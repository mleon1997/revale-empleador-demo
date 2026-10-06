import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {settlementFixture} from './settlement-fixture.mjs';
import {scheduleSettlementPayout,markSettlementPaid,markSettlementFailed,closeLastCompletedWeeklySettlement} from '../lib/revale-settlements.js';
import {reconcileSettlementPayout,registerIssuedFeeInvoice,reportMerchantWithholding,reviewMerchantWithholding,registerIssuedFeeCreditNote} from '../lib/revale-settlement-tax.js';
import {claimFinancialApprovalForExecution} from '../lib/revale-financial-approvals.js';
import {emitAndPostAccountingEvent,processPendingAccountingEvents} from '../lib/revale-accounting.js';
import {financialResponse} from '../lib/revale-financial-transaction.js';
import {confirmCharge} from '../lib/revale-db.js';
import {createRedemptionHandler} from '../api/revale-demo.js';
import {operationalHealth} from '../lib/revale-operational-health.js';
import {createHealthHandler} from '../api/operational-health.js';

const f=await settlementFixture();after(()=>f.close());beforeEach(()=>f.reset());
const schedule=(id='S1',bank=1,max=100)=>f.run(tx=>scheduleSettlementPayout(tx,id,'maker',{expectedBankAccountId:bank,maxApprovedAmount:max}));
const rows=(query,args=[])=>f.sql.query(query,args);
const count=async table=>(await rows('SELECT COUNT(*)::int AS n FROM revale.'+table))[0].n;
async function ready(){await f.settlement();await f.payable();}
async function consume(id='T1',amount=100){
  await f.charge(id,amount);assert.equal((await confirmCharge(f.sql,id,'token-'+id,f.principal)).code,'ok');
  await processPendingAccountingEvents(f.sql);
  await rows("UPDATE revale.transactions SET approved_at=date_trunc('week',now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil'-interval '1 day'");
}
async function closeSettlement(){
  return f.run(async tx=>{const r=await closeLastCompletedWeeklySettlement(tx,'m1','maker');assert.equal(r.code,'ok');await emitAndPostAccountingEvent(tx,{eventType:'settlement_closed',sourceType:'settlement',sourceId:r.settlement.id,eventKey:'closed',merchantId:'m1',settlementId:r.settlement.id,amount:r.settlement.fee_amount+r.settlement.tax_amount,payload:r.settlement});return r;});
}
async function reverse(id='T1'){
  const res={code:0,body:null,status(c){this.code=c;return this;},setHeader(){return this;},json(b){this.body=b;return this;}};
  const handler=createRedemptionHandler({database:async()=>f.sql,merchantSession:async()=>f.merchant});
  await handler({method:'POST',query:{action:'reverse'},body:{tx:id,reason:'other'},headers:{host:'comercios.revale.app',origin:'https://comercios.revale.app'}},res);
  if(res.code===500&&f.sql.lastTransactionError)throw f.sql.lastTransactionError;
  return res;
}
async function pay(id='S1',reference='BANK-1'){
  return f.run(async tx=>{
    const result=await markSettlementPaid(tx,id,reference,'maker');
    if(result.code==='ok')await emitAndPostAccountingEvent(tx,{eventType:'merchant_payout_paid',sourceType:'settlement',sourceId:id,eventKey:'paid',amount:result.settlement.payout_amount,merchantId:'m1',settlementId:id});
    return result;
  });
}
async function approved(){
  await rows(`INSERT INTO revale.financial_approval_requests(id,request_key,action_type,entity_type,entity_id,amount,requested_by,required_approvals,status,expires_at)
    VALUES('A','A','merchant_payout','settlement','S1',100,'maker',1,'approved',now()+interval '1 hour')`);
  await rows("INSERT INTO revale.financial_approval_decisions(request_id,approver_id,decision) VALUES('A','checker','approved')");
}
test('payout retries reserve once and bank changes require a new approval',async()=>{
  await ready();assert.equal((await schedule('S1',2)).code,'approved_bank_changed');
  assert.equal((await schedule('S1',1,99)).code,'approval_amount_exceeded');
  assert.equal((await schedule()).code,'ok');assert.equal((await schedule()).idempotent,true);assert.equal(await count('settlement_payouts'),1);
});
test('reserved merchant liabilities cannot fund two settlements',async()=>{
  await ready();await f.settlement('S2');assert.equal((await schedule()).code,'ok');
  assert.equal((await schedule('S2')).code,'merchant_balance_offset');assert.equal(await count('settlement_payouts'),1);
});
test('treasury reservations prevent two merchants from spending the same cash',async()=>{
  await ready();await f.settlement('S2',100,'m2');await f.payable(100,'m2');
  await rows('UPDATE revale.treasury_bank_balance_snapshots SET balance=100,available_balance=100');
  assert.equal((await schedule()).code,'ok');assert.equal((await schedule('S2',2)).code,'insufficient_available_treasury');
});
test('an unposted accounting event blocks payment even if old GL balance exists',async()=>{
  await ready();await rows("INSERT INTO revale.accounting_events(event_type,source_type,source_id,event_key,merchant_id) VALUES('redemption_reversed','transaction','X','reversed','m1')");
  assert.equal((await schedule()).code,'accounting_pending');assert.equal(await count('settlement_payouts'),0);
});
test('payment is idempotent, references cannot be reused and paid cannot become failed',async()=>{
  await ready();await schedule();assert.equal((await pay()).code,'ok');assert.equal((await pay()).idempotent,true);
  assert.equal((await pay('S1','DIFFERENT')).code,'paid_reference_conflict');
  assert.equal((await f.run(tx=>markSettlementFailed(tx,'S1','bank rejected','maker'))).code,'invalid_status');
  await f.settlement('S2',100,'m2');await f.payable(100,'m2');await schedule('S2',2);
  assert.equal((await pay('S2')).code,'duplicate_bank_reference');
  assert.equal((await rows("SELECT SUM(debit)::float8 AS n FROM revale.gl_journal_lines WHERE account_id='gl_merchant_payable'"))[0].n,100);
});
test('a GL write failure rolls back both payout status and the accounting event',async()=>{
  await ready();await schedule();await f.exec("ALTER TABLE revale.gl_journal_lines ADD CONSTRAINT reject_payout CHECK(account_id<>'gl_cash_client_funds')");
  try{await assert.rejects(pay());assert.equal((await rows("SELECT status FROM revale.settlements WHERE id='S1'"))[0].status,'scheduled');assert.equal(await count('accounting_events'),1);}
  finally{await f.exec('ALTER TABLE revale.gl_journal_lines DROP CONSTRAINT reject_payout');}
});
test('unsupported or unbalanced journals fail closed inside financial transactions',async()=>{
  for(const args of [{eventType:'unknown',amount:10},{eventType:'settled_redemption_reversed',amount:10,payload:{merchant_recovery:9}}]){
    await assert.rejects(f.run(tx=>emitAndPostAccountingEvent(tx,{...args,sourceType:'test',sourceId:'invalid'})));
  }
  assert.equal(await count('accounting_events'),0);
});
test('responses are not sent until commit and never report success after rollback',async()=>{
  const sent=[];const res={status(c){sent.push(c);return this;},setHeader(){return this;},json(b){sent.push(b);return this;}};
  await assert.rejects(financialResponse(f.sql,res,async(tx,r)=>{await tx.query("UPDATE revale.benefit_accounts SET balance=1");r.status(200).json({ok:true});throw new Error('crash');}));
  assert.deepEqual(sent,[]);assert.equal(Number((await rows("SELECT balance FROM revale.benefit_accounts WHERE id='a1'"))[0].balance),100);
});
test('execution rechecks expiration, permissions, role, approval limit and maker-checker separation',async()=>{
  await approved();
  const mutations=[
    ["UPDATE revale.financial_approval_requests SET expires_at=now()-interval '1 minute'","UPDATE revale.financial_approval_requests SET expires_at=now()+interval '1 hour'"],
    ["UPDATE revale.financial_user_permissions SET active=false WHERE admin_user_id='checker'","UPDATE revale.financial_user_permissions SET active=true"],
    ["UPDATE revale.admin_users SET role='support' WHERE id='checker'","UPDATE revale.admin_users SET role='finance'"],
    ["UPDATE revale.financial_user_permissions SET approval_limit=99 WHERE admin_user_id='checker'","UPDATE revale.financial_user_permissions SET approval_limit=NULL"],
    ["UPDATE revale.financial_approval_policies SET approvals_below=2 WHERE action_type='merchant_payout'","UPDATE revale.financial_approval_policies SET approvals_below=1 WHERE action_type='merchant_payout'"],
    ["UPDATE revale.financial_approval_decisions SET approver_id='maker'","UPDATE revale.financial_approval_decisions SET approver_id='checker'"]
  ];
  for(const [change,undo] of mutations){await rows(change);assert.equal((await f.run(tx=>claimFinancialApprovalForExecution(tx,'A','maker'))).code,'not_executable');await rows(undo);}
  assert.equal((await f.run(tx=>claimFinancialApprovalForExecution(tx,'A','maker'))).code,'ok');
});
test('one cent is a mismatch and a matched reconciliation is immutable and retryable',async()=>{
  await ready();await schedule();await pay();
  const reconcile=amount=>f.run(tx=>reconcileSettlementPayout(tx,{settlementId:'S1',bankReference:'BANK-1',bankPostedOn:'2026-10-05',bankAmount:amount,actorId:'maker'}));
  assert.equal((await reconcile(99.99)).reconciliation.status,'mismatch');
  assert.equal((await reconcile(100)).reconciliation.status,'matched');
  assert.equal((await reconcile(100)).idempotent,true);assert.equal((await reconcile(101)).code,'reconciliation_locked');
});
test('consumption to close, tax invoice, payout and reconciliation preserves exact amounts',async()=>{
  await f.charge('T1',100);assert.equal((await confirmCharge(f.sql,'T1','token-T1',f.principal)).code,'ok');
  await processPendingAccountingEvents(f.sql);
  await rows("UPDATE revale.transactions SET approved_at=date_trunc('week',now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil'-interval '1 day'");
  const closed=await f.run(async tx=>{const r=await closeLastCompletedWeeklySettlement(tx,'m1','maker');assert.equal(r.code,'ok');await emitAndPostAccountingEvent(tx,{eventType:'settlement_closed',sourceType:'settlement',sourceId:r.settlement.id,eventKey:'closed',merchantId:'m1',settlementId:r.settlement.id,amount:r.settlement.fee_amount+r.settlement.tax_amount,payload:r.settlement});return r;});
  const id=closed.settlement.id;assert.equal(closed.settlement.fee_amount,2.5);assert.equal(closed.settlement.tax_amount,0.38);assert.equal(closed.settlement.net_amount,97.12);
  assert.equal((await schedule(id)).code,'fee_invoice_pending');
  const [invoice]=await rows('SELECT id FROM revale.merchant_fee_invoices WHERE settlement_id=$1',[id]);
  assert.equal((await f.run(tx=>registerIssuedFeeInvoice(tx,{settlementId:id,invoiceNumber:'TEST-1',actorId:'maker'}))).code,'ok');
  assert.equal((await schedule(id)).payout.amount,97.12);assert.equal((await pay(id)).code,'ok');
  assert.equal((await f.run(tx=>reconcileSettlementPayout(tx,{settlementId:id,bankReference:'BANK-1',bankPostedOn:'2026-10-05',bankAmount:97.12}))).reconciliation.status,'matched');
  assert.equal((await rows("SELECT SUM(credit-debit)::float8 AS balance FROM revale.gl_journal_lines WHERE account_id='gl_merchant_payable' AND merchant_id='m1'"))[0].balance,0);
});
test('post-close reversals return exactly the assessed fee, including rounding remainders',async()=>{
  await consume('T1',0.1);await consume('T2',0.1);const closed=await closeSettlement();
  assert.equal(closed.settlement.fee_amount,0.01);
  assert.equal((await reverse('T1')).code,200);assert.equal((await reverse('T2')).code,200);assert.equal((await reverse('T2')).code,200);
  assert.equal(Number((await rows("SELECT balance FROM revale.benefit_accounts WHERE id='a1'"))[0].balance),100);
  assert.equal((await rows("SELECT SUM(credit-debit)::float8 AS n FROM revale.gl_journal_lines WHERE account_id='gl_merchant_payable'"))[0].n,0);
  assert.equal((await rows("SELECT SUM(debit-credit)::float8 AS n FROM revale.gl_journal_lines WHERE account_id='gl_fee_revenue'"))[0].n,0);
  assert.equal((await rows('SELECT status FROM revale.settlements'))[0].status,'cancelled');
});
test('withholding verification adds its value once and cannot exceed the approved payout',async()=>{
  await consume();const {settlement:{id}}=await closeSettlement();
  await f.run(tx=>registerIssuedFeeInvoice(tx,{settlementId:id,invoiceNumber:'TEST-1'}));
  const report=await f.run(tx=>reportMerchantWithholding(tx,{settlementId:id,merchantId:'m1',documentNumber:'WHT-1',issuedOn:'2026-10-05',incomeTaxAmount:0.25}));
  assert.equal(report.code,'ok');assert.equal((await schedule(id)).code,'withholding_pending');
  for(let i=0;i<2;i++)await f.run(async tx=>{
    const verified=await reviewMerchantWithholding(tx,{withholdingId:report.withholding.id,decision:'verify',actorId:'checker'});
    assert.equal(verified.code,'ok');await emitAndPostAccountingEvent(tx,{eventType:'merchant_withholding_verified',sourceType:'merchant_withholding',sourceId:report.withholding.id,eventKey:'verified',amount:verified.withholding.total_amount,merchantId:'m1',settlementId:id});
  });
  assert.equal((await schedule(id,1,97.12)).code,'approval_amount_exceeded');
  assert.equal((await schedule(id,1,97.37)).payout.amount,97.37);
  assert.equal(await count('settlement_adjustments'),1);
});
test('a stale bank balance cannot authorize a payment even with optional coverage enforcement off',async()=>{
  await ready();await rows("UPDATE revale.treasury_bank_balance_snapshots SET as_of=now()-interval '2 days'");
  assert.equal((await schedule()).code,'bank_balance_stale');assert.equal(await count('settlement_payouts'),0);
});
test('reversal after an issued invoice requires a credit note before the remaining payout',async()=>{
  await consume('T1',50);await consume('T2',50);const {settlement:{id}}=await closeSettlement();
  await f.run(tx=>registerIssuedFeeInvoice(tx,{settlementId:id,invoiceNumber:'TEST-1'}));
  assert.equal((await reverse('T1')).code,200);assert.equal((await schedule(id)).code,'credit_note_pending');
  const [note]=await rows('SELECT id,total_amount FROM revale.merchant_fee_credit_notes');assert.equal(Number(note.total_amount),1.44);
  assert.equal((await f.run(tx=>registerIssuedFeeCreditNote(tx,{creditNoteId:note.id,creditNoteNumber:'CN-TEST-1',actorId:'maker'}))).code,'ok');
  assert.equal((await schedule(id)).payout.amount,48.56);
});
test('retrying a pre-close reversal after closing does not create a second accounting reversal',async()=>{
  await consume();assert.equal((await reverse()).code,200);await closeSettlement();assert.equal((await reverse()).code,200);
  assert.equal((await rows("SELECT COUNT(*)::int AS n FROM revale.accounting_events WHERE event_type IN ('redemption_reversed','settled_redemption_reversed')"))[0].n,1);
});
test('health detects a financial mismatch and the public endpoint exposes no details',async()=>{
  assert.equal((await operationalHealth(f.sql)).ok,true);
  await rows("UPDATE revale.benefit_accounts SET balance=-1 WHERE id='a1'");
  const health=await operationalHealth(f.sql);assert.equal(health.ok,false);assert.equal(health.checks.negative_balances,1);
  const logs=[];const handler=createHealthHandler({database:async()=>f.sql,log:(...args)=>logs.push(args)});
  const res={status(c){this.code=c;return this;},setHeader(){},json(b){this.body=b;return this;}};
  await handler({method:'GET'},res);assert.equal(res.code,503);assert.deepEqual(res.body,{ok:false});assert.equal(logs.length,1);
});
test('a failed database check returns 503 without leaking connection details',async()=>{
  const logs=[];const handler=createHealthHandler({database:async()=>{throw new Error('secret connection string');},log:(...args)=>logs.push(args)});
  const res={status(c){this.code=c;return this;},setHeader(){},json(b){this.body=b;return this;}};
  await handler({method:'GET'},res);assert.equal(res.code,503);assert.deepEqual(res.body,{ok:false});assert.ok(!JSON.stringify(logs).includes('secret'));
});
test('concurrent payment requests create one reservation on independent connections',{skip:!f.native},async()=>{
  await ready();const results=await Promise.all(Array.from({length:4},()=>schedule()));
  assert.ok(results.every(r=>r.code==='ok'));assert.equal(await count('settlement_payouts'),1);
});
test('simultaneous settlements cannot over-reserve merchant payable',{skip:!f.native},async()=>{
  await ready();await f.settlement('S2');const results=await Promise.all([schedule(),schedule('S2')]);
  assert.equal(results.filter(x=>x.code==='ok').length,1);assert.equal(await count('settlement_payouts'),1);
});
test('paid versus failed has exactly one terminal winner',{skip:!f.native},async()=>{
  await ready();await schedule();const results=await Promise.all([pay(),f.run(tx=>markSettlementFailed(tx,'S1','Rejected','maker'))]);
  assert.equal(results.filter(x=>x.code==='ok').length,1);
  const [p]=await rows('SELECT status FROM revale.settlement_payouts');assert.ok(['paid','failed'].includes(p.status));
  assert.equal((await rows('SELECT status FROM revale.settlements'))[0].status,p.status);
});
test('a concurrent close and reversal never lose or duplicate merchant liability',{skip:!f.native},async()=>{
  await consume();const [closed,reversed]=await Promise.all([closeSettlement(),reverse()]);
  assert.equal(closed.code,'ok');assert.equal(reversed.code,200);
  assert.equal(Number((await rows("SELECT balance FROM revale.benefit_accounts WHERE id='a1'"))[0].balance),100);
  assert.equal((await rows("SELECT SUM(credit-debit)::float8 AS n FROM revale.gl_journal_lines WHERE account_id='gl_merchant_payable'"))[0].n,0);
});
test('a payout scheduled concurrently with reversal either locks the reversal or uses the corrected balance',{skip:!f.native},async()=>{
  await consume();const {settlement:{id}}=await closeSettlement();
  await f.run(tx=>registerIssuedFeeInvoice(tx,{settlementId:id,invoiceNumber:'TEST-1'}));
  const [scheduled,reversed]=await Promise.all([schedule(id),reverse()]);
  if(scheduled.code==='ok'){
    assert.equal(reversed.code,409);assert.equal(Number((await rows("SELECT balance FROM revale.benefit_accounts WHERE id='a1'"))[0].balance),0);
  }else{
    assert.equal(reversed.code,200);assert.equal(await count('settlement_payouts'),0);assert.equal(Number((await rows("SELECT balance FROM revale.benefit_accounts WHERE id='a1'"))[0].balance),100);
  }
});

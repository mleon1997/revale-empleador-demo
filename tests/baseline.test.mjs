import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { reconcileSettlementPayout } from '../lib/revale-settlement-tax.js';
import { registerFundingReceipt, confirmFundingBatchAtomic } from '../lib/revale-admin-funding.js';
import { emitAndPostAccountingEvent } from '../lib/revale-accounting.js';

const base = new URL('../db/baseline/', import.meta.url);
const baseline = await readFile(new URL('20261006_revale.sql', base), 'utf8');
const queryBaseline = await readFile(new URL('20261006_revale-query.sql', base), 'utf8');
const catalogQuery = await readFile(new URL('catalog-query.sql', base), 'utf8');
const expected = JSON.parse(await readFile(new URL('catalog-20261006.json', base), 'utf8'));

test('full schema: funding receipt, allocation and retries preserve a single balanced credit',async()=>{
  const db=new PGlite(),previous=process.env.REVALE_MODE;process.env.REVALE_MODE='live';
  try{
    await db.exec(baseline);
    await db.exec(`
      INSERT INTO revale.employers(id,name) VALUES ('fund','Synthetic');
      INSERT INTO revale.benefit_programs(id,employer_id,name) VALUES ('fund','fund','Synthetic');
      INSERT INTO revale.persons(id,person_identification,first_name,last_name,company_identification) VALUES ('fund','TEST','Test','Employee','TEST-COMPANY');
      INSERT INTO revale.cards(card_number,person_id) VALUES ('fund','fund');
      INSERT INTO revale.benefit_accounts(id,card_number,balance) VALUES ('fund','fund',0);
      INSERT INTO revale.employee_enrollments(id,program_id,person_id) VALUES (1,'fund','fund');
      INSERT INTO revale.funding_batches(id,employer_id,program_id,amount) VALUES ('fund','fund','fund',100);
      INSERT INTO revale.funding_batch_items(funding_batch_id,enrollment_id,account_id,amount) VALUES ('fund',1,'fund',100);
      INSERT INTO revale.treasury_bank_accounts(id,bank_name,account_name,purpose) VALUES ('fund','Synthetic','Not real','client_funds');
      INSERT INTO revale.gl_accounts(id,internal_code,name,account_type,normal_balance,ifrs_category) VALUES
        ('gl_cash_client_funds','cash','cash','asset','debit','synthetic'),
        ('gl_employer_prefund_liability','prefund','prefund','liability','credit','synthetic'),
        ('gl_employee_benefit_liability','benefit','benefit','liability','credit','synthetic');
    `);
    const receipt={fundingBatchId:'fund',amount:100,bankReference:'TEST-NOT-A-TRANSFER',bankPostedOn:'2026-10-07',treasuryAccountId:'fund',actorId:'synthetic'};
    const run=(work,old=false)=>db.transaction(async tx=>work({query:async(text,args)=>
      (await tx.query(old?text.replace("'last_bank_reference',$2::text","'last_bank_reference',$2"):text,args)).rows}));
    await assert.rejects(run(sql=>registerFundingReceipt(sql,receipt),true),e=>e.code==='42P18');
    assert.equal((await db.query('SELECT count(*)::int n FROM revale.employer_funding_receipts')).rows[0].n,0,'Receipt must rollback after a metadata failure');
    for(let i=0;i<2;i++)await run(async sql=>{
      const r=await registerFundingReceipt(sql,receipt);assert.equal(r.code,'ok');if(i)assert.equal(r.idempotent,true);
      await emitAndPostAccountingEvent(sql,{eventType:'funding_cash_received',sourceType:'funding_receipt',sourceId:r.receipt.id,eventKey:'confirmed',amount:100,employerId:'fund'});
    });
    assert.equal(Number((await db.query('SELECT balance FROM revale.benefit_accounts')).rows[0].balance),0);
    const meta=(await db.query('SELECT metadata,status FROM revale.funding_batches')).rows[0];assert.equal(meta.status,'received');assert.equal(meta.metadata.last_bank_reference,receipt.bankReference);
    for(let i=0;i<2;i++)await run(async sql=>{
      const r=await confirmFundingBatchAtomic(sql,'fund');assert.equal(r.code,'ok');if(i)assert.equal(r.idempotent,true);
      await emitAndPostAccountingEvent(sql,{eventType:'funding_allocated',sourceType:'funding_batch',sourceId:'fund',eventKey:'allocated_v2',amount:100,employerId:'fund'});
    });
    assert.equal(Number((await db.query('SELECT balance FROM revale.benefit_accounts')).rows[0].balance),100);
    for(const table of ['employer_funding_receipts','benefit_allocations','ledger_entries'])assert.equal((await db.query(`SELECT count(*)::int n FROM revale.${table}`)).rows[0].n,1);
    const gl=(await db.query('SELECT account_id,sum(debit-credit)::float8 net FROM revale.gl_journal_lines GROUP BY account_id ORDER BY account_id')).rows;
    assert.deepEqual(gl,[{account_id:'gl_cash_client_funds',net:100},{account_id:'gl_employee_benefit_liability',net:-100},{account_id:'gl_employer_prefund_liability',net:0}]);
  }finally{if(previous===undefined)delete process.env.REVALE_MODE;else process.env.REVALE_MODE=previous;await db.close();}
});

test('exact reconciliation works against the full observed schema after its status migration',async()=>{
  const db=new PGlite();
  const priorMode=process.env.REVALE_MODE;
  process.env.REVALE_MODE='live';
  try {
    await db.exec(baseline);
    await db.exec(`
      INSERT INTO revale.merchants(id,name) VALUES ('test','Synthetic merchant');
      INSERT INTO revale.merchant_bank_accounts(id,merchant_id,bank_name,account_type,account_number,holder_name,holder_identification,status)
        VALUES (1,'test','Synthetic','checking','NOT-REAL','Synthetic','NOT-REAL','verified');
      INSERT INTO revale.settlements(id,merchant_id,period_start,period_end,status,net_amount)
        VALUES ('test','test','2026-09-28','2026-10-05','paid',97.12);
      INSERT INTO revale.settlement_payouts(settlement_id,attempt_no,bank_account_id,amount,status,payout_reference)
        VALUES ('test',1,1,97.12,'paid','SYNTHETIC');
    `);
    const reconcile=amount=>db.transaction(async tx=>reconcileSettlementPayout({query:async(text,args)=>(await tx.query(text,args)).rows},
      {settlementId:'test',bankReference:'SYNTHETIC',bankPostedOn:'2026-10-06',bankAmount:amount}));
    assert.equal((await reconcile(97.11)).reconciliation.status,'mismatch');
    await assert.rejects(reconcile(97.12),e=>e.code==='23514'&&e.message.includes('settlements_status_check'));
    assert.equal((await db.query("SELECT status FROM revale.settlement_reconciliations")).rows[0].status,'mismatch','Constraint failure rolls back reconciliation');
    const migration=await readFile(new URL('../db/migrations/20261006_settlement_reconciled_status.sql',import.meta.url),'utf8');
    await db.exec(migration);
    assert.equal((await reconcile(97.12)).reconciliation.status,'matched');
    assert.equal((await db.query('SELECT status FROM revale.settlements')).rows[0].status,'reconciled');
    assert.equal((await reconcile(97.12)).idempotent,true);
    assert.equal((await reconcile(97.13)).code,'reconciliation_locked');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM revale.settlement_events WHERE event_type='reconciled'")).rows[0].n,1);
    await assert.rejects(db.query("UPDATE revale.settlements SET status='unknown'"),e=>e.code==='23514');
    await db.exec(migration); // A repeat is safe and retains the reconciled row.
  } finally {
    if(priorMode===undefined)delete process.env.REVALE_MODE;else process.env.REVALE_MODE=priorMode;
    await db.close();
  }
});

for (const mode of ['script', 'prepared query']) {
test(`${mode}: fresh isolated database reproduces the observed schema without data or identities`, async () => {
  const db = new PGlite();
  try {
    const run = () => mode === 'script' ? db.exec(baseline) : db.query(queryBaseline);
    await run();
    const result = await db.query(catalogQuery);
    const actual = JSON.parse(result.rows[0].schema_catalog);
    for (const key of ['tables','constraints','indexes','sequences','functions','triggers','policies','enums','other_types']) {
      assert.deepEqual(actual[key], expected[key], `Source schema mismatch in ${key}`);
    }
    for (const { name } of expected.tables) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      const result = await db.query(`SELECT count(*)::integer AS n FROM revale.${quoted}`);
      assert.equal(result.rows[0].n, 0, `${name} must start empty`);
    }
    const auth = await db.query("SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname = 'neon_auth'");
    assert.equal(auth.rows[0].n, 0, 'Baseline must not install/copy provider identity data');
    await assert.rejects(run(), /already exists/);
    await db.exec('ROLLBACK');
    const intact = await db.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='revale'");
    assert.equal(intact.rows[0].n, expected.tables.length, 'Rejected rerun must preserve schema');
  } finally {
    await db.close();
  }
});
}

test('single-statement wrapper contains exactly the approved baseline DDL', () => {
  const body = baseline.replace('\nBEGIN;\n', '\n').replace('\nCOMMIT;', '\n').trim();
  assert.equal(queryBaseline.split('$revale_ddl$')[1].trim(), body);
});

import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {confirmCharge,reverseCharge,getCharge,transactionId,publicToken} from '../lib/revale-db.js';
import {redemptionFixture} from './redemption-fixture.mjs';

const f=await redemptionFixture();
after(()=>f.close());beforeEach(()=>f.reset());
const confirm=(id='T1',who=f.principal)=>confirmCharge(f.sql,id,'token-'+id,who);
const balance=async id=>Number((await f.sql.query('SELECT balance FROM revale.benefit_accounts WHERE id=$1',[id]))[0].balance);

test('one debit, one ledger entry and a durable accounting event survive an identical retry',async()=>{
  await f.charge();const first=await confirm(),second=await confirm();
  assert.equal(first.code,'ok');assert.equal(second.code,'ok');assert.equal(first.balanceAfter,90);assert.equal(second.balanceAfter,90);
  assert.equal(await balance('a1'),90);
  assert.equal((await f.sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,1);
  assert.equal((await f.sql.query("SELECT COUNT(*)::int AS n FROM revale.accounting_events WHERE status='pending'"))[0].n,1);
});
test('invalid, expired and insufficient-balance charges do not change the ledger',async()=>{
  await f.charge('T1',120);assert.equal((await confirm()).code,'insufficient_balance');
  assert.equal((await confirmCharge(f.sql,'T1','wrong',f.principal)).code,'not_found');
  await f.sql.query("UPDATE revale.transactions SET expires_at=now()-interval '1 second'");
  assert.equal((await confirm()).code,'expired');assert.equal(await balance('a1'),100);
  assert.equal((await f.sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,0);
});
test('ownership and current benefit eligibility are checked at the financial boundary',async()=>{
  await f.charge();await f.sql.query("UPDATE revale.employee_enrollments SET status='suspended' WHERE person_id='p1'");
  assert.notEqual((await confirm()).code,'ok');assert.equal(await balance('a1'),100);
  await f.sql.query("UPDATE revale.employee_enrollments SET status='active'");await confirm();
  const other={personId:'p2',benefit:{...f.principal.benefit,account_id:'a2',card_number:'c2'}};
  assert.equal((await confirm('T1',other)).code,'already_claimed');
  assert.equal(await getCharge(f.sql,'T1','token-T1',other),null);assert.equal(await balance('a2'),100);
});
test('limits are atomic and a retry remains valid after the daily limit is reached',async()=>{
  await f.sql.query(`INSERT INTO revale.benefit_rules(program_id,rule_type,rule_value) VALUES('b1','daily_limit','{"amount":10}')`);
  await f.charge();assert.equal((await confirm()).code,'ok');assert.equal((await confirm()).code,'ok');
  await f.charge('T2',1);assert.equal((await confirm('T2')).code,'rule_denied');assert.equal(await balance('a1'),90);
});
test('merchant, branch and per-consumption limits are enforced before debiting',async()=>{
  await f.charge();
  for(const [type,value] of [['max_transaction_amount',{amount:5}],['merchant_allowlist',{merchant_ids:['m2']}],['merchant_blocklist',{merchant_ids:['m1']}],['location_allowlist',{location_ids:['l2']}]]){
    await f.sql.query('TRUNCATE revale.benefit_rules');
    await f.sql.query('INSERT INTO revale.benefit_rules(program_id,rule_type,rule_value) VALUES($1,$2,$3::jsonb)',['b1',type,JSON.stringify(value)]);
    assert.equal((await confirm()).code,'rule_denied');
  }
  assert.equal(await balance('a1'),100);
});
test('a reversal is scoped to its merchant/branch and credits only once',async()=>{
  await f.charge();await confirm();
  assert.equal((await reverseCharge(f.sql,'T1','other','','Test',{...f.merchant,merchantId:'m2'})).code,'not_found');
  assert.equal((await reverseCharge(f.sql,'T1','other','','Test',{...f.merchant,locationId:'l2'})).code,'not_found');
  assert.equal(await balance('a1'),90);
  assert.equal((await reverseCharge(f.sql,'T1','other','','Test',f.merchant)).code,'ok');
  assert.equal((await reverseCharge(f.sql,'T1','other','','Test',f.merchant)).idempotent,true);
  assert.equal(await balance('a1'),100);
  assert.equal((await f.sql.query("SELECT COUNT(*)::int AS n FROM revale.ledger_entries WHERE entry_type='reversal'"))[0].n,1);
});
test('failure to persist the accounting event rolls back the balance and the transaction',async()=>{
  await f.charge();await f.exec("ALTER TABLE revale.accounting_events ADD CONSTRAINT reject_test CHECK (amount<0)");
  try {await assert.rejects(confirm());assert.equal(await balance('a1'),100);assert.equal((await f.sql.query("SELECT status FROM revale.transactions WHERE id='T1'"))[0].status,'pending');}
  finally{await f.exec('ALTER TABLE revale.accounting_events DROP CONSTRAINT reject_test');}
});
test('QR credentials use cryptographic-size random values',()=>{
  const ids=new Set(),tokens=new Set();for(let i=0;i<1000;i++){const id=transactionId(),token=publicToken();assert.match(id,/^RV-[A-F0-9]{24}$/);assert.match(token,/^[A-Za-z0-9_-]{43}$/);ids.add(id);tokens.add(token);}
  assert.equal(ids.size,1000);assert.equal(tokens.size,1000);
});
test('12 simultaneous confirmations debit once on multi-connection PostgreSQL',{skip:!f.native},async()=>{
  await f.charge();const results=await Promise.all(Array.from({length:12},()=>confirm()));
  assert.ok(results.every(r=>r.code==='ok'));assert.equal(await balance('a1'),90);
  assert.equal((await f.sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,1);
});
test('two employees cannot both pay the same QR',{skip:!f.native},async()=>{
  await f.charge();const other={personId:'p2',benefit:{...f.principal.benefit,account_id:'a2',card_number:'c2'}};
  const results=await Promise.all([confirm(),confirm('T1',other)]);
  assert.equal(results.filter(r=>r.code==='ok').length,1);
  assert.equal(await balance('a1')+await balance('a2'),190);
});
test('simultaneous different charges cannot exceed a daily limit',{skip:!f.native},async()=>{
  await f.sql.query(`INSERT INTO revale.benefit_rules(program_id,rule_type,rule_value) VALUES('b1','daily_limit','{"amount":15}')`);
  await f.charge();await f.charge('T2');const results=await Promise.all([confirm(),confirm('T2')]);
  assert.equal(results.filter(r=>r.code==='ok').length,1);assert.equal(await balance('a1'),90);
});
test('12 simultaneous reversals credit once on multi-connection PostgreSQL',{skip:!f.native},async()=>{
  await f.charge();await confirm();
  const results=await Promise.all(Array.from({length:12},()=>reverseCharge(f.sql,'T1','other','','Test',f.merchant)));
  assert.ok(results.every(r=>r.code==='ok'));assert.equal(await balance('a1'),100);
  assert.equal((await f.sql.query("SELECT COUNT(*)::int AS n FROM revale.ledger_entries WHERE entry_type='reversal'"))[0].n,1);
});

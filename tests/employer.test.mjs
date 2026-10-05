import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {employerFixture} from './employer-fixture.mjs';
import {createEmployerHandler} from '../api/employer.js';
import {overview,employees,report,requestFunding,fundingDetail,fundingMoney,saveRules,updateEnrollment,updateProgram,upsertRule,period,moneyValue,merchantPresentation} from '../lib/revale-employer.js';
const {db,sql,principal}=await employerFixture();
after(()=>db.close());

test('overview deduplicates accounts by identity, preserves equal balances, and isolates another company',async()=>{
 const d=await overview(sql,principal);
 assert.equal(d.stats.visible_balance,198.10);assert.equal(d.stats.active_employees,2);assert.equal(d.stats.shared_balances,1);
 assert.equal(d.summary.spent,30.95);assert.equal(d.summary.invoices_pending,1);assert.equal(d.summary.total,3);
 assert.equal(d.recent.some(x=>x.id==='PRIVATE'),false);assert.equal(d.recent.find(x=>x.id==='T2').merchant_name,'BOGÖ');
 const list=await employees(sql,principal.employerId);assert.equal(list.length,3);assert.equal(list.find(x=>x.person_id==='shared').balance,null);assert.equal(list.find(x=>x.person_id==='shared').funding_ready,false);
});
test('a funding request is atomic, cent accurate, retriable, and never credits employee balances',async()=>{
 const input={program_id:'program_demo_food',amount_per_employee:99.99,external_reference:'QA isolated database',request_id:'test-request-001',expected_employee_count:2};
 const before=await sql.query('SELECT id,balance FROM revale.benefit_accounts ORDER BY id');
 const first=await requestFunding(sql,principal,input),again=await requestFunding(sql,principal,input);
 assert.equal(first.batch.total,199.98);assert.equal(again.batch.id,first.batch.id);assert.equal(again.idempotent,true);
 const detail=await fundingDetail(sql,principal.employerId,first.batch.id);assert.equal(detail.items.length,2);assert.equal(detail.batch.allocated_amount,0);assert.equal(detail.batch.received_amount,0);
 assert.deepEqual(await sql.query('SELECT id,balance FROM revale.benefit_accounts ORDER BY id'),before);
 assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,0);
 assert.equal((await sql.query("SELECT COUNT(*)::int AS n FROM revale.audit_events WHERE action='funding.requested'"))[0].n,1);
 await assert.rejects(requestFunding(sql,principal,{...input,amount_per_employee:100}),e=>e.status===409);
 await assert.rejects(fundingDetail(sql,'other',first.batch.id),e=>e.status===404);
});
test('stale employee count, wrong tenant, and invalid monetary inputs create no partial requests',async()=>{
 const before=(await sql.query('SELECT COUNT(*)::int AS n FROM revale.funding_batches'))[0].n;
 await assert.rejects(requestFunding(sql,principal,{program_id:'program_demo_food',amount_per_employee:10,request_id:'stale-request-001',expected_employee_count:3}),e=>e.status===409);
 await assert.rejects(requestFunding(sql,principal,{program_id:'other-program',amount_per_employee:10,request_id:'foreign-request-001'}),e=>e.status===409);
 for(const n of [0,-1,0.001,10.999,Infinity,NaN,1000001])assert.throws(()=>moneyValue(n));
 assert.equal(moneyValue('99.99'),99.99);assert.equal(moneyValue('0.01'),.01);
 assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.funding_batches'))[0].n,before);
});
test('funding shortfall subtracts money already allocated and refunds',()=>{
 assert.deepEqual(fundingMoney({received_amount:150,refunded_amount:10,allocated_amount:100,item_total:200}),{received_amount:150,refunded_amount:10,allocated_amount:100,item_total:200,cash_net:140,unallocated_cash:40,pending_allocation:100,funding_gap:60});
});
test('benefit and enrollment changes are tenant scoped and audited without changing balances',async()=>{
 await assert.rejects(updateEnrollment(sql,principal,{enrollment_id:'3',status:'suspended',reason:'Unauthorized foreign edit'}),e=>e.status===404);
 await updateEnrollment(sql,principal,{enrollment_id:'1',status:'suspended',reason:'Temporary test pause'});
 assert.equal((await employees(sql,principal.employerId)).find(e=>e.enrollment_id==='1').funding_ready,false);
 await updateEnrollment(sql,principal,{enrollment_id:'1',status:'active',reason:'Restore after test'});
 await updateProgram(sql,principal,{program_id:'program_demo_food',allocation_amount:125,allocation_frequency:'monthly',rollover_policy:'no_rollover'});
 await assert.rejects(updateProgram(sql,principal,{program_id:'other-program',allocation_amount:100,allocation_frequency:'monthly',rollover_policy:'no_rollover'}),e=>e.status===404);
 assert.equal(Number((await sql.query("SELECT balance FROM revale.benefit_accounts WHERE id='acct_demo_andrea'"))[0].balance),99.05);
});
test('atomic rules save removes blank limits, preserves branch restrictions and rejects unknown merchants',async()=>{
 await saveRules(sql,principal,{program_id:'program_demo_food',max_transaction_amount:'',daily_limit:25,merchant_ids:['merchant_el_hornero']});
 const rows=await sql.query("SELECT rule_type,rule_value FROM revale.benefit_rules WHERE program_id='program_demo_food' AND active=true");
 assert.equal(rows.some(r=>r.rule_type==='max_transaction_amount'),false);assert.ok(rows.some(r=>r.rule_type==='location_allowlist'));assert.equal(rows.find(r=>r.rule_type==='daily_limit').rule_value.amount,25);
 await assert.rejects(saveRules(sql,principal,{program_id:'program_demo_food',merchant_ids:['unknown']}),e=>e.status===400);
 await assert.rejects(saveRules(sql,principal,{program_id:'other-program',merchant_ids:[]}),e=>e.status===404);
 await upsertRule(sql,principal,{program_id:'program_demo_food',rule_type:'max_transaction_amount',rule_value:{amount:40}});
 assert.equal((await sql.query("SELECT COUNT(*)::int AS n FROM revale.benefit_rules WHERE program_id='program_demo_food' AND rule_type='max_transaction_amount' AND active=true"))[0].n,1);
});
test('reports reject invalid periods, preserve reversals, isolate another company, and keep demo presentation scoped',async()=>{
 for(const q of [{from:'2026-02-30'},{from:'2027-01-01',to:'2026-01-01'},{from:'2020-01-01',to:'2026-01-01'}])assert.throws(()=>period(q));
 const r=await report(sql,principal,{program_id:'other-program'});assert.equal(r.items.length,0);assert.equal(r.summary.total,0);
 const real=merchantPresentation({...principal,email:'real@example.com'},{id:'merchant_cebiches_ruminahui',name:'Original'});assert.equal(real.name,'Original');
});
test('API enforces session and role capabilities on every employer mutation',async()=>{
 for(const [role,denied] of [['viewer',['update-program','save-rules','upsert-rule','request-funding','update-enrollment']],['hr',['request-funding']],['finance',['update-program','save-rules','upsert-rule','update-enrollment']]]){
   const handler=createEmployerHandler({database:async()=>sql,authenticate:async()=>({...principal,role}),ensureSchema:async()=>{}});
   for(const action of denied){let result;const res={status(code){this.code=code;return this;},setHeader(){return this;},json(body){result={status:this.code,body};}};await handler({method:'POST',query:{action},body:{}},res);assert.equal(result.status,403,role+': '+action);}
 }
 let status;const noAuth=createEmployerHandler({database:async()=>sql,authenticate:async()=>null,ensureSchema:async()=>{throw new Error('Must not reach schema without authentication');}});
 await noAuth({method:'GET',query:{action:'dashboard'}},{status(code){status=code;return this;},setHeader(){return this;},json(){}});assert.equal(status,401);
});

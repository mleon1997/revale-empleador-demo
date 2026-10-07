// Explicit staging-only rehearsal. Private config and credentials stay outside Git.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {hashPassword} from 'better-auth/crypto';
import {PNG} from 'pngjs';
import jsQR from 'jsqr';
import {base32} from '@better-auth/utils/base32';
import {createOTP} from '@better-auth/utils/otp';

const configPath=process.env.REVALE_STAGING_PROBE_CONFIG;
const c=JSON.parse(fs.readFileSync(configPath));
assert.equal(c.origin,'https://revale-staging-mateo-leon-s-projects.vercel.app');
for(const [key,role] of [['connectionString','revale_staging_app'],['identityConnectionString','revale_staging_identity']]){
 const u=new URL(c[key]);assert.equal(u.username,role);assert.match(u.hostname,/^ep-patient-art-b8g0o99p(?:-pooler)?\./);
}
const sql=neon(c.connectionString),identity=neon(c.identityConnectionString),prefix='fundtest_20261007';
const id=s=>prefix+'_'+s;
const mode=process.argv[2];
const output=process.env.REVALE_STAGING_PROBE_OUTPUT;
const results=[];
function report(check,detail={}){const row={check,...detail};results.push(row);console.log(JSON.stringify(row));if(output)fs.writeFileSync(output,JSON.stringify(results,null,2));}
function save(){fs.writeFileSync(configPath,JSON.stringify(c),{mode:0o600});}

if(mode==='seed'){
 assert.equal((await sql.query('SELECT count(*)::int n FROM revale.employers WHERE id=$1',[id('company')]))[0].n,0);
 c.users=[];save();
 for(const [role,portal] of [['companyMaker','employer'],['companyChecker','employer'],['maker','admin'],['checker','admin'],['employee','employee']]){
  const u={role,portal,id:randomUUID(),email:`${prefix}-${role.toLowerCase()}@example.invalid`,password:randomBytes(32).toString('base64url')};
  c.users.push(u);save();
  const password=await hashPassword(u.password);
  await identity.transaction([
   identity.query('INSERT INTO revale_identity."user" (id,name,email,"emailVerified","twoFactorEnabled") VALUES ($1,$2,$3,false,false)',[u.id,'Synthetic funding '+role,u.email]),
   identity.query('INSERT INTO revale_identity.account (id,"accountId","providerId","userId",password,"updatedAt") VALUES ($1,$2,\'credential\',$4::uuid,$3,now())',[randomUUID(),u.id,password,u.id])
  ]);
 }
 const u=role=>c.users.find(x=>x.role===role);
 const q=[];const add=(text,args=[])=>q.push(sql.query(text,args));
 add("INSERT INTO revale.employers(id,name,tax_id,slug,metadata) VALUES ($1,'Empresa Prueba Carga 100','TEST-FUND-20261007',$1,'{\"synthetic\":true}')",[id('company')]);
 add("INSERT INTO revale.benefit_programs(id,employer_id,name,allocation_amount,valid_from,metadata) VALUES ($1,$2,'Alimentación de prueba',100,'2020-01-01','{\"synthetic\":true}')",[id('program'),id('company')]);
 add("INSERT INTO revale.persons(id,person_identification,first_name,last_name,email,company_identification,auth_user_id) VALUES ($1,'TEST-FUND-EMPLOYEE','Andrea','Prueba de carga',$2,'TEST-FUND-20261007',$3)",[id('employee'),u('employee').email,u('employee').id]);
 add('INSERT INTO revale.cards(card_number,person_id) VALUES ($1,$2)',[id('card'),id('employee')]);
 add('INSERT INTO revale.benefit_accounts(id,card_number,balance) VALUES ($1,$2,0)',[id('balance'),id('card')]);
 add("INSERT INTO revale.employee_enrollments(program_id,person_id,starts_on,metadata) VALUES ($1,$2,'2020-01-01','{\"synthetic\":true}')",[id('program'),id('employee')]);
 add('INSERT INTO revale.employer_approval_policies(employer_id,threshold) VALUES ($1,100)',[id('company')]);
 for(const role of ['companyMaker','companyChecker'])add("INSERT INTO revale.employer_users(id,employer_id,auth_user_id,email,display_name,role,approval_limit) VALUES ($1,$2,$3,$4,$5,'finance',100)",[id(role),id('company'),u(role).id,u(role).email,'Synthetic '+role]);
 for(const role of ['maker','checker']){
  add("INSERT INTO revale.admin_users(id,auth_user_id,display_name,email,role) VALUES ($1,$2,$3,$4,'finance')",[id(role),u(role).id,'Synthetic '+role,u(role).email]);
  add("INSERT INTO revale.financial_user_permissions(admin_user_id,can_make,can_approve,approval_limit,metadata) VALUES ($1,$2,$3,100,'{\"synthetic\":true}')",[id(role),role==='maker',true]);
 }
 add("INSERT INTO revale.financial_approval_policies(action_type,label,threshold_amount,approvals_below,approvals_above,expiry_hours,metadata) VALUES ('funding_allocation','Staging funding test',100,1,2,1,'{\"synthetic\":true}')");
 add("INSERT INTO revale.treasury_bank_accounts(id,bank_name,account_name,purpose,is_primary,metadata) VALUES ($1,'Banco ficticio','Prueba sin transferencia real','client_funds',false,'{\"synthetic\":true}')",[id('cash')]);
 add("INSERT INTO revale.gl_accounts(id,internal_code,name,account_type,normal_balance,ifrs_category,metadata) VALUES ('gl_employer_prefund_liability','2.1.01.01','Fondos empresariales pendientes de asignar','liability','credit','current_liabilities','{\"synthetic\":true}') ON CONFLICT(id) DO NOTHING");
 await sql.transaction(q);report('seed',{users:5,employeeBalance:0,realFunds:false});
}else if(mode==='cleanup'){
 // Only fixtures created by this probe; human memberships and sessions are untouched.
 const q=[];for(const table of ['employers','benefit_programs','persons','admin_users','employer_users','treasury_bank_accounts'])q.push(sql.query(`UPDATE revale.${table} SET active=false WHERE id LIKE $1`,[prefix+'_%']));
 q.push(sql.query('UPDATE revale.financial_user_permissions SET active=false WHERE admin_user_id LIKE $1',[prefix+'_%']));
 q.push(sql.query("UPDATE revale.financial_approval_policies SET active=false WHERE action_type='funding_allocation' AND metadata->>'synthetic'='true'"));
 await sql.transaction(q);
 const ids=c.users.map(x=>x.id);
 await identity.query('DELETE FROM revale_identity."user" WHERE id=ANY($1::uuid[]) AND email LIKE $2',[ids,prefix+'-%@example.invalid']);
 report('cleanup',{testMembershipsDisabled:true,testIdentitiesDeleted:true,financialEvidenceRetained:true});
}else if(mode==='run'){
 assert.ok(c.bypass);
 const clients={};
 function client(){const jar=new Map();return {async request(path,body){
  const url=new URL(c.origin+path);if(!jar.size)url.searchParams.set('_vercel_share',c.bypass);
  for(let i=0;i<5;i++){
   const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{origin:c.origin,'content-type':'application/json',cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(30000)});
   for(const line of r.headers.getSetCookie()){const p=line.split(';')[0],j=p.indexOf('=');jar.set(p.slice(0,j),p.slice(j+1));}
   if(r.status>=300&&r.status<400){const next=new URL(r.headers.get('location'),url);assert.equal(next.origin,c.origin,'Protection link expired');url.href=next.href;continue;}
   return {status:r.status,data:await r.json().catch(()=>({nonJson:true}))};
  }throw Error('Redirect limit');
 }};}
 async function ok(a,path,body,status=200){const r=await a.request(path,body);assert.equal(r.status,status,`${path}: ${JSON.stringify(r.data)}`);return r.data;}
 const admin='/api/admin?action=',company='/api/employer?action=';
 const balance=async()=>Number((await sql.query('SELECT balance FROM revale.benefit_accounts WHERE id=$1',[id('balance')]))[0].balance);
 try{
  for(const u of c.users){
   const a=clients[u.role]=client();
   await ok(a,`/api/${u.portal}-auth?action=login`,{email:u.email,password:u.password});
   if(u.portal!=='employee')await ok(a,u.portal==='admin'?admin+'approve-funding':company+'request-funding',{id:'absent'},403);
   const e=await ok(a,'/api/identity?action=enable',{password:u.password,portal:u.portal});
   const png=PNG.sync.read(Buffer.from(e.qr.split(',')[1],'base64')),qr=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);assert.ok(qr);
   const secret=new TextDecoder().decode(base32.decode(new URL(qr.data).searchParams.get('secret')));
   await ok(a,'/api/identity?action=totp',{code:await createOTP(secret).totp(),portal:u.portal});
   report('MFA',{role:u.role});
  }
  const {companyMaker,companyChecker,maker,checker,employee}=clients;
  assert.equal(await balance(),0);
  const request={program_id:id('program'),amount_per_employee:100,expected_employee_count:1,request_id:prefix,external_reference:'PRUEBA-100-SIN-DINERO-REAL'};
  const first=await ok(companyMaker,company+'request-funding',request);c.batchId=first.batch.id;save();
  const repeated=await ok(companyMaker,company+'request-funding',request);assert.equal(repeated.batch.id,c.batchId);assert.equal(repeated.idempotent,true);
  await ok(companyMaker,company+'request-funding',{...request,amount_per_employee:101},409);
  assert.equal(await balance(),0);
  await ok(maker,admin+'approve-funding',{id:c.batchId},409);
  await ok(companyMaker,company+'decide-funding',{id:c.batchId,decision:'approve'},409);
  await ok(companyChecker,company+'decide-funding',{id:c.batchId,decision:'approve'});
  await ok(companyChecker,company+'decide-funding',{id:c.batchId,decision:'approve'});
  await ok(maker,admin+'approve-funding',{id:c.batchId},409);
  report('company-request',{amount:100,batchId:c.batchId,balance:0,idempotent:true,selfApprovalRejected:true,allocationWithoutReceiptRejected:true});
  const receipt={id:c.batchId,amount:100,bank_reference:'TEST-NO-BANK-TRANSFER-20261007',bank_posted_on:'2026-10-07',treasury_account_id:id('cash')};
  await ok(maker,admin+'record-funding-receipt',receipt);await ok(maker,admin+'record-funding-receipt',receipt);
  assert.equal(await balance(),0);
  report('receipt',{received:100,employeeBalanceBeforeApproval:0,realBankTransfer:false});
  const forbidden=await ok(checker,admin+'approve-funding',{id:c.batchId},409);assert.equal(forbidden.detail.code,'maker_not_allowed');
  const approval=await ok(maker,admin+'approve-funding',{id:c.batchId});c.approvalId=approval.result.request.id;save();
  const again=await ok(maker,admin+'approve-funding',{id:c.batchId});assert.equal(again.result.request.id,c.approvalId);
  const self=await ok(maker,admin+'financial-approval-decision',{id:c.approvalId,decision:'approve'},409);assert.equal(self.detail.code,'self_approval_forbidden');
  const approved=await ok(checker,admin+'financial-approval-decision',{id:c.approvalId,decision:'approve'});assert.equal(approved.execution.code,'ok');
  // Repeated decisions may be rejected or return idempotently; they must never credit twice.
  const retries=await Promise.all(Array.from({length:3},()=>checker.request(admin+'financial-approval-decision',{id:c.approvalId,decision:'approve'})));
  assert.ok(retries.every(r=>[200,409].includes(r.status)));
  assert.equal(await balance(),100);
  const dashboard=await ok(employee,'/api/employee?action=dashboard');assert.equal(Number(dashboard.benefit.balance),100);assert.equal(dashboard.activity.items.length,1);assert.equal(dashboard.activity.items[0].amount,100);
  const detail=await ok(companyMaker,company+'funding-detail&id='+c.batchId);assert.equal(detail.batch.progress,'credited');assert.equal(detail.receipts.length,1);assert.equal(detail.items.length,1);
  const [totals]=await sql.query(`SELECT (SELECT count(*) FROM revale.ledger_entries WHERE account_id=$1)::int credits,(SELECT count(*) FROM revale.employer_funding_receipts WHERE funding_batch_id=$2 AND status='confirmed')::int receipts,(SELECT count(*) FROM revale.financial_approval_requests WHERE entity_id=$2)::int approvals`,[id('balance'),c.batchId]);
  assert.deepEqual(totals,{credits:1,receipts:1,approvals:1});
  const gl=await sql.query('SELECT account_id,sum(debit-credit)::numeric(14,2)::text net FROM revale.gl_journal_lines WHERE employer_id=$1 GROUP BY account_id ORDER BY account_id',[id('company')]);
  assert.equal(Number(gl.find(r=>r.account_id==='gl_cash_client_funds')?.net),100);assert.equal(Number(gl.find(r=>r.account_id==='gl_employer_prefund_liability')?.net),0);assert.equal(Number(gl.find(r=>r.account_id==='gl_employee_benefit_liability')?.net),-100);
  report('funding-complete',{balance:100,employeeHistoryCredits:1,...totals,retries:3,retryStatuses:retries.map(r=>r.status),companyProgress:detail.batch.progress,gl,realFunds:false});
 }catch(e){report('failed',{message:e.message});process.exitCode=1;}
 finally{for(const a of Object.values(clients))await a.request('/api/identity?action=logout',{}).catch(()=>{});}
}else throw Error('Use seed, run, or cleanup');

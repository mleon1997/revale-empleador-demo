import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {employerFixture} from './employer-fixture.mjs';
import {requestFunding,fundingDetail} from '../lib/revale-employer.js';
import {team,inviteTeamMember,updateTeamMember,approvalPolicy,updateApprovalPolicy,approvalDetail,approvalInbox,approvalSummary,decideFunding,companyFundingApproved,teamInvitationInfo,claimTeamInvitation,releaseTeamInvitation,completeTeamInvitation,employerGovernanceSchema} from '../lib/revale-employer-governance.js';
import {activateTeamMember} from '../lib/revale-activation.js';
import {getEmployerPrincipal} from '../lib/revale-auth.js';
import {confirmFundingBatchAtomic} from '../lib/revale-admin-funding.js';
import {confirmFundingBatch,prepareFundingItems} from '../lib/revale-benefits.js';

const {db,sql,principal}=await employerFixture();after(()=>db.close());
const users={};
for(const [id,role,company] of [['finance-one','finance',principal.employerId],['finance-two','finance',principal.employerId],['hr','hr',principal.employerId],['outside','admin','other']]){
  const n=Object.keys(users).length+1,auth=`11111111-1111-4111-8111-11111111111${n}`;
  await sql.query('INSERT INTO revale.employer_users(id,employer_id,display_name,email,role,auth_user_id) VALUES($1,$2,$1,$3,$4,$5::uuid)',[id,company,id+'@example.test',role,auth]);
  users[id]={...principal,employerId:company,employerUserId:id,authUserId:auth,role,email:id+'@example.test'};
}
let sequence=0;
const create=(amount=50,actor=users.hr)=>requestFunding(sql,actor,{program_id:'program_demo_food',amount_per_employee:amount,expected_employee_count:2,request_id:'governance-test-'+(++sequence),external_reference:'Alimentación QA '+sequence});
const member=async id=>(await team(sql,principal)).find(u=>u.id===id);
const update=async(id,changes)=>{const m=await member(id);return updateTeamMember(sql,principal,{user_id:id,role:m.role,active:m.active,approval_limit:m.approval_limit,version:m.access_version,reason:'Ajuste autorizado de prueba',...changes});};

test('schema migration matches runtime bootstrap and membership invitations are scoped, hashed and replaceable',async()=>{
  const migration=await readFile(new URL('../db/migrations/20261005_employer_governance.sql',import.meta.url),'utf8');
  for(const statement of employerGovernanceSchema)assert.ok(migration.includes(statement));
  const body={display_name:'María Finanzas',email:'maria@example.test',role:'finance',approval_limit:1000};
  const first=await inviteTeamMember(sql,principal,body),token=first.url.split('#')[1];
  assert.equal(token.length,43);assert.equal((await member(first.id)).access_status,'invited');
  const [stored]=await sql.query('SELECT * FROM revale.employer_team_invites WHERE user_id=$1',[first.id]);assert.notEqual(stored.token_hash,token);assert.equal(JSON.stringify(stored).includes(token),false);
  await assert.rejects(inviteTeamMember(sql,principal,body),e=>e.status===409);
  await assert.rejects(inviteTeamMember(sql,users.outside,{user_id:first.id}),e=>e.status===409);
  const second=await inviteTeamMember(sql,principal,{user_id:first.id});await assert.rejects(teamInvitationInfo(sql,token),e=>e.status===404);
  assert.equal((await teamInvitationInfo(sql,second.url.split('#')[1])).role,'finance');
  await update(first.id,{approval_limit:500});await assert.rejects(teamInvitationInfo(sql,second.url.split('#')[1]),e=>e.status===404);
});
test('team activation verifies the actual provider identity and prevents legacy login bypass',async()=>{
  const invite=await inviteTeamMember(sql,principal,{display_name:'Consulta QA',email:'consulta@example.test',role:'viewer'}),token=invite.url.split('#')[1];
  const authUser={id:'22222222-2222-4222-8222-222222222222',email:'consulta@example.test'};
  assert.equal(await getEmployerPrincipal(sql,{},async()=>({user:authUser})),null);
  const provider={authRequest:async(req,path,options)=>{assert.equal(req.headers.cookie,undefined);assert.equal(JSON.parse(options.body).email,authUser.email);return new Response('{}',{headers:{'set-cookie':'qa=valid; Secure; HttpOnly'}});},readSession:async()=>({user:{...authUser,email:'wrong@example.test'}})};
  await assert.rejects(activateTeamMember(sql,{headers:{cookie:'unrelated'}},{token,password:'una-frase-de-prueba'},provider),e=>e.status===401);
  assert.equal((await member(invite.id)).access_status,'invited');
  await activateTeamMember(sql,{headers:{}},{token,password:'una-frase-de-prueba'},{...provider,readSession:async()=>({user:authUser})});
  assert.equal((await member(invite.id)).access_status,'activated');
  assert.equal((await getEmployerPrincipal(sql,{},async()=>({user:authUser}))).role,'viewer');
  await assert.rejects(teamInvitationInfo(sql,token),e=>e.status===404);
  await assert.rejects(inviteTeamMember(sql,principal,{user_id:invite.id}),e=>e.status===409);
  await update(invite.id,{active:false});assert.equal(await getEmployerPrincipal(sql,{},async()=>({user:authUser})),null);
});
test('team invitation claims expire, throttle attempts and cannot bind the wrong email',async()=>{
  const invite=await inviteTeamMember(sql,principal,{display_name:'Invitación QA',email:'limits@example.test',role:'hr'}),token=invite.url.split('#')[1];
  for(let n=0;n<5;n++){const c=await claimTeamInvitation(sql,token);await assert.rejects(completeTeamInvitation(sql,token,c.claim_id,{id:'33333333-3333-4333-8333-333333333333',email:'wrong@example.test'}),e=>e.status===409);await releaseTeamInvitation(sql,c.claim_id);}
  await assert.rejects(claimTeamInvitation(sql,token),e=>e.status===429);
  await sql.query("UPDATE revale.employer_team_invites SET expires_at=now()-interval '1 second' WHERE user_id=$1",[invite.id]);
  await assert.rejects(teamInvitationInfo(sql,token),e=>e.status===404);
});
test('membership updates require a current admin, forbid self escalation and detect stale versions',async()=>{
  await assert.rejects(updateTeamMember(sql,principal,{user_id:principal.employerUserId,role:'finance',active:true,version:1,reason:'Cambio propio bloqueado'}),e=>e.status===403);
  const original=await member('finance-one');await update('finance-one',{approval_limit:100});
  await assert.rejects(updateTeamMember(sql,principal,{user_id:original.id,role:'admin',active:true,version:original.access_version,reason:'Versión anterior bloqueada'}),e=>e.status===409);
  await assert.rejects(updateTeamMember(sql,users.hr,{user_id:'finance-one',role:'admin',active:true,version:2,reason:'Rol sin permiso bloqueado'}),e=>e.status===409);
  await assert.rejects(updateTeamMember(sql,users.outside,{user_id:'finance-one',role:'admin',active:true,version:2,reason:'Otra empresa bloqueada'}),e=>e.status===409);
  assert.equal((await member('finance-one')).role,'finance');
});
test('approval policy is versioned and snapshots survive later policy changes',async()=>{
  const p=await approvalPolicy(sql,principal.employerId);await updateApprovalPolicy(sql,principal,{threshold:100,version:p.version,reason:'Regla de autorización QA'});
  await assert.rejects(updateApprovalPolicy(sql,principal,{threshold:500,version:p.version,reason:'Versión anterior bloqueada'}),e=>e.status===409);
  const boundary=await create(50),higher=await create(50.01);
  assert.equal((await approvalDetail(sql,principal,boundary.batch.id)).required_approvals,1);
  assert.equal((await approvalDetail(sql,principal,higher.batch.id)).required_approvals,2);
  await updateApprovalPolicy(sql,principal,{threshold:1000,version:p.version+1,reason:'Nueva política futura'});
  assert.equal((await approvalDetail(sql,principal,higher.batch.id)).required_approvals,2);
  assert.equal((await approvalDetail(sql,principal,higher.batch.id)).threshold,100);
});
test('one or two independent authorized approvals are required; duplicates, self approval and other tenants fail',async()=>{
  const p=await approvalPolicy(sql,principal.employerId);await updateApprovalPolicy(sql,principal,{threshold:100,version:p.version,reason:'Regla para doble revisión'});
  const request=await create(50.01),id=request.batch.id;
  assert.equal((await fundingDetail(sql,principal.employerId,id)).batch.progress,'company_pending');
  assert.equal(await approvalDetail(sql,users.outside,id),null);assert.equal((await approvalInbox(sql,users.outside)).items.length,0);
  for(const actor of [users.hr,users.outside,users['finance-one']])await assert.rejects(decideFunding(sql,actor,{id,decision:'approve'}),e=>e.status===409);
  await update('finance-one',{approval_limit:200});
  const first=await decideFunding(sql,users['finance-one'],{id,decision:'approve',note:'Detalle revisado'});assert.equal(first.approval.status,'pending');assert.equal(first.approval.approved_count,1);
  const retry=await decideFunding(sql,users['finance-one'],{id,decision:'approve',note:'Detalle revisado'});assert.equal(retry.idempotent,true);assert.equal(retry.approval.approved_count,1);
  await assert.rejects(decideFunding(sql,users['finance-one'],{id,decision:'reject',note:'Otro intento no permitido'}),e=>e.status===409);
  assert.equal(await companyFundingApproved(sql,id),false);
  const final=await decideFunding(sql,users['finance-two'],{id,decision:'approve'});assert.equal(final.approval.status,'approved');assert.equal(final.approval.approved_count,2);assert.equal(await companyFundingApproved(sql,id),true);
  assert.equal((await approvalInbox(sql,principal,{filter:'history'})).items.some(x=>x.funding_batch_id===id),true);
  const own=await create(25,principal);await assert.rejects(decideFunding(sql,principal,{id:own.batch.id,decision:'approve'}),e=>e.status===409);
  assert.equal((await approvalSummary(sql,principal)).mine>0,true);
  assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,0);
});
test('rejection and withdrawal are terminal and preserve decisions and any received cash',async()=>{
  const rejected=await create(10),withdrawn=await create(10);
  await assert.rejects(decideFunding(sql,users['finance-two'],{id:rejected.batch.id,decision:'reject'}),e=>e.status===400);
  await decideFunding(sql,users['finance-two'],{id:rejected.batch.id,decision:'reject',note:'Revisar monto por persona'});
  await assert.rejects(decideFunding(sql,principal,{id:rejected.batch.id,decision:'approve'}),e=>e.status===409);
  await decideFunding(sql,users.hr,{id:withdrawn.batch.id,decision:'cancel',note:'Retiro para corregir detalle'});
  assert.equal((await fundingDetail(sql,principal.employerId,rejected.batch.id)).batch.progress,'company_rejected');
  assert.equal((await fundingDetail(sql,principal.employerId,withdrawn.batch.id)).batch.progress,'company_cancelled');
  assert.equal(await companyFundingApproved(sql,rejected.batch.id),false);assert.equal(await companyFundingApproved(sql,withdrawn.batch.id),false);
});
test('revoked approvers lose authority immediately; a queue explains missing approvers',async()=>{
  const request=await create(200),id=request.batch.id;
  await update('finance-two',{active:false});
  await assert.rejects(decideFunding(sql,users['finance-two'],{id,decision:'approve'}),e=>e.status===409);
  const d=await approvalDetail(sql,principal,id);assert.equal(d.blocked,true);assert.deepEqual(d.eligible_approvers.map(x=>x.id),[principal.employerUserId]);
  assert.equal((await approvalInbox(sql,users['finance-two'],{filter:'mine'})).items.length,0);
  await update('finance-two',{active:true});
});
test('Admin and legacy allocation entry points cannot bypass company approval or changed roster, even with bank funds',async()=>{
  const request=await create(10),id=request.batch.id;
  await sql.query("INSERT INTO revale.employer_funding_receipts(id,funding_batch_id,employer_id,amount,bank_reference,bank_posted_on) VALUES('receipt-qa',$1,$2,20,'QA-001',CURRENT_DATE)",[id,principal.employerId]);
  await sql.query("UPDATE revale.funding_batches SET status='received' WHERE id=$1",[id]);
  const before=await sql.query('SELECT id,balance FROM revale.benefit_accounts ORDER BY id');
  assert.equal((await confirmFundingBatchAtomic(sql,id)).code,'company_approval_required');
  assert.equal((await confirmFundingBatch(sql,id)).code,'company_approval_required');
  assert.deepEqual(await sql.query('SELECT id,balance FROM revale.benefit_accounts ORDER BY id'),before);
  assert.equal((await prepareFundingItems(sql,{fundingBatchId:id,programId:'program_demo_food',amountPerEmployee:200})).length,0);
  await decideFunding(sql,users['finance-one'],{id,decision:'approve'});
  assert.equal(await companyFundingApproved(sql,id),true);
  await sql.query('UPDATE revale.funding_batch_items SET amount=11 WHERE funding_batch_id=$1 AND enrollment_id=1',[id]);
  assert.equal((await confirmFundingBatchAtomic(sql,id)).code,'company_approval_required');
  await sql.query("UPDATE revale.funding_batches SET metadata=metadata-'company_approval_required' WHERE id=$1",[id]);
  assert.equal(await companyFundingApproved(sql,id),false);
  await sql.query('UPDATE revale.funding_batch_items SET amount=10 WHERE funding_batch_id=$1 AND enrollment_id=1',[id]);
  const result=await confirmFundingBatchAtomic(sql,id);assert.equal(result.code,'ok');assert.equal(result.allocatedAmount,20);
  assert.equal((await confirmFundingBatchAtomic(sql,id)).idempotent,true);
  assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,2);
  assert.equal(Number((await sql.query("SELECT balance FROM revale.benefit_accounts WHERE id='acct_demo_andrea'"))[0].balance),109.05);
});

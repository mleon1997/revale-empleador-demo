import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {employerFixture} from './employer-fixture.mjs';
import {previewEmployees,importEmployees,readEmployeeRows,issueEmployeeInvite,invitationInfo,claimInvitation,completeInvitation,releaseInvitation} from '../lib/revale-onboarding.js';
import {getEmployeePrincipal} from '../lib/revale-auth.js';
import {activateEmployee,activationResult} from '../lib/revale-activation.js';
import {employees,requestFunding,fundingDetail,fundingMoney} from '../lib/revale-employer.js';
import {createEmployerHandler} from '../api/employer.js';

const {db,sql,principal}=await employerFixture();
after(()=>db.close());
const row=(overrides={})=>({first_name:'Sofía',last_name:'Rivera',email:'sofia@example.test',person_identification:'0012345678',starts_on:'2026-01-01',department:'Operaciones',cost_center:'Quito',allocation_amount:'85.50',...overrides});
const input=(rows,key)=>({program_id:'program_demo_food',rows,request_id:key});
let newEnrollment;
test('CSV and Excel preserve identification text and reject formulas',async()=>{
  const csv='\uFEFFNombres;Apellidos;Correo;Identificación;Monto USD\r\n"Sofía";"Rivera; Pérez";sofia@example.test;0012345678;85.50';
  const rows=await readEmployeeRows({file:{name:'equipo.csv',content:Buffer.from(csv).toString('base64')}});
  assert.equal(rows[0].last_name,'Rivera; Pérez');assert.equal(rows[0].person_identification,'0012345678');
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Colaboradores');
  sheet.addRow(['Nombres','Apellidos','Correo','Identificación']);sheet.addRow(['Sofía','Rivera','sofia@example.test','0012345678']);
  let content=Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
  assert.equal((await readEmployeeRows({file:{name:'equipo.xlsx',content}}))[0].person_identification,'0012345678');
  sheet.getCell('A2').value={formula:'1+1',result:2};content=Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
  await assert.rejects(readEmployeeRows({file:{name:'equipo.xlsx',content}}),e=>e.status===400);
});
test('preview finds row errors, duplicates, existing enrollment and foreign identities without exposing foreign data',async()=>{
  const preview=await previewEmployees(sql,principal,input([row(),row({email:'wrong',person_identification:'BAD'}),row({email:'private@example.test',person_identification:'TEST003'}),row({email:'andrea.demo@revale.app',person_identification:'1712345623'})]));
  assert.deepEqual(preview.summary,{new:1,existing:1,errors:2});
  assert.equal(JSON.stringify(preview).includes('Privado Otro'),false);
  assert.equal((await previewEmployees(sql,principal,input([row(),row()]))).summary.errors,2);
  await assert.rejects(previewEmployees(sql,principal,{program_id:'other-program',rows:[row()]}),e=>e.status===404);
});
test('bulk onboarding is atomic, creates zero-balance accounts, and is safely replayed',async()=>{
  const before=(await sql.query('SELECT COUNT(*)::int AS n FROM revale.persons'))[0].n;
  await assert.rejects(importEmployees(sql,principal,input([row(),row({email:'broken'})],'invalid-import-001')),e=>e.status===400);
  assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.persons'))[0].n,before);
  const body=input([row()],'new-import-001');const first=await importEmployees(sql,principal,body);newEnrollment=first.enrollment_ids[0];
  assert.equal(first.created,1);assert.equal(first.existing,0);
  const again=await importEmployees(sql,principal,body);assert.equal(again.idempotent,true);assert.deepEqual(again.enrollment_ids,first.enrollment_ids);
  await assert.rejects(importEmployees(sql,principal,{...body,rows:[row({first_name:'Cambio'})]}),e=>e.status===409);
  const people=await employees(sql,principal.employerId),person=people.find(p=>p.enrollment_id===newEnrollment);
  assert.equal(person.balance,0);assert.equal(person.access_status,'not_invited');assert.equal(person.suggested_amount,85.5);assert.equal(person.department,'Operaciones');
  assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,0);
  assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.funding_batches'))[0].n,0);
  assert.equal((await sql.query("SELECT COUNT(*)::int AS n FROM revale.audit_events WHERE action='employees.imported'"))[0].n,1);
  const duplicate=await importEmployees(sql,principal,input([row()],'new-import-002'));assert.equal(duplicate.created,0);assert.equal(duplicate.existing,1);
});
test('invitations are scoped, hashed, replaceable, expiring and single-use',async()=>{
  await assert.rejects(issueEmployeeInvite(sql,{...principal,employerId:'other'},{enrollment_id:newEnrollment}),e=>e.status===409);
  let link=await issueEmployeeInvite(sql,principal,{enrollment_id:newEnrollment});const oldToken=link.url.split('#')[1];
  assert.equal((await invitationInfo(sql,oldToken)).email,'sofia@example.test');
  const stored=(await sql.query('SELECT token_hash FROM revale.employee_access_invites WHERE enrollment_id=$1',[newEnrollment]))[0].token_hash;assert.notEqual(stored,oldToken);assert.equal(stored.length,64);
  link=await issueEmployeeInvite(sql,principal,{enrollment_id:newEnrollment});const token=link.url.split('#')[1];
  await assert.rejects(invitationInfo(sql,oldToken),e=>e.status===404);
  const claim=await claimInvitation(sql,token);
  await assert.rejects(claimInvitation(sql,token),e=>e.status===429);
  await assert.rejects(completeInvitation(sql,token,claim.claim_id,{id:'12345678-1234-4234-8234-123456789001',email:'wrong@example.test'}),e=>e.status===409);
  await completeInvitation(sql,token,claim.claim_id,{id:'12345678-1234-4234-8234-123456789001',email:'sofia@example.test'});
  await assert.rejects(invitationInfo(sql,token),e=>e.status===404);
  await assert.rejects(issueEmployeeInvite(sql,principal,{enrollment_id:newEnrollment}),e=>e.status===409);
  assert.equal((await employees(sql,principal.employerId)).find(p=>p.enrollment_id===newEnrollment).access_status,'activated');
});
test('activation requires a valid upstream session and limits repeated attempts',async()=>{
  const added=await importEmployees(sql,principal,input([row({email:'new@example.test',person_identification:'0012345679'})],'activation-case-001'));
  const id=added.enrollment_ids[0];const link=await issueEmployeeInvite(sql,principal,{enrollment_id:id});const token=link.url.split('#')[1];
  const req={headers:{cookie:'unrelated-existing-session',origin:'https://mi.revale.app'}};
  const response=()=>new Response('{}',{status:200,headers:{'set-cookie':'session=valid; HttpOnly; Secure'}});
  await assert.rejects(activateEmployee(sql,req,{token,password:'new-password-123',mode:'create'},{authRequest:async r=>{assert.equal(r.headers.cookie,undefined);return response();},readSession:async()=>({user:{id:'12345678-1234-4234-8234-123456789002',email:'intruder@example.test'}})}),e=>e.status===401);
  assert.equal((await employees(sql,principal.employerId)).find(p=>p.enrollment_id===id).access_status,'invited');
  const upstream=await activateEmployee(sql,req,{token,password:'new-password-123',mode:'create'},{authRequest:async()=>response(),readSession:async()=>({user:{id:'12345678-1234-4234-8234-123456789002',email:'new@example.test'}})});
  assert.equal(upstream.status,200);
  const waiting=await importEmployees(sql,principal,input([row({email:'limit@example.test',person_identification:'0012345680'})],'activation-limit-001'));
  const limited=(await issueEmployeeInvite(sql,principal,{enrollment_id:waiting.enrollment_ids[0]})).url.split('#')[1];
  for(let i=0;i<5;i++){const claim=await claimInvitation(sql,limited);await releaseInvitation(sql,claim.claim_id);}
  await assert.rejects(claimInvitation(sql,limited),e=>e.status===429);
  await sql.query("UPDATE revale.employee_access_invites SET expires_at=now()-interval '1 second' WHERE enrollment_id=$1",[waiting.enrollment_ids[0]]);
  await assert.rejects(invitationInfo(sql,limited),e=>e.status===404);
});
test('personalized funding locks the reviewed roster, accounts and cents without moving money',async()=>{
  const before=await sql.query('SELECT id,balance FROM revale.benefit_accounts ORDER BY id');
  const body={program_id:'program_demo_food',request_id:'personalized-001',external_reference:'Recarga revisada',expected_employee_count:2,items:[{enrollment_id:'1',account_id:'acct_demo_andrea',amount:'120.10'},{enrollment_id:'2',account_id:'a2',amount:'75.05'}]};
  const result=await requestFunding(sql,principal,body);assert.equal(result.batch.total,195.15);
  const detail=await fundingDetail(sql,principal.employerId,result.batch.id);assert.equal(detail.batch.progress,'company_pending');assert.equal(detail.items.find(i=>i.enrollment_id==='2').amount,75.05);
  assert.equal((await requestFunding(sql,principal,{...body,items:[...body.items].reverse()})).idempotent,true);
  await assert.rejects(requestFunding(sql,principal,{...body,request_id:'stale-account-001',items:[{enrollment_id:'1',account_id:'a2',amount:50}]}),e=>e.status===409);
  await assert.rejects(requestFunding(sql,principal,{...body,request_id:'foreign-person-001',items:[{enrollment_id:'3',account_id:'a3',amount:50}]}),e=>e.status===409);
  await assert.rejects(requestFunding(sql,principal,{...body,request_id:'duplicate-person-001',items:[body.items[0],body.items[0]]}),e=>e.status===400);
  await assert.rejects(requestFunding(sql,principal,{...body,request_id:'foreign-source-001',source_batch_id:'not-owned'}),e=>e.status===404);
  const repeated=await requestFunding(sql,principal,{...body,request_id:'repeated-request-001',source_batch_id:result.batch.id});assert.equal(repeated.batch.total,195.15);
  assert.deepEqual(await sql.query('SELECT id,balance FROM revale.benefit_accounts ORDER BY id'),before);
  assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM revale.ledger_entries'))[0].n,0);
});

test('an existing MFA user completes an invitation only after the second factor, with matching identity',async()=>{
  const previous=process.env.REVALE_AUTH_PROVIDER;
  const added=await importEmployees(sql,principal,input([row({email:'mfa-invite@example.test',person_identification:'0012345681'})],'mfa-activation-001'));
  const id=added.enrollment_ids[0],token=(await issueEmployeeInvite(sql,principal,{enrollment_id:id})).url.split('#')[1];
  process.env.REVALE_AUTH_PROVIDER='better-auth-mfa';
  try {
    const pending=await activateEmployee(sql,{headers:{}},{token,password:'existing-password-2026',mode:'existing'},{
      authRequest:async()=>Response.json({twoFactorRedirect:true},{headers:{'set-cookie':'challenge=test; Secure; HttpOnly'}}),
      readSession:async()=>{throw new Error('Pending MFA must not bind an invitation');}
    });
    assert.equal((await employees(sql,principal.employerId)).find(p=>p.enrollment_id===id).access_status,'invited');
    assert.equal((await activationResult(pending,'employee',token)).next,'/seguridad/?portal=employee&activation=1#'+token);
    const user={id:'12345678-1234-4234-8234-123456789003',email:'mfa-invite@example.test',twoFactorEnabled:true};
    const resume=(session)=>activateEmployee(sql,{headers:{cookie:'authenticated'}},{token,mode:'session'},{readSession:async()=>session});
    await assert.rejects(resume({user,session:{mfaVerified:false}}),e=>e.status===403);
    await assert.rejects(resume({user:{...user,email:'other@example.test'},session:{mfaVerified:true}}),e=>e.status===401);
    assert.equal((await resume({user,session:{mfaVerified:true}})).status,200);
    assert.equal((await employees(sql,principal.employerId)).find(p=>p.enrollment_id===id).access_status,'activated');
    await assert.rejects(resume({user,session:{mfaVerified:true}}),e=>e.status===404);
  }finally{if(previous===undefined)delete process.env.REVALE_AUTH_PROVIDER;else process.env.REVALE_AUTH_PROVIDER=previous;}
});
test('funding progress distinguishes partial cash, partial credit, completion and cancellation',()=>{
  const base={item_total:200,received_amount:100,refunded_amount:0,allocated_amount:0,status:'received'};
  assert.equal(fundingMoney(base).progress,'partial_funding');
  assert.equal(fundingMoney({...base,received_amount:200}).progress,'awaiting_credit');
  assert.equal(fundingMoney({...base,received_amount:200,allocated_amount:100}).progress,'partial_credit');
  assert.equal(fundingMoney({...base,received_amount:200,allocated_amount:200,status:'allocated'}).progress,'credited');
  assert.equal(fundingMoney({...base,status:'cancelled'}).progress,'cancelled');
});
test('finance and viewer roles cannot provision or issue employee invitations',async()=>{
  for(const role of ['finance','viewer'])for(const action of ['preview-employees','import-employees','invite-employee']){
    let status;const handler=createEmployerHandler({database:async()=>sql,authenticate:async()=>({...principal,role}),ensureSchema:async()=>{}});
    await handler({method:'POST',query:{action},body:{},headers:{host:'empresas.revale.app',origin:'https://empresas.revale.app'}},{status(code){status=code;return this;},setHeader(){return this;},json(){}});assert.equal(status,403);
  }
});

test('employee login cannot bypass activation and benefit start dates use Ecuador time',async()=>{
  const unclaimed=await getEmployeePrincipal(sql,{},async()=>({user:{id:'12345678-1234-4234-8234-123456789009',email:'limit@example.test'}}));
  assert.equal(unclaimed,null);
  const session=async()=>({user:{id:'12345678-1234-4234-8234-123456789001',email:'sofia@example.test'}});
  assert.ok((await getEmployeePrincipal(sql,{},session)).benefit);
  await sql.query("UPDATE revale.employee_enrollments SET starts_on=(now() AT TIME ZONE 'America/Guayaquil')::date+1 WHERE id=$1",[newEnrollment]);
  assert.equal((await getEmployeePrincipal(sql,{},session)).benefit,null);
  await sql.query("UPDATE revale.employee_enrollments SET starts_on='2026-01-01' WHERE id=$1",[newEnrollment]);
});

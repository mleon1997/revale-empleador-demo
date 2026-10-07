import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes,createHash,randomUUID } from 'node:crypto';
import { identityFixture } from './identity-fixture.mjs';
import { activateAdmin,activationResult } from '../lib/revale-activation.js';
import { adminInvitationInfo,claimAdminInvitation,releaseAdminInvitation,completeAdminInvitation } from '../lib/revale-admin-onboarding.js';
import { identityRequest,identitySession,mergedCookie,verifyIdentityFactor } from '../lib/revale-identity.js';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';

test('personal admin invitation stays inactive until MFA, then binds once using the full baseline',async()=>{
  const f=await identityFixture();
  const old={REVALE_MODE:process.env.REVALE_MODE,REVALE_AUTH_PROVIDER:process.env.REVALE_AUTH_PROVIDER,VERCEL_ENV:process.env.VERCEL_ENV};
  Object.assign(process.env,{REVALE_MODE:'live',REVALE_AUTH_PROVIDER:'better-auth-mfa',VERCEL_ENV:'preview'});
  try{
    await f.exec('DROP SCHEMA IF EXISTS revale CASCADE');
    await f.exec(await readFile(new URL('../db/baseline/20261006_revale.sql',import.meta.url),'utf8'));
    await f.exec(await readFile(new URL('../db/migrations/20261006_admin_invitations.sql',import.meta.url),'utf8'));
    const sql={query:async(text,args)=>(await f.query(text,args)).rows};
    const token=randomBytes(32).toString('base64url'),email='admin-onboarding@example.invalid',password=randomBytes(32).toString('base64url');
    await f.query("INSERT INTO revale.admin_users(id,display_name,email,role,active) VALUES ('new','Synthetic admin',$1,'superadmin',false)",[email]);
    await f.query("INSERT INTO revale.admin_access_invites(admin_user_id,token_hash,email,invited_role,created_by,expires_at) VALUES ('new',$1,$2,'superadmin','synthetic',now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),email]);
    assert.equal((await adminInvitationInfo(sql,token)).role,'superadmin');
    const options={authRequest:(req,path,opts)=>identityRequest(f.auth,req,path,opts),readSession:req=>identitySession(f.auth,req)};
    const upstream=await activateAdmin(sql,{headers:{}},{token,password,mode:'create',role:'finance'},options);
    assert.equal(upstream.status,200);
    assert.equal((await activationResult(upstream,'admin',token)).next,'/seguridad/?portal=admin&activation=1#'+token);
    let req={headers:{cookie:mergedCookie({headers:{}},upstream)}};
    assert.equal((await f.query("SELECT active FROM revale.admin_users WHERE id='new'")).rows[0].active,false);
    await assert.rejects(activateAdmin(sql,req,{token,mode:'session'},options),e=>e.status===403);
    const enabled=await identityRequest(f.auth,req,'/two-factor/enable',{method:'POST',body:JSON.stringify({password,method:'totp'})});
    const data=await enabled.json();assert.equal(enabled.status,200);
    const factor=new TextDecoder().decode(base32.decode(new URL(data.totpURI).searchParams.get('secret')));
    const verified=await verifyIdentityFactor(f.auth,req,'totp',await createOTP(factor).totp());assert.equal(verified.status,200);
    req={headers:{cookie:mergedCookie(req,verified)}};
    assert.equal((await activateAdmin(sql,req,{token,mode:'session',role:'finance'},options)).status,200);
    const [admin]=await sql.query("SELECT active,role,auth_user_id::text FROM revale.admin_users WHERE id='new'");
    assert.equal(admin.active,true);assert.equal(admin.role,'superadmin');assert.equal(admin.auth_user_id,(await identitySession(f.auth,req)).user.id);
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM revale.audit_events WHERE action='admin.activated'"))[0].n,1);
    await assert.rejects(activateAdmin(sql,req,{token,mode:'session'},options),e=>e.status===404);
    // The runtime role receives no delete, schema ownership, or identity grants.
    await f.exec("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='revale_runtime') THEN CREATE ROLE revale_runtime NOLOGIN; END IF; END $$;");
    await f.exec(await readFile(new URL('../db/baseline/admin-invitation-runtime-grants.sql',import.meta.url),'utf8'));
    const [grants]=await sql.query("SELECT has_table_privilege('revale_runtime','revale.admin_access_invites','SELECT,INSERT,UPDATE') AS allowed,has_table_privilege('revale_runtime','revale.admin_access_invites','DELETE') AS can_delete");
    assert.equal(grants.allowed,true);assert.equal(grants.can_delete,false);
  }finally{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await f.close();}
});

test('admin invitations reject expiry, revocation, changed email/role, competing claims and unverified identities',async()=>{
  const f=await identityFixture();
  try{
    await f.exec('DROP SCHEMA IF EXISTS revale CASCADE');
    await f.exec(await readFile(new URL('../db/baseline/20261006_revale.sql',import.meta.url),'utf8'));
    await f.exec(await readFile(new URL('../db/migrations/20261006_admin_invitations.sql',import.meta.url),'utf8'));
    const sql={query:async(text,args)=>(await f.query(text,args)).rows};
    const token=randomBytes(32).toString('base64url'),email='admin-guard@example.invalid';
    await sql.query("INSERT INTO revale.admin_users(id,display_name,email,role,active) VALUES ('guard','Test',$1,'finance',false)",[email]);
    await sql.query("INSERT INTO revale.admin_access_invites(admin_user_id,token_hash,email,invited_role,created_by,expires_at) VALUES ('guard',$1,$2,'finance','synthetic',now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),email]);
    await assert.rejects(adminInvitationInfo(sql,'invalid'),e=>e.status===404);
    for(const [set,undo] of [["expires_at=now()-interval '1 hour'","expires_at=now()+interval '1 hour'"],["revoked_at=now()","revoked_at=NULL"],["email='other@example.invalid'","email='admin-guard@example.invalid'"],["invited_role='superadmin'","invited_role='finance'"]]){
      await sql.query('UPDATE revale.admin_access_invites SET '+set);
      await assert.rejects(adminInvitationInfo(sql,token),e=>e.status===404);
      await sql.query('UPDATE revale.admin_access_invites SET '+undo);
    }
    const claims=await Promise.allSettled(Array.from({length:8},()=>claimAdminInvitation(sql,token)));
    assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
    const claim=claims.find(r=>r.status==='fulfilled').value;
    const user={id:randomUUID(),email,twoFactorEnabled:true};
    await assert.rejects(completeAdminInvitation(sql,token,claim.claim_id,user,{user,session:{mfaVerified:false}}),e=>e.status===403);
    await assert.rejects(completeAdminInvitation(sql,token,claim.claim_id,{...user,email:'other@example.invalid'},{user,session:{mfaVerified:true}}),e=>e.status===401);
    await releaseAdminInvitation(sql,claim.claim_id);
    await sql.query("UPDATE revale.admin_access_invites SET attempts=10,attempt_window=now()");
    await assert.rejects(claimAdminInvitation(sql,token),e=>e.status===429);
    assert.equal((await sql.query("SELECT active FROM revale.admin_users WHERE id='guard'"))[0].active,false);
  }finally{await f.close();}
});

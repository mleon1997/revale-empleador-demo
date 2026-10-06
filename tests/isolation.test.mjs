import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { authOrigin, runtimeBootstrapAllowed, databaseUrl, authUrl } from '../lib/revale-security.js';
import { neonAuthRequest } from '../lib/revale-auth.js';
import { ensureOnboardingSchema } from '../lib/revale-onboarding.js';
import { ensureEmployerGovernanceSchema } from '../lib/revale-employer-governance.js';
import { ensureFundingTreasurySchema } from '../lib/revale-admin-funding.js';
import { ensureFinancialApprovalSchema, financialPermission } from '../lib/revale-financial-approvals.js';
import { ensureSafeguardingSchema } from '../lib/revale-safeguarding.js';
import { ensureBankReconciliationSchema } from '../lib/revale-bank-reconciliation.js';
import { ensureSettlementTaxSchema } from '../lib/revale-settlement-tax.js';

const ensureSchemas = [ensureOnboardingSchema, ensureEmployerGovernanceSchema,
  ensureFundingTreasurySchema, ensureFinancialApprovalSchema, ensureSafeguardingSchema,
  ensureBankReconciliationSchema, ensureSettlementTaxSchema];

test('isolated deployments never bootstrap schema or legacy financial grants', () => {
  for (const env of [{}, {REVALE_MODE:'live'}, {REVALE_MODE:'demo',VERCEL_ENV:'preview'},
    {REVALE_MODE:'demo',REVALE_SCHEMA_MODE:'managed'}]) {
    assert.equal(runtimeBootstrapAllowed(env), false);
  }
  assert.equal(runtimeBootstrapAllowed({REVALE_MODE:'demo',VERCEL_ENV:'production'}), true);
});

test('preview refuses live credentials and requires its own Auth origin', () => {
  const env={REVALE_MODE:'live',VERCEL_ENV:'preview',
    REVALE_LIVE_DATABASE_URL:'postgres://user:placeholder@live.example/db',
    REVALE_LIVE_AUTH_URL:'https://live.auth.example'};
  assert.throws(()=>databaseUrl(env),/ISOLATED_PREVIEW_DATABASE/);
  assert.throws(()=>authUrl(env),/ISOLATED_PREVIEW_AUTH/);
  assert.throws(()=>authOrigin(env),/REVALE_AUTH_ORIGIN_REQUIRED/);
  const configured={...env,REVALE_PREVIEW_DATABASE_URL:'postgres://user:placeholder@staging.example/db',
    REVALE_PREVIEW_AUTH_URL:'https://staging.auth.example',REVALE_AUTH_ORIGIN:'https://staging.example/'};
  assert.equal(databaseUrl(configured),configured.REVALE_PREVIEW_DATABASE_URL);
  assert.equal(authUrl(configured),configured.REVALE_PREVIEW_AUTH_URL);
  assert.equal(authOrigin(configured),'https://staging.example');
  assert.throws(()=>databaseUrl({...configured,REVALE_PREVIEW_DATABASE_URL:env.REVALE_LIVE_DATABASE_URL}),/ISOLATED_PREVIEW_DATABASE/);
  assert.throws(()=>authUrl({...configured,REVALE_PREVIEW_AUTH_URL:env.REVALE_LIVE_AUTH_URL+'/'}),/ISOLATED_PREVIEW_AUTH/);
  assert.throws(()=>databaseUrl({...configured,VERCEL_ENV:'production',REVALE_LIVE_DATABASE_URL:configured.REVALE_PREVIEW_DATABASE_URL}),/ISOLATED_LIVE_DATABASE/);
  assert.throws(()=>authUrl({...configured,VERCEL_ENV:'production',REVALE_LIVE_AUTH_URL:configured.REVALE_PREVIEW_AUTH_URL}),/ISOLATED_LIVE_AUTH/);
  for (const value of ['http://staging.example','https://user:password@staging.example',
    'https://staging.example/path','https://staging.example?query','https://staging.example#hash']) {
    assert.throws(()=>authOrigin({...env,REVALE_AUTH_ORIGIN:value}),/INVALID_REVALE_AUTH_ORIGIN/);
  }
  assert.equal(authOrigin({REVALE_MODE:'demo'}),'https://comercios.revale.app');
});

test('Auth proxy uses the configured staging provider and origin, preserving cookie handling', async t => {
  const before={...process.env};
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);});
  Object.assign(process.env,{REVALE_MODE:'live',VERCEL_ENV:'preview',
    REVALE_PREVIEW_AUTH_URL:'https://staging.auth.example',REVALE_AUTH_ORIGIN:'https://staging.example'});
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(url,'https://staging.auth.example/get-session');
    assert.equal(options.headers.get('origin'),'https://staging.example');
    assert.equal(options.headers.get('referer'),'https://staging.example/');
    assert.equal(options.headers.get('cookie'),'test-session=synthetic');
    assert.equal(options.redirect,'manual');
    return new Response('{}');
  });
  await neonAuthRequest({headers:{origin:'https://untrusted.example',cookie:'test-session=synthetic'}},'/get-session',{method:'GET'});
});

test('runtime role can use migrated schema without DDL or access to provider identity tables', async t => {
  const before={...process.env};
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);});
  const db=new PGlite();
  try {
    await db.exec(await readFile(new URL('../db/baseline/20261006_revale.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../db/baseline/runtime-role.sql',import.meta.url),'utf8'));
    await db.exec(`CREATE SCHEMA neon_auth; CREATE TABLE neon_auth.secret_test(id text);
      INSERT INTO revale.admin_users(id,display_name,email,role) VALUES ('test-admin','Synthetic admin','admin@example.invalid','superadmin');
      SET ROLE revale_runtime;`);
    const sql={query:async(text,args=[]) => (await db.query(text,args)).rows};
    for (const env of [{REVALE_MODE:'live',VERCEL_ENV:'production'},
      {REVALE_MODE:'demo',VERCEL_ENV:'preview'}, {REVALE_MODE:'demo',VERCEL_ENV:'production',REVALE_SCHEMA_MODE:'managed'}]) {
      Object.assign(process.env,env);
      for(const ensure of ensureSchemas)await ensure(sql);
      const permission=await financialPermission(sql,'test-admin');
      assert.equal(permission.can_make,false);
      assert.equal(permission.can_approve,false);
      assert.equal(permission.active,false);
      assert.equal((await sql.query('SELECT count(*)::int AS n FROM revale.financial_user_permissions'))[0].n,0);
    }
    await sql.query(`INSERT INTO revale.audit_events(actor_type,action,resource_type) VALUES ('test','isolation_test','test')`);
    await sql.query(`UPDATE revale.audit_events SET action='isolation_verified' WHERE action='isolation_test'`);
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM revale.audit_events'))[0].n,1);
    for(const statement of [
      'CREATE TABLE revale.forbidden(id int)',
      'ALTER TABLE revale.admin_users ADD COLUMN forbidden text',
      'DROP TABLE revale.admin_users',
      'TRUNCATE revale.audit_events',
      'DELETE FROM revale.audit_events',
      'SELECT * FROM neon_auth.secret_test',
      "SELECT setval('revale.audit_events_id_seq',999)",
      'CREATE ROLE forbidden_role'
    ]) await assert.rejects(sql.query(statement), /permission denied|must be owner/);
  } finally { await db.close(); }
});

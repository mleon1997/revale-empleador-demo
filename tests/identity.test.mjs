import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { createIdentity, identityConfig, identitySession, verifyIdentityFactor, requireMfa } from '../lib/revale-identity.js';
import { createIdentityHandler } from '../api/identity.js';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { readFile } from 'node:fs/promises';

test('MFA configuration cannot activate on demo/live or borrow application credentials', () => {
  const env = { REVALE_AUTH_PROVIDER: 'better-auth-mfa', VERCEL_ENV: 'preview', REVALE_MODE: 'live',
    REVALE_PREVIEW_DATABASE_URL: 'postgres://revale_staging_app:password@staging.example/neondb',
    REVALE_PREVIEW_IDENTITY_DATABASE_URL: 'postgres://revale_staging_identity:password@staging.example/neondb',
    REVALE_PREVIEW_IDENTITY_SECRET: 'x'.repeat(64), REVALE_AUTH_ORIGIN: 'https://staging.example' };
  assert.equal(identityConfig(env).origin, 'https://staging.example');
  for (const extra of [{ VERCEL_ENV: 'production' }, { REVALE_MODE: 'demo' }, { REVALE_PREVIEW_IDENTITY_SECRET: '' },
    { REVALE_PREVIEW_IDENTITY_DATABASE_URL: env.REVALE_PREVIEW_DATABASE_URL },
    { REVALE_PREVIEW_IDENTITY_DATABASE_URL: 'postgres://revale_staging_identity:password@live.example/neondb' }]) {
    assert.throws(() => identityConfig({ ...env, ...extra }));
  }
});

test('MFA identity endpoints fail closed before touching credentials or data', async () => {
  let calls = 0;
  const handler = createIdentityHandler({ enabled: () => false, identity: () => { calls++; } });
  async function request(method, origin) {
    let result;
    const res = { status(code) { this.code = code; return this; }, setHeader() { return this; }, json(body) { result = { status: this.code, body }; } };
    await handler({ method, headers: { host: 'staging.example', origin }, query: { action: 'enable' }, body: {} }, res);
    return result;
  }
  assert.equal((await request('GET')).status, 404);
  assert.equal((await request('POST', 'https://foreign.example')).status, 403);
  assert.equal(calls, 0);
});

test('password, enrollment, TOTP, recovery and logout enforce session-specific MFA', async () => {
  const f = await identityFixture();
  try {
    const migration=await readFile(new URL('../db/migrations/20261006_staging_mfa.sql',import.meta.url),'utf8');
    assert.ok(migration.includes(f.ddl), 'reviewed migration matches the installed provider version');
    const password = 'Synthetic-password-only-2026!', email = 'mfa-test@example.invalid';
    const a = f.client(), b = f.client();
    const signup = await a.request('/sign-up/email', { name: 'Synthetic tester', email, password, mfaVerified: true });
    assert.equal(signup.response.status, 200);
    let session = await identitySession(f.auth, a.req);
    assert.equal(session.session.mfaVerified, false, 'client cannot supply assurance');
    assert.throws(() => requireMfa(session), e => e.code === 'MFA_REQUIRED');
    assert.equal((await b.request('/sign-in/email', { email, password })).response.status, 200);
    const oldPasswordOnlyCookie = b.req;
    const badEnable = await a.request('/two-factor/enable', { password: 'wrong-password', method: 'totp' });
    assert.equal(badEnable.response.ok, false);
    const enabled = await a.request('/two-factor/enable', { password, method: 'totp' });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.data.backupCodes.length, 10);
    const secret = new TextDecoder().decode(base32.decode(new URL(enabled.data.totpURI).searchParams.get('secret')));
    const stored = (await f.query('SELECT secret,"backupCodes" FROM revale_identity."twoFactor"')).rows[0];
    assert.notEqual(stored.secret, secret);
    assert.ok(!stored.backupCodes.includes(enabled.data.backupCodes[0]), 'recovery codes encrypted at rest');
    const code = await createOTP(secret).totp();
    assert.equal((await verifyIdentityFactor(f.auth, a.req, 'recovery', enabled.data.backupCodes[0])).status, 403);
    const verified = await verifyIdentityFactor(f.auth, a.req, 'totp', code);
    assert.equal(verified.status, 200);
    a.accept(verified);
    session = await identitySession(f.auth, a.req);
    assert.equal(requireMfa(session).session.mfaVerified, true);
    const awaitSession = await identitySession(f.auth, oldPasswordOnlyCookie);
    assert.throws(() => requireMfa(awaitSession), e => e.code === 'MFA_REQUIRED', 'old password-only session stays blocked');
    const logout = await a.request('/sign-out', {});
    assert.equal(logout.response.status, 200);
    assert.equal(await identitySession(f.auth, a.req), null);
    const c = f.client();
    const challenge = await c.request('/sign-in/email', { email, password });
    assert.equal(challenge.data.twoFactorRedirect, true);
    assert.equal(await identitySession(f.auth, c.req), null, 'password must not issue a usable session');
    const challengeCookie = c.req;
    assert.equal((await verifyIdentityFactor(f.auth, c.req, 'totp', 'not-code')).ok, false);
    const recovered = await verifyIdentityFactor(f.auth, c.req, 'recovery', enabled.data.backupCodes[0]);
    assert.equal(recovered.status, 200);
    c.accept(recovered);
    assert.equal(requireMfa(await identitySession(f.auth, c.req)).session.mfaVerified, true);
    assert.equal((await verifyIdentityFactor(f.auth, challengeCookie, 'recovery', enabled.data.backupCodes[1])).ok, false, 'consumed challenge cannot create a second session');
    const d = f.client();
    await d.request('/sign-in/email', { email, password });
    assert.equal((await verifyIdentityFactor(f.auth, d.req, 'recovery', enabled.data.backupCodes[0])).ok, false, 'recovery code cannot be reused');
    const other = createIdentity({ pool: f.pool, origin: 'https://other.example', secret: 'unrelated-isolated-test-only-secret-value-2026', cookiePrefix: 'other-environment' });
    assert.equal(await identitySession(other,c.req), null, 'other environment does not accept the session');
    const expired = f.client();
    await expired.request('/sign-in/email', { email, password });
    await f.query('UPDATE revale_identity.verification SET "expiresAt"=now()-interval \'1 minute\'');
    assert.equal((await verifyIdentityFactor(f.auth, expired.req, 'totp', code)).ok, false, 'expired challenges cannot be used');
    for (const cookie of recovered.headers.getSetCookie().filter(c => c.includes('session_token='))) {
      assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Lax/i);
    }
  } finally { await f.close(); }
});

test('identity role accesses only its schema and cannot modify structure', async () => {
  const f = await identityFixture();
  try {
    const roleSql=await readFile(new URL('../db/baseline/identity-runtime-role.sql',import.meta.url),'utf8');
    const client=await f.pool.connect();
    try {
      // Independent synthetic schemas, never a remote database.
      await client.query('CREATE SCHEMA IF NOT EXISTS neon_auth');
      await client.query('CREATE TABLE IF NOT EXISTS neon_auth.test_private(id int)');
      await client.query(roleSql);
      await client.query('SET ROLE revale_identity_runtime');
      await client.query('SELECT id FROM revale_identity.session LIMIT 0');
      await client.query('UPDATE revale_identity.session SET "mfaVerified"=false WHERE false');
      await client.query('DELETE FROM revale_identity.session WHERE false');
      await assert.rejects(client.query('SELECT * FROM neon_auth.test_private'), /permission denied/);
      await assert.rejects(client.query('CREATE TABLE revale_identity.forbidden(id int)'), /permission denied/);
      await client.query('RESET ROLE');
    } finally { await client.query('RESET ROLE');client.release(); }
  }finally{await f.close();}
});

test('a concurrent MFA challenge creates only one authorized session on PostgreSQL', {skip:!process.env.REVALE_TEST_DATABASE_URL}, async () => {
  const f=await identityFixture();
  try {
    const email='concurrent-test@example.invalid',password='Synthetic-concurrency-test-2026!';
    const c=f.client();
    await c.request('/sign-up/email',{email,password,name:'Concurrency tester'});
    const enabled=await c.request('/two-factor/enable',{password,method:'totp'});
    const secret=new TextDecoder().decode(base32.decode(new URL(enabled.data.totpURI).searchParams.get('secret')));
    const code=await createOTP(secret).totp();
    c.accept(await verifyIdentityFactor(f.auth,c.req,'totp',code));
    await c.request('/sign-out',{});
    await c.request('/sign-in/email',{email,password});
    const results=await Promise.all(Array.from({length:8},()=>verifyIdentityFactor(f.auth,c.req,'totp',code)));
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal((await f.query('SELECT count(*)::int AS n FROM revale_identity.session WHERE "mfaVerified"=true')).rows[0].n,1);
  }finally{await f.close();}
});

test('five incorrect second factors lock the account across fresh challenges', async () => {
  const f = await identityFixture();
  try {
    const email='locked-test@example.invalid',password='Synthetic-locked-account-2026!';
    const enrolled=f.client();
    await enrolled.request('/sign-up/email',{email,password,name:'Lockout tester'});
    const enabled=await enrolled.request('/two-factor/enable',{password,method:'totp'});
    const secret=new TextDecoder().decode(base32.decode(new URL(enabled.data.totpURI).searchParams.get('secret')));
    const code=await createOTP(secret).totp();
    const response=await verifyIdentityFactor(f.auth,enrolled.req,'totp',code);
    enrolled.accept(response);
    await enrolled.request('/sign-out',{});
    for(let i=0;i<5;i++) {
      const attempt=f.client();
      assert.equal((await attempt.request('/sign-in/email',{email,password})).data.twoFactorRedirect,true);
      assert.equal((await verifyIdentityFactor(f.auth,attempt.req,'totp','bad-code')).ok,false);
    }
    const fresh=f.client();
    await fresh.request('/sign-in/email',{email,password});
    assert.equal((await verifyIdentityFactor(f.auth,fresh.req,'totp',code)).status,429);
    assert.equal(await identitySession(f.auth,fresh.req),null);
  } finally { await f.close(); }
});

test('the public MFA handler exposes only the intended actions and never tokens', async () => {
  const f=await identityFixture();
  try {
    const handler=createIdentityHandler({enabled:()=>true,identity:()=>f.auth});
    async function call(action,body={},method='POST') {
      let output;
      const res={status(code){this.code=code;return this;},setHeader(){return this;},json(data){output={status:this.code,data};}};
      await handler({method,headers:{host:'staging.example',origin:'https://staging.example','x-vercel-forwarded-for':'192.0.2.250'},query:{action},body},res);
      return output;
    }
    for(const action of ['sign-up/email','disable','delete-user','change-email'])assert.equal((await call(action)).status,404);
    assert.equal((await call('enable',{password:'unknown'})).status,401);
    const status=await call('status',{},'GET');
    assert.equal(status.status,200);
    assert.deepEqual(status.data,{ok:true,authenticated:false,enrolled:false,verified:false});
    assert.equal((await f.query('SELECT count(*)::int AS n FROM revale_identity."user"')).rows[0].n,0);
  }finally{await f.close();}
});

test('public session throttling cannot consume recovery without establishing MFA assurance', async () => {
  const f=await identityFixture();
  try {
    const email='session-throttle@example.invalid',password='Synthetic-session-throttle-2026!';
    const c=f.client();
    await c.request('/sign-up/email',{email,password,name:'Session throttle tester'});
    const enabled=await c.request('/two-factor/enable',{password,method:'totp'});
    const secret=new TextDecoder().decode(base32.decode(new URL(enabled.data.totpURI).searchParams.get('secret')));
    c.accept(await verifyIdentityFactor(f.auth,c.req,'totp',await createOTP(secret).totp()));
    await c.request('/sign-out',{});
    await c.request('/sign-in/email',{email,password});
    for(let i=0;i<60;i++)assert.equal((await c.request('/get-session')).response.status,200);
    assert.equal((await c.request('/get-session')).response.status,429);
    const handler=createIdentityHandler({enabled:()=>true,identity:()=>f.auth});
    let status;
    const res={status(code){status=code;return this;},setHeader(){return this;},json(){}};
    await handler({method:'GET',headers:c.req.headers,query:{action:'status'}},res);
    assert.equal(status,429,'the public status endpoint retains its rate limit');
    const recovered=await verifyIdentityFactor(f.auth,c.req,'recovery',enabled.data.backupCodes[0]);
    assert.equal(recovered.status,200);
    c.accept(recovered);
    assert.equal(requireMfa(await identitySession(f.auth,c.req)).session.mfaVerified,true);
  } finally {await f.close();}
});

// Synthetic credentials only. Never logs factors, recovery codes or encryption keys.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { symmetricDecrypt } from 'better-auth/crypto';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { createIdentity, identityRequest, identitySession, mergedCookie, requireMfa, verifyIdentityFactor } from '../lib/revale-identity.js';

export function restoreClient(auth, ip = '192.0.2.200') {
  let cookie = '';
  return {
    get req() { return { headers: { cookie, 'x-vercel-forwarded-for': ip } }; },
    accept(response) { cookie = mergedCookie(this.req, response); },
    async request(path, body) {
      const response = await identityRequest(auth, this.req, path, { method: 'POST', body: JSON.stringify(body) });
      this.accept(response); return { response, data: await response.json() };
    }
  };
}

export async function prepareRecoveryFixture(f) {
  const email = 'restore-test@example.invalid', password = randomBytes(32).toString('base64url');
  const a = restoreClient(f.auth);
  assert.equal((await a.request('/sign-up/email', {email,password,name:'Synthetic restore user'})).response.status,200);
  const enabled = await a.request('/two-factor/enable', {password,method:'totp'});
  assert.equal(enabled.response.status,200);
  const factor = new TextDecoder().decode(base32.decode(new URL(enabled.data.totpURI).searchParams.get('secret')));
  const verified = await verifyIdentityFactor(f.auth,a.req,'totp',await createOTP(factor).totp());
  assert.equal(verified.status,200);a.accept(verified);
  await a.request('/sign-out',{});
  await a.request('/sign-in/email',{email,password});
  const recovered = await verifyIdentityFactor(f.auth,a.req,'recovery',enabled.data.backupCodes[0]);
  assert.equal(recovered.status,200);a.accept(recovered);
  assert.equal(requireMfa(await identitySession(f.auth,a.req)).session.mfaVerified,true);
  const challenge = restoreClient(f.auth,'192.0.2.201');
  assert.equal((await challenge.request('/sign-in/email',{email,password})).data.twoFactorRedirect,true);
  return { email,password,factor,codes:enabled.data.backupCodes,oldSession:a.req,oldChallenge:challenge.req,
    secret:f.config.secret,origin:f.config.origin };
}

export async function verifyIdentityAfterRestore({pool,query}, state) {
  const auth = createIdentity({pool,origin:state.origin,secret:state.secret});
  const stored = (await query('SELECT secret,"backupCodes" FROM revale_identity."twoFactor"')).rows[0];
  assert.equal(await symmetricDecrypt({key:state.secret,data:stored.secret}),state.factor,'Correct separately recovered key decrypts the factor');
  await assert.rejects(symmetricDecrypt({key:randomBytes(48).toString('base64url'),data:stored.secret}), 'Database alone and a replacement key cannot recover MFA');
  assert.ok(!JSON.parse(await symmetricDecrypt({key:state.secret,data:stored.backupCodes})).includes(state.codes[0]),'Previously consumed code remains consumed');
  // A backup can resurrect valid sessions. Invalidate both sessions and pending
  // challenges in the isolated recovery destination before opening traffic.
  assert.equal(requireMfa(await identitySession(auth,state.oldSession)).session.mfaVerified,true);
  const recoveryConnection=await pool.connect();
  try {
    await recoveryConnection.query('BEGIN');
    await recoveryConnection.query('DELETE FROM revale_identity.session');
    await recoveryConnection.query('DELETE FROM revale_identity.verification');
    await recoveryConnection.query('COMMIT');
  } catch(e) { await recoveryConnection.query('ROLLBACK');throw e; }
  finally { recoveryConnection.release(); }
  assert.equal(await identitySession(auth,state.oldSession),null);
  assert.equal((await verifyIdentityFactor(auth,state.oldChallenge,'totp',await createOTP(state.factor).totp())).ok,false);
  const login = restoreClient(auth,'192.0.2.202');
  assert.equal((await login.request('/sign-in/email',{email:state.email,password:state.password})).data.twoFactorRedirect,true);
  assert.equal(await identitySession(auth,login.req),null);
  const factor = await verifyIdentityFactor(auth,login.req,'totp',await createOTP(state.factor).totp());
  assert.equal(factor.status,200);login.accept(factor);
  assert.equal(requireMfa(await identitySession(auth,login.req)).session.mfaVerified,true);
  await login.request('/sign-out',{});
  await login.request('/sign-in/email',{email:state.email,password:state.password});
  assert.equal((await verifyIdentityFactor(auth,login.req,'recovery',state.codes[0])).ok,false);
  const recovery = await verifyIdentityFactor(auth,login.req,'recovery',state.codes[1]);
  assert.equal(recovery.status,200);login.accept(recovery);
  assert.equal(requireMfa(await identitySession(auth,login.req)).session.mfaVerified,true);
  await login.request('/sign-out',{});
  await login.request('/sign-in/email',{email:state.email,password:state.password});
  assert.equal((await verifyIdentityFactor(auth,login.req,'recovery',state.codes[1])).ok,false);
  return {keyRequired:true,oldSessionsRevoked:true,oldChallengesRevoked:true,totpLogin:true,passwordOnlyBlocked:true,consumedCodesRejected:true,recoverySingleUse:true};
}

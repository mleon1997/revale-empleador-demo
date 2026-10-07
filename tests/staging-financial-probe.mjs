// Explicit staging-only HTTP rehearsal. Requires previously provisioned synthetic
// fixtures and a private config file outside Git. Never sends a bank transfer.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';

const c = JSON.parse(readFileSync(process.env.REVALE_STAGING_PROBE_CONFIG));
assert.equal(c.origin, 'https://revale-staging-mateo-leon-s-projects.vercel.app');
const dbUrl = new URL(c.connectionString);
assert.equal(dbUrl.username, 'revale_staging_app');
assert.match(dbUrl.hostname, /^ep-patient-art-b8g0o99p(?:-pooler)?\./);
assert.ok(c.bypass && process.env.REVALE_STAGING_PROBE_OUTPUT);
neonConfig.webSocketConstructor = globalThis.WebSocket;
const pool = new Pool({ connectionString: c.connectionString, max: 3, connectionTimeoutMillis: 10000 });
const results = [], clients = {};
function report(check, detail = {}) {
  results.push({ check, ...detail });
  console.log(JSON.stringify(results.at(-1)));
  writeFileSync(process.env.REVALE_STAGING_PROBE_OUTPUT, JSON.stringify(results, null, 2));
}
function client() {
  const jar = new Map();
  return { async request(path, body) {
    const url = new URL(c.origin + path);
    if (!jar.size) url.searchParams.set('_vercel_share', c.bypass);
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
        headers: { origin: c.origin, 'content-type': 'application/json', cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; ') },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      for (const line of r.headers.getSetCookie()) {
        const part = line.split(';')[0], j = part.indexOf('='); jar.set(part.slice(0,j), part.slice(j+1));
      }
      if (r.status >= 300 && r.status < 400) {
        const next = new URL(r.headers.get('location'), url);
        assert.equal(next.origin, c.origin, 'Protection link expired or off-site redirect'); url.href = next.href; continue;
      }
      const data = await r.json().catch(() => ({ nonJson: true }));
      return { status: r.status, data };
    }
    throw Error('Redirect limit');
  }};
}
async function ok(a, path, body, status = 200) {
  const r = await a.request(path,body);
  assert.equal(r.status,status,`${path}: ${JSON.stringify(r.data)}`); return r.data;
}
const business = '/api/revale-demo?action=', admin = '/api/admin?action=';
const balance = async () => Number((await pool.query("SELECT balance FROM revale.benefit_accounts WHERE id='flow_benefit'")).rows[0].balance);
try {
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM revale.transactions')).rows[0].n,0,'Fresh financial fixture required');
  for (const u of c.users) {
    const a = clients[u.role] = client(), route = u.portal === 'merchant' ? 'auth' : u.portal + '-auth';
    await ok(a,`/api/${route}?action=login`,{email:u.email,password:u.password});
    const gate = await a.request(u.role === 'employee' ? business+'confirm' : u.role === 'merchant' ? business+'create' : admin+'close-settlements', {amount:1,tx:'absent',token:'absent'});
    assert.equal(gate.status,403,'Password-only session must not execute business operations');
    const enrollment = await ok(a,'/api/identity?action=enable',{password:u.password,portal:u.portal});
    const png = PNG.sync.read(Buffer.from(enrollment.qr.split(',')[1],'base64'));
    const qr = jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
    assert.ok(qr,'Enrollment QR readable');
    const secret = new TextDecoder().decode(base32.decode(new URL(qr.data).searchParams.get('secret')));
    await ok(a,'/api/identity?action=totp',{code:await createOTP(secret).totp(),portal:u.portal});
    report('MFA-business-gate',{role:u.role,passwordOnlyRejected:true});
  }
  const {employee,merchant,maker,checker}=clients;
  const first = await ok(merchant,business+'create',{amount:20,reference:'SYNTHETIC-REVERSAL'});
  await ok(employee,business+'confirm',{tx:first.tx,token:first.token});
  assert.equal(await balance(),80);
  await Promise.all(Array.from({length:3},()=>ok(merchant,business+'reverse',{tx:first.tx,reason:'other',note:'Synthetic rehearsal'})));
  assert.equal(await balance(),100);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM revale.ledger_entries WHERE transaction_id=$1 AND entry_type='reversal'",[first.tx])).rows[0].n,1);
  report('reversal-retries',{requests:3,balance:100,credits:1});
  const second = await ok(merchant,business+'create',{amount:100,reference:'SYNTHETIC-SETTLEMENT',idempotency_key:'flow-charge-20261006'});
  const repeated = await ok(merchant,business+'create',{amount:100,reference:'SYNTHETIC-SETTLEMENT',idempotency_key:'flow-charge-20261006'});
  assert.equal(second.tx,repeated.tx);
  await Promise.all(Array.from({length:3},()=>ok(employee,business+'confirm',{tx:second.tx,token:second.token})));
  assert.equal(await balance(),0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM revale.ledger_entries WHERE transaction_id=$1 AND entry_type='consumption'",[second.tx])).rows[0].n,1);
  report('charge-confirm-retries',{requests:3,balance:0,debits:1,createIdempotent:true});
  // Only the two synthetic transactions are placed in the completed period.
  // The production close route selects the last completed weekly period.
  await pool.query("UPDATE revale.transactions SET approved_at=date_trunc('week',now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil'-interval '1 day',reversed_at=CASE WHEN status='reversed' THEN date_trunc('week',now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil'-interval '1 hour' END WHERE merchant_id='flow_merchant'");
  await ok(maker,admin+'accounting-reconcile',{});
  const closed=await ok(maker,admin+'close-settlements',{});
  const s=closed.results.find(r=>r.merchant_id==='flow_merchant');
  assert.equal(s.code,'ok');
  const id=s.settlement.id;
  assert.equal(s.settlement.net_amount,97.12);
  await ok(maker,admin+'register-fee-invoice',{settlement_id:id,invoice_number:'TEST-NOT-FISCAL-20261006'});
  const request=await ok(maker,admin+'schedule-payout',{id,note:'Synthetic approval; no real funds'});
  const approvalId=request.result.request.id;
  const self=await ok(maker,admin+'financial-approval-decision',{id:approvalId,decision:'approve'},409);
  assert.equal(self.detail.code,'self_approval_forbidden');
  const approved=await ok(checker,admin+'financial-approval-decision',{id:approvalId,decision:'approve'});
  assert.equal(approved.execution.code,'ok');
  await ok(maker,admin+'mark-payout-paid',{id,payout_reference:'TEST-NO-BANK-TRANSFER-20261006'});
  await ok(maker,admin+'mark-payout-paid',{id,payout_reference:'TEST-NO-BANK-TRANSFER-20261006'});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM revale.settlement_payouts WHERE settlement_id=$1',[id])).rows[0].n,1);
  const wrong=await ok(maker,admin+'reconcile-settlement',{id,bank_reference:'TEST-NO-BANK-TRANSFER-20261006',bank_posted_on:'2026-10-06',bank_amount:97.11});
  assert.equal(wrong.reconciliation.status,'mismatch');
  const alert=await ok(maker,admin+'operational-health');
  assert.equal(alert.ok,false);assert.equal(alert.checks.reconciliation_mismatches,1);
  const reconciled=await ok(maker,admin+'reconcile-settlement',{id,bank_reference:'TEST-NO-BANK-TRANSFER-20261006',bank_posted_on:'2026-10-06',bank_amount:97.12});
  assert.equal(reconciled.reconciliation.status,'matched');
  const health=await ok(maker,admin+'operational-health');assert.equal(health.ok,true);
  const payable=Number((await pool.query("SELECT sum(credit-debit) AS n FROM revale.gl_journal_lines WHERE account_id='gl_merchant_payable' AND merchant_id='flow_merchant'")).rows[0].n);
  assert.equal(payable,0);
  report('settlement-MFA',{gross:100,fee:2.50,tax:0.38,net:97.12,separateApproval:true,selfApprovalRejected:true,payouts:1,oneCentAlert:true,reconciled:true,merchantPayable:0,health:health.checks,realBankTransfer:false});
} catch(e) { report('failed',{message:e.message});process.exitCode=1; }
finally {
  for(const a of Object.values(clients)) await a.request('/api/identity?action=logout',{}).catch(()=>{});
  await pool.end();
}

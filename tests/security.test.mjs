import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedemptionHandler} from '../api/revale-demo.js';
import {getEmployeePrincipal} from '../lib/revale-auth.js';
import admin from '../api/admin.js';
import merchantAuth from '../api/auth.js';
import employeeAuth from '../api/employee-auth.js';
import employerAuth from '../api/employer-auth.js';
import adminAuth from '../api/admin-auth.js';
import employer from '../api/employer.js';
import {assertSameOrigin,databaseUrl,authUrl,identityAllowed,canBindLegacyIdentity} from '../lib/revale-security.js';

const headers={host:'comercios.revale.app',origin:'https://comercios.revale.app'};
async function request(handler,action,method='GET',extra={}) {
  let result;
  const res={status(code){this.code=code;return this;},setHeader(){return this;},json(body){result={status:this.code,body};}};
  await handler({method,headers,query:{action,tx:'foreign',token:'secret'},body:{tx:'foreign'},...extra},res);
  return result;
}
test('retired personal-data endpoints never open a database connection',async()=>{
  const handler=createRedemptionHandler({database:()=>{throw new Error('Database must not be reached');}});
  for(const action of ['persons','balance']) assert.equal((await request(handler,action)).status,410);
});
test('transaction routes require the appropriate session',async()=>{
  const handler=createRedemptionHandler({database:async()=>({}),merchantSession:async()=>null,employeeSession:async()=>null});
  for(const [action,method] of [['transactions','GET'],['status','GET'],['create','POST'],['reverse','POST'],['invoice-match','POST'],['resolve-reversal','POST'],['get','GET'],['confirm','POST']]){
    assert.equal((await request(handler,action,method)).status,401,action);
  }
});
test('foreign transaction status and invoice matching cannot reveal or mutate data',async()=>{
  let reads=0;
  const sql={query:async(text,args)=>{reads++;assert.match(text,/merchant_id=\$2/);assert.match(text,/location_id=\$3/);assert.deepEqual(args,['foreign','m1','l1']);return [];}};
  const handler=createRedemptionHandler({database:async()=>sql,merchantSession:async()=>({merchantId:'m1',locationId:'l1',role:'supervisor'})});
  assert.equal((await request(handler,'status')).status,404);
  assert.equal((await request(handler,'invoice-match','POST')).status,404);
  assert.equal(reads,2);
});
test('cross-origin and origin-less mutations fail before accessing the database',async()=>{
  const handler=createRedemptionHandler({database:()=>{throw new Error('Database must not be reached');}});
  for(const origin of ['https://evil.example','https://mi.revale.app','']){
    assert.equal((await request(handler,'create','POST',{headers:{host:headers.host,origin}})).status,403);
  }
  assert.doesNotThrow(()=>assertSameOrigin({method:'POST',headers}));
  assert.throws(()=>assertSameOrigin({method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'}}),e=>e.status===403);
});
test('unverified real email cannot claim an unbound employee identity',async()=>{
  let reads=0;
  const sql={query:async text=>{reads++;assert.match(text,/SELECT id, auth_user_id/);return [{id:'person',auth_user_id:null}];}};
  const auth=async()=>({user:{id:'auth-user',email:'user@example.com',emailVerified:false}});
  assert.equal(await getEmployeePrincipal(sql,{},auth),null);assert.equal(reads,1);
  assert.equal(canBindLegacyIdentity({email:'user@example.com',emailVerified:false}),false);
});
test('all browser authentication and administration routes reject missing or foreign origins',async()=>{
  for(const handler of [admin,merchantAuth,employeeAuth,employerAuth,adminAuth,employer]) {
    for(const origin of ['', 'https://foreign.example']) {
      assert.equal((await request(handler,'login','POST',{headers:{host:headers.host,origin}})).status,403);
    }
  }
});
test('live and preview cannot reuse the demo database or demo credentials',()=>{
  const demo={REVALE_MODE:'demo',REVALE_DB_DATABASE_URL:'postgres://user:secret@demo-pooler.example/db',NEON_AUTH_URL:'https://demo.auth.example'};
  assert.equal(databaseUrl(demo),demo.REVALE_DB_DATABASE_URL);
  assert.throws(()=>databaseUrl({...demo,REVALE_MODE:'live'}),/ISOLATED_LIVE/);
  assert.throws(()=>databaseUrl({...demo,REVALE_MODE:'live',REVALE_LIVE_DATABASE_URL:'postgres://other:password@demo.example/db'}),/ISOLATED_LIVE/);
  assert.throws(()=>databaseUrl({...demo,VERCEL_ENV:'preview'}),/ISOLATED_PREVIEW/);
  assert.throws(()=>authUrl({...demo,VERCEL_ENV:'preview'}),/ISOLATED_PREVIEW/);
  assert.throws(()=>authUrl({...demo,REVALE_MODE:'live',REVALE_LIVE_AUTH_URL:demo.NEON_AUTH_URL}),/ISOLATED_LIVE/);
  assert.throws(()=>authUrl({...demo,REVALE_MODE:'live',REVALE_LIVE_AUTH_URL:demo.NEON_AUTH_URL+'/'}),/ISOLATED_LIVE/);
  assert.equal(databaseUrl({...demo,REVALE_MODE:'live',REVALE_LIVE_DATABASE_URL:'postgres://user:secret@live.example/db'}),'postgres://user:secret@live.example/db');
  for(const email of ['admin@demo.revale.app','supervisor@comercios.demo.revale.app','andrea.demo@revale.app']) assert.equal(identityAllowed(email,{REVALE_MODE:'live'}),false);
  assert.equal(identityAllowed('user@example.com',{REVALE_MODE:'live'}),true);
});

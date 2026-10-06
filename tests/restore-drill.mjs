import pg from 'pg';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {operationalHealth} from '../lib/revale-operational-health.js';
import {identityFixture} from './identity-fixture.mjs';
import {prepareRecoveryFixture,verifyIdentityAfterRestore} from './identity-restore-helpers.mjs';

// Rehearsal using synthetic CI data. Does NOT certify the real Neon backup,
// retention window, provider recovery, credentials or operational RTO/RPO.
const source=process.env.REVALE_TEST_DATABASE_URL;
if(!source)throw new Error('Disposable local PostgreSQL required');
const url=new URL(source),container=process.env.REVALE_TEST_POSTGRES_CONTAINER;
if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/revale_test_'))throw new Error('Unsafe restore drill source');
if(!container||!/^[a-zA-Z0-9_-]+$/.test(container))throw new Error('Explicit disposable PostgreSQL service container required');
const targetName='revale_test_restore_drill';
if(url.pathname==='/'+targetName)throw new Error('Restore source and target must differ');
const sourceDb=new pg.Client({connectionString:source});
const targetUrl=new URL(source);targetUrl.pathname='/'+targetName;
let restored,identity,restoredIdentityPool;
async function fingerprint(client){
  const {rows:tables}=await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('revale','revale_identity') ORDER BY schemaname,tablename");
  const result={};
  for(const {schemaname,tablename} of tables){
    if(!/^[a-zA-Z_]+$/.test(tablename)||!['revale','revale_identity'].includes(schemaname))throw new Error('Unexpected test table name');
    const {rows:[row]}=await client.query(`SELECT COUNT(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM "${schemaname}"."${tablename}" t`);
    result[schemaname+'.'+tablename]=row;
  }
  result.sequences=(await client.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='revale' ORDER BY sequencename")).rows;
  return result;
}
function postgresTool(command,args,input){
  const result=spawnSync('docker',['exec',...(input?['-i']:[]),container,command,'--username',decodeURIComponent(url.username),...args],{input,maxBuffer:32*1024*1024});
  if(result.error||result.status!==0)throw new Error('Synthetic restore drill command failed: '+command);
  return result.stdout;
}
try{
  await sourceDb.connect();
  identity=await identityFixture();
  // The encryption key is retained separately in process memory. It is never
  // included in the SQL archive, logs or a GitHub artifact.
  const identityState=await prepareRecoveryFixture(identity);
  const before=await fingerprint(sourceDb);
  const start=performance.now();
  const backup=postgresTool('pg_dump',['--format=custom','--no-owner','--no-acl','--schema=revale','--schema=revale_identity','--dbname',url.pathname.slice(1)]);
  // Never DROP an existing database: a repeated drill requires explicit cleanup.
  await sourceDb.query('CREATE DATABASE '+targetName);
  postgresTool('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',targetName],backup);
  restored=new pg.Client({connectionString:targetUrl.href});await restored.connect();
  assert.deepEqual(await fingerprint(restored),before,'Restored rows and sequence state must be identical');
  const result=await operationalHealth({query:async(text,args)=>(await restored.query(text,args)).rows});
  assert.equal(result.ok,true,'Synthetic recovery must preserve financial invariants');
  restoredIdentityPool=new pg.Pool({connectionString:targetUrl.href,max:3});
  const mfa=await verifyIdentityAfterRestore({pool:restoredIdentityPool,query:(text,args)=>restored.query(text,args)},identityState);
  assert.equal(await identity.auth.api.getSession({headers:identityState.oldSession.headers}).then(s=>s?.session?.mfaVerified),true,'Recovery destination revocation must not affect source sessions');
  console.log(JSON.stringify({drill:'synthetic_postgresql_restore',tables:Object.keys(before).length-1,identityTables:Object.keys(before).filter(k=>k.startsWith('revale_identity.')).length,backupBytes:backup.length,elapsedSeconds:Math.round((performance.now()-start)/10)/100,rowsAndSequencesIdentical:true,financialInvariants:true,mfa,realBackupVerified:false}));
}finally{await restoredIdentityPool?.end();await identity?.close();await restored?.end();await sourceDb.end();}

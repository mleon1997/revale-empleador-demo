import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { reconcileSettlementPayout } from '../lib/revale-settlement-tax.js';

const base = new URL('../db/baseline/', import.meta.url);
const baseline = await readFile(new URL('20261006_revale.sql', base), 'utf8');
const queryBaseline = await readFile(new URL('20261006_revale-query.sql', base), 'utf8');
const catalogQuery = await readFile(new URL('catalog-query.sql', base), 'utf8');
const expected = JSON.parse(await readFile(new URL('catalog-20261006.json', base), 'utf8'));

test('exact reconciliation works against the full observed schema after its status migration',async()=>{
  const db=new PGlite();
  const priorMode=process.env.REVALE_MODE;
  process.env.REVALE_MODE='live';
  try {
    await db.exec(baseline);
    await db.exec(`
      INSERT INTO revale.merchants(id,name) VALUES ('test','Synthetic merchant');
      INSERT INTO revale.merchant_bank_accounts(id,merchant_id,bank_name,account_type,account_number,holder_name,holder_identification,status)
        VALUES (1,'test','Synthetic','checking','NOT-REAL','Synthetic','NOT-REAL','verified');
      INSERT INTO revale.settlements(id,merchant_id,period_start,period_end,status,net_amount)
        VALUES ('test','test','2026-09-28','2026-10-05','paid',97.12);
      INSERT INTO revale.settlement_payouts(settlement_id,attempt_no,bank_account_id,amount,status,payout_reference)
        VALUES ('test',1,1,97.12,'paid','SYNTHETIC');
    `);
    const reconcile=amount=>db.transaction(async tx=>reconcileSettlementPayout({query:async(text,args)=>(await tx.query(text,args)).rows},
      {settlementId:'test',bankReference:'SYNTHETIC',bankPostedOn:'2026-10-06',bankAmount:amount}));
    assert.equal((await reconcile(97.11)).reconciliation.status,'mismatch');
    await assert.rejects(reconcile(97.12),e=>e.code==='23514'&&e.message.includes('settlements_status_check'));
    assert.equal((await db.query("SELECT status FROM revale.settlement_reconciliations")).rows[0].status,'mismatch','Constraint failure rolls back reconciliation');
    const migration=await readFile(new URL('../db/migrations/20261006_settlement_reconciled_status.sql',import.meta.url),'utf8');
    await db.exec(migration);
    assert.equal((await reconcile(97.12)).reconciliation.status,'matched');
    assert.equal((await db.query('SELECT status FROM revale.settlements')).rows[0].status,'reconciled');
    assert.equal((await reconcile(97.12)).idempotent,true);
    assert.equal((await reconcile(97.13)).code,'reconciliation_locked');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM revale.settlement_events WHERE event_type='reconciled'")).rows[0].n,1);
    await assert.rejects(db.query("UPDATE revale.settlements SET status='unknown'"),e=>e.code==='23514');
    await db.exec(migration); // A repeat is safe and retains the reconciled row.
  } finally {
    if(priorMode===undefined)delete process.env.REVALE_MODE;else process.env.REVALE_MODE=priorMode;
    await db.close();
  }
});

for (const mode of ['script', 'prepared query']) {
test(`${mode}: fresh isolated database reproduces the observed schema without data or identities`, async () => {
  const db = new PGlite();
  try {
    const run = () => mode === 'script' ? db.exec(baseline) : db.query(queryBaseline);
    await run();
    const result = await db.query(catalogQuery);
    const actual = JSON.parse(result.rows[0].schema_catalog);
    for (const key of ['tables','constraints','indexes','sequences','functions','triggers','policies','enums','other_types']) {
      assert.deepEqual(actual[key], expected[key], `Source schema mismatch in ${key}`);
    }
    for (const { name } of expected.tables) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      const result = await db.query(`SELECT count(*)::integer AS n FROM revale.${quoted}`);
      assert.equal(result.rows[0].n, 0, `${name} must start empty`);
    }
    const auth = await db.query("SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname = 'neon_auth'");
    assert.equal(auth.rows[0].n, 0, 'Baseline must not install/copy provider identity data');
    await assert.rejects(run(), /already exists/);
    await db.exec('ROLLBACK');
    const intact = await db.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='revale'");
    assert.equal(intact.rows[0].n, expected.tables.length, 'Rejected rerun must preserve schema');
  } finally {
    await db.close();
  }
});
}

test('single-statement wrapper contains exactly the approved baseline DDL', () => {
  const body = baseline.replace('\nBEGIN;\n', '\n').replace('\nCOMMIT;', '\n').trim();
  assert.equal(queryBaseline.split('$revale_ddl$')[1].trim(), body);
});

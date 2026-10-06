import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const base = new URL('../db/baseline/', import.meta.url);
const baseline = await readFile(new URL('20261006_revale.sql', base), 'utf8');
const queryBaseline = await readFile(new URL('20261006_revale-query.sql', base), 'utf8');
const catalogQuery = await readFile(new URL('catalog-query.sql', base), 'utf8');
const expected = JSON.parse(await readFile(new URL('catalog-20261006.json', base), 'utf8'));

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

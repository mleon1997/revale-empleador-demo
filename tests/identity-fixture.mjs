import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { randomBytes } from 'node:crypto';
import { createIdentity, identityOptions, identityRequest, mergedCookie } from '../lib/revale-identity.js';

export async function identityFixture() {
  const connectionString = process.env.REVALE_TEST_DATABASE_URL;
  let pool, db;
  if (connectionString) {
    const url = new URL(connectionString);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/revale_test_')) {
      throw new Error('Disposable local test database required');
    }
    pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query('DROP SCHEMA IF EXISTS revale_identity CASCADE');
  } else {
    db = new PGlite();
    let tail = Promise.resolve();
    pool = { async connect() {
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      return { query: async (text, args) => {
        const result = await db.query(text, args);
        return { ...result, rowCount: result.affectedRows ?? result.rows.length };
      }, release };
    }, async end() { await db.close(); } };
  }
  const config = { pool, origin: 'https://staging.example', secret: randomBytes(48).toString('base64url') };
  const migration = await getMigrations(identityOptions(config));
  const ddl = await migration.compileMigrations();
  await migration.runMigrations();
  const auth = createIdentity(config);
  let clientNumber = 0;
  function client() {
    let cookie = '';
    const ip = `192.0.2.${++clientNumber}`;
    return {
      get req() { return { headers: { cookie, 'x-vercel-forwarded-for': ip } }; },
      async request(path, body) {
        const req = { headers: { cookie, 'x-vercel-forwarded-for': ip } };
        const response = await identityRequest(auth, req, path, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) });
        cookie = mergedCookie(req, response);
        return { response, data: await response.json() };
      },
      accept(response) { cookie = mergedCookie({ headers: { cookie } }, response); }
    };
  }
  async function query(text,args=[]) { const c=await pool.connect();try{return await c.query(text,args);}finally{c.release();} }
  return { auth, pool, config, ddl, client, query, close: () => pool.end() };
}

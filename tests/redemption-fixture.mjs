import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export async function redemptionFixture() {
  const connectionString=process.env.REVALE_TEST_DATABASE_URL;
  if(connectionString) {
    const u=new URL(connectionString);
    if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.startsWith('/revale_test_')) throw new Error('Disposable local test database required');
  }
  const pool=connectionString?new pg.Pool({connectionString,max:20}):null;
  const db=pool||new PGlite();
  const query=(text,args=[])=>db.query(text,args);
  const exec=text=>pool?pool.query(text):db.exec(text);
  const sql=(strings,...args)=>sql.query(strings.reduce((s,v,i)=>s+(i?'$'+i:'')+v,''),args);
  sql.query=(text,args=[])=>({text,args,then(resolve,reject){return query(text,args).then(r=>r.rows).then(resolve,reject);}});
  sql.transaction=async (queries,options)=>{
    if(options?.isolationLevel!=='Serializable')throw new Error('Serializable isolation required');
    if(pool){const client=await pool.connect();try{
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');const results=[];
      for(const q of queries)results.push((await client.query(q.text,q.args)).rows);
      await client.query('COMMIT');return results;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
    return db.transaction(async client=>{const results=[];for(const q of queries)results.push((await client.query(q.text,q.args)).rows);return results;});
  };
  await exec(`DROP SCHEMA IF EXISTS revale CASCADE; CREATE SCHEMA revale;
    CREATE TABLE revale.persons(id text PRIMARY KEY,first_name text,last_name text,person_identification text,email text,active boolean DEFAULT true);
    CREATE TABLE revale.cards(card_number text PRIMARY KEY,person_id text REFERENCES revale.persons(id),active boolean DEFAULT true);
    CREATE TABLE revale.benefit_accounts(id text PRIMARY KEY,card_number text REFERENCES revale.cards(card_number),balance numeric(14,2),updated_at timestamptz DEFAULT now());
    CREATE TABLE revale.employers(id text PRIMARY KEY,active boolean DEFAULT true);
    CREATE TABLE revale.benefit_programs(id text PRIMARY KEY,employer_id text REFERENCES revale.employers(id),active boolean DEFAULT true,valid_from date,valid_until date);
    CREATE TABLE revale.employee_enrollments(id bigserial PRIMARY KEY,person_id text REFERENCES revale.persons(id),program_id text REFERENCES revale.benefit_programs(id),status text DEFAULT 'active',starts_on date DEFAULT CURRENT_DATE-1,ends_on date);
    CREATE TABLE revale.benefit_rules(id bigserial PRIMARY KEY,program_id text,rule_type text,rule_value jsonb,priority int DEFAULT 100,active boolean DEFAULT true);
    CREATE TABLE revale.merchants(id text PRIMARY KEY,name text,active boolean DEFAULT true,logo_url text,brand_primary text);
    CREATE TABLE revale.merchant_locations(id text PRIMARY KEY,merchant_id text REFERENCES revale.merchants(id),name text,active boolean DEFAULT true);
    CREATE TABLE revale.transactions(id text PRIMARY KEY,external_transaction_id text,transaction_type text,merchant_id text REFERENCES revale.merchants(id),location_id text REFERENCES revale.merchant_locations(id),person_id text REFERENCES revale.persons(id),account_id text REFERENCES revale.benefit_accounts(id),program_id text,card_number text,amount numeric(14,2),reference text,observation text,public_token text,expires_at timestamptz DEFAULT now()+interval '5 minutes',created_at timestamptz DEFAULT now(),approved_at timestamptz,reversed_at timestamptz,status text DEFAULT 'pending',balance_before numeric(14,2),balance_after numeric(14,2));
    CREATE TABLE revale.ledger_entries(id bigserial PRIMARY KEY,account_id text,transaction_id text,entry_type text,amount numeric(14,2),balance_after numeric(14,2),description text,UNIQUE(account_id,transaction_id,entry_type));
    CREATE TABLE revale.transaction_events(id bigserial PRIMARY KEY,transaction_id text,event_type text,payload jsonb);
    CREATE TABLE revale.accounting_events(id bigserial PRIMARY KEY,event_type text,source_type text,source_id text,event_key text,amount numeric(14,2),currency text,merchant_id text,employer_id text,person_id text,benefit_account_id text,transaction_id text,payload jsonb,status text DEFAULT 'pending',UNIQUE(source_type,source_id,event_key));
    CREATE TABLE revale.settlements(id text PRIMARY KEY,merchant_id text,status text,period_end date);
    CREATE TABLE revale.settlement_items(id bigserial PRIMARY KEY,settlement_id text REFERENCES revale.settlements(id),transaction_id text,item_type text);
    CREATE TABLE revale.invoices(id bigserial PRIMARY KEY,transaction_id text,status text,email_alias text,received_at timestamptz,matched_at timestamptz);
    CREATE TABLE revale.reversal_requests(id bigserial PRIMARY KEY,transaction_id text,merchant_id text,location_id text,status text DEFAULT 'pending',requested_by text,reason text,note text,reviewed_by text,reviewed_at timestamptz);
    INSERT INTO revale.persons(id,first_name) VALUES ('p1','Test'),('p2','Other');
    INSERT INTO revale.cards VALUES ('c1','p1',true),('c2','p2',true);
    INSERT INTO revale.benefit_accounts(id,card_number,balance) VALUES ('a1','c1',100),('a2','c2',100);
    INSERT INTO revale.employers(id) VALUES ('e1');
    INSERT INTO revale.benefit_programs(id,employer_id) VALUES ('b1','e1');
    INSERT INTO revale.employee_enrollments(person_id,program_id) VALUES ('p1','b1'),('p2','b1');
    INSERT INTO revale.merchants(id,name) VALUES ('m1','Test merchant'),('m2','Other merchant');
    INSERT INTO revale.merchant_locations(id,merchant_id,name) VALUES ('l1','m1','Branch 1'),('l2','m1','Branch 2'),('l3','m2','Other branch');
  `);
  const principal={personId:'p1',benefit:{account_id:'a1',card_number:'c1',program_id:'b1',employer_id:'e1',balance:100}};
  const merchant={merchantId:'m1',locationId:'l1',role:'supervisor',displayName:'Test supervisor'};
  async function reset(){await exec(`TRUNCATE revale.transactions,revale.ledger_entries,revale.transaction_events,revale.accounting_events,revale.benefit_rules,revale.settlement_items,revale.settlements,revale.invoices,revale.reversal_requests;
    UPDATE revale.benefit_accounts SET balance=100; UPDATE revale.employee_enrollments SET status='active';
    UPDATE revale.persons SET active=true; UPDATE revale.merchants SET active=true;
    UPDATE revale.merchant_locations SET active=true; UPDATE revale.benefit_programs SET active=true;
    UPDATE revale.employers SET active=true;`);}
  async function charge(id='T1',amount=10,location='l1'){
    await sql.query(`INSERT INTO revale.transactions(id,merchant_id,location_id,amount,public_token) SELECT $1,merchant_id,id,$2,'token-'||$1 FROM revale.merchant_locations WHERE id=$3`,[id,amount,location]);
    return {id,token:'token-'+id};
  }
  return {sql,db,pool,exec,reset,charge,principal,merchant,native:!!pool,close:()=>pool?pool.end():db.close()};
}

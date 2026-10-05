import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

export async function employerFixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA revale;
    CREATE TABLE revale.persons (id text PRIMARY KEY,first_name text,last_name text,email text,person_identification text,active boolean DEFAULT true);
    CREATE TABLE revale.cards (card_number text PRIMARY KEY,person_id text REFERENCES revale.persons(id),active boolean DEFAULT true);
    CREATE TABLE revale.benefit_accounts (id text PRIMARY KEY,card_number text REFERENCES revale.cards(card_number),balance numeric(14,2),updated_at timestamptz DEFAULT now());
    CREATE TABLE revale.merchants (id text PRIMARY KEY,name text,slug text,active boolean DEFAULT true);
    CREATE TABLE revale.merchant_locations (id text PRIMARY KEY,merchant_id text REFERENCES revale.merchants(id),name text,active boolean DEFAULT true);
    CREATE TABLE revale.merchant_bank_accounts (id bigserial PRIMARY KEY);
    CREATE TABLE revale.transactions (id text PRIMARY KEY,program_id text,person_id text REFERENCES revale.persons(id),merchant_id text REFERENCES revale.merchants(id),location_id text REFERENCES revale.merchant_locations(id),amount numeric(14,2),status text,approved_at timestamptz,reversed_at timestamptz);
    CREATE TABLE revale.invoices (id bigserial PRIMARY KEY,transaction_id text,status text,matched_at timestamptz);
    CREATE TABLE revale.ledger_entries (id bigserial PRIMARY KEY,account_id text,amount numeric(14,2));
    CREATE TABLE revale.gl_accounts (id text PRIMARY KEY,internal_code text,local_account_code text,name text,account_type text,normal_balance text,ifrs_category text,ecuador_reporting_line text,active boolean);
  `);
  await db.exec(await readFile(new URL('../db/migrations/20261003_platform_foundation.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../db/migrations/20261004_employer_funding_treasury.sql',import.meta.url),'utf8'));
  await db.exec(`CREATE TABLE revale.funding_batch_items (id bigserial PRIMARY KEY,funding_batch_id text REFERENCES revale.funding_batches(id),enrollment_id bigint REFERENCES revale.employee_enrollments(id),account_id text REFERENCES revale.benefit_accounts(id),amount numeric(14,2),status text DEFAULT 'pending',allocated_at timestamptz,UNIQUE(funding_batch_id,enrollment_id));
    INSERT INTO revale.employers(id,name,tax_id,slug) VALUES ('employer_demo_revale','Empresa Demo ReVale','1799999999001','empresa-demo-revale'),('other','Otra Empresa','000','other');
    INSERT INTO revale.benefit_programs(id,employer_id,name,allocation_amount) VALUES ('program_demo_food','employer_demo_revale','Alimentación',120),('other-program','other','Privado',500);
    INSERT INTO revale.persons(id,first_name,last_name,email,person_identification) VALUES
      ('person_demo_andrea','Andrea','Martínez','andrea.demo@revale.app','1712345623'),('luis','Luis','Vega','luis@example.test','TEST002'),('foreign','Privado','Otro','private@example.test','TEST003'),('shared','Compartido','Prueba','shared@example.test','TEST004');
    INSERT INTO revale.cards(card_number,person_id) VALUES ('RV-DEMO-0001','person_demo_andrea'),('C2','luis'),('C3','foreign'),('C4','shared');
    INSERT INTO revale.benefit_accounts(id,card_number,balance) VALUES ('acct_demo_andrea','RV-DEMO-0001',99.05),('a2','C2',99.05),('a3','C3',500),('a4','C4',30);
    INSERT INTO revale.employee_enrollments(id,program_id,person_id) VALUES (1,'program_demo_food','person_demo_andrea'),(2,'program_demo_food','luis'),(3,'other-program','foreign'),(4,'program_demo_food','shared'),(5,'other-program','shared');
    INSERT INTO revale.merchants(id,name,slug) VALUES ('merchant_el_hornero','El Hornero','el-hornero'),('merchant_cebiches_ruminahui','Los Cebiches de la Rumiñahui','cebiches-ruminahui');
    INSERT INTO revale.merchant_locations(id,merchant_id,name) VALUES ('l1','merchant_el_hornero','Isla Floreana'),('l2','merchant_cebiches_ruminahui','Sucursal Demo');
    INSERT INTO revale.transactions(id,program_id,person_id,merchant_id,location_id,amount,status,approved_at) VALUES
      ('T1','program_demo_food','person_demo_andrea','merchant_el_hornero','l1',10,'approved',now()),
      ('T2','program_demo_food','luis','merchant_cebiches_ruminahui','l2',20.95,'approved',now()),
      ('T3','program_demo_food','person_demo_andrea','merchant_el_hornero','l1',5,'reversed',now()),
      ('PRIVATE','other-program','foreign','merchant_el_hornero','l1',999,'approved',now());
    INSERT INTO revale.invoices(transaction_id,status,matched_at) VALUES ('T1','matched',now());
    INSERT INTO revale.benefit_rules(program_id,rule_type,rule_value) VALUES ('program_demo_food','max_transaction_amount','{"amount":50}'),('program_demo_food','location_allowlist','{"location_ids":[]}');
  `);
  const sql={
    query(text,args=[]){return {text,args,then(resolve,reject){return db.query(text,args).then(r=>r.rows).then(resolve,reject);}};},
    async transaction(queries,options){if(options.isolationLevel!=='Serializable')throw new Error('Expected serializable rules transaction');return db.transaction(async tx=>{const rows=[];for(const q of queries)rows.push((await tx.query(q.text,q.args)).rows);return rows;});}
  };
  const principal={employerId:'employer_demo_revale',employerUserId:'employer_demo_admin',email:'beneficios@demo.revale.app',displayName:'Administrador de Beneficios',employerName:'Empresa Demo ReVale',role:'admin'};
  return {db,sql,principal};
}

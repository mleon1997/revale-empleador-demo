import {readFile} from 'node:fs/promises';
import {redemptionFixture} from './redemption-fixture.mjs';
import {ensureSettlementTaxSchema} from '../lib/revale-settlement-tax.js';
import {ensureSafeguardingSchema} from '../lib/revale-safeguarding.js';
import {ensureFinancialApprovalSchema} from '../lib/revale-financial-approvals.js';
import {financialTransaction} from '../lib/revale-financial-transaction.js';
import {emitAndPostAccountingEvent} from '../lib/revale-accounting.js';

// Disposable databases only; redemptionFixture validates the native connection.
export async function settlementFixture(){
  const f=await redemptionFixture();
  await f.exec(`
    DROP TABLE revale.settlement_items; DROP TABLE revale.settlements;
    ALTER TABLE revale.employers ADD COLUMN slug text;
    CREATE TABLE revale.merchant_bank_accounts(id bigserial PRIMARY KEY,merchant_id text REFERENCES revale.merchants(id),status text,verified_at timestamptz);
    CREATE TABLE revale.admin_users(id text PRIMARY KEY,role text,active boolean DEFAULT true,display_name text,email text);
    CREATE TABLE revale.gl_accounts(id text PRIMARY KEY,internal_code text,local_account_code text,name text,account_type text,normal_balance text,ifrs_category text,ecuador_reporting_line text,active boolean DEFAULT true);
    CREATE TABLE revale.gl_journals(id text PRIMARY KEY,source_type text,source_id text,event_key text,journal_date date,currency text,description text,status text,merchant_id text,employer_id text,person_id text,settlement_id text,transaction_id text,metadata jsonb,posted_at timestamptz,UNIQUE(source_type,source_id,event_key));
    CREATE TABLE revale.gl_journal_lines(id bigserial PRIMARY KEY,journal_id text REFERENCES revale.gl_journals(id),line_no int,account_id text REFERENCES revale.gl_accounts(id),debit numeric(16,2) DEFAULT 0 CHECK(debit>=0),credit numeric(16,2) DEFAULT 0 CHECK(credit>=0),merchant_id text,employer_id text,person_id text,benefit_account_id text,settlement_id text,transaction_id text,description text,metadata jsonb,UNIQUE(journal_id,line_no));
    ALTER TABLE revale.accounting_events ADD COLUMN settlement_id text,ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN posted_at timestamptz,ADD COLUMN error_message text;
    INSERT INTO revale.admin_users(id,role,display_name) VALUES ('maker','finance','Maker'),('checker','finance','Checker'),('checker2','finance','Checker Two');
    INSERT INTO revale.gl_accounts(id) VALUES ('gl_cash_client_funds'),('gl_employee_benefit_liability'),('gl_merchant_payable'),('gl_fee_revenue'),('gl_vat_payable');
  `);
  await f.exec(await readFile(new URL('../db/migrations/20261003_platform_foundation.sql',import.meta.url),'utf8'));
  await f.exec(`
    CREATE UNIQUE INDEX settlement_items_transaction_type_unique ON revale.settlement_items(transaction_id,item_type) WHERE transaction_id IS NOT NULL;
    CREATE TABLE revale.settlement_events(id bigserial PRIMARY KEY,settlement_id text REFERENCES revale.settlements(id),event_type text,actor_id text,payload jsonb,created_at timestamptz DEFAULT now());
    CREATE TABLE revale.settlement_payouts(id text PRIMARY KEY DEFAULT gen_random_uuid()::text,settlement_id text REFERENCES revale.settlements(id),attempt_no int,status text,amount numeric(14,2),currency text,bank_account_id bigint,scheduled_at timestamptz,completed_at timestamptz,payout_reference text,failure_reason text,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(settlement_id,attempt_no));
  `);
  await f.exec(await readFile(new URL('../db/migrations/20261004_employer_funding_treasury.sql',import.meta.url),'utf8'));
  await ensureSettlementTaxSchema(f.sql);
  await ensureSafeguardingSchema(f.sql);
  await ensureFinancialApprovalSchema(f.sql);
  await f.exec(`
    INSERT INTO revale.merchant_terms(merchant_id,effective_from,discount_rate,tax_rate) VALUES('m1','2020-01-01',0.025,0.15),('m2','2020-01-01',0.025,0.15);
    INSERT INTO revale.treasury_bank_accounts(id,bank_name,account_name,purpose,is_primary) VALUES ('cash','Test bank','Segregated test','client_funds',true);
  `);
  f.run=work=>financialTransaction(f.sql,work);
  f.reset=async()=>{
    await f.exec(`TRUNCATE revale.transactions,revale.settlements,revale.accounting_events,revale.gl_journals,revale.financial_approval_requests,revale.treasury_bank_balance_snapshots,revale.audit_events CASCADE;
      TRUNCATE revale.ledger_entries,revale.transaction_events,revale.merchant_bank_accounts RESTART IDENTITY CASCADE;
      UPDATE revale.benefit_accounts SET balance=100;
      UPDATE revale.financial_user_permissions SET active=true,can_make=true,can_approve=true,approval_limit=NULL;
      UPDATE revale.admin_users SET active=true,role='finance';
      UPDATE revale.safeguarding_settings SET enforcement_enabled=false;
      INSERT INTO revale.merchant_bank_accounts(id,merchant_id,status,verified_at) VALUES (1,'m1','verified',now()),(2,'m2','verified',now());
      INSERT INTO revale.treasury_bank_balance_snapshots(id,bank_account_id,balance,available_balance,as_of) VALUES ('balance','cash',1000,1000,now()-interval '1 minute');
    `);
  };
  f.settlement=async(id='S1',amount=100,merchant='m1')=>{
    await f.sql.query(`INSERT INTO revale.settlements(id,merchant_id,period_start,period_end,gross_amount,net_amount,status,bank_account_id)
      VALUES($1,$2,'2026-01-01'::timestamptz+make_interval(days=>(SELECT COUNT(*)::int FROM revale.settlements)), '2026-01-02'::timestamptz+make_interval(days=>(SELECT COUNT(*)::int FROM revale.settlements)),$3,$3,'closed',$4)`,[id,merchant,amount,merchant==='m1'?1:2]);
  };
  f.payable=async(amount=100,merchant='m1')=>f.run(tx=>emitAndPostAccountingEvent(tx,{eventType:'redemption_approved',sourceType:'test',sourceId:'payable-'+merchant,amount,merchantId:merchant}));
  return f;
}

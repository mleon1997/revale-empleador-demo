-- ReVale safeguarding and treasury bank accounts
-- 2026-10-04

CREATE TABLE IF NOT EXISTS revale.treasury_bank_accounts (
  id text PRIMARY KEY,
  bank_name text NOT NULL,
  account_name text NOT NULL,
  account_number_last4 text,
  purpose text NOT NULL
    CHECK (purpose IN ('client_funds','operating','tax')),
  currency char(3) NOT NULL DEFAULT 'USD',
  is_primary boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  external_account_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS treasury_bank_accounts_primary_unique
  ON revale.treasury_bank_accounts(purpose,currency)
  WHERE active=true AND is_primary=true;

CREATE TABLE IF NOT EXISTS revale.treasury_bank_balance_snapshots (
  id text PRIMARY KEY,
  bank_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
  balance numeric(16,2) NOT NULL,
  available_balance numeric(16,2),
  currency char(3) NOT NULL DEFAULT 'USD',
  as_of timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','bank_import','api')),
  statement_reference text,
  recorded_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS treasury_bank_balance_snapshots_latest_idx
  ON revale.treasury_bank_balance_snapshots(bank_account_id,as_of DESC);

CREATE TABLE IF NOT EXISTS revale.treasury_internal_transfers (
  id text PRIMARY KEY,
  from_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
  to_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
  transfer_type text NOT NULL CHECK (transfer_type IN ('safeguarding_topup','excess_sweep')),
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  bank_reference text NOT NULL,
  bank_posted_on date NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','voided')),
  confirmed_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS treasury_internal_transfers_ref_unique
  ON revale.treasury_internal_transfers(bank_reference,bank_posted_on)
  WHERE status='confirmed';

CREATE TABLE IF NOT EXISTS revale.safeguarding_settings (
  id text PRIMARY KEY DEFAULT 'default',
  required_coverage_ratio numeric(8,5) NOT NULL DEFAULT 1.00000
    CHECK (required_coverage_ratio >= 1),
  minimum_buffer numeric(16,2) NOT NULL DEFAULT 0 CHECK (minimum_buffer >= 0),
  stale_after_hours integer NOT NULL DEFAULT 24 CHECK (stale_after_hours BETWEEN 1 AND 168),
  enforcement_enabled boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO revale.safeguarding_settings (
  id,required_coverage_ratio,minimum_buffer,stale_after_hours,enforcement_enabled
) VALUES ('default',1.00000,0,24,false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE revale.employer_funding_receipts
  ADD COLUMN IF NOT EXISTS treasury_account_id text REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale.employer_funding_refunds
  ADD COLUMN IF NOT EXISTS treasury_account_id text REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale.settlement_payouts
  ADD COLUMN IF NOT EXISTS source_treasury_account_id text REFERENCES revale.treasury_bank_accounts(id);

INSERT INTO revale.gl_accounts (
  id,internal_code,local_account_code,name,account_type,normal_balance,
  ifrs_category,ecuador_reporting_line,active
) VALUES (
  'gl_cash_operating','1.1.01.02','1.1.01.02',
  'Caja y bancos propios ReVale','asset','debit',
  'cash_and_cash_equivalents','Efectivo propio',true
)
ON CONFLICT (id) DO NOTHING;

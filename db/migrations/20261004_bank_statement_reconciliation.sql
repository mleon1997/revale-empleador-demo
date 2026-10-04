-- ReVale bank statement imports and reconciliation
-- 2026-10-04

CREATE TABLE IF NOT EXISTS revale.bank_statement_imports (
  id text PRIMARY KEY,
  treasury_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
  filename text NOT NULL,
  file_format text NOT NULL CHECK (file_format IN ('csv','xlsx')),
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'imported'
    CHECK (status IN ('imported','reviewed','completed','failed')),
  row_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  unmatched_count integer NOT NULL DEFAULT 0,
  imported_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(treasury_account_id,file_hash)
);

CREATE TABLE IF NOT EXISTS revale.bank_statement_entries (
  id text PRIMARY KEY,
  import_id text NOT NULL REFERENCES revale.bank_statement_imports(id),
  treasury_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
  booking_date date NOT NULL,
  value_date date,
  description text,
  bank_reference text,
  amount numeric(16,2) NOT NULL CHECK (amount <> 0),
  balance_after numeric(16,2),
  currency char(3) NOT NULL DEFAULT 'USD',
  fingerprint text NOT NULL,
  match_status text NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('unmatched','suggested','matched','ignored')),
  suggested_type text,
  suggested_id text,
  suggested_score integer,
  suggested_reason text,
  matched_type text,
  matched_id text,
  matched_by text,
  matched_at timestamptz,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(treasury_account_id,fingerprint)
);

CREATE INDEX IF NOT EXISTS bank_statement_entries_review_idx
  ON revale.bank_statement_entries(treasury_account_id,match_status,booking_date DESC);

CREATE INDEX IF NOT EXISTS bank_statement_entries_import_idx
  ON revale.bank_statement_entries(import_id,booking_date,id);

-- ReVale employer funding treasury controls
-- 2026-10-04
-- Bank receipt and employee allocation are separate control points.

CREATE TABLE IF NOT EXISTS revale.employer_funding_receipts (
  id text PRIMARY KEY,
  funding_batch_id text NOT NULL REFERENCES revale.funding_batches(id),
  employer_id text NOT NULL REFERENCES revale.employers(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
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

CREATE UNIQUE INDEX IF NOT EXISTS employer_funding_receipts_ref_unique
  ON revale.employer_funding_receipts(employer_id,bank_reference,bank_posted_on)
  WHERE status='confirmed';

CREATE INDEX IF NOT EXISTS employer_funding_receipts_batch_idx
  ON revale.employer_funding_receipts(funding_batch_id,status,created_at);

CREATE TABLE IF NOT EXISTS revale.employer_funding_refunds (
  id text PRIMARY KEY,
  funding_batch_id text NOT NULL REFERENCES revale.funding_batches(id),
  employer_id text NOT NULL REFERENCES revale.employers(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  bank_reference text NOT NULL,
  bank_posted_on date NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','voided')),
  confirmed_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employer_funding_refunds_ref_unique
  ON revale.employer_funding_refunds(employer_id,bank_reference,bank_posted_on)
  WHERE status='confirmed';

CREATE INDEX IF NOT EXISTS employer_funding_refunds_batch_idx
  ON revale.employer_funding_refunds(funding_batch_id,status,created_at);

INSERT INTO revale.gl_accounts (
  id,internal_code,local_account_code,name,account_type,normal_balance,
  ifrs_category,ecuador_reporting_line,active
) VALUES (
  'gl_employer_prefund_liability','2.1.01.01','2.1.01.01',
  'Fondos empresariales pendientes de asignar','liability','credit',
  'current_liabilities','Fondos de terceros pendientes de asignación',true
)
ON CONFLICT (id) DO NOTHING;

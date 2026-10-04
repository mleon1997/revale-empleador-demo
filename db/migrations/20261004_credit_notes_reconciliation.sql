-- ReVale fee credit notes and bank reconciliation
-- 2026-10-04
-- Fiscal corrections are linked to the original ReVale fee invoice.
-- Bank reconciliation finalizes paid settlements without creating a second cash event.

CREATE TABLE IF NOT EXISTS revale.merchant_fee_credit_notes (
  id text PRIMARY KEY,
  fee_invoice_id text NOT NULL REFERENCES revale.merchant_fee_invoices(id),
  settlement_id text NOT NULL REFERENCES revale.settlements(id),
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  transaction_id text REFERENCES revale.transactions(id),
  credit_note_number text,
  access_key text,
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  reason text,
  status text NOT NULL DEFAULT 'pending_issue'
    CHECK (status IN ('pending_issue','issued','cancelled')),
  withholding_status text NOT NULL DEFAULT 'not_required'
    CHECK (withholding_status IN ('not_required','review_required','resolved')),
  withholding_adjustment_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (withholding_adjustment_amount >= 0),
  withholding_resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  issued_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_credit_notes_tx_unique
  ON revale.merchant_fee_credit_notes(fee_invoice_id,transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_credit_notes_access_key_unique
  ON revale.merchant_fee_credit_notes(access_key)
  WHERE access_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS merchant_fee_credit_notes_status_idx
  ON revale.merchant_fee_credit_notes(merchant_id,status,withholding_status,created_at);

CREATE TABLE IF NOT EXISTS revale.settlement_reconciliations (
  id text PRIMARY KEY,
  settlement_id text NOT NULL REFERENCES revale.settlements(id),
  payout_id text NOT NULL,
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  expected_amount numeric(14,2) NOT NULL,
  bank_amount numeric(14,2) NOT NULL,
  difference_amount numeric(14,2) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  bank_reference text NOT NULL,
  bank_posted_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('matched','mismatch')),
  reconciled_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(settlement_id,payout_id)
);

CREATE INDEX IF NOT EXISTS settlement_reconciliations_status_idx
  ON revale.settlement_reconciliations(status,created_at);

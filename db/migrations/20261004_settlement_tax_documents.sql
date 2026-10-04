-- ReVale settlement tax documents and withholding controls
-- 2026-10-04
-- Closed settlements remain immutable. Verified tax withholdings become additive payout adjustments.

CREATE TABLE IF NOT EXISTS revale.merchant_fee_invoices (
  id text PRIMARY KEY,
  settlement_id text NOT NULL UNIQUE REFERENCES revale.settlements(id),
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  invoice_number text,
  access_key text,
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending_issue'
    CHECK (status IN ('pending_issue','issued','cancelled')),
  issued_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_invoices_access_key_unique
  ON revale.merchant_fee_invoices(access_key)
  WHERE access_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS revale.merchant_withholdings (
  id text PRIMARY KEY,
  settlement_id text NOT NULL REFERENCES revale.settlements(id),
  fee_invoice_id text NOT NULL REFERENCES revale.merchant_fee_invoices(id),
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  document_number text NOT NULL,
  authorization_number text,
  issued_on date NOT NULL,
  income_tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (income_tax_amount >= 0),
  vat_withheld_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_withheld_amount >= 0),
  total_amount numeric(14,2) NOT NULL CHECK (total_amount > 0),
  status text NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported','verified','rejected')),
  reported_by text,
  verified_by text,
  verified_at timestamptz,
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_withholdings_document_unique
  ON revale.merchant_withholdings(merchant_id,document_number);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_withholdings_active_invoice_unique
  ON revale.merchant_withholdings(fee_invoice_id)
  WHERE status IN ('reported','verified');

CREATE INDEX IF NOT EXISTS merchant_withholdings_status_idx
  ON revale.merchant_withholdings(status,created_at);

CREATE TABLE IF NOT EXISTS revale.settlement_adjustments (
  id text PRIMARY KEY,
  settlement_id text NOT NULL REFERENCES revale.settlements(id),
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  adjustment_type text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_adjustments_source_unique
  ON revale.settlement_adjustments(settlement_id,source_type,source_id,adjustment_type);

CREATE INDEX IF NOT EXISTS settlement_adjustments_settlement_idx
  ON revale.settlement_adjustments(settlement_id,created_at);

INSERT INTO revale.merchant_fee_invoices (
  id,settlement_id,merchant_id,subtotal,vat_amount,total_amount,currency,status,metadata
)
SELECT
  'feeinv_'||regexp_replace(s.id,'[^a-zA-Z0-9_]','','g'),
  s.id,s.merchant_id,s.fee_amount,s.tax_amount,(s.fee_amount+s.tax_amount),s.currency,'pending_issue',
  jsonb_build_object('source','settlement_backfill','period_start',s.period_start,'period_end',s.period_end)
FROM revale.settlements s
WHERE NOT EXISTS (
  SELECT 1 FROM revale.merchant_fee_invoices fi WHERE fi.settlement_id=s.id
)
ON CONFLICT (settlement_id) DO NOTHING;

INSERT INTO revale.gl_accounts (
  id,internal_code,local_account_code,name,account_type,normal_balance,
  ifrs_category,ecuador_reporting_line,active
) VALUES (
  'gl_tax_withholding_receivable','1.1.03.01','1.1.03.01',
  'Retenciones tributarias por cobrar','asset','debit',
  'current_assets','Créditos tributarios por retenciones',true
)
ON CONFLICT (id) DO NOTHING;

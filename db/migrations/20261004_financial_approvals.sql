-- ReVale financial maker-checker controls
-- 2026-10-04

CREATE TABLE IF NOT EXISTS revale.financial_user_permissions (
  admin_user_id text PRIMARY KEY,
  can_make boolean NOT NULL DEFAULT false,
  can_approve boolean NOT NULL DEFAULT false,
  approval_limit numeric(16,2),
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.financial_approval_policies (
  action_type text PRIMARY KEY,
  label text NOT NULL,
  threshold_amount numeric(16,2) NOT NULL DEFAULT 10000 CHECK (threshold_amount >= 0),
  approvals_below integer NOT NULL DEFAULT 1 CHECK (approvals_below BETWEEN 1 AND 5),
  approvals_above integer NOT NULL DEFAULT 2 CHECK (approvals_above BETWEEN 1 AND 5),
  expiry_hours integer NOT NULL DEFAULT 48 CHECK (expiry_hours BETWEEN 1 AND 720),
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.financial_approval_requests (
  id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  action_type text NOT NULL REFERENCES revale.financial_approval_policies(action_type),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  requested_by text NOT NULL,
  requested_by_name text,
  required_approvals integer NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','executing','executed','execution_failed','cancelled','expired')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_note text,
  expires_at timestamptz NOT NULL,
  execution_started_at timestamptz,
  executed_at timestamptz,
  execution_result jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financial_approval_requests_queue_idx
  ON revale.financial_approval_requests(status,created_at);

CREATE INDEX IF NOT EXISTS financial_approval_requests_entity_idx
  ON revale.financial_approval_requests(action_type,entity_type,entity_id,created_at DESC);

CREATE TABLE IF NOT EXISTS revale.financial_approval_decisions (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL REFERENCES revale.financial_approval_requests(id),
  approver_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,approver_id)
);

INSERT INTO revale.financial_approval_policies
  (action_type,label,threshold_amount,approvals_below,approvals_above,expiry_hours)
VALUES
  ('funding_allocation','Acreditación de fondeo',10000,1,2,48),
  ('merchant_payout','Programación de payout a comercio',10000,1,2,24),
  ('employer_refund','Devolución de fondos a empresa',5000,1,2,24),
  ('safeguarding_topup','Top-up a cuenta segregada',10000,1,2,24),
  ('safeguarding_sweep','Barrido de excedente',5000,1,2,24),
  ('withholding_verification','Verificación de retención',5000,1,2,24),
  ('credit_note_withholding','Ajuste de retención por nota de crédito',5000,1,2,24)
ON CONFLICT (action_type) DO NOTHING;

INSERT INTO revale.financial_user_permissions
  (admin_user_id,can_make,can_approve,approval_limit,active,metadata)
SELECT id::text,true,true,NULL,true,jsonb_build_object('bootstrap_role',role)
FROM revale.admin_users
WHERE active=true AND role IN ('superadmin','finance')
ON CONFLICT (admin_user_id) DO NOTHING;

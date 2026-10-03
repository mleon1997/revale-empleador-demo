-- ReVale platform foundation
-- 2026-10-03
-- This migration captures the production-oriented domain added after the merchant pilot.

CREATE TABLE IF NOT EXISTS revale.employers (
  id text PRIMARY KEY,
  name text NOT NULL,
  tax_id text,
  slug text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employers_slug_unique
  ON revale.employers (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS revale.benefit_programs (
  id text PRIMARY KEY,
  employer_id text NOT NULL REFERENCES revale.employers(id),
  name text NOT NULL,
  benefit_type text NOT NULL DEFAULT 'food',
  currency char(3) NOT NULL DEFAULT 'USD',
  allocation_amount numeric(14,2),
  allocation_frequency text NOT NULL DEFAULT 'monthly'
    CHECK (allocation_frequency IN ('one_time','weekly','biweekly','monthly','custom')),
  rollover_policy text NOT NULL DEFAULT 'no_rollover'
    CHECK (rollover_policy IN ('no_rollover','full_rollover','capped_rollover')),
  valid_from date,
  valid_until date,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.employee_enrollments (
  id bigserial PRIMARY KEY,
  program_id text NOT NULL REFERENCES revale.benefit_programs(id),
  person_id text NOT NULL REFERENCES revale.persons(id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','ended')),
  starts_on date NOT NULL DEFAULT CURRENT_DATE,
  ends_on date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(program_id, person_id)
);

CREATE TABLE IF NOT EXISTS revale.funding_batches (
  id text PRIMARY KEY,
  employer_id text NOT NULL REFERENCES revale.employers(id),
  program_id text REFERENCES revale.benefit_programs(id),
  external_reference text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','received','allocated','cancelled')),
  received_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.benefit_allocations (
  id bigserial PRIMARY KEY,
  program_id text NOT NULL REFERENCES revale.benefit_programs(id),
  enrollment_id bigint NOT NULL REFERENCES revale.employee_enrollments(id),
  account_id text NOT NULL REFERENCES revale.benefit_accounts(id),
  funding_batch_id text REFERENCES revale.funding_batches(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','reversed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.benefit_rules (
  id bigserial PRIMARY KEY,
  program_id text NOT NULL REFERENCES revale.benefit_programs(id),
  rule_type text NOT NULL,
  rule_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.merchant_terms (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  discount_rate numeric(7,5) NOT NULL DEFAULT 0.025,
  tax_rate numeric(7,5) NOT NULL DEFAULT 0.15,
  settlement_frequency text NOT NULL DEFAULT 'weekly',
  settlement_weekday smallint NOT NULL DEFAULT 1,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_until date,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.settlements (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES revale.merchants(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  adjustment_amount numeric(14,2) NOT NULL DEFAULT 0,
  fee_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  net_amount numeric(14,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'draft',
  bank_account_id bigint REFERENCES revale.merchant_bank_accounts(id),
  payout_reference text,
  closed_at timestamptz,
  scheduled_at timestamptz,
  paid_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS revale.settlement_items (
  id bigserial PRIMARY KEY,
  settlement_id text NOT NULL REFERENCES revale.settlements(id),
  transaction_id text REFERENCES revale.transactions(id),
  item_type text NOT NULL,
  amount numeric(14,2) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revale.idempotency_keys (
  id bigserial PRIMARY KEY,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text,
  response_code integer,
  response_body jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE(scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS revale.audit_events (
  id bigserial PRIMARY KEY,
  merchant_id text REFERENCES revale.merchants(id),
  employer_id text REFERENCES revale.employers(id),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

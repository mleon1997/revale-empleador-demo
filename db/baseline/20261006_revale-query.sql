-- Generated from 20261006_revale.sql for single-statement SQL editors.
-- The DO statement is atomic; the underlying DDL is unchanged.
DO $revale_migration$
BEGIN
  EXECUTE $revale_ddl$
-- ReVale schema-only baseline captured 2026-10-06 from the existing demo.

-- No application rows, identities, sequence states, owners or grants are copied.

-- Run only against a NEW isolated ReVale database. CREATE SCHEMA refuses an existing schema.

-- Tables: 58; sequences: 20; constraints: 270; indexes: 149.


CREATE SCHEMA revale;

CREATE SEQUENCE revale."accounting_events_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."audit_events_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."benefit_allocations_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."benefit_rules_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."employee_enrollments_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."financial_approval_decisions_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."funding_batch_items_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."gl_journal_lines_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."idempotency_keys_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."invoices_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."ledger_entries_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."merchant_bank_account_requests_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."merchant_bank_accounts_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."merchant_location_requests_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."merchant_terms_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."reversal_requests_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."settlement_events_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."settlement_items_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."settlement_payouts_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE revale."transaction_events_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE TABLE revale."accounting_events" (
  "id" bigint DEFAULT nextval('revale.accounting_events_id_seq'::regclass) NOT NULL,
  "event_type" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "event_key" text DEFAULT 'default'::text NOT NULL,
  "amount" numeric(14,2),
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "merchant_id" text,
  "employer_id" text,
  "person_id" text,
  "benefit_account_id" text,
  "settlement_id" text,
  "transaction_id" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "error_message" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "posted_at" timestamp with time zone
);

CREATE TABLE revale."admin_users" (
  "id" text NOT NULL,
  "auth_user_id" uuid,
  "display_name" text NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT 'ops'::text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."audit_events" (
  "id" bigint DEFAULT nextval('revale.audit_events_id_seq'::regclass) NOT NULL,
  "merchant_id" text,
  "employer_id" text,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."bank_statement_entries" (
  "id" text NOT NULL,
  "import_id" text NOT NULL,
  "treasury_account_id" text NOT NULL,
  "booking_date" date NOT NULL,
  "value_date" date,
  "description" text,
  "bank_reference" text,
  "amount" numeric(16,2) NOT NULL,
  "balance_after" numeric(16,2),
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "fingerprint" text NOT NULL,
  "match_status" text DEFAULT 'unmatched'::text NOT NULL,
  "suggested_type" text,
  "suggested_id" text,
  "suggested_score" integer,
  "suggested_reason" text,
  "matched_type" text,
  "matched_id" text,
  "matched_by" text,
  "matched_at" timestamp with time zone,
  "raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."bank_statement_imports" (
  "id" text NOT NULL,
  "treasury_account_id" text NOT NULL,
  "filename" text NOT NULL,
  "file_format" text NOT NULL,
  "file_hash" text NOT NULL,
  "status" text DEFAULT 'imported'::text NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "duplicate_count" integer DEFAULT 0 NOT NULL,
  "matched_count" integer DEFAULT 0 NOT NULL,
  "unmatched_count" integer DEFAULT 0 NOT NULL,
  "imported_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."benefit_accounts" (
  "id" text NOT NULL,
  "card_number" text NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "balance" numeric(14,2) DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."benefit_allocations" (
  "id" bigint DEFAULT nextval('revale.benefit_allocations_id_seq'::regclass) NOT NULL,
  "program_id" text NOT NULL,
  "enrollment_id" bigint NOT NULL,
  "account_id" text NOT NULL,
  "funding_batch_id" text,
  "amount" numeric(14,2) NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "status" text DEFAULT 'active'::text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."benefit_programs" (
  "id" text NOT NULL,
  "employer_id" text NOT NULL,
  "name" text NOT NULL,
  "benefit_type" text DEFAULT 'food'::text NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "allocation_amount" numeric(14,2),
  "allocation_frequency" text DEFAULT 'monthly'::text NOT NULL,
  "rollover_policy" text DEFAULT 'no_rollover'::text NOT NULL,
  "valid_from" date,
  "valid_until" date,
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."benefit_rules" (
  "id" bigint DEFAULT nextval('revale.benefit_rules_id_seq'::regclass) NOT NULL,
  "program_id" text NOT NULL,
  "rule_type" text NOT NULL,
  "rule_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."cards" (
  "card_number" text NOT NULL,
  "person_id" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."employee_access_invites" (
  "person_id" text NOT NULL,
  "enrollment_id" bigint NOT NULL,
  "employer_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "attempt_window" timestamp with time zone,
  "claim_id" text,
  "claim_until" timestamp with time zone
);

CREATE TABLE revale."employee_enrollments" (
  "id" bigint DEFAULT nextval('revale.employee_enrollments_id_seq'::regclass) NOT NULL,
  "program_id" text NOT NULL,
  "person_id" text NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "starts_on" date DEFAULT CURRENT_DATE NOT NULL,
  "ends_on" date,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."employee_imports" (
  "id" text NOT NULL,
  "employer_id" text NOT NULL,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."employer_approval_policies" (
  "employer_id" text NOT NULL,
  "threshold" numeric(14,2) DEFAULT 5000 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."employer_funding_approvals" (
  "funding_batch_id" text NOT NULL,
  "employer_id" text NOT NULL,
  "program_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "requester_auth_id" uuid NOT NULL,
  "requester_name" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "roster_hash" text NOT NULL,
  "required_approvals" integer NOT NULL,
  "policy_version" integer NOT NULL,
  "threshold" numeric(14,2) NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone
);

CREATE TABLE revale."employer_funding_decisions" (
  "funding_batch_id" text NOT NULL,
  "user_id" text NOT NULL,
  "auth_user_id" uuid NOT NULL,
  "actor_name" text NOT NULL,
  "actor_role" text NOT NULL,
  "decision" text NOT NULL,
  "note" text DEFAULT ''::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."employer_funding_receipts" (
  "id" text NOT NULL,
  "funding_batch_id" text NOT NULL,
  "employer_id" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "bank_reference" text NOT NULL,
  "bank_posted_on" date NOT NULL,
  "status" text DEFAULT 'confirmed'::text NOT NULL,
  "confirmed_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "treasury_account_id" text
);

CREATE TABLE revale."employer_funding_refunds" (
  "id" text NOT NULL,
  "funding_batch_id" text NOT NULL,
  "employer_id" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "bank_reference" text NOT NULL,
  "bank_posted_on" date NOT NULL,
  "reason" text,
  "status" text DEFAULT 'confirmed'::text NOT NULL,
  "confirmed_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "treasury_account_id" text
);

CREATE TABLE revale."employer_team_invites" (
  "user_id" text NOT NULL,
  "employer_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "attempt_window" timestamp with time zone,
  "claim_id" text,
  "claim_until" timestamp with time zone
);

CREATE TABLE revale."employer_users" (
  "id" text NOT NULL,
  "employer_id" text NOT NULL,
  "auth_user_id" uuid,
  "display_name" text NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT 'admin'::text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "invite_status" text DEFAULT 'active'::text NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activation_required" boolean DEFAULT false NOT NULL,
  "approval_limit" numeric(14,2),
  "access_version" integer DEFAULT 1 NOT NULL
);

CREATE TABLE revale."employers" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "tax_id" text,
  "slug" text,
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."financial_approval_decisions" (
  "id" bigint DEFAULT nextval('revale.financial_approval_decisions_id_seq'::regclass) NOT NULL,
  "request_id" text NOT NULL,
  "approver_id" text NOT NULL,
  "decision" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."financial_approval_policies" (
  "action_type" text NOT NULL,
  "label" text NOT NULL,
  "threshold_amount" numeric(16,2) DEFAULT 10000 NOT NULL,
  "approvals_below" integer DEFAULT 1 NOT NULL,
  "approvals_above" integer DEFAULT 2 NOT NULL,
  "expiry_hours" integer DEFAULT 48 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."financial_approval_requests" (
  "id" text NOT NULL,
  "request_key" text NOT NULL,
  "action_type" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "amount" numeric(16,2) DEFAULT 0 NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "requested_by" text NOT NULL,
  "requested_by_name" text,
  "required_approvals" integer NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "request_note" text,
  "expires_at" timestamp with time zone NOT NULL,
  "execution_started_at" timestamp with time zone,
  "executed_at" timestamp with time zone,
  "execution_result" jsonb,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."financial_user_permissions" (
  "admin_user_id" text NOT NULL,
  "can_make" boolean DEFAULT false NOT NULL,
  "can_approve" boolean DEFAULT false NOT NULL,
  "approval_limit" numeric(16,2),
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."funding_batch_items" (
  "id" bigint DEFAULT nextval('revale.funding_batch_items_id_seq'::regclass) NOT NULL,
  "funding_batch_id" text NOT NULL,
  "enrollment_id" bigint NOT NULL,
  "account_id" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "allocated_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."funding_batches" (
  "id" text NOT NULL,
  "employer_id" text NOT NULL,
  "program_id" text,
  "external_reference" text,
  "amount" numeric(14,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "received_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."gl_accounts" (
  "id" text NOT NULL,
  "internal_code" text NOT NULL,
  "local_account_code" text,
  "name" text NOT NULL,
  "account_type" text NOT NULL,
  "normal_balance" text NOT NULL,
  "ifrs_category" text NOT NULL,
  "ecuador_reporting_line" text,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."gl_journal_lines" (
  "id" bigint DEFAULT nextval('revale.gl_journal_lines_id_seq'::regclass) NOT NULL,
  "journal_id" text NOT NULL,
  "line_no" integer NOT NULL,
  "account_id" text NOT NULL,
  "debit" numeric(14,2) DEFAULT 0 NOT NULL,
  "credit" numeric(14,2) DEFAULT 0 NOT NULL,
  "merchant_id" text,
  "employer_id" text,
  "person_id" text,
  "benefit_account_id" text,
  "settlement_id" text,
  "transaction_id" text,
  "description" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."gl_journals" (
  "id" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "event_key" text DEFAULT 'default'::text NOT NULL,
  "journal_date" date DEFAULT CURRENT_DATE NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "description" text NOT NULL,
  "status" text DEFAULT 'posted'::text NOT NULL,
  "merchant_id" text,
  "employer_id" text,
  "person_id" text,
  "settlement_id" text,
  "transaction_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."idempotency_keys" (
  "id" bigint DEFAULT nextval('revale.idempotency_keys_id_seq'::regclass) NOT NULL,
  "scope" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text,
  "response_code" integer,
  "response_body" jsonb,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone
);

CREATE TABLE revale."invoices" (
  "id" bigint DEFAULT nextval('revale.invoices_id_seq'::regclass) NOT NULL,
  "transaction_id" text NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "email_alias" text NOT NULL,
  "sri_access_key" text,
  "xml_location" text,
  "pdf_location" text,
  "received_at" timestamp with time zone,
  "matched_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."ledger_entries" (
  "id" bigint DEFAULT nextval('revale.ledger_entries_id_seq'::regclass) NOT NULL,
  "account_id" text NOT NULL,
  "transaction_id" text,
  "entry_type" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "balance_after" numeric(14,2) NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."merchant_bank_account_requests" (
  "id" bigint DEFAULT nextval('revale.merchant_bank_account_requests_id_seq'::regclass) NOT NULL,
  "merchant_id" text NOT NULL,
  "bank_name" text NOT NULL,
  "account_type" text NOT NULL,
  "account_number" text NOT NULL,
  "holder_name" text NOT NULL,
  "holder_identification" text NOT NULL,
  "requested_by" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "rejection_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE revale."merchant_bank_accounts" (
  "id" bigint DEFAULT nextval('revale.merchant_bank_accounts_id_seq'::regclass) NOT NULL,
  "merchant_id" text NOT NULL,
  "bank_name" text NOT NULL,
  "account_type" text NOT NULL,
  "account_number" text NOT NULL,
  "holder_name" text NOT NULL,
  "holder_identification" text NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "requested_by" text,
  "verified_by" text,
  "verified_at" timestamp with time zone,
  "rejection_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE revale."merchant_fee_credit_notes" (
  "id" text NOT NULL,
  "fee_invoice_id" text NOT NULL,
  "settlement_id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "transaction_id" text,
  "credit_note_number" text,
  "access_key" text,
  "subtotal" numeric(14,2) DEFAULT 0 NOT NULL,
  "vat_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "total_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "reason" text,
  "status" text DEFAULT 'pending_issue'::text NOT NULL,
  "withholding_status" text DEFAULT 'not_required'::text NOT NULL,
  "withholding_adjustment_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "withholding_resolution_note" text,
  "resolved_by" text,
  "resolved_at" timestamp with time zone,
  "issued_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."merchant_fee_invoices" (
  "id" text NOT NULL,
  "settlement_id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "invoice_number" text,
  "access_key" text,
  "subtotal" numeric(14,2) DEFAULT 0 NOT NULL,
  "vat_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "total_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "status" text DEFAULT 'pending_issue'::text NOT NULL,
  "issued_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."merchant_location_requests" (
  "id" bigint DEFAULT nextval('revale.merchant_location_requests_id_seq'::regclass) NOT NULL,
  "merchant_id" text NOT NULL,
  "requested_by" text,
  "name" text NOT NULL,
  "address" text,
  "requested_terminals" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE revale."merchant_locations" (
  "id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "slug" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE revale."merchant_terms" (
  "id" bigint DEFAULT nextval('revale.merchant_terms_id_seq'::regclass) NOT NULL,
  "merchant_id" text NOT NULL,
  "discount_rate" numeric(7,5) DEFAULT 0.025 NOT NULL,
  "tax_rate" numeric(7,5) DEFAULT 0.15 NOT NULL,
  "settlement_frequency" text DEFAULT 'weekly'::text NOT NULL,
  "settlement_weekday" smallint DEFAULT 1 NOT NULL,
  "effective_from" date DEFAULT CURRENT_DATE NOT NULL,
  "effective_until" date,
  "active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."merchant_users" (
  "id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "location_id" text,
  "display_name" text NOT NULL,
  "role" text DEFAULT 'cashier'::text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "email" text,
  "invite_status" text DEFAULT 'active'::text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login_at" timestamp with time zone,
  "auth_user_id" uuid
);

CREATE TABLE revale."merchant_withholdings" (
  "id" text NOT NULL,
  "settlement_id" text NOT NULL,
  "fee_invoice_id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "document_number" text NOT NULL,
  "authorization_number" text,
  "issued_on" date NOT NULL,
  "income_tax_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "vat_withheld_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "total_amount" numeric(14,2) NOT NULL,
  "status" text DEFAULT 'reported'::text NOT NULL,
  "reported_by" text,
  "verified_by" text,
  "verified_at" timestamp with time zone,
  "rejection_reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."merchants" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "tax_id" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "slug" text,
  "logo_url" text,
  "brand_primary" text,
  "brand_secondary" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE revale."persons" (
  "id" text NOT NULL,
  "person_identification" text NOT NULL,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text,
  "mobile_phone" text,
  "company_identification" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "auth_user_id" uuid,
  "activation_required" boolean DEFAULT false NOT NULL,
  "activated_at" timestamp with time zone
);

CREATE TABLE revale."platform_users" (
  "id" text NOT NULL,
  "auth_user_id" uuid,
  "display_name" text NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT 'ops'::text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."reversal_requests" (
  "id" bigint DEFAULT nextval('revale.reversal_requests_id_seq'::regclass) NOT NULL,
  "transaction_id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "location_id" text,
  "requested_by" text NOT NULL,
  "reason" text NOT NULL,
  "note" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE revale."safeguarding_settings" (
  "id" text DEFAULT 'default'::text NOT NULL,
  "required_coverage_ratio" numeric(8,5) DEFAULT 1.00000 NOT NULL,
  "minimum_buffer" numeric(16,2) DEFAULT 0 NOT NULL,
  "stale_after_hours" integer DEFAULT 24 NOT NULL,
  "enforcement_enabled" boolean DEFAULT false NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."settlement_adjustments" (
  "id" text NOT NULL,
  "settlement_id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "adjustment_type" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."settlement_events" (
  "id" bigint DEFAULT nextval('revale.settlement_events_id_seq'::regclass) NOT NULL,
  "settlement_id" text NOT NULL,
  "event_type" text NOT NULL,
  "actor_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."settlement_items" (
  "id" bigint DEFAULT nextval('revale.settlement_items_id_seq'::regclass) NOT NULL,
  "settlement_id" text NOT NULL,
  "transaction_id" text,
  "item_type" text NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."settlement_payouts" (
  "id" bigint DEFAULT nextval('revale.settlement_payouts_id_seq'::regclass) NOT NULL,
  "settlement_id" text NOT NULL,
  "attempt_no" integer NOT NULL,
  "bank_account_id" bigint NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "status" text DEFAULT 'scheduled'::text NOT NULL,
  "payout_reference" text,
  "failure_reason" text,
  "scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_treasury_account_id" text
);

CREATE TABLE revale."settlement_reconciliations" (
  "id" text NOT NULL,
  "settlement_id" text NOT NULL,
  "payout_id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "expected_amount" numeric(14,2) NOT NULL,
  "bank_amount" numeric(14,2) NOT NULL,
  "difference_amount" numeric(14,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "bank_reference" text NOT NULL,
  "bank_posted_on" date NOT NULL,
  "status" text NOT NULL,
  "reconciled_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."settlements" (
  "id" text NOT NULL,
  "merchant_id" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "gross_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "adjustment_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "fee_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "tax_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "net_amount" numeric(14,2) DEFAULT 0 NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "status" text DEFAULT 'draft'::text NOT NULL,
  "bank_account_id" bigint,
  "payout_reference" text,
  "closed_at" timestamp with time zone,
  "scheduled_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."transaction_events" (
  "id" bigint DEFAULT nextval('revale.transaction_events_id_seq'::regclass) NOT NULL,
  "transaction_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."transactions" (
  "id" text NOT NULL,
  "external_transaction_id" text NOT NULL,
  "transaction_type" character(2) DEFAULT '04'::bpchar NOT NULL,
  "card_number" text,
  "merchant_id" text NOT NULL,
  "location_id" text NOT NULL,
  "transaction_date" date DEFAULT CURRENT_DATE NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "reference" text NOT NULL,
  "observation" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "public_token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "balance_before" numeric(14,2),
  "balance_after" numeric(14,2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_at" timestamp with time zone,
  "reversed_at" timestamp with time zone,
  "person_id" text,
  "account_id" text,
  "program_id" text
);

CREATE TABLE revale."treasury_bank_accounts" (
  "id" text NOT NULL,
  "bank_name" text NOT NULL,
  "account_name" text NOT NULL,
  "account_number_last4" text,
  "purpose" text NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "external_account_ref" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."treasury_bank_balance_snapshots" (
  "id" text NOT NULL,
  "bank_account_id" text NOT NULL,
  "balance" numeric(16,2) NOT NULL,
  "available_balance" numeric(16,2),
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "as_of" timestamp with time zone NOT NULL,
  "source" text DEFAULT 'manual'::text NOT NULL,
  "statement_reference" text,
  "recorded_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE revale."treasury_internal_transfers" (
  "id" text NOT NULL,
  "from_account_id" text NOT NULL,
  "to_account_id" text NOT NULL,
  "transfer_type" text NOT NULL,
  "amount" numeric(16,2) NOT NULL,
  "currency" character(3) DEFAULT 'USD'::bpchar NOT NULL,
  "bank_reference" text NOT NULL,
  "bank_posted_on" date NOT NULL,
  "status" text DEFAULT 'confirmed'::text NOT NULL,
  "confirmed_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER SEQUENCE revale."accounting_events_id_seq" OWNED BY revale."accounting_events"."id";

ALTER SEQUENCE revale."audit_events_id_seq" OWNED BY revale."audit_events"."id";

ALTER SEQUENCE revale."benefit_allocations_id_seq" OWNED BY revale."benefit_allocations"."id";

ALTER SEQUENCE revale."benefit_rules_id_seq" OWNED BY revale."benefit_rules"."id";

ALTER SEQUENCE revale."employee_enrollments_id_seq" OWNED BY revale."employee_enrollments"."id";

ALTER SEQUENCE revale."financial_approval_decisions_id_seq" OWNED BY revale."financial_approval_decisions"."id";

ALTER SEQUENCE revale."funding_batch_items_id_seq" OWNED BY revale."funding_batch_items"."id";

ALTER SEQUENCE revale."gl_journal_lines_id_seq" OWNED BY revale."gl_journal_lines"."id";

ALTER SEQUENCE revale."idempotency_keys_id_seq" OWNED BY revale."idempotency_keys"."id";

ALTER SEQUENCE revale."invoices_id_seq" OWNED BY revale."invoices"."id";

ALTER SEQUENCE revale."ledger_entries_id_seq" OWNED BY revale."ledger_entries"."id";

ALTER SEQUENCE revale."merchant_bank_account_requests_id_seq" OWNED BY revale."merchant_bank_account_requests"."id";

ALTER SEQUENCE revale."merchant_bank_accounts_id_seq" OWNED BY revale."merchant_bank_accounts"."id";

ALTER SEQUENCE revale."merchant_location_requests_id_seq" OWNED BY revale."merchant_location_requests"."id";

ALTER SEQUENCE revale."merchant_terms_id_seq" OWNED BY revale."merchant_terms"."id";

ALTER SEQUENCE revale."reversal_requests_id_seq" OWNED BY revale."reversal_requests"."id";

ALTER SEQUENCE revale."settlement_events_id_seq" OWNED BY revale."settlement_events"."id";

ALTER SEQUENCE revale."settlement_items_id_seq" OWNED BY revale."settlement_items"."id";

ALTER SEQUENCE revale."settlement_payouts_id_seq" OWNED BY revale."settlement_payouts"."id";

ALTER SEQUENCE revale."transaction_events_id_seq" OWNED BY revale."transaction_events"."id";

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_pkey" PRIMARY KEY (id);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_source_type_source_id_event_key_key" UNIQUE (source_type, source_id, event_key);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'posted'::text, 'error'::text, 'ignored'::text])));

ALTER TABLE revale."admin_users" ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY (id);

ALTER TABLE revale."admin_users" ADD CONSTRAINT "admin_users_role_check" CHECK ((role = ANY (ARRAY['superadmin'::text, 'ops'::text, 'finance'::text, 'support'::text, 'risk'::text])));

ALTER TABLE revale."audit_events" ADD CONSTRAINT "audit_events_pkey" PRIMARY KEY (id);

ALTER TABLE revale."bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_amount_check" CHECK ((amount <> (0)::numeric));

ALTER TABLE revale."bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_match_status_check" CHECK ((match_status = ANY (ARRAY['unmatched'::text, 'suggested'::text, 'matched'::text, 'ignored'::text])));

ALTER TABLE revale."bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_pkey" PRIMARY KEY (id);

ALTER TABLE revale."bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_treasury_account_id_fingerprint_key" UNIQUE (treasury_account_id, fingerprint);

ALTER TABLE revale."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_file_format_check" CHECK ((file_format = ANY (ARRAY['csv'::text, 'xlsx'::text])));

ALTER TABLE revale."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY (id);

ALTER TABLE revale."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_status_check" CHECK ((status = ANY (ARRAY['imported'::text, 'reviewed'::text, 'completed'::text, 'failed'::text])));

ALTER TABLE revale."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_treasury_account_id_file_hash_key" UNIQUE (treasury_account_id, file_hash);

ALTER TABLE revale."benefit_accounts" ADD CONSTRAINT "benefit_accounts_balance_check" CHECK ((balance >= (0)::numeric));

ALTER TABLE revale."benefit_accounts" ADD CONSTRAINT "benefit_accounts_card_number_key" UNIQUE (card_number);

ALTER TABLE revale."benefit_accounts" ADD CONSTRAINT "benefit_accounts_pkey" PRIMARY KEY (id);

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_pkey" PRIMARY KEY (id);

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'reversed'::text])));

ALTER TABLE revale."benefit_programs" ADD CONSTRAINT "benefit_programs_allocation_frequency_check" CHECK ((allocation_frequency = ANY (ARRAY['one_time'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text, 'custom'::text])));

ALTER TABLE revale."benefit_programs" ADD CONSTRAINT "benefit_programs_pkey" PRIMARY KEY (id);

ALTER TABLE revale."benefit_programs" ADD CONSTRAINT "benefit_programs_rollover_policy_check" CHECK ((rollover_policy = ANY (ARRAY['no_rollover'::text, 'full_rollover'::text, 'capped_rollover'::text])));

ALTER TABLE revale."benefit_rules" ADD CONSTRAINT "benefit_rules_pkey" PRIMARY KEY (id);

ALTER TABLE revale."cards" ADD CONSTRAINT "cards_pkey" PRIMARY KEY (card_number);

ALTER TABLE revale."employee_access_invites" ADD CONSTRAINT "employee_access_invites_pkey" PRIMARY KEY (person_id);

ALTER TABLE revale."employee_access_invites" ADD CONSTRAINT "employee_access_invites_token_hash_key" UNIQUE (token_hash);

ALTER TABLE revale."employee_enrollments" ADD CONSTRAINT "employee_enrollments_pkey" PRIMARY KEY (id);

ALTER TABLE revale."employee_enrollments" ADD CONSTRAINT "employee_enrollments_program_id_person_id_key" UNIQUE (program_id, person_id);

ALTER TABLE revale."employee_enrollments" ADD CONSTRAINT "employee_enrollments_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'ended'::text])));

ALTER TABLE revale."employee_imports" ADD CONSTRAINT "employee_imports_pkey" PRIMARY KEY (id);

ALTER TABLE revale."employer_approval_policies" ADD CONSTRAINT "employer_approval_policies_pkey" PRIMARY KEY (employer_id);

ALTER TABLE revale."employer_approval_policies" ADD CONSTRAINT "employer_approval_policies_threshold_check" CHECK ((threshold > (0)::numeric));

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_pkey" PRIMARY KEY (funding_batch_id);

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_required_approvals_check" CHECK ((required_approvals = ANY (ARRAY[1, 2])));

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));

ALTER TABLE revale."employer_funding_decisions" ADD CONSTRAINT "employer_funding_decisions_decision_check" CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text, 'cancel'::text])));

ALTER TABLE revale."employer_funding_decisions" ADD CONSTRAINT "employer_funding_decisions_funding_batch_id_auth_user_id_key" UNIQUE (funding_batch_id, auth_user_id);

ALTER TABLE revale."employer_funding_decisions" ADD CONSTRAINT "employer_funding_decisions_pkey" PRIMARY KEY (funding_batch_id, user_id);

ALTER TABLE revale."employer_funding_receipts" ADD CONSTRAINT "employer_funding_receipts_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."employer_funding_receipts" ADD CONSTRAINT "employer_funding_receipts_pkey" PRIMARY KEY (id);

ALTER TABLE revale."employer_funding_receipts" ADD CONSTRAINT "employer_funding_receipts_status_check" CHECK ((status = ANY (ARRAY['confirmed'::text, 'voided'::text])));

ALTER TABLE revale."employer_funding_refunds" ADD CONSTRAINT "employer_funding_refunds_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."employer_funding_refunds" ADD CONSTRAINT "employer_funding_refunds_pkey" PRIMARY KEY (id);

ALTER TABLE revale."employer_funding_refunds" ADD CONSTRAINT "employer_funding_refunds_status_check" CHECK ((status = ANY (ARRAY['confirmed'::text, 'voided'::text])));

ALTER TABLE revale."employer_team_invites" ADD CONSTRAINT "employer_team_invites_pkey" PRIMARY KEY (user_id);

ALTER TABLE revale."employer_team_invites" ADD CONSTRAINT "employer_team_invites_token_hash_key" UNIQUE (token_hash);

ALTER TABLE revale."employer_users" ADD CONSTRAINT "employer_users_approval_limit_check" CHECK ((approval_limit >= (0)::numeric));

ALTER TABLE revale."employer_users" ADD CONSTRAINT "employer_users_pkey" PRIMARY KEY (id);

ALTER TABLE revale."employer_users" ADD CONSTRAINT "employer_users_role_check" CHECK ((role = ANY (ARRAY['admin'::text, 'finance'::text, 'hr'::text, 'viewer'::text])));

ALTER TABLE revale."employers" ADD CONSTRAINT "employers_pkey" PRIMARY KEY (id);

ALTER TABLE revale."financial_approval_decisions" ADD CONSTRAINT "financial_approval_decisions_decision_check" CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])));

ALTER TABLE revale."financial_approval_decisions" ADD CONSTRAINT "financial_approval_decisions_pkey" PRIMARY KEY (id);

ALTER TABLE revale."financial_approval_decisions" ADD CONSTRAINT "financial_approval_decisions_request_id_approver_id_key" UNIQUE (request_id, approver_id);

ALTER TABLE revale."financial_approval_policies" ADD CONSTRAINT "financial_approval_policies_approvals_above_check" CHECK (((approvals_above >= 1) AND (approvals_above <= 5)));

ALTER TABLE revale."financial_approval_policies" ADD CONSTRAINT "financial_approval_policies_approvals_below_check" CHECK (((approvals_below >= 1) AND (approvals_below <= 5)));

ALTER TABLE revale."financial_approval_policies" ADD CONSTRAINT "financial_approval_policies_expiry_hours_check" CHECK (((expiry_hours >= 1) AND (expiry_hours <= 720)));

ALTER TABLE revale."financial_approval_policies" ADD CONSTRAINT "financial_approval_policies_pkey" PRIMARY KEY (action_type);

ALTER TABLE revale."financial_approval_policies" ADD CONSTRAINT "financial_approval_policies_threshold_amount_check" CHECK ((threshold_amount >= (0)::numeric));

ALTER TABLE revale."financial_approval_requests" ADD CONSTRAINT "financial_approval_requests_amount_check" CHECK ((amount >= (0)::numeric));

ALTER TABLE revale."financial_approval_requests" ADD CONSTRAINT "financial_approval_requests_pkey" PRIMARY KEY (id);

ALTER TABLE revale."financial_approval_requests" ADD CONSTRAINT "financial_approval_requests_request_key_key" UNIQUE (request_key);

ALTER TABLE revale."financial_approval_requests" ADD CONSTRAINT "financial_approval_requests_required_approvals_check" CHECK (((required_approvals >= 1) AND (required_approvals <= 5)));

ALTER TABLE revale."financial_approval_requests" ADD CONSTRAINT "financial_approval_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'executing'::text, 'executed'::text, 'execution_failed'::text, 'cancelled'::text, 'expired'::text])));

ALTER TABLE revale."financial_user_permissions" ADD CONSTRAINT "financial_user_permissions_pkey" PRIMARY KEY (admin_user_id);

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_funding_batch_id_enrollment_id_key" UNIQUE (funding_batch_id, enrollment_id);

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_pkey" PRIMARY KEY (id);

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'allocated'::text, 'failed'::text, 'cancelled'::text])));

ALTER TABLE revale."funding_batches" ADD CONSTRAINT "funding_batches_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."funding_batches" ADD CONSTRAINT "funding_batches_pkey" PRIMARY KEY (id);

ALTER TABLE revale."funding_batches" ADD CONSTRAINT "funding_batches_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'allocated'::text, 'cancelled'::text])));

ALTER TABLE revale."gl_accounts" ADD CONSTRAINT "gl_accounts_account_type_check" CHECK ((account_type = ANY (ARRAY['asset'::text, 'liability'::text, 'equity'::text, 'revenue'::text, 'expense'::text])));

ALTER TABLE revale."gl_accounts" ADD CONSTRAINT "gl_accounts_internal_code_key" UNIQUE (internal_code);

ALTER TABLE revale."gl_accounts" ADD CONSTRAINT "gl_accounts_normal_balance_check" CHECK ((normal_balance = ANY (ARRAY['debit'::text, 'credit'::text])));

ALTER TABLE revale."gl_accounts" ADD CONSTRAINT "gl_accounts_pkey" PRIMARY KEY (id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_check" CHECK ((((debit > (0)::numeric) AND (credit = (0)::numeric)) OR ((credit > (0)::numeric) AND (debit = (0)::numeric))));

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_credit_check" CHECK ((credit >= (0)::numeric));

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_debit_check" CHECK ((debit >= (0)::numeric));

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_journal_id_line_no_key" UNIQUE (journal_id, line_no);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_pkey" PRIMARY KEY (id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_pkey" PRIMARY KEY (id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_source_type_source_id_event_key_key" UNIQUE (source_type, source_id, event_key);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text, 'reversed'::text])));

ALTER TABLE revale."idempotency_keys" ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY (id);

ALTER TABLE revale."idempotency_keys" ADD CONSTRAINT "idempotency_keys_scope_idempotency_key_key" UNIQUE (scope, idempotency_key);

ALTER TABLE revale."invoices" ADD CONSTRAINT "invoices_email_alias_key" UNIQUE (email_alias);

ALTER TABLE revale."invoices" ADD CONSTRAINT "invoices_pkey" PRIMARY KEY (id);

ALTER TABLE revale."invoices" ADD CONSTRAINT "invoices_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'matched'::text, 'rejected'::text])));

ALTER TABLE revale."invoices" ADD CONSTRAINT "invoices_transaction_id_key" UNIQUE (transaction_id);

ALTER TABLE revale."ledger_entries" ADD CONSTRAINT "ledger_entries_entry_type_check" CHECK ((entry_type = ANY (ARRAY['allocation'::text, 'consumption'::text, 'reversal'::text, 'adjustment'::text])));

ALTER TABLE revale."ledger_entries" ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_bank_account_requests" ADD CONSTRAINT "merchant_bank_account_requests_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_bank_account_requests" ADD CONSTRAINT "merchant_bank_account_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));

ALTER TABLE revale."merchant_bank_accounts" ADD CONSTRAINT "merchant_bank_accounts_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_bank_accounts" ADD CONSTRAINT "merchant_bank_accounts_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'superseded'::text])));

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_status_check" CHECK ((status = ANY (ARRAY['pending_issue'::text, 'issued'::text, 'cancelled'::text])));

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_subtotal_check" CHECK ((subtotal >= (0)::numeric));

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_total_amount_check" CHECK ((total_amount >= (0)::numeric));

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_vat_amount_check" CHECK ((vat_amount >= (0)::numeric));

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_withholding_adjustment_amount_check" CHECK ((withholding_adjustment_amount >= (0)::numeric));

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_withholding_status_check" CHECK ((withholding_status = ANY (ARRAY['not_required'::text, 'review_required'::text, 'resolved'::text])));

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_settlement_id_key" UNIQUE (settlement_id);

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_status_check" CHECK ((status = ANY (ARRAY['pending_issue'::text, 'issued'::text, 'cancelled'::text])));

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_subtotal_check" CHECK ((subtotal >= (0)::numeric));

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_total_amount_check" CHECK ((total_amount >= (0)::numeric));

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_vat_amount_check" CHECK ((vat_amount >= (0)::numeric));

ALTER TABLE revale."merchant_location_requests" ADD CONSTRAINT "merchant_location_requests_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_location_requests" ADD CONSTRAINT "merchant_location_requests_requested_terminals_check" CHECK (((requested_terminals >= 1) AND (requested_terminals <= 50)));

ALTER TABLE revale."merchant_location_requests" ADD CONSTRAINT "merchant_location_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));

ALTER TABLE revale."merchant_locations" ADD CONSTRAINT "merchant_locations_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_terms" ADD CONSTRAINT "merchant_terms_discount_rate_check" CHECK (((discount_rate >= (0)::numeric) AND (discount_rate < (1)::numeric)));

ALTER TABLE revale."merchant_terms" ADD CONSTRAINT "merchant_terms_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_terms" ADD CONSTRAINT "merchant_terms_settlement_frequency_check" CHECK ((settlement_frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text])));

ALTER TABLE revale."merchant_terms" ADD CONSTRAINT "merchant_terms_settlement_weekday_check" CHECK (((settlement_weekday >= 0) AND (settlement_weekday <= 6)));

ALTER TABLE revale."merchant_terms" ADD CONSTRAINT "merchant_terms_tax_rate_check" CHECK (((tax_rate >= (0)::numeric) AND (tax_rate < (1)::numeric)));

ALTER TABLE revale."merchant_users" ADD CONSTRAINT "merchant_users_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_income_tax_amount_check" CHECK ((income_tax_amount >= (0)::numeric));

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_pkey" PRIMARY KEY (id);

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_status_check" CHECK ((status = ANY (ARRAY['reported'::text, 'verified'::text, 'rejected'::text])));

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_total_amount_check" CHECK ((total_amount > (0)::numeric));

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_vat_withheld_amount_check" CHECK ((vat_withheld_amount >= (0)::numeric));

ALTER TABLE revale."merchants" ADD CONSTRAINT "merchants_pkey" PRIMARY KEY (id);

ALTER TABLE revale."persons" ADD CONSTRAINT "persons_person_identification_key" UNIQUE (person_identification);

ALTER TABLE revale."persons" ADD CONSTRAINT "persons_pkey" PRIMARY KEY (id);

ALTER TABLE revale."platform_users" ADD CONSTRAINT "platform_users_pkey" PRIMARY KEY (id);

ALTER TABLE revale."platform_users" ADD CONSTRAINT "platform_users_role_check" CHECK ((role = ANY (ARRAY['admin'::text, 'ops'::text, 'finance'::text, 'support'::text])));

ALTER TABLE revale."reversal_requests" ADD CONSTRAINT "reversal_requests_pkey" PRIMARY KEY (id);

ALTER TABLE revale."reversal_requests" ADD CONSTRAINT "reversal_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));

ALTER TABLE revale."safeguarding_settings" ADD CONSTRAINT "safeguarding_settings_minimum_buffer_check" CHECK ((minimum_buffer >= (0)::numeric));

ALTER TABLE revale."safeguarding_settings" ADD CONSTRAINT "safeguarding_settings_pkey" PRIMARY KEY (id);

ALTER TABLE revale."safeguarding_settings" ADD CONSTRAINT "safeguarding_settings_required_coverage_ratio_check" CHECK ((required_coverage_ratio >= (1)::numeric));

ALTER TABLE revale."safeguarding_settings" ADD CONSTRAINT "safeguarding_settings_stale_after_hours_check" CHECK (((stale_after_hours >= 1) AND (stale_after_hours <= 168)));

ALTER TABLE revale."settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_amount_check" CHECK ((amount <> (0)::numeric));

ALTER TABLE revale."settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_pkey" PRIMARY KEY (id);

ALTER TABLE revale."settlement_events" ADD CONSTRAINT "settlement_events_pkey" PRIMARY KEY (id);

ALTER TABLE revale."settlement_items" ADD CONSTRAINT "settlement_items_item_type_check" CHECK ((item_type = ANY (ARRAY['consumption'::text, 'reversal'::text, 'fee'::text, 'tax'::text, 'adjustment'::text])));

ALTER TABLE revale."settlement_items" ADD CONSTRAINT "settlement_items_pkey" PRIMARY KEY (id);

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_pkey" PRIMARY KEY (id);

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_settlement_id_attempt_no_key" UNIQUE (settlement_id, attempt_no);

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_status_check" CHECK ((status = ANY (ARRAY['scheduled'::text, 'processing'::text, 'paid'::text, 'failed'::text, 'cancelled'::text])));

ALTER TABLE revale."settlement_reconciliations" ADD CONSTRAINT "settlement_reconciliations_pkey" PRIMARY KEY (id);

ALTER TABLE revale."settlement_reconciliations" ADD CONSTRAINT "settlement_reconciliations_settlement_id_payout_id_key" UNIQUE (settlement_id, payout_id);

ALTER TABLE revale."settlement_reconciliations" ADD CONSTRAINT "settlement_reconciliations_status_check" CHECK ((status = ANY (ARRAY['matched'::text, 'mismatch'::text])));

ALTER TABLE revale."settlements" ADD CONSTRAINT "settlements_merchant_id_period_start_period_end_key" UNIQUE (merchant_id, period_start, period_end);

ALTER TABLE revale."settlements" ADD CONSTRAINT "settlements_pkey" PRIMARY KEY (id);

ALTER TABLE revale."settlements" ADD CONSTRAINT "settlements_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'closed'::text, 'scheduled'::text, 'paid'::text, 'failed'::text, 'cancelled'::text])));

ALTER TABLE revale."transaction_events" ADD CONSTRAINT "transaction_events_pkey" PRIMARY KEY (id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_external_transaction_id_key" UNIQUE (external_transaction_id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_pkey" PRIMARY KEY (id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_public_token_key" UNIQUE (public_token);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'expired'::text, 'reversed'::text])));

ALTER TABLE revale."treasury_bank_accounts" ADD CONSTRAINT "treasury_bank_accounts_pkey" PRIMARY KEY (id);

ALTER TABLE revale."treasury_bank_accounts" ADD CONSTRAINT "treasury_bank_accounts_purpose_check" CHECK ((purpose = ANY (ARRAY['client_funds'::text, 'operating'::text, 'tax'::text])));

ALTER TABLE revale."treasury_bank_balance_snapshots" ADD CONSTRAINT "treasury_bank_balance_snapshots_pkey" PRIMARY KEY (id);

ALTER TABLE revale."treasury_bank_balance_snapshots" ADD CONSTRAINT "treasury_bank_balance_snapshots_source_check" CHECK ((source = ANY (ARRAY['manual'::text, 'bank_import'::text, 'api'::text])));

ALTER TABLE revale."treasury_internal_transfers" ADD CONSTRAINT "treasury_internal_transfers_amount_check" CHECK ((amount > (0)::numeric));

ALTER TABLE revale."treasury_internal_transfers" ADD CONSTRAINT "treasury_internal_transfers_pkey" PRIMARY KEY (id);

ALTER TABLE revale."treasury_internal_transfers" ADD CONSTRAINT "treasury_internal_transfers_status_check" CHECK ((status = ANY (ARRAY['confirmed'::text, 'voided'::text])));

ALTER TABLE revale."treasury_internal_transfers" ADD CONSTRAINT "treasury_internal_transfers_transfer_type_check" CHECK ((transfer_type = ANY (ARRAY['safeguarding_topup'::text, 'excess_sweep'::text])));

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_benefit_account_id_fkey" FOREIGN KEY (benefit_account_id) REFERENCES revale.benefit_accounts(id);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."accounting_events" ADD CONSTRAINT "accounting_events_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."audit_events" ADD CONSTRAINT "audit_events_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."audit_events" ADD CONSTRAINT "audit_events_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_import_id_fkey" FOREIGN KEY (import_id) REFERENCES revale.bank_statement_imports(id);

ALTER TABLE revale."bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_treasury_account_id_fkey" FOREIGN KEY (treasury_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_treasury_account_id_fkey" FOREIGN KEY (treasury_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."benefit_accounts" ADD CONSTRAINT "benefit_accounts_card_number_fkey" FOREIGN KEY (card_number) REFERENCES revale.cards(card_number);

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_account_id_fkey" FOREIGN KEY (account_id) REFERENCES revale.benefit_accounts(id);

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_enrollment_id_fkey" FOREIGN KEY (enrollment_id) REFERENCES revale.employee_enrollments(id);

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_funding_batch_id_fkey" FOREIGN KEY (funding_batch_id) REFERENCES revale.funding_batches(id);

ALTER TABLE revale."benefit_allocations" ADD CONSTRAINT "benefit_allocations_program_id_fkey" FOREIGN KEY (program_id) REFERENCES revale.benefit_programs(id);

ALTER TABLE revale."benefit_programs" ADD CONSTRAINT "benefit_programs_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."benefit_rules" ADD CONSTRAINT "benefit_rules_program_id_fkey" FOREIGN KEY (program_id) REFERENCES revale.benefit_programs(id);

ALTER TABLE revale."cards" ADD CONSTRAINT "cards_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."employee_access_invites" ADD CONSTRAINT "employee_access_invites_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employee_access_invites" ADD CONSTRAINT "employee_access_invites_enrollment_id_fkey" FOREIGN KEY (enrollment_id) REFERENCES revale.employee_enrollments(id);

ALTER TABLE revale."employee_access_invites" ADD CONSTRAINT "employee_access_invites_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."employee_enrollments" ADD CONSTRAINT "employee_enrollments_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."employee_enrollments" ADD CONSTRAINT "employee_enrollments_program_id_fkey" FOREIGN KEY (program_id) REFERENCES revale.benefit_programs(id);

ALTER TABLE revale."employee_imports" ADD CONSTRAINT "employee_imports_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employer_approval_policies" ADD CONSTRAINT "employer_approval_policies_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_funding_batch_id_fkey" FOREIGN KEY (funding_batch_id) REFERENCES revale.funding_batches(id);

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_program_id_fkey" FOREIGN KEY (program_id) REFERENCES revale.benefit_programs(id);

ALTER TABLE revale."employer_funding_approvals" ADD CONSTRAINT "employer_funding_approvals_requested_by_fkey" FOREIGN KEY (requested_by) REFERENCES revale.employer_users(id);

ALTER TABLE revale."employer_funding_decisions" ADD CONSTRAINT "employer_funding_decisions_funding_batch_id_fkey" FOREIGN KEY (funding_batch_id) REFERENCES revale.employer_funding_approvals(funding_batch_id);

ALTER TABLE revale."employer_funding_decisions" ADD CONSTRAINT "employer_funding_decisions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES revale.employer_users(id);

ALTER TABLE revale."employer_funding_receipts" ADD CONSTRAINT "employer_funding_receipts_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employer_funding_receipts" ADD CONSTRAINT "employer_funding_receipts_funding_batch_id_fkey" FOREIGN KEY (funding_batch_id) REFERENCES revale.funding_batches(id);

ALTER TABLE revale."employer_funding_receipts" ADD CONSTRAINT "employer_funding_receipts_treasury_account_fk" FOREIGN KEY (treasury_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."employer_funding_refunds" ADD CONSTRAINT "employer_funding_refunds_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employer_funding_refunds" ADD CONSTRAINT "employer_funding_refunds_funding_batch_id_fkey" FOREIGN KEY (funding_batch_id) REFERENCES revale.funding_batches(id);

ALTER TABLE revale."employer_funding_refunds" ADD CONSTRAINT "employer_funding_refunds_treasury_account_fk" FOREIGN KEY (treasury_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."employer_team_invites" ADD CONSTRAINT "employer_team_invites_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."employer_team_invites" ADD CONSTRAINT "employer_team_invites_user_id_fkey" FOREIGN KEY (user_id) REFERENCES revale.employer_users(id);

ALTER TABLE revale."employer_users" ADD CONSTRAINT "employer_users_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."financial_approval_decisions" ADD CONSTRAINT "financial_approval_decisions_request_id_fkey" FOREIGN KEY (request_id) REFERENCES revale.financial_approval_requests(id);

ALTER TABLE revale."financial_approval_requests" ADD CONSTRAINT "financial_approval_requests_action_type_fkey" FOREIGN KEY (action_type) REFERENCES revale.financial_approval_policies(action_type);

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_account_id_fkey" FOREIGN KEY (account_id) REFERENCES revale.benefit_accounts(id);

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_enrollment_id_fkey" FOREIGN KEY (enrollment_id) REFERENCES revale.employee_enrollments(id);

ALTER TABLE revale."funding_batch_items" ADD CONSTRAINT "funding_batch_items_funding_batch_id_fkey" FOREIGN KEY (funding_batch_id) REFERENCES revale.funding_batches(id);

ALTER TABLE revale."funding_batches" ADD CONSTRAINT "funding_batches_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."funding_batches" ADD CONSTRAINT "funding_batches_program_id_fkey" FOREIGN KEY (program_id) REFERENCES revale.benefit_programs(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_account_id_fkey" FOREIGN KEY (account_id) REFERENCES revale.gl_accounts(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_benefit_account_id_fkey" FOREIGN KEY (benefit_account_id) REFERENCES revale.benefit_accounts(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_journal_id_fkey" FOREIGN KEY (journal_id) REFERENCES revale.gl_journals(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_employer_id_fkey" FOREIGN KEY (employer_id) REFERENCES revale.employers(id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."gl_journals" ADD CONSTRAINT "gl_journals_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."invoices" ADD CONSTRAINT "invoices_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY (account_id) REFERENCES revale.benefit_accounts(id);

ALTER TABLE revale."ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."merchant_bank_account_requests" ADD CONSTRAINT "merchant_bank_account_requests_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_bank_accounts" ADD CONSTRAINT "merchant_bank_accounts_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_fee_invoice_id_fkey" FOREIGN KEY (fee_invoice_id) REFERENCES revale.merchant_fee_invoices(id);

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."merchant_fee_credit_notes" ADD CONSTRAINT "merchant_fee_credit_notes_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_fee_invoices" ADD CONSTRAINT "merchant_fee_invoices_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."merchant_location_requests" ADD CONSTRAINT "merchant_location_requests_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_locations" ADD CONSTRAINT "merchant_locations_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_terms" ADD CONSTRAINT "merchant_terms_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_users" ADD CONSTRAINT "merchant_users_location_id_fkey" FOREIGN KEY (location_id) REFERENCES revale.merchant_locations(id);

ALTER TABLE revale."merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_fee_invoice_id_fkey" FOREIGN KEY (fee_invoice_id) REFERENCES revale.merchant_fee_invoices(id);

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."merchant_withholdings" ADD CONSTRAINT "merchant_withholdings_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."reversal_requests" ADD CONSTRAINT "reversal_requests_location_id_fkey" FOREIGN KEY (location_id) REFERENCES revale.merchant_locations(id);

ALTER TABLE revale."reversal_requests" ADD CONSTRAINT "reversal_requests_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."reversal_requests" ADD CONSTRAINT "reversal_requests_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."settlement_adjustments" ADD CONSTRAINT "settlement_adjustments_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."settlement_events" ADD CONSTRAINT "settlement_events_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."settlement_items" ADD CONSTRAINT "settlement_items_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES revale.merchant_bank_accounts(id);

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."settlement_payouts" ADD CONSTRAINT "settlement_payouts_source_treasury_account_fk" FOREIGN KEY (source_treasury_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."settlement_reconciliations" ADD CONSTRAINT "settlement_reconciliations_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."settlement_reconciliations" ADD CONSTRAINT "settlement_reconciliations_settlement_id_fkey" FOREIGN KEY (settlement_id) REFERENCES revale.settlements(id);

ALTER TABLE revale."settlements" ADD CONSTRAINT "settlements_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES revale.merchant_bank_accounts(id);

ALTER TABLE revale."settlements" ADD CONSTRAINT "settlements_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES revale.transactions(id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY (account_id) REFERENCES revale.benefit_accounts(id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_card_number_fkey" FOREIGN KEY (card_number) REFERENCES revale.cards(card_number);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_location_id_fkey" FOREIGN KEY (location_id) REFERENCES revale.merchant_locations(id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES revale.merchants(id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_person_id_fkey" FOREIGN KEY (person_id) REFERENCES revale.persons(id);

ALTER TABLE revale."transactions" ADD CONSTRAINT "transactions_program_id_fkey" FOREIGN KEY (program_id) REFERENCES revale.benefit_programs(id);

ALTER TABLE revale."treasury_bank_balance_snapshots" ADD CONSTRAINT "treasury_bank_balance_snapshots_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."treasury_internal_transfers" ADD CONSTRAINT "treasury_internal_transfers_from_account_id_fkey" FOREIGN KEY (from_account_id) REFERENCES revale.treasury_bank_accounts(id);

ALTER TABLE revale."treasury_internal_transfers" ADD CONSTRAINT "treasury_internal_transfers_to_account_id_fkey" FOREIGN KEY (to_account_id) REFERENCES revale.treasury_bank_accounts(id);

CREATE INDEX accounting_events_status_idx ON revale.accounting_events USING btree (status, created_at);

CREATE UNIQUE INDEX admin_users_auth_unique ON revale.admin_users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX admin_users_email_unique ON revale.admin_users USING btree (lower(email));

CREATE INDEX audit_events_employer_idx ON revale.audit_events USING btree (employer_id, created_at DESC);

CREATE INDEX audit_events_merchant_idx ON revale.audit_events USING btree (merchant_id, created_at DESC);

CREATE INDEX bank_statement_entries_import_idx ON revale.bank_statement_entries USING btree (import_id, booking_date, id);

CREATE INDEX bank_statement_entries_review_idx ON revale.bank_statement_entries USING btree (treasury_account_id, match_status, booking_date DESC);

CREATE INDEX benefit_allocations_account_idx ON revale.benefit_allocations USING btree (account_id, status, expires_at);

CREATE INDEX benefit_programs_employer_idx ON revale.benefit_programs USING btree (employer_id, active);

CREATE INDEX benefit_rules_program_idx ON revale.benefit_rules USING btree (program_id, active, priority);

CREATE INDEX employee_access_invites_employer_idx ON revale.employee_access_invites USING btree (employer_id, expires_at);

CREATE INDEX employer_funding_approvals_queue_idx ON revale.employer_funding_approvals USING btree (employer_id, status, created_at DESC);

CREATE INDEX employer_funding_receipts_batch_idx ON revale.employer_funding_receipts USING btree (funding_batch_id, status, created_at);

CREATE UNIQUE INDEX employer_funding_receipts_ref_unique ON revale.employer_funding_receipts USING btree (employer_id, bank_reference, bank_posted_on) WHERE (status = 'confirmed'::text);

CREATE INDEX employer_funding_refunds_batch_idx ON revale.employer_funding_refunds USING btree (funding_batch_id, status, created_at);

CREATE UNIQUE INDEX employer_funding_refunds_ref_unique ON revale.employer_funding_refunds USING btree (employer_id, bank_reference, bank_posted_on) WHERE (status = 'confirmed'::text);

CREATE INDEX employer_team_invites_company_idx ON revale.employer_team_invites USING btree (employer_id, expires_at);

CREATE UNIQUE INDEX employer_users_auth_unique ON revale.employer_users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX employer_users_email_unique ON revale.employer_users USING btree (lower(email));

CREATE UNIQUE INDEX employers_slug_unique ON revale.employers USING btree (slug) WHERE (slug IS NOT NULL);

CREATE INDEX financial_approval_decisions_request_idx ON revale.financial_approval_decisions USING btree (request_id, created_at);

CREATE INDEX financial_approval_requests_entity_idx ON revale.financial_approval_requests USING btree (action_type, entity_type, entity_id, created_at DESC);

CREATE INDEX financial_approval_requests_queue_idx ON revale.financial_approval_requests USING btree (status, created_at);

CREATE INDEX funding_batch_items_batch_idx ON revale.funding_batch_items USING btree (funding_batch_id, status);

CREATE INDEX funding_batches_employer_status_idx ON revale.funding_batches USING btree (employer_id, status, created_at DESC);

CREATE INDEX gl_journal_lines_account_idx ON revale.gl_journal_lines USING btree (account_id, created_at);

CREATE INDEX gl_journal_lines_employer_idx ON revale.gl_journal_lines USING btree (employer_id, created_at) WHERE (employer_id IS NOT NULL);

CREATE INDEX gl_journal_lines_merchant_idx ON revale.gl_journal_lines USING btree (merchant_id, created_at) WHERE (merchant_id IS NOT NULL);

CREATE INDEX idx_transaction_events_tx ON revale.transaction_events USING btree (transaction_id, created_at);

CREATE INDEX idx_transactions_card_created ON revale.transactions USING btree (card_number, created_at DESC);

CREATE INDEX idx_transactions_status_created ON revale.transactions USING btree (status, created_at DESC);

CREATE INDEX merchant_bank_account_requests_merchant_idx ON revale.merchant_bank_account_requests USING btree (merchant_id, created_at DESC);

CREATE UNIQUE INDEX merchant_bank_account_requests_one_pending ON revale.merchant_bank_account_requests USING btree (merchant_id) WHERE (status = 'pending'::text);

CREATE INDEX merchant_bank_accounts_merchant_idx ON revale.merchant_bank_accounts USING btree (merchant_id, created_at DESC);

CREATE UNIQUE INDEX merchant_bank_accounts_one_current ON revale.merchant_bank_accounts USING btree (merchant_id) WHERE (status = ANY (ARRAY['pending'::text, 'verified'::text]));

CREATE UNIQUE INDEX merchant_fee_credit_notes_access_key_unique ON revale.merchant_fee_credit_notes USING btree (access_key) WHERE (access_key IS NOT NULL);

CREATE INDEX merchant_fee_credit_notes_status_idx ON revale.merchant_fee_credit_notes USING btree (merchant_id, status, withholding_status, created_at);

CREATE UNIQUE INDEX merchant_fee_credit_notes_tx_unique ON revale.merchant_fee_credit_notes USING btree (fee_invoice_id, transaction_id) WHERE (transaction_id IS NOT NULL);

CREATE UNIQUE INDEX merchant_fee_invoices_access_key_unique ON revale.merchant_fee_invoices USING btree (access_key) WHERE (access_key IS NOT NULL);

CREATE INDEX merchant_location_requests_merchant_idx ON revale.merchant_location_requests USING btree (merchant_id, created_at DESC);

CREATE INDEX merchant_terms_lookup_idx ON revale.merchant_terms USING btree (merchant_id, active, effective_from DESC);

CREATE INDEX merchant_users_auth_user_idx ON revale.merchant_users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX merchant_users_email_unique ON revale.merchant_users USING btree (lower(email)) WHERE (email IS NOT NULL);

CREATE UNIQUE INDEX merchant_withholdings_active_invoice_unique ON revale.merchant_withholdings USING btree (fee_invoice_id) WHERE (status = ANY (ARRAY['reported'::text, 'verified'::text]));

CREATE UNIQUE INDEX merchant_withholdings_document_unique ON revale.merchant_withholdings USING btree (merchant_id, document_number);

CREATE INDEX merchant_withholdings_status_idx ON revale.merchant_withholdings USING btree (status, created_at);

CREATE UNIQUE INDEX merchants_slug_unique ON revale.merchants USING btree (slug) WHERE (slug IS NOT NULL);

CREATE UNIQUE INDEX persons_auth_user_unique ON revale.persons USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX platform_users_auth_unique ON revale.platform_users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX platform_users_email_unique ON revale.platform_users USING btree (lower(email));

CREATE INDEX reversal_requests_merchant_status_idx ON revale.reversal_requests USING btree (merchant_id, status, created_at DESC);

CREATE UNIQUE INDEX reversal_requests_one_pending_per_tx ON revale.reversal_requests USING btree (transaction_id) WHERE (status = 'pending'::text);

CREATE INDEX settlement_adjustments_settlement_idx ON revale.settlement_adjustments USING btree (settlement_id, created_at);

CREATE UNIQUE INDEX settlement_adjustments_source_unique ON revale.settlement_adjustments USING btree (settlement_id, source_type, source_id, adjustment_type);

CREATE INDEX settlement_events_settlement_idx ON revale.settlement_events USING btree (settlement_id, created_at);

CREATE INDEX settlement_items_settlement_idx ON revale.settlement_items USING btree (settlement_id, id);

CREATE UNIQUE INDEX settlement_items_transaction_type_unique ON revale.settlement_items USING btree (transaction_id, item_type) WHERE (transaction_id IS NOT NULL);

CREATE INDEX settlement_payouts_status_idx ON revale.settlement_payouts USING btree (status, scheduled_at DESC);

CREATE INDEX settlement_reconciliations_status_idx ON revale.settlement_reconciliations USING btree (status, created_at);

CREATE INDEX settlements_merchant_status_idx ON revale.settlements USING btree (merchant_id, status, period_end DESC);

CREATE INDEX transactions_account_created_idx ON revale.transactions USING btree (account_id, created_at DESC) WHERE (account_id IS NOT NULL);

CREATE INDEX transactions_person_created_idx ON revale.transactions USING btree (person_id, created_at DESC) WHERE (person_id IS NOT NULL);

CREATE UNIQUE INDEX treasury_bank_accounts_primary_unique ON revale.treasury_bank_accounts USING btree (purpose, currency) WHERE ((active = true) AND (is_primary = true));

CREATE INDEX treasury_bank_accounts_purpose_idx ON revale.treasury_bank_accounts USING btree (purpose, active);

CREATE INDEX treasury_bank_balance_snapshots_latest_idx ON revale.treasury_bank_balance_snapshots USING btree (bank_account_id, as_of DESC);

CREATE UNIQUE INDEX treasury_internal_transfers_ref_unique ON revale.treasury_internal_transfers USING btree (bank_reference, bank_posted_on) WHERE (status = 'confirmed'::text);

CREATE UNIQUE INDEX uq_ledger_tx_type ON revale.ledger_entries USING btree (transaction_id, entry_type) WHERE (transaction_id IS NOT NULL);
$revale_ddl$;
END
$revale_migration$;

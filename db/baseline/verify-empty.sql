-- Read-only verification for a newly installed, unused ReVale baseline.
WITH app_counts AS (
SELECT 'accounting_events' AS table_name, count(*)::bigint AS rows FROM revale."accounting_events"
UNION ALL
SELECT 'admin_users' AS table_name, count(*)::bigint AS rows FROM revale."admin_users"
UNION ALL
SELECT 'audit_events' AS table_name, count(*)::bigint AS rows FROM revale."audit_events"
UNION ALL
SELECT 'bank_statement_entries' AS table_name, count(*)::bigint AS rows FROM revale."bank_statement_entries"
UNION ALL
SELECT 'bank_statement_imports' AS table_name, count(*)::bigint AS rows FROM revale."bank_statement_imports"
UNION ALL
SELECT 'benefit_accounts' AS table_name, count(*)::bigint AS rows FROM revale."benefit_accounts"
UNION ALL
SELECT 'benefit_allocations' AS table_name, count(*)::bigint AS rows FROM revale."benefit_allocations"
UNION ALL
SELECT 'benefit_programs' AS table_name, count(*)::bigint AS rows FROM revale."benefit_programs"
UNION ALL
SELECT 'benefit_rules' AS table_name, count(*)::bigint AS rows FROM revale."benefit_rules"
UNION ALL
SELECT 'cards' AS table_name, count(*)::bigint AS rows FROM revale."cards"
UNION ALL
SELECT 'employee_access_invites' AS table_name, count(*)::bigint AS rows FROM revale."employee_access_invites"
UNION ALL
SELECT 'employee_enrollments' AS table_name, count(*)::bigint AS rows FROM revale."employee_enrollments"
UNION ALL
SELECT 'employee_imports' AS table_name, count(*)::bigint AS rows FROM revale."employee_imports"
UNION ALL
SELECT 'employer_approval_policies' AS table_name, count(*)::bigint AS rows FROM revale."employer_approval_policies"
UNION ALL
SELECT 'employer_funding_approvals' AS table_name, count(*)::bigint AS rows FROM revale."employer_funding_approvals"
UNION ALL
SELECT 'employer_funding_decisions' AS table_name, count(*)::bigint AS rows FROM revale."employer_funding_decisions"
UNION ALL
SELECT 'employer_funding_receipts' AS table_name, count(*)::bigint AS rows FROM revale."employer_funding_receipts"
UNION ALL
SELECT 'employer_funding_refunds' AS table_name, count(*)::bigint AS rows FROM revale."employer_funding_refunds"
UNION ALL
SELECT 'employer_team_invites' AS table_name, count(*)::bigint AS rows FROM revale."employer_team_invites"
UNION ALL
SELECT 'employer_users' AS table_name, count(*)::bigint AS rows FROM revale."employer_users"
UNION ALL
SELECT 'employers' AS table_name, count(*)::bigint AS rows FROM revale."employers"
UNION ALL
SELECT 'financial_approval_decisions' AS table_name, count(*)::bigint AS rows FROM revale."financial_approval_decisions"
UNION ALL
SELECT 'financial_approval_policies' AS table_name, count(*)::bigint AS rows FROM revale."financial_approval_policies"
UNION ALL
SELECT 'financial_approval_requests' AS table_name, count(*)::bigint AS rows FROM revale."financial_approval_requests"
UNION ALL
SELECT 'financial_user_permissions' AS table_name, count(*)::bigint AS rows FROM revale."financial_user_permissions"
UNION ALL
SELECT 'funding_batch_items' AS table_name, count(*)::bigint AS rows FROM revale."funding_batch_items"
UNION ALL
SELECT 'funding_batches' AS table_name, count(*)::bigint AS rows FROM revale."funding_batches"
UNION ALL
SELECT 'gl_accounts' AS table_name, count(*)::bigint AS rows FROM revale."gl_accounts"
UNION ALL
SELECT 'gl_journal_lines' AS table_name, count(*)::bigint AS rows FROM revale."gl_journal_lines"
UNION ALL
SELECT 'gl_journals' AS table_name, count(*)::bigint AS rows FROM revale."gl_journals"
UNION ALL
SELECT 'idempotency_keys' AS table_name, count(*)::bigint AS rows FROM revale."idempotency_keys"
UNION ALL
SELECT 'invoices' AS table_name, count(*)::bigint AS rows FROM revale."invoices"
UNION ALL
SELECT 'ledger_entries' AS table_name, count(*)::bigint AS rows FROM revale."ledger_entries"
UNION ALL
SELECT 'merchant_bank_account_requests' AS table_name, count(*)::bigint AS rows FROM revale."merchant_bank_account_requests"
UNION ALL
SELECT 'merchant_bank_accounts' AS table_name, count(*)::bigint AS rows FROM revale."merchant_bank_accounts"
UNION ALL
SELECT 'merchant_fee_credit_notes' AS table_name, count(*)::bigint AS rows FROM revale."merchant_fee_credit_notes"
UNION ALL
SELECT 'merchant_fee_invoices' AS table_name, count(*)::bigint AS rows FROM revale."merchant_fee_invoices"
UNION ALL
SELECT 'merchant_location_requests' AS table_name, count(*)::bigint AS rows FROM revale."merchant_location_requests"
UNION ALL
SELECT 'merchant_locations' AS table_name, count(*)::bigint AS rows FROM revale."merchant_locations"
UNION ALL
SELECT 'merchant_terms' AS table_name, count(*)::bigint AS rows FROM revale."merchant_terms"
UNION ALL
SELECT 'merchant_users' AS table_name, count(*)::bigint AS rows FROM revale."merchant_users"
UNION ALL
SELECT 'merchant_withholdings' AS table_name, count(*)::bigint AS rows FROM revale."merchant_withholdings"
UNION ALL
SELECT 'merchants' AS table_name, count(*)::bigint AS rows FROM revale."merchants"
UNION ALL
SELECT 'persons' AS table_name, count(*)::bigint AS rows FROM revale."persons"
UNION ALL
SELECT 'platform_users' AS table_name, count(*)::bigint AS rows FROM revale."platform_users"
UNION ALL
SELECT 'reversal_requests' AS table_name, count(*)::bigint AS rows FROM revale."reversal_requests"
UNION ALL
SELECT 'safeguarding_settings' AS table_name, count(*)::bigint AS rows FROM revale."safeguarding_settings"
UNION ALL
SELECT 'settlement_adjustments' AS table_name, count(*)::bigint AS rows FROM revale."settlement_adjustments"
UNION ALL
SELECT 'settlement_events' AS table_name, count(*)::bigint AS rows FROM revale."settlement_events"
UNION ALL
SELECT 'settlement_items' AS table_name, count(*)::bigint AS rows FROM revale."settlement_items"
UNION ALL
SELECT 'settlement_payouts' AS table_name, count(*)::bigint AS rows FROM revale."settlement_payouts"
UNION ALL
SELECT 'settlement_reconciliations' AS table_name, count(*)::bigint AS rows FROM revale."settlement_reconciliations"
UNION ALL
SELECT 'settlements' AS table_name, count(*)::bigint AS rows FROM revale."settlements"
UNION ALL
SELECT 'transaction_events' AS table_name, count(*)::bigint AS rows FROM revale."transaction_events"
UNION ALL
SELECT 'transactions' AS table_name, count(*)::bigint AS rows FROM revale."transactions"
UNION ALL
SELECT 'treasury_bank_accounts' AS table_name, count(*)::bigint AS rows FROM revale."treasury_bank_accounts"
UNION ALL
SELECT 'treasury_bank_balance_snapshots' AS table_name, count(*)::bigint AS rows FROM revale."treasury_bank_balance_snapshots"
UNION ALL
SELECT 'treasury_internal_transfers' AS table_name, count(*)::bigint AS rows FROM revale."treasury_internal_transfers"
)
SELECT count(*)::integer AS application_tables, sum(rows)::bigint AS application_rows, (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema='revale') AS application_columns, (SELECT count(*)::integer FROM pg_indexes WHERE schemaname='revale') AS application_indexes, (SELECT count(*)::integer FROM pg_sequences WHERE schemaname='revale') AS application_sequences, (SELECT count(*)::integer FROM pg_sequences WHERE schemaname='revale' AND last_value IS NOT NULL) AS used_sequences, (SELECT count(*)::integer FROM pg_tables WHERE schemaname='neon_auth') AS auth_tables, (SELECT count(*)::integer FROM neon_auth."user") AS auth_users, (SELECT count(*)::integer FROM neon_auth.session) AS auth_sessions FROM app_counts;

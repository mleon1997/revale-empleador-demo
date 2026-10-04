# ReVale Architecture

## Product surfaces

ReVale is organized around four product surfaces:

- **Merchant / Comercios**: redemption, cashier operations, reversals, branches, users, settlements and payout account configuration.
- **Employer / Empresas**: benefit programs, funding, employee enrollment, allocations and reporting.
- **Employee / App**: balance, redemption, transaction history and benefit validity.
- **ReVale Admin**: merchant onboarding, branch approvals, bank verification, settlement operations and support.

## Current platform shape

The current stack is a modular-monolith target:

- Vercel for web/API runtime.
- Neon Postgres as the system of record.
- Server-side API domain logic in `api/` and `lib/`.
- Merchant portal under `public/comercios/`.
- Neon Auth is provisioned on the main branch; production RBAC integration is the next security milestone.

## Core domains

### Benefits
- employers
- benefit_programs
- employee_enrollments
- funding_batches
- employer_funding_receipts
- employer_funding_refunds
- benefit_allocations
- benefit_rules

### Redemption
- persons
- cards
- benefit_accounts
- transactions
- transaction_events
- ledger_entries
- reversal_requests

### Merchant
- merchants
- merchant_locations
- merchant_users
- merchant_terms
- merchant_location_requests
- merchant_bank_accounts
- merchant_bank_account_requests

### Settlement
- settlements
- settlement_items
- settlement_payouts
- settlement_adjustments
- settlement_reconciliations
- merchant_fee_invoices
- merchant_fee_credit_notes
- merchant_withholdings

### Treasury & safeguarding
- treasury_bank_accounts
- treasury_bank_balance_snapshots
- treasury_internal_transfers
- safeguarding_settings
- bank_statement_imports
- bank_statement_entries

### Financial approvals
- financial_user_permissions
- financial_approval_policies
- financial_approval_requests
- financial_approval_decisions

### Platform controls
- idempotency_keys
- audit_events

## Non-negotiable production rules

1. Merchant and location scope must come from the authenticated server-side session, never from client-supplied IDs.
2. Every externally callable money-moving action must be idempotent.
3. Benefit balances are derived from immutable financial entries; cached balances are performance aids, not the audit source of truth.
4. Closed settlements are immutable. Post-close changes become new adjustments.
5. Merchant commercial terms are effective-dated and server-side.
6. Administrative changes generate immutable audit events.
7. Bank account changes require ReVale verification before becoming payout destinations.
8. An employer funding request never creates employee balance. Bank cash receipt and benefit allocation are separate events.
9. Employer cash receipts are third-party funds: receipt posts to employer prefunding liability, allocation reclassifies that liability to employee benefit liability, and neither event recognizes revenue.
10. Benefit allocation cannot exceed confirmed cash net of refunds for the funding batch.
11. Unallocated employer cash remains a liability to the employer until allocated or refunded.
12. Merchant payout is constrained by the posted merchant payable ledger, not only by settlement arithmetic.
13. Paid settlements are not final until bank reconciliation reaches matched/reconciled status.
14. Issued fiscal documents are never overwritten; post-issue corrections use linked credit notes and immutable adjustments.
15. Every new employer bank receipt, employer refund and merchant payout must identify the ReVale treasury account used.
16. Safeguarding coverage compares physically reported/rolled-forward client-funds bank balances against positive third-party obligations without netting receivables across counterparties.
17. When safeguarding enforcement is enabled, merchant payouts and employer refunds are blocked unless bank balances are current and coverage is at least 100%.
18. Excess sweeps from segregated accounts are limited to the lower of physical bank excess and ledger-supported excess; top-ups move ReVale own cash into the client-funds account through double-entry accounting.
19. Bank statement imports retain normalized transaction fields and a file hash, not the original file or arbitrary raw bank columns.
20. Automatic reconciliation produces suggestions only. A Finance or Superadmin user must confirm a suggested or manually selected match before it can create/repair a funding receipt, payout posting, or settlement reconciliation.
21. A bank statement is evidence of what physically happened. If an already-executed payout is observed while safeguarding is below threshold, ReVale records the payment and emits a specific safeguarding override audit event instead of hiding the real bank movement.
22. Bank import idempotency is based on account, normalized bank fields and occurrence order so repeated legitimate movements with identical amount/date/descriptions are not collapsed.
23. Imported closing balances may anchor safeguarding only when Finance explicitly opts to use the mapped balance column.
24. Sensitive financial actions use maker-checker: the requester can never approve the same request, even when the user has both Maker and Approver permissions.
25. Approval requirements are policy-driven by action and amount. Defaults require one independent approval up to the configured threshold and two independent approvals above it.
26. Approvers may have a personal monetary approval limit in addition to action-level policy thresholds.
27. Funding allocation, merchant payout scheduling, employer refunds, safeguarding top-ups/sweeps and tax-withholding adjustments execute only after the required approvals are met.
28. Approval execution is idempotent and recoverable: a failed execution preserves approvals and can be retried without creating a duplicate money movement.
29. Bank evidence remains authoritative for movements already executed externally; reconciliation may repair posting state even when preventive approval/safeguarding controls would block a new future action.

## Immediate production backlog

1. Replace demo client auth with Neon Auth sessions and server-side RBAC.
2. Bind merchant_users to Neon Auth user IDs.
3. Add employer admin APIs and UI.
4. Persist settlement close jobs and payout lifecycle.
5. Expand ledger into a double-entry platform ledger.
6. Add structured logs, request IDs, rate limits, tests and operational alerts.

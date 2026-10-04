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

## Immediate production backlog

1. Replace demo client auth with Neon Auth sessions and server-side RBAC.
2. Bind merchant_users to Neon Auth user IDs.
3. Add employer admin APIs and UI.
4. Persist settlement close jobs and payout lifecycle.
5. Expand ledger into a double-entry platform ledger.
6. Add structured logs, request IDs, rate limits, tests and operational alerts.

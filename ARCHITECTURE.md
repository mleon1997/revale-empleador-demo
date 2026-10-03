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

## Immediate production backlog

1. Replace demo client auth with Neon Auth sessions and server-side RBAC.
2. Bind merchant_users to Neon Auth user IDs.
3. Add employer admin APIs and UI.
4. Persist settlement close jobs and payout lifecycle.
5. Expand ledger into a double-entry platform ledger.
6. Add structured logs, request IDs, rate limits, tests and operational alerts.

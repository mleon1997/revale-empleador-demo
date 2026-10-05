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
- Neon Auth sessions are connected to server-side principals for merchants, employers, employees, and ReVale Admin.
- Employer portal under `public/empresas/`, with company-scoped APIs in `api/employer.js` and workflows in `lib/revale-employer.js`.
- Employee portal under `public/empleados/`, served at `mi.revale.app`.
- Host-specific entry points reuse the same runtime and database; the employer root is served at `empresas.revale.app`.

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

### Company governance
- employer_users (personal roles, activation gate, approval limits and access versions)
- employer_team_invites
- employer_approval_policies
- employer_funding_approvals
- employer_funding_decisions

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

## Employer experience

The employer portal provides seven views: overview, employees, benefits, funding requests, internal approvals, consumption reports, and team/access management. It uses the existing employer identity and does not create a parallel ledger.

- Administration manages benefits, enrollment, company access and approval policy. HR manages benefits/enrollment and prepares funding requests. Finance prepares and approves funding requests. Administration also approves within its personal limit. Consultation is read-only. Requesters cannot approve their own requests, including through another membership with the same authenticated identity.
- Company administrators issue manually shared, single-use 72-hour activation links for HR, Finance, Consultation, or Administration. Invite-only users cannot use legacy email binding to bypass activation. The `/empresas/activar/` flow reuses verified Neon Auth sessions; passwords never enter employer records. Token hashes, attempt limits, expiring claims, rotation and membership revocation protect access. No automatic invitation email is sent.
- Membership and policy mutations revalidate the current company administrator inside Serializable transactions. Users cannot change their own permissions, pending invitation links expire after permission changes, and an activated administrator is retained. Suspended users lose access on the next authenticated request. Changes are version checked and audited.
- Every new company funding request requires one independent company approval up to a configurable threshold (initially USD 5,000), or two above it. The amount, program, reviewed roster signature, requester identity and policy version are saved atomically with the batch. Policy changes apply only to new requests. An approver must currently be active, hold Administration or Finance, and have a sufficient personal monetary limit. Previously recorded decisions remain part of the immutable decision history.
- The company inbox offers all pending requests, requests the signed-in user may decide, and history. Detail shows the exact roster/amounts, decision comments, remaining approvals and currently eligible people. A missing approver is explicit; the system never bypasses an approval because a company has only one administrator. Rejection and requester withdrawal are terminal and retain any bank receipts for ReVale to reconcile/refund.
- Every company scope originates in the authenticated employer principal; inactive companies cannot resolve a principal.
- A funding request atomically snapshots eligible employees, their accounts, and per-person amounts. A deterministic request ID and payload hash make retries idempotent. Requests do not post cash, benefit allocations, or employee ledger entries.
- Cash verification, maker-checker approval, and financial posting remain in the existing ReVale Admin workflows. Company approval is a separate prerequisite checked when requesting ReVale allocation approval and again inside the atomic credit statement. A changed amount/program/roster or missing decision blocks allocation even if cash is already verified. The legacy allocation helper delegates to the same gate; legacy item preparation cannot append to a company-reviewed roster. Existing batches without company approval records retain their prior financial workflow. Recording an actual bank receipt/refund remains possible independently of internal company approval.
- The overview deduplicates individual account balances by account ID, not by equal monetary values. Accounts associated with multiple employers are not exposed as an employer balance and are excluded from new employer funding requests until their account scope is resolved.
- HR and administration can preview and import up to 500 employees from a form, CSV, or Excel. Normalized identifiers, row-level validation, tenant checks, and a Serializable transaction prevent duplicate/partial onboarding. New accounts start at zero; importing never creates a funding batch or ledger entry.
- Import retries use a company-scoped request ID and payload hash. Existing matching enrollments are skipped without changing their data. An identity already outside the selected company/program requires operations review.
- Employee access and enrollment status are distinct. Employers can create or rotate a personal, single-use, 72-hour activation link. Only token hashes are stored; the token remains in the URL fragment and is submitted in a request body. Links are shared manually by the employer; no automatic invitation email is sent.
- The employee activation page at `mi.revale.app/activar/` uses Neon Auth for signup/signin and validates its resulting session before linking the invited identity. Employers never set or reset employee passwords. New invite-only accounts cannot be claimed by the legacy email-matching login flow. Claims expire, attempts are limited, and successful activation is audited.
- Recargas supports reviewed per-person amounts and explicit inclusion. Account and enrollment IDs are revalidated inside the Serializable request transaction. Repeating a batch retains its original amounts for currently eligible people and leaves new employees unchecked for explicit review. A repeat creates a new request; it does not reuse or edit the original batch.
- Funding progress distinguishes partial receipts, full receipts awaiting credit, partial credit, completed credit, cancellation, and legacy requests awaiting item preparation. Bank receipts/refunds and financial approvals continue to originate in ReVale Admin. Bank transfer details must be coordinated with ReVale until verified payment instructions are configured; the UI does not invent bank account details.
- HR may pause/reactivate an enrollment with a recorded reason. This does not delete history, reverse balances, or rewrite the roster of an existing funding request.
- Rule edits are validated, audited, and transactional. Clearing a monetary limit disables it. Branch restrictions and blocklists are preserved. Concurrent rule edits run under Serializable isolation.
- Consumption reports scope by transaction program and company, use Ecuador dates, retain reversed transactions, and expose invoice registration status. CSV exports are protected against spreadsheet formula injection.
- Employer demo presentation uses BOGÖ consistently with Andrea's demo; underlying financial identifiers and records are unchanged.

## Remaining product and operational work

1. Self-service employer onboarding, automatic invitation email delivery, and access recovery. Employee provisioning, company team management, and personal activation links are implemented; password recovery still uses the established operations process.
2. Automated allocation scheduling, expiry, and rollover execution. Configured frequency and policy are reference settings; they do not themselves trigger balance changes.
3. Complete benefit-scoped account support for people associated with multiple employers.
4. Source invoice document ingestion and secure document retrieval. The employer report currently exposes registration metadata and CSV consumption detail, not fiscal document downloads.
5. Expand structured operational logs, rate limits, production monitoring, and reconciliation automation without bypassing approval controls.

## Verification

`npm run test:employer` runs isolated Postgres tests for tenant isolation, equal-balance aggregation, permissions, funding idempotency/atomicity, monetary precision, CSV/Excel imports, zero-balance onboarding, employee/team activation tokens and upstream identity verification, versioned access/policies, independent company decisions, approval limits, revocation, immutable roster guards, enrollment changes, rule updates, and reporting. Allocation gate tests write only to disposable local fixtures; they never use production credentials or move real funds.

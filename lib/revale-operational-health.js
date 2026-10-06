// Counts only: suitable for restricted operational logs. Never include identities,
// balances, bank references, cookies, connection strings or SQL error text.
export async function operationalHealth(sql){
  const [checks]=await sql.query(`SELECT
    (SELECT COUNT(*)::int FROM revale.benefit_accounts WHERE balance<0) AS negative_balances,
    (SELECT COUNT(*)::int FROM (SELECT settlement_id FROM revale.settlement_payouts WHERE status IN ('scheduled','processing','paid') GROUP BY settlement_id HAVING COUNT(*)>1) x) AS duplicate_payouts,
    (SELECT COUNT(*)::int FROM (SELECT j.id FROM revale.gl_journals j LEFT JOIN revale.gl_journal_lines l ON l.journal_id=j.id WHERE j.status='posted' GROUP BY j.id HAVING COUNT(l.id)=0 OR COALESCE(SUM(l.debit-l.credit),0)<>0) x) AS unbalanced_journals,
    (SELECT COUNT(*)::int FROM revale.accounting_events WHERE status='error' OR (status='pending' AND created_at<now()-interval '5 minutes')) AS accounting_backlog,
    (SELECT COUNT(*)::int FROM revale.settlement_payouts p JOIN revale.settlements s ON s.id=p.settlement_id WHERE p.status='paid' AND (s.status NOT IN ('paid','reconciled') OR NOT EXISTS(SELECT 1 FROM revale.accounting_events e WHERE e.source_type='settlement' AND e.source_id=s.id AND e.event_key='paid' AND e.status='posted'))) AS unposted_payments,
    (SELECT COUNT(*)::int FROM revale.settlement_reconciliations WHERE status='mismatch') AS reconciliation_mismatches,
    (SELECT COUNT(*)::int FROM revale.financial_approval_requests WHERE status='executing' AND execution_started_at<now()-interval '5 minutes') AS stuck_approvals,
    (SELECT COUNT(*)::int FROM revale.treasury_bank_accounts a WHERE a.active=true AND a.purpose='client_funds' AND NOT EXISTS(SELECT 1 FROM revale.treasury_bank_balance_snapshots b WHERE b.bank_account_id=a.id AND b.as_of>=now()-make_interval(hours=>COALESCE((SELECT stale_after_hours FROM revale.safeguarding_settings WHERE id='default'),24)) AND b.as_of<=now()+interval '5 minutes')) AS stale_bank_balances
  `);
  return {ok:Object.values(checks).every(n=>Number(n)===0),checks};
}

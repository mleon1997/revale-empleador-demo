import { confirmFundingBatchAtomic } from './revale-admin-funding.js';
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadProgramRules(sql, programId) {
  return sql.query(
    `SELECT id, rule_type, rule_value, priority
     FROM revale.benefit_rules
     WHERE program_id = $1
       AND active = true
     ORDER BY priority ASC, id ASC`,
    [programId]
  );
}

export async function evaluateRedemptionRules(sql, {
  programId,
  personId,
  merchantId,
  locationId,
  amount
}) {
  const rules = await loadProgramRules(sql, programId);
  const applied = [];

  for (const rule of rules) {
    const value = rule.rule_value || {};
    let ok = true;
    let message = "";

    if (rule.rule_type === "max_transaction_amount") {
      const max = numberOrNull(value.amount);
      ok = max == null ? true : Number(amount) <= max;
      if (!ok) message = "El monto supera el máximo permitido por tu beneficio";
    } else if (rule.rule_type === "merchant_allowlist") {
      const ids = asArray(value.merchant_ids).map(String);
      ok = ids.length === 0 || ids.includes(String(merchantId));
      if (!ok) message = "Este comercio no está habilitado para tu beneficio";
    } else if (rule.rule_type === "merchant_blocklist") {
      const ids = asArray(value.merchant_ids).map(String);
      ok = !ids.includes(String(merchantId));
      if (!ok) message = "Este comercio no está habilitado para tu beneficio";
    } else if (rule.rule_type === "location_allowlist") {
      const ids = asArray(value.location_ids).map(String);
      ok = ids.length === 0 || ids.includes(String(locationId));
      if (!ok) message = "Esta sucursal no está habilitada para tu beneficio";
    } else if (rule.rule_type === "daily_limit") {
      const limit = numberOrNull(value.amount);
      if (limit != null) {
        const [row] = await sql.query(
          `SELECT COALESCE(SUM(amount),0)::float8 AS spent
           FROM revale.transactions
           WHERE program_id = $1
             AND person_id = $2
             AND status = 'approved'
             AND approved_at >= date_trunc('day', now())
             AND approved_at < date_trunc('day', now()) + interval '1 day'`,
          [programId, personId]
        );
        const spent = Number(row?.spent || 0);
        ok = spent + Number(amount) <= limit;
        if (!ok) message = "Alcanzaste el límite diario de tu beneficio";
      }
    }

    applied.push({
      id: rule.id,
      type: rule.rule_type,
      ok,
      message
    });

    if (!ok) {
      return { ok: false, message, rules: applied };
    }
  }

  return { ok: true, rules: applied };
}

export async function createFundingBatch(sql, {
  id,
  employerId,
  programId,
  externalReference,
  amount,
  currency = "USD",
  metadata = {}
}) {
  const [row] = await sql.query(
    `INSERT INTO revale.funding_batches (
       id, employer_id, program_id, external_reference, amount, currency, status, metadata
     )
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb)
     RETURNING *`,
    [
      id,
      employerId,
      programId,
      externalReference || null,
      amount,
      currency,
      JSON.stringify(metadata)
    ]
  );
  return row;
}

export async function prepareFundingItems(sql, {
  fundingBatchId,
  programId,
  amountPerEmployee
}) {
  return sql.query(
    `INSERT INTO revale.funding_batch_items (
       funding_batch_id, enrollment_id, account_id, amount
     )
     SELECT
       $1,
       ee.id,
       ba.id,
       $3
     FROM revale.employee_enrollments ee
     JOIN revale.cards c ON c.person_id = ee.person_id AND c.active = true
     JOIN revale.benefit_accounts ba ON ba.card_number = c.card_number
     WHERE ee.program_id = $2
       AND EXISTS(SELECT 1 FROM revale.funding_batches fb WHERE fb.id=$1 AND fb.program_id=$2 AND COALESCE(fb.metadata->>'company_approval_required','false')<>'true')
       AND ee.status = 'active'
       AND ee.starts_on <= CURRENT_DATE
       AND (ee.ends_on IS NULL OR ee.ends_on >= CURRENT_DATE)
     ON CONFLICT (funding_batch_id,enrollment_id) DO NOTHING
     RETURNING id, funding_batch_id, enrollment_id, account_id, amount::float8 AS amount, status`,
    [fundingBatchId, programId, amountPerEmployee]
  );
}

// Legacy callers share the verified-cash and company-approval gate used by Admin.
export async function confirmFundingBatch(sql, fundingBatchId) {
  return confirmFundingBatchAtomic(sql,fundingBatchId);
}

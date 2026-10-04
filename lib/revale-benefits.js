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
             AND status = 'approved'
             AND approved_at >= date_trunc('day', now())
             AND approved_at < date_trunc('day', now()) + interval '1 day'`,
          [programId]
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
       AND ee.status = 'active'
       AND ee.starts_on <= CURRENT_DATE
       AND (ee.ends_on IS NULL OR ee.ends_on >= CURRENT_DATE)
     ON CONFLICT (funding_batch_id,enrollment_id) DO NOTHING
     RETURNING id, funding_batch_id, enrollment_id, account_id, amount::float8 AS amount, status`,
    [fundingBatchId, programId, amountPerEmployee]
  );
}

export async function confirmFundingBatch(sql, fundingBatchId) {
  const [batch] = await sql.query(
    `SELECT id, employer_id, program_id, amount::float8 AS amount, currency, status
     FROM revale.funding_batches
     WHERE id=$1
     LIMIT 1`,
    [fundingBatchId]
  );
  if (!batch) return { code: "not_found" };
  if (batch.status === "allocated") return { code: "ok", idempotent: true, batch };
  if (batch.status === "cancelled") return { code: "invalid_status", status: batch.status };

  const [totals] = await sql.query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS total, COUNT(*)::int AS count
     FROM revale.funding_batch_items
     WHERE funding_batch_id=$1
       AND status='pending'`,
    [fundingBatchId]
  );

  if (!totals?.count) return { code: "no_items" };
  if (Number(totals.total) > Number(batch.amount) + 0.00001) {
    return { code: "insufficient_funding", required: totals.total, available: batch.amount };
  }

  await sql.query("BEGIN");
  try {
    const items = await sql.query(
      `SELECT id,enrollment_id,account_id,amount::float8 AS amount
       FROM revale.funding_batch_items
       WHERE funding_batch_id=$1 AND status='pending'
       ORDER BY id
       FOR UPDATE`,
      [fundingBatchId]
    );

    for (const item of items) {
      const [acct] = await sql.query(
        `UPDATE revale.benefit_accounts
         SET balance = balance + $1, updated_at=now()
         WHERE id=$2
         RETURNING balance::float8 AS balance_after`,
        [item.amount, item.account_id]
      );

      await sql.query(
        `INSERT INTO revale.benefit_allocations (
           program_id,enrollment_id,account_id,funding_batch_id,amount,effective_at,status,metadata
         )
         VALUES ($1,$2,$3,$4,$5,now(),'active','{"source":"funding_batch"}'::jsonb)`,
        [batch.program_id, item.enrollment_id, item.account_id, fundingBatchId, item.amount]
      );

      await sql.query(
        `INSERT INTO revale.ledger_entries (
           account_id,transaction_id,entry_type,amount,balance_after,description
         )
         VALUES ($1,NULL,'allocation',$2,$3,'Asignación de beneficio')`,
        [item.account_id, item.amount, acct.balance_after]
      );

      await sql.query(
        `UPDATE revale.funding_batch_items
         SET status='allocated',allocated_at=now()
         WHERE id=$1`,
        [item.id]
      );
    }

    await sql.query(
      `UPDATE revale.funding_batches
       SET status='allocated',received_at=COALESCE(received_at,now()),updated_at=now()
       WHERE id=$1`,
      [fundingBatchId]
    );

    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  }

  const [updated] = await sql.query(
    `SELECT id,status,amount::float8 AS amount,received_at
     FROM revale.funding_batches WHERE id=$1`,
    [fundingBatchId]
  );

  return { code: "ok", batch: updated };
}

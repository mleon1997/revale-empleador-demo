let sqlPromise;

export async function getSql() {
  if (sqlPromise) return sqlPromise;

  sqlPromise = (async () => {
    const { neon } = await import("@neondatabase/serverless");
    const url =
      process.env.REVALE_DB_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.REVALE_DB_URL ||
      process.env.STORAGE_URL;

    if (!url) throw new Error("DATABASE_URL_NOT_CONFIGURED");
    return neon(url);
  })();

  return sqlPromise;
}

export function transactionId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "RV-";
  for (let i = 0; i < 5; i++) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return value;
}

export function publicToken() {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)
  );
}

export async function getDemoAccount(sql) {
  const [row] = await sql`
    SELECT
      p.first_name,
      p.last_name,
      p.person_identification,
      c.card_number,
      ba.balance::float8 AS balance
    FROM revale.persons p
    JOIN revale.cards c ON c.person_id = p.id
    JOIN revale.benefit_accounts ba ON ba.card_number = c.card_number
    WHERE p.id = 'person_demo_andrea'
    LIMIT 1
  `;

  return row || null;
}

export async function createCharge(sql, amount, reference) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = transactionId();
    const token = publicToken();

    try {
      const [row] = await sql`
        INSERT INTO revale.transactions (
          id,
          external_transaction_id,
          transaction_type,
          merchant_id,
          location_id,
          amount,
          reference,
          observation,
          public_token,
          expires_at
        )
        VALUES (
          ${tx},
          ${tx},
          '04',
          'merchant_el_hornero',
          'location_el_hornero_cumbaya',
          ${amount},
          ${reference || tx},
          'Portal ReVale Nivel 1',
          ${token},
          now() + interval '5 minutes'
        )
        RETURNING
          id,
          public_token,
          amount::float8 AS amount,
          reference,
          status,
          extract(epoch from created_at) * 1000 AS created_at_ms,
          extract(epoch from expires_at) * 1000 AS expires_at_ms
      `;

      await sql`
        INSERT INTO revale.transaction_events (
          transaction_id,
          event_type,
          payload
        )
        VALUES (
          ${tx},
          'created',
          jsonb_build_object('channel','merchant_web','location','Cumbayá')
        )
      `;

      return {
        tx: row.id,
        token: row.public_token,
        amount: row.amount,
        reference: row.reference,
        status: row.status,
        createdAt: Number(row.created_at_ms),
        expiresAt: Number(row.expires_at_ms)
      };
    } catch (error) {
      if (String(error?.message || "").includes("duplicate key")) continue;
      throw error;
    }
  }

  throw new Error("TRANSACTION_ID_GENERATION_FAILED");
}

export async function getCharge(sql, tx, token) {
  let [row] = await sql`
    SELECT
      id,
      amount::float8 AS amount,
      reference,
      status,
      balance_before::float8 AS balance_before,
      balance_after::float8 AS balance_after,
      extract(epoch from created_at) * 1000 AS created_at_ms,
      extract(epoch from approved_at) * 1000 AS approved_at_ms,
      extract(epoch from expires_at) * 1000 AS expires_at_ms
    FROM revale.transactions
    WHERE id = ${tx}
      AND public_token = ${token}
    LIMIT 1
  `;

  if (!row) return null;

  if (row.status === "pending" && Number(row.expires_at_ms) <= Date.now()) {
    const [expired] = await sql`
      UPDATE revale.transactions
      SET status = 'expired'
      WHERE id = ${tx}
        AND public_token = ${token}
        AND status = 'pending'
        AND expires_at <= now()
      RETURNING id
    `;

    if (expired) {
      row.status = "expired";
      await sql`
        INSERT INTO revale.transaction_events (
          transaction_id,
          event_type,
          payload
        )
        VALUES (${tx}, 'expired', '{}'::jsonb)
      `;
    }
  }

  const employee = await getDemoAccount(sql);

  return {
    tx: row.id,
    amount: row.amount,
    reference: row.reference,
    status: row.status,
    createdAt: Number(row.created_at_ms),
    approvedAt: row.approved_at_ms ? Number(row.approved_at_ms) : null,
    expiresAt: Number(row.expires_at_ms),
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    currentBalance: employee?.balance ?? null,
    employee: employee
      ? {
          firstName: employee.first_name,
          lastName: employee.last_name,
          identification: employee.person_identification
        }
      : null
  };
}

export async function confirmCharge(sql, tx, token) {
  const rows = await sql`
    WITH target AS (
      SELECT id, amount
      FROM revale.transactions
      WHERE id = ${tx}
        AND public_token = ${token}
        AND status = 'pending'
        AND expires_at > now()
    ),
    debit AS (
      UPDATE revale.benefit_accounts AS account
      SET
        balance = account.balance - target.amount,
        updated_at = now()
      FROM target
      WHERE account.id = 'acct_demo_andrea'
        AND account.balance >= target.amount
      RETURNING
        target.id AS transaction_id,
        target.amount,
        (account.balance + target.amount)::float8 AS balance_before,
        account.balance::float8 AS balance_after
    ),
    approved AS (
      UPDATE revale.transactions AS tr
      SET
        status = 'approved',
        card_number = 'RV-DEMO-0001',
        approved_at = now(),
        balance_before = debit.balance_before,
        balance_after = debit.balance_after
      FROM debit
      WHERE tr.id = debit.transaction_id
      RETURNING
        tr.id,
        tr.amount::float8 AS amount,
        tr.balance_before::float8 AS balance_before,
        tr.balance_after::float8 AS balance_after
    ),
    ledger AS (
      INSERT INTO revale.ledger_entries (
        account_id,
        transaction_id,
        entry_type,
        amount,
        balance_after,
        description
      )
      SELECT
        'acct_demo_andrea',
        approved.id,
        'consumption',
        -approved.amount,
        approved.balance_after,
        'Consumo ReVale - El Hornero Cumbayá'
      FROM approved
      ON CONFLICT DO NOTHING
      RETURNING id
    ),
    event AS (
      INSERT INTO revale.transaction_events (
        transaction_id,
        event_type,
        payload
      )
      SELECT
        approved.id,
        'approved',
        jsonb_build_object(
          'card_number','RV-DEMO-0001',
          'balance_before',approved.balance_before,
          'balance_after',approved.balance_after
        )
      FROM approved
      RETURNING id
    ),
    invoice AS (
      INSERT INTO revale.invoices (
        transaction_id,
        email_alias
      )
      SELECT
        approved.id,
        'factura+' || lower(approved.id) || '@revale.app'
      FROM approved
      ON CONFLICT (transaction_id) DO NOTHING
      RETURNING id
    )
    SELECT * FROM approved
  `;

  if (rows[0]) {
    return {
      code: "ok",
      status: "approved",
      balanceBefore: rows[0].balance_before,
      balanceAfter: rows[0].balance_after
    };
  }

  const [existing] = await sql`
    SELECT
      status,
      balance_before::float8 AS balance_before,
      balance_after::float8 AS balance_after,
      extract(epoch from expires_at) * 1000 AS expires_at_ms
    FROM revale.transactions
    WHERE id = ${tx}
      AND public_token = ${token}
    LIMIT 1
  `;

  if (!existing) return { code: "not_found" };

  if (existing.status === "approved") {
    return {
      code: "ok",
      status: "approved",
      balanceBefore: existing.balance_before,
      balanceAfter: existing.balance_after
    };
  }

  if (
    existing.status === "pending" &&
    Number(existing.expires_at_ms) <= Date.now()
  ) {
    await sql`
      UPDATE revale.transactions
      SET status = 'expired'
      WHERE id = ${tx}
        AND status = 'pending'
    `;
    return { code: "expired" };
  }

  const account = await getDemoAccount(sql);

  if (
    existing.status === "pending" &&
    account &&
    Number(account.balance) < 0.01
  ) {
    return { code: "insufficient_balance" };
  }

  if (
    existing.status === "pending" &&
    account
  ) {
    const [charge] = await sql`
      SELECT amount::float8 AS amount
      FROM revale.transactions
      WHERE id = ${tx}
    `;

    if (charge && Number(account.balance) < Number(charge.amount)) {
      await sql`
        UPDATE revale.transactions
        SET status = 'declined'
        WHERE id = ${tx}
          AND status = 'pending'
      `;

      await sql`
        INSERT INTO revale.transaction_events (
          transaction_id,
          event_type,
          payload
        )
        VALUES (
          ${tx},
          'declined',
          jsonb_build_object(
            'error_code','RVL-007',
            'reason','insufficient_balance'
          )
        )
      `;

      return { code: "insufficient_balance" };
    }
  }

  return { code: existing.status };
}

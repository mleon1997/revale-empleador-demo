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

export async function createCharge(sql, amount, reference, merchantId = "merchant_el_hornero", locationId = "location_el_hornero_cumbaya") {
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
          ${merchantId},
          ${locationId},
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
          jsonb_build_object('channel','merchant_web','merchant_id',${merchantId}::text,'location_id',${locationId}::text)
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
      tr.id,
      tr.amount::float8 AS amount,
      tr.reference,
      tr.status,
      tr.balance_before::float8 AS balance_before,
      tr.balance_after::float8 AS balance_after,
      tr.merchant_id,
      tr.location_id,
      m.name AS merchant_name,
      m.logo_url,
      m.brand_primary,
      ml.name AS location_name,
      extract(epoch from tr.created_at) * 1000 AS created_at_ms,
      extract(epoch from tr.approved_at) * 1000 AS approved_at_ms,
      extract(epoch from tr.expires_at) * 1000 AS expires_at_ms
    FROM revale.transactions tr
    JOIN revale.merchants m ON m.id = tr.merchant_id
    JOIN revale.merchant_locations ml ON ml.id = tr.location_id
    WHERE tr.id = ${tx}
      AND tr.public_token = ${token}
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
    merchant: {
      id: row.merchant_id,
      name: row.merchant_name,
      locationId: row.location_id,
      locationName: row.location_name,
      logoUrl: row.logo_url || null,
      brandPrimary: row.brand_primary || null
    },
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
      SELECT tr.id, tr.amount, m.name AS merchant_name, ml.name AS location_name
      FROM revale.transactions tr
      JOIN revale.merchants m ON m.id = tr.merchant_id
      JOIN revale.merchant_locations ml ON ml.id = tr.location_id
      WHERE tr.id = ${tx}
        AND tr.public_token = ${token}
        AND tr.status = 'pending'
        AND tr.expires_at > now()
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
        target.merchant_name,
        target.location_name,
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
        tr.balance_after::float8 AS balance_after,
        debit.merchant_name,
        debit.location_name
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
        'Consumo ReVale - ' || approved.merchant_name || ' · ' || approved.location_name
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


export async function listMerchantTransactions(sql, limit = 50, merchantId = "merchant_el_hornero", locationId = null) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));

  const rows = await sql.query(
    `SELECT
       tr.id,
       tr.external_transaction_id,
       tr.transaction_type,
       tr.merchant_id,
       tr.location_id,
       ml.name AS location_name,
       tr.amount::float8 AS amount,
       tr.reference,
       tr.status,
       tr.created_at,
       tr.approved_at,
       tr.reversed_at,
       tr.balance_before::float8 AS balance_before,
       tr.balance_after::float8 AS balance_after,
       inv.status AS invoice_status,
       inv.email_alias
     FROM revale.transactions tr
     JOIN revale.merchant_locations ml ON ml.id = tr.location_id
     LEFT JOIN revale.invoices inv ON inv.transaction_id = tr.id
     WHERE tr.merchant_id = $2
       AND ($3::text IS NULL OR tr.location_id = $3)
     ORDER BY tr.created_at DESC
     LIMIT $1`,
    [safeLimit, merchantId, locationId]
  );

  return rows;
}

export async function reverseCharge(sql, tx) {
  const rows = await sql`
    WITH target AS (
      SELECT tr.id, tr.amount, m.name AS merchant_name, ml.name AS location_name
      FROM revale.transactions tr
      JOIN revale.merchants m ON m.id = tr.merchant_id
      JOIN revale.merchant_locations ml ON ml.id = tr.location_id
      WHERE tr.id = ${tx}
        AND tr.status = 'approved'
        AND tr.card_number = 'RV-DEMO-0001'
    ),
    credit AS (
      UPDATE revale.benefit_accounts AS account
      SET
        balance = account.balance + target.amount,
        updated_at = now()
      FROM target
      WHERE account.id = 'acct_demo_andrea'
      RETURNING
        target.id AS transaction_id,
        target.amount::float8 AS amount,
        target.merchant_name,
        target.location_name,
        account.balance::float8 AS new_balance
    ),
    reversed AS (
      UPDATE revale.transactions AS tr
      SET
        status = 'reversed',
        reversed_at = now()
      FROM credit
      WHERE tr.id = credit.transaction_id
      RETURNING
        tr.id,
        tr.amount::float8 AS amount,
        credit.new_balance,
        credit.merchant_name,
        credit.location_name
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
        reversed.id,
        'reversal',
        reversed.amount,
        reversed.new_balance,
        'Reverso ReVale - ' || reversed.merchant_name || ' · ' || reversed.location_name
      FROM reversed
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
        reversed.id,
        'reversed',
        jsonb_build_object(
          'transaction_type','05',
          'balance_after',reversed.new_balance
        )
      FROM reversed
      RETURNING id
    )
    SELECT * FROM reversed
  `;

  if (rows[0]) {
    return {
      code: "ok",
      transactionType: "05",
      tx: rows[0].id,
      amount: rows[0].amount,
      newBalance: rows[0].new_balance
    };
  }

  const [existing] = await sql`
    SELECT
      tr.status,
      tr.amount::float8 AS amount,
      ba.balance::float8 AS current_balance
    FROM revale.transactions tr
    LEFT JOIN revale.benefit_accounts ba
      ON ba.id = 'acct_demo_andrea'
    WHERE tr.id = ${tx}
    LIMIT 1
  `;

  if (!existing) return { code: "not_found" };

  if (existing.status === "reversed") {
    return {
      code: "ok",
      transactionType: "05",
      tx,
      amount: existing.amount,
      newBalance: existing.current_balance,
      idempotent: true
    };
  }

  return { code: "invalid_status", status: existing.status };
}

export async function matchInvoice(sql, tx) {
  const rows = await sql`
    WITH eligible AS (
      SELECT id
      FROM revale.transactions
      WHERE id = ${tx}
        AND status = 'approved'
    ),
    matched AS (
      UPDATE revale.invoices AS inv
      SET
        status = 'matched',
        received_at = COALESCE(inv.received_at, now()),
        matched_at = now()
      FROM eligible
      WHERE inv.transaction_id = eligible.id
      RETURNING inv.transaction_id, inv.status, inv.email_alias, inv.matched_at
    ),
    event AS (
      INSERT INTO revale.transaction_events (
        transaction_id,
        event_type,
        payload
      )
      SELECT
        matched.transaction_id,
        'invoice_matched',
        jsonb_build_object('email_alias', matched.email_alias)
      FROM matched
      RETURNING id
    )
    SELECT * FROM matched
  `;

  if (rows[0]) {
    return {
      code: "ok",
      tx: rows[0].transaction_id,
      status: rows[0].status,
      emailAlias: rows[0].email_alias,
      matchedAt: rows[0].matched_at
    };
  }

  const [existing] = await sql`
    SELECT
      tr.status AS transaction_status,
      inv.status AS invoice_status
    FROM revale.transactions tr
    LEFT JOIN revale.invoices inv ON inv.transaction_id = tr.id
    WHERE tr.id = ${tx}
    LIMIT 1
  `;

  if (!existing) return { code: "not_found" };
  if (existing.invoice_status === "matched") {
    return { code: "ok", tx, status: "matched", idempotent: true };
  }

  return {
    code: "invalid_status",
    transactionStatus: existing.transaction_status,
    invoiceStatus: existing.invoice_status
  };
}

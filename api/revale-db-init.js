export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST required" });
  }

  try {
    const { neon } = await import("@neondatabase/serverless");
    const url =
      process.env.REVALE_DB_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.REVALE_DB_URL ||
      process.env.STORAGE_URL;

    if (!url) {
      return res.status(500).json({ ok: false, error: "database_url_not_found" });
    }

    const sql = neon(url);

    const ddl = [
      "CREATE SCHEMA IF NOT EXISTS revale",
      `CREATE TABLE IF NOT EXISTS revale.merchants (
        id text PRIMARY KEY,
        name text NOT NULL,
        tax_id text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revale.merchant_locations (
        id text PRIMARY KEY,
        merchant_id text NOT NULL REFERENCES revale.merchants(id),
        name text NOT NULL,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revale.merchant_users (
        id text PRIMARY KEY,
        merchant_id text NOT NULL REFERENCES revale.merchants(id),
        location_id text REFERENCES revale.merchant_locations(id),
        display_name text NOT NULL,
        role text NOT NULL DEFAULT 'cashier',
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revale.persons (
        id text PRIMARY KEY,
        person_identification text NOT NULL UNIQUE,
        first_name text NOT NULL,
        last_name text NOT NULL,
        email text,
        mobile_phone text,
        company_identification text NOT NULL,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revale.cards (
        card_number text PRIMARY KEY,
        person_id text NOT NULL REFERENCES revale.persons(id),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revale.benefit_accounts (
        id text PRIMARY KEY,
        card_number text NOT NULL UNIQUE REFERENCES revale.cards(card_number),
        currency char(3) NOT NULL DEFAULT 'USD',
        balance numeric(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revale.transactions (
        id text PRIMARY KEY,
        external_transaction_id text NOT NULL UNIQUE,
        transaction_type char(2) NOT NULL DEFAULT '04',
        card_number text REFERENCES revale.cards(card_number),
        merchant_id text NOT NULL REFERENCES revale.merchants(id),
        location_id text NOT NULL REFERENCES revale.merchant_locations(id),
        transaction_date date NOT NULL DEFAULT current_date,
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        reference text NOT NULL,
        observation text,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','declined','expired','reversed')),
        public_token text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        balance_before numeric(14,2),
        balance_after numeric(14,2),
        created_at timestamptz NOT NULL DEFAULT now(),
        approved_at timestamptz,
        reversed_at timestamptz
      )`,
      "CREATE INDEX IF NOT EXISTS idx_transactions_status_created ON revale.transactions(status, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_transactions_card_created ON revale.transactions(card_number, created_at DESC)",
      `CREATE TABLE IF NOT EXISTS revale.ledger_entries (
        id bigserial PRIMARY KEY,
        account_id text NOT NULL REFERENCES revale.benefit_accounts(id),
        transaction_id text REFERENCES revale.transactions(id),
        entry_type text NOT NULL CHECK (entry_type IN ('allocation','consumption','reversal','adjustment')),
        amount numeric(14,2) NOT NULL,
        balance_after numeric(14,2) NOT NULL,
        description text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_tx_type ON revale.ledger_entries(transaction_id, entry_type) WHERE transaction_id IS NOT NULL",
      `CREATE TABLE IF NOT EXISTS revale.transaction_events (
        id bigserial PRIMARY KEY,
        transaction_id text NOT NULL REFERENCES revale.transactions(id),
        event_type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      "CREATE INDEX IF NOT EXISTS idx_transaction_events_tx ON revale.transaction_events(transaction_id, created_at)",
      `CREATE TABLE IF NOT EXISTS revale.invoices (
        id bigserial PRIMARY KEY,
        transaction_id text NOT NULL UNIQUE REFERENCES revale.transactions(id),
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','received','matched','rejected')),
        email_alias text NOT NULL UNIQUE,
        sri_access_key text,
        xml_location text,
        pdf_location text,
        received_at timestamptz,
        matched_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    ];

    for (const statement of ddl) {
      await sql.query(statement);
    }

    await sql.transaction([
      sql`INSERT INTO revale.merchants (id, name)
          VALUES ('merchant_el_hornero', 'El Hornero')
          ON CONFLICT (id) DO NOTHING`,
      sql`INSERT INTO revale.merchant_locations (id, merchant_id, name)
          VALUES ('location_el_hornero_cumbaya', 'merchant_el_hornero', 'Cumbayá')
          ON CONFLICT (id) DO NOTHING`,
      sql`INSERT INTO revale.merchant_users (id, merchant_id, location_id, display_name, role)
          VALUES ('cashier_demo_01', 'merchant_el_hornero', 'location_el_hornero_cumbaya', 'Caja 01', 'cashier')
          ON CONFLICT (id) DO NOTHING`,
      sql`INSERT INTO revale.persons (
            id, person_identification, first_name, last_name, email,
            mobile_phone, company_identification
          )
          VALUES (
            'person_demo_andrea', '1712345623', 'Andrea', 'Martínez',
            'andrea.demo@revale.app', '0990000000', '1799999999001'
          )
          ON CONFLICT (id) DO NOTHING`,
      sql`INSERT INTO revale.cards (card_number, person_id)
          VALUES ('RV-DEMO-0001', 'person_demo_andrea')
          ON CONFLICT (card_number) DO NOTHING`,
      sql`INSERT INTO revale.benefit_accounts (id, card_number, balance)
          VALUES ('acct_demo_andrea', 'RV-DEMO-0001', 143.20)
          ON CONFLICT (id) DO NOTHING`
    ]);

    const [existingAllocation] = await sql`
      SELECT id
      FROM revale.ledger_entries
      WHERE account_id = 'acct_demo_andrea'
        AND entry_type = 'allocation'
        AND transaction_id IS NULL
      LIMIT 1
    `;

    if (!existingAllocation) {
      const [account] = await sql`
        SELECT balance::float8 AS balance
        FROM revale.benefit_accounts
        WHERE id = 'acct_demo_andrea'
      `;

      await sql`
        INSERT INTO revale.ledger_entries (
          account_id, transaction_id, entry_type, amount, balance_after, description
        )
        VALUES (
          'acct_demo_andrea', NULL, 'allocation', 143.20,
          ${Number(account?.balance || 143.2)}, 'Saldo inicial demo'
        )
      `;
    }

    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'revale'
      ORDER BY table_name
    `;

    const [demo] = await sql`
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
    `;

    return res.status(200).json({
      ok: true,
      schema: "revale",
      tables: tables.map((x) => x.table_name),
      demo
    });
  } catch (error) {
    console.error("ReVale DB init error", error);
    return res.status(500).json({
      ok: false,
      error: "database_initialization_failed"
    });
  }
}

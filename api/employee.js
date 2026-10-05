import { getSql } from "../lib/revale-db.js";
import { getEmployeePrincipal } from "../lib/revale-auth.js";
import { loadProgramRules } from "../lib/revale-benefits.js";

function json(res, status, body) {
  return res.status(status).setHeader("Content-Type", "application/json; charset=utf-8")
    .setHeader("Cache-Control", "private, no-store").json(body);
}

// Account and person scope always originate in the authenticated session.
async function activity(sql, personId, offset = 0) {
  const rows = await sql.query(
    `SELECT le.id::text, le.entry_type, le.amount::float8 AS amount,
       le.balance_after::float8 AS balance_after, le.description, le.created_at,
       tr.id AS transaction_id, tr.status AS transaction_status,
       tr.reference, tr.approved_at, tr.reversed_at,
       m.name AS merchant_name, m.logo_url, ml.name AS location_name,
       inv.status AS invoice_status
     FROM revale.ledger_entries le
     JOIN revale.benefit_accounts ba ON ba.id=le.account_id
     JOIN revale.cards c ON c.card_number=ba.card_number
     LEFT JOIN revale.transactions tr ON tr.id=le.transaction_id
     LEFT JOIN revale.merchants m ON m.id=tr.merchant_id
     LEFT JOIN revale.merchant_locations ml ON ml.id=tr.location_id
     LEFT JOIN LATERAL (
       SELECT i.status FROM revale.invoices i WHERE i.transaction_id=tr.id LIMIT 1
     ) inv ON true
     WHERE c.person_id=$1 AND (tr.person_id IS NULL OR tr.person_id=$1)
     ORDER BY le.created_at DESC, le.id DESC LIMIT 31 OFFSET $2::int`,
    [personId, offset]
  );
  return { items: rows.slice(0, 30), hasMore: rows.length > 30, nextOffset: offset + Math.min(rows.length, 30) };
}

export function merchantAllowed(rules, merchantId, locationId) {
  return rules.every(({ rule_type: type, rule_value: value = {} }) => {
    const merchantIds = Array.isArray(value?.merchant_ids) ? value.merchant_ids.map(String) : [];
    const locationIds = Array.isArray(value?.location_ids) ? value.location_ids.map(String) : [];
    if (type === "merchant_allowlist") return !merchantIds.length || merchantIds.includes(String(merchantId));
    if (type === "merchant_blocklist") return !merchantIds.includes(String(merchantId));
    if (type === "location_allowlist") return !locationIds.length || locationIds.includes(String(locationId));
    return true;
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "Método no permitido" });
  const action = String(req.query?.action || "dashboard");
  if (!["dashboard", "activity"].includes(action)) return json(res, 400, { ok: false, error: "Acción no válida" });
  try {
    const sql = await getSql();
    const principal = await getEmployeePrincipal(sql, req);
    if (!principal) return json(res, 401, { ok: false, error: "Inicia sesión para ver tus beneficios" });
    if (action === "activity") {
      const offset = Math.min(10000, Math.max(0, Math.floor(Number(req.query?.offset) || 0)));
      return json(res, 200, { ok: true, activity: await activity(sql, principal.personId, offset) });
    }

    const programId = principal.benefit?.program_id || null;
    const [programRows, rules, locations, history, summaryRows] = await Promise.all([
      programId ? sql.query(
        `SELECT bp.name, bp.benefit_type, bp.currency,
           bp.allocation_amount::float8 AS allocation_amount, bp.allocation_frequency,
           bp.rollover_policy, bp.valid_until::text, e.name AS employer_name
         FROM revale.benefit_programs bp JOIN revale.employers e ON e.id=bp.employer_id
         WHERE bp.id=$1`, [programId]
      ) : [],
      programId ? loadProgramRules(sql, programId) : [],
      programId ? sql.query(
        `SELECT m.id AS merchant_id, m.name AS merchant_name, m.slug, m.logo_url,
           m.brand_primary, ml.id AS location_id, ml.name AS location_name
         FROM revale.merchants m JOIN revale.merchant_locations ml ON ml.merchant_id=m.id
         WHERE m.active=true AND ml.active=true ORDER BY m.name,ml.name`
      ) : [],
      activity(sql, principal.personId),
      sql.query(
        `SELECT COALESCE(SUM(-le.amount) FILTER (WHERE le.entry_type='consumption'),0)::float8 AS spent,
           COALESCE(SUM(le.amount) FILTER (WHERE le.entry_type='reversal'),0)::float8 AS returned,
           COALESCE(SUM(le.amount) FILTER (WHERE le.amount>0 AND le.entry_type<>'reversal'),0)::float8 AS credited,
           COUNT(*) FILTER (WHERE le.entry_type='consumption')::int AS purchases
         FROM revale.ledger_entries le
         JOIN revale.benefit_accounts ba ON ba.id=le.account_id
         JOIN revale.cards c ON c.card_number=ba.card_number
         WHERE c.person_id=$1
           AND le.created_at >= (date_trunc('month',now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil')`,
        [principal.personId]
      )
    ]);

    const merchants = new Map();
    for (const row of locations) {
      if (!merchantAllowed(rules, row.merchant_id, row.location_id)) continue;
      if (!merchants.has(row.merchant_id)) merchants.set(row.merchant_id, {
        id: row.merchant_id, name: row.merchant_name, slug: row.slug,
        logoUrl: row.logo_url, brandPrimary: row.brand_primary, locations: []
      });
      merchants.get(row.merchant_id).locations.push({ id: row.location_id, name: row.location_name });
    }
    return json(res, 200, {
      ok: true,
      profile: { firstName: principal.firstName, lastName: principal.lastName, email: principal.email,
        identification: principal.identification,
        demo: principal.personId === "person_demo_andrea" && principal.email === "andrea.demo@revale.app" },
      benefit: principal.benefit ? { ...programRows[0], balance: principal.benefit.balance,
        startsOn: principal.benefit.starts_on, endsOn: principal.benefit.ends_on,
        cardLast4: String(principal.benefit.card_number).slice(-4) } : null,
      rules: rules.filter(r => ["daily_limit", "max_transaction_amount"].includes(r.rule_type))
        .map(r => ({ type: r.rule_type, amount: Number(r.rule_value?.amount) })),
      merchants: [...merchants.values()], activity: history,
      summary: { ...summaryRows[0], month: new Intl.DateTimeFormat("es-EC", { month: "long", timeZone: "America/Guayaquil" }).format(new Date()) },
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("ReVale employee portal error", error);
    return json(res, 500, { ok: false, error: "No pudimos cargar tus beneficios. Intenta nuevamente." });
  }
}

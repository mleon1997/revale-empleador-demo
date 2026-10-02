import {
  getSql,
  getDemoAccount,
  createCharge,
  getCharge,
  confirmCharge
} from "../lib/revale-db.js";

function json(res, code, body) {
  res
    .status(code)
    .setHeader("Content-Type", "application/json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .json(body);
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || "";

  try {
    const sql = await getSql();

    if (req.method === "GET" && action === "health") {
      const [db] = await sql`
        SELECT current_database() AS database_name, now() AS server_time
      `;
      const demo = await getDemoAccount(sql);

      return json(res, 200, {
        ok: true,
        storage: "neon-postgres",
        schema: "revale",
        database: db?.database_name,
        serverTime: db?.server_time,
        demoBalance: demo?.balance ?? null
      });
    }

    if (req.method === "GET" && action === "persons") {
      const rows = await sql`
        SELECT
          c.card_number AS revale_card,
          p.person_identification,
          p.first_name,
          p.last_name,
          p.email,
          p.mobile_phone,
          p.company_identification
        FROM revale.persons p
        JOIN revale.cards c ON c.person_id = p.id
        WHERE p.active = true AND c.active = true
        ORDER BY p.first_name, p.last_name
      `;

      return json(res, 200, {
        message: "RVL-000",
        response: {
          status: "success",
          error_code: "RVL-000",
          error_message: "Query completed successfully",
          data: { persons: rows }
        }
      });
    }

    if (req.method === "GET" && action === "balance") {
      const card = String(req.query?.card_number || "RV-DEMO-0001");
      const [row] = await sql`
        SELECT
          card_number,
          balance::float8 AS balance
        FROM revale.benefit_accounts
        WHERE card_number = ${card}
        LIMIT 1
      `;

      if (!row) {
        return json(res, 404, {
          message: "RVL-005",
          response: {
            status: "error",
            error_code: "RVL-005",
            error_message: "Card not found"
          }
        });
      }

      return json(res, 200, {
        message: "RVL-000",
        response: {
          status: "success",
          error_code: "RVL-000",
          error_message: "Query completed successfully",
          data: row
        }
      });
    }

    if (req.method === "POST" && action === "create") {
      const amount = Number(req.body?.amount || 0);
      const reference = String(req.body?.reference || "").slice(0, 80);

      if (!Number.isFinite(amount) || amount <= 0 || amount > 500) {
        return json(res, 400, {
          message: "RVL-010",
          error: "Monto inválido"
        });
      }

      const row = await createCharge(
        sql,
        Math.round(amount * 100) / 100,
        reference
      );

      return json(res, 200, row);
    }

    if (
      req.method === "GET" &&
      (action === "get" || action === "status")
    ) {
      const tx = String(req.query?.tx || "");
      const token = String(req.query?.token || "");
      const row = await getCharge(sql, tx, token);

      if (!row) {
        return json(res, 404, {
          message: "RVL-005",
          error: "Transacción no encontrada"
        });
      }

      return json(res, 200, row);
    }

    if (req.method === "POST" && action === "confirm") {
      const tx = String(req.body?.tx || "");
      const token = String(req.body?.token || "");
      const result = await confirmCharge(sql, tx, token);

      if (result.code === "not_found") {
        return json(res, 404, {
          message: "RVL-005",
          error: "Transacción no encontrada"
        });
      }

      if (result.code === "expired") {
        return json(res, 410, {
          message: "RVL-015",
          error: "QR expirado"
        });
      }

      if (result.code === "insufficient_balance") {
        return json(res, 409, {
          message: "RVL-007",
          error: "Saldo insuficiente"
        });
      }

      if (result.code !== "ok") {
        return json(res, 409, {
          message: "RVL-013",
          error: "La transacción no puede confirmarse",
          status: result.code
        });
      }

      return json(res, 200, {
        ok: true,
        message: "RVL-000",
        status: result.status,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter
      });
    }

    return json(res, 405, {
      message: "RVL-009",
      error: "Acción no soportada"
    });
  } catch (error) {
    console.error("ReVale API error", error);
    return json(res, 500, {
      message: "RVL-013",
      error: "Error interno del servicio"
    });
  }
}

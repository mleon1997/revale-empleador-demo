import {
  getSql,
  getDemoAccount,
  createCharge,
  getCharge,
  confirmCharge,
  listMerchantTransactions,
  reverseCharge,
  matchInvoice
} from "../lib/revale-db.js";


async function getMerchantConfig(sql, slug = "el-hornero") {
  const [merchant] = await sql`
    SELECT
      id,
      name,
      slug,
      logo_url,
      brand_primary,
      brand_secondary,
      metadata
    FROM revale.merchants
    WHERE slug = ${slug}
      AND active = true
    LIMIT 1
  `;

  if (!merchant) return null;

  const locations = await sql`
    SELECT
      id,
      name,
      slug,
      metadata
    FROM revale.merchant_locations
    WHERE merchant_id = ${merchant.id}
      AND active = true
    ORDER BY name
  `;

  return {
    id: merchant.id,
    name: merchant.name,
    slug: merchant.slug,
    logoUrl: merchant.logo_url || null,
    brandPrimary: merchant.brand_primary || "#51C878",
    brandSecondary: merchant.brand_secondary || "#29294B",
    shortName: merchant.metadata?.short_name || merchant.name,
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      slug: location.slug,
      terminal: location.metadata?.demo_terminal || "Caja 01"
    }))
  };
}

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

    if (req.method === "GET" && action === "merchant-config") {
      const slug = String(req.query?.merchant || "el-hornero");
      const config = await getMerchantConfig(sql, slug);
      if (!config) return json(res, 404, { ok: false, error: "Comercio no encontrado" });
      return json(res, 200, { ok: true, merchant: config });
    }

    if (req.method === "GET" && action === "branch-requests") {
      const merchantId = String(req.query?.merchant_id || "merchant_el_hornero");
      const rows = await sql`
        SELECT id, merchant_id, requested_by, name, address, requested_terminals, status, created_at, reviewed_at
        FROM revale.merchant_location_requests
        WHERE merchant_id = ${merchantId}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return json(res, 200, { ok: true, requests: rows });
    }

    if (req.method === "POST" && action === "request-branch") {
      const merchantId = String(req.body?.merchant_id || "merchant_el_hornero");
      const requestedBy = String(req.body?.requested_by || "Gerencia").slice(0, 120);
      const name = String(req.body?.name || "").trim().slice(0, 120);
      const address = String(req.body?.address || "").trim().slice(0, 240);
      const requestedTerminals = Math.max(1, Math.min(Number(req.body?.requested_terminals || 1), 50));
      if (!name) return json(res, 400, { ok: false, error: "Ingresa el nombre de la sucursal" });
      const [row] = await sql`
        INSERT INTO revale.merchant_location_requests (merchant_id, requested_by, name, address, requested_terminals)
        VALUES (${merchantId}, ${requestedBy}, ${name}, ${address || null}, ${requestedTerminals})
        RETURNING id, merchant_id, requested_by, name, address, requested_terminals, status, created_at
      `;
      return json(res, 200, { ok: true, request: row });
    }

    if (req.method === "GET" && action === "merchant-users") {
      const merchantId = String(req.query?.merchant_id || "merchant_el_hornero");
      const rows = await sql`
        SELECT
          mu.id,
          mu.merchant_id,
          mu.location_id,
          mu.display_name,
          mu.email,
          mu.role,
          mu.active,
          mu.invite_status,
          mu.created_at,
          mu.updated_at,
          mu.last_login_at,
          ml.name AS location_name
        FROM revale.merchant_users mu
        LEFT JOIN revale.merchant_locations ml ON ml.id = mu.location_id
        WHERE mu.merchant_id = ${merchantId}
        ORDER BY
          CASE mu.role WHEN 'admin' THEN 1 WHEN 'supervisor' THEN 2 ELSE 3 END,
          mu.display_name
      `;
      return json(res, 200, { ok: true, users: rows });
    }

    if (req.method === "POST" && action === "invite-user") {
      const merchantId = String(req.body?.merchant_id || "merchant_el_hornero");
      const displayName = String(req.body?.display_name || "").trim().slice(0, 120);
      const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 180);
      const role = String(req.body?.role || "cashier");
      const locationId = req.body?.location_id ? String(req.body.location_id) : null;
      if (!displayName) return json(res, 400, { ok: false, error: "Ingresa el nombre del usuario" });
      if (!email || !email.includes("@")) return json(res, 400, { ok: false, error: "Ingresa un correo válido" });
      if (!["cashier","supervisor","admin"].includes(role)) return json(res, 400, { ok: false, error: "Rol inválido" });
      if (role !== "admin" && !locationId) return json(res, 400, { ok: false, error: "Selecciona una sucursal" });

      const userId = "merchant_user_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,8);
      try {
        const [row] = await sql`
          INSERT INTO revale.merchant_users (
            id, merchant_id, location_id, display_name, email, role, active, invite_status, updated_at
          )
          VALUES (
            ${userId}, ${merchantId}, ${role === "admin" ? null : locationId}, ${displayName}, ${email}, ${role}, true, 'pending', now()
          )
          RETURNING id, merchant_id, location_id, display_name, email, role, active, invite_status, created_at, updated_at
        `;
        return json(res, 200, { ok: true, user: row });
      } catch (error) {
        if (String(error?.message || "").toLowerCase().includes("merchant_users_email_unique")) {
          return json(res, 409, { ok: false, error: "Ese correo ya tiene acceso a ReVale" });
        }
        throw error;
      }
    }

    if (req.method === "POST" && action === "update-user") {
      const merchantId = String(req.body?.merchant_id || "merchant_el_hornero");
      const userId = String(req.body?.user_id || "");
      const active = typeof req.body?.active === "boolean" ? req.body.active : null;
      const role = req.body?.role ? String(req.body.role) : null;
      const locationId = Object.prototype.hasOwnProperty.call(req.body || {}, "location_id")
        ? (req.body.location_id ? String(req.body.location_id) : null)
        : undefined;
      if (!userId) return json(res, 400, { ok: false, error: "Usuario inválido" });
      if (role && !["cashier","supervisor","admin"].includes(role)) return json(res, 400, { ok: false, error: "Rol inválido" });

      const [existing] = await sql`
        SELECT id, role, location_id, active
        FROM revale.merchant_users
        WHERE id = ${userId} AND merchant_id = ${merchantId}
        LIMIT 1
      `;
      if (!existing) return json(res, 404, { ok: false, error: "Usuario no encontrado" });

      const nextRole = role || existing.role;
      const nextLocation = nextRole === "admin"
        ? null
        : (locationId === undefined ? existing.location_id : locationId);
      if (nextRole !== "admin" && !nextLocation) {
        return json(res, 400, { ok: false, error: "Caja y Supervisor requieren una sucursal" });
      }

      const [row] = await sql`
        UPDATE revale.merchant_users
        SET
          role = ${nextRole},
          location_id = ${nextLocation},
          active = COALESCE(${active}, active),
          updated_at = now()
        WHERE id = ${userId} AND merchant_id = ${merchantId}
        RETURNING id, merchant_id, location_id, display_name, email, role, active, invite_status, created_at, updated_at
      `;
      return json(res, 200, { ok: true, user: row });
    }

    if (req.method === "GET" && action === "bank-account") {
      const merchantId = String(req.query?.merchant_id || "merchant_el_hornero");
      const [verified] = await sql`
        SELECT id, merchant_id, bank_name, account_type, account_number, holder_name, holder_identification, status, requested_by, verified_by, verified_at, created_at, updated_at
        FROM revale.merchant_bank_accounts
        WHERE merchant_id = ${merchantId} AND status = 'verified'
        ORDER BY verified_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `;
      const [request] = await sql`
        SELECT id, merchant_id, bank_name, account_type, account_number, holder_name, holder_identification, requested_by, status, reviewed_by, reviewed_at, rejection_reason, created_at, updated_at
        FROM revale.merchant_bank_account_requests
        WHERE merchant_id = ${merchantId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const mask = (value) => {
        const s = String(value || "");
        if (!s) return null;
        return "•••• " + s.slice(-4);
      };
      return json(res, 200, {
        ok: true,
        verified: verified ? { ...verified, account_number_masked: mask(verified.account_number), account_number: undefined } : null,
        request: request ? { ...request, account_number_masked: mask(request.account_number), account_number: undefined } : null
      });
    }

    if (req.method === "POST" && action === "request-bank-account") {
      const merchantId = String(req.body?.merchant_id || "merchant_el_hornero");
      const bankName = String(req.body?.bank_name || "").trim().slice(0, 120);
      const accountType = String(req.body?.account_type || "").trim().slice(0, 60);
      const accountNumber = String(req.body?.account_number || "").replace(/\s+/g, "").slice(0, 60);
      const holderName = String(req.body?.holder_name || "").trim().slice(0, 160);
      const holderIdentification = String(req.body?.holder_identification || "").replace(/\s+/g, "").slice(0, 40);
      const requestedBy = String(req.body?.requested_by || "Gerencia").trim().slice(0, 120);
      if (!bankName || !accountType || !accountNumber || !holderName || !holderIdentification) {
        return json(res, 400, { ok: false, error: "Completa todos los datos bancarios" });
      }

      const [pending] = await sql`
        SELECT id
        FROM revale.merchant_bank_account_requests
        WHERE merchant_id = ${merchantId} AND status='pending'
        LIMIT 1
      `;
      if (pending) return json(res, 409, { ok: false, error: "Ya existe una cuenta pendiente de verificación" });

      const [row] = await sql`
        INSERT INTO revale.merchant_bank_account_requests (
          merchant_id, bank_name, account_type, account_number, holder_name, holder_identification, requested_by
        )
        VALUES (
          ${merchantId}, ${bankName}, ${accountType}, ${accountNumber}, ${holderName}, ${holderIdentification}, ${requestedBy}
        )
        RETURNING id, merchant_id, bank_name, account_type, holder_name, holder_identification, requested_by, status, created_at
      `;
      return json(res, 200, { ok: true, request: row });
    }

    if (req.method === "GET" && action === "merchant-terms") {
      const merchantId = String(req.query?.merchant_id || "merchant_el_hornero");
      const [row] = await sql`
        SELECT
          id,
          merchant_id,
          discount_rate::float8 AS discount_rate,
          tax_rate::float8 AS tax_rate,
          settlement_frequency,
          settlement_weekday,
          effective_from,
          effective_until
        FROM revale.merchant_terms
        WHERE merchant_id = ${merchantId}
          AND active = true
          AND effective_from <= CURRENT_DATE
          AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
      `;
      if (!row) return json(res, 404, { ok: false, error: "Condiciones comerciales no configuradas" });
      return json(res, 200, { ok: true, terms: row });
    }

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

    if (req.method === "GET" && action === "reversal-requests") {
      const merchantId = String(req.query?.merchant_id || "merchant_el_hornero");
      const locationId = req.query?.location_id ? String(req.query.location_id) : null;
      const rows = await sql`
        SELECT
          rr.id,
          rr.transaction_id,
          rr.merchant_id,
          rr.location_id,
          rr.requested_by,
          rr.reason,
          rr.note,
          rr.status,
          rr.reviewed_by,
          rr.reviewed_at,
          rr.created_at,
          tr.amount::float8 AS amount,
          tr.reference,
          tr.status AS transaction_status,
          ml.name AS location_name
        FROM revale.reversal_requests rr
        JOIN revale.transactions tr ON tr.id = rr.transaction_id
        LEFT JOIN revale.merchant_locations ml ON ml.id = rr.location_id
        WHERE rr.merchant_id = ${merchantId}
          AND (${locationId}::text IS NULL OR rr.location_id = ${locationId})
        ORDER BY rr.created_at DESC
        LIMIT 100
      `;
      return json(res, 200, { ok: true, requests: rows });
    }

    if (req.method === "POST" && action === "request-reversal") {
      const tx = String(req.body?.tx || "");
      const merchantId = String(req.body?.merchant_id || "merchant_el_hornero");
      const locationId = req.body?.location_id ? String(req.body.location_id) : null;
      const requestedBy = String(req.body?.requested_by || "Caja").slice(0, 120);
      const reason = String(req.body?.reason || "").trim().slice(0, 120);
      const note = String(req.body?.note || "").trim().slice(0, 500);
      if (!tx || !reason) return json(res, 400, { ok: false, error: "Selecciona un motivo" });

      const [tr] = await sql`
        SELECT id, status, merchant_id, location_id
        FROM revale.transactions
        WHERE id = ${tx} AND merchant_id = ${merchantId}
        LIMIT 1
      `;
      if (!tr) return json(res, 404, { ok: false, error: "Transacción no encontrada" });
      if (tr.status !== "approved") return json(res, 409, { ok: false, error: "Solo se puede solicitar reverso de una transacción aprobada" });

      try {
        const [row] = await sql`
          INSERT INTO revale.reversal_requests (
            transaction_id, merchant_id, location_id, requested_by, reason, note
          )
          VALUES (
            ${tx}, ${merchantId}, ${tr.location_id || locationId}, ${requestedBy}, ${reason}, ${note || null}
          )
          RETURNING id, transaction_id, merchant_id, location_id, requested_by, reason, note, status, created_at
        `;
        await sql`
          INSERT INTO revale.transaction_events (transaction_id, event_type, payload)
          VALUES (
            ${tx},
            'reversal_requested',
            jsonb_build_object('requested_by',${requestedBy},'reason',${reason},'note',${note || null})
          )
        `;
        return json(res, 200, { ok: true, request: row });
      } catch (error) {
        if (String(error?.message || "").includes("reversal_requests_one_pending_per_tx")) {
          return json(res, 409, { ok: false, error: "Ya existe una solicitud de reverso pendiente para esta transacción" });
        }
        throw error;
      }
    }

    if (req.method === "POST" && action === "resolve-reversal") {
      const requestId = Number(req.body?.request_id || 0);
      const decision = String(req.body?.decision || "");
      const reviewedBy = String(req.body?.reviewed_by || "Supervisor").slice(0, 120);
      if (!requestId || !["approve","reject"].includes(decision)) {
        return json(res, 400, { ok: false, error: "Solicitud inválida" });
      }
      const [request] = await sql`
        SELECT *
        FROM revale.reversal_requests
        WHERE id = ${requestId} AND status = 'pending'
        LIMIT 1
      `;
      if (!request) return json(res, 404, { ok: false, error: "Solicitud no encontrada o ya resuelta" });

      if (decision === "reject") {
        const [row] = await sql`
          UPDATE revale.reversal_requests
          SET status='rejected', reviewed_by=${reviewedBy}, reviewed_at=now()
          WHERE id=${requestId}
          RETURNING *
        `;
        await sql`
          INSERT INTO revale.transaction_events (transaction_id,event_type,payload)
          VALUES (
            ${request.transaction_id},
            'reversal_rejected',
            jsonb_build_object('reviewed_by',${reviewedBy},'request_id',${requestId})
          )
        `;
        return json(res, 200, { ok: true, request: row });
      }

      const result = await reverseCharge(
        sql,
        request.transaction_id,
        request.reason,
        request.note || "",
        reviewedBy
      );
      if (result.code !== "ok") {
        return json(res, 409, { ok: false, error: "La transacción ya no puede reversarse", status: result.status });
      }
      const [row] = await sql`
        UPDATE revale.reversal_requests
        SET status='approved', reviewed_by=${reviewedBy}, reviewed_at=now()
        WHERE id=${requestId}
        RETURNING *
      `;
      return json(res, 200, { ok: true, request: row, reversal: result });
    }

    if (req.method === "GET" && action === "transactions") {
      const merchant = String(req.query?.merchant_id || "merchant_el_hornero");
      const location = req.query?.location_id ? String(req.query.location_id) : null;
      const rows = await listMerchantTransactions(sql, req.query?.limit || 50, merchant, location);
      return json(res, 200, { ok: true, transactions: rows });
    }

    if (req.method === "POST" && action === "reverse") {
      const tx = String(req.body?.tx || "");
      const reason = String(req.body?.reason || "other").slice(0,120);
      const note = String(req.body?.note || "").slice(0,500);
      const reviewedBy = String(req.body?.reviewed_by || "Supervisor").slice(0,120);
      const result = await reverseCharge(sql, tx, reason, note, reviewedBy);

      if (result.code === "not_found") {
        return json(res, 404, {
          message: "RVL-005",
          error: "Transacción no encontrada"
        });
      }

      if (result.code !== "ok") {
        return json(res, 409, {
          message: "RVL-013",
          error: "La transacción no puede reversarse",
          status: result.status
        });
      }

      return json(res, 200, {
        message: "RVL-000",
        response: {
          status: "success",
          error_code: "RVL-000",
          error_message: "Reversal registered successfully",
          data: {
            external_transaction_id: result.tx,
            transaction_type: result.transactionType,
            amount: result.amount,
            balance: result.newBalance
          }
        }
      });
    }

    if (req.method === "POST" && action === "invoice-match") {
      const tx = String(req.body?.tx || "");
      const result = await matchInvoice(sql, tx);

      if (result.code === "not_found") {
        return json(res, 404, {
          message: "RVL-005",
          error: "Transacción no encontrada"
        });
      }

      if (result.code !== "ok") {
        return json(res, 409, {
          message: "RVL-013",
          error: "La factura no puede conciliarse",
          transactionStatus: result.transactionStatus,
          invoiceStatus: result.invoiceStatus
        });
      }

      return json(res, 200, {
        ok: true,
        message: "RVL-000",
        tx: result.tx,
        invoiceStatus: result.status
      });
    }

    if (req.method === "POST" && action === "create") {
      const amount = Number(req.body?.amount || 0);
      const reference = String(req.body?.reference || "").slice(0, 80);
      const merchantId = String(req.body?.merchant_id || "merchant_el_hornero");
      const locationId = String(req.body?.location_id || "location_el_hornero_cumbaya");

      if (!Number.isFinite(amount) || amount <= 0 || amount > 500) {
        return json(res, 400, {
          message: "RVL-010",
          error: "Monto inválido"
        });
      }

      const row = await createCharge(
        sql,
        Math.round(amount * 100) / 100,
        reference,
        merchantId,
        locationId
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

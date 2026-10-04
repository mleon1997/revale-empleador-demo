import { getSql } from "../lib/revale-db.js";
import {
  neonAuthRequest,
  forwardAuthCookies,
  getMerchantPrincipal,
  getNeonSession
} from "../lib/revale-auth.js";

function json(res, code, body) {
  res
    .status(code)
    .setHeader("Content-Type", "application/json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .json(body);
}

function demoCredential(email, password) {
  const map = {
    "caja@demo.revale.app": "caja-demo",
    "supervisor@demo.revale.app": "supervisor-demo",
    "gerencia@demo.revale.app": "gerencia-demo",
    "caja.gonzalezsuarez@demo.revale.app": "caja-demo",
    "supervisor.gonzalezsuarez@demo.revale.app": "supervisor-demo",
    "caja.islafloreana@demo.revale.app": "caja-demo",
    "supervisor.islafloreana@demo.revale.app": "supervisor-demo",
    "caja@cebiches.demo.revale.app": "caja-demo",
    "supervisor@cebiches.demo.revale.app": "supervisor-demo",
    "gerencia@cebiches.demo.revale.app": "gerencia-demo"
  };
  return map[email] === password;
}

async function upstreamJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export default async function handler(req, res) {
  const action = String(req.query?.action || "");

  try {
    const sql = await getSql();

    if (req.method === "GET" && action === "session") {
      const session = await getNeonSession(req);
      if (!session) return json(res, 401, { ok: false, error: "Sesión no válida" });

      const principal = await getMerchantPrincipal(sql, req);
      if (!principal) {
        return json(res, 403, {
          ok: false,
          error: "Tu usuario no tiene acceso a ReVale Comercios"
        });
      }

      return json(res, 200, {
        ok: true,
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name
        },
        principal
      });
    }

    if (req.method === "POST" && action === "login") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) {
        return json(res, 400, { ok: false, error: "Ingresa correo y contraseña" });
      }

      const [merchantUser] = await sql.query(
        `SELECT id, display_name, active
         FROM revale.merchant_users
         WHERE lower(email) = $1
         LIMIT 1`,
        [email]
      );

      if (!merchantUser?.active) {
        return json(res, 403, { ok: false, error: "Este usuario no tiene acceso activo" });
      }

      let upstream = await neonAuthRequest(req, "/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password, rememberMe: true })
      });

      if (!upstream.ok && demoCredential(email, password)) {
        const signup = await neonAuthRequest(req, "/sign-up/email", {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            name: merchantUser.display_name || "ReVale"
          })
        });

        if (signup.ok) {
          forwardAuthCookies(signup, res);
          return json(res, 200, { ok: true, bootstrapped: true });
        }
      }

      if (!upstream.ok) {
        const errorBody = await upstreamJson(upstream);
        return json(res, 401, {
          ok: false,
          error:
            errorBody?.message ||
            errorBody?.error?.message ||
            "Correo o contraseña incorrectos"
        });
      }

      forwardAuthCookies(upstream, res);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "logout") {
      const upstream = await neonAuthRequest(req, "/sign-out", {
        method: "POST",
        body: JSON.stringify({})
      });
      forwardAuthCookies(upstream, res);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { ok: false, error: "Acción no soportada" });
  } catch (error) {
    console.error("ReVale auth error", error);
    return json(res, 500, { ok: false, error: "Error de autenticación" });
  }
}

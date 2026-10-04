const DEFAULT_AUTH_URL = "https://ep-withered-sky-b7auv2sh.neonauth.c-13.us-east-1.aws.neon.tech/neondb/auth";

function authBaseUrl() {
  return String(process.env.NEON_AUTH_URL || DEFAULT_AUTH_URL).replace(/\/$/, "");
}

function cookieHeader(req) {
  return String(req?.headers?.cookie || "");
}

export async function neonAuthRequest(req, path, options = {}) {
  const headers = new Headers(options.headers || {});
  const cookie = cookieHeader(req);
  if (cookie) headers.set("cookie", cookie);

  // Better Auth validates Origin on state-changing requests. Because ReVale
  // proxies auth through /api/auth, the upstream request must explicitly
  // preserve the browser origin instead of becoming an origin-less
  // server-to-server fetch.
  const requestOrigin = String(req?.headers?.origin || "").trim();
  const trustedOrigin =
    requestOrigin === "https://comercios.revale.app"
      ? requestOrigin
      : "https://comercios.revale.app";
  headers.set("origin", trustedOrigin);
  headers.set("referer", trustedOrigin + "/");

  if (!headers.has("content-type") && options.body) {
    headers.set("content-type", "application/json");
  }
  headers.set("accept", "application/json");

  return fetch(authBaseUrl() + path, {
    ...options,
    headers,
    redirect: "manual"
  });
}

export function forwardAuthCookies(upstream, res) {
  const getSetCookie = upstream?.headers?.getSetCookie;
  let cookies = typeof getSetCookie === "function"
    ? getSetCookie.call(upstream.headers)
    : [];
  if (!cookies.length) {
    const single = upstream?.headers?.get("set-cookie");
    if (single) cookies = [single];
  }
  if (cookies.length) {
    const normalized = cookies.map((value) =>
      String(value)
        .replace(/;\s*Domain=[^;]+/gi, "")
        .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
    );
    res.setHeader("Set-Cookie", normalized);
  }
}

export async function getNeonSession(req) {
  const upstream = await neonAuthRequest(req, "/get-session", { method: "GET" });
  if (!upstream.ok) return null;
  const data = await upstream.json().catch(() => null);
  if (!data?.user || !data?.session) return null;
  return data;
}

export async function getMerchantPrincipal(sql, req) {
  const auth = await getNeonSession(req);
  if (!auth?.user) return null;

  const authUserId = String(auth.user.id || "");
  const email = String(auth.user.email || "").trim().toLowerCase();
  if (!authUserId || !email) return null;

  let [row] = await sql.query(
    `SELECT
       mu.id AS merchant_user_id,
       mu.auth_user_id,
       mu.merchant_id,
       mu.location_id,
       mu.display_name,
       mu.email,
       mu.role,
       mu.active,
       m.name AS merchant_name,
       m.slug AS merchant_slug,
       ml.name AS location_name,
       ml.slug AS location_slug,
       ml.metadata AS location_metadata
     FROM revale.merchant_users mu
     JOIN revale.merchants m ON m.id = mu.merchant_id
     LEFT JOIN revale.merchant_locations ml ON ml.id = mu.location_id
     WHERE mu.active = true
       AND (
         mu.auth_user_id::text = $1
         OR (mu.auth_user_id IS NULL AND lower(mu.email) = $2)
       )
     LIMIT 1`,
    [authUserId, email]
  );

  if (!row) return null;

  if (!row.auth_user_id) {
    [row] = await sql.query(
      `UPDATE revale.merchant_users
       SET auth_user_id = $1::uuid, updated_at = now(), last_login_at = now()
       WHERE id = $2 AND auth_user_id IS NULL
       RETURNING id AS merchant_user_id, auth_user_id, merchant_id, location_id,
                 display_name, email, role, active`,
      [authUserId, row.merchant_user_id]
    );

    const [details] = await sql.query(
      `SELECT m.name AS merchant_name, m.slug AS merchant_slug,
              ml.name AS location_name, ml.slug AS location_slug,
              ml.metadata AS location_metadata
       FROM revale.merchants m
       LEFT JOIN revale.merchant_locations ml ON ml.id = $2
       WHERE m.id = $1
       LIMIT 1`,
      [row.merchant_id, row.location_id]
    );
    row = { ...row, ...details };
  } else {
    await sql.query(
      "UPDATE revale.merchant_users SET last_login_at = now() WHERE id = $1",
      [row.merchant_user_id]
    );
  }

  return {
    authUserId,
    email,
    merchantUserId: row.merchant_user_id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    merchantSlug: row.merchant_slug,
    locationId: row.location_id,
    locationName: row.location_name,
    locationSlug: row.location_slug,
    terminal: row.location_metadata?.demo_terminal || "Caja 01",
    displayName: row.display_name,
    role: row.role
  };
}

export function roleAllowed(principal, allowedRoles = []) {
  if (!principal) return false;
  if (!allowedRoles?.length) return true;
  return allowedRoles.includes(principal.role);
}

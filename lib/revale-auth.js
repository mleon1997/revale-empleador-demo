import { authUrl, authOrigin, identityAllowed, canBindLegacyIdentity } from './revale-security.js';

function cookieHeader(req) {
  return String(req?.headers?.cookie || "");
}

export async function neonAuthRequest(req, path, options = {}) {
  const headers = new Headers(options.headers || {});
  const cookie = cookieHeader(req);
  if (cookie) headers.set("cookie", cookie);

  // Routes validate the incoming Origin before this proxy. Each isolated
  // provider must trust its own explicitly configured canonical origin.
  const trustedOrigin = authOrigin();
  headers.set("origin", trustedOrigin);
  headers.set("referer", trustedOrigin + "/");

  if (!headers.has("content-type") && options.body) {
    headers.set("content-type", "application/json");
  }
  headers.set("accept", "application/json");

  return fetch(authUrl() + path, {
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
  if (!authUserId || !email || !identityAllowed(email)) return null;

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
     LEFT JOIN revale.merchant_locations ml ON ml.id = mu.location_id AND ml.merchant_id = mu.merchant_id
     WHERE mu.active = true AND m.active = true
       AND (mu.role = 'admin' OR (ml.id IS NOT NULL AND ml.active = true))
       AND (
         mu.auth_user_id::text = $1
         OR (mu.auth_user_id IS NULL AND lower(mu.email) = $2)
       )
     LIMIT 1`,
    [authUserId, email]
  );

  if (!row) return null;

  if (!row.auth_user_id) {
    if (!canBindLegacyIdentity(auth.user)) return null;
    [row] = await sql.query(
      `UPDATE revale.merchant_users
       SET auth_user_id = $1::uuid, updated_at = now(), last_login_at = now()
       WHERE id = $2 AND auth_user_id IS NULL
       RETURNING id AS merchant_user_id, auth_user_id, merchant_id, location_id,
                 display_name, email, role, active`,
      [authUserId, row.merchant_user_id]
    );

    if (!row) return null;
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

export async function getEmployeePrincipal(sql, req, authenticate = getNeonSession) {
  const auth = await authenticate(req);
  if (!auth?.user) return null;

  const authUserId = String(auth.user.id || "");
  const email = String(auth.user.email || "").trim().toLowerCase();
  if (!authUserId || !email || !identityAllowed(email)) return null;

  let [person] = await sql.query(
    `SELECT id, auth_user_id, person_identification, first_name, last_name, email,
            company_identification, active
     FROM revale.persons
     WHERE active = true
       AND (
         auth_user_id::text = $1
         OR (auth_user_id IS NULL AND lower(email) = $2
           AND NOT COALESCE((to_jsonb(persons)->>'activation_required')::boolean,false))
       )
     LIMIT 1`,
    [authUserId, email]
  );
  if (!person) return null;

  if (!person.auth_user_id) {
    if (!canBindLegacyIdentity(auth.user)) return null;
    [person] = await sql.query(
      `UPDATE revale.persons
       SET auth_user_id = $1::uuid, updated_at = now()
       WHERE id = $2 AND auth_user_id IS NULL
         AND NOT COALESCE((to_jsonb(persons)->>'activation_required')::boolean,false)
       RETURNING id, auth_user_id, person_identification, first_name, last_name, email,
                 company_identification, active`,
      [authUserId, person.id]
    );
    if (!person) return null;
  }

  const [benefit] = await sql.query(
    `SELECT
       ee.id AS enrollment_id,
       ee.program_id,
       bp.employer_id,
       bp.name AS program_name,
       bp.benefit_type,
       bp.currency,
       ba.id AS account_id,
       ba.card_number,
       ba.balance::float8 AS balance,
       ee.starts_on,
       ee.ends_on
     FROM revale.employee_enrollments ee
     JOIN revale.benefit_programs bp ON bp.id = ee.program_id
     JOIN revale.cards c ON c.person_id = ee.person_id AND c.active = true
     JOIN revale.benefit_accounts ba ON ba.card_number = c.card_number
     WHERE ee.person_id = $1
       AND ee.status = 'active'
       AND bp.active = true
       AND ee.starts_on <= (now() AT TIME ZONE 'America/Guayaquil')::date
       AND (ee.ends_on IS NULL OR ee.ends_on >= (now() AT TIME ZONE 'America/Guayaquil')::date)
       AND (bp.valid_from IS NULL OR bp.valid_from <= (now() AT TIME ZONE 'America/Guayaquil')::date)
       AND (bp.valid_until IS NULL OR bp.valid_until >= (now() AT TIME ZONE 'America/Guayaquil')::date)
     ORDER BY bp.created_at DESC
     LIMIT 1`,
    [person.id]
  );

  return {
    authUserId,
    email,
    personId: person.id,
    identification: person.person_identification,
    firstName: person.first_name,
    lastName: person.last_name,
    companyIdentification: person.company_identification,
    benefit: benefit || null
  };
}

export async function getEmployerPrincipal(sql, req, authenticate = getNeonSession) {
  const auth = await authenticate(req);
  if (!auth?.user) return null;

  const authUserId = String(auth.user.id || "");
  const email = String(auth.user.email || "").trim().toLowerCase();
  if (!authUserId || !email || !identityAllowed(email)) return null;

  let [row] = await sql.query(
    `SELECT
       eu.id AS employer_user_id,
       eu.auth_user_id,
       eu.employer_id,
       eu.display_name,
       eu.email,
       eu.role,
       eu.active,
       e.name AS employer_name,
       e.slug AS employer_slug
     FROM revale.employer_users eu
     JOIN revale.employers e ON e.id = eu.employer_id
     WHERE eu.active = true AND e.active = true
       AND (
         eu.auth_user_id::text = $1
         OR (eu.auth_user_id IS NULL AND lower(eu.email) = $2
           AND NOT COALESCE((to_jsonb(eu)->>'activation_required')::boolean,false))
       )
     LIMIT 1`,
    [authUserId, email]
  );

  if (!row) return null;

  if (!row.auth_user_id) {
    if (!canBindLegacyIdentity(auth.user)) return null;
    const [updated] = await sql.query(
      `UPDATE revale.employer_users
       SET auth_user_id=$1::uuid,last_login_at=now(),updated_at=now()
       WHERE id=$2 AND auth_user_id IS NULL AND active=true
         AND NOT COALESCE((to_jsonb(employer_users)->>'activation_required')::boolean,false)
       RETURNING id AS employer_user_id,auth_user_id,employer_id,display_name,email,role,active`,
      [authUserId, row.employer_user_id]
    );
    if(!updated)return null;
    row = { ...row, ...updated };
  } else {
    await sql.query(
      "UPDATE revale.employer_users SET last_login_at=now() WHERE id=$1",
      [row.employer_user_id]
    );
  }

  return {
    authUserId,
    email,
    employerUserId: row.employer_user_id,
    employerId: row.employer_id,
    employerName: row.employer_name,
    employerSlug: row.employer_slug,
    displayName: row.display_name,
    role: row.role
  };
}

export async function getAdminPrincipal(sql, req) {
  const auth = await getNeonSession(req);
  if (!auth?.user) return null;

  const authUserId = String(auth.user.id || "");
  const email = String(auth.user.email || "").trim().toLowerCase();
  if (!authUserId || !email || !identityAllowed(email)) return null;

  let [row] = await sql.query(
    `SELECT id,auth_user_id,display_name,email,role,active
     FROM revale.admin_users
     WHERE active=true
       AND (
         auth_user_id::text=$1
         OR (auth_user_id IS NULL AND lower(email)=$2)
       )
     LIMIT 1`,
    [authUserId,email]
  );
  if (!row) return null;

  if (!row.auth_user_id) {
    if (!canBindLegacyIdentity(auth.user)) return null;
    [row] = await sql.query(
      `UPDATE revale.admin_users
       SET auth_user_id=$1::uuid,last_login_at=now(),updated_at=now()
       WHERE id=$2 AND auth_user_id IS NULL
       RETURNING id,auth_user_id,display_name,email,role,active`,
      [authUserId,row.id]
    );
  } else {
    await sql.query("UPDATE revale.admin_users SET last_login_at=now() WHERE id=$1",[row.id]);
  }

  return {
    authUserId,
    email,
    adminUserId:row.id,
    displayName:row.display_name,
    role:row.role
  };
}

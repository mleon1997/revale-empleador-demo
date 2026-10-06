import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { PostgresDialect } from 'kysely';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { authOrigin, databaseUrl } from './revale-security.js';

export const IDENTITY_SCHEMA = 'revale_identity';
export const identityEnabled = (env = process.env) => env.REVALE_AUTH_PROVIDER === 'better-auth-mfa';

// A staged opt-in only. No migration or credential fallback during requests.
export function identityConfig(env = process.env) {
  if (!identityEnabled(env) || env.VERCEL_ENV !== 'preview' || env.REVALE_MODE !== 'live') {
    throw new Error('IDENTITY_MFA_PREVIEW_ONLY');
  }
  const connectionString = env.REVALE_PREVIEW_IDENTITY_DATABASE_URL;
  if (!connectionString) throw new Error('ISOLATED_IDENTITY_DATABASE_REQUIRED');
  const identity = new URL(connectionString), application = new URL(databaseUrl(env));
  const host = value => value.hostname.replace('-pooler.', '.');
  if (host(identity) !== host(application) || identity.pathname !== application.pathname ||
      decodeURIComponent(identity.username) !== 'revale_staging_identity' || !identity.password) {
    throw new Error('RESTRICTED_STAGING_IDENTITY_REQUIRED');
  }
  const secret = env.REVALE_PREVIEW_IDENTITY_SECRET;
  if (!secret || secret.length < 43) throw new Error('IDENTITY_SECRET_REQUIRED');
  return { connectionString, secret, origin: authOrigin(env) };
}

export function identityOptions({ pool, origin, secret, cookiePrefix = 'revale-staging-mfa' }) {
  return {
    appName: 'ReVale Staging',
    baseURL: origin,
    basePath: '/internal-identity',
    secret,
    trustedOrigins: [origin],
    database: { dialect: new PostgresDialect({ pool }), type: 'postgres', schemaName: IDENTITY_SCHEMA, transaction: true },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: {
      expiresIn: 8 * 60 * 60,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
      additionalFields: { mfaVerified: { type: 'boolean', defaultValue: false, input: false } }
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 10 }, '/two-factor/*': { window: 60, max: 10 } } },
    advanced: { cookiePrefix, useSecureCookies: true, database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: ['x-vercel-forwarded-for'] },
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } },
    plugins: [twoFactor({ issuer: 'ReVale Staging', skipVerificationOnEnable: false,
      twoFactorCookieMaxAge: 300, accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 } })]
  };
}

export function createIdentity(options) { return betterAuth(identityOptions(options)); }

let instance;
export function getIdentity() {
  if (!instance) {
    const config = identityConfig();
    neonConfig.webSocketConstructor = globalThis.WebSocket;
    const pool = new Pool({ connectionString: config.connectionString, max: 5, connectionTimeoutMillis: 10000 });
    instance = createIdentity({ ...config, pool });
  }
  return instance;
}

// Only application-owned handlers call this. There is deliberately no public
// Better Auth catch-all exposing signup, factor removal or user management.
export async function identityRequest(auth, req, path, options = {}) {
  const headers = new Headers(options.headers);
  if (req.headers?.cookie) headers.set('cookie', req.headers.cookie);
  if (req.headers?.['x-vercel-forwarded-for']) headers.set('x-vercel-forwarded-for', req.headers['x-vercel-forwarded-for']);
  headers.set('origin', auth.options.baseURL);
  if (options.body) headers.set('content-type', 'application/json');
  return auth.handler(new Request(auth.options.baseURL + '/internal-identity' + path, { ...options, headers }));
}

export function mergedCookie(req, response) {
  const jar = new Map(String(req.headers?.cookie || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)];
  }));
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';')[0], i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function identitySession(auth, req) {
  const response = await identityRequest(auth, req, '/get-session', { method: 'GET' });
  return response.ok ? response.json() : null;
}

export function requireMfa(session) {
  if (session && (!session.user?.twoFactorEnabled || session.session?.mfaVerified !== true)) {
    throw Object.assign(new Error('Completa la verificación de seguridad para continuar.'), { status: 403, code: 'MFA_REQUIRED' });
  }
  return session;
}

export async function verifyIdentityFactor(auth, req, action, code) {
  const before = await identitySession(auth, req);
  if (action === 'recovery' && before && !before.user.twoFactorEnabled) {
    return Response.json({ message: 'Confirma primero el código del autenticador.' }, { status: 403 });
  }
  const path = action === 'recovery' ? '/two-factor/verify-backup-code' : '/two-factor/verify-totp';
  const response = await identityRequest(auth, req, path, { method: 'POST', body: JSON.stringify({ code, trustDevice: false }) });
  if (!response.ok) return response;
  const session = await identitySession(auth, { headers: { ...req.headers, cookie: mergedCookie(req, response) } });
  if (!session?.session || !session.user.twoFactorEnabled) throw new Error('MFA_SESSION_NOT_ESTABLISHED');
  // Proof belongs to this specific session, never just to the user's enabled flag.
  const context = await auth.$context;
  await context.internalAdapter.updateSession(session.session.token, { mfaVerified: true });
  return response;
}

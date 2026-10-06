export function isDemoIdentity(email) {
  return /@(?:[^@]+\.)?demo\.revale\.app$|\.demo@revale\.app$/i.test(String(email || ''));
}

export function identityAllowed(email, env = process.env) {
  return env.REVALE_MODE === 'demo' || !isDemoIdentity(email);
}

export function canBindLegacyIdentity(user) {
  return user?.emailVerified === true ||
    (process.env.REVALE_MODE === 'demo' && isDemoIdentity(user?.email));
}

// Browser mutations must originate from this exact host. Do not rewrite an
// untrusted Origin into a trusted one before applying this check.
export function assertSameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const host = String(req.headers?.host || '');
  const origin = String(req.headers?.origin || '');
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const expected = `${local ? 'http' : 'https'}://${host}`;
  if (!host || origin !== expected || req.headers?.['sec-fetch-site'] === 'cross-site') {
    throw Object.assign(new Error('Abre esta acción desde ReVale.'), { status: 403 });
  }
}

function databaseIdentity(value) {
  const url = new URL(value);
  return url.hostname.replace('-pooler.', '.') + url.pathname;
}

export function databaseUrl(env = process.env) {
  if (!['demo', 'live'].includes(env.REVALE_MODE)) throw new Error('REVALE_MODE_NOT_CONFIGURED');
  const demo = env.REVALE_DB_DATABASE_URL || env.DATABASE_URL || env.REVALE_DB_URL || env.STORAGE_URL;
  if (env.VERCEL_ENV === 'preview') {
    if (!env.REVALE_PREVIEW_DATABASE_URL || (demo && databaseIdentity(demo) === databaseIdentity(env.REVALE_PREVIEW_DATABASE_URL))) {
      throw new Error('ISOLATED_PREVIEW_DATABASE_REQUIRED');
    }
    return env.REVALE_PREVIEW_DATABASE_URL;
  }
  if (env.REVALE_MODE === 'live') {
    const live = env.REVALE_LIVE_DATABASE_URL;
    if (!live || (demo && databaseIdentity(demo) === databaseIdentity(live))) throw new Error('ISOLATED_LIVE_DATABASE_REQUIRED');
    return live;
  }
  if (!demo) throw new Error('DATABASE_URL_NOT_CONFIGURED');
  return demo;
}

export function authUrl(env = process.env) {
  const demo = env.NEON_AUTH_URL || env.REVALE_DB_NEON_AUTH_BASE_URL;
  const sameEndpoint = value => demo && new URL(value).href.replace(/\/$/, '') === new URL(demo).href.replace(/\/$/, '');
  if (env.VERCEL_ENV === 'preview') {
    if (!env.REVALE_PREVIEW_AUTH_URL || sameEndpoint(env.REVALE_PREVIEW_AUTH_URL)) throw new Error('ISOLATED_PREVIEW_AUTH_REQUIRED');
    return env.REVALE_PREVIEW_AUTH_URL.replace(/\/$/, '');
  }
  if (env.REVALE_MODE === 'live') {
    if (!env.REVALE_LIVE_AUTH_URL || sameEndpoint(env.REVALE_LIVE_AUTH_URL)) throw new Error('ISOLATED_LIVE_AUTH_REQUIRED');
    return env.REVALE_LIVE_AUTH_URL.replace(/\/$/, '');
  }
  if (env.REVALE_MODE !== 'demo' || !demo) throw new Error('AUTH_NOT_CONFIGURED');
  return demo.replace(/\/$/, '');
}

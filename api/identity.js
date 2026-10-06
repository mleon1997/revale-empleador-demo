import { assertSameOrigin } from '../lib/revale-security.js';
import { forwardAuthCookies } from '../lib/revale-auth.js';
import { getIdentity, identityEnabled, identityRequest, identitySession, verifyIdentityFactor, requireMfa } from '../lib/revale-identity.js';
import QRCode from 'qrcode';

const destinations = { employee: '/empleados/', employer: '/empresas/', merchant: '/comercios/', admin: '/admin/' };
export function createIdentityHandler({ enabled = identityEnabled, identity = getIdentity } = {}) {
  return async (req, res) => {
    const json = (code, value) => res.status(code).setHeader('Cache-Control', 'no-store').json(value);
    try {
      assertSameOrigin(req);
      if (!enabled()) return json(404, { ok: false, error: 'Acción no disponible.' });
      const auth = identity(), action = String(req.query?.action || '');
      if (req.method === 'GET' && action === 'status') {
        const session = await identitySession(auth, req);
        return json(200, { ok: true, authenticated: !!session, enrolled: !!session?.user?.twoFactorEnabled,
          verified: !!session?.user?.twoFactorEnabled && session?.session?.mfaVerified === true });
      }
      if (req.method !== 'POST') return json(405, { ok: false, error: 'Acción no soportada.' });
      let response;
      if (action === 'enable') {
        response = await identityRequest(auth, req, '/two-factor/enable', { method: 'POST',
          body: JSON.stringify({ password: String(req.body?.password || ''), method: 'totp' }) });
        if (response.ok) {
          const data = await response.json();
          const qr = await QRCode.toDataURL(data.totpURI, { width: 256, margin: 2 });
          // QR is rendered here; no third-party service receives the shared secret.
          return json(200, { ok: true, qr, backupCodes: data.backupCodes });
        }
      } else if (['totp', 'recovery'].includes(action)) {
        const code = String(req.body?.code || '');
        if ((action === 'totp' && !/^\d{6}$/.test(code)) || code.length > 80 || !code) {
          return json(400, { ok: false, error: 'Ingresa un código válido.' });
        }
        response = await verifyIdentityFactor(auth, req, action, code);
      } else if (action === 'regenerate-recovery') {
        const session = await identitySession(auth, req);
        if (!session) return json(401, { ok: false, error: 'Inicia sesión.' });
        requireMfa(session);
        response = await identityRequest(auth, req, '/two-factor/generate-backup-codes', { method: 'POST',
          body: JSON.stringify({ password: String(req.body?.password || '') }) });
        if (response.ok) return json(200, { ok: true, backupCodes: (await response.json()).backupCodes });
      } else if (action === 'logout') {
        response = await identityRequest(auth, req, '/sign-out', { method: 'POST', body: '{}' });
      } else return json(404, { ok: false, error: 'Acción no disponible.' });
      forwardAuthCookies(response, res);
      if (!response.ok) return json(response.status === 429 ? 429 : 401, { ok: false,
        error: response.status === 429 ? 'Demasiados intentos. Espera 15 minutos antes de volver a intentar.' : 'No pudimos validar tu acceso. Revisa el código o inicia sesión de nuevo.' });
      return json(200, { ok: true, next: destinations[String(req.body?.portal)] || '/empleados/' });
    } catch (error) {
      if (!error.status) console.error('ReVale identity error', { code: 'IDENTITY_FAILED' });
      return json(error.status || 503, { ok: false, error: error.status ? error.message : 'No pudimos completar la verificación. Intenta nuevamente.' });
    }
  };
}
export default createIdentityHandler();

import crypto from 'node:crypto';
import { requireTenant } from './tenant-ingestion.js';

const base = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
async function api(resource, { token = key, method = 'GET', body } = {}) {
  const response = await fetch(base + resource, { method,
    headers: { apikey: key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('No se pudo verificar o guardar la cuenta.');
  return data;
}
export async function loadDatabaseTenantConfig(tenantId) {
  requireTenant(tenantId);
  const rows = await api('/rest/v1/tenants?id=eq.' + encodeURIComponent(tenantId) + '&select=meta_config');
  if (!rows[0]) throw new Error('Cuenta no encontrada.');
  return { ...rows[0].meta_config, tenantId, accessToken: rows[0].meta_config.accessToken || '', datasetId: rows[0].meta_config.datasetId || '' };
}
export async function verifyAccountRequest(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /i, '');
  if (!token || token === key) throw new Error('Inicia sesión para gestionar esta cuenta.');
  const user = await api('/auth/v1/user', { token });
  const rows = await api('/rest/v1/tenant_memberships?user_id=eq.' + encodeURIComponent(user.id) + '&select=tenant_id,role');
  if (!rows[0]) throw new Error('No hay una cuenta asignada a esta sesión.');
  return { userId: user.id, tenantId: rows[0].tenant_id, role: rows[0].role };
}
export function authorizeTenant(member, tenant) {
  requireTenant(tenant);
  if (member.role !== 'superadmin' && member.tenantId !== tenant) throw new Error('La sesión pertenece a otra cuenta.');
  return tenant;
}
function signingKey() {
  const secret = process.env.ADMIN_KEY || process.env['ADMIN-KEY'] || process.env.WEBHOOK_SECRET || process.env.SESSION_ENCRYPTION_KEY || 'kindev_internal_signing_key_fallback';
  return secret;
}
export function makeLinkTicket(tenant, userId, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ tenant: requireTenant(tenant), userId, exp: now + 10 * 60000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}
export function verifyLinkTicket(ticket, tenant, now = Date.now()) {
  try {
    const [payload, signature, extra] = String(ticket || '').split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    return claims.tenant === requireTenant(tenant) && claims.exp > now && claims.exp <= now + 10 * 60000;
  } catch { return false; }
}
export function installAccountRoutes(app) {
  const attempts = new Map();
  const limiter = (req, res, next) => {
    const address = req.ip;
    const previous = attempts.get(address);
    const current = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60000 };
    current.count++; attempts.set(address, current);
    if (attempts.size > 10000) for (const [ip, state] of attempts) if (state.until <= Date.now()) attempts.delete(ip);
    if (current.count > 30) return res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' });
    next();
  };
  app.post('/api/auth/login', limiter, async (req, res) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      let email = username;
      if (!username.includes('@')) {
        if (!/^[a-z0-9_ .-]{1,80}$/.test(username)) throw new Error('Usuario inválido.');
        const alias = ['kindev', 'kindevx', 'admin'].includes(username) ? 'kindev' : ['gabriel', 'miranda', 'gabriel miranda'].includes(username) ? 'gabriel_miranda_gi1yk' : username;
        const rows = await api('/rest/v1/tenants?id=eq.' + encodeURIComponent(alias) + '&select=username');
        email = rows[0]?.username || 'unknown@invalid.example';
      }
      const session = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      res.set('Cache-Control', 'no-store').json({ access_token: session.access_token, refresh_token: session.refresh_token });
    } catch { res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); }
  });
  app.post('/api/auth/google', limiter, async (req, res) => {
    try {
      const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(process.env.KINDEVADS_FIREBASE_API_KEY || 'AIzaSyDuY8r3OQ08dG-JEk_XSs08M2U8e56W5J8'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: req.body.firebaseToken }), signal: AbortSignal.timeout(10000)
      });
      const identity = (await response.json()).users?.[0];
      if (!response.ok || !identity?.emailVerified || !identity.providerUserInfo?.some(provider => provider.providerId === 'google.com')) throw new Error('Identidad Google no verificada.');
      const email = identity.email.toLowerCase();
      const tenants = await api('/rest/v1/tenants?username=eq.' + encodeURIComponent(email) + '&select=id');
      if (!tenants.length) {
        // Auth trigger provisions a new tenant with client privileges only.
        await api('/auth/v1/admin/users', { method: 'POST', body: { email, email_confirm: true,
          password: crypto.randomBytes(32).toString('base64url'), user_metadata: { business_name: identity.displayName || email.split('@')[0] } } });
      }
      const link = await api('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email } });
      const session = await api('/auth/v1/verify', { method: 'POST', body: { type: 'magiclink', token_hash: link.hashed_token || link.properties?.hashed_token } });
      res.set('Cache-Control', 'no-store').json({ access_token: session.access_token, refresh_token: session.refresh_token });
    } catch { res.status(401).json({ error: 'No se pudo verificar el acceso de Google.' }); }
  });
  app.post('/api/whatsapp/link-ticket', async (req, res) => {
    try {
      const member = await verifyAccountRequest(req);
      const tenant = authorizeTenant(member, req.body.tenantId);
      res.set('Cache-Control', 'no-store').json({ tenantId: tenant, ticket: makeLinkTicket(tenant, member.userId) });
    } catch (error) { res.status(403).json({ error: error.message }); }
  });
  app.post('/api/accounts', async (req, res) => {
    try {
      const member = await verifyAccountRequest(req);
      if (member.role !== 'superadmin') return res.status(403).json({ error: 'Operación administrativa.' });
      const { email, password, name, phone, metaConfig } = req.body;
      if (!String(email).includes('@') || String(password || '').length < 8) throw new Error('Usa correo y contraseña de al menos 8 caracteres.');
      const user = await api('/auth/v1/admin/users', { method: 'POST', body: {
        email: String(email).toLowerCase().trim(), password, email_confirm: true, user_metadata: { business_name: name, phone }
      } });
      const memberships = await api('/rest/v1/tenant_memberships?user_id=eq.' + encodeURIComponent(user.id) + '&select=tenant_id');
      const tenant = memberships[0]?.tenant_id;
      if (!tenant) throw new Error('No se pudo asignar la cuenta.');
      const rows = await api('/rest/v1/tenants?id=eq.' + encodeURIComponent(tenant), { method: 'PATCH', body: { meta_config: metaConfig || {} } });
      res.json(rows[0]);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/accounts/password', async (req, res) => {
    try {
      const member = await verifyAccountRequest(req);
      const tenant = authorizeTenant(member, req.body.tenantId);
      const password = String(req.body.password || '');
      if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
      const members = await api('/rest/v1/tenant_memberships?tenant_id=eq.' + encodeURIComponent(tenant) + '&select=user_id');
      if (!members[0]) throw new Error('Cuenta no encontrada.');
      await api('/auth/v1/admin/users/' + members[0].user_id, { method: 'PUT', body: { password } });
      res.json({ success: true, tenantId: tenant });
    } catch (error) { res.status(403).json({ error: error.message }); }
  });
}

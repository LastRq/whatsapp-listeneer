export function statusCors(req, res, next) {
  if (req.path === '/api/status') {
    const allowed = new Set(['https://kindevads.com', 'https://www.kindevads.com', 'https://kindevads.web.app']);
    if (allowed.has(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
}
export function publicListenerStatus({ status, phone, tenantId, instanceId, projectId, hasQR, filterActive, now = Date.now() }) {
  const connected = status === 'conectado' && Boolean(phone);
  return { status, connected, isListening: connected, tenantId, instanceId, projectId, hasQR: Boolean(hasQR), phone: connected ? phone : null, filterActive, updatedAt: new Date(now).toISOString(), version: 'kindevads-tenants-1' };
}

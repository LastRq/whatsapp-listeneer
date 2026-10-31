import { TENANT_ID, firestoreFetch } from './firebase-client.js';
import { DOCUMENTS_URL, decode, loadTenantConfig, authorizeMeta, patchDocument, OFFICIAL_ORIGINS } from './meta-integration.js';
import { findPhoneLead } from './whatsapp-leads.js';
export function summarizeOutbound(leads, now = Date.now()) {
  const entries = leads.filter(l => l.tenantId === TENANT_ID && l.outboundTracking?.firstSentAt).map(l => ({
    phone: l.phone, firstSentAt: l.outboundTracking.firstSentAt, lastSentAt: l.outboundTracking.lastSentAt,
    snippet: '', replyCount: l.outboundTracking.replyCount || 0
  })).sort((a,b) => b.lastSentAt-a.lastSentAt);
  const replied = entries.filter(e => e.replyCount > 0).length;
  return { tenantId: TENANT_ID, totalProspected: entries.length, replied, responseRate: entries.length ? (100*replied/entries.length).toFixed(1) : '0',
    recent24h: entries.filter(e => now-e.lastSentAt < 86400000).length,
    cold48h: entries.filter(e => now-e.lastSentAt > 2*86400000 && !e.replyCount).length,
    dead7d: entries.filter(e => now-e.lastSentAt > 7*86400000 && !e.replyCount).length, entries };
}
const queues = new Map();
export async function observeCrmConversation(msg) {
  const jid = msg.key?.remoteJid || '';
  if (!jid.endsWith('@s.whatsapp.net') || !msg.key?.id) return;
  const phone = jid.split('@')[0].replace(/:\d+$/, '');
  const run = async () => {
    const lead = await findPhoneLead(phone);
    if (!lead) return; // No registrar conversaciones personales ajenas al CRM de esta cuenta.
    const tracking = lead.outboundTracking || {};
    const time = Math.min(Date.now(), Number(msg.messageTimestamp || Date.now()/1000)*1000);
    if (msg.key.fromMe) {
      if (tracking.lastMessageId === msg.key.id) return;
      await patchDocument('leads/' + lead.id, { lastContactDate: new Date(time).toISOString(), outboundTracking: {
        ...tracking, firstSentAt: tracking.firstSentAt || time, lastSentAt: time,
        replyCount: tracking.replyCount || 0, lastMessageId: msg.key.id
      } });
    } else if (tracking.firstSentAt && tracking.lastReplyId !== msg.key.id) {
      await patchDocument('leads/' + lead.id, { outboundTracking: { ...tracking, replyCount: (tracking.replyCount || 0)+1, lastReplyId: msg.key.id } });
    }
  };
  const task = (queues.get(phone) || Promise.resolve()).then(run).catch(e => console.warn('[Seguimiento]', e.message));
  queues.set(phone, task); await task;
  if (queues.get(phone) === task) queues.delete(phone);
}
export function installOutboundRoutes(app) {
  app.use('/api/whatsapp/outbound-tracker-full', async (req,res,next) => {
    const origin = req.get('Origin');
    if (origin && !OFFICIAL_ORIGINS.has(origin)) return res.status(403).json({error:'Origen no permitido.'});
    if (origin) res.set('Access-Control-Allow-Origin',origin).vary('Origin');
    res.set('Cache-Control','no-store').set('Access-Control-Allow-Headers','X-Meta-Token').set('Access-Control-Allow-Methods','GET,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    try {
      const cfg = await loadTenantConfig(TENANT_ID);
      if (!authorizeMeta(cfg,req.get('X-Meta-Token'))) return res.status(401).json({error:'No hay credenciales de esta cuenta.'});
      next();
    } catch { res.status(502).json({error:'No se pudo comprobar la cuenta.'}); }
  });
  app.get('/api/whatsapp/outbound-tracker-full', async (_req,res) => {
    try {
      const r = await firestoreFetch(DOCUMENTS_URL + ':runQuery',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({structuredQuery:{
        from:[{collectionId:'leads'}],where:{fieldFilter:{field:{fieldPath:'outboundTracking.firstSentAt'},op:'GREATER_THAN',value:{doubleValue:0}}}
      }}) });
      if (!r.ok) throw Error('Firebase no respondió.');
      const leads=(await r.json()).filter(x=>x.document).map(x=>decode({mapValue:x.document}));
      res.json(summarizeOutbound(leads));
    } catch { res.status(502).json({error:'No se pudo leer el seguimiento de esta cuenta.'}); }
  });
}

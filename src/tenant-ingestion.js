import crypto from 'node:crypto';

export function requireTenant(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)) throw new Error('Cuenta inválida o ausente.');
  return value;
}

// The phone, message id and lock always belong to the receiving socket's tenant.
export const tenantKey = (tenant, value) => JSON.stringify([requireTenant(tenant), String(value)]);

export function createTenantIngestion({ request, inbox, mirror = async () => {}, deliver = async () => {}, now = () => new Date().toISOString() }) {
  const locks = new Map();
  async function save(payload) {
    const tenant = requireTenant(payload.tenantId);
    const phone = String(payload.phone || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) throw new Error('Número de WhatsApp no válido.');
    const key = tenantKey(tenant, phone);
    const receipt = inbox?.put(payload);
    const previous = locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const rows = await request('leads?tenant_id=eq.' + encodeURIComponent(tenant) + '&phone=in.(' + phone + ',%2B' + phone + ')&select=*&order=created_at.asc&limit=1');
      const existing = rows[0];
      const timestamp = now();
      const ids = Array.isArray(existing?.whatsapp_message_ids) ? existing.whatsapp_message_ids : [];
      if (!payload.placeholder && existing && payload.messageId && ids.includes(payload.messageId)) return { saved: true, created: false, id: existing.id };
      const confirmedIds = !payload.placeholder && payload.messageId ? [...ids, payload.messageId].slice(-200) : ids;
      const pending = new Set(existing?.whatsapp_delivery?.pendingIds || []);
      if (payload.messageId) { if (payload.placeholder) pending.add(payload.messageId); else pending.delete(payload.messageId); }
      const delivery = { status: pending.size ? 'pending' : 'available', pendingIds: [...pending].slice(-200), updatedAt: timestamp };
      const pendingLabel = '[WhatsApp: contenido pendiente de recuperación]';
      const previousNotes = String(existing?.notes || '').replace(pendingLabel, '').trim();
      const message = payload.placeholder ? '' : String(payload.notes || payload.message || '').slice(0, 1200);
      const notes = [previousNotes, message ? timestamp + ' ' + message : '', pending.size ? pendingLabel : ''].filter(Boolean).join('\n').slice(-10000);
      const resumeMeta = !payload.placeholder && existing?.meta_delivery?.status === 'waiting_message';
      const metaDelivery = payload.placeholder ? { status: 'waiting_message', eventId: existing?.event_id }
        : payload.suppressMeta ? { status: 'skipped', reason: payload.suppressReason || 'operator_test', eventId: existing?.event_id }
        : { status: 'pending', eventId: existing?.event_id };
      let lead;
      if (existing) {
        const patch = { notes, last_contact_date: timestamp, whatsapp_message_ids: confirmedIds, whatsapp_delivery: delivery,
          ...(resumeMeta ? { meta_delivery: metaDelivery } : {}),
          ...(existing.outbound_tracking?.firstSentAt ? { outbound_tracking: { ...existing.outbound_tracking,
            replyCount: (existing.outbound_tracking.replyCount || 0) + 1, lastReplyAt: Date.parse(timestamp) } } : {}),
          ...(payload.adInfo?.ctwaClid && !existing.ctwa_clid ? { ctwa_clid: payload.adInfo.ctwaClid } : {}) };
        const updated = await request('leads?id=eq.' + encodeURIComponent(existing.id) + '&tenant_id=eq.' + encodeURIComponent(tenant), { method: 'PATCH', body: patch });
        if (!updated.length) throw new Error('No se confirmó la actualización del contacto.');
        lead = updated[0];
      } else {
        const id = 'wa_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
        const eventId = 'wa_lead_' + id;
        lead = { id, tenant_id: tenant, phone, display_phone: payload.displayPhone || '+' + phone,
          name: String(payload.name || 'Cliente WhatsApp').slice(0, 100), service: payload.service || 'Contacto Inicial WhatsApp',
          notes, status: 'prospecto', amount: 0, created_at: payload.receivedAt || timestamp, last_contact_date: timestamp,
          whatsapp_message_ids: confirmedIds, whatsapp_delivery: delivery,
          source: 'whatsapp_auto', event_id: eventId, meta_events: [],
          ...(payload.adInfo?.ctwaClid ? { ctwa_clid: payload.adInfo.ctwaClid } : {}),
          meta_delivery: { ...metaDelivery, eventId } };
        const inserted = await request('leads', { method: 'POST', body: lead });
        if (!inserted.length) throw new Error('No se confirmó la creación del contacto.');
        lead = inserted[0];
      }
      // CRM capture succeeds independently of Firebase quota or Meta availability.
      Promise.resolve().then(() => mirror(lead)).catch(e => console.warn('[Mirror]', e.message));
      if ((!existing || resumeMeta) && !payload.placeholder && !payload.suppressMeta) Promise.resolve().then(() => deliver(lead)).catch(e => console.warn('[CAPI]', e.message));
      return { saved: true, created: !existing, id: lead.id };
    });
    locks.set(key, operation);
    try {
      const result = await operation;
      if (receipt) inbox.remove(receipt);
      return result;
    }
    finally { if (locks.get(key) === operation) locks.delete(key); }
  }
  return { save, async recordOutbound(payload) {
    const tenant = requireTenant(payload.tenantId);
    const phone = String(payload.phone || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) return;
    const key = tenantKey(tenant, phone);
    const previous = locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const rows = await request('leads?tenant_id=eq.' + encodeURIComponent(tenant) + '&phone=in.(' + phone + ',%2B' + phone + ')&select=*&order=created_at.asc&limit=1');
      const lead = rows[0];
      if (!lead) return;
      const tracker = lead.outbound_tracking || {};
      if (tracker.lastSentAt >= payload.timestamp) return;
      await request('leads?id=eq.' + encodeURIComponent(lead.id) + '&tenant_id=eq.' + encodeURIComponent(tenant), {
        method: 'PATCH', body: { outbound_tracking: { ...tracker, firstSentAt: tracker.firstSentAt || payload.timestamp,
          lastSentAt: payload.timestamp, replyCount: tracker.replyCount || 0, snippet: '' } }
      });
    });
    locks.set(key, operation);
    try { await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
  }, async drain() {
    for (const payload of inbox?.pending() || []) {
      try { await save(payload); } catch (e) { console.warn('[Inbox:' + payload.tenantId + ']', e.message); }
    }
  } };
}

export function createSupabaseRequest(base, key, fetcher = fetch) {
  if (!key || key.startsWith('sb_publishable_')) throw new Error('El servidor necesita la clave privada de Supabase.');
  return async (resource, options = {}) => {
    const response = await fetcher(base + '/rest/v1/' + resource, {
      method: options.method || 'GET', headers: { apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json', Prefer: (options.upsert ? 'resolution=merge-duplicates,' : '') + 'return=representation' },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Supabase no confirmó el guardado/lectura (' + response.status + ').');
    return response.status === 204 ? [] : response.json();
  };
}

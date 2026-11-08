import { requireTenant } from './tenant-ingestion.js';
import crypto from 'node:crypto';
import { firestoreFetch, TENANT_ID } from './firebase-client.js';
import { DOCUMENTS_URL, decode, readDocument, appendMetaEvent, patchDocument, loadTenantConfig, sendMetaEvent, phoneNumber } from './meta-integration.js';
export async function findPhoneLead(phone, targetTenant = null) {
  const response = await firestoreFetch(DOCUMENTS_URL + ':runQuery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'leads' }], where: { fieldFilter: { field: { fieldPath: 'phone' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: phone }, { stringValue: '+' + phone }] } } } }, limit: 100
    } })
  });
  if (!response.ok) throw new Error('No se pudo verificar duplicados en Firebase.');
  const documents = (await response.json()).filter(r => r.document).map(r => ({ ...decode({ mapValue: r.document }), id: r.document.name.split('/').pop() }));
  const tenant = targetTenant || TENANT_ID;
  return documents.filter(d => (d.tenantId || 'kindev') === tenant).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
}
export async function deliverWhatsAppLead(lead) {
  const eventId = lead.metaDelivery?.eventId || lead.eventId;
  try {
    const config = await loadTenantConfig(lead.tenantId || TENANT_ID);
    const result = await sendMetaEvent({
      eventName: 'Lead', phone: lead.phone, name: lead.name, leadId: lead.id, eventId,
      eventTime: Math.floor(new Date(lead.createdAt).getTime() / 1000), actionSource: 'business_messaging', ctwaClid: lead.ctwaClid
    }, config);
    const event = { eventName: 'Lead', date: new Date().toISOString(), fbtraceId: result.fbtraceId, eventId, testMode: result.testMode, actionSource: result.actionSource, eventsReceived: result.eventsReceived, tenantId: lead.tenantId || TENANT_ID, datasetId: result.datasetId };
    await appendMetaEvent(lead.id, lead.tenantId || TENANT_ID, event, { status: 'accepted', eventId, checkedAt: event.date, traceId: result.fbtraceId });
    console.log('[CAPI] Lead confirmado por Meta para ' + (lead.tenantId || TENANT_ID) + '.');
  } catch (e) {
    // Evento persistido para reintentar, conservando su ID y fecha originales.
    const latest = await readDocument('leads/' + lead.id);
    if (!latest || (latest.metaDelivery?.status === 'accepted' && latest.metaDelivery?.eventId === eventId)) return;
    await patchDocument('leads/' + lead.id, { metaDelivery: { status: 'pending', eventId, checkedAt: new Date().toISOString(), error: e.message } });
    console.warn('[CAPI] Lead pendiente para ' + (lead.tenantId || TENANT_ID) + ': ' + e.message);
  }
}
export async function saveWhatsAppLead(payload) {
  const phone = phoneNumber(payload.phone);
  if (phone.length < 8 || phone.length > 15) throw new Error('Número de WhatsApp no válido.');
  const effectiveTenant = requireTenant(payload.tenantId);
  const effectiveService = payload.service || (effectiveTenant === 'gabriel_miranda_gi1yk' ? 'Promoción Campaña ($50 USD)' : 'Contacto Meta Ads');

  const existing = await findPhoneLead(phone, effectiveTenant);
  const ctwaClid = payload.adInfo?.ctwaClid || '';
  if (existing) {
    const existingNotes = existing.notes ? `${existing.notes}\n[WhatsApp]: ${payload.message || ''}` : (payload.message || '');
    await patchDocument('leads/' + existing.id, {
      notes: existingNotes.slice(0, 1000),
      lastContactDate: new Date().toISOString(),
      ...(ctwaClid && !existing.ctwaClid ? { ctwaClid } : {})
    }, undefined);
    return { id: existing.id, created: false };
  }

  const id = 'wa_' + crypto.createHash('sha256').update(effectiveTenant + ':' + phone).digest('hex').slice(0, 40);
  const eventId = 'wa_lead_' + id;
  const lead = {
    name: String(payload.name || 'Cliente WhatsApp').slice(0, 100), phone, displayPhone: '+' + phone,
    service: effectiveService, notes: String(payload.message || '').slice(0, 500),
    status: 'prospecto', amount: effectiveTenant === 'gabriel_miranda_gi1yk' ? 50 : 0, createdAt: payload.receivedAt || new Date().toISOString(),
    source: payload.source || 'whatsapp_auto', tenantId: effectiveTenant, eventId, metaEvents: [], ...(ctwaClid ? { ctwaClid } : {}),
    metaDelivery: { status: 'pending', eventId }
  };
  try {
    await patchDocument('leads/' + id, lead, undefined);
    console.log(`🎉 [FIRESTORE] ¡Lead ${lead.name} (+${phone}) guardado con éxito en ${effectiveTenant}!`);
  } catch (e) {
    console.error(`❌ [FIRESTORE] Error guardando lead:`, e.message);
    const duplicate = await findPhoneLead(phone, effectiveTenant);
    if (duplicate) return { id: duplicate.id, created: false };
    throw e;
  }
  await deliverWhatsAppLead({ ...lead, id });
  return { id, created: true };
}
let retrying = false;
export async function retryPendingWhatsAppLeads() {
  if (retrying) return;
  retrying = true;
  try {
    const response = await firestoreFetch(DOCUMENTS_URL + ':runQuery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'leads' }],
        where: { fieldFilter: { field: { fieldPath: 'metaDelivery.status' }, op: 'EQUAL', value: { stringValue: 'pending' } } } } })
    });
    if (!response.ok) return;
    const leads = (await response.json()).filter(r => r.document).map(r => ({ ...decode({ mapValue: r.document }), id: r.document.name.split('/').pop() }));
    for (const lead of leads.filter(l => l.tenantId === TENANT_ID).slice(0, 30)) {
      if (Date.now() - new Date(lead.createdAt).getTime() > 7 * 86400000) {
        await patchDocument('leads/' + lead.id, { metaDelivery: { ...lead.metaDelivery, status: 'expired', error: 'Evento de más de 7 días; no se altera la fecha para reenviarlo.' } });
      } else await deliverWhatsAppLead(lead);
    }
  } catch (e) { console.warn('[CAPI retry]', e.message); }
  finally { retrying = false; }
}

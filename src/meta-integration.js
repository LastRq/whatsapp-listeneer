import crypto from 'node:crypto';
import { firestoreFetch, FIREBASE_PROJECT_ID } from './firebase-client.js';

export const GRAPH_VERSION = 'v21.0';
export const DOCUMENTS_URL = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents';
export const OFFICIAL_ORIGINS = new Set(['https://kindevads.com', 'https://www.kindevads.com', 'https://kindevads.web.app']);
export function decode(value) {
  if (value?.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decode(v)]));
  if (value?.arrayValue) return (value.arrayValue.values || []).map(decode);
  return value?.stringValue ?? value?.booleanValue ?? value?.integerValue ?? value?.doubleValue ?? value?.timestampValue ?? null;
}
export function encode(value) {
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)])) } };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}
export async function readDocument(path) {
  const res = await firestoreFetch(DOCUMENTS_URL + '/' + path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('No se pudo leer la configuración oficial de Firebase (' + res.status + ').');
  return decode({ mapValue: await res.json() });
}
export async function patchDocument(path, data, exists = true) {
  const query = new URLSearchParams();
  for (const key of Object.keys(data)) query.append('updateMask.fieldPaths', key);
  if (exists !== undefined) query.set('currentDocument.exists', String(exists));
  const res = await firestoreFetch(DOCUMENTS_URL + '/' + path + '?' + query, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(encode(data).mapValue)
  });
  if (!res.ok) throw new Error('Firebase no confirmó el guardado (' + res.status + ').');
  return res;
}
export async function appendMetaEvent(leadId, tenantId, event, delivery) {
  const current = await readDocument('leads/' + leadId);
  if (!current || (current.tenantId || 'kindev') !== tenantId) throw new Error('El contacto no pertenece a esta cuenta.');
  const response = await firestoreFetch(DOCUMENTS_URL + ':commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [{
      update: { name: DOCUMENTS_URL.replace('https://firestore.googleapis.com/v1/', '') + '/leads/' + leadId, fields: { metaDelivery: encode(delivery) } },
      updateMask: { fieldPaths: ['metaDelivery'] }, currentDocument: { exists: true },
      updateTransforms: [{ fieldPath: 'metaEvents', appendMissingElements: { values: [encode(event)] } }]
    }] })
  });
  if (!response.ok) throw new Error('Firebase no confirmó el registro del evento.');
}
export function selectTenantConfig(tenantId, master, clients = []) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tenantId || '')) throw new Error('Cuenta no válida.');
  if (tenantId === 'kindev') return {
    ...master, tenantId, datasetId: master?.datasetId || '1368429478371391',
    accessToken: master?.capiToken || master?.accessToken || master?.userToken || '',
    marketingToken: master?.marketingToken || master?.userToken || ''
  };
  const client = clients.find(c => c.id === tenantId);
  if (!client) throw new Error('Cuenta no encontrada.');
  return { ...client.metaConfig, tenantId, datasetId: client.metaConfig?.datasetId || '', accessToken: client.metaConfig?.accessToken || '' };
}
export async function loadTenantConfig(tenantId) {
  if (tenantId === 'kindev') return selectTenantConfig(tenantId, await readDocument('settings/meta_config'));
  const registry = await readDocument('settings/tenants_registry');
  return selectTenantConfig(tenantId, null, registry?.clients || []);
}
export function authorizeMeta(config, supplied) {
  const a = Buffer.from(String(config.accessToken || ''));
  const b = Buffer.from(String(supplied || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hash = s => crypto.createHash('sha256').update(String(s).normalize('NFC').trim().toLowerCase(), 'utf8').digest('hex');
export function phoneNumber(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.length === 10 && p.startsWith('09')) p = '593' + p.slice(1);
  else if (p.length === 9 && p.startsWith('9')) p = '593' + p;
  return p;
}
export function prepareMetaEvent(params, config, now = Date.now()) {
  if (!/^\d+$/.test(config.datasetId || '') || !config.accessToken?.trim()) throw new Error('Falta dataset o token de esta cuenta.');
  if (!['Lead', 'Contact', 'Purchase'].includes(params.eventName)) throw new Error('Evento no permitido.');
  const testMode = params.testMode === true || config.testMode === true;
  const testCode = String(params.testEventCode || config.testEventCode || '').trim();
  if (testMode && !testCode) throw new Error('Falta el código de Probar eventos; no se enviará a producción.');
  const eventId = String(params.eventId || '').trim();
  if (!eventId || eventId.length > 200) throw new Error('Se requiere un event_id estable.');
  const timestamp = params.eventTime !== undefined ? Number(params.eventTime) : Math.floor(now / 1000);
  if (!Number.isFinite(timestamp) || timestamp < now / 1000 - 7 * 86400 || timestamp > now / 1000 + 60) throw new Error('Fecha fuera del intervalo admitido por Meta.');
  let actionSource = params.actionSource || 'chat';
  if (!['chat', 'website', 'business_messaging', 'system_generated', 'other'].includes(actionSource)) throw new Error('Origen no válido.');
  // Baileys no siempre entrega CTWA. No fingimos atribución de mensajería cuando faltan identificadores.
  const businessMessaging = actionSource === 'business_messaging' && !!params.ctwaClid && !!(config.pageId || config.whatsappBusinessAccountId);
  if (actionSource === 'business_messaging' && !businessMessaging) actionSource = 'chat';
  const userData = {};
  const phone = phoneNumber(params.phone);
  if (phone) {
    if (phone.length < 8 || phone.length > 15) throw new Error('Teléfono no válido.');
    userData.ph = [hash(phone)];
  }
  if (params.email) userData.em = [hash(params.email)];
  const names = String(params.name || '').trim().split(/\s+/);
  if (names[0]) userData.fn = [hash(names[0])];
  const surname = params.lastName || names.slice(1).join(' ');
  if (surname) userData.ln = [hash(surname)];
  if (params.city) userData.ct = [hash(String(params.city).replace(/\s+/g, ''))];
  const country = params.countryCode || (phone.startsWith('593') ? 'ec' : '');
  if (country) userData.country = [hash(country)];
  if (params.leadId) userData.external_id = [hash(config.tenantId + ':' + params.leadId)];
  // Solo metadatos propios del contacto, nunca cookies/IP del operador del CRM.
  for (const [source, target] of [['fbc','fbc'], ['fbp','fbp'], ['clientIp','client_ip_address'], ['clientUserAgent','client_user_agent']]) {
    if (params[source]) userData[target] = String(params[source]);
  }
  if (!userData.ph && !userData.em && !businessMessaging) throw new Error('Falta teléfono o correo del contacto.');
  if (actionSource === 'website' && (!params.clientUserAgent || !params.eventSourceUrl)) throw new Error('Un evento web requiere URL y navegador reales del visitante.');
  if (businessMessaging) {
    userData.ctwa_clid = params.ctwaClid;
    if (config.pageId) userData.page_id = config.pageId;
    if (config.whatsappBusinessAccountId) userData.whatsapp_business_account_id = config.whatsappBusinessAccountId;
  }
  const event = { event_name: params.eventName, event_time: Math.floor(timestamp), event_id: eventId, action_source: actionSource, user_data: userData };
  if (businessMessaging) event.messaging_channel = 'whatsapp';
  if (actionSource === 'website') event.event_source_url = params.eventSourceUrl;
  if (params.eventName === 'Purchase') {
    const amount = Number(params.value);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Purchase requiere un importe real mayor a cero.');
    event.custom_data = { value: amount, currency: String(params.currency || 'USD').toUpperCase(), order_id: eventId };
    // No enviamos tratamientos, notas ni datos clínicos como contenido publicitario.
  }
  return { data: [event], ...(testMode ? { test_event_code: testCode } : {}) };
}
export async function graphRequest(path, token, { fetcher = fetch, ...options } = {}) {
  const res = await fetcher('https://graph.facebook.com/' + GRAPH_VERSION + '/' + path, {
    ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const error = new Error(data.error?.message || 'Meta respondió HTTP ' + res.status);
    error.code = data.error?.code; error.subcode = data.error?.error_subcode; error.traceId = data.error?.fbtrace_id;
    throw error;
  }
  return data;
}
export async function sendMetaEvent(params, config, dependencies = {}) {
  const body = prepareMetaEvent(params, config, dependencies.now?.() || Date.now());
  const data = await graphRequest(config.datasetId + '/events', config.accessToken, { ...dependencies, method: 'POST', body: JSON.stringify(body) });
  if (!(Number(data.events_received) > 0)) throw new Error('Meta no confirmó la recepción del evento.');
  return {
    tenantId: config.tenantId, datasetId: config.datasetId, eventsReceived: Number(data.events_received),
    fbtraceId: data.fbtrace_id || '', warnings: data.messages || [], eventId: body.data[0].event_id, actionSource: body.data[0].action_source,
    testMode: !!body.test_event_code, checkedAt: new Date().toISOString()
  };
}
export async function checkMetaConfig(config) {
  const base = { tenantId: config.tenantId, datasetId: config.datasetId, checkedAt: new Date().toISOString(), testMode: !!config.testMode, testCodePresent: !!config.testEventCode };
  if (!config.datasetId || !config.accessToken) return { ...base, tokenStatus: 'unconfigured', capiStatus: 'unconfigured', message: 'Falta dataset o token de esta cuenta.' };
  try {
    await graphRequest('me?fields=id', config.accessToken);
    return { ...base, tokenStatus: 'valid', capiStatus: 'unverified', message: 'Token válido. Confirma la recepción CAPI con Probar eventos; los permisos de lectura y envío son distintos.' };
  } catch (e) {
    return { ...base, tokenStatus: e.code === 190 ? 'expired' : 'error', capiStatus: 'error', message: e.message, code: e.code, subcode: e.subcode };
  }
}
function actions(row, name) { return Number((row.actions || []).find(a => a.action_type === name)?.value || 0); }
export async function fetchTenantInsights(config) {
  const token = config.marketingToken || config.accessToken;
  let account = String(config.adAccountId || '').replace(/^act_/, '');
  if (!account) {
    const accounts = await graphRequest('me/adaccounts?fields=id,name&limit=25', token);
    if (accounts.data?.length !== 1) throw new Error('Configura el ID de la cuenta publicitaria y un token con ads_read para esta cuenta.');
    account = accounts.data[0].id.replace(/^act_/, '');
  }
  if (!/^\d+$/.test(account)) throw new Error('Cuenta publicitaria no válida.');
  const scope = config.campaignId || 'act_' + account;
  if (!/^(act_)?\d+$/.test(scope)) throw new Error('Campaña no válida.');
  const fields = 'spend,impressions,reach,frequency,clicks,cpc,cpm,actions';
  const [main, platforms] = await Promise.all([
    graphRequest(scope + '/insights?date_preset=this_month&fields=' + fields, token),
    graphRequest(scope + '/insights?date_preset=this_month&breakdowns=publisher_platform&fields=spend,impressions,clicks,actions', token)
  ]);
  const r = main.data?.[0] || {};
  const messages = actions(r, 'onsite_conversion.messaging_conversation_started_7d');
  return {
    tenantId: config.tenantId, isLive: true, lastSync: new Date().toISOString(), adAccountId: account, period: 'this_month',
    campaign: { id: config.campaignId || '', name: config.campaignId ? 'Campaña configurada' : 'Cuenta publicitaria · mes actual',
      spend: Number(r.spend || 0), impressions: Number(r.impressions || 0), reach: Number(r.reach || 0),
      frequency: Number(r.frequency || 0), clicks: Number(r.clicks || 0), cpc: Number(r.cpc || 0), cpm: Number(r.cpm || 0),
      messagingConnections: messages, firstReplies: actions(r, 'onsite_conversion.messaging_first_reply'),
      depth2Replies: 0, depth5Replies: 0, linkClicks: actions(r, 'link_click'),
      costPerMessage: messages ? Number(r.spend || 0) / messages : 0, dropRatePercent: 0 },
    platforms: (platforms.data || []).map(p => { const n = actions(p, 'onsite_conversion.messaging_conversation_started_7d'); return {
      platform: p.publisher_platform, spend: Number(p.spend || 0), impressions: Number(p.impressions || 0),
      clicks: Number(p.clicks || 0), messages: n, costPerMessage: n ? Number(p.spend || 0) / n : 0, conversionRatePercent: 0 }; }),
    activeAd: { id: '', name: '', status: '', priceAnchor: '', title: '', bodySnippet: '' },
    killSwitch: { enabled: false, maxCostPerMessage: 0, maxSpendWithoutLead: 0, currentCost: 0, statusText: 'Sin automatización de anuncios' }
  };
}
export function installMetaRoutes(app, { loadConfig = loadTenantConfig, sendEvent = sendMetaEvent, checkConfig = checkMetaConfig, fetchInsights = fetchTenantInsights } = {}) {
  app.use('/api/meta', (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !OFFICIAL_ORIGINS.has(origin)) return res.status(403).json({ error: 'Origen no permitido.' });
    if (origin) res.set('Access-Control-Allow-Origin', origin).vary('Origin');
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Headers', 'Content-Type,X-Meta-Token');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api/meta/:tenantId', async (req, res, next) => {
    try {
      const config = await loadConfig(req.params.tenantId);
      if (!authorizeMeta(config, req.get('X-Meta-Token'))) return res.status(401).json({ error: 'No hay credenciales válidas para esta cuenta.' });
      req.metaConfig = config; next();
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/meta/:tenantId/status', async (req, res) => {
    try { res.json(await checkConfig(req.metaConfig)); } catch { res.status(502).json({ error: 'No se pudo consultar Meta.' }); }
  });
  app.get('/api/meta/:tenantId/insights', async (req, res) => {
    try { res.json(await fetchInsights(req.metaConfig)); }
    catch (e) { res.status(502).json({ error: e.message, code: e.code, traceId: e.traceId, tenantId: req.metaConfig.tenantId }); }
  });
  app.post('/api/meta/:tenantId/events', async (req, res) => {
    try {
      // El dataset y las credenciales siempre vienen del registro de esta cuenta.
      if (req.body.datasetId && req.body.datasetId !== req.metaConfig.datasetId) throw new Error('El dataset no pertenece a esta cuenta.');
      const params = req.body.params || {};
      res.json(await sendEvent(params, req.metaConfig));
    } catch (e) { res.status(422).json({ error: e.message, code: e.code, subcode: e.subcode, traceId: e.traceId, tenantId: req.metaConfig.tenantId }); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { selectTenantConfig, authorizeMeta, prepareMetaEvent, sendMetaEvent, installMetaRoutes } from '../src/meta-integration.js';
const cfg = { tenantId: 'miranda', datasetId: '222', accessToken: 'miranda-secret', testMode: false };
const params = { eventName: 'Lead', phone: '0991234567', name: 'José Muñoz', eventId: 'lead-1', actionSource: 'chat' };
test('client config never falls back to master and master CAPI is separate from Marketing', () => {
 const master = { userToken: 'expired-marketing', capiToken: 'valid-capi' };
 const clients = [{ id: 'miranda', metaConfig: { datasetId: '222', accessToken: '' } }];
 assert.equal(selectTenantConfig('kindev', master).accessToken, 'valid-capi');
 assert.equal(selectTenantConfig('kindev', master).marketingToken, 'expired-marketing');
 assert.equal(selectTenantConfig('miranda', master, clients).accessToken, '');
 assert.throws(() => selectTenantConfig('other', master, clients), /no encontrada/);
});
test('credentials of another account cannot authorize CAPI', () => {
 assert.equal(authorizeMeta(cfg, 'kindev-secret'), false);
 assert.equal(authorizeMeta(cfg, ''), false);
 assert.equal(authorizeMeta(cfg, cfg.accessToken), true);
});
test('missing tenant token or test code fails before sending', () => {
 assert.throws(() => prepareMetaEvent(params, { ...cfg, accessToken: '' }), /Falta/);
 assert.throws(() => prepareMetaEvent({ ...params, testMode: true }, cfg), /código/);
 assert.throws(() => prepareMetaEvent({ ...params, testMode: false }, { ...cfg, testMode: true }), /código/);
});
test('test traffic is marked only at request level and retains its stable event ID', () => {
 const body = prepareMetaEvent({ ...params, testMode: true, testEventCode: 'TEST-CURRENT' }, cfg);
 assert.equal(body.test_event_code, 'TEST-CURRENT');
 assert.equal(body.data[0].event_id, 'lead-1');
 assert.equal(body.data[0].test_event_code, undefined);
});
test('no guessed city, operator browser, cookies or customer treatment is transmitted', () => {
 const body = prepareMetaEvent({ ...params, eventName: 'Purchase', value: 50, service: 'Private clinical information' }, cfg);
 const e = body.data[0];
 assert.equal(e.action_source, 'chat');
 for (const field of ['ct','fbp','fbc','client_user_agent','client_ip_address']) assert.equal(e.user_data[field], undefined);
 assert.equal(e.user_data.ph[0].length, 64);
 assert.equal(e.custom_data.value, 50);
 assert.equal(e.custom_data.content_name, undefined);
 assert.equal(JSON.stringify(body).includes('José'), false);
});
test('Purchase never invents a value and dates are not moved to evade the API window', () => {
 assert.throws(() => prepareMetaEvent({ ...params, eventName: 'Purchase' }, cfg), /importe real/);
 assert.throws(() => prepareMetaEvent({ ...params, eventName: 'Purchase', value: -1 }, cfg), /importe real/);
 assert.throws(() => prepareMetaEvent({ ...params, eventTime: Math.floor(Date.now()/1000)-8*86400 }, cfg), /Fecha/);
});
test('CTWA attribution requires actual click and business identifiers; otherwise uses chat', () => {
 assert.equal(prepareMetaEvent({ ...params, actionSource: 'business_messaging' }, cfg).data[0].action_source, 'chat');
 const event = prepareMetaEvent({ ...params, actionSource: 'business_messaging', ctwaClid: 'real-click' }, { ...cfg, pageId: '123' }).data[0];
 assert.equal(event.action_source, 'business_messaging'); assert.equal(event.messaging_channel, 'whatsapp');
 assert.equal(event.user_data.ctwa_clid, 'real-click'); assert.equal(event.user_data.page_id, '123');
});
test('API acceptance requires a positive events_received; token is never in the URL', async () => {
 let requested;
 const fetcher = async (url, options) => { requested = { url, options }; return Response.json({ events_received: 1, fbtrace_id: 'trace' }); };
 const res = await sendMetaEvent(params, cfg, { fetcher });
 assert.equal(res.tenantId, 'miranda'); assert.equal(res.eventsReceived, 1);
 assert.equal(requested.url, 'https://graph.facebook.com/v21.0/222/events');
 assert.equal(requested.options.headers.Authorization, 'Bearer miranda-secret');
 await assert.rejects(sendMetaEvent(params, cfg, { fetcher: async()=>Response.json({ events_received: 0 }) }), /no confirmó/);
 await assert.rejects(sendMetaEvent(params, cfg, { fetcher: async()=>Response.json({ error: { message: 'expired', code:190 } }, {status:401}) }), /expired/);
});
test('gateway enforces account credential, ignores body credentials, rejects foreign datasets and supports official CORS', async () => {
 const app = express(); app.use(express.json());
 const received = [];
 installMetaRoutes(app, {
  loadConfig: async id => { if(id!=='miranda') throw Error('Cuenta no encontrada.'); return cfg; },
  sendEvent: async (p,c) => { received.push(c); return {tenantId:c.tenantId,datasetId:c.datasetId,eventsReceived:1}; }
 });
 const server = app.listen(0, '127.0.0.1'); await once(server,'listening');
 const base = 'http://127.0.0.1:' + server.address().port + '/api/meta/miranda/events';
 try {
  const preflight = await fetch(base,{method:'OPTIONS',headers:{Origin:'https://kindevads.com'}});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://kindevads.com');
  assert.equal((await fetch(base,{method:'POST',headers:{'X-Meta-Token':'kindev-secret'}})).status,401);
  assert.equal((await fetch(base,{method:'POST',headers:{'X-Meta-Token':cfg.accessToken,Origin:'https://foreign.example'}})).status,403);
  const headers = {'X-Meta-Token':cfg.accessToken,'Content-Type':'application/json'};
  assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify({datasetId:'111',params})})).status,422);
  const accepted = await fetch(base,{method:'POST',headers,body:JSON.stringify({datasetId:'222',accessToken:'injected',params})});
  assert.equal(accepted.status,200); assert.equal(received.length,1); assert.equal(received[0].accessToken,cfg.accessToken);
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
import { extractMetaAdInfo } from '../src/meta-ad-info.js';
import { summarizeOutbound } from '../src/outbound-tracker.js';
import { TENANT_ID } from '../src/firebase-client.js';
test('native Baileys CTWA click is kept exactly and never invented from opaque ctwaPayload',()=>{
 const info=extractMetaAdInfo({message:{extendedTextMessage:{contextInfo:{externalAdReply:{title:'Ad',ctwaClid:'native-click'}}}}});
 assert.equal(info.ctwaClid,'native-click');
 assert.equal(extractMetaAdInfo({message:{conversation:'Hello'}}),null);
 const opaque=extractMetaAdInfo({message:{extendedTextMessage:{contextInfo:{ctwaPayload:new Uint8Array([1,2])}}}});
 assert.equal(opaque.ctwaClid,'');
});
test('outbound summary excludes other tenants and does not expose message bodies',()=>{
 const own={tenantId:TENANT_ID,phone:'593000000000',outboundTracking:{firstSentAt:10,lastSentAt:20,replyCount:2,snippet:'private'}};
 const foreign={...own,tenantId:TENANT_ID+'_other'};
 const stats=summarizeOutbound([own,foreign],100);
 assert.equal(stats.totalProspected,1);assert.equal(stats.entries.length,1);
 assert.equal(stats.entries[0].snippet,'');assert.equal(stats.replied,1);
});

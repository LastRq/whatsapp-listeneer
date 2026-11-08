import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenantIngestion, createSupabaseRequest } from '../src/tenant-ingestion.js';

function harness() {
  const rows = [];
  let unavailable = false;
  const request = async (resource, options = {}) => {
    if (unavailable) throw new Error('database unavailable');
    const url = new URL('https://db.test/' + resource);
    const tenant = url.searchParams.get('tenant_id')?.slice(3);
    if (options.method === 'POST') { rows.push(structuredClone(options.body)); return [structuredClone(options.body)]; }
    const matching = rows.filter(row => row.tenant_id === tenant && (!url.searchParams.has('id') || row.id === url.searchParams.get('id').slice(3)));
    if (options.method === 'PATCH') { for (const row of matching) Object.assign(row, options.body); }
    return structuredClone(matching);
  };
  const events = [];
  const ingestion = createTenantIngestion({ request, deliver: async row => events.push(row), now: () => '2026-11-08T20:00:00.000Z' });
  return { rows, events, ingestion, fail: value => { unavailable = value; } };
}
const contact = { phone: '593987654321', name: 'Contact', message: 'Hola' };

test('the same phone and message id in two accounts create isolated records', async () => {
  const h = harness();
  await Promise.all(['kindev', 'gabriel_miranda_gi1yk', 'alexandro_r__osori_xityd'].map(tenantId => h.ingestion.save({ ...contact, tenantId, messageId: 'SAME' })));
  assert.equal(h.rows.length, 3);
  assert.equal(new Set(h.rows.map(r => r.id)).size, 3);
  assert.deepEqual(h.events.map(r => r.tenant_id).sort(), ['alexandro_r__osori_xityd', 'gabriel_miranda_gi1yk', 'kindev']);
});
test('a message updates only the receiving tenant, preserving sale status and amount', async () => {
  const h = harness();
  await h.ingestion.save({ ...contact, tenantId: 'kindev', messageId: 'A' });
  await h.ingestion.save({ ...contact, tenantId: 'miranda', messageId: 'A' });
  h.rows[0].status = 'cerrado'; h.rows[0].amount = 200;
  await h.ingestion.save({ ...contact, tenantId: 'kindev', message: 'Segundo mensaje', messageId: 'B' });
  assert.match(h.rows[0].notes, /Segundo mensaje/);
  assert.doesNotMatch(h.rows[1].notes, /Segundo mensaje/);
  assert.equal(h.rows[0].status, 'cerrado'); assert.equal(h.rows[0].amount, 200);
  assert.equal(h.events.length, 2);
});
test('concurrent messages preserve both messages and create one lead', async () => {
  const h = harness();
  await Promise.all(['A', 'B', 'C'].map(messageId => h.ingestion.save({ ...contact, tenantId: 'kindev', messageId })));
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.rows[0].whatsapp_message_ids, ['A', 'B', 'C']);
  assert.doesNotMatch(h.rows[0].notes, /\[wa:/);
  assert.equal(h.events.length, 1);
});
test('replaying a confirmed message does not append its text again', async () => {
  const h = harness();
  const payload = { ...contact, tenantId: 'kindev', messageId: 'A' };
  await h.ingestion.save(payload); const before = h.rows[0].notes;
  await h.ingestion.save(payload); assert.equal(h.rows[0].notes, before);
});
test('storage failure is not reported as success and the message can be retried', async () => {
  const h = harness(); h.fail(true);
  await assert.rejects(h.ingestion.save({ ...contact, tenantId: 'kindev', messageId: 'A' }));
  assert.equal(h.events.length, 0);
  h.fail(false); assert.equal((await h.ingestion.save({ ...contact, tenantId: 'kindev', messageId: 'A' })).saved, true);
});
test('missing or malformed tenants never fall back to another account', async () => {
  const h = harness();
  for (const tenantId of [undefined, '', '../kindev', 'KINDEV', 'a/b']) await assert.rejects(h.ingestion.save({ ...contact, tenantId }));
  assert.equal(h.rows.length, 0);
});
test('CAPI failure cannot prevent CRM capture and pending delivery is durable', async () => {
  const h = harness();
  const result = await h.ingestion.save({ ...contact, tenantId: 'miranda' });
  assert.equal(result.saved, true); assert.equal(h.rows[0].meta_delivery.status, 'pending');
});
test('Supabase errors and empty writes are never accepted as successful writes', async () => {
  const request = createSupabaseRequest('https://db.test', 'private-key', async () => new Response('{}', { status: 403 }));
  await assert.rejects(request('leads', { method: 'POST', body: {} }));
  const empty = createTenantIngestion({ request: async () => [] });
  await assert.rejects(empty.save({ ...contact, tenantId: 'kindev' }));
});
test('a real incoming placeholder creates a visible contact and the same id later accepts its content', async () => {
  const h = harness();
  const payload = { ...contact, tenantId: 'kindev', messageId: 'P', receivedAt: '2026-11-08T19:00:00.000Z' };
  await h.ingestion.save({ ...payload, placeholder: true });
  assert.equal(h.rows.length, 1); assert.equal(h.events.length, 0);
  assert.equal(h.rows[0].meta_delivery.status, 'waiting_message');
  assert.match(h.rows[0].notes, /contenido pendiente/);
  assert.deepEqual(h.rows[0].whatsapp_message_ids, []);
  const id = h.rows[0].id;
  await h.ingestion.save({ ...payload, message: 'Contenido real recuperado' });
  assert.equal(h.rows[0].id, id); assert.equal(h.rows[0].created_at, payload.receivedAt);
  assert.match(h.rows[0].notes, /Contenido real recuperado/);
  assert.doesNotMatch(h.rows[0].notes, /contenido pendiente/);
  assert.deepEqual(h.rows[0].whatsapp_message_ids, ['P']);
  assert.equal(h.events.length, 1);
});
test('history and diagnostic recovery save content without sending a new production conversion', async () => {
  const h = harness();
  await h.ingestion.save({ ...contact, tenantId: 'kindev', messageId: 'P', placeholder: true });
  await h.ingestion.save({ ...contact, tenantId: 'kindev', messageId: 'P', suppressMeta: true, suppressReason: 'history_recovery' });
  assert.equal(h.events.length, 0);
  assert.equal(h.rows[0].meta_delivery.status, 'skipped');
  assert.equal(h.rows[0].meta_delivery.reason, 'history_recovery');
});

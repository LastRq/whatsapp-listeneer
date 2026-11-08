import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kindev-ingestion-'));
process.env.NODE_ENV = 'test';
process.env.AUTH_DATA_DIR = temporary;
process.env.SUPABASE_URL = 'https://database.test';
process.env.SUPABASE_KEY = 'test-private-key';
process.env.ADMIN_KEY = 'test-admin';
const network = globalThis.fetch;
const rows = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === '127.0.0.1') return network(input, options);
  if (url.hostname !== 'database.test') return new Response('{}', { status: 503 });
  if (url.pathname === '/auth/v1/user') return Response.json({id:'client-user'});
  if (url.pathname === '/rest/v1/tenant_memberships') return Response.json([{tenant_id:'client_a',role:'client'}]);
  const tenant = url.searchParams.get('tenant_id')?.slice(3);
  const body = options.body && JSON.parse(options.body);
  if (options.method === 'POST') { rows.push(body); return Response.json([body]); }
  const matching = rows.filter(row => row.tenant_id === tenant && (!url.searchParams.has('id') || row.id === url.searchParams.get('id').slice(3)));
  if (options.method === 'PATCH') for (const row of matching) Object.assign(row, body);
  return Response.json(matching);
};
let server;
try {
  const { app, processIncomingMessage } = await import('../src/index.js');
  const makeMessage = (id, text = 'Quiero información') => ({ key: { id, remoteJid: '593987654321@s.whatsapp.net' },
    message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Contact' });
  const socket = { user: { id: '593999999999:1@s.whatsapp.net' } };
  const results = await Promise.all(['kindev', 'gabriel_miranda_gi1yk'].map(tenant => processIncomingMessage(socket, makeMessage('SAME'), 'live', tenant)));
  assert.ok(results.every(result => result.saved)); assert.equal(rows.length, 2);
  await processIncomingMessage(socket, makeMessage('SECOND', 'Soy veterinario, gracias por comunicarte'), 'live', 'kindev');
  assert.match(rows.find(row => row.tenant_id === 'kindev').notes, /Soy veterinario/);
  assert.doesNotMatch(rows.find(row => row.tenant_id === 'gabriel_miranda_gi1yk').notes, /Soy veterinario/);
  const replay = await processIncomingMessage(socket, makeMessage('SAME'), 'retry', 'kindev');
  assert.equal(replay.reason, 'already_processed_msg');
  const unresolved = await processIncomingMessage(socket, { ...makeMessage('LID'), key: { id: 'LID', remoteJid: '1234567890123456@lid' } }, 'live', 'kindev');
  assert.equal(unresolved.reason, 'unresolved_lid');
  const alt = await processIncomingMessage(socket, { ...makeMessage('ALT'), key: { id: 'ALT', remoteJid: '1234567890123456@lid', remoteJidAlt: '593988888888@s.whatsapp.net' } }, 'live', 'kindev');
  assert.equal(alt.saved, true);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const status = await (await network(base + '/api/status?tenant=kindev')).json();
  assert.equal(status.version, 'tenant-ingestion-20261108-placeholder-recovery');
  assert.equal(status.ingestion.saved, 3);
  const hosted = await processIncomingMessage(socket, { ...makeMessage('HOSTED'), key: { id: 'HOSTED', remoteJid: '593987654321@hosted' } }, 'live', 'hosted_client');
  assert.equal(hosted.saved, true);
  const hostedLid = await processIncomingMessage(socket, { ...makeMessage('HOSTED_LID'), key: { id: 'HOSTED_LID', remoteJid: '1234567@hosted.lid', remoteJidAlt: '593987654321@hosted' } }, 'live', 'hosted_lid_client');
  assert.equal(hostedLid.saved, true);
  for (const route of ['/api/whatsapp/chat/593987654321?tenant=kindev', '/api/whatsapp/disconnect?tenant=kindev', '/api/whatsapp/outbound-tracker-full']) {
    assert.equal((await network(base + route)).status, 401);
  }
  const mixed = await network(base + '/api/whatsapp/relink?tenant=client_a&ticket=invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({tenantId:'kindev'}) });
  assert.equal(mixed.status,400);
  const blacklist = await network(base + '/api/blacklist/add?tenantId=client_a', { method: 'POST', headers: { Authorization:'Bearer verified-client', 'Content-Type':'application/json' }, body: JSON.stringify({phone:'593987654321'}) });
  assert.equal(blacklist.status,200);
  assert.equal((await blacklist.json()).entry.tenantId,'client_a');
  const conflict = await network(base + '/api/blacklist/add?tenant=client_a', { method:'POST', headers:{Authorization:'Bearer verified-client','Content-Type':'application/json'}, body:JSON.stringify({tenantId:'kindev',phone:'593987654321'}) });
  assert.equal(conflict.status,400);
  const own = await (await network(base + '/api/whatsapp/chat/593987654321?tenant=kindev', { headers: { 'x-admin-key': 'test-admin' } })).json();
  assert.ok(own.messages.length > 0);
  console.log('RUNTIME_OK: socket ingestion, tenant isolation, LID resolution, truthful status and protected APIs');
} finally {
  server?.close();
  globalThis.fetch = network;
  // Remove only the exact temporary test directory created above.
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDurableInbox } from '../src/durable-inbox.js';
import { createTenantIngestion } from '../src/tenant-ingestion.js';
test('unconfirmed writes survive restart and replay only into their original account', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kindev-inbox-'));
  try {
    const payload = { tenantId: 'client_a', phone: '593987654321', messageId: 'A', message: 'Hola' };
    const offline = createTenantIngestion({ inbox: createDurableInbox(directory), request: async () => { throw new Error('offline'); } });
    await assert.rejects(offline.save(payload));
    assert.equal(createDurableInbox(directory).pending().length, 1);
    const requests = [];
    const restarted = createTenantIngestion({ inbox: createDurableInbox(directory), request: async (url, options = {}) => {
      requests.push({ url, options });
      return options.method === 'POST' ? [options.body] : [];
    } });
    await restarted.drain();
    assert.ok(requests[0].url.includes('tenant_id=eq.client_a'));
    assert.equal(requests[1].options.body.tenant_id, 'client_a');
    assert.equal(createDurableInbox(directory).pending().length, 0);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

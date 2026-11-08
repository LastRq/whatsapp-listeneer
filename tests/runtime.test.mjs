import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
test('actual listener captures messages per socket and protects legacy APIs', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./runtime-fixture.mjs', import.meta.url))], { timeout: 15000 });
  assert.match(stdout, /RUNTIME_OK/);
});

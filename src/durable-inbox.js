import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireTenant, tenantKey } from './tenant-ingestion.js';

export function createDurableInbox(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    put(payload) {
      const tenant = requireTenant(payload.tenantId);
      const id = crypto.createHash('sha256').update(tenantKey(tenant, payload.messageId || JSON.stringify(payload))).digest('hex');
      const file = path.join(directory, id + '.json');
      const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(temporary, file);
      return file;
    },
    remove(file) { fs.rmSync(file, { force: true }); },
    pending() {
      return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        try { return [JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))]; }
        catch { console.warn('[Inbox] No se pudo leer una entrada pendiente.'); return []; }
      });
    }
  };
}

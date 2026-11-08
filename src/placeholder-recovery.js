import { proto } from '@whiskeysockets/baileys';
import { tenantKey } from './tenant-ingestion.js';

// A peer-data response comes from our own primary phone. Its wrapper is
// outgoing, but the recovered customer message is incoming to this same tenant.
export function recoverPeerMessages(envelope, findOriginal) {
  if (!envelope.key?.fromMe) return [];
  const response = envelope.message?.protocolMessage?.peerDataOperationRequestResponseMessage;
  const recovered = [];
  for (const result of response?.peerDataOperationResult || []) {
    const bytes = result.placeholderMessageResendResponse?.webMessageInfoBytes;
    if (!bytes?.length) continue;
    try {
      const decoded = proto.WebMessageInfo.decode(bytes);
      const original = findOriginal(decoded.key?.id);
      if (!original || original.key.fromMe || !decoded.message) continue;
      recovered.push({ ...original, message: decoded.message,
        messageTimestamp: decoded.messageTimestamp || original.messageTimestamp,
        messageStubType: undefined, messageStubParameters: [] });
    } catch { /* Keep the original pending; never invent content. */ }
  }
  return recovered;
}

export function createPlaceholderRecovery({ inbox, getSocket, onMetric = () => {}, now = Date.now }) {
  const pending = new Map();
  const inFlight = new Set();
  for (const record of inbox.pending()) if (record.key?.id && record.tenantId) pending.set(tenantKey(record.tenantId, record.key.id), record);
  function remember(tenantId, msg) {
    const key = tenantKey(tenantId, msg.key.id);
    const record = pending.get(key) || { tenantId, messageId: msg.key.id, key: msg.key,
      messageTimestamp: Number(msg.messageTimestamp || Math.floor(now() / 1000)), pushName: msg.pushName || '', attempts: 0, nextRetryAt: 0 };
    pending.set(key, record); inbox.put(record);
    return record;
  }
  async function request(record, force = false) {
    const key = tenantKey(record.tenantId, record.key.id);
    const sock = getSocket(record.tenantId);
    if (!sock?.requestPlaceholderResend || inFlight.has(key) || (!force && (record.attempts >= 10 || record.nextRetryAt > now()))) return;
    inFlight.add(key);
    try {
      const alternate = record.key.remoteJidAlt;
      const requestKey = record.attempts % 2 === 1 && alternate?.endsWith('@s.whatsapp.net')
        ? { ...record.key, remoteJid: alternate, remoteJidAlt: record.key.remoteJid }
        : record.key;
      record.attempts++; record.nextRetryAt = now() + Math.min(record.attempts * 30000, 5 * 60000);
      inbox.put(record);
      await sock.requestPlaceholderResend(requestKey, { key: record.key, messageTimestamp: record.messageTimestamp, pushName: record.pushName });
      onMetric(record.tenantId, 'placeholder_requested');
      // Some primary-phone versions look up message keys by PN rather than LID.
      // If single-message recovery is insufficient, request this own chat's
      // actual earlier history. The normal per-socket history handler ingests it.
      if (record.attempts >= 2 && !record.historyRequested && sock.fetchMessageHistory) {
        await sock.fetchMessageHistory(20, requestKey, record.messageTimestamp);
        record.historyRequested = true;
        inbox.put(record);
        onMetric(record.tenantId, 'placeholder_history_requested');
      }
    } catch { onMetric(record.tenantId, 'placeholder_request_failed'); }
    finally { inFlight.delete(key); }
  }
  return {
    remember,
    request,
    original(tenant, id) { return id ? pending.get(tenantKey(tenant, id)) : undefined; },
    complete(tenant, id) {
      const key = tenantKey(tenant, id);
      const record = pending.get(key);
      if (record) { inbox.remove(inbox.put(record)); pending.delete(key); }
    },
    count(tenant) { return [...pending.values()].filter(record => record.tenantId === tenant).length; },
    async retry() {
      for (const record of pending.values()) {
        if (now() - record.messageTimestamp * 1000 > 72 * 3600000) { this.complete(record.tenantId, record.key.id); continue; }
        await request(record);
      }
    }
  };
}

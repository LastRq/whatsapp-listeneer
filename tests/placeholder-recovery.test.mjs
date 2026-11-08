import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { recoverPeerMessages, createPlaceholderRecovery } from '../src/placeholder-recovery.js';
const original = { key: { id: 'A', remoteJid: '123@lid', remoteJidAlt: '593987654321@s.whatsapp.net', fromMe: false }, messageTimestamp: 1000, messageStubType: 2 };
function envelope(id = 'A') {
  const bytes = proto.WebMessageInfo.encode({ key: { id }, message: { conversation: 'Hola' } }).finish();
  return { key: { fromMe: true }, message: { protocolMessage: { peerDataOperationRequestResponseMessage: {
    peerDataOperationResult: [{ placeholderMessageResendResponse: { webMessageInfoBytes: bytes } }]
  } } } };
}
test('an outgoing peer wrapper recovers the original incoming message and its phone metadata', () => {
  const result = recoverPeerMessages(envelope(), id => id === 'A' ? original : null);
  assert.equal(result.length, 1); assert.equal(result[0].key.fromMe, false);
  assert.equal(result[0].key.remoteJidAlt, original.key.remoteJidAlt);
  assert.equal(result[0].message.conversation, 'Hola');
  assert.equal(result[0].messageStubType, undefined);
});
test('peer responses cannot invent an original message or accept another sender as our primary phone', () => {
  assert.deepEqual(recoverPeerMessages(envelope('OTHER'), id => id === 'A' ? original : null), []);
  const spoofed = envelope(); spoofed.key.fromMe = false;
  assert.deepEqual(recoverPeerMessages(spoofed, () => original), []);
});
test('pending placeholders and retries stay isolated by account even with the same message id', async () => {
  const records = new Map();
  const inbox = { pending: () => [], put: record => { const key = record.tenantId + ':' + record.messageId; records.set(key, record); return key; }, remove: key => records.delete(key) };
  const requests = [];
  const recovery = createPlaceholderRecovery({ inbox, getSocket: tenant => ({ requestPlaceholderResend: async key => requests.push([tenant, key.id]) }), now: () => 1000000 });
  const a = recovery.remember('client_a', original); recovery.remember('client_b', original);
  await recovery.request(a);
  assert.deepEqual(requests, [['client_a', 'A']]);
  recovery.complete('client_a', 'A');
  assert.equal(recovery.count('client_a'), 0); assert.equal(recovery.count('client_b'), 1);
  assert.equal(records.size, 1);
});

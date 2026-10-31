export function sessionDocumentPrefix(tenantId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tenantId)) throw new Error('Invalid tenant identifier.');
  // A length prefix makes even identifiers containing underscores unambiguous.
  return 'whatsapp_status_session_' + tenantId.length + '_' + tenantId + '_';
}
export function sessionDocumentId(fileName, tenantId) {
  return sessionDocumentPrefix(tenantId) + fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
}
export function sessionDocumentBelongsTo(docId, tenantId) {
  return docId.startsWith(sessionDocumentPrefix(tenantId));
}
export function safeSessionFileName(fileName) {
  if (typeof fileName !== 'string') return null;
  const safe = fileName.replace(/\//g, '__').replace(/:/g, '-');
  if (safe.includes('..') || safe.includes('\\') || !safe.endsWith('.json')) return null;
  return safe;
}

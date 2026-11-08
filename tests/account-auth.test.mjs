import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTenant, makeLinkTicket, verifyLinkTicket } from '../src/account-auth.js';
process.env.ADMIN_KEY = 'test-only-signing-key';
test('client identity cannot select another account or grant itself an administrator role', () => {
  const member = { tenantId: 'client_a', role: 'client' };
  assert.equal(authorizeTenant(member, 'client_a'), 'client_a');
  assert.throws(() => authorizeTenant(member, 'kindev'));
  assert.throws(() => authorizeTenant(member, undefined));
  assert.equal(authorizeTenant({ tenantId: 'kindev', role: 'superadmin' }, 'client_a'), 'client_a');
});
test('QR tickets bind account and expiration and cannot be forged using the old PIN', () => {
  const now = 1000000;
  const ticket = makeLinkTicket('client_a', 'user-a', now);
  assert.equal(verifyLinkTicket(ticket, 'client_a', now), true);
  assert.equal(verifyLinkTicket(ticket, 'client_b', now), false);
  assert.equal(verifyLinkTicket(ticket, 'client_a', now + 600001), false);
  assert.equal(verifyLinkTicket(ticket + 'x', 'client_a', now), false);
  assert.equal(verifyLinkTicket('KIN-3075', 'kindev', now), false);
  const [payload, signature] = ticket.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  claims.tenant = 'kindev';
  assert.equal(verifyLinkTicket(Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + signature, 'kindev', now), false);
});

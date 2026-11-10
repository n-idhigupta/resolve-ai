import { it, expect } from 'vitest';
import { loginDestination, loginSessionSchema } from './login-session.js';
const tenant = '10000000-0000-4000-8000-000000000091',
  other = '10000000-0000-4000-8000-000000000092';
const membership = { merchantId: tenant, role: 'AGENT' as const };
it('routes the canonical customer login to orders while preserving complaint deep links', () => {
  expect(loginDestination('customer', [], '/login')).toBe('/orders');
  expect(loginDestination('customer', [], '/complaints/case')).toBe(
    '/complaints/case',
  );
  expect(
    loginDestination('customer', [], '/merchant/' + other + '/cases'),
  ).toBe('/orders');
});
it('uses only returned memberships for merchant navigation', () => {
  expect(loginDestination('merchant', [], '/login')).toBeNull();
  expect(loginDestination('merchant', [membership], '/login')).toBe(
    '/merchant/' + tenant + '/cases',
  );
  expect(
    loginDestination('merchant', [membership], '/merchant/' + other + '/cases'),
  ).toBe('/merchant/' + tenant + '/cases');
  expect(
    loginDestination(
      'merchant',
      [membership],
      '/merchant/' + tenant + '/cases/case',
    ),
  ).toBe('/merchant/' + tenant + '/cases/case');
});
it('requires an explicit choice when there are multiple authorized workspaces', () => {
  const memberships = [
    membership,
    { merchantId: other, role: 'OWNER' as const },
  ];
  expect(loginDestination('merchant', memberships, '/login')).toBeNull();
  expect(loginDestination('merchant', memberships, '/login', other)).toBe(
    '/merchant/' + other + '/cases',
  );
  expect(
    loginDestination('merchant', memberships, '/login', 'unauthorized'),
  ).toBeNull();
});
it('rejects malformed tenant/role session responses before routing', () => {
  const session = {
    user: {
      id: '20000000-0000-4000-8000-000000000091',
      email: 'synthetic@resolveai.test',
    },
    csrfToken: 'synthetic',
    memberships: [membership],
  };
  expect(loginSessionSchema.safeParse(session).success).toBe(true);
  expect(
    loginSessionSchema.safeParse({
      ...session,
      memberships: [{ ...membership, role: 'SUPERADMIN' }],
    }).success,
  ).toBe(false);
  expect(
    loginSessionSchema.safeParse({
      ...session,
      memberships: [{ ...membership, merchantId: 'not-a-tenant-id' }],
    }).success,
  ).toBe(false);
});

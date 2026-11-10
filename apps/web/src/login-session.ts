import { roleSchema } from '@resolveai/shared';
import { z } from 'zod';
export const loginSessionSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email() }),
  csrfToken: z.string().min(1),
  memberships: z.array(z.object({ merchantId: z.uuid(), role: roleSchema })),
});
export type LoginSession = z.infer<typeof loginSessionSchema>;
export type LoginRole = 'customer' | 'merchant';
export function loginDestination(
  role: LoginRole,
  memberships: LoginSession['memberships'],
  requestedPath: string,
  merchantId?: string,
) {
  if (role === 'customer')
    return requestedPath.startsWith('/complaints/') ||
      requestedPath === '/complaints'
      ? requestedPath
      : '/orders';
  const membership =
    memberships.find((m) => m.merchantId === merchantId) ??
    (memberships.length === 1 ? memberships[0] : undefined);
  if (!membership) return null;
  const root = '/merchant/' + membership.merchantId;
  return requestedPath.startsWith(root + '/') ? requestedPath : root + '/cases';
}

import { PrismaClient, Prisma } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppError } from './errors.js';
export type Database = PrismaClient;
export type TenantTx = Prisma.TransactionClient;
export function createDatabase(url: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      connectionTimeoutMillis: 2000,
      max: 8,
    }),
  });
}
export async function assertSafeRuntime(db: Database) {
  const rows = await db.$queryRaw<
    Array<{ unsafe: boolean }>
  >`SELECT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid) OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) OR has_schema_privilege(current_user,'public','CREATE')) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`;
  if (rows[0]?.unsafe !== false) throw Error('Unsafe runtime database role');
  const policy = await db.$queryRaw<
    Array<{ unsafe: boolean }>
  >`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (c.relname='Merchant' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='merchantId' AND NOT a.attisdropped)) AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (c.relname='Merchant' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='merchantId' AND NOT a.attisdropped)))<27 AS unsafe`;
  if (policy[0]?.unsafe !== false)
    throw Error('Required RLS protections are missing');
}
export function withActorTransaction<T>(
  db: Database,
  userId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.user_id',${userId},true),set_config('app.merchant_id','',true)`;
      return work(tx);
    },
    { timeout: 5000 },
  );
}
export function withTenantTransaction<T>(
  db: Database,
  actor: { userId: string },
  merchantId: string,
  work: (tx: TenantTx) => Promise<T>,
  requireMerchant = false,
): Promise<T> {
  return withActorTransaction(db, actor.userId, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { merchantId, userId: actor.userId, active: true },
    });
    const ownership = membership
      ? true
      : !requireMerchant &&
        Boolean(
          await tx.customerOrder.findFirst({
            where: { merchantId, userId: actor.userId },
          }),
        );
    if (!membership && !ownership)
      throw new AppError(404, 'NOT_FOUND', 'Resource not found');
    await tx.$queryRaw`SELECT set_config('app.merchant_id',${merchantId},true)`;
    return work(tx);
  });
}

import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
export type Tx = PoolClient;
export class PaymentError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const hashPayload = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex');
export function encryptReceipt(raw: string, key: string) {
  const bytes = Buffer.from(key, 'hex');
  if (bytes.length !== 32)
    throw Error('A 32-byte hexadecimal webhook key is required');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', bytes, iv);
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return [
    'aes256gcm-v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}
export function decryptReceipt(value: string, key: string) {
  const [format, iv, tag, data] = value.split(':');
  if (format !== 'aes256gcm-v1' || !iv || !tag || !data)
    throw Error('Invalid receipt encoding');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
export class PaymentDatabase {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });
    this.pool.on('error', () => {});
  }
  async transaction<T>(
    merchantId: string | null,
    userId: string | null,
    work: (tx: Tx) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query(
        options.readOnly
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
          : 'BEGIN',
      );
      await tx.query(
        "SELECT set_config('app.merchant_id',$1,true),set_config('app.user_id',$2,true)",
        [merchantId ?? '', userId ?? ''],
      );
      const result = await work(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }
  async rows<T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }
  async assertWorker() {
    const rows = await this.rows<{ safe: boolean }>(
      `SELECT NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid) OR has_schema_privilege(current_user,'public','CREATE')) AND current_user IN ('resolve_payments','resolve_payments_test') AS safe FROM pg_roles r WHERE rolname=current_user`,
    );
    if (!rows[0]?.safe) throw Error('Unsafe payment worker role');
    const guard = await this.rows<{ safe: boolean }>(
      `SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) AND count(*)=15 AS safe FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('PaymentAccount','Order','CheckoutOperation','Capture','OutboxEvent','WebhookInbox','WebhookReceipt','OrderItem','PaymentAttempt','RefundOperation','Settlement','Proposal','Approval','Case','CaseTimelineEvent')`,
    );
    if (!guard[0]?.safe) throw Error('Payment RLS protections missing');
  }
  close() {
    return this.pool.end();
  }
}

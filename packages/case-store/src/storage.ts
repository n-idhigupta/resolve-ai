import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_QUARANTINE_BUCKET: z.string().min(1),
  S3_CLEAN_BUCKET: z.string().min(1),
});
export type StorageEnv = z.infer<typeof storageEnvSchema>;
export const sha = (b: Buffer | string) =>
  createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) =>
  createHmac('sha256', k).update(s).digest();
export class PrivateStorage {
  constructor(readonly env: StorageEnv) {}
  async request(method: string, bucket: string, key: string, body?: Buffer) {
    const url = new URL(
        '/' + [bucket, ...key.split('/')].map(encodeURIComponent).join('/'),
        this.env.S3_ENDPOINT,
      ),
      stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
      date = stamp.slice(0, 8),
      scope = `${date}/${this.env.S3_REGION}/s3/aws4_request`,
      hash = sha(body ?? Buffer.alloc(0));
    const headers = `host:${url.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${stamp}\n`,
      signed = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, url.pathname, '', headers, signed, hash].join(
      '\n',
    );
    const signing = hmac(
      hmac(
        hmac(
          hmac('AWS4' + this.env.S3_SECRET_ACCESS_KEY, date),
          this.env.S3_REGION,
        ),
        's3',
      ),
      'aws4_request',
    );
    const signature = createHmac('sha256', signing)
      .update(['AWS4-HMAC-SHA256', stamp, scope, sha(canonical)].join('\n'))
      .digest('hex');
    const result = await fetch(url, {
      method,
      headers: {
        'x-amz-date': stamp,
        'x-amz-content-sha256': hash,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!result.ok && !(method === 'DELETE' && result.status === 404))
      throw Error('STORAGE_' + result.status);
    return result;
  }
  async put(bucket: string, key: string, bytes: Buffer) {
    await this.request('PUT', bucket, key, bytes);
  }
  async get(bucket: string, key: string) {
    const r = await this.request('GET', bucket, key);
    const reader = r.body!.getReader();
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10485760) throw Error('FILE_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  async delete(bucket: string, key: string) {
    await this.request('DELETE', bucket, key);
  }
}

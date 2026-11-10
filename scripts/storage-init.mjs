import { config } from 'dotenv';
import { createHash, createHmac } from 'node:crypto';
config({ quiet: true });
const hash = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
export async function storageRequest(method, path) {
  const url = new URL(path, process.env.S3_ENDPOINT);
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8),
    region = process.env.S3_REGION ?? 'us-east-1',
    scope = `${date}/${region}/s3/aws4_request`,
    bodyHash = hash('');
  const headers = `host:${url.host}
x-amz-content-sha256:${bodyHash}
x-amz-date:${timestamp}
`;
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [method, url.pathname, '', headers, signed, bodyHash].join(
    '\n',
  );
  const signing = hmac(
    hmac(
      hmac(hmac('AWS4' + process.env.S3_SECRET_ACCESS_KEY, date), region),
      's3',
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', signing)
    .update(['AWS4-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n'))
    .digest('hex');
  return fetch(url, {
    method,
    headers: {
      'x-amz-date': timestamp,
      'x-amz-content-sha256': bodyHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(5000),
  });
}
for (const bucket of [
  process.env.S3_QUARANTINE_BUCKET,
  process.env.S3_CLEAN_BUCKET,
]) {
  if (!bucket) throw Error('Bucket configuration missing');
  const result = await storageRequest('PUT', '/' + bucket);
  if (!result.ok && result.status !== 409)
    throw Error(`Bucket creation failed: ${result.status}`);
  const anonymous = await fetch(new URL('/' + bucket, process.env.S3_ENDPOINT));
  if (anonymous.ok) throw Error('Anonymous bucket access is enabled');
}
console.log('Both local buckets initialized; anonymous listing denied.');

import { request as httpRequest } from 'node:http';
import type { Request } from '@playwright/test';
// Distinct loopback source addresses model independent browser clients without changing rate limits.
export async function forward(
  request: Request,
  port: number,
  sourceAddress: string,
  cookie: string,
) {
  const url = new URL(request.url()),
    headers: Record<string, string> = {
      ...(await request.allHeaders()),
      ...(cookie ? { cookie } : {}),
    };
  delete headers.host;
  return new Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    cookie: string;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: url.pathname + url.search,
        method: request.method(),
        localAddress: sourceAddress,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (b: Buffer) => chunks.push(b));
        response.on('end', () => {
          const output: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers))
            if (
              value !== undefined &&
              !['transfer-encoding', 'content-length', 'set-cookie'].includes(
                name,
              )
            )
              output[name] = Array.isArray(value) ? value.join(',') : value;
          resolve({
            status: response.statusCode ?? 500,
            headers: output,
            body: Buffer.concat(chunks),
            cookie:
              response.headers['set-cookie']?.[0]?.split(';')[0] ?? cookie,
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(request.postDataBuffer());
  });
}

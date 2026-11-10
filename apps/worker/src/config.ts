import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
if (process.env.RESOLVEAI_WORKER_ISOLATED !== 'true') {
  const local: Record<string, string> = {};
  config({
    processEnv: local,
    path: fileURLToPath(new URL('../../../.env', import.meta.url)),
    quiet: true,
  });
  delete local.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  for (const [k, v] of Object.entries(local))
    if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
}
export const workerEnvSchema = z.object({
  REDIS_URL: z
    .url()
    .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://')),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
});

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const localSettings: Record<string, string> = {};
config({
  processEnv: localSettings,
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
delete localSettings.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
for (const [k, v] of Object.entries(localSettings))
  if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
export const envSchema = z
  .object({
    AI_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
    AI_MODEL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .enum([
          'gpt-5.4-mini-2026-03-17',
          'gemini-2.5-flash',
          'gemini-3.5-flash-lite',
        ])
        .optional(),
    ),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WEB_ORIGIN: z.url(),
    DATABASE_URL: z.url().refine((v) => v.startsWith('postgresql://')),
    REDIS_URL: z
      .url()
      .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://')),
    SESSION_HASH_PEPPER: z.string().min(32),
    CSRF_SECRET: z.string().min(32),
    LOG_LEVEL: z
      .enum(['debug', 'info', 'warn', 'error', 'silent'])
      .default('info'),
    ENABLE_DEV_SEED: z.enum(['true', 'false']).default('false'),
    API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    PAYPAL_REFUNDS_ENABLED: z.enum(['true', 'false']).default('false'),
    PAYPAL_ENABLED: z.enum(['true', 'false']).default('false'),
    PAYPAL_ENVIRONMENT: z.literal('sandbox').default('sandbox'),
    PAYPAL_CLIENT_ID: z.string().optional(),
    PAYPAL_CLIENT_SECRET: z.string().optional(),
    PAYPAL_MERCHANT_ID: z.string().optional(),
    PAYPAL_WEBHOOK_ID: z
      .string()
      .regex(/^[a-zA-Z0-9]{1,50}$/)
      .optional(),
    WEBHOOK_PAYLOAD_ENCRYPTION_KEY: z.string().optional(),
  })
  .superRefine((v, c) => {
    if (
      v.AI_MODEL &&
      (v.AI_PROVIDER === 'gemini') !==
        ['gemini-2.5-flash', 'gemini-3.5-flash-lite'].includes(v.AI_MODEL)
    )
      c.addIssue({ code: 'custom', message: 'AI provider/model mismatch' });
    if (
      v.PAYPAL_ENABLED === 'true' &&
      (!v.PAYPAL_CLIENT_ID ||
        !v.PAYPAL_MERCHANT_ID ||
        !v.PAYPAL_WEBHOOK_ID ||
        !v.WEBHOOK_PAYLOAD_ENCRYPTION_KEY?.match(/^[a-f0-9]{64}$/))
    )
      c.addIssue({
        code: 'custom',
        message:
          'Enabled Sandbox checkout requires client/seller/webhook configuration and a 32-byte hexadecimal receipt key',
      });
    if (
      v.NODE_ENV === 'production' &&
      (v.PAYPAL_ENABLED === 'true' || v.PAYPAL_REFUNDS_ENABLED === 'true')
    )
      c.addIssue({
        code: 'custom',
        message: 'Sandbox and refund execution are forbidden in production',
      });
    if (v.NODE_ENV === 'production' && v.ENABLE_DEV_SEED === 'true')
      c.addIssue({
        code: 'custom',
        message: 'Development seed is forbidden in production',
      });
    if (v.NODE_ENV === 'production' && !v.WEB_ORIGIN.startsWith('https://'))
      c.addIssue({
        code: 'custom',
        message: 'Production origin requires HTTPS',
      });
  });
export type Env = z.infer<typeof envSchema>;
export function readEnv(input: Record<string, unknown> = process.env): Env {
  return envSchema.parse(input);
}

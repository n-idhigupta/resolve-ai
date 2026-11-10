import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { Env } from './config.js';
import { installErrors } from './errors.js';
export type Dependencies = {
  checkDatabase: () => Promise<unknown>;
  checkRedis: () => Promise<unknown>;
  close: () => Promise<void>;
};
export async function createApp(env: Env, deps: Dependencies) {
  const app = Fastify({
    bodyLimit: 65536,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
      ],
    },
  });
  installErrors(app);
  await app.register(cookie);
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/health', async (request) => ({
    data: { status: 'ok' },
    requestId: request.id,
  }));
  app.get('/ready', async (request, reply) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([deps.checkDatabase(), deps.checkRedis()]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('timeout')), 1500);
        }),
      ]);
      return { data: { status: 'ready' }, requestId: request.id };
    } catch {
      return reply
        .status(503)
        .send({ data: { status: 'unavailable' }, requestId: request.id });
    } finally {
      clearTimeout(timer);
    }
  });
  app.addHook('onClose', deps.close);
  return app;
}

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { hash, verify, argon2id } from 'argon2';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import { withActorTransaction } from './database.js';
import type { Env } from './config.js';
import { AppError } from './errors.js';
export const SESSION_COOKIE = 'resolveai_session';
export const hashPassword = (password: string) =>
  hash(password, {
    type: argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
export function tokenHash(token: string, env: Env) {
  return createHmac('sha256', env.SESSION_HASH_PEPPER)
    .update(token)
    .digest('hex');
}
export function csrfFor(hash: string, env: Env) {
  return createHmac('sha256', env.CSRF_SECRET).update(hash).digest('hex');
}
export function checkOrigin(request: FastifyRequest, env: Env) {
  if (request.headers.origin !== env.WEB_ORIGIN)
    throw new AppError(403, 'FORBIDDEN', 'Untrusted request origin');
}
export async function requireSession(
  request: FastifyRequest,
  db: Database,
  env: Env,
) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  const hashed = tokenHash(token, env);
  const session = await db.session.findUnique({ where: { tokenHash: hashed } });
  const now = new Date();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    now.getTime() - session.lastSeenAt.getTime() >= 1800000
  )
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== 'ACTIVE')
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  await db.session.update({
    where: { id: session.id },
    data: { lastSeenAt: now },
  });
  return { session, user };
}
export function checkCsrf(request: FastifyRequest, hashed: string, env: Env) {
  checkOrigin(request, env);
  const token = request.headers['x-csrf-token'];
  const expected = csrfFor(hashed, env);
  if (
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
  )
    throw new AppError(403, 'FORBIDDEN', 'Invalid CSRF token');
}
export async function registerAuth(
  app: FastifyInstance,
  db: Database,
  env: Env,
) {
  const dummy = await hashPassword(randomBytes(32).toString('hex'));
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      checkOrigin(request, env);
      const body = z
        .strictObject({
          email: z.email().max(254),
          password: z.string().min(1).max(256),
        })
        .parse(request.body);
      const user = await db.user.findUnique({
        where: { normalizedEmail: body.email.trim().toLowerCase() },
      });
      const valid = await verify(user?.passwordHash ?? dummy, body.password);
      if (!user || user.status !== 'ACTIVE' || !valid)
        throw new AppError(401, 'UNAUTHENTICATED', 'Invalid email or password');
      const token = randomBytes(32).toString('hex');
      const hashed = tokenHash(token, env),
        now = new Date();
      const prior = request.cookies[SESSION_COOKIE];
      await db.$transaction(async (tx) => {
        if (prior && /^[a-f0-9]{64}$/.test(prior))
          await tx.session.updateMany({
            where: { tokenHash: tokenHash(prior, env) },
            data: { revokedAt: now },
          });
        await tx.session.create({
          data: {
            userId: user.id,
            tokenHash: hashed,
            authenticatedAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + 28800000),
          },
        });
      });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 28800,
      });
      const memberships = await withActorTransaction(db, user.id, (tx) =>
        tx.membership.findMany({
          where: { userId: user.id, active: true },
          select: { merchantId: true, role: true },
        }),
      );
      return {
        data: {
          user: { id: user.id, email: user.normalizedEmail },
          memberships,
          csrfToken: csrfFor(hashed, env),
        },
        requestId: request.id,
      };
    },
  );
  app.get('/api/v1/auth/session', async (request) => {
    const { session, user } = await requireSession(request, db, env);
    const memberships = await withActorTransaction(db, user.id, (tx) =>
      tx.membership.findMany({
        where: { userId: user.id, active: true },
        select: { merchantId: true, role: true },
      }),
    );
    return {
      data: {
        user: { id: user.id, email: user.normalizedEmail },
        memberships,
        csrfToken: csrfFor(session.tokenHash, env),
      },
      requestId: request.id,
    };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const { session } = await requireSession(request, db, env);
    checkCsrf(request, session.tokenHash, env);
    z.strictObject({}).parse(request.body);
    await db.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    reply.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
    });
    return reply.status(204).send();
  });
}

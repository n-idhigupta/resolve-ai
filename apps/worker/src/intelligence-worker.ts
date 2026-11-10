import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import pino from 'pino';
import { PaymentDatabase } from '@resolveai/payment-store';
import { PrivateStorage, storageEnvSchema } from '@resolveai/case-store';
import {
  readProviderSelection,
  AnalysisEngine,
  ContextPreparer,
  type AIProvider,
} from '@resolveai/ai-core';
import { connection, jobDefaults } from './queue.js';
export function assertInferenceEnvironment(env: NodeJS.ProcessEnv) {
  for (const key of Object.keys(env))
    if (
      /^(PAYPAL_|S3_|WORKER_DATABASE_URL$|DATABASE_URL$|MIGRATION_DATABASE_URL$|EVIDENCE_DATABASE_URL$|POSTGRES_|DEV_SEED_|SESSION_|CSRF_)/.test(
        key,
      )
    )
      throw Error('FORBIDDEN_AI_ENVIRONMENT');
  if (
    !env.AI_DATABASE_URL ||
    !env.AI_ARTIFACT_KEY ||
    !(readProviderSelection(env).provider === 'gemini'
      ? env.GEMINI_API_KEY
      : env.OPENAI_API_KEY)
  )
    throw Error('AI_CONFIGURATION_REQUIRED');
  if (
    readProviderSelection(env).provider === 'gemini' &&
    env.GEMINI_USAGE_CONFIRMED !== 'true'
  )
    throw Error('GEMINI_ELIGIBILITY_NOT_CONFIRMED');
}
export async function startIntelligenceWorker(options: {
  mode: 'prepare' | 'infer';
  mockOnly?: boolean;
  databaseUrl: string;
  redisUrl: string;
  key: string;
  provider?: AIProvider;
  storage?: PrivateStorage;
  prefix?: string;
  intervalMs?: number;
}) {
  if (
    options.mockOnly &&
    options.mode === 'infer' &&
    options.provider?.executionMode !== 'mock'
  )
    throw Error('LOCAL_MOCK_PROVIDER_REQUIRED');
  const db = new PaymentDatabase(options.databaseUrl),
    prefix = options.prefix ?? 'resolveai',
    mode = options.mode,
    logger = pino({
      name: 'intelligence-worker',
      level: process.env.LOG_LEVEL ?? 'info',
    });
  const role = (
    await db.rows(
      "SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership,has_schema_privilege(current_user,'public','CREATE') AS creates,EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid AND relnamespace='public'::regnamespace) AS owns FROM pg_roles r WHERE rolname=current_user",
    )
  )[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.membership ||
    role.creates ||
    role.owns ||
    !(
      mode === 'infer'
        ? ['resolve_ai', 'resolve_ai_test']
        : ['resolve_evidence', 'resolve_evidence_test']
    ).includes(role.rolname)
  ) {
    await db.close();
    throw Error('UNSAFE_AI_ROLE');
  }
  const protectedTables = (
    await db.rows(
      "SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS safe,count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(ARRAY['Analysis','AIContext','AIConsent','AIRevocation','AIUsage','AnalysisSource'])",
    )
  )[0];
  if (protectedTables?.safe !== true || protectedTables.n !== 6) {
    await db.close();
    throw Error('AI_RLS_REQUIRED');
  }
  const engine =
      mode === 'infer'
        ? new AnalysisEngine(
            db,
            options.provider ??
              (() => {
                throw Error('PROVIDER_REQUIRED');
              })(),
            options.key,
          )
        : undefined,
    preparer =
      mode === 'prepare'
        ? new ContextPreparer(
            db,
            options.storage ??
              new PrivateStorage(storageEnvSchema.parse(process.env)),
            options.key,
          )
        : undefined;
  const producer = connection(options.redisUrl),
    consumer = connection(options.redisUrl),
    name = mode === 'infer' ? 'ai-inference-v1' : 'ai-prepare-v1',
    queue = new Queue(name, {
      connection: producer,
      prefix,
      defaultJobOptions: jobDefaults,
    });
  const payload = z.strictObject({
    schemaVersion: z.literal(1),
    merchantId: z.uuid(),
    id: z.uuid(),
  });
  const worker = new Worker(
    name,
    async (job) => {
      const data = payload.parse(job.data);
      if (options.mockOnly) {
        const allowed = await db.transaction(
          data.merchantId,
          null,
          async (tx) =>
            (
              await tx.query(
                mode === 'infer'
                  ? 'SELECT a.id FROM "Analysis" a JOIN "AIContext" c ON c.id=a."contextId" JOIN "AISharingPolicy" p ON p.id=c."sharingPolicyId" JOIN "DemoTenant" d ON d."merchantId"=a."merchantId" WHERE a.id=$1 AND p."executionMode"=\'mock\' AND mock_context_allowed(c.id)'
                  : 'SELECT c.id FROM "AIContext" c JOIN "AISharingPolicy" p ON p.id=c."sharingPolicyId" JOIN "DemoTenant" d ON d."merchantId"=c."merchantId" WHERE c.id=$1 AND p."executionMode"=\'mock\' AND mock_context_allowed(c.id)',
                [data.id],
              )
            ).rows[0],
        );
        if (!allowed) throw Error('MOCK_JOB_NOT_AUTHORIZED');
      }
      if (engine) await engine.run(data.merchantId, data.id);
      else await preparer!.process(data.merchantId, data.id);
    },
    { connection: consumer, prefix, concurrency: 1 },
  );
  worker.on('error', () => logger.error('AI queue connection failed'));
  worker.on('failed', (job) =>
    logger.warn({ jobId: job?.id }, 'AI job failed; durable state retained'),
  );
  await worker.waitUntilReady();
  let active: Promise<void> | undefined,
    stopped = false;
  const tick = async () => {
    const table = mode === 'infer' ? 'AIWorkerTenant' : 'EvidenceWorkerTenant';
    const tenants = await db.rows<{ merchantId: string }>(
      options.mockOnly
        ? `SELECT a."merchantId" FROM "${table}" a JOIN "DemoTenant" d ON d."merchantId"=a."merchantId"`
        : `SELECT "merchantId" FROM "${table}"`,
    );
    for (const { merchantId } of tenants) {
      if (mode === 'infer') {
        await db.transaction(merchantId, null, (tx) =>
          tx.query(
            'UPDATE "Analysis" SET status=CASE WHEN "postAttempts">=3 THEN \'FAILED\'::"AnalysisState" ELSE \'QUEUED\'::"AnalysisState" END,"lastErrorCode"=\'LEASE_EXPIRED\',"leaseUntil"=NULL WHERE status=\'RUNNING\' AND "contextId" IS NOT NULL AND "leaseUntil"<now()',
          ),
        );
        if (!options.mockOnly)
          await db.transaction(merchantId, null, (tx) =>
            tx.query('SELECT ai_purge_expired()'),
          );
      }
      if (mode === 'prepare' && !options.mockOnly)
        await db.transaction(merchantId, null, (tx) =>
          tx.query(
            'UPDATE "AIContext" SET state=\'FAILED\',"errorCode"=\'LEASE_ATTEMPTS_EXHAUSTED\',"leaseUntil"=NULL WHERE state=\'PREPARING\' AND attempts>=3 AND "leaseUntil"<now()',
          ),
        );
      const eventType = mode === 'infer' ? 'ai.analyze' : 'ai.prepare';
      const events = await db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'UPDATE "OutboxEvent" SET "leaseOwner"=gen_random_uuid(),"leaseUntil"=now()+interval \'30 seconds\',attempts=attempts+1 WHERE id IN(SELECT id FROM "OutboxEvent" WHERE "eventType"=$1 AND "deliveredAt" IS NULL AND "availableAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 25) RETURNING *',
              [eventType],
            )
          ).rows,
      );
      for (const e of events) {
        await queue.add(
          'process',
          { schemaVersion: 1, merchantId, id: e.aggregateId },
          { jobId: e.id + '-' + e.attempts },
        );
        await db.transaction(merchantId, null, (tx) =>
          tx.query(
            'UPDATE "OutboxEvent" SET "deliveredAt"=now(),"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',
            [e.id, e.leaseOwner],
          ),
        );
      }
      const due = await db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              mode === 'infer'
                ? 'SELECT id FROM "Analysis" WHERE "contextId" IS NOT NULL AND status=\'QUEUED\' AND "postAttempts"<3 AND "nextAttemptAt"<=now() ORDER BY "createdAt" LIMIT 25'
                : 'SELECT id FROM "AIContext" WHERE state IN (\'QUEUED\',\'PREPARING\') AND attempts<3 AND "nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) ORDER BY "createdAt" LIMIT 25',
            )
          ).rows,
      );
      for (const d of due)
        await queue.add(
          'process',
          { schemaVersion: 1, merchantId, id: d.id },
          { jobId: 'recover-' + d.id + '-' + Math.floor(Date.now() / 30000) },
        );
    }
  };
  const launch = () => {
    if (!active && !stopped)
      active = tick()
        .catch(() => logger.warn('AI sweep failed; durable state retained'))
        .finally(() => {
          active = undefined;
        });
  };
  launch();
  const timer = setInterval(launch, options.intervalMs ?? 2000);
  return {
    db,
    engine,
    preparer,
    queue,
    worker,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
      await worker.close();
      await queue.close();
      await Promise.allSettled([producer.quit(), consumer.quit()]);
      await db.close();
    },
  };
}

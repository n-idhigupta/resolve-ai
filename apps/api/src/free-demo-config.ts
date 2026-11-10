export function assertFreeDemoEnvironment(
  env: Record<string, string | undefined>,
) {
  if (env.RESOLVEAI_FREE_DEMO !== 'true' || env.NODE_ENV !== 'production')
    throw Error('EXPLICIT_PRODUCTION_FREE_DEMO_REQUIRED');
  for (const key of [
    'PAYPAL_ENABLED',
    'PAYPAL_REFUNDS_ENABLED',
    'AI_ENABLED',
    'EVIDENCE_ENABLED',
    'ENABLE_DEV_SEED',
  ])
    if (env[key] !== 'false')
      throw Error('FREE_DEMO_EXECUTION_MUST_BE_DISABLED');
  for (const key of Object.keys(env))
    if (
      env[key] &&
      (/^(PAYPAL_CLIENT_SECRET|PAYPAL_CLIENT_ID|PAYPAL_WEBHOOK_ID|PAYPAL_MERCHANT_ID|WEBHOOK_PAYLOAD_ENCRYPTION_KEY|GEMINI_API_KEY|OPENAI_API_KEY|AI_ARTIFACT_KEY|AI_DATABASE_URL|EVIDENCE_DATABASE_URL|WORKER_DATABASE_URL|MIGRATION_DATABASE_URL)$/.test(
        key,
      ) ||
        key.startsWith('S3_'))
    )
      throw Error('FREE_DEMO_FORBIDDEN_CREDENTIAL');
}

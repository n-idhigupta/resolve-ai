import { config } from 'dotenv';
import { readProviderSelection } from '../packages/ai-core/dist/selection.js';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const local =
  config({ path: root + '.env', processEnv: {}, quiet: true }).parsed ?? {};
const source = { ...local, ...process.env };
const common = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'NODE_ENV',
  'LOG_LEVEL',
  'REDIS_URL',
];
export function workerEnvironment(kind, values) {
  const names =
    kind === 'infer'
      ? [
          ...common,
          'AI_ENABLED',
          'AI_DATABASE_URL',
          'AI_ARTIFACT_KEY',
          'AI_PROVIDER',
          'AI_MODEL',
          'GEMINI_USAGE_CONFIRMED',
          ...(readProviderSelection(values).provider === 'gemini'
            ? ['GEMINI_API_KEY']
            : ['OPENAI_API_KEY']),
        ]
      : kind === 'prepare'
        ? [
            ...common,
            'EVIDENCE_DATABASE_URL',
            'AI_ARTIFACT_KEY',
            'S3_ENDPOINT',
            'S3_REGION',
            'S3_ACCESS_KEY_ID',
            'S3_SECRET_ACCESS_KEY',
            'S3_QUARANTINE_BUCKET',
            'S3_CLEAN_BUCKET',
            'CLAMAV_HOST',
            'CLAMAV_PORT',
          ]
        : [
            ...common,
            'WORKER_CONCURRENCY',
            'WORKER_DATABASE_URL',
            'PAYPAL_ENABLED',
            'PAYPAL_REFUNDS_ENABLED',
            'PAYPAL_ENVIRONMENT',
            'PAYPAL_CLIENT_ID',
            'PAYPAL_CLIENT_SECRET',
            'PAYPAL_MERCHANT_ID',
            'PAYPAL_WEBHOOK_ID',
            'WEBHOOK_PAYLOAD_ENCRYPTION_KEY',
          ];
  return {
    ...Object.fromEntries(
      names.filter((n) => values[n] !== undefined).map((n) => [n, values[n]]),
    ),
    RESOLVEAI_WORKER_ISOLATED: 'true',
  };
}
if (process.argv.includes('--check-environments')) {
  console.log(
    JSON.stringify({
      inferenceNames: Object.keys(workerEnvironment('infer', source)),
      preparationNames: Object.keys(workerEnvironment('prepare', source)),
    }),
  );
} else if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const children = [];
  function start(kind, entry) {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--watch', root + 'apps/worker/src/' + entry],
      {
        cwd: root,
        env: workerEnvironment(kind, source),
        windowsHide: true,
        stdio: 'inherit',
      },
    );
    children.push(child);
    child.on('exit', (code) => {
      if (code) console.error('Worker process exited', kind, code);
    });
  }
  start('payments', 'main.ts');
  if (source.EVIDENCE_ENABLED === 'true') start('prepare', 'evidence-main.ts');
  if (
    source.AI_ENABLED === 'true' &&
    (readProviderSelection(source).provider === 'gemini'
      ? source.GEMINI_API_KEY && source.GEMINI_USAGE_CONFIRMED === 'true'
      : source.OPENAI_API_KEY)
  )
    start('infer', 'ai-main.ts');
  else
    console.log('AI inference disabled: explicit enablement and key required.');
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      for (const child of children) child.kill();
    });
}

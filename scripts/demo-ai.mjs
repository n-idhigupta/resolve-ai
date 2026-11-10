import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { spawn } from 'node:child_process';
const v = { ...parse(readFileSync('.env')), ...process.env };
if (v.NODE_ENV === 'production') throw Error('Local demo only');
const common = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'LOG_LEVEL',
  'REDIS_URL',
  'AI_ARTIFACT_KEY',
];
const children = [];
for (const mode of ['prepare', 'infer']) {
  const keys = [
    ...common,
    ...(mode === 'infer'
      ? ['AI_DATABASE_URL']
      : [
          'EVIDENCE_DATABASE_URL',
          'S3_ENDPOINT',
          'S3_REGION',
          'S3_ACCESS_KEY_ID',
          'S3_SECRET_ACCESS_KEY',
          'S3_QUARANTINE_BUCKET',
          'S3_CLEAN_BUCKET',
        ]),
  ];
  if (
    !v.AI_ARTIFACT_KEY ||
    !v[mode === 'infer' ? 'AI_DATABASE_URL' : 'EVIDENCE_DATABASE_URL']
  )
    throw Error(
      'Local AI artifact key and restricted role configuration required',
    );
  const env = {
    ...Object.fromEntries(
      keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]),
    ),
    RESOLVEAI_WORKER_ISOLATED: 'true',
  };
  children.push(
    spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/worker/src/demo-ai-main.ts',
        ...(mode === 'prepare' ? ['--prepare'] : []),
      ],
      { env, stdio: 'inherit', windowsHide: true },
    ),
  );
}
for (const sig of ['SIGINT', 'SIGTERM'])
  process.once(sig, () => {
    for (const c of children) c.kill();
  });
for (const c of children)
  c.once('exit', (code) => {
    if (code)
      console.error(
        'Local mock worker stopped; check restricted configuration.',
      );
  });

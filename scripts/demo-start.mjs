import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
const v = { ...parse(readFileSync('.env')), ...process.env };
if (v.NODE_ENV === 'production') throw Error('Local demo only');
for (const key of [
  'AI_ARTIFACT_KEY',
  'AI_DATABASE_URL',
  'EVIDENCE_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'REDIS_URL',
])
  if (!v[key])
    throw Error(
      'Configure local restricted worker roles and artifact key before demo:start',
    );
for (const port of [3001, 5173])
  await new Promise((ok, no) => {
    const server = createServer();
    server.once('error', () =>
      no(Error('Stop the existing API/web process before demo:start')),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => ok()));
  });
const common = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'NODE_ENV',
    'LOG_LEVEL',
  ],
  pick = (names) =>
    Object.fromEntries(
      names.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]),
    ),
  children = [];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
};
function run(args, env, cwd = process.cwd()) {
  const c = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(c);
  c.on('error', () => {
    console.error('Demo service could not start.');
    stop();
    process.exitCode = 1;
  });
  c.on('exit', (code) => {
    if (!stopping) {
      console.error('Demo service exited; stopping the demo stack.');
      stop();
      process.exitCode = code || 1;
    }
  });
}
run(['--import', 'tsx', 'apps/api/src/main.ts'], {
  ...pick(common),
  PAYPAL_ENABLED: 'false',
  PAYPAL_REFUNDS_ENABLED: 'false',
  AI_ENABLED: 'false',
});
run(
  [resolve('apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'],
  pick([...common, 'VITE_API_BASE_URL']),
  resolve('apps/web'),
);
const workerCommon = [...common, 'REDIS_URL'];
run(['--import', 'tsx', 'apps/worker/src/demo-ai-main.ts', '--prepare'], {
  ...pick([
    ...workerCommon,
    'AI_ARTIFACT_KEY',
    'EVIDENCE_DATABASE_URL',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_QUARANTINE_BUCKET',
    'S3_CLEAN_BUCKET',
  ]),
  RESOLVEAI_WORKER_ISOLATED: 'true',
});
run(['--import', 'tsx', 'apps/worker/src/demo-ai-main.ts'], {
  ...pick([...workerCommon, 'AI_ARTIFACT_KEY', 'AI_DATABASE_URL']),
  RESOLVEAI_WORKER_ISOLATED: 'true',
});
run(['--import', 'tsx', 'apps/worker/src/refund-demo-main.ts'], {
  ...pick([...workerCommon, 'WORKER_DATABASE_URL']),
  RESOLVEAI_WORKER_ISOLATED: 'true',
});
console.log(
  'Local demo stack: API :3001, web :5173; local mock AI/refunds only.',
);
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, stop);

process.once('message', (message) => {
  if (message === 'stop') stop();
});

import { parse } from 'dotenv';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const values = { ...parse(fs.readFileSync('.env')), ...process.env };
if (values.NODE_ENV === 'production')
  throw Error('Development mock worker only');
const names = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'REDIS_URL',
  'WORKER_DATABASE_URL',
];
const env = Object.fromEntries(
  names.filter((n) => values[n] !== undefined).map((n) => [n, values[n]]),
);
env.RESOLVEAI_WORKER_ISOLATED = 'true';
const c = spawn(
  process.execPath,
  ['--import', 'tsx', 'apps/worker/src/refund-demo-main.ts'],
  { env, stdio: 'inherit', windowsHide: true },
);
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => c.kill());
c.once('exit', (code) => {
  process.exitCode = code ?? 1;
});

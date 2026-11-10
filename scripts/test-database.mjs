import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = { ...process.env, ...parse(readFileSync('.env.test')) };
if (new URL(env.MIGRATION_DATABASE_URL).pathname !== '/resolveai_test')
  throw Error('Refusing non-test database');
const result = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm.cmd --filter @resolveai/api db:migrate']
    : ['--filter', '@resolveai/api', 'db:migrate'],
  { env, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;

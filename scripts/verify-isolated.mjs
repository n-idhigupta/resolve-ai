import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!existsSync('.local/verification.env'))
  throw Error('Create the explicitly approved disposable database first');
const env = {
  ...process.env,
  RESOLVEAI_VERIFY_DATABASE: 'resolveai_verify_20261110',
  AI_ENABLED: 'false',
  PAYPAL_REFUNDS_ENABLED: 'false',
};
for (const args of [
  ['format:check'],
  ['lint'],
  ['typecheck'],
  ['build'],
  ['test'],
  ['test:integration'],
  ['test:e2e'],
]) {
  const r = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm.cmd ' + args.join(' ')]
      : args,
    { env, stdio: 'inherit', windowsHide: true },
  );
  if (r.status !== 0) {
    process.exitCode = r.status ?? 1;
    break;
  }
}

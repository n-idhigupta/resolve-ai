import { spawnSync } from 'node:child_process';
// Explicit safe profile: excluded suites contain TRUNCATE/reset or queue deletion.
// Do not call pnpm check under a no-reset authorization.
const steps = [
  ['format:check'],
  ['lint'],
  ['typecheck'],
  ['build'],
  ['test'],
  [
    'exec',
    'vitest',
    'run',
    '--project',
    'integration',
    'tests/integration/settlement-safe.test.ts',
    'tests/integration/analytics-safe.test.ts',
  ],
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/shell.spec.ts',
    'tests/e2e/checkout.spec.ts',
    'tests/e2e/settlement-safe.spec.ts',
  ],
];
console.log(
  'Safe regression: all unit tests; append-only settlement/analytics/RLS/recovery integration; shell, mocked checkout and complete synthetic complaint-to-settlement browsers.',
);
console.log(
  'Not run: legacy integration suites and complaints browser fixture use database resets/TRUNCATE or queue deletion; no-reset boundary preserved.',
);
for (const args of steps) {
  const r = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm.cmd ' + args.join(' ')]
      : args,
    { stdio: 'inherit', windowsHide: true },
  );
  if (r.status !== 0) {
    process.exitCode = r.status ?? 1;
    break;
  }
}

import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { assertInferenceEnvironment } from './intelligence-worker.js';
it('passes the selected Gemini key only to the restricted inference process', () => {
  const code =
    "import{workerEnvironment}from'./scripts/worker-launch.mjs';const v={AI_PROVIDER:'gemini',AI_MODEL:'gemini-2.5-flash',GEMINI_API_KEY:'fake',OPENAI_API_KEY:'fake-other',PAYPAL_CLIENT_SECRET:'fake-payment',S3_SECRET_ACCESS_KEY:'fake-storage'};console.log(JSON.stringify(Object.fromEntries(['infer','prepare','payments'].map(k=>[k,Object.keys(workerEnvironment(k,v))]))));";
  const value = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  expect(value.infer).toContain('GEMINI_API_KEY');
  expect(value.infer).not.toContain('OPENAI_API_KEY');
  expect(value.infer).not.toContain('PAYPAL_CLIENT_SECRET');
  expect(value.infer).not.toContain('S3_SECRET_ACCESS_KEY');
  expect(value.prepare).not.toContain('GEMINI_API_KEY');
  expect(value.payments).not.toContain('GEMINI_API_KEY');
});
it('requires Gemini eligibility attestation and keeps secret values out of errors', () => {
  const env = {
    AI_PROVIDER: 'gemini',
    AI_MODEL: 'gemini-2.5-flash',
    AI_DATABASE_URL: 'postgresql://fake/fake',
    AI_ARTIFACT_KEY: 'fake',
    GEMINI_API_KEY: 'unit-fake-secret',
  };
  expect(() => assertInferenceEnvironment(env)).toThrow(
    'GEMINI_ELIGIBILITY_NOT_CONFIRMED',
  );
  expect(() =>
    assertInferenceEnvironment({ ...env, GEMINI_USAGE_CONFIRMED: 'true' }),
  ).not.toThrow();
  expect(() =>
    assertInferenceEnvironment({
      ...env,
      GEMINI_USAGE_CONFIRMED: 'true',
      PAYPAL_CLIENT_SECRET: 'fake',
    }),
  ).toThrow('FORBIDDEN_AI_ENVIRONMENT');
});
it('does not populate Gemini credentials in API or legacy payment-worker environments', () => {
  for (const module of [
    './apps/api/src/config.ts',
    './apps/worker/src/config.ts',
  ]) {
    const code =
      "process.env.GEMINI_API_KEY='unit-only-fake';await import(" +
      JSON.stringify(module) +
      ");console.log(JSON.stringify({hasKey:Object.hasOwn(process.env,'GEMINI_API_KEY')}));";
    const value = JSON.parse(
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
    expect(value.hasKey).toBe(false);
  }
}, 15000);

it('direct inference entrypoint refuses disabled configuration before credentials or network', () => {
  let diagnostic = '';
  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'apps/worker/src/ai-main.ts'],
      {
        env: {
          ...Object.fromEntries(
            ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
              .filter((k) => process.env[k] !== undefined)
              .map((k) => [k, process.env[k]]),
          ),
          AI_ENABLED: 'false',
        },
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (e) {
    diagnostic = String((e as { stderr: unknown }).stderr);
  }
  expect(diagnostic).toContain('AI_INFERENCE_DISABLED');
});

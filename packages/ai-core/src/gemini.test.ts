import { it, expect } from 'vitest';
import { createGeminiProvider } from './gemini.js';
import { geminiWire, geminiCountWire } from './gemini-wire.js';
import { requestEnvelope, AIProviderError } from './provider.js';
import {
  GEMINI_MODEL,
  LEGACY_GEMINI_MODEL,
  acceptedReturnedModels,
  GEMINI_DISCLOSURE,
  readProviderSelection,
  estimateProviderMicros,
  assertGeminiModelWindow,
} from './selection.js';
const output = {
  schemaVersion: '1',
  summary: { text: 'Synthetic case requires review.', sourceIds: ['S001'] },
  findings: [],
  contradictions: [],
  missingInformation: [],
  policySourceIds: [],
  riskFlags: [],
  recommendation: {
    candidateId: 'C1',
    rationale: 'Human review only.',
    findingIds: [],
    sourceIds: ['S001'],
  },
};
function models(
  options: {
    error?: number;
    malformed?: boolean;
    version?: string;
    reason?: string;
    missingUsage?: boolean;
  } = {},
) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async () => {
      calls++;
      if (options.error)
        throw { status: options.error, message: 'SECRET_MUST_NOT_ESCAPE' };
      return {
        text: options.malformed ? 'not JSON' : JSON.stringify(output),
        modelVersion: options.version ?? GEMINI_MODEL,
        responseId: 'synthetic-response',
        candidates: [{ finishReason: options.reason ?? 'STOP' }],
        usageMetadata: options.missingUsage
          ? undefined
          : {
              promptTokenCount: 100,
              candidatesTokenCount: 40,
              thoughtsTokenCount: 0,
            },
      };
    },
  };
}
const input = () =>
  requestEnvelope(
    { sources: [{ key: 'S001', text: 'Synthetic only' }] },
    [],
    GEMINI_MODEL,
  );
it('maps exact text/image/schema settings with tools disabled and model-specific thinking', () => {
  const i = requestEnvelope(
      {},
      [{ sourceId: 'S002', dataUrl: 'data:image/png;base64,AAAA' }],
      GEMINI_MODEL,
    ),
    wire = geminiWire(i);
  expect(wire.contents[0]?.parts.at(-1)).toEqual({
    inlineData: { mimeType: 'image/png', data: 'AAAA' },
  });
  expect(wire.config.thinkingConfig.thinkingLevel).toBe('MINIMAL');
  expect(wire.config.tools).toEqual([]);
  expect(geminiCountWire(i).contents).toHaveLength(2);
  expect(() =>
    geminiWire(requestEnvelope({}, [], 'gpt-5.4-mini-2026-03-17')),
  ).toThrow('AI_PROVIDER_MODEL_MISMATCH');
  (i.input[0] as { content: { type: string; image_url: string }[] }).content.at(
    -1,
  )!.image_url = 'https://untrusted.invalid/image.png';
  expect(() => geminiWire(i)).toThrow('INVALID_IMAGE_INPUT');
});
it('validates structured JSON and reports sanitized diagnostics and usage', async () => {
  const m = models(),
    p = createGeminiProvider('synthetic-key', m as never);
  expect(await p.countInputTokens(input())).toBeGreaterThan(100);
  expect(await p.analyze(input())).toMatchObject({
    output,
    model: GEMINI_MODEL,
    inputTokens: 100,
    outputTokens: 40,
    requestId: 'synthetic-response',
  });
});
it('rejects malformed, refused, missing-usage and unexpectedly rerouted model responses', async () => {
  for (const option of [
    { malformed: true },
    { reason: 'MAX_TOKENS' },
    { missingUsage: true },
    { version: 'gemini-3.8-flash' },
  ]) {
    await expect(
      createGeminiProvider('fake', models(option) as never).analyze(input()),
    ).rejects.toBeInstanceOf(AIProviderError);
  }
});
it('normalizes quota and transient failures without leaking provider errors or adding SDK retries', async () => {
  for (const status of [400, 403, 404, 429, 503]) {
    const m = models({ error: status });
    let error: unknown;
    try {
      await createGeminiProvider('fake', m as never).analyze(input());
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'PROVIDER_HTTP_' + status,
      transient: status === 429 || status === 503,
    });
    expect(String(error)).not.toContain('SECRET_MUST_NOT_ESCAPE');
    expect(m.calls).toBe(1);
  }
});
it('validates provider/model pairs, conservative costs, Google disclosure and deprecation boundary', () => {
  expect(readProviderSelection({ AI_PROVIDER: 'gemini' }).model).toBe(
    GEMINI_MODEL,
  );
  expect(() =>
    readProviderSelection({
      AI_PROVIDER: 'gemini',
      AI_MODEL: 'gpt-5.4-mini-2026-03-17',
    }),
  ).toThrow();
  expect(() =>
    readProviderSelection({ AI_PROVIDER: 'gemini', AI_MODEL: 'latest' }),
  ).toThrow();
  expect(estimateProviderMicros(16000, 4000, GEMINI_MODEL)).toBe(14800);
  expect(GEMINI_DISCLOSURE).toContain('55-day');
  expect(GEMINI_DISCLOSURE).toContain('human reviewers');
  expect(() =>
    assertGeminiModelWindow(Date.parse('2026-12-01T00:00:00Z')),
  ).toThrow('GEMINI_MODEL_REVALIDATION_REQUIRED');
});
it('uses the official SDK serialization and fixed host without hidden retries', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (url, options) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(options?.body)),
    });
    if (String(url).includes(':countTokens'))
      return new Response(JSON.stringify({ totalTokens: 50 }));
    return new Response(
      JSON.stringify({
        modelVersion: GEMINI_MODEL,
        responseId: 'sdk-response',
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify(output) }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 0,
        },
      }),
    );
  };
  const p = createGeminiProvider(
    'fake-SDK-key',
    undefined,
    () => Date.parse('2026-11-10T00:00:00Z'),
    transport,
  );
  await p.countInputTokens(input());
  expect((await p.analyze(input())).requestId).toBe('sdk-response');
  expect(requests).toHaveLength(2);
  expect(
    requests.every((r) =>
      r.url.startsWith('https://generativelanguage.googleapis.com/v1beta/'),
    ),
  ).toBe(true);
  expect(JSON.stringify(requests)).not.toContain('fake-SDK-key');
  expect(requests[1]?.body).toMatchObject({
    generationConfig: {
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'MINIMAL' },
    },
  });
  let attempts = 0;
  const quota = createGeminiProvider(
    'fake-key',
    undefined,
    () => Date.parse('2026-11-10T00:00:00Z'),
    async () => {
      attempts++;
      return new Response(
        JSON.stringify({
          error: { code: 429, message: 'do not log raw provider payload' },
        }),
        { status: 429 },
      );
    },
  );
  await expect(quota.analyze(input())).rejects.toMatchObject({
    code: 'PROVIDER_HTTP_429',
  });
  expect(attempts).toBe(1);
});

it('preserves legacy model consent protocol and rejects unlisted returned versions', () => {
  const old = requestEnvelope({}, [], LEGACY_GEMINI_MODEL),
    current = requestEnvelope({}, [], GEMINI_MODEL);
  expect(old.protocolVersion).toBe('gemini-sdk-v1');
  expect(current.protocolVersion).toBe('gemini-sdk-v3');
  expect(geminiWire(old).config.thinkingConfig.thinkingBudget).toBe(0);
  expect(geminiWire(current).config.thinkingConfig.thinkingLevel).toBe(
    'MINIMAL',
  );
  expect(acceptedReturnedModels(GEMINI_MODEL)).toEqual([
    GEMINI_MODEL,
    GEMINI_MODEL + '-07-2026',
  ]);
  expect(acceptedReturnedModels(GEMINI_MODEL)).not.toContain(
    'gemini-3.8-flash',
  );
  expect(() =>
    assertGeminiModelWindow(Date.parse('2026-12-01T00:00:00Z'), GEMINI_MODEL),
  ).not.toThrow();
});

it('simplifies only new consent protocol grammar and retains strict server validation', () => {
  const current = input(),
    old = { ...input(), protocolVersion: 'gemini-sdk-v2' as const };
  const currentSchema = JSON.stringify(
    geminiWire(current).config.responseJsonSchema,
  );
  expect(currentSchema).not.toContain('maxItems');
  expect(currentSchema).not.toContain('maximum');
  expect(currentSchema).not.toContain('pattern');
  expect(currentSchema).toContain('additionalProperties');
  expect(JSON.stringify(geminiWire(old).config.responseJsonSchema)).toContain(
    'maxItems',
  );
});

it('retains bounded rejected field diagnostics without raw provider payloads', async () => {
  const p = createGeminiProvider(
    'fake-key',
    undefined,
    Date.now,
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'SECRET_MUST_NOT_ESCAPE schema too complex',
            details: [
              {
                fieldViolations: [
                  {
                    field: 'generationConfig.responseJsonSchema',
                    description: 'SECRET_MUST_NOT_ESCAPE',
                  },
                  { field: 'SECRET_MUST_NOT_ESCAPE' },
                ],
              },
            ],
          },
        }),
        { status: 400 },
      ),
  );
  const error = (await p
    .analyze(input())
    .catch((e: unknown) => e)) as AIProviderError;
  expect(error.code).toBe('PROVIDER_HTTP_400');
  expect(error.diagnostics).toEqual({
    status: 'INVALID_ARGUMENT',
    fields: ['generationConfig.responseJsonSchema'],
    reason: 'SCHEMA_COMPLEXITY',
  });
  expect(JSON.stringify(error)).not.toContain('SECRET_MUST_NOT_ESCAPE');
  expect(error.transient).toBe(false);
});

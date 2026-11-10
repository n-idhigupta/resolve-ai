import { it, expect } from 'vitest';
import {
  createOpenAIProvider,
  requestEnvelope,
  MODEL,
  AIProviderError,
} from './provider.js';
import { conservativeTextTokens, estimatedMicros } from './engine.js';
it('uses strict Responses schema and token preflight without tools or storage', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify(
        String(url).endsWith('input_tokens')
          ? { input_tokens: 1000 }
          : {
              status: 'completed',
              model: MODEL,
              usage: { input_tokens: 1000, output_tokens: 100 },
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: '{}' }],
                },
              ],
            },
      ),
      { status: 200, headers: { 'x-request-id': 'req-safe' } },
    );
  };
  const p = createOpenAIProvider('test-secret', transport),
    input = requestEnvelope({ text: 'synthetic' }, []);
  expect(await p.countInputTokens(input)).toBe(1000);
  expect((await p.analyze(input)).requestId).toBe('req-safe');
  expect(calls[1]?.body.store).toBe(false);
  expect(calls[1]?.body.tools).toEqual([]);
  expect(JSON.stringify(calls)).not.toContain('test-secret');
});
it('classifies transient failures and rejects incomplete output', async () => {
  const p = createOpenAIProvider(
    'fake',
    async () =>
      new Response(JSON.stringify({ error: 'not logged' }), { status: 429 }),
  );
  await expect(p.analyze(requestEnvelope({}, []))).rejects.toMatchObject({
    transient: true,
    uncertain: false,
    code: 'PROVIDER_HTTP_429',
  });
  const q = createOpenAIProvider(
    'fake',
    async () => new Response('{}', { status: 200 }),
  );
  await expect(q.analyze(requestEnvelope({}, []))).rejects.toBeInstanceOf(
    AIProviderError,
  );
});
it('fails closed on images without token preflight and bounds text conservatively', () => {
  const text = requestEnvelope({ text: 'hello' }, []);
  expect(conservativeTextTokens(text)).toBeGreaterThan(
    Buffer.byteLength(JSON.stringify(text)),
  );
  expect(() =>
    conservativeTextTokens(
      requestEnvelope({}, [
        { sourceId: 'S001', dataUrl: 'data:image/png;base64,AA==' },
      ]),
    ),
  ).toThrow('IMAGE_PREFLIGHT_REQUIRED');
  expect(estimatedMicros(16000, 4000)).toBe(30000);
});

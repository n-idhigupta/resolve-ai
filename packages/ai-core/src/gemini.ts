import {
  GoogleGenAI,
  type GenerateContentParameters,
  type CountTokensParameters,
} from '@google/genai';
import { aiOutputSchema } from '@resolveai/shared';
import {
  AIProviderError,
  type AIProvider,
  type ProviderInput,
} from './provider.js';
import {
  acceptedReturnedModels,
  assertGeminiModelWindow,
} from './selection.js';
import { geminiWire, geminiCountWire } from './gemini-wire.js';
export type GeminiModels = Pick<
  GoogleGenAI['models'],
  'generateContent' | 'countTokens'
>;
export function geminiErrorDiagnostics(value: unknown) {
  const error = (
    value as {
      error?: {
        status?: string;
        message?: string;
        details?: { fieldViolations?: { field?: string }[] }[];
      };
    }
  )?.error;
  const message = error?.message ?? '';
  const fields = (error?.details ?? [])
    .flatMap((d) => (d.fieldViolations ?? []).map((v) => v.field ?? ''))
    .filter((f) => /^[a-zA-Z][a-zA-Z0-9_.[\]]{0,180}$/.test(f))
    .filter((f) =>
      [
        'generationConfig',
        'generation_config',
        'contents',
        'systemInstruction',
        'system_instruction',
        'tools',
        'model',
      ].some(
        (root) =>
          f === root || f.startsWith(root + '.') || f.startsWith(root + '['),
      ),
    )
    .slice(0, 8);
  const reason = /too many states|schema.*complex|state.*limit/i.test(message)
    ? 'SCHEMA_COMPLEXITY'
    : /unknown name|unknown field|unrecognized field/i.test(message)
      ? 'UNSUPPORTED_FIELD'
      : /token.*limit|max.output.tokens/i.test(message)
        ? 'TOKEN_LIMIT'
        : 'UNCLASSIFIED_PROVIDER_REJECTION';
  return {
    ...(/^[A-Z_]{1,64}$/.test(error?.status ?? '')
      ? { status: error!.status! }
      : {}),
    fields,
    reason,
  };
}
export function normalizeGeminiError(e: unknown) {
  if (e instanceof AIProviderError) return e;
  const n = e && typeof e === 'object' && 'status' in e ? Number(e.status) : 0;
  return new AIProviderError(
    n ? 'PROVIDER_HTTP_' + n : 'PROVIDER_TRANSPORT',
    n === 0 || n === 408 || n === 429 || n >= 500,
    n === 0 || n === 408 || n >= 500,
  );
}
export function createGeminiProvider(
  key: string,
  models?: GeminiModels,
  now: () => number = Date.now,
  transport: typeof fetch = fetch,
): AIProvider {
  if (!key) throw Error('GEMINI_KEY_REQUIRED');
  // SDK retries are off: durable AnalysisEngine owns all attempts and budget reservations.
  const client =
    models ??
    new GoogleGenAI({
      apiKey: key,
      vertexai: false,
      httpOptions: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiVersion: 'v1beta',
        timeout: 45000,
        retryOptions: { attempts: 1 },
        fetch: async (url, options) => {
          if (
            new URL(String(url)).origin !==
            'https://generativelanguage.googleapis.com'
          )
            throw new AIProviderError('PROVIDER_HOST_REJECTED', false, false);
          const r = await transport(url, { ...options, redirect: 'error' }),
            chunks: Uint8Array[] = [];
          let size = 0;
          const reader = r.body?.getReader();
          if (reader)
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.length;
                if (size > 1048576) {
                  await reader.cancel();
                  throw new AIProviderError(
                    'PROVIDER_RESPONSE_TOO_LARGE',
                    false,
                    true,
                  );
                }
                chunks.push(next.value);
              }
            } finally {
              reader.releaseLock();
            }
          const bytes = Buffer.concat(chunks);
          if (!r.ok) {
            let parsed: unknown = {};
            try {
              parsed = JSON.parse(bytes.toString('utf8'));
            } catch {
              /* Never log raw response. */
            }
            const d = geminiErrorDiagnostics(parsed);
            throw new AIProviderError(
              'PROVIDER_HTTP_' + r.status,
              r.status === 408 || r.status === 429 || r.status >= 500,
              r.status === 408 || r.status >= 500,
              null,
              0,
              { ...d, ...(d.status ? { status: d.status } : {}) },
            );
          }
          return new Response(bytes, {
            status: r.status,
            statusText: r.statusText,
            headers: r.headers,
          });
        },
      },
    }).models;
  async function guarded<T>(fn: () => Promise<T>, model: string) {
    assertGeminiModelWindow(now(), model);
    try {
      return await fn();
    } catch (e) {
      throw normalizeGeminiError(e);
    }
  }
  return {
    id: 'gemini',
    async countInputTokens(input: ProviderInput) {
      const result = await guarded(
        () =>
          client.countTokens({
            ...geminiCountWire(input),
            config: {
              ...geminiCountWire(input).config,
              abortSignal: AbortSignal.timeout(45000),
            },
          } as CountTokensParameters),
        input.model,
      );
      if (!Number.isSafeInteger(result.totalTokens) || result.totalTokens! < 0)
        throw new AIProviderError('PROVIDER_TOKEN_COUNT_INVALID', false, false);
      return (
        result.totalTokens! +
        Buffer.byteLength(JSON.stringify(input.text.format.schema), 'utf8') +
        2048
      );
    },
    async analyze(input: ProviderInput) {
      const start = Date.now();
      const result = await guarded(
        () =>
          client.generateContent({
            ...geminiWire(input),
            config: {
              ...geminiWire(input).config,
              abortSignal: AbortSignal.timeout(45000),
            },
          } as GenerateContentParameters),
        input.model,
      );
      const requestId = /^[A-Za-z0-9_-]{1,128}$/.test(result.responseId ?? '')
        ? result.responseId!
        : null;
      if (
        !acceptedReturnedModels(input.model).includes(result.modelVersion ?? '')
      )
        throw new AIProviderError(
          'UNEXPECTED_PROVIDER_MODEL',
          false,
          true,
          requestId,
        );
      if (
        result.promptFeedback?.blockReason ||
        result.candidates?.length !== 1 ||
        result.candidates[0]?.finishReason !== 'STOP'
      )
        throw new AIProviderError(
          'PROVIDER_INCOMPLETE_OR_REFUSED',
          false,
          true,
          requestId,
        );
      const text = result.text ?? '';
      if (Buffer.byteLength(text) > 1048576)
        throw new AIProviderError(
          'PROVIDER_RESPONSE_TOO_LARGE',
          false,
          true,
          requestId,
        );
      const usage = result.usageMetadata;
      const inputTokens = usage?.promptTokenCount,
        candidateTokens = usage?.candidatesTokenCount,
        thinkingTokens = usage?.thoughtsTokenCount ?? 0;
      const outputTokens = (candidateTokens ?? 0) + thinkingTokens;
      if (
        !Number.isSafeInteger(inputTokens) ||
        inputTokens! < 0 ||
        !Number.isSafeInteger(candidateTokens) ||
        candidateTokens! < 0 ||
        !Number.isSafeInteger(thinkingTokens) ||
        thinkingTokens < 0 ||
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 0
      )
        throw new AIProviderError(
          'PROVIDER_USAGE_INVALID',
          false,
          true,
          requestId,
        );
      let output: unknown;
      try {
        output = aiOutputSchema.parse(JSON.parse(text));
      } catch {
        throw new AIProviderError(
          'PROVIDER_OUTPUT_INVALID',
          false,
          true,
          requestId,
        );
      }
      return {
        output,
        requestId,
        model: result.modelVersion!,
        inputTokens: inputTokens!,
        outputTokens,
        latencyMs: Date.now() - start,
      };
    },
  };
}

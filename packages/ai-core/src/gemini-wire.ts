import type { ProviderInput } from './provider.js';
import { GEMINI_MODEL, providerForModel } from './selection.js';
// Keep grammar complexity bounded; all semantic/length/financial checks remain in server Zod.
// Historical protocol v1/v2 mappings are immutable for existing consent previews.
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const value = schema as Record<string, unknown>,
    result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      [
        'minimum',
        'maximum',
        'minItems',
        'maxItems',
        'minLength',
        'maxLength',
        'pattern',
      ].includes(key)
    )
      continue;
    if (key === 'const') {
      result.enum = [entry];
      continue;
    }
    if (key === 'properties')
      result[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(
          ([name, child]) => [name, geminiSchema(child)],
        ),
      );
    else result[key] = geminiSchema(entry);
  }
  return result;
}
export function geminiWire(input: ProviderInput) {
  if (providerForModel(input.model) !== 'gemini')
    throw Error('AI_PROVIDER_MODEL_MISMATCH');
  const messages = input.input as {
    role: string;
    content: { type: string; text?: string; image_url?: string }[];
  }[];
  if (messages.length !== 1 || messages[0]?.role !== 'user')
    throw Error('INVALID_PROVIDER_ENVELOPE');
  const parts = messages[0].content.map((c) => {
    if (c.type === 'input_text' && typeof c.text === 'string')
      return { text: c.text };
    if (c.type === 'input_image' && typeof c.image_url === 'string') {
      const m = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(
        c.image_url,
      );
      if (!m || c.image_url.length > 3000000)
        throw Error('INVALID_IMAGE_INPUT');
      return { inlineData: { mimeType: m[1]!, data: m[2]! } };
    }
    throw Error('INVALID_PROVIDER_CONTENT');
  });
  return {
    model: input.model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: input.instructions,
      responseMimeType: 'application/json',
      responseJsonSchema:
        input.protocolVersion === 'gemini-sdk-v3'
          ? geminiSchema(input.text.format.schema)
          : input.text.format.schema,
      maxOutputTokens: input.max_output_tokens,
      thinkingConfig:
        input.model === GEMINI_MODEL
          ? { thinkingLevel: 'MINIMAL' as const }
          : { thinkingBudget: 0 },
      candidateCount: 1,
      tools: [],
    },
  };
}
export function geminiCountWire(input: ProviderInput) {
  const wire = geminiWire(input);
  // countTokens generationConfig isn't supported on the Developer API. Include schema bytes
  // as an explicit text part too and add a conservative local schema/overhead allowance.
  return {
    model: wire.model,
    contents: [
      ...wire.contents,
      {
        role: 'user',
        parts: [
          {
            text: 'System instruction for counting only: ' + input.instructions,
          },
          {
            text:
              'Output JSON schema: ' +
              JSON.stringify(wire.config.responseJsonSchema),
          },
        ],
      },
    ],
    config: {},
  };
}

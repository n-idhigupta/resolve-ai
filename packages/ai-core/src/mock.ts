import { randomUUID } from 'node:crypto';
import { conservativeTextTokens } from './engine.js';
import type { AIProvider, ProviderInput, ProviderResult } from './provider.js';
export const MOCK_DISCLOSURE =
  'Local deterministic mock analysis for migration-authorized synthetic demo tenants only. The exact preview below is processed locally; no data is transmitted to OpenAI, Google or another model provider. The model identifier is compatibility metadata, not evidence of a real model call. Customer consent still binds this exact source manifest and policy version; revocation blocks subsequent processing. Findings are scripted demonstration outputs, not model-quality evidence. Merchant review and deterministic policy validation remain required. No payment action is authorized.';
export class MockAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  readonly executionMode = 'mock' as const;
  async countInputTokens(input: ProviderInput) {
    return conservativeTextTokens(input);
  }
  async analyze(input: ProviderInput): Promise<ProviderResult> {
    const ctx = JSON.parse(
      (input.input[0] as { content: { text: string }[] }).content[0]!.text,
    ) as {
      sources: { key: string; kind: string }[];
      constraints: { candidates: { id: string; kind: string }[] };
    };
    const source =
      ctx.sources.find((s) => s.kind === 'ALLEGATION') ?? ctx.sources[0];
    if (!source) throw Error('MOCK_SOURCE_REQUIRED');
    const candidate =
      ctx.constraints.candidates.find((c) => c.kind === 'PARTIAL_REFUND') ??
      ctx.constraints.candidates.find((c) => c.kind === 'ESCALATE_TO_HUMAN');
    if (!candidate) throw Error('MOCK_CANDIDATE_REQUIRED');
    return {
      model: input.model,
      requestId: 'mock-local-' + randomUUID(),
      inputTokens: await this.countInputTokens(input),
      outputTokens: 200,
      latencyMs: 1,
      output: {
        schemaVersion: '1',
        summary: {
          text: 'Local mock: the synthetic complaint is ready for a merchant to review alongside the verified purchase and policy.',
          sourceIds: [source.key],
        },
        findings: [
          {
            id: 'F1',
            kind: 'ALLEGATION',
            statement:
              'The customer reports an issue. This allegation is not independent proof of damage or delivery.',
            sourceIds: [source.key],
            quote: null,
            start: null,
            end: null,
            page: null,
          },
        ],
        contradictions: [],
        missingInformation: [],
        policySourceIds: ctx.sources
          .filter((s) => s.kind === 'POLICY')
          .slice(0, 20)
          .map((s) => s.key),
        riskFlags: [],
        recommendation: {
          candidateId: candidate.id,
          rationale:
            'Local scripted suggestion selected from server-permitted candidates. The merchant must assess the complaint and policy; no offer or refund has been authorized.',
          findingIds: ['F1'],
          sourceIds: [source.key],
        },
      },
    };
  }
}

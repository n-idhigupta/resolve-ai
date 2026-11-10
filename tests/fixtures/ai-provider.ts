import {
  AIProviderError,
  type AIProvider,
  type ProviderInput,
  type ProviderResult,
} from '../../packages/ai-core/dist/index.js';
export class FakeAI implements AIProvider {
  calls = 0;
  countCalls = 0;
  tokens = 1000;
  candidateKind = 'ESCALATE_TO_HUMAN';
  malformed = false;
  transient = false;
  beforeReturn: (() => Promise<void>) | undefined;
  lastRequest: ProviderInput | undefined;
  async countInputTokens(input: ProviderInput) {
    this.countCalls++;
    this.lastRequest = input;
    return this.tokens;
  }
  async analyze(input: ProviderInput): Promise<ProviderResult> {
    this.calls++;
    this.lastRequest = input;
    if (this.transient)
      throw new AIProviderError('PROVIDER_HTTP_503', true, true);
    const ctx = JSON.parse(
      (input.input[0] as { content: { text: string }[] }).content[0]!.text,
    );
    if (this.beforeReturn) await this.beforeReturn();
    const candidate =
      ctx.constraints.candidates.find(
        (c: { kind: string }) => c.kind === this.candidateKind,
      ) ?? ctx.constraints.candidates[1];
    return {
      model: input.model,
      requestId: 'req-synthetic',
      inputTokens: 1000,
      outputTokens: 100,
      latencyMs: 10,
      output: this.malformed
        ? { invalid: true }
        : {
            schemaVersion: '1',
            summary: {
              text: 'Synthetic complaint needs merchant review.',
              sourceIds: ['S001'],
            },
            findings: [
              {
                id: 'F1',
                kind: 'ALLEGATION',
                statement: 'The customer reports an issue.',
                sourceIds: ['S001'],
                quote: null,
                start: null,
                end: null,
                page: null,
              },
            ],
            contradictions: [],
            missingInformation: [],
            policySourceIds: ctx.sources
              .filter((s: { kind: string }) => s.kind === 'POLICY')
              .map((s: { key: string }) => s.key),
            riskFlags: [],
            recommendation: {
              candidateId: candidate.id,
              rationale: 'Human review is required before any further step.',
              findingIds: ['F1'],
              sourceIds: ['S001'],
            },
          },
    };
  }
}

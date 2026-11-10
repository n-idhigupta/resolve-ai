import { z } from 'zod';
import { aiOutputSchema, type AIOutput } from '@resolveai/shared';
import {
  chooseRecommendation,
  type RecommendationCandidate,
} from '@resolveai/policy-engine';
export const sourceSchema = z.object({
  key: z.string(),
  kind: z.enum([
    'TRUSTED_RECORD',
    'ALLEGATION',
    'MERCHANT_ASSERTION',
    'POLICY',
    'DOCUMENT_OBSERVATION',
    'TIMELINE',
  ]),
  text: z.string(),
  reference: z.record(z.string(), z.string()),
  page: z.number().int().positive().nullable(),
  hash: z.string(),
});
export type AISource = z.infer<typeof sourceSchema>;
export const redact = (s: string) =>
  s
    .replace(/https?:\/\/[^\s]+/gi, '[URL removed]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, '[number removed]');
export function validateCitations(
  value: unknown,
  sources: AISource[],
  candidates: RecommendationCandidate[],
) {
  const out = aiOutputSchema.parse(value),
    map = new Map(sources.map((s) => [s.key, s])),
    findings = new Set(out.findings.map((f) => f.id));
  if (findings.size !== out.findings.length) throw Error('DUPLICATE_FINDING');
  function citations(ids: string[]) {
    for (const id of ids) if (!map.has(id)) throw Error('INVALID_CITATION');
  }
  citations(out.summary.sourceIds);
  citations(out.policySourceIds);
  if (out.policySourceIds.some((id) => map.get(id)?.kind !== 'POLICY'))
    throw Error('INVALID_POLICY_CITATION');
  citations(out.recommendation.sourceIds);
  for (const f of out.findings) {
    citations(f.sourceIds);
    if (/https?:\/\/|<\/?[a-z]/i.test(f.statement))
      throw Error('UNSAFE_MODEL_TEXT');
    if (
      f.kind === 'EVIDENCE_OBSERVATION' &&
      f.sourceIds.some((id) => map.get(id)?.kind !== 'DOCUMENT_OBSERVATION')
    )
      throw Error('WRONG_SOURCE_CLASS');
    if (f.quote !== null) {
      if (f.start === null || f.end === null || f.sourceIds.length !== 1)
        throw Error('INVALID_QUOTE');
      const source = map.get(f.sourceIds[0]!)!;
      if (
        source.text.slice(f.start, f.end) !== f.quote ||
        f.end <= f.start ||
        f.end > source.text.length
      )
        throw Error('INVALID_QUOTE');
    } else if (f.start !== null || f.end !== null) throw Error('INVALID_QUOTE');
    if (
      f.page !== null &&
      f.sourceIds.some((id) => map.get(id)?.page !== f.page)
    )
      throw Error('INVALID_PAGE');
  }
  for (const group of out.contradictions)
    if (group.findingIds.some((id) => !findings.has(id)))
      throw Error('INVALID_FINDING_REFERENCE');
  for (const m of out.missingInformation) citations(m.relatedSourceIds);
  if (out.recommendation.findingIds.some((id) => !findings.has(id)))
    throw Error('INVALID_FINDING_REFERENCE');
  const uncertain =
    out.missingInformation.some((m) => m.blocking) ||
    out.contradictions.length > 0 ||
    out.riskFlags.length > 0;
  const candidate = chooseRecommendation(
    candidates,
    out.recommendation.candidateId,
    uncertain,
  );
  return { output: out, candidate, uncertain };
}
export function outputUncertain(out: AIOutput) {
  return (
    out.contradictions.length > 0 ||
    out.missingInformation.some((m) => m.blocking) ||
    out.riskFlags.length > 0
  );
}

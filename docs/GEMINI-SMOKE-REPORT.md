# Authorized Gemini smoke attempt — 2026-11-10

Result: **stopped after one HTTP404 NOT_FOUND response**. No retry, fallback model, billing change, payment operation or normal application enablement occurred.

## Authorization and isolation

The user reported that ResolveAI-Development belongs to Default Gemini Project, with Free tier and Set up billing shown in AI Studio, and subsequently confirmed nonzero remaining quota for the requested model. Numeric RPM/TPM/RPD limits were not supplied; this was an operator attestation, not an independently read quota counter. The user authorized one synthetic-only smoke with Google-specific consent.

The app remained configured for OpenAI with AI inference disabled. This was an isolated Gemini smoke, not a configuration switch. The child received only the Gemini key and consent hash plus OS runtime variables; no database, original-storage, session or PayPal credentials.

The immutable input packet identified synthetic case GEMINI-SYNTHETIC-SMOKE-ONE and one allegation: an imaginary sample parcel had not arrived. It contained no names, emails, addresses, real orders/payment IDs, customer evidence or private merchant notes. Permitted recommendations were information request or human escalation, with no financial amount.

The Google unpaid-services disclosure, exact generation request, source manifest, token/budget caps and user authorization were bound by hashes in ignored .local/gemini-real-smoke-packet.json and .local/gemini-real-smoke-2026-11-10.json. This was a smoke-only operator authorization, not consent for actual customer data or general background inference.

## Limits and actual result

| Item                                        | Evidence                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Requested model                             | gemini-2.5-flash                                                               |
| Returned model                              | None                                                                           |
| Generation attempts                         | 1                                                                              |
| Endpoint                                    | Gemini Developer API v1beta generateContent, official SDK                      |
| HTTP / provider error                       | 404 / NOT_FOUND                                                                |
| Structured-output validation                | Not run: no model output returned                                              |
| Citation / policy validation                | Not run: no model output returned                                              |
| Token usage                                 | Not returned; do not infer zero processed tokens                               |
| Quota error / quota violations              | None returned; quota availability was not established by this response         |
| Input cap                                   | 7000 tokens; conservative whole-envelope estimate6399                          |
| Output cap                                  | 512 tokens; thinkingBudget0, one candidate                                     |
| Budget cap                                  | USD0.0035 at conservative published-rate estimates                             |
| Retries / provider fallback                 | Disabled; no second request                                                    |
| countTokens / model-list / model-get probes | Not called; local text-only conservative preflight avoided additional requests |
| Billing settings                            | Not changed; no billing setup/linking was attempted                            |
| PayPal / financial operations               | None; child had no payment or database credentials                             |

Dispatch authorization was recorded2026-11-10T05:34:42.837Z; the attempt finished2026-11-10T05:34:43.905Z. The fixed-host/path transport allowed at most one generateContent POST and no other model. A durable attempt marker prevents re-running the helper automatically, including after uncertain transport failures.

HTTP404 establishes that this requested model operation was unavailable to this attempt. It does not establish the precise reason, confirm authentication generally, or measure quota. The result is consistent with Google's documented existing-user restrictions for this legacy model, but the response does not independently prove that explanation.

## Verification status and next step

Real-provider structured output, citations, usage reporting and model quality remain **unverified**. The earlier160 passing regression tests remain mocked-provider/infrastructure evidence; this failed availability attempt is separate and must not be counted as a successful model smoke.

Any follow-up request or different model requires separate authorization and renewed model-specific quota/terms review. No automatic switch is permitted. Keep billing disabled and normal Gemini inference disabled.

Official context: [model availability](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash), [project/model rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Google unpaid-services terms](https://ai.google.dev/gemini-api/terms). No deletion or zero-retention guarantee is made for the synthetic content already transmitted.

## Separately authorized ListModels selection and second smoke

The user subsequently authorized ListModels discovery, an explicit configuration update, and one new synthetic smoke. One read-only ListModels call succeeded2026-11-10T05:39:55.479Z. The response advertised generateContent for gemini-3.5-flash-lite, version3.5-flash-lite-07-2026, with1048576 input and65536 output token limits. The failed gemini-2.5-flash was also advertised, demonstrating that listing metadata alone does not prove actual generation access or remaining quota.

Selected replacement: **gemini-3.5-flash-lite**, explicitly chosen from that response. Official documentation describes a stable text/image model with structured output and a free tier. Published standard input/output estimates match USD0.30/M andUSD2.50/M. The adapter now uses thinkingLevel=MINIMAL for this model; legacy2.5 retains thinkingBudget0 and its existing cutoff. Returned models remain strictly allowlisted. New model/protocol hashes require new consent; existing policies are not rewritten.

Private configuration now selects AI_PROVIDER=gemini and AI_MODEL=gemini-3.5-flash-lite. AI_ENABLED remains false and GEMINI_USAGE_CONFIRMED remains false. Billing and credentials were not changed. Additive migration0022_gemini_selected_model extends only the AI policy model constraint, preserving legacy/OpenAI rows and tenant controls.

The new exact synthetic packet used a separate case alias, consent hash and durable one-attempt marker. The child had no payment, database or original-storage credentials. Receipt: ignored .local/gemini-selected-model-smoke-2026-11-10.json.

| Item                                         | Actual result                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| New generation attempts                      | 1, no retry or additional fallback                                             |
| Requested model                              | gemini-3.5-flash-lite                                                          |
| Returned model                               | None                                                                           |
| HTTP / provider status                       | **400 INVALID_ARGUMENT**                                                       |
| Structured-output/citation/policy validation | Not run: no model output                                                       |
| Token usage                                  | Not returned                                                                   |
| Quota error / violations                     | None returned                                                                  |
| Caps                                         | 7000 input tokens; conservative estimate6407;512 output;USD0.0035 upper budget |
| Request timing                               | Dispatch05:46:58.357Z; finished05:47:00.990Z,2026-11-10                        |
| Billing changes / PayPal operations          | None                                                                           |

The exact rejected field was not retained by the secret-safe error normalizer; a cause must not be inferred from HTTP400 alone. This is a real rejected request, not a successful provider smoke. Generation compatibility, actual usage, quota and model quality remain unverified. No further generation request was made. Any diagnosis requiring another model call needs a new explicit authorization.

Offline regression verification: Formatting, lint, typecheck and all nine package builds passed. Unit tests: 56 passed. Integration tests: 97 passed against isolated real database/RLS, queue, storage and scanner fixtures, with provider responses mocked. The first browser run had 6 passes and 2 timeouts during a prolonged stall (uncertain-payment display and evidence-download journey); pnpm test:e2e was rerun without code or security changes and all 8 passed in 2.3 minutes. Thus the final suite results are 161 passing tests across the successful runs, not a clean first pnpm check invocation. An earlier test-argument typecheck error was corrected before rerunning. Migration 0022 succeeded on development and isolated test databases. These results do not establish real Gemini output quality or successful generation.

Official references: [replacement model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite), [thinking configuration](https://ai.google.dev/gemini-api/docs/thinking).

## Authorized application smoke � latest result

One authorized gemini-3.5-flash-lite application generation returned HTTP503 UNAVAILABLE after successful model metadata and token preflight (6224 conservative tokens). Actual scanned synthetic evidence and exact Google consent were used; consent was revoked after failure. No retry, model switch, payment operation or billing change. No output/usage returned, so real citations and merchant review remain pending. New versioned schema compatibility hardening does not establish the old400 root cause. See [integration readiness](INTEGRATION-READINESS.md) for caps, isolation and evidence.

## Fresh final authorized attempt - 2026-11-10

User reconfirmed billing disabled and available quota and authorized exactly one fresh synthetic request. Exact Google-specific context/source consent and CLEAN/scannedAt evidence checks passed. Model metadata confirmed gemini-3.5-flash-lite, advertised version3.5-flash-lite-07-2026; token preflight6224. Generation attempted once: HTTP503 UNAVAILABLE, normalized PROVIDER_HTTP_503, no quota violation returned. No output/model response, generation token usage or actual cost was returned. Structured-output/citation/policy validation and merchant review could not run. Consent revoked; attempt marker retained; no retries, model changes, PayPal access or billing changes. Cap16000input/4000output; upper estimate USD0.0148; reservation USD0.03. Private receipt .local/gemini-final-result.json. Further real generation requires fresh authorization; mocked success is not a substitute.

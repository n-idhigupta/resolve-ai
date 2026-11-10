# Gemini provider integration

Status: adapter and provider-independent verification implemented. A later, separately authorized one-request smoke returned HTTP404 NOT_FOUND on2026-11-10; see [the smoke report](GEMINI-SMOKE-REPORT.md). No further real request is authorized. Account eligibility, actual model access, quota and real output quality remain pending. The private key is never printed, returned to the browser or placed in payment/evidence worker environments.

## Resumed-work inventory

Inspection after the interruption found @google/genai3.0.0 already pinned in ai-core and pnpm-lock.yaml, with protobufjs optional build scripts explicitly denied. The SDK installation was preserved. No Gemini adapter, provider-selection implementation, consent changes, provider tests or documentation had been started. Existing Phase5 files, migrations, evaluation freeze and the verified payment were retained.

## Contracts and model status

The official Google Gen AI TypeScript SDK @google/genai3.0.0 is used through the existing AIProvider interface. Gemini Developer API v1beta, fixed generativelanguage.googleapis.com host; no Vertex, grounding, tools, file upload, model fallback or automatic model discovery. SDK retries are disabled (attempts1); the existing durable engine owns at most three budget-reserved attempts. HTTP redirects are denied, timeout45s, response1MiB.

The original implementation pinned gemini-2.5-flash. The current explicitly selected Gemini default is gemini-3.5-flash-lite; see the replacement section below. For the legacy model, Official model-specific and deprecation pages retrieved2026-11-10 say existing-user API access only and automatic routing to gemini-3.5-flash-lite on2026-12-01. The catalogue/search summaries still contained contradictory “not deprecated” wording. ResolveAI follows the conservative model-specific notice: no new model is silently selected, unexpected returned versions are rejected, and legacy2.5 calls are blocked on/after2026-12-01; this cutoff is not applied to the separately reviewed3.5 model. No account-level availability check was performed; a key or models.get result alone would not prove generation access.

Official references:

- [Model capabilities and availability](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)
- [Deprecation and rerouting notice](https://ai.google.dev/gemini-api/docs/deprecations#gemini-2.5-flash-models)
- [Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Token counting](https://ai.google.dev/gemini-api/docs/tokens)
- [SDK source and documentation](https://github.com/googleapis/js-genai)

## Configuration and credential separation

AI_PROVIDER=openai|gemini. AI_MODEL may be empty to select that provider’s documented default, or explicitly the reviewed matching model. Unknown providers, aliases such as latest, other models and mismatched pairs fail validation. OpenAI default remains gpt-5.4-mini-2026-03-17. The later user-authorized provider/model selection was written to private .env, while inference-enable flags remain disabled.

GEMINI_API_KEY is passed only to the selected restricted inference child. API and legacy payment-worker dotenv loaders exclude it; the launcher passes neither it nor an OpenAI key to payment/evidence workers. Inference receives only the selected provider’s key. GEMINI_USAGE_CONFIRMED=false is a nonsecret operational gate: account, region, billing and terms must first be reviewed. It is an operator attestation, not proof of account access. Leave it false during deferred verification. AI_ENABLED remains an explicit separate gate.

API /ai/config returns safe provider/model/disclosure/synthetic-only configuration, not a key or proof of worker/provider health. Switching configuration cannot migrate existing consent or send an OpenAI snapshot to Google; provider mismatch fails before preflight.

## Exact consent and unpaid-data restrictions

A new immutable AISharingPolicy records providerId, matching model, provider-specific disclosure and hash. Existing OpenAI policies default to providerId=openai without changing their content/hash. Existing OpenAI request envelopes and evaluation fingerprint remain unchanged. Google envelopes add a protocol/provider marker; consent hashes cover this normalized request and immutable policy. The exact Google SDK generation and token-count arguments are derived deterministically and displayed separately in the customer preview, with authentication excluded. Google has no OpenAI store:false control; the normalized envelope’s internal store:false field is not a Google retention setting.

[Unpaid-service terms](https://ai.google.dev/gemini-api/terms) allow product/model improvement and human review, subject to regional/billing exceptions, and prohibit sensitive, confidential or personal submissions. Customer consent does not override this prohibition. [Abuse monitoring](https://ai.google.dev/gemini-api/docs/usage-policies) documents55-day retention for prompts/context/output; that is not a universal deletion deadline for all unpaid-service/model-improvement data. ResolveAI promises neither zero retention nor recall/deletion of already transmitted material. The disclosure distinguishes the EEA/Switzerland/UK and active-billing exceptions without assuming the user qualifies.

Initial Gemini mode is therefore **trusted synthetic fixtures only**. All existing cases default to unauthorized. Only migration-authority fixtures may set synthetic provenance; there is no application endpoint to enable real customer cases. Approval binds Case.version. A public comment, evidence operation or other version change invalidates that provenance and existing Google context freshness; it requires trusted reclassification as well as new preview/consent. A trusted fixture label is not automated PII detection: fixture authors remain responsible for synthetic content. Paid-service handling of actual customer data needs a separately reviewed policy/mode.

Revocation, tenant/ownership checks, RLS, source catalogs, staleness and review constraints remain in the existing pipeline. Internal approval/revision stays nonbinding and never writes offers, case closure, payments or refunds.

## Structured output, tokens and budgets

Text and selected CLEAN evidence image derivatives map to SDK contents/inlineData. No remote image URLs are accepted. responseMimeType=application/json and responseJsonSchema use the existing strict schema; server-side Zod, source citations and deterministic candidate validation remain authoritative. One candidate, thinkingBudget0, maxOutputTokens4000. Unexpected models, refusals, truncation, invalid JSON/schema and absent usage fail closed. Returned thinking tokens are included in estimated output usage if present.

SDK3.0.0 rejects countTokens systemInstruction/generationConfig on the Developer API. This was verified using the actual SDK with mocked HTTP, not a real provider request. The count request includes the instruction and schema as additional text parts and adds a conservative schema-byte/2048-token overhead locally. This deliberately overestimates; it never substitutes an unbounded estimate. The existing16000 input/4000 output caps remain. If preflight is unavailable, the existing whole-envelope UTF-8-byte-plus2048 fallback is text-only; images fail closed without provider counting.

[Published standard rates](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash): text/image inputUSD0.30/M, output including thinkingUSD2.50/M. Integer micro-USD estimates use these paid upper-bound rates even for purported free usage; free-quota eligibility is not assumed. Configured maxima implyUSD0.0148, covered by the existingUSD0.03 attempt reservation. Unknown generation outcomes retain holds; successful usage releases the difference. Existing daily budgets, tenant serialization, start limits and recovery remain. Real billing and quota have not been measured; consult the actual project before any request.

## Migrations and verification

0020_gemini_provider adds provider/model pairing to immutable policies and protected synthetic-case provenance. 0021_gemini_fixture_freshness binds provenance to the case version and adds a Google-only freshness check. Both are additive, use existing FORCE RLS and retain existing OpenAI freshness behavior. No financial table/counter was changed.

Mocked-provider tests exercise SDK serialization, text/image/schema mapping, quota/transient errors, no hidden SDK retries, refusal/malformed usage/model mismatch, provider/key configuration, synthetic-only consent, changed-source freshness, budgets/unknown recovery, citation validation, merchant review and existing authorization. Browser verification includes separate OpenAI and Google consent/review cycles using real HTTP/database/storage/scanner/queues but mocked inference/configuration.

See PHASE-5-REPORT.md for the final commands, counts and actual outcomes.

## Deferred smoke verification

pnpm gemini:smoke:preview creates only .local/gemini-smoke-preview.json using fixed synthetic text, exact wire arguments, disclosure and budget; it loads no key and makes no network/database request. It does not record consent or run inference. Invocation without --preview refuses execution.

Real verification remains blocked by the user’s explicit no-request instruction and unconfirmed account eligibility/billing/model access. Before a future separately authorized smoke: review actual project region/billing/free-quota eligibility; verify model access without assuming metadata implies generation access; review the exact synthetic-only payload and Google consent; apply a small budget; then verify genuine structured output, citations, deterministic policy and authorized merchant review through the isolated test workflow. Never use the completed PayPal payment or real customer/private notes. No real-provider success, observed quota or quality metric is claimed here.

## Subsequent one-request authorization

The user later confirmed Free tier/nonzero remaining model quota and authorized one synthetic-only request. It returned404 NOT_FOUND, with no output or usage metadata. Execution stopped without retry, billing changes or model fallback. Earlier deferred-verification statements describe the implementation stage; the new attempt does not complete real-provider validation. See GEMINI-SMOKE-REPORT.md for the exact evidence and consent scope.

## Explicit replacement after ListModels discovery

On2026-11-10, the user authorized selecting a listed generateContent model and one new smoke. ListModels advertised gemini-3.5-flash-lite; it is now the explicit Gemini default and selected private AI_MODEL, with normal inference still disabled. This is an authorized configuration change, not runtime fallback. Legacy2.5 remains recognized for immutable historical policies with its original cutoff. OpenAI remains supported.

The selected stable model uses SDK thinkingLevel MINIMAL and protocol gemini-sdk-v2. Legacy2.5 uses thinkingBudget0/protocolv1. Both use the unchanged strict output schema, Google unpaid synthetic-only disclosure, RLS, source validation, consent/freshness and deterministic financial constraints. Model-specific returned-version allowlists include the dated version from ListModels; arbitrary/latest aliases remain rejected. Standard paid-rate upper-bound estimates for3.5 Flash-Lite are USD0.30/M input andUSD2.50/M output, matching the existing budget reserve.

Migration0022_gemini_selected_model extends the AISharingPolicy model pair check without rewriting any policy or consent. Existing cases require a new selected-model sharing policy and consent to use3.5; changing .env does not translate old requests.

One real replacement-model smoke returned400 INVALID_ARGUMENT with no output or usage metadata, and execution stopped. Model metadata is verified; actual generation acceptance remains pending. See GEMINI-SMOKE-REPORT.md for exact evidence. No billing or PayPal changes occurred.

## Current compatibility verification

New selected-model snapshots use gemini-sdk-v3 to reduce response JSON-schema grammar complexity; strict server validation is unchanged and old protocol mappings are preserved for historical consent. The latest authorized application smoke reached model metadata/counting but generation returned 503 UNAVAILABLE. No further request or model switch was performed. The previous 400 field was not retained and is not proven fixed. See INTEGRATION-READINESS.md and GEMINI-SMOKE-REPORT.md.

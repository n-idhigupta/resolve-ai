# Pinned dependencies

Node24.13.1; pnpm12.3.4. Exact manifests and pnpm-lock.yaml are authoritative. Existing stable versions are retained. Phase 3 adds a shared in-process payment package and reuses pg8.23.1/Zod4.6.7; the official browser SDK is loaded from its documented Sandbox v6 URL at runtime, not vendored. No live-provider compatibility claim is implied by local tests.

| Workspace                | Dependency               | Version |
| ------------------------ | ------------------------ | ------- |
| resolveai                | typescript               | 5.9.3   |
| resolveai                | turbo                    | 2.11.10 |
| resolveai                | eslint                   | 10.14.0 |
| resolveai                | typescript-eslint        | 8.72.1  |
| resolveai                | @eslint/js               | 10.0.1  |
| resolveai                | prettier                 | 3.9.10  |
| resolveai                | vitest                   | 5.1.0   |
| resolveai                | @playwright/test         | 1.65.0  |
| resolveai                | @types/node              | 24.10.1 |
| resolveai                | tsx                      | 4.23.15 |
| resolveai                | dotenv                   | 17.2.3  |
| resolveai                | ioredis                  | 6.0.0   |
| resolveai                | pg                       | 8.23.1  |
| resolveai                | zod                      | 4.6.7   |
| @resolveai/web           | react                    | 19.3.1  |
| @resolveai/web           | react-dom                | 19.3.1  |
| @resolveai/web           | react-router             | 8.5.1   |
| @resolveai/web           | ag-grid-community        | 36.3.0  |
| @resolveai/web           | ag-grid-react            | 36.3.0  |
| @resolveai/web           | @radix-ui/react-slot     | 1.5.0   |
| @resolveai/web           | class-variance-authority | 0.7.1   |
| @resolveai/web           | clsx                     | 2.1.1   |
| @resolveai/web           | tailwind-merge           | 3.7.0   |
| @resolveai/web           | zod                      | 4.6.7   |
| @resolveai/web           | vite                     | 8.3.7   |
| @resolveai/web           | @vitejs/plugin-react     | 6.3.0   |
| @resolveai/web           | tailwindcss              | 4.3.5   |
| @resolveai/web           | @tailwindcss/vite        | 4.3.5   |
| @resolveai/web           | @types/react             | 19.2.7  |
| @resolveai/web           | @types/react-dom         | 19.2.3  |
| @resolveai/api           | @fastify/cookie          | 11.1.5  |
| @resolveai/api           | @fastify/cors            | 11.4.1  |
| @resolveai/api           | @fastify/rate-limit      | 11.2.2  |
| @resolveai/api           | fastify                  | 5.12.8  |
| @resolveai/api           | zod                      | 4.6.7   |
| @resolveai/api           | @prisma/client           | 7.10.1  |
| @resolveai/api           | @prisma/adapter-pg       | 7.10.1  |
| @resolveai/api           | pg                       | 8.23.1  |
| @resolveai/api           | ioredis                  | 6.0.0   |
| @resolveai/api           | argon2                   | 0.45.2  |
| @resolveai/api           | dotenv                   | 17.2.3  |
| @resolveai/api           | prisma                   | 7.10.1  |
| @resolveai/api           | @types/pg                | 8.15.5  |
| @resolveai/worker        | bullmq                   | 6.7.2   |
| @resolveai/worker        | ioredis                  | 6.0.0   |
| @resolveai/worker        | pino                     | 10.4.0  |
| @resolveai/worker        | zod                      | 4.6.7   |
| @resolveai/worker        | dotenv                   | 17.2.3  |
| @resolveai/shared        | zod                      | 4.6.7   |
| @resolveai/policy-engine | zod                      | 4.6.7   |
| @resolveai/paypal-client | zod                      | 4.6.7   |
| @resolveai/payment-store | pg                       | 8.23.1  |
| @resolveai/payment-store | zod                      | 4.6.7   |
| @resolveai/payment-store | @types/pg                | 8.15.5  |

Development image pins remain PostgreSQL17.6-alpine, Redis7.4.6-alpine and SeaweedFS4.12 (linux/amd64 digests in compose.yaml). Native-build allowlist is unchanged.

## Phase 4 additions

New internal package @resolveai/case-store reuses pg8.23.1 and Zod4.6.7. Content validation pins sharp0.35.5 and pdf-lib1.17.1. ClamAV official Linux amd64 image is pinned at sha256:2a9be29239aea6c6fe17da9625f3c192f91974e61059d364e293f20277f931a3. Scanner signatures update independently and must be at most seven days old. Existing dependency pins remain unchanged; package manifests and lockfile are authoritative.

## Phase 5 additions

New workspace @resolveai/ai-core uses existing pinned TypeScript/Zod/pg versions. Added exact local extraction dependencies: sharp0.35.5, pdfjs-dist6.5.438 and @napi-rs/canvas1.1.0. No orchestration framework or OpenAI SDK dependency; fetch adapter uses pinned gpt-5.4-mini-2026-03-17, Responses and input-token counting. Account availability remains a real-provider acceptance check. Lockfile records workspace changes.

## Gemini addition

@google/genai3.0.0 is exact-pinned and retained from the interrupted session. Frozen installation passed; protobufjs optional build scripts are explicitly denied. SDK serialization/counting and retry behavior are tested with mocked HTTP, not real Google requests. Reviewed initial model remains gemini-2.5-flash with a fail-closed2026-12-01 revalidation boundary. See GEMINI.md.

Selected Gemini model updated by explicit user authorization to gemini-3.5-flash-lite after ListModels discovery2026-11-10. SDK remains3.0.0; minimal thinking uses the supported SDK enum and no model fallback was added. Legacy2.5 protocol/cutoff remain separate. See the smoke report for the unsuccessful real request.

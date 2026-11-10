# Render deployment preparation

`render.yaml` prepares two free web services with automatic deployments off. Nothing has been deployed or created. The API uses pinned Node/pnpm and the frozen lockfile; the web container uses the existing pinned Docker build. The Blueprint was validated against [Render's official schema](https://render.com/docs/blueprint-spec).

Before any approved deployment:

1. Supply an approved Git repository. Review the Blueprint before creating resources; importing it still creates services and triggers an initial build despite automatic deployments being off.
2. Provision approved external PostgreSQL/Redis/private object storage. Apply the existing role-provisioning scripts and all additive migrations through a separate migration connection. Give the API only the nonowner, NOBYPASSRLS runtime URL; never put migration credentials in its environment.
3. Enter the prompted secret settings in Render, not Git. `WEB_ORIGIN` is the exact HTTPS frontend origin; `API_UPSTREAM` is the API's HTTPS public origin with no path or trailing slash. Nginx proxies /api, /health and /ready using the upstream Host, TLS SNI and certificate verification. Browser requests remain same-origin and production cookies remain Secure.
4. Use an independent artifact encryption key and private storage buckets. Do not reuse local development credentials or copy `.env` into images. Confirm database/Redis TLS and required network access with the selected providers.
5. Verify `/ready`, session login/logout, CSRF rejection and tenant isolation after deployment. Validate role grants and migration status before exposing accounts.

PayPal, real refunds, external AI and development seeds remain disabled. No PayPal/Gemini secret is requested by this Blueprint. Production configuration intentionally rejects Sandbox financial execution; this preparation is not authorization to relax that guard. A publicly hosted live Sandbox demo would need a separately approved staging design.

No background worker, scanner, database, disk or paid service is provisioned here. Render free web instances sleep and cannot receive private-network traffic; use the API's public HTTPS origin for the proxy. A complete hosted evidence/AI/refund journey additionally requires approved separately credentialed workers and a reachable real ClamAV service. Free web services are not a production availability commitment. Do not describe this two-service template as a deployed full-stack system.

Local verification: web-image build and Nginx entrypoint/configuration checks are recorded in INTEGRATION-READINESS.md. Existing `deploy/compose.yaml` still uses the default `http://api:3001` upstream. Render API validation, actual builds/startup in Render, operational monitoring, backup recovery and vulnerability review remain pending approval/environment access.

## Exact Render steps (only after deployment approval)

1. Select the approved repository/branch containing `render.yaml`. In Render choose **New > Blueprint**, connect that repository and review the two-service plan. Do not click the final create/apply action until public deployment is approved. No database or worker is included automatically.
2. Have a DBA provision the migration-owned schema, nonowner runtime role, and named restricted roles required by the existing SQL migrations on an approved database. Local provisioning scripts are development-only and must not be run against production. No administrator or migration URL belongs in the API settings. PostgreSQL privileges/extension support must be confirmed before importing existing migrations.
3. From a trusted local terminal with only the approved target migration URL set privately, run `pnpm install --frozen-lockfile`, then `pnpm db:migrate`. This runs additive `prisma migrate deploy`, not reset or dev. Do not run seed/demo scripts against production or copy existing development transactions into another environment without approval.
4. Enter the environment settings below in Render. Determine the assigned service HTTPS URLs from its service configuration. Set the frontend origin on the API and API upstream on the web; leave automatic deploys off. Complete the initial build only after approval. If assigned URLs differ, update both settings and manually redeploy the affected services.
5. API build: `npm install --global pnpm@12.3.4 && pnpm install --frozen-lockfile --prod=false && pnpm build`. Start: `node apps/api/dist/main.js`. Web uses the root Dockerfile's final Nginx stage. Preserve the pinned Node/pnpm versions.
6. Visit `https://<WEB_HOST>/health`, `/ready`, `/status`, `/orders` and `/checkout`; confirm readiness200, no mixed content and proper unauthenticated states. Verify login/logout with an explicitly provisioned synthetic account, HTTPS Secure cookies, CSRF rejection and tenant access denial. Do not enable public signup or development seeding. Check backend logs only for sanitized request IDs/errors.
7. Keep the service private/unadvertised until post-deploy acceptance passes. An actual live Sandbox purchase/refund, provider worker activation or any paid resource still requires separate approval. A successful build alone is not a successful hosted end-to-end demo.

### API environment - every Blueprint setting

| Variable                                | Required value/source                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| NODE_VERSION                            | `24.13.1`                                                                                                                                       |
| NODE_ENV                                | `production`                                                                                                                                    |
| API_HOST / API_PORT                     | `0.0.0.0` / `3001`                                                                                                                              |
| PAYPAL_ENABLED / PAYPAL_REFUNDS_ENABLED | `false` / `false`; production guards reject Sandbox execution                                                                                   |
| AI_ENABLED / ENABLE_DEV_SEED            | `false` / `false`                                                                                                                               |
| WEB_ORIGIN                              | Exact frontend HTTPS origin, no path or trailing slash                                                                                          |
| DATABASE_URL                            | Approved PostgreSQL URL for nonowner runtime role; preserve password URL encoding; use provider-required verified TLS configuration             |
| REDIS_URL                               | Approved Redis URL; `rediss://` for hosted TLS                                                                                                  |
| SESSION_HASH_PEPPER / CSRF_SECRET       | Independent strong secrets, each at least32 characters                                                                                          |
| AI_ARTIFACT_KEY                         | Independent 32-byte key encoded as64 lowercase hexadecimal characters, matching existing artifacts; never generate over existing encrypted data |
| S3_ENDPOINT                             | Approved private S3-compatible HTTPS endpoint reachable from the API                                                                            |
| S3_REGION                               | Configured bucket region; default `us-east-1` only when correct                                                                                 |
| S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | Scoped storage credentials for the approved private buckets                                                                                     |
| S3_QUARANTINE_BUCKET / S3_CLEAN_BUCKET  | Existing private quarantine and clean bucket names                                                                                              |

Web environment: **API_UPSTREAM** is `https://<API_HOST>` only, no path or trailing slash. The frontend uses same-origin `/api/v1`; no provider key or database setting belongs in a `VITE_` variable. `MIGRATION_DATABASE_URL` is only for the separate trusted migration session. PayPal/Gemini keys, worker database URLs and ClamAV settings are deliberately not accepted by this two-service deployment packet; they require separately approved worker provisioning, not browser configuration.

### Public demo decision requiring the owner

The current production Blueprint can display persisted authorized records but cannot execute Sandbox checkout/refunds or run the local mock-worker demo. Do **not** advertise it as a live full Sandbox demo. Choose between a recording of the verified Sandbox integration plus the clearly labelled local mock-AI journey, or authorize a separately reviewed public staging setup with HTTPS, private storage/scanner and restricted workers. Do not set `NODE_ENV=development` on a public service to bypass financial guards. No changes to those guards are part of final delivery.

References checked: [Blueprint](https://render.com/docs/blueprint-spec), [free service limits](https://render.com/docs/free). Free services share workspace quotas and can sleep; no availability or zero-overage guarantee is implied. Keep billing disabled and approve any resource separately.

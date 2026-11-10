import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { requestEnvelope, DISCLOSURE } from '../packages/ai-core/dist/index.js';
const file = '.local/ai-smoke-request.json';
const digest = (x) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');
if (process.argv.includes('--preview')) {
  const context = {
    caseSummary: { reason: 'OTHER', requestedOutcome: 'HELP' },
    sources: [
      {
        key: 'S001',
        kind: 'ALLEGATION',
        text: 'Synthetic case SYNTHETIC-SMOKE-001: the sample parcel has not arrived.',
        page: null,
      },
    ],
    policy: { legacy: true },
    constraints: {
      candidates: [
        {
          id: 'C0',
          kind: 'REQUEST_MORE_INFORMATION',
          amountMinor: null,
          currency: null,
        },
        {
          id: 'C1',
          kind: 'ESCALATE_TO_HUMAN',
          amountMinor: null,
          currency: null,
        },
      ],
    },
    omissions: [],
  };
  const images = [];
  if (process.argv.includes('--image')) {
    const require = createRequire(import.meta.url),
      sharp = (
        await import(
          pathToFileURL(
            require.resolve('sharp', { paths: ['packages/ai-core'] }),
          ).href
        )
      ).default;
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#00a080' },
    })
      .png()
      .toBuffer();
    context.sources.push({
      key: 'S002',
      kind: 'DOCUMENT_OBSERVATION',
      text: 'Synthetic teal square; not transaction evidence.',
      page: null,
    });
    images.push({
      sourceId: 'S002',
      dataUrl: 'data:image/png;base64,' + png.toString('base64'),
    });
  }
  const manifest = {
    caseId: 'SYNTHETIC-SMOKE-001',
    sourceHashes: [digest(context.sources[0])],
    sharingPolicyVersion: 'synthetic-sharing-v1',
    synthetic: true,
  };
  const packet = {
    manifest,
    disclosure: DISCLOSURE,
    request: requestEnvelope(context, images),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  mkdirSync('.local', { recursive: true });
  writeFileSync(file, JSON.stringify(packet, null, 2));
  console.log(
    'Review the exact synthetic-only request and retention disclosure in ' +
      file +
      '. Consent hash: ' +
      digest(packet),
  );
  process.exit(0);
}
if (
  process.env.RUN_REAL_AI_SMOKE !== 'true' ||
  process.env.AI_SMOKE_SHARING_ACK !== 'I_REVIEWED_THE_EXACT_SYNTHETIC_REQUEST'
)
  throw Error(
    'Explicit real-provider opt-in and sharing acknowledgment required',
  );
const packet = JSON.parse(readFileSync(file, 'utf8'));
if (
  packet.manifest.caseId !== 'SYNTHETIC-SMOKE-001' ||
  !packet.manifest.synthetic ||
  Date.parse(packet.expiresAt) <= Date.now() ||
  digest(packet) !== process.env.AI_SMOKE_CONSENT_HASH
)
  throw Error('Exact synthetic manifest consent missing or expired');
const local = parse(readFileSync('.env'));
const key = process.env.OPENAI_API_KEY ?? local.OPENAI_API_KEY;
if (!key) throw Error('OPENAI_API_KEY_REQUIRED_REAL_VERIFICATION_PENDING');
const env = {};
for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
  if (process.env[name]) env[name] = process.env[name];
Object.assign(env, {
  OPENAI_API_KEY: key,
  AI_SMOKE_CONSENT_HASH: digest(packet),
  AI_SMOKE_LIMIT_MICROS: '30000',
});
// Child has no database, storage, PayPal, or session credentials. Fixed provider host; one generation only.
const usedFile = '.local/ai-smoke-used.json';
let used = [];
try {
  used = JSON.parse(readFileSync(usedFile, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (used.includes(digest(packet)))
  throw Error('SMOKE_ALREADY_DISPATCHED_PREPARE_AND_CONSENT_AGAIN');
writeFileSync(usedFile, JSON.stringify([...used, digest(packet)]));
const child = spawnSync(process.execPath, ['scripts/ai-smoke-child.mjs'], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
process.exitCode = child.status ?? 1;

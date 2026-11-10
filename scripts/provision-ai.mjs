import { config, parse } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
config({ quiet: true });
if (process.env.NODE_ENV === 'production')
  throw Error(
    'Local role provisioning is forbidden in production; use the documented DBA procedure',
  );
for (const [file, role] of [
  ['.env', 'resolve_ai'],
  ['.env.test', 'resolve_ai_test'],
]) {
  const text = readFileSync(file, 'utf8'),
    env = parse(text),
    target = new URL(env.DATABASE_URL);
  if (
    !['/resolveai', '/resolveai_test'].includes(target.pathname) ||
    !['localhost', '127.0.0.1'].includes(target.hostname)
  )
    throw Error('Local database target required');
  const previous = env.AI_DATABASE_URL,
    password = previous
      ? decodeURIComponent(new URL(previous).password)
      : randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(password))
    throw Error('Expected generated hexadecimal local worker password');
  const admin = new URL(target);
  admin.username = 'resolve_admin';
  admin.password = process.env.POSTGRES_ADMIN_PASSWORD;
  const db = new pg.Client({ connectionString: admin.href });
  await db.connect();
  try {
    const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
      role,
    ]);
    if (!exists.rowCount)
      await db.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
      );
    await db.query(
      `GRANT CONNECT ON DATABASE ${target.pathname.slice(1)} TO ${role}`,
    );
  } finally {
    await db.end();
  }
  target.username = role;
  target.password = password;
  const updated =
    text.replace(/^AI_DATABASE_URL=.*\r?\n?/m, '').trimEnd() +
    '\nAI_DATABASE_URL=' +
    target.href +
    '\n';
  writeFileSync(file, updated);
}
console.log(
  'Provisioned local/test non-owner AI inference roles; worker URLs saved only in ignored environment files.',
);

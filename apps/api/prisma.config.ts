import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      'postgresql://unconfigured:unconfigured@localhost:5432/resolveai',
  },
});

import { defineConfig } from 'prisma/config';

// Load .env if present (never overrides variables already set in the environment).
try {
  process.loadEnvFile();
} catch {
  // No .env: CI / Docker provide real environment variables.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` does not need a URL; migrate commands do.
    url: process.env.DATABASE_URL ?? '',
  },
});

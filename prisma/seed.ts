/**
 * Demo data: three sources (github, stripe, demo), each with a destination pointing at the
 * sample receiver (scripts/mock-receiver.ts). Safe to run repeatedly (upsert).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, SignatureScheme } from '../src/generated/prisma/client';

const DESTINATION_URL = process.env.SEED_DESTINATION_URL ?? 'http://localhost:4000/webhook';
// The sample receiver verifies X-HookRelay-Signature with this secret.
const DESTINATION_SECRET = process.env.SEED_DESTINATION_SECRET ?? 'whsec_dev_receiver_secret';

const SOURCES = [
  { name: 'github', scheme: SignatureScheme.GITHUB, secret: 'dev-github-secret' },
  { name: 'stripe', scheme: SignatureScheme.STRIPE, secret: 'whsec_dev_stripe_secret' },
  { name: 'demo', scheme: SignatureScheme.GENERIC, secret: 'dev-demo-secret' },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    for (const { name, scheme, secret } of SOURCES) {
      const source = await prisma.source.upsert({
        where: { name },
        update: { scheme, secret },
        create: { name, scheme, secret },
      });
      const existing = await prisma.destination.findFirst({
        where: { sourceId: source.id, url: DESTINATION_URL },
      });
      if (!existing) {
        await prisma.destination.create({
          data: { sourceId: source.id, url: DESTINATION_URL, secret: DESTINATION_SECRET },
        });
      }
      console.log(`✔ source "${name}" (${scheme}) -> ${DESTINATION_URL}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

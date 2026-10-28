/**
 * Sends signed webhooks to the seeded sources, the way the real providers would.
 *
 *   npm run send -- github              # one event in GitHub format
 *   npm run send -- stripe 5            # five events in Stripe format
 *   npm run send -- demo 1 --duplicate  # send the same event twice (idempotency)
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE_URL = process.env.HOOKRELAY_URL ?? 'http://localhost:3000';
const SECRETS: Record<string, string> = {
  github: process.env.GITHUB_SECRET ?? 'dev-github-secret',
  stripe: process.env.STRIPE_SECRET ?? 'whsec_dev_stripe_secret',
  demo: process.env.DEMO_SECRET ?? 'dev-demo-secret',
};

const hmac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

function build(source: string): { body: string; headers: Record<string, string> } {
  const secret = SECRETS[source];
  if (!secret) throw new Error(`Unknown source "${source}" (github | stripe | demo)`);

  if (source === 'github') {
    const body = JSON.stringify({ action: 'opened', issue: { number: 42, title: 'Bug report' } });
    return {
      body,
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${hmac(secret, body)}`,
      },
    };
  }
  if (source === 'stripe') {
    const body = JSON.stringify({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      type: 'payment_intent.succeeded',
      data: { object: { amount: 4999, currency: 'try' } },
    });
    const t = Math.floor(Date.now() / 1000);
    return { body, headers: { 'stripe-signature': `t=${t},v1=${hmac(secret, `${t}.${body}`)}` } };
  }
  const body = JSON.stringify({ id: randomUUID(), type: 'order.created', total: 120 });
  return { body, headers: { 'x-signature': `sha256=${hmac(secret, body)}` } };
}

async function send(source: string, webhook: ReturnType<typeof build>): Promise<void> {
  const res = await fetch(`${BASE_URL}/hooks/${source}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...webhook.headers },
    body: webhook.body,
  });
  console.log(`${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  const [source = 'github', countArg = '1', ...flags] = process.argv.slice(2);
  for (let i = 0; i < Number(countArg); i++) {
    const webhook = build(source);
    await send(source, webhook);
    if (flags.includes('--duplicate')) await send(source, webhook);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

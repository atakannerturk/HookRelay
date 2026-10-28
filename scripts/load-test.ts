/**
 * Load test for POST /hooks/demo. Every request carries a unique event id and a valid
 * signature, so the measured path is the real one: signature check + Redis idempotency +
 * Postgres write + enqueue.
 *
 *   npm run loadtest                       # 50 connections, 20 s
 *   CONNECTIONS=100 DURATION=30 npm run loadtest
 */
import autocannon from 'autocannon';
import { createHmac, randomUUID } from 'node:crypto';

const url = process.env.HOOKRELAY_URL ?? 'http://localhost:3000';
const secret = process.env.DEMO_SECRET ?? 'dev-demo-secret';
const connections = Number(process.env.CONNECTIONS ?? 50);
const duration = Number(process.env.DURATION ?? 20);

async function main(): Promise<void> {
  console.log(`Load test: ${url}/hooks/demo, ${connections} connections, ${duration} s\n`);
  const result = await autocannon({
    url,
    connections,
    duration,
    requests: [
      {
        method: 'POST',
        path: '/hooks/demo',
        setupRequest: (request) => {
          const body = JSON.stringify({ id: randomUUID(), type: 'load.test', amount: 1 });
          const signature = createHmac('sha256', secret).update(body).digest('hex');
          return {
            ...request,
            body,
            headers: { 'content-type': 'application/json', 'x-signature': `sha256=${signature}` },
          };
        },
      },
    ],
  });

  console.log('| Metric | Value |');
  console.log('| --- | --- |');
  console.log(`| Connections / duration | ${connections} / ${duration} s |`);
  console.log(`| Total requests | ${result.requests.total} |`);
  console.log(`| Requests/s (avg) | ${result.requests.average} |`);
  console.log(`| Latency p50 | ${result.latency.p50} ms |`);
  console.log(`| Latency p97.5 | ${result.latency.p97_5} ms |`);
  console.log(`| Latency p99 | ${result.latency.p99} ms |`);
  console.log(`| 2xx | ${result['2xx']} |`);
  console.log(
    `| Errors (non-2xx / connection / timeout) | ${result.non2xx} / ${result.errors} / ${result.timeouts} |`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

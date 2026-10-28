/**
 * Sample destination server. Handles the requests HookRelay delivers:
 *  - verifies X-HookRelay-Signature (401 if invalid)
 *  - answers 500 at FAIL_RATE (to watch retries and the dead-letter list)
 *  - skips events it has already processed (an idempotent consumer)
 *
 * Usage: FAIL_RATE=0.5 npm run receiver
 */
import { createServer } from 'node:http';
import { SIGNATURE_HEADER, verifySignature } from '../src/delivery/signature';

const port = Number(process.env.PORT ?? 4000);
const failRate = Number(process.env.FAIL_RATE ?? 0);
const secret = process.env.DESTINATION_SECRET ?? 'whsec_dev_receiver_secret';
const processed = new Set<string>();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const eventId = String(req.headers['x-hookrelay-event-id'] ?? '-');
    const attempt = String(req.headers['x-hookrelay-attempt'] ?? '?');
    const signature = String(req.headers[SIGNATURE_HEADER] ?? '');

    if (!verifySignature(secret, body, signature)) {
      console.log(`✖ ${eventId} invalid signature`);
      res.writeHead(401).end('invalid signature');
      return;
    }
    if (Math.random() < failRate) {
      console.log(`✖ ${eventId} attempt ${attempt}: simulated failure (500)`);
      res.writeHead(500).end('simulated failure');
      return;
    }

    const duplicate = processed.has(eventId);
    processed.add(eventId);
    const type = req.headers['x-hookrelay-event-type'] ?? '';
    console.log(
      `✔ ${eventId} ${type} attempt ${attempt}${duplicate ? ' (already processed, skipped)' : ''}`,
    );
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});

server.listen(port, () => {
  console.log(`Sample receiver listening on :${port} (FAIL_RATE=${failRate})`);
});

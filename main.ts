// Entrypoint: bind, register with the trial env, wait for done, exit 0.
//
// Two modes. With MAKEFUN_ENV_URL set (a trial) the process binds an
// ephemeral port on 0.0.0.0, POSTs {"port": N} to $MAKEFUN_ENV_URL/register
// until the env accepts it, then polls GET $MAKEFUN_ENV_URL/done until it
// answers {"done": true} and exits 0 — never before. Without it the
// process runs standalone on FORGE_PORT (default 18080, loopback only)
// until it is stopped, which is how the suite is graded locally.

import { buildServer } from './src/server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const STANDALONE_PORT = Number.parseInt(process.env.FORGE_PORT ?? '18080', 10);

const SINGLE_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function log(line: string): void {
  process.stdout.write(`[forge2] ${line}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env takes it (200) or another entry already won (409). */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(SINGLE_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused: HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoff(attempt));
  }
}

/** Poll GET /done until the env says the trial is over. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(SINGLE_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet: keep polling.
    }
    await pause(backoff(attempt));
  }
}

async function runStandalone(): Promise<number> {
  const server = buildServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(STANDALONE_PORT, '127.0.0.1', () => resolve());
  });
  log(`standalone on http://127.0.0.1:${STANDALONE_PORT}`);
  await new Promise(() => {
    // Serve until the process is stopped.
  });
  return 0;
}

async function runTrial(): Promise<number> {
  const server = buildServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
  log(`listening on port ${address.port}`);
  await announce(address.port);
  log('registered; waiting for done');
  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  log('done');
  return 0;
}

try {
  const code = ENV_URL === '' ? await runStandalone() : await runTrial();
  process.exit(code);
} catch (err) {
  process.stderr.write(`[forge2] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

/**
 * RATE-1: rate-limit buckets a KV dump cannot turn back into an IP, one reader
 * for "who is calling", and readiness flags the missing key cannot switch off.
 *
 * Run: cd apps/web && npx vitest run __tests__/lib/rateLimitKey.test.ts
 *
 * THE LEAK. Every rate-limited route stored its counter under
 * `sha256(ip + salt)[0:12]`, and every salt is a literal in this public
 * repository (`RATE_SALT = 'p01:issue-note:v1'`, the pairing relay's `'salt'`).
 * A dump of the KV is then an IP x hour x route log: a /16 is 65,536 candidates
 * per public salt and the whole IPv4 space was measured at 2,511 s
 * (scratchpad `bench-leak-at-rest.log`). The positive control below recovers the
 * IP from that formula with the same brute force that must find nothing once
 * `P01_RATE_LIMIT_KEY` is set.
 *
 * WHAT THE BRUTE FORCE CAN AND CANNOT SAY. It tries every public salt the
 * routes carry (read from the route files, so a new route is covered without a
 * list here) in both concatenation orders. It cannot prove a keyed bucket is
 * unrecoverable; that rests on the key being secret. So a second case reads the
 * bucket by what MOVES it: two worlds that differ only in the key must give two
 * buckets. A bucket the key does not move is a function of public inputs, and a
 * dump holder computes it without any key at all.
 *
 * READINESS. `configured` (issue-note) and `ready` (relay-to-buyer) are both
 * `reasons.length === 0`, so a missing key pushed into `reasons` would switch
 * the shield path off. The cases below pin that it lands in `advisories` only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const h = vi.hoisted(() => ({ store: null as unknown }));

// Only the store resolution is replaced; `rateLimitExceeded` and
// `rateLimitRemaining` stay the real ones, which is what the dump is made of.
vi.mock('@/lib/waitlist/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/waitlist/store')>();
  return { ...actual, getStore: () => h.store };
});

// The relay readiness reads the float's balance and history. Offline here: a
// read that throws is reported as `null`, which the route never folds into
// `ready`, so the readiness answer depends on configuration alone.
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getBalance(): Promise<number> {
        throw new Error('offline in rateLimitKey.test.ts');
      }
      async getSignaturesForAddress(): Promise<never[]> {
        throw new Error('offline in rateLimitKey.test.ts');
      }
    },
  };
});

import { rateLimitExceeded, rateLimitRemaining } from '@/lib/waitlist/store';

const WEB_ROOT = join(__dirname, '..', '..');
const API_ROOT = join(WEB_ROOT, 'app', 'api');

/** Synthetic. Inside 10.77.0.0/16, the range the brute force walks. */
const VICTIM_IP = '10.77.201.14';
const FROZEN = new Date('2026-09-16T10:30:00.000Z');
/** A synthetic 64-hex key. Never a deployment's. */
const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every salt a reader of the public repository has: the route literals, the
 *  pairing relay's fallback, and the empty string. */
function publicSalts(): string[] {
  const salts = new Set<string>(['salt', '']);
  for (const f of filesUnder(API_ROOT)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/RATE_SALT\s*=\s*['"]([^'"]+)['"]/g)) {
      salts.add(m[1]);
    }
  }
  return [...salts];
}

/** Walk 10.77.0.0/16 once with every public salt; for each bucket, return what
 *  reproduces it. One walk for all buckets: the hashing is the cost (one walk
 *  measured at 755 ms alone in gates/G3/web-default-rateLimitKey-alone-G3-r1.log),
 *  so one walk per bucket pushed the 5-route case past the 5 s test timeout. */
function bruteForce16(buckets: string[], salts: string[]): string[][] {
  for (const bucket of buckets) {
    if (!/^[0-9a-f]{8,}$/.test(bucket)) throw new Error(`not a hex bucket: ${bucket}`);
  }
  const hits: string[][] = buckets.map(() => []);
  for (let a = 0; a < 256; a += 1) {
    for (let b = 0; b < 256; b += 1) {
      const ip = `10.77.${a}.${b}`;
      for (const salt of salts) {
        const after = sha256Hex(ip + salt);
        const before = sha256Hex(salt + ip);
        buckets.forEach((bucket, i) => {
          if (after.startsWith(bucket) || before.startsWith(bucket)) hits[i].push(`${ip} via '${salt}'`);
        });
      }
    }
  }
  return hits;
}

/** A KV that records the keys it is asked for, like a dump would hold them. */
function recordingKv() {
  const keys: string[] = [];
  return {
    keys,
    incr: vi.fn(async (k: string) => {
      keys.push(k);
      return 1;
    }),
    expire: vi.fn(async () => 1),
    get: vi.fn(async (k: string) => {
      keys.push(k);
      return null;
    }),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  };
}

/** The bucket part of a `wl:rl:<bucket>:<hour>` row. */
function storeBucket(key: string): string {
  const m = /^wl:rl:([^:]+):/.exec(key);
  if (!m) throw new Error(`not a rate row: ${key}`);
  return m[1];
}

async function waitlistStoreBucket(ip: string, salt: string): Promise<string> {
  const kv = recordingKv();
  await rateLimitExceeded(kv as never, ip, salt, 3);
  return storeBucket(kv.keys[0]);
}

type PairMem = Map<string, { n: number; exp: number }>;

/** The bucket the pairing relay writes for `ip`, through the real module. */
async function pairStoreBucket(ip: string): Promise<string> {
  vi.resetModules();
  const mem = (globalThis as unknown as { __p01PairRlMem?: PairMem }).__p01PairRlMem;
  mem?.clear();
  const { pairRateLimitExceeded } = await import('@/lib/pairStore');
  await pairRateLimitExceeded('take', ip, 60);
  const rows = [...((globalThis as unknown as { __p01PairRlMem: PairMem }).__p01PairRlMem.keys())];
  const m = /^p01pair:rl:take:([^:]+):/.exec(rows[0] ?? '');
  if (!m) throw new Error(`no pairing rate row: ${rows.join(',')}`);
  return m[1];
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // The dev in-memory backends, never a real KV.
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('WAITLIST_STATS_TOKEN', '');
  vi.stubEnv('P01_RATE_LIMIT_KEY', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN);
  h.store = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// Each case below walks a whole /16 (65,536 IPs x every public salt): about
// 1 s here, over 5 s on a GitHub runner (CI run 35769553676, 2026-09-22),
// where vitest's 5 s default failed them. The work is the point of the test,
// so the budget moves, not the walk.
describe('keyed bucket not reversible from a KV dump', { timeout: 60_000 }, () => {
  it('positive control: the /16 brute force recovers the IP from the public-salt formula', () => {
    const salts = publicSalts();
    // 5 route literals + 'salt' + ''. Fewer means the scan stopped reading them.
    expect(salts.length).toBeGreaterThanOrEqual(7);
    const t0 = performance.now();
    // Both buckets in one walk, the same multi-bucket path the keyed case uses,
    // so this also shows each hit is attributed to its own bucket.
    const [hits, pairHits] = bruteForce16(
      [sha256Hex(VICTIM_IP + 'p01:issue-note:v1').slice(0, 12), sha256Hex(VICTIM_IP + 'salt').slice(0, 12)],
      salts,
    );
    const ms = performance.now() - t0;
    expect(hits).toEqual([`${VICTIM_IP} via 'p01:issue-note:v1'`]);
    expect(pairHits).toEqual([`${VICTIM_IP} via 'salt'`]);
    // Reported, not asserted: machine-dependent. RATE-1-green.log carries it.
    console.info(`[rateLimitKey] /16 x ${salts.length} salts x 2 orders brute force, 2 buckets: ${ms.toFixed(0)} ms`);
  });

  it('with P01_RATE_LIMIT_KEY set, the brute force with every public salt matches nothing in any route bucket', async () => {
    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_A);
    const salts = publicSalts();
    const routes = salts.filter((s) => s.startsWith('p01:'));
    // The 5 route literals. Fewer means the loop below checks less than it says.
    expect(routes.length).toBeGreaterThanOrEqual(5);
    const buckets: string[] = [];
    for (const salt of routes) buckets.push(await waitlistStoreBucket(VICTIM_IP, salt));
    const hits = bruteForce16(buckets, salts);
    routes.forEach((salt, i) => {
      expect(hits[i], `route ${salt}`).toEqual([]);
      expect(buckets[i], `route ${salt}`).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  it('with P01_RATE_LIMIT_KEY set, the pairing relay bucket matches nothing either', async () => {
    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_A);
    const bucket = await pairStoreBucket(VICTIM_IP);
    expect(bruteForce16([bucket], publicSalts())).toEqual([[]]);
    expect(bucket).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the keyed bucket moves with the key, the hour and the route, and is identical when nothing moves', async () => {
    const salt = 'p01:relay-to-buyer:v1';
    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_A);
    const base = await waitlistStoreBucket(VICTIM_IP, salt);
    const again = await waitlistStoreBucket(VICTIM_IP, salt);
    const route2 = await waitlistStoreBucket(VICTIM_IP, 'p01:issue-note:v1');
    vi.setSystemTime(new Date(FROZEN.getTime() + 3_600_000));
    const hour2 = await waitlistStoreBucket(VICTIM_IP, salt);
    vi.setSystemTime(FROZEN);
    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_B);
    const key2 = await waitlistStoreBucket(VICTIM_IP, salt);

    // Determinism first: without it every world differs and nothing is shown.
    expect(again).toBe(base);
    expect(key2, 'the key does not move the bucket').not.toBe(base);
    expect(hour2, 'the hour does not move the bucket').not.toBe(base);
    expect(route2, 'the route does not move the bucket').not.toBe(base);

    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_A);
    const pairA = await pairStoreBucket(VICTIM_IP);
    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_B);
    const pairB = await pairStoreBucket(VICTIM_IP);
    expect(pairB, 'the key does not move the pairing bucket').not.toBe(pairA);
  });

  it('the preview reads the very bucket the limiter increments, keyed or not', async () => {
    for (const key of ['', KEY_A]) {
      vi.stubEnv('P01_RATE_LIMIT_KEY', key);
      const kv = recordingKv();
      await rateLimitExceeded(kv as never, VICTIM_IP, 'p01:relay-to-buyer:v1', 3);
      await rateLimitRemaining(kv as never, VICTIM_IP, 'p01:relay-to-buyer:v1', 3);
      expect(kv.keys).toHaveLength(2);
      expect(kv.keys[1]).toBe(kv.keys[0]);
    }
  });

  it('unset (or too short to be a secret) keeps today\'s formula in both stores', async () => {
    for (const key of ['', '   ', 'salt']) {
      vi.stubEnv('P01_RATE_LIMIT_KEY', key);
      expect(await waitlistStoreBucket(VICTIM_IP, 'p01:issue-note:v1')).toBe(
        sha256Hex(VICTIM_IP + 'p01:issue-note:v1').slice(0, 12),
      );
      expect(await pairStoreBucket(VICTIM_IP)).toBe(sha256Hex(VICTIM_IP + '').slice(0, 12));
    }
  });
});

// ---------------------------------------------------------------------------

/** Header names a route would read to learn the caller's address itself. */
const IP_HEADER = /x-real-ip|x-forwarded-for|x-vercel-forwarded-for|cf-connecting-ip|true-client-ip|x-client-ip/i;

function localIpParsers(files: { path: string; text: string }[]): string[] {
  return files.filter((f) => IP_HEADER.test(f.text)).map((f) => f.path).sort();
}

function apiSources(): { path: string; text: string }[] {
  return filesUnder(API_ROOT).map((p) => ({
    path: relative(WEB_ROOT, p).replace(/\\/g, '/'),
    text: readFileSync(p, 'utf8'),
  }));
}

function getReq(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: 'GET', headers } as unknown as ConstructorParameters<
    typeof NextRequest
  >[1]);
}

const TICKET = 'rate-1-ticket';
const KEY_ADVISORY = expect.arrayContaining([expect.stringContaining('P01_RATE_LIMIT_KEY')]);

function configureIssueAndRelay() {
  vi.stubEnv('P01_TREASURY_POOL_SEED', 'ab'.repeat(32));
  vi.stubEnv('P01_TREASURY_NOTE_LEAVES', '83-85');
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(Keypair.generate().secretKey));
  vi.stubEnv('P01_TILL_ADDRESS', Keypair.generate().publicKey.toBase58());
  vi.stubEnv('P01_FEE_WALLET', Keypair.generate().publicKey.toBase58());
  vi.stubEnv('P01_FUNDER_RPC', 'http://127.0.0.1:9');
  h.store = recordingKv();
}

async function readiness() {
  vi.resetModules();
  const issue = await import('@/app/api/issue-note/route');
  const relay = await import('@/app/api/relay-to-buyer/route');
  const issueBody = await (await issue.GET()).json();
  const relayBody = await (
    await relay.GET(getReq('http://localhost:3000/api/relay-to-buyer', { 'x-real-ip': VICTIM_IP }))
  ).json();
  return { issueBody, relayBody };
}

describe('one IP reader; readiness unchanged', () => {
  it('positive control: the detector flags a route that reads an IP header', () => {
    const planted = [
      { path: 'app/api/a/route.ts', text: "const ip = req.headers.get('x-forwarded-for');" },
      { path: 'app/api/b/route.ts', text: 'h.get("X-Real-IP")' },
      { path: 'app/api/c/route.ts', text: "import { clientIp } from '@/lib/net/clientIp';" },
    ];
    expect(localIpParsers(planted)).toEqual(['app/api/a/route.ts', 'app/api/b/route.ts']);
  });

  it('no file under app/api parses an IP header itself', () => {
    expect(localIpParsers(apiSources())).toEqual([]);
  });

  it('every rate-limited route reads the caller through lib/net/clientIp', () => {
    const limited = apiSources().filter((f) =>
      /\b(rateLimitExceeded|rateLimitRemaining|pairRateLimitExceeded)\s*\(/.test(f.text),
    );
    // issue-note, contribute-note, claim-for-payment, relay-to-buyer,
    // fund-ephemeral, waitlist, pair/[id].
    expect(limited.length).toBeGreaterThanOrEqual(7);
    const without = limited
      .filter((f) => !/import\s*\{[^}]*\bclientIp\b[^}]*\}\s*from\s*['"]@\/lib\/net\/clientIp['"]/.test(f.text))
      .map((f) => f.path);
    expect(without).toEqual([]);
  });

  it('the RATE-1 sources hold no raw control byte, so git, grep and rg read them as text', () => {
    // A raw NUL makes git show the file as binary and grep/rg skip it, which
    // hides it from every text sweep. Tab, LF and CR are the only bytes < 0x20 allowed.
    const controlBytes = (buf: Buffer) => buf.filter((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d).length;
    expect(controlBytes(Buffer.from('a\u0000b\u0000c'))).toBe(2); // positive control
    const files = [
      'lib/net/clientIp.ts',
      'lib/pairStore.ts',
      'lib/waitlist/store.ts',
      '__tests__/lib/rateLimitKey.test.ts',
      ...filesUnder(API_ROOT).map((p) => relative(WEB_ROOT, p).replace(/\\/g, '/')),
    ];
    const dirty = files.filter((f) => controlBytes(readFileSync(join(WEB_ROOT, f))) > 0);
    expect(dirty).toEqual([]);
  });

  it('clientIp: x-real-ip, else the first forwarded entry, else unknown', async () => {
    const { clientIp } = await import('@/lib/net/clientIp');
    const u = 'http://localhost:3000/api/x';
    expect(clientIp(getReq(u, { 'x-real-ip': ' 203.0.113.5 ', 'x-forwarded-for': '198.51.100.1' }))).toBe(
      '203.0.113.5',
    );
    expect(clientIp(getReq(u, { 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' }))).toBe('198.51.100.1');
    expect(clientIp(getReq(u))).toBe('unknown');
  });

  it('with the key unset, configured and ready stay true and advisories names the key', async () => {
    configureIssueAndRelay();
    const { issueBody, relayBody } = await readiness();
    expect(issueBody.advisories).toEqual(KEY_ADVISORY);
    expect(relayBody.advisories).toEqual(KEY_ADVISORY);
    expect(issueBody.configured).toBe(true);
    expect(relayBody.ready).toBe(true);
    expect(JSON.stringify(issueBody.reasons)).not.toContain('P01_RATE_LIMIT_KEY');
    expect(JSON.stringify(relayBody.reasons)).not.toContain('P01_RATE_LIMIT_KEY');
  });

  it('with the key set, advisories are empty, readiness is the same, and the key is never echoed', async () => {
    configureIssueAndRelay();
    vi.stubEnv('P01_RATE_LIMIT_KEY', KEY_A);
    const { issueBody, relayBody } = await readiness();
    expect(issueBody.advisories).toEqual([]);
    expect(relayBody.advisories).toEqual([]);
    expect(issueBody.configured).toBe(true);
    expect(relayBody.ready).toBe(true);
    expect(JSON.stringify(issueBody)).not.toContain(KEY_A);
    expect(JSON.stringify(relayBody)).not.toContain(KEY_A);
  });
});

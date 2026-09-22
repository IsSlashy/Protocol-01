/**
 * What POST /api/fund-ephemeral leaves in the server log when the chain read
 * or the confirmation fails.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/fundEphemeralChainErrors.test.ts
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Three chain calls in the POST sat outside any `try`: the genesis read, the
 * empty-target balance read and the confirmation. What leaves a handler is
 * logged by the framework itself (`console.error(err)`, next/dist/server/
 * route-modules/route-module.js), and web3.js words two of those failures with
 * the identifier in them:
 *
 *   failed to get balance of account <EPHEMERAL>: ...
 *   Signature <FUNDING SIGNATURE> has expired: block height exceeded.
 *
 * The ephemeral signs the user's spend and is its fee payer. The line lands in
 * the Vercel runtime log beside the platform's record of the same request,
 * which holds the caller's IP and the second. So a log reader joins an address
 * to an IP with no timing inference at all. Measured on `next start`:
 * scratchpad/web-run/logs8/r1-logs/probe-next-start-fund-ephemeral.log.
 *
 * The harness below does what Next does with an escaped error: it hands it to
 * `console.error`. The assertions then read the log.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const FUNDING_SIG =
  '3dih3B3WBaDEoQWj6Tutt3mnMtg5AbtCyBySmpaBd7AeG8ovccXs4rUHJvZpyCxPT8KGPxtDtU5MsuoFTbJ8JYws';

type Behaviour = 'ok' | 'throws';
let genesisRead: Behaviour = 'ok';
let balanceRead: Behaviour = 'ok';
let confirmation: Behaviour = 'ok';
/** What `getSignatureStatuses` says about the funding signature afterwards. */
let landed: 'confirmed' | 'absent' | 'unreadable' = 'absent';
let sends = 0;

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => ({ incr: vi.fn(), expire: vi.fn() }),
  rateLimitExceeded: async () => false,
}));

// The send itself is not under test, and building a real transfer drags
// `@solana/buffer-layout` into jsdom (see the note in fund-ephemeral.test.ts).
vi.mock('@/lib/privacy/pool/sendTx', () => ({
  sendWithFreshBlockhash: async () => {
    sends += 1;
    return { signature: FUNDING_SIG, blockhash: 'BLOCKHASH', lastValidBlockHeight: 1 };
  },
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  class FakeTransaction {
    add() {
      return this;
    }
  }
  return {
    ...actual,
    Transaction: FakeTransaction,
    SystemProgram: { ...actual.SystemProgram, transfer: () => ({}) },
    Connection: class {
      async getGenesisHash() {
        if (genesisRead === 'throws') throw new Error('failed to get genesis hash: fetch failed');
        return DEVNET_GENESIS;
      }
      // The wording is web3.js 1.98.4's own (index.cjs.js, `getBalanceAndContext`).
      async getBalance(key: { toBase58(): string }) {
        if (balanceRead === 'throws') {
          throw new Error(
            `failed to get balance of account ${key.toBase58()}: SolanaJSONRPCError: failed to ` +
              `get balance for ${key.toBase58()}: Node is behind by 182 slots`,
          );
        }
        return 0;
      }
      async confirmTransaction(strategy: { signature: string }) {
        if (confirmation === 'throws') {
          const err = new Error(
            `Signature ${strategy.signature} has expired: block height exceeded.`,
          );
          err.name = 'TransactionExpiredBlockheightExceededError';
          throw err;
        }
        return { value: { err: null } };
      }
      async getSignaturesForAddress() {
        return [];
      }
      async getTransaction() {
        return null;
      }
      async getSignatureStatuses(sigs: string[]) {
        if (landed === 'unreadable') {
          throw new Error(`failed to get signature statuses for ${sigs.join(',')}: fetch failed`);
        }
        return {
          value: [landed === 'confirmed' ? { confirmationStatus: 'confirmed', err: null } : null],
        };
      }
    },
  };
});

const funderKeypair = Keypair.generate();
const TICKET = 'test-ticket';
/** A fresh ephemeral per run, so the assertion is on a value the route was given. */
const EPHEMERAL = Keypair.generate().publicKey.toBase58();

let logged: string[] = [];
const render = (a: unknown): string =>
  a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : String(a);

type Route = typeof import('@/app/api/fund-ephemeral/route');
let route: Route;

/** Call the handler the way Next does: what escapes it goes to `console.error`. */
async function postAsNextDoes(): Promise<{ escaped: boolean; res: Response | null }> {
  const request = new NextRequest('http://localhost:3000/api/fund-ephemeral', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-p01-funder-ticket': TICKET,
      'x-real-ip': '203.0.113.7',
    },
    body: JSON.stringify({ ephemeralPubkey: EPHEMERAL, lamports: 1_000_000 }),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
  try {
    return { escaped: false, res: await route.POST(request) };
  } catch (err) {
    console.error(err);
    return { escaped: true, res: null };
  }
}

beforeEach(async () => {
  logged = [];
  sends = 0;
  genesisRead = 'ok';
  balanceRead = 'ok';
  confirmation = 'ok';
  landed = 'absent';
  vi.unstubAllEnvs();
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funderKeypair.secretKey));
  vi.stubEnv('P01_FUNDER_TICKET', TICKET);
  // A fresh module per case: `spentThisInstance` is module state, and the
  // ceiling case below reads it.
  vi.resetModules();
  route = await import('@/app/api/fund-ephemeral/route');
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(render).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(render).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the control: a funding that works', () => {
  // Proves the harness reaches the end of the handler, so the cases below fail
  // for the reason they name and not because the route never got that far.
  it('answers 200 with the signature and logs nothing', async () => {
    const { escaped, res } = await postAsNextDoes();
    expect(escaped).toBe(false);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.signature).toBe(FUNDING_SIG);
    expect(body.sweepTo).toBe(funderKeypair.publicKey.toBase58());
    expect(sends).toBe(1);
    expect(logged).toEqual([]);
  });
});

describe('the empty-target balance read fails', () => {
  beforeEach(() => {
    balanceRead = 'throws';
  });

  it('does not write the spend ephemeral into the server log', async () => {
    await postAsNextDoes();
    expect(logged.join('\n'), 'the server log names the spend ephemeral').not.toContain(EPHEMERAL);
  });

  it('answers a JSON 502 in fixed words, and sends nothing', async () => {
    const { escaped, res } = await postAsNextDoes();
    expect(escaped, 'the chain error left the handler, so the framework logs it').toBe(false);
    expect(res?.status).toBe(502);
    const text = await res!.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: 'the configured RPC could not be read; nothing was sent',
    });
    expect(text).not.toContain(EPHEMERAL);
    expect(sends).toBe(0);
  });
});

describe('the confirmation throws', () => {
  beforeEach(() => {
    confirmation = 'throws';
  });

  it('does not write the funding signature into the server log', async () => {
    await postAsNextDoes();
    const text = logged.join('\n');
    expect(text, 'the server log carries the funding signature').not.toContain(FUNDING_SIG);
    expect(text, 'the server log names the spend ephemeral').not.toContain(EPHEMERAL);
  });

  it('does not write it when the status read fails too', async () => {
    landed = 'unreadable';
    const { escaped } = await postAsNextDoes();
    expect(escaped, 'the status read left the handler').toBe(false);
    expect(logged.join('\n')).not.toContain(FUNDING_SIG);
  });

  it('answers a JSON 502 in fixed words when the transfer cannot be seen', async () => {
    const { escaped, res } = await postAsNextDoes();
    expect(escaped, 'the chain error left the handler, so the framework logs it').toBe(false);
    expect(res?.status).toBe(502);
    const body = await res!.json();
    expect(body).toEqual({
      ok: false,
      error: 'the funding transaction could not be confirmed',
    });
  });

  it('serves the grant when the transfer DID land and only the answer was lost', async () => {
    // A missed websocket notice on serverless is the usual way to get here. The
    // lamports are on the ephemeral, so a refusal would strand them and send
    // the retry into the 409 "target already holds lamports" branch.
    landed = 'confirmed';
    const { escaped, res } = await postAsNextDoes();
    expect(escaped).toBe(false);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.signature).toBe(FUNDING_SIG);
    expect(logged.join('\n')).not.toContain(FUNDING_SIG);
  });

  it('counts an unconfirmed send against the instance ceiling', async () => {
    // It may have landed. A ceiling that only counts what it saw confirmed
    // undercounts exactly when the RPC is failing.
    const spent = async (): Promise<number> =>
      (
        await (
          await route.GET(new NextRequest('http://localhost:3000/api/fund-ephemeral?readiness=1'))
        ).json()
      ).readiness.spentThisInstance;

    expect(await spent()).toBe(0);
    await postAsNextDoes();
    expect(await spent(), 'an unconfirmed send was not counted').toBe(1_000_000);
  });
});

describe('the genesis read fails', () => {
  it('answers a JSON 502 in fixed words instead of a bare 500', async () => {
    genesisRead = 'throws';
    const { escaped, res } = await postAsNextDoes();
    expect(escaped, 'the chain error left the handler, so the framework logs it').toBe(false);
    expect(res?.status).toBe(502);
    expect(await res!.json()).toEqual({
      ok: false,
      error: 'the configured RPC could not be read; nothing was sent',
    });
    expect(sends).toBe(0);
  });
});

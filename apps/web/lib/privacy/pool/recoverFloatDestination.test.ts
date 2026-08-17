/**
 * Where a RECOVERED ephemeral's residue goes, and when it must not go anywhere.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `recoverFloat` used to sweep unconditionally to the connected wallet. That was
 * correct for exactly as long as the wallet was the only thing that ever funded
 * an ephemeral — and it stopped being correct when `subscribeFromPool` began
 * asking the deployment's funder to pre-fund instead. A subscribe deliberately
 * reuses the WITHDRAWAL's ephemeral derivation so that recovery finds it
 * (`subscribeEphemeral.ts` header), so a treasury-funded subscription that
 * crashed left ~1.03 SOL of someone else's money on a key this function
 * re-derives, and one click on Recover sent it to the user's wallet — draining
 * the treasury by accident AND writing the wallet into the newest transaction of
 * that ephemeral's life, which is the edge the funder exists to avoid.
 *
 * These tests decode the bytes that would actually reach the chain, in the style
 * of `subscribeSweepTarget.test.ts`, rather than asserting on what was passed
 * in. A test that reads back its own input agrees with the encoder no matter
 * what either of them does.
 *
 * The refusal cases are the load-bearing ones. Refusing costs a retry; sweeping
 * to the wrong party is irreversible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';

// The pool config, buffer PDAs and buffer closing are not under test here: this
// file is about the destination of the ONE transfer at the end.
vi.mock('./shieldEphemeral', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shieldEphemeral')>()),
  readTreeLeafCount: vi.fn(async () => HEAD),
}));
vi.mock('./stark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stark')>()),
  closeStarkProofBuffer: vi.fn(async () => 'CLOSESIG'),
}));

import { recoverStuckFloat } from './recoverFloat';
import type { PoolConfig } from './denominatedPool';

const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const FUNDER = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const STRANGER = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const POOL = new PublicKey('SysvarRent111111111111111111111111111111111');
const BLOCKHASH = SystemProgram.programId.toBase58();

const HEAD = 4;
const SWEEP_FEE = 5_000;
/** Roughly one proof buffer's rent — the real shape of stranded float. */
const STRANDED = 1_030_290_360;

const SEED = new Uint8Array(32).fill(7);

let sent: Buffer[] = [];

/**
 * A connection whose whole job is to answer "who paid into this key".
 *
 * `sources` is keyed by nothing: every ephemeral in a run gets the same funding
 * story, which is what we want — each test asserts one story at a time, and the
 * balance is only served for ONE leaf so exactly one sweep decision is made.
 */
function fakeConnection(opts: {
  sources: PublicKey[];
  /** Serve no signature history at all, as a pruned RPC does. */
  noHistory?: boolean;
  /** Reject the history read outright. */
  historyThrows?: boolean;
  fundedLeaf?: number;
}): Connection {
  const fundedLeaf = opts.fundedLeaf ?? HEAD;
  let balanceServed = 0;
  return {
    // No proof buffers anywhere: `getAccountInfo` is only used to find them.
    getAccountInfo: async () => null,
    // Serve the stranded balance exactly once, so only one ephemeral in the
    // scan reaches the destination decision and the assertions stay unambiguous.
    getBalance: async () => {
      if (balanceServed === 0 && fundedLeaf >= 0) {
        balanceServed += 1;
        return STRANDED;
      }
      return 0;
    },
    getSignaturesForAddress: async () => {
      if (opts.historyThrows) throw new Error('rpc says no');
      return opts.noHistory ? [] : [{ signature: 'FUNDINGSIG' }];
    },
    getParsedTransaction: async () => ({
      meta: {
        // Index 0..n-1 are the sources, index n is the ephemeral receiving.
        preBalances: [...opts.sources.map(() => STRANDED * 2), 0],
        postBalances: [...opts.sources.map(() => STRANDED), STRANDED],
      },
      transaction: {
        message: {
          accountKeys: [
            ...opts.sources.map((pubkey) => ({ pubkey })),
            // The ephemeral's own key is filled in per call below.
            { pubkey: currentEphemeral! },
          ],
        },
      },
    }),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw: Buffer) => {
      sent.push(raw);
      return 'SWEEPSIG';
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
}

/**
 * The ephemeral currently being classified.
 *
 * `readInboundSources` finds the receiving account by matching the ephemeral's
 * own base58 in `accountKeys`, so the fake transaction has to name it. There is
 * no way to know it in advance — it is HKDF'd from the seed — so the fake
 * `getBalance` records it as a side effect of being asked.
 */
let currentEphemeral: PublicKey | null = null;

function poolConfig(): PoolConfig {
  return { poolPDA: POOL, treePDA: POOL, token: 'SOL' } as unknown as PoolConfig;
}

function decodeSweep() {
  expect(sent).toHaveLength(1);
  const tx = Transaction.from(sent[0]!);
  expect(tx.instructions).toHaveLength(1);
  const ix = tx.instructions[0]!;
  expect(ix.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
  const data = Buffer.from(ix.data);
  expect(data.readUInt32LE(0)).toBe(2); // System Transfer
  return {
    from: ix.keys[0]!.pubkey.toBase58(),
    to: ix.keys[1]!.pubkey.toBase58(),
    lamports: Number(data.readBigUInt64LE(4)),
  };
}

/**
 * Run a recovery whose single funded ephemeral is classified from `sources`.
 *
 * The fake connection cannot name the ephemeral until it exists, so the first
 * `getBalance` call publishes it into `currentEphemeral` for the parsed-transaction
 * stub to use.
 */
async function runRecovery(opts: Parameters<typeof fakeConnection>[0], funder?: PublicKey) {
  const conn = fakeConnection(opts);
  const realGetBalance = conn.getBalance.bind(conn);
  (conn as unknown as { getBalance: (k: PublicKey) => Promise<number> }).getBalance = async (
    key: PublicKey,
  ) => {
    const bal = await realGetBalance(key);
    if (bal > 0) currentEphemeral = key;
    return bal;
  };
  return recoverStuckFloat(conn, poolConfig(), SEED, OWNER, {
    funderPubkey: funder,
    lookback: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  currentEphemeral = null;
});

describe('the recovery sweep goes to whoever paid', () => {
  it('sweeps to the wallet when no funder is configured — unchanged behaviour', async () => {
    // The pre-funder world. No third-party money can exist, so no classification
    // is needed and none is paid for: this must not even read the history.
    const found = await runRecovery({ sources: [OWNER] });
    const sweep = decodeSweep();
    expect(sweep.to).toBe(OWNER.toBase58());
    expect(sweep.lamports).toBe(STRANDED - SWEEP_FEE);
    expect(found.find((f) => f.lamports > 0)?.destination).toBe(OWNER.toBase58());
  });

  it('sweeps to the wallet when the wallet funded it and a funder exists', async () => {
    const found = await runRecovery({ sources: [OWNER] }, FUNDER);
    expect(decodeSweep().to).toBe(OWNER.toBase58());
    expect(found.find((f) => f.lamports > 0)?.destination).toBe(OWNER.toBase58());
  });

  it('REPAYS THE FUNDER when the funder funded it — the theft-by-accident case', async () => {
    // This is the whole reason the file exists. Before the fix this swept
    // ~1.03 SOL of treasury money to OWNER.
    const found = await runRecovery({ sources: [FUNDER] }, FUNDER);
    const sweep = decodeSweep();
    expect(sweep.to).toBe(FUNDER.toBase58());
    expect(sweep.to).not.toBe(OWNER.toBase58());
    expect(found.find((f) => f.lamports > 0)?.destination).toBe(FUNDER.toBase58());
  });
});

describe('it refuses rather than guess', () => {
  it('sends NOTHING when both the wallet and the funder paid in', async () => {
    // A sweep lands a 0-data account on exactly zero, so it can only have one
    // destination. Splitting is not available; picking one robs the other.
    const found = await runRecovery({ sources: [OWNER, FUNDER] }, FUNDER);
    expect(sent).toHaveLength(0);
    const refused = found.find((f) => f.refused);
    expect(refused?.refused).toBe('mixed');
    expect(refused?.strandedLamports).toBe(STRANDED - SWEEP_FEE);
    expect(refused?.destination).toBeNull();
  });

  it('sends NOTHING when a stranger dusted the key — the sweep cannot be outbid', async () => {
    // Ephemeral addresses are enumerable from the funder's history, so a rule
    // like "sweep to the largest inbound" would let an attacker redirect the
    // whole balance for the price of one fee. A fixed allowlist cannot be
    // outbid; an unrecognised source is simply refused.
    const found = await runRecovery({ sources: [STRANGER] }, FUNDER);
    expect(sent).toHaveLength(0);
    expect(found.find((f) => f.refused)?.refused).toBe('unidentified');
  });

  it('sends NOTHING when the RPC has pruned the history and a funder exists', async () => {
    // We cannot tell whose money it is. Deferring costs a retry against a
    // fuller RPC; guessing costs someone the balance.
    const found = await runRecovery({ sources: [], noHistory: true }, FUNDER);
    expect(sent).toHaveLength(0);
    expect(found.find((f) => f.refused)?.refused).toBe('unverifiable');
  });

  it('sends NOTHING when the history read itself fails', async () => {
    const found = await runRecovery({ sources: [], historyThrows: true }, FUNDER);
    expect(sent).toHaveLength(0);
    expect(found.find((f) => f.refused)?.refused).toBe('unverifiable');
  });

  it('still sweeps home on a pruned RPC when there is NO funder', async () => {
    // The negative control for the rule above: the defensive refusal must not
    // break recovery on a deployment where third-party money cannot exist.
    // Getting this wrong strands every devnet user behind a warning.
    const found = await runRecovery({ sources: [], noHistory: true });
    expect(decodeSweep().to).toBe(OWNER.toBase58());
    expect(found.find((f) => f.refused)).toBeUndefined();
  });

  it('sends NOTHING when we could not even find out whether a funder exists', async () => {
    // 🚨 THE ROUTE THAT SURVIVED THE FIRST VERSION OF THIS FILE. "No funder
    // configured" and "the lookup failed" were the same branch, so one
    // transient fetch error made a recovery sweep the treasury's float home —
    // and with it the buyer's wallet address, onto the ephemeral that signed
    // their subscription. That ephemeral is accountKeys[0] of the subscribe, so
    // the wallet lands on the subscription itself. And it fires on a Recover
    // click: AFTER the verification run that reported it clean.
    //
    // Same inputs as the case above, one flag apart. That is the whole finding.
    const conn = fakeConnection({ sources: [OWNER] });
    const realGetBalance = conn.getBalance.bind(conn);
    (conn as unknown as { getBalance: (k: PublicKey) => Promise<number> }).getBalance = async (
      key: PublicKey,
    ) => {
      const bal = await realGetBalance(key);
      if (bal > 0) currentEphemeral = key;
      return bal;
    };
    const found = await recoverStuckFloat(conn, poolConfig(), SEED, OWNER, {
      lookback: 1,
      funderUnknown: true,
    });
    expect(sent).toHaveLength(0);
    expect(found.find((f) => f.refused)?.refused).toBe('unverifiable');
  });
});

describe('which keys are searched at all', () => {
  it('searches a spend note far below the tree head', async () => {
    // A withdrawal or subscribe derives its ephemeral from the SPENT note's
    // leaf index, and a spend advances no tree — so a note 400 leaves back
    // strands its float 400 leaves back, outside the head-relative window that
    // is correct for shields. Before this, that ~1 SOL was unreachable by
    // anything: CloseProofBuffer is `close = authority`.
    const conn = fakeConnection({ sources: [OWNER] });
    const seen: string[] = [];
    (conn as unknown as { getBalance: (k: PublicKey) => Promise<number> }).getBalance = async (
      key: PublicKey,
    ) => {
      seen.push(key.toBase58());
      return 0;
    };
    await recoverStuckFloat(conn, poolConfig(), SEED, OWNER, {
      lookback: 1,
      unshieldLeafIndices: [400],
    });

    const { deriveUnshieldEphemeral } = await import('./unshieldEphemeral');
    const far = deriveUnshieldEphemeral(SEED, POOL, 400).publicKey.toBase58();
    expect(seen).toContain(far);
  });

  it('does not lose the head-relative window when note indices are supplied', async () => {
    // The note list is unioned with the window, never a replacement for it: a
    // shield that died before its note was ever stored has no note to name it.
    const conn = fakeConnection({ sources: [OWNER] });
    const seen: string[] = [];
    (conn as unknown as { getBalance: (k: PublicKey) => Promise<number> }).getBalance = async (
      key: PublicKey,
    ) => {
      seen.push(key.toBase58());
      return 0;
    };
    await recoverStuckFloat(conn, poolConfig(), SEED, OWNER, {
      lookback: 1,
      unshieldLeafIndices: [400],
    });

    const { deriveShieldEphemeral } = await import('./shieldEphemeral');
    const atHead = deriveShieldEphemeral(SEED, POOL, HEAD).publicKey.toBase58();
    expect(seen).toContain(atHead);
  });
});

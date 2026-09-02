/**
 * The float-to-restock top-up, against a stubbed chain.
 *
 * Runs in the pool suite on the real `@solana/web3.js`, because the assertions
 * that matter are about the transaction: who it pays, how much, who signed it,
 * and that dry-run never builds one.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/restockTopUp.test.ts
 */

import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, type Transaction } from '@solana/web3.js';

import {
  DEFAULT_SETTLEMENT_CONFIG,
  ONE_PURCHASE_LAMPORTS,
  PREFUND_WORST_CASE_LAMPORTS,
  floatRequiredForBatch,
} from './settlementPolicy';
import {
  DEFAULT_RESTOCK_CONFIG,
  restockConfigFromEnv,
  restockWalletTargetLamports,
} from './restockConfig';
import {
  DEFAULT_MIN_TOP_UP_LAMPORTS,
  formatTopUpLine,
  planTopUp,
  runTopUp,
  type TopUpChain,
} from './restockTopUp';

const HOUR = 3600;
const NOW = 1_800_000_000;
/**
 * An environment literal as the real type. This app's ambient `ProcessEnv`
 * declares `NODE_ENV` required, so a plain literal cannot be assigned to it;
 * one cast here rather than one at every call site.
 */
const asEnv = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;
const cfg = DEFAULT_SETTLEMENT_CONFIG;
const FUNDER_FLOOR = floatRequiredForBatch(cfg.minPurchases);
const RESTOCK_TARGET = restockWalletTargetLamports(DEFAULT_RESTOCK_CONFIG);

function inputs(over: Partial<Parameters<typeof planTopUp>[0]> = {}) {
  return {
    funderLamports: FUNDER_FLOOR + 5 * 1e9,
    restockLamports: 0,
    secondsSinceLastFunderActivity: 48 * HOUR,
    nowSeconds: NOW,
    ...over,
  };
}

describe('restockConfig', () => {
  it('reads every field and falls back on anything malformed', () => {
    expect(restockConfigFromEnv(asEnv({}))).toEqual(DEFAULT_RESTOCK_CONFIG);
    expect(
      restockConfigFromEnv(asEnv({
        P01_TREASURY_TARGET: '12',
        P01_TREASURY_LOW_WATER: '9',
        P01_TREASURY_MAX_PER_RUN: '2',
        P01_TREASURY_FLOOR: '2000000000',
      })),
    ).toEqual({ target: 12, lowWater: 9, maxPerRun: 2, floorLamports: 2_000_000_000 });
    for (const bad of ['', 'abc', '-1']) {
      expect(restockConfigFromEnv(asEnv({ P01_TREASURY_MAX_PER_RUN: bad })).maxPerRun).toBe(
        DEFAULT_RESTOCK_CONFIG.maxPerRun,
      );
    }
  });

  it('sizes the restock wallet for one run of sequential deposits above its floor', () => {
    // Three deposits back to back: two note values permanently gone plus one
    // pre-fund free while the last one runs. The same arithmetic the float is
    // sized by, measured on devnet.
    expect(RESTOCK_TARGET).toBe(
      DEFAULT_RESTOCK_CONFIG.floorLamports + 2 * ONE_PURCHASE_LAMPORTS + PREFUND_WORST_CASE_LAMPORTS,
    );
    expect(restockWalletTargetLamports({ ...DEFAULT_RESTOCK_CONFIG, maxPerRun: 1 })).toBe(
      DEFAULT_RESTOCK_CONFIG.floorLamports + PREFUND_WORST_CASE_LAMPORTS,
    );
  });
});

describe('planTopUp: what moves', () => {
  it('keeps the float at the floor the settler reports, never under it', () => {
    // The number settle-till hands the operator as floatRequiredForFloorLamports.
    expect(FUNDER_FLOOR).toBe(2 * ONE_PURCHASE_LAMPORTS + 1_620_000_000);
    const p = planTopUp(inputs({ funderLamports: FUNDER_FLOOR + 3 * 1e9, restockLamports: 0 }));
    expect(p.verdict).toBe('move');
    expect(p.funderFloorLamports).toBe(FUNDER_FLOOR);
    expect(p.funderSurplusLamports).toBe(3 * 1e9);
    expect(p.amountLamports).toBe(3 * 1e9);
  });

  it('moves the smaller of the surplus and the deficit', () => {
    const deficit = RESTOCK_TARGET - 1e9;
    const p = planTopUp(inputs({ funderLamports: FUNDER_FLOOR + 50 * 1e9, restockLamports: 1e9 }));
    expect(p.verdict).toBe('move');
    expect(p.restockDeficitLamports).toBe(deficit);
    expect(p.amountLamports).toBe(deficit);
    expect(p.amountLamports).toBeLessThan(p.funderSurplusLamports);
  });

  it('does nothing when the restock wallet is at its target', () => {
    const p = planTopUp(inputs({ restockLamports: RESTOCK_TARGET }));
    expect(p.verdict).toBe('restock-at-target');
    expect(p.amountLamports).toBe(0);
    expect(planTopUp(inputs({ restockLamports: RESTOCK_TARGET + 1 })).verdict).toBe('restock-at-target');
  });

  it('refuses to take the float under its floor, and says the settler would deadlock', () => {
    for (const funderLamports of [0, FUNDER_FLOOR - 1, FUNDER_FLOOR]) {
      const p = planTopUp(inputs({ funderLamports }));
      expect(p.verdict).toBe('float-at-floor');
      expect(p.amountLamports).toBe(0);
      expect(p.reason).toMatch(/deadlock/);
    }
  });

  it('refuses a transfer smaller than one note by default', () => {
    const p = planTopUp(inputs({ funderLamports: FUNDER_FLOOR + DEFAULT_MIN_TOP_UP_LAMPORTS - 1 }));
    expect(p.verdict).toBe('below-minimum-move');
    expect(DEFAULT_MIN_TOP_UP_LAMPORTS).toBe(ONE_PURCHASE_LAMPORTS);
    const ok = planTopUp(inputs({ funderLamports: FUNDER_FLOOR + DEFAULT_MIN_TOP_UP_LAMPORTS }));
    expect(ok.verdict).toBe('move');
    const custom = planTopUp(
      inputs({ funderLamports: FUNDER_FLOOR + 1_000_000, minMoveLamports: 1_000_000 }),
    );
    expect(custom.verdict).toBe('move');
  });

  it('capacity refusals come before timing refusals, so an empty float is never reported as a wait', () => {
    const p = planTopUp(inputs({ funderLamports: 0, secondsSinceLastFunderActivity: 0 }));
    expect(p.verdict).toBe('float-at-floor');
    const q = planTopUp(inputs({ restockLamports: RESTOCK_TARGET, secondsSinceLastFunderActivity: null }));
    expect(q.verdict).toBe('restock-at-target');
  });
});

describe('planTopUp: the settlement clock', () => {
  it('refuses while the float was touched less than the quiet period ago', () => {
    const p = planTopUp(inputs({ secondsSinceLastFunderActivity: cfg.minQuietSeconds - 1 }));
    expect(p.verdict).toBe('too-soon-after-float-activity');
    expect(p.amountLamports).toBe(0);
    expect(planTopUp(inputs({ secondsSinceLastFunderActivity: cfg.minQuietSeconds })).verdict).toBe('move');
  });

  it('refuses when the float history could not be read', () => {
    // The unknown must not read as old, here as in the settler.
    const p = planTopUp(inputs({ secondsSinceLastFunderActivity: null }));
    expect(p.verdict).toBe('float-history-unknown');
    expect(p.amountLamports).toBe(0);
  });

  it('honours a stored hold when the caller keeps one', () => {
    expect(planTopUp(inputs({ holdUntilSeconds: NOW + 60 })).verdict).toBe('holding-off');
    expect(planTopUp(inputs({ holdUntilSeconds: NOW - 1 })).verdict).toBe('move');
  });

  it('follows the configured quiet period, not the default', () => {
    const settlement = { ...cfg, minQuietSeconds: 60 };
    expect(planTopUp(inputs({ secondsSinceLastFunderActivity: 59, settlement })).verdict).toBe(
      'too-soon-after-float-activity',
    );
    expect(planTopUp(inputs({ secondsSinceLastFunderActivity: 60, settlement })).verdict).toBe('move');
  });

  it('never returns an amount on any refusal', () => {
    const refusals = [
      inputs({ restockLamports: RESTOCK_TARGET }),
      inputs({ funderLamports: FUNDER_FLOOR }),
      inputs({ funderLamports: FUNDER_FLOOR + 1 }),
      inputs({ secondsSinceLastFunderActivity: null }),
      inputs({ secondsSinceLastFunderActivity: 0 }),
      inputs({ holdUntilSeconds: NOW + 1 }),
    ];
    for (const i of refusals) {
      const p = planTopUp(i);
      expect(p.verdict, `${p.verdict} must not carry an amount`).not.toBe('move');
      expect(p.amountLamports).toBe(0);
    }
  });
});

// ── runTopUp against a stubbed chain ────────────────────────────────────────

interface FakeChain {
  balances: Map<string, number>;
  funderBlockTime: number | null;
  feeForMessage: number | null;
  sent: { tx: Transaction; signers: Keypair[] }[];
  confirmed: string[];
  throwOnSignatures?: boolean;
}

function fakeChain(over: Partial<FakeChain> = {}): FakeChain & { chain: TopUpChain } {
  const state: FakeChain = {
    balances: new Map(),
    funderBlockTime: NOW - 48 * HOUR,
    feeForMessage: 5000,
    sent: [],
    confirmed: [],
    ...over,
  };
  const chain = {
    async getBalance(k: PublicKey) {
      return state.balances.get(k.toBase58()) ?? 0;
    },
    async getSignaturesForAddress() {
      if (state.throwOnSignatures) throw new Error('rpc down');
      return state.funderBlockTime === undefined
        ? []
        : [{ signature: 'LAST', blockTime: state.funderBlockTime }];
    },
    async getLatestBlockhash() {
      return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 };
    },
    async getFeeForMessage() {
      return { context: { slot: 1 }, value: state.feeForMessage };
    },
    async sendTransaction(tx: Transaction, signers: Keypair[]) {
      state.sent.push({ tx, signers });
      return 'SIGNATURE_' + state.sent.length;
    },
    async confirmTransaction(strategy: { signature: string }) {
      state.confirmed.push(strategy.signature);
      return { context: { slot: 1 }, value: { err: null } };
    },
  } as unknown as TopUpChain;
  return { ...state, chain, sent: state.sent, confirmed: state.confirmed };
}

describe('runTopUp', () => {
  const funder = Keypair.generate();
  const restock = Keypair.generate();
  const env = asEnv({});

  function eligible(over: Partial<FakeChain> = {}) {
    const f = fakeChain(over);
    f.balances.set(funder.publicKey.toBase58(), FUNDER_FLOOR + 10 * 1e9);
    f.balances.set(restock.publicKey.toBase58(), DEFAULT_RESTOCK_CONFIG.floorLamports);
    return f;
  }

  it('dry-run reads, decides and never sends', async () => {
    const f = eligible();
    const r = await runTopUp({
      chain: f.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: true,
      nowSeconds: NOW,
      env,
    });
    expect(r.plan.verdict).toBe('move');
    expect(r.plan.amountLamports).toBe(RESTOCK_TARGET - DEFAULT_RESTOCK_CONFIG.floorLamports);
    expect(r.dryRun).toBe(true);
    expect(r.signature).toBeNull();
    expect(r.sentLamports).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(f.confirmed).toHaveLength(0);
  });

  it('live: pays the restock wallet, from the float, signed by the float, less the fee', async () => {
    const f = eligible({ feeForMessage: 7500 });
    const r = await runTopUp({
      chain: f.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: false,
      nowSeconds: NOW,
      env,
    });
    expect(r.plan.verdict).toBe('move');
    expect(r.signature).toBe('SIGNATURE_1');
    expect(r.feeLamports).toBe(7500);
    expect(r.sentLamports).toBe(r.plan.amountLamports - 7500);
    expect(f.confirmed).toEqual(['SIGNATURE_1']);

    expect(f.sent).toHaveLength(1);
    const { tx, signers } = f.sent[0];
    expect(signers.map((s) => s.publicKey.toBase58())).toEqual([funder.publicKey.toBase58()]);
    expect(tx.feePayer?.toBase58()).toBe(funder.publicKey.toBase58());
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0];
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toEqual([funder.publicKey.toBase58(), restock.publicKey.toBase58()]);
    // The transfer amount is the little-endian u64 after the 4-byte instruction index.
    const lamports = Number(ix.data.readBigUInt64LE(4));
    expect(lamports).toBe(r.sentLamports);
    // And the float ends at or above its floor, exactly.
    expect(FUNDER_FLOOR + 10 * 1e9 - lamports - 7500).toBeGreaterThanOrEqual(FUNDER_FLOOR);
  });

  it('falls back to the default fee when the chain will not quote one', async () => {
    const f = eligible({ feeForMessage: null });
    const r = await runTopUp({
      chain: f.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: false,
      nowSeconds: NOW,
      env,
    });
    expect(r.feeLamports).toBe(5000);
    expect(r.sentLamports).toBe(r.plan.amountLamports - 5000);
  });

  it('sends nothing on a refusal, dry or live', async () => {
    for (const over of [
      { funderBlockTime: NOW - 60 },
      { funderBlockTime: null },
      { throwOnSignatures: true },
    ] as Partial<FakeChain>[]) {
      const f = eligible(over);
      const r = await runTopUp({
        chain: f.chain,
        funder,
        restockWallet: restock.publicKey,
        dryRun: false,
        nowSeconds: NOW,
        env,
      });
      expect(r.plan.verdict).not.toBe('move');
      expect(r.signature).toBeNull();
      expect(f.sent).toHaveLength(0);
    }
  });

  it('reads the quiet period and the minimum from the environment', async () => {
    const f = eligible({ funderBlockTime: NOW - 120 });
    const r = await runTopUp({
      chain: f.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: true,
      nowSeconds: NOW,
      env: asEnv({ P01_SETTLE_MIN_QUIET_SECONDS: '60' }),
    });
    expect(r.plan.verdict).toBe('move');
    const tiny = eligible();
    tiny.balances.set(restock.publicKey.toBase58(), RESTOCK_TARGET - 1_000_000);
    const small = await runTopUp({
      chain: tiny.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: true,
      nowSeconds: NOW,
      env,
    });
    expect(small.plan.verdict).toBe('below-minimum-move');
    const allowed = await runTopUp({
      chain: tiny.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: true,
      nowSeconds: NOW,
      env: asEnv({ P01_TOPUP_MIN_LAMPORTS: '1000000' }),
    });
    expect(allowed.plan.verdict).toBe('move');
  });

  it('the log line names public keys and amounts, and no secret', async () => {
    const f = eligible();
    const r = await runTopUp({
      chain: f.chain,
      funder,
      restockWallet: restock.publicKey,
      dryRun: false,
      nowSeconds: NOW,
      env,
    });
    const line = formatTopUpLine(r);
    expect(line).toContain('verdict=move');
    expect(line).toContain(funder.publicKey.toBase58());
    expect(line).toContain(restock.publicKey.toBase58());
    expect(line).toContain('sig=SIGNATURE_1');
    expect(line).not.toContain(Buffer.from(funder.secretKey).toString('hex'));
    expect(line).not.toContain(JSON.stringify(Array.from(funder.secretKey)));
    expect(line.split('\n')).toHaveLength(1);
  });
});

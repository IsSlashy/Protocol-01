/**
 * subscriptionRecovery — the #11 vault-recovery scan.
 *
 * What is pinned here, in order of importance:
 *
 *   1. THE LEAK REGRESSION. The naive recovery probes
 *      `getAccountInfo(vaultPDA)` once per owned note, which is leak L4 in a
 *      new costume: a list of identifiers derived from this user's note
 *      secrets, handed to the RPC for vaults that may never exist. The test
 *      serializes every request the scan makes and asserts no secret-derived
 *      value appears in any of them — WITH a positive control, following
 *      `denominatedPool.test.ts`'s blinding-window scan, so the assertion
 *      cannot pass vacuously.
 *   2. A recovered vault reproduces the record the subscribe path would have
 *      written (minus the three cosmetic fields), and the license key
 *      re-derives from it.
 *   3. A wallet with no subscriptions recovers nothing and does not throw,
 *      and a program with no vaults costs zero derivation work.
 *
 * The commitment function is a STUB (any deterministic map works — both the
 * planted vault and the matcher use it), because the real one is the STARK
 * wasm, which this suite cannot boot. The production wiring passes
 * `starkProver.computeCommitment`, the same call `handlePoolSubscribePrepare`
 * makes; that identity is enforced by injection — there is no second
 * implementation anywhere to drift.
 *
 * Runs under `vitest.pool.config.mts` (node, real @solana/web3.js).
 */

import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
  recoverSubscriptionVaults,
  subscriptionVaultFilter,
} from './subscriptionRecovery';
import {
  ALL_POOLS_V3,
  SOL_POOLS_V3,
  ZK_SHIELDED_PROGRAM_ID,
  deriveNoteMaterial,
} from './denominatedPool';
import { deriveSubscriptionVaultPDA, goldilocksU64To32 } from './subscribePrivateStark';
import {
  NATIVE_SOL_MINT_BASE58,
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  base58Encode,
  bytesToHex,
} from './subscriptionVaultAccount';
import {
  deriveLicenseSecret,
  deriveLicenseSecretV2,
  encodeLicenseKey,
  licenseCommitment,
} from '../license';
import { deriveLicenseSecretUnder } from '../licenseTagMatch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL = SOL_POOLS_V3[0]; // 0.1 SOL
const SEED = new Uint8Array(32).fill(5);
const COUNTER = 7; // the paying note's leaf index == its derivation counter
const LEAF_COUNT = 12; // tree size the derivation walk must cover
const RATE = 100_000_000n;
const INTERVAL_SLOTS = 1_500n;

const U64_MASK = (1n << 64n) - 1n;

/** Deterministic stand-in for `starkProver.computeCommitment`: decimal string
 *  of a note secret in, decimal string of a u64 commitment out. */
async function stubCommitment(secretDecimal: string): Promise<string> {
  return ((BigInt(secretDecimal) * 6364136223846793005n + 1442695040888963407n) & U64_MASK).toString();
}

/** Borsh-writes a private-mode vault, zero-padded to 361 bytes like Anchor's
 *  allocation. Mirrors the synthetic writer in `paySubscriptions.test.ts`. */
function writeVault(v: {
  subscriberCommitment: Uint8Array;
  retailer: Uint8Array;
  tokenMint?: Uint8Array;
  rate?: bigint;
  intervalSlots?: bigint;
  sourcePool?: Uint8Array | null;
  /** `blake3(licenseSecret)` as the subscribe path posts it; absent = None. */
  licenseCommitment?: Uint8Array;
}): Uint8Array {
  const parts: number[] = [...SUBSCRIPTION_VAULT_DISCRIMINATOR];
  const u64 = (x: bigint) => {
    let val = x;
    for (let i = 0; i < 8; i++) {
      parts.push(Number(val & 0xffn));
      val >>= 8n;
    }
  };
  parts.push(0); // subscriber_pubkey: None (private mode)
  parts.push(1, ...v.subscriberCommitment);
  parts.push(...v.retailer, ...(v.tokenMint ?? new Uint8Array(32)));
  u64(500_000_000n); // total_deposited
  u64(v.rate ?? RATE);
  u64(v.intervalSlots ?? INTERVAL_SLOTS);
  u64(1_000n); // start_slot
  u64(0n); // claimed_periods
  parts.push(1, 0); // is_active, is_paused
  parts.push(0); // pause_slot: None
  u64(0n); // total_paused_slots
  parts.push(...new Uint8Array(32)); // vk_hash_subscriber
  if (v.sourcePool === null) parts.push(0);
  else parts.push(1, ...(v.sourcePool ?? POOL.poolPDA.toBytes()));
  parts.push(254); // bump
  parts.push(0); // client_stealth_meta: None
  if (v.licenseCommitment) parts.push(1, ...v.licenseCommitment);
  else parts.push(0); // license_commitment: None
  const out = new Uint8Array(361);
  out.set(parts);
  return out;
}

/** `MerkleTreeStateV3` prefix, enough for `parseFilledSubtrees`: disc(8) +
 *  pool(32) + authority(32) + leaf_count u64 + depth u8 + empty Vec len. */
function treeAccountBytes(leafCount: number): Uint8Array {
  const out = new Uint8Array(8 + 32 + 32 + 8 + 1 + 4);
  new DataView(out.buffer).setBigUint64(72, BigInt(leafCount), true);
  out[80] = 15;
  return out;
}

interface RecordedCall {
  method: string;
  [k: string]: unknown;
}

/** A connection that records EVERY request it is asked, so the leak test can
 *  assert over the union of everything that would have reached the RPC. */
function makeConnection(
  vaults: Array<{ pubkey: PublicKey; data: Uint8Array }>,
  leafCount = LEAF_COUNT,
): { conn: Connection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const tree = treeAccountBytes(leafCount);
  const conn = {
    getProgramAccounts: async (programId: PublicKey, cfg: unknown) => {
      calls.push({ method: 'getProgramAccounts', programId: programId.toBase58(), cfg });
      return vaults.map((v) => ({ pubkey: v.pubkey, account: { data: Buffer.from(v.data) } }));
    },
    getAccountInfo: async (pk: PublicKey) => {
      calls.push({ method: 'getAccountInfo', address: pk.toBase58() });
      if (ALL_POOLS_V3.some((p) => p.treePDA.equals(pk))) return { data: Buffer.from(tree) };
      return null;
    },
  } as unknown as Connection;
  return { conn, calls };
}

/** The full planted-vault scenario: this seed's note at COUNTER paid RETAILER.
 *  With `boughtUnderTag` the vault also carries the license commitment the
 *  subscribe path posts for a purchase scoped to that tag: under v1 (what
 *  every vault from before 2026-09-02 stores) unless `scheme` says v2. */
async function plantVault(boughtUnderTag?: string, scheme: 'v1' | 'v2' = 'v1') {
  const { secret } = deriveNoteMaterial(SEED, POOL.poolPDA, COUNTER);
  const commitment = BigInt(await stubCommitment(secret.toString()));
  const commitment32 = goldilocksU64To32(commitment);
  const retailer = Keypair.generate().publicKey;
  const [vaultPDA] = deriveSubscriptionVaultPDA(retailer, commitment32, SystemProgram.programId);
  const data = writeVault({
    subscriberCommitment: commitment32,
    retailer: retailer.toBytes(),
    licenseCommitment:
      boughtUnderTag === undefined
        ? undefined
        : scheme === 'v2'
          ? licenseCommitment(deriveLicenseSecretV2(secret, boughtUnderTag, SEED))
          : licenseCommitment(deriveLicenseSecret(secret, boughtUnderTag)),
  });
  return { secret, commitment, commitment32, retailer, vaultPDA, data };
}

// ---------------------------------------------------------------------------

describe('recoverSubscriptionVaults — the record comes back', () => {
  it('reproduces the record the subscribe path would have written', async () => {
    const { retailer, vaultPDA, data } = await plantVault();
    const { conn } = makeConnection([{ pubkey: vaultPDA, data }]);

    const res = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: stubCommitment,
    });

    // What `SubscribePanel` records at purchase time, restricted to the
    // recoverable fields (serviceTag/serviceName resolve from the registry on
    // the main thread; openTxSig/openedAt are cosmetic and gone).
    const subscribeTimeRecord = {
      vaultPDA: vaultPDA.toBase58(),
      retailer: retailer.toBase58(),
      token: 'SOL',
      denomination: 0.1,
      rate: RATE.toString(),
      intervalSlots: INTERVAL_SLOTS.toString(),
      pool: POOL.poolPDA.toBase58(),
      leafIndex: COUNTER,
    };
    expect(res.vaultsScanned).toBe(1);
    expect(res.recovered).toEqual([
      {
        ...subscribeTimeRecord,
        tokenMint: NATIVE_SOL_MINT_BASE58,
        // This fixture vault stores no license commitment, so no tag and no
        // scheme can be verified for it: null on all three, never a guess.
        licenseCommitment: null,
        serviceTag: null,
        licenseScheme: null,
      },
    ]);
  });

  describe('the serviceTag is verified against the vault commitment', () => {
    const roster = (retailer: PublicKey) => [
      { slug: 'acme-basic', retailer: retailer.toBase58(), tokenMint: NATIVE_SOL_MINT_BASE58 },
      { slug: 'acme-pro', retailer: retailer.toBase58(), tokenMint: NATIVE_SOL_MINT_BASE58 },
    ];

    it('two listings on one (retailer, mint): picks the one the vault was bought under', async () => {
      const planted = await plantVault('acme-pro');
      const { conn } = makeConnection([{ pubkey: planted.vaultPDA, data: planted.data }]);
      const keyAtPurchase = encodeLicenseKey(deriveLicenseSecret(planted.secret, 'acme-pro'));

      const res = await recoverSubscriptionVaults(conn, [SEED], {
        computeSubscriberCommitment: stubCommitment,
        services: roster(planted.retailer), // a join would take acme-basic, first in order
      });
      expect(res.recovered).toHaveLength(1);
      const rec = res.recovered[0]!;
      expect(rec.serviceTag).toBe('acme-pro');
      expect(rec.licenseScheme).toBe('v1');
      expect(rec.licenseCommitment).toBe(
        bytesToHex(licenseCommitment(deriveLicenseSecret(planted.secret, 'acme-pro'))),
      );
      // The key under the recovered tag IS the key the merchant accepted.
      expect(encodeLicenseKey(deriveLicenseSecret(planted.secret, rec.serviceTag!))).toBe(
        keyAtPurchase,
      );
    });

    it('a roster without the bought slug yields null, never the retailer-address guess', async () => {
      const planted = await plantVault('acme-pro'); // listing removed since
      const { conn } = makeConnection([{ pubkey: planted.vaultPDA, data: planted.data }]);

      const res = await recoverSubscriptionVaults(conn, [SEED], {
        computeSubscriberCommitment: stubCommitment,
        services: [roster(planted.retailer)[0]!],
      });
      expect(res.recovered[0]!.serviceTag).toBeNull();
      expect(res.recovered[0]!.licenseScheme).toBeNull();
      expect(res.recovered[0]!.licenseCommitment).toHaveLength(64);

      const empty = await recoverSubscriptionVaults(conn, [SEED], {
        computeSubscriberCommitment: stubCommitment,
      });
      expect(empty.recovered[0]!.serviceTag).toBeNull();
    });

    it('a purchase with no registry (retailer address as tag) still verifies', async () => {
      const planted = await plantVault(); // placeholder to build the retailer
      const retailer58 = planted.retailer.toBase58();
      const { secret } = deriveNoteMaterial(SEED, POOL.poolPDA, COUNTER);
      const data = writeVault({
        subscriberCommitment: planted.commitment32,
        retailer: planted.retailer.toBytes(),
        licenseCommitment: licenseCommitment(deriveLicenseSecret(secret, retailer58)),
      });
      const { conn } = makeConnection([{ pubkey: planted.vaultPDA, data }]);

      const res = await recoverSubscriptionVaults(conn, [SEED], {
        computeSubscriberCommitment: stubCommitment,
        services: roster(planted.retailer),
      });
      expect(res.recovered[0]!.serviceTag).toBe(retailer58);
    });
  });

  describe('the license scheme is verified against the vault commitment, v2 then v1', () => {
    const roster = (retailer: PublicKey) => [
      { slug: 'acme-basic', retailer: retailer.toBase58(), tokenMint: NATIVE_SOL_MINT_BASE58 },
      { slug: 'acme-pro', retailer: retailer.toBase58(), tokenMint: NATIVE_SOL_MINT_BASE58 },
    ];

    it('a vault written under v1, from before v2 existed, still yields its key and says v1', async () => {
      // Exactly the vault a purchase made on 2026-09-01 left on chain: the
      // commitment is blake3 of the v1 secret and nothing marks it as such.
      const planted = await plantVault('acme-pro', 'v1');
      const { conn } = makeConnection([{ pubkey: planted.vaultPDA, data: planted.data }]);
      const keyAtPurchase = encodeLicenseKey(deriveLicenseSecret(planted.secret, 'acme-pro'));

      const res = await recoverSubscriptionVaults(conn, [SEED], {
        computeSubscriberCommitment: stubCommitment,
        services: roster(planted.retailer),
      });
      const rec = res.recovered[0]!;
      expect(rec.serviceTag).toBe('acme-pro');
      expect(rec.licenseScheme).toBe('v1');
      // The key under the recovered (tag, scheme) IS the key the merchant
      // accepted, re-derived the way the Reveal path does it.
      const rederived = deriveNoteMaterial(SEED, new PublicKey(rec.pool), rec.leafIndex).secret;
      expect(
        encodeLicenseKey(
          deriveLicenseSecretUnder(rec.licenseScheme!, rederived, rec.serviceTag!, SEED),
        ),
      ).toBe(keyAtPurchase);
    });

    it('a vault written under v2 yields its key and says v2', async () => {
      const planted = await plantVault('acme-pro', 'v2');
      const { conn } = makeConnection([{ pubkey: planted.vaultPDA, data: planted.data }]);
      const keyAtPurchase = encodeLicenseKey(
        deriveLicenseSecretV2(planted.secret, 'acme-pro', SEED),
      );

      const res = await recoverSubscriptionVaults(conn, [SEED], {
        computeSubscriberCommitment: stubCommitment,
        services: roster(planted.retailer), // the join would take acme-basic
      });
      const rec = res.recovered[0]!;
      expect(rec.serviceTag).toBe('acme-pro');
      expect(rec.licenseScheme).toBe('v2');
      expect(
        encodeLicenseKey(
          deriveLicenseSecretUnder(rec.licenseScheme!, planted.secret, rec.serviceTag!, SEED),
        ),
      ).toBe(keyAtPurchase);
      // Not the v1 key: the two schemes never collide on one commitment.
      expect(keyAtPurchase).not.toBe(
        encodeLicenseKey(deriveLicenseSecret(planted.secret, 'acme-pro')),
      );
    });

    it('a v2 vault minted under a seed this scan does not hold matches nothing, never a v1 guess', async () => {
      const planted = await plantVault('acme-pro', 'v2'); // minted under SEED
      const { conn } = makeConnection([{ pubkey: planted.vaultPDA, data: planted.data }]);
      // The note itself is handed in as a blob candidate (so the vault IS
      // found) but under a stranger's identity seed.
      const stranger = new Uint8Array(32).fill(9);
      const res = await recoverSubscriptionVaults(conn, [stranger], {
        blobCandidates: [
          {
            pool: POOL.poolPDA.toBase58(),
            leafIndex: COUNTER,
            secret: planted.secret,
            identitySeed: stranger,
          },
        ],
        computeSubscriberCommitment: stubCommitment,
        services: roster(planted.retailer),
      });
      expect(res.recovered).toHaveLength(1);
      expect(res.recovered[0]!.serviceTag).toBeNull();
      expect(res.recovered[0]!.licenseScheme).toBeNull();
    });

    it('a v2 vault paid with a received note is matched through the blob candidate seed', async () => {
      // The note secret came from the sender; the KEY was minted under our
      // identity seed, the one that filed the note. Both travel in the blob
      // candidate, and the scan needs neither from its own derivation walk.
      const foreignSecret = 987_654_321_123n;
      const commitment32 = goldilocksU64To32(
        BigInt(await stubCommitment(foreignSecret.toString())),
      );
      const retailer = Keypair.generate().publicKey;
      const [vaultPDA] = deriveSubscriptionVaultPDA(retailer, commitment32, SystemProgram.programId);
      const data = writeVault({
        subscriberCommitment: commitment32,
        retailer: retailer.toBytes(),
        licenseCommitment: licenseCommitment(
          deriveLicenseSecretV2(foreignSecret, 'acme-pro', SEED),
        ),
      });
      const { conn } = makeConnection([{ pubkey: vaultPDA, data }]);
      const poolB58 = POOL.poolPDA.toBase58();

      const withSeed = await recoverSubscriptionVaults(conn, [SEED], {
        blobCandidates: [{ pool: poolB58, leafIndex: 3, secret: foreignSecret, identitySeed: SEED }],
        computeSubscriberCommitment: stubCommitment,
        services: roster(retailer),
      });
      expect(withSeed.recovered[0]).toMatchObject({ serviceTag: 'acme-pro', licenseScheme: 'v2' });

      // A blob candidate that names no seed still matches through the seeds
      // the scan holds: the identity's seeds are the trial set either way.
      const withoutSeed = await recoverSubscriptionVaults(conn, [SEED], {
        blobCandidates: [{ pool: poolB58, leafIndex: 3, secret: foreignSecret }],
        computeSubscriberCommitment: stubCommitment,
        services: roster(retailer),
      });
      expect(withoutSeed.recovered[0]).toMatchObject({ serviceTag: 'acme-pro', licenseScheme: 'v2' });
    });
  });

  it('the license key re-derives from the recovered record alone', async () => {
    const { secret, vaultPDA, data } = await plantVault();
    const { conn } = makeConnection([{ pubkey: vaultPDA, data }]);

    // At purchase time, `handlePoolSubscribeExecute` returned this key.
    const serviceTag = 'bitwarden-test';
    const keyAtPurchase = encodeLicenseKey(deriveLicenseSecret(secret, serviceTag));

    const res = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: stubCommitment,
    });
    const rec = res.recovered[0];

    // A recovered record carries (pool, leafIndex); the leaf index IS the
    // derivation counter, so any device holding the seed reaches the same
    // secret — the exact walk `handlePoolLicenseKey` performs.
    const rederived = deriveNoteMaterial(SEED, new PublicKey(rec.pool), rec.leafIndex).secret;
    expect(rederived).toBe(secret);
    expect(encodeLicenseKey(deriveLicenseSecret(rederived, serviceTag))).toBe(keyAtPurchase);
  });

  it('recovers a subscription paid with a RECEIVED note via its blob secrets', async () => {
    // A received note's secrets came from the sender's seed: underivable here,
    // only its decrypted blob knows them.
    const foreignSecret = 987_654_321_123n;
    const commitment32 = goldilocksU64To32(BigInt(await stubCommitment(foreignSecret.toString())));
    const retailer = Keypair.generate().publicKey;
    const [vaultPDA] = deriveSubscriptionVaultPDA(retailer, commitment32, SystemProgram.programId);
    const data = writeVault({ subscriberCommitment: commitment32, retailer: retailer.toBytes() });
    const { conn } = makeConnection([{ pubkey: vaultPDA, data }]);

    const withoutBlobs = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: stubCommitment,
    });
    expect(withoutBlobs.recovered).toEqual([]);

    const withBlobs = await recoverSubscriptionVaults(conn, [SEED], {
      blobCandidates: [{ pool: POOL.poolPDA.toBase58(), leafIndex: 3, secret: foreignSecret }],
      computeSubscriberCommitment: stubCommitment,
    });
    expect(withBlobs.recovered).toHaveLength(1);
    expect(withBlobs.recovered[0].vaultPDA).toBe(vaultPDA.toBase58());
    expect(withBlobs.recovered[0].leafIndex).toBe(3);
  });

  it('a vault with no source_pool is still found by walking every pool', async () => {
    const otherPool = SOL_POOLS_V3[1]; // 1 SOL
    const { secret } = deriveNoteMaterial(SEED, otherPool.poolPDA, 2);
    const commitment32 = goldilocksU64To32(BigInt(await stubCommitment(secret.toString())));
    const retailer = Keypair.generate().publicKey;
    const [vaultPDA] = deriveSubscriptionVaultPDA(retailer, commitment32, SystemProgram.programId);
    const data = writeVault({
      subscriberCommitment: commitment32,
      retailer: retailer.toBytes(),
      sourcePool: null,
    });
    const { conn } = makeConnection([{ pubkey: vaultPDA, data }]);

    const res = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: stubCommitment,
    });
    expect(res.recovered).toHaveLength(1);
    expect(res.recovered[0].pool).toBe(otherPool.poolPDA.toBase58());
    expect(res.recovered[0].token).toBe('SOL');
    expect(res.recovered[0].denomination).toBe(1);
  });
});

describe('recoverSubscriptionVaults — nothing to find', () => {
  it('a wallet with no subscriptions recovers nothing and does not throw', async () => {
    const { vaultPDA, data } = await plantVault(); // someone ELSE's vault
    const { conn } = makeConnection([{ pubkey: vaultPDA, data }]);
    const strangerSeed = new Uint8Array(32).fill(9);

    const res = await recoverSubscriptionVaults(conn, [strangerSeed], {
      computeSubscriberCommitment: stubCommitment,
    });
    expect(res.recovered).toEqual([]);
    expect(res.vaultsScanned).toBe(1); // the enumeration saw it; the match said no
  });

  it('a program with no vaults costs zero derivation work', async () => {
    const { conn, calls } = makeConnection([]);
    const spy = vi.fn(stubCommitment);

    const res = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: spy,
    });
    expect(res).toEqual({ recovered: [], vaultsScanned: 0 });
    expect(spy).not.toHaveBeenCalled();
    // No tree reads either: the early return fires before any derivation.
    expect(calls.filter((c) => c.method === 'getAccountInfo')).toEqual([]);
  });

  it('a commitment match at the WRONG address is refused by the PDA check', async () => {
    const planted = await plantVault();
    // Same account body, planted at an address that is NOT the derived PDA —
    // a decode drift (or a forged enumeration entry) must recover nothing
    // rather than record a vault the subscriber cannot prove ownership of.
    const wrongAddress = Keypair.generate().publicKey;
    const { conn } = makeConnection([{ pubkey: wrongAddress, data: planted.data }]);

    const res = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: stubCommitment,
    });
    expect(res.recovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 🚨 The leak regression. This is the test the whole design answers to.
// ---------------------------------------------------------------------------

describe('recoverSubscriptionVaults — no per-note identifier reaches the RPC', () => {
  it('sends only user-independent requests, and still finds the vault', async () => {
    const planted = await plantVault();
    const { conn, calls } = makeConnection([{ pubkey: planted.vaultPDA, data: planted.data }]);

    const res = await recoverSubscriptionVaults(conn, [SEED], {
      computeSubscriberCommitment: stubCommitment,
    });

    // POSITIVE CONTROL half 1: the scan is capable of finding something — the
    // planted vault came back, so the "sends nothing" assertions below are not
    // passing because the scan did nothing.
    expect(res.recovered).toHaveLength(1);
    expect(res.recovered[0].vaultPDA).toBe(planted.vaultPDA.toBase58());

    const serialized = JSON.stringify(calls);

    // POSITIVE CONTROL half 2: the serialization the detector searches DOES
    // contain a value we know is in the requests (the discriminator filter),
    // so a per-note identifier below could not hide from it.
    expect(serialized).toContain(
      Buffer.from(SUBSCRIPTION_VAULT_DISCRIMINATOR).toString('base64'),
    );

    // The identifiers a per-note probe would have sent, in every encoding a
    // request could plausibly carry them. None may appear in ANY request.
    const forbidden = [
      planted.vaultPDA.toBase58(), // getAccountInfo(vaultPDA) — the L4 shape
      planted.secret.toString(),
      planted.commitment.toString(),
      bytesToHex(planted.commitment32),
      base58Encode(planted.commitment32),
      Buffer.from(planted.commitment32).toString('base64'), // a memcmp filter on the commitment
    ];
    for (const value of forbidden) {
      expect(serialized).not.toContain(value);
    }

    // The request set, by shape: ONE program-wide enumeration whose only
    // filter is the discriminator at offset 0 (never a dataSize — the vault
    // has three sizes — and never a commitment memcmp)...
    const enumerations = calls.filter((c) => c.method === 'getProgramAccounts');
    expect(enumerations).toHaveLength(1);
    expect(enumerations[0].programId).toBe(ZK_SHIELDED_PROGRAM_ID.toBase58());
    expect((enumerations[0].cfg as { filters: unknown[] }).filters).toEqual([
      subscriptionVaultFilter(),
    ]);

    // ...plus getAccountInfo reads of pool TREE accounts only — fixed table
    // constants every client reads on every shield, identical for every user.
    const treeAddresses = new Set(ALL_POOLS_V3.map((p) => p.treePDA.toBase58()));
    for (const call of calls.filter((c) => c.method === 'getAccountInfo')) {
      expect(treeAddresses.has(call.address as string)).toBe(true);
    }
  });

  it('the detector catches the naive implementation (control of the control)', async () => {
    // If someone reintroduces a per-note getAccountInfo(vaultPDA) probe, the
    // exact assertions above must go red. Prove it: simulate one probe and run
    // the same detector over its recorded calls.
    const planted = await plantVault();
    const { conn, calls } = makeConnection([]);
    await conn.getAccountInfo(planted.vaultPDA); // the leak, one call of it
    expect(JSON.stringify(calls)).toContain(planted.vaultPDA.toBase58());
  });
});

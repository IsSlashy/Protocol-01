/**
 * WHEN the license key is persisted, relative to the subscribe transaction.
 *
 * MEASURED before 2026-09-02: `subscribePrivate` confirmed the tx, then its
 * `finally` closed two proof buffers (two more confirmed transactions), then
 * the store reloaded every vault, then the page fetched the vault and dropped
 * the note, and only THEN derived and saved the key. The extension popup
 * closes the moment it loses focus (sessionCrypto.ts, measured 2026-08-18), so
 * a customer whose popup closed in that window had paid, had a commitment on
 * chain, and had no key. Nothing could rebuild one: the service tag was not
 * recorded anywhere.
 *
 * The real `subscribePrivate` runs here against stubbed proving, a stubbed
 * verifier and a fake connection, and every persistence step is logged in the
 * order it happens. The one assertion that matters is that `license` comes
 * after `confirmed` and before the first `close`.
 *
 * What this does NOT measure: that a proof verifies, or that the popup really
 * closes. The wire bytes it does measure: the interval written and the
 * commitment posted, decoded from the transaction the fake connection was
 * handed, against the key the store holds.
 */

// @vitest-environment node
//
// Node, not jsdom: vitest's jsdom environment replaces the global `Uint8Array`
// with jsdom's realm copy, so the Node `Buffer` that `findProgramAddressSync`
// hashes is refused by @noble/hashes and every PDA derivation dies with
// "Unable to find a viable program address nonce". Same reason
// denominatedPool.test.ts runs in node. The stores' chrome.storage backing is
// stubbed below because only the jsdom setup defines `chrome`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

vi.hoisted(() => {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  };
});

const h = vi.hoisted(() => ({
  events: [] as string[],
  sentTx: null as Uint8Array | null,
  submitAndVerifyStarkProof: vi.fn(),
  closeStarkProofBuffer: vi.fn(),
  prepareUnshield: vi.fn(),
  isNullifierSpent: vi.fn(),
  findPoolV3: vi.fn(),
  confirmTransaction: vi.fn(),
  walletState: { publicKey: null as string | null, _keypair: null as unknown, network: 'devnet' },
}));

/** Spread the real module; override only the two verifier round-trips. */
vi.mock('./stark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stark')>();
  return {
    ...actual,
    submitAndVerifyStarkProof: h.submitAndVerifyStarkProof,
    closeStarkProofBuffer: h.closeStarkProofBuffer,
  };
});

/** Same: the real pool module, with proving and the two RPC lookups stubbed. */
vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    prepareUnshield: h.prepareUnshield,
    isNullifierSpent: h.isNullifierSpent,
    findPoolV3: h.findPoolV3,
  };
});

vi.mock('../store/wallet', () => ({
  useWalletStore: { getState: () => h.walletState },
}));

/** The fake connection records the confirmation and keeps the raw tx. */
vi.mock('./wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet')>();
  return {
    ...actual,
    getConnection: () => ({
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        h.sentTx = raw;
        return 'SIG';
      },
      confirmTransaction: h.confirmTransaction,
    }),
  };
});

/**
 * No WebCrypto in this environment. The vault store still encrypts the
 * subscriber secret at rest and decrypts it on read; the round trip is what
 * the rebuild depends on, so it is kept, with a transparent cipher.
 */
vi.mock('./sessionCrypto', () => ({
  getSessionPassword: () => 'test-password',
  encryptForSession: async (plaintext: string) => ({ ct: plaintext, iv: '', salt: '', _enc: true }),
  decryptFromSession: async (blob: { ct: string }) => blob.ct,
  isEncryptedBlob: (v: unknown) =>
    !!v && typeof v === 'object' && (v as { _enc?: boolean })._enc === true,
}));

import { subscribePrivate, deriveVaultPDA, goldilocksU64To32 } from './subscriptionVault';
import { useLicenseStore } from '../store/license';
import { useSubscriptionVaultStore } from '../store/subscriptionVault';
import { decodeLicenseKey, licenseCommitment, licenseKeyForPrivate } from './license';

const PAYER = Keypair.generate();
const RETAILER = Keypair.generate().publicKey.toBase58();
const POOL_PDA = Keypair.generate().publicKey;
const TREE_PDA = Keypair.generate().publicKey;
const SUBSCRIBER_COMMITMENT = 7n;
const SERVICE_TAG = 'acme';

const NOTE = {
  secret: 123456789012345678n,
  nullifierPreimage: 42n,
  depositEpoch: 0n,
  tokenMint: 0n,
  commitment: 777n,
  leafIndex: 0,
  denomination: 1_000_000_000n,
  pool: POOL_PDA.toBase58(),
  token: 'SOL' as const,
  denominationHuman: 1,
  shieldedAt: 0,
  merkleRoot: 1n,
};

const VAULT_PDA = deriveVaultPDA(
  new PublicKey(RETAILER),
  goldilocksU64To32(SUBSCRIBER_COMMITMENT),
  SystemProgram.programId,
).toBase58();

const proofResult = { proofBytes: new Uint8Array(8), publicInputs: [] as number[], proofSize: 8 };

/** Byte offset of `interval_slots` and of the license Option in the ix data. */
const INTERVAL_OFFSET = 8 + 32 + 32 + 8 + 32 + 8;
const LICENSE_OFFSET = INTERVAL_OFFSET + 8 + 32 + 8;

function subscribe() {
  return subscribePrivate({
    receipt: NOTE,
    poolPDA: POOL_PDA.toBase58(),
    treePDA: TREE_PDA.toBase58(),
    retailer: RETAILER,
    rate: 60_000_000n,
    intervalSlots: 100_000n,
    subscriberOwnershipCommitment: SUBSCRIBER_COMMITMENT,
    vkHashSubscriber: new Uint8Array(32),
    serviceId: SERVICE_TAG,
    serviceName: 'Acme Reader',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.events.length = 0;
  h.sentTx = null;
  h.walletState.publicKey = PAYER.publicKey.toBase58();
  h.walletState._keypair = PAYER;
  useLicenseStore.getState().reset();
  useSubscriptionVaultStore.setState({ vaults: [], subscriberSecrets: {} });

  h.findPoolV3.mockReturnValue({
    token: 'SOL',
    tokenMint: SystemProgram.programId,
    denomination: 1,
    denominationAtomic: 1_000_000_000n,
    decimals: 9,
    poolPDA: POOL_PDA,
    treePDA: TREE_PDA,
    version: 'v3',
  });
  h.isNullifierSpent.mockResolvedValue(false);
  h.prepareUnshield.mockResolvedValue({
    c1ProofResult: proofResult,
    c3ProofResult: proofResult,
    merkleRoot: 1n,
    nullifierGoldilocks: 2n,
    starkCommitment: 3n,
    subtreeRoot: 4n,
    siblings: [5n, 6n, 7n],
    directions: [0, 1, 0],
  });
  h.submitAndVerifyStarkProof.mockImplementation(async () => ({
    proofBuffer: Keypair.generate().publicKey,
    authority: PAYER.publicKey,
    txSignature: 'proof-sig',
  }));
  h.closeStarkProofBuffer.mockImplementation(async () => {
    h.events.push('close');
  });
  h.confirmTransaction.mockImplementation(async () => {
    h.events.push('confirmed');
  });

  // Every persistence step, in the order the stores see it. zustand notifies
  // synchronously inside `set`, so this is the true order.
  useSubscriptionVaultStore.subscribe((s, prev) => {
    if (Object.keys(s.subscriberSecrets).length > Object.keys(prev.subscriberSecrets).length) {
      h.events.push('secret');
    }
  });
  useLicenseStore.subscribe((s, prev) => {
    if (Object.keys(s.vaultTags).length > Object.keys(prev.vaultTags).length) h.events.push('tag');
    if (Object.keys(s.licenses).length > Object.keys(prev.licenses).length) h.events.push('license');
  });
});

describe('the key is persisted the instant the subscribe tx confirms', () => {
  it('secret before the tx, tag before the send, key after confirmation and before any close', async () => {
    await subscribe();
    expect(h.events).toEqual(['secret', 'tag', 'confirmed', 'license', 'close', 'close']);
  });

  it('the key it persists is the preimage of the commitment on the wire, for the interval on the wire', async () => {
    await subscribe();
    const entry = useLicenseStore.getState().getLicense(RETAILER, 'zk');
    expect(entry?.licenseKey).toBe(licenseKeyForPrivate(NOTE.secret, SERVICE_TAG));
    expect(entry?.vaultAddress).toBe(VAULT_PDA);
    expect(entry?.serviceTag).toBe(SERVICE_TAG);
    expect(entry?.serviceName).toBe('Acme Reader');

    // The merchant's check: blake3(decode(presentedKey)) == vault.license_commitment.
    expect(h.sentTx).not.toBeNull();
    const tx = Transaction.from(h.sentTx!);
    const data = tx.instructions[tx.instructions.length - 1].data;
    expect(data.readBigUInt64LE(INTERVAL_OFFSET)).toBe(100_000n);
    expect(data[LICENSE_OFFSET]).toBe(1);
    const posted = Buffer.from(data.subarray(LICENSE_OFFSET + 1, LICENSE_OFFSET + 33));
    const fromKey = Buffer.from(licenseCommitment(decodeLicenseKey(entry!.licenseKey)));
    expect(posted.equals(fromKey)).toBe(true);
  });
});

describe('the key can be rebuilt for a vault the store knows', () => {
  it('re-derivation from the encrypted-at-rest secret yields the minted key', async () => {
    await subscribe();
    const minted = useLicenseStore.getState().getLicense(RETAILER, 'zk')!.licenseKey;
    const rebuilt = await useLicenseStore.getState().deriveLicenseForVault(VAULT_PDA);
    expect(rebuilt?.licenseKey).toBe(minted);
  });

  it('THE DEFECT WINDOW: a confirmation this device never saw still leaves a presentable key', async () => {
    // The tx is sent; the client-side confirmation fails (blockhash expiry on
    // a tx that may well have landed, a case this codebase documents). No key
    // was minted anywhere, which was the whole defect.
    h.confirmTransaction.mockRejectedValue(new Error('block height exceeded'));
    await expect(subscribe()).rejects.toThrow('block height exceeded');
    expect(useLicenseStore.getState().getLicense(RETAILER, 'zk')).toBeNull();

    const list = await useLicenseStore.getState().presentableLicenses();
    expect(list).toHaveLength(1);
    expect(list[0].vaultAddress).toBe(VAULT_PDA);
    expect(list[0].confirmed).toBe(false);
    expect(list[0].licenseKey).toBe(licenseKeyForPrivate(NOTE.secret, SERVICE_TAG));
  });

  it('a failure before the send records no tag, so no key is offered for a vault that never existed', async () => {
    h.submitAndVerifyStarkProof.mockRejectedValue(new Error('verifier refused'));
    await expect(subscribe()).rejects.toThrow('verifier refused');
    expect(useLicenseStore.getState().vaultTags).toEqual({});
    expect(await useLicenseStore.getState().presentableLicenses()).toEqual([]);
  });
});

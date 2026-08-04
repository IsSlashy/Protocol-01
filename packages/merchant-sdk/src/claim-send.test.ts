/**
 * The send path of the revenue leg, and specifically its PERMISSIONLESS shape.
 *
 * WHY THIS FILE EXISTS. The 2026-08-04 redeploy changed `claim_period` to take
 * the retailer as an `UncheckedAccount` pinned by `retailer.key() ==
 * vault.retailer` — the DESTINATION is fixed, the SENDER is not. That change
 * exists to rescue merchants whose retailer key is gone (~5.5 SOL of devnet
 * vaults), and it was proven on chain by a third-party signer the same day.
 * The SDK's `claimPeriod()` then shipped demanding the retailer as a `Signer`
 * and signing with nothing else — re-imposing in software exactly the
 * constraint the program had removed. The fix was found by a state-check agent,
 * not by a test, because every test passed the retailer as its own payer: the
 * one shape that cannot see the bug.
 *
 * These tests ARE the missing shape. If `claimPeriod` ever again requires the
 * retailer's key — by demanding a `Signer` for the third parameter, by marking
 * the retailer account `isSigner`, or by putting the retailer back in the
 * signer list — the third-party-payer tests below go red.
 *
 * Everything is offline: the `Connection` is a stub and
 * `sendAndConfirmTransaction` is mocked to capture what would have been sent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  type Connection,
  type Signer,
  type Transaction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

import { claimPeriod } from './claim-send';
import { decodeSubscriptionVault } from './vaults';
import { ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn(async () => 'MOCK_SIGNATURE'),
  };
});

const PROGRAM = ZK_SHIELDED_PROGRAM_ID_DEVNET;
const VAULT_DISC = [96, 90, 247, 202, 157, 16, 86, 190];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Borsh-faithful private-mode vault body, zero-padded to `size`.
 *
 * The padding is not decoration: real vaults are `init`ed at a fixed `space`
 * and Borsh-serialized variable-width, so every live account carries trailing
 * zeros. The three sizes live on devnet are 263, 328 and 361 bytes — which is
 * why nothing here (or in the SDK) may ever assume a single `LEN`.
 */
function buildVault(f: {
  retailer: PublicKey;
  tokenMint?: PublicKey;
  totalDeposited?: bigint;
  rate?: bigint;
  intervalSlots?: bigint;
  startSlot?: bigint;
  claimedPeriods?: bigint;
  size?: number;
}): Buffer {
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };

  const body = Buffer.concat([
    Buffer.from(VAULT_DISC),
    Buffer.from([0]), // subscriber_pubkey None — ONE byte
    Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 0x11)]), // commitment Some
    f.retailer.toBuffer(),
    (f.tokenMint ?? SystemProgram.programId).toBuffer(),
    u64(f.totalDeposited ?? 12_000_000_000n), // 12 periods at 1 SOL
    u64(f.rate ?? 1_000_000_000n),
    u64(f.intervalSlots ?? 100n),
    i64(f.startSlot ?? 1_000n),
    u64(f.claimedPeriods ?? 0n),
    Buffer.from([1, 0]), // is_active, is_paused
    Buffer.from([0]), // pause_slot None
    i64(0n), // total_paused_slots
    Buffer.alloc(32, 0x44), // vk_hash_subscriber
    Buffer.from([0]), // source_pool None
    Buffer.from([7]), // bump
    Buffer.from([0]), // client_stealth_meta None
    Buffer.from([0]), // license_commitment None
  ]);
  const size = f.size ?? 263;
  if (body.length > size) throw new Error(`fixture body ${body.length} exceeds size ${size}`);
  return Buffer.concat([body, Buffer.alloc(size - body.length)]);
}

/** The members `claimPeriod` actually reaches for, nothing else. */
function stubConnection(opts: {
  vaultPda: PublicKey;
  vaultData: Buffer;
  slot?: number;
  retailerBalance?: number;
  /** Vault account lamports — the rent a closing claim releases. */
  vaultLamports?: number;
}): Connection {
  return {
    async getAccountInfo(pk: PublicKey) {
      if (!pk.equals(opts.vaultPda)) return null;
      return {
        data: opts.vaultData,
        owner: PROGRAM,
        lamports: opts.vaultLamports ?? 2_616_960, // measured shape: rent for a mid-size vault
        executable: false,
        rentEpoch: 0,
      };
    },
    async getSlot() { return opts.slot ?? 1_550; }, // 5 periods past start
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 };
    },
    async getFeeForMessage() { return { context: { slot: 1 }, value: 5_000 }; },
    async getBalance() { return opts.retailerBalance ?? 0; },
    async getMinimumBalanceForRentExemption() { return 890_880; },
  } as unknown as Connection;
}

const sent = vi.mocked(sendAndConfirmTransaction);

function lastSend(): { tx: Transaction; signers: Signer[] } {
  expect(sent).toHaveBeenCalled();
  const call = sent.mock.calls[sent.mock.calls.length - 1]!;
  return { tx: call[1] as Transaction, signers: call[2] as Signer[] };
}

beforeEach(() => { sent.mockClear(); });

// ---------------------------------------------------------------------------
// The permissionless shape — the one every earlier test missed
// ---------------------------------------------------------------------------

describe('claimPeriod with a third-party payer and no retailer key', () => {
  const retailer = Keypair.generate().publicKey; // an ADDRESS. There is no key.
  const keeper = Keypair.generate();
  const vaultPda = Keypair.generate().publicKey;

  it('settles a claim from a bare retailer PublicKey — nobody holds the retailer secret', async () => {
    const conn = stubConnection({ vaultPda, vaultData: buildVault({ retailer }) });

    const res = await claimPeriod(conn, vaultPda, retailer, { payer: keeper });

    expect(res.signature).toBe('MOCK_SIGNATURE');
    expect(res.periodsClaimed).toBe(5n);
    expect(res.amountClaimed).toBe(5_000_000_000n);
  });

  it('never asks the retailer to sign: not in the account metas, not in the signer list', async () => {
    const conn = stubConnection({ vaultPda, vaultData: buildVault({ retailer }) });
    await claimPeriod(conn, vaultPda, retailer, { payer: keeper });

    const { tx, signers } = lastSend();

    // The payer carries the fee and is the ONLY required signature.
    expect(tx.feePayer!.equals(keeper.publicKey)).toBe(true);
    expect(signers.map((s) => s.publicKey.toBase58())).toEqual([keeper.publicKey.toBase58()]);
    expect(tx.compileMessage().header.numRequiredSignatures).toBe(1);

    // The retailer travels as a plain writable account, exactly as the program
    // declares it since the 2026-08-04 redeploy. If this flips back to
    // `isSigner: true`, the SDK has re-imposed the removed constraint.
    const retailerMeta = tx.instructions[0]!.keys[0]!;
    expect(retailerMeta.pubkey.equals(retailer)).toBe(true);
    expect(retailerMeta.isSigner).toBe(false);
    expect(retailerMeta.isWritable).toBe(true);
  });

  it('does not net the fee against the payout when the payer is not the retailer', async () => {
    // Retailer balance 0 and payout exactly on the rent floor: passes only if
    // the fee is charged to the payer, not the retailer. If the fee were
    // netted (the self-claim rule), the preflight would throw.
    const conn = stubConnection({
      vaultPda,
      vaultData: buildVault({ retailer, rate: 890_880n, totalDeposited: 890_880n * 12n }),
      retailerBalance: 0,
    });
    await expect(claimPeriod(conn, vaultPda, retailer, { payer: keeper })).resolves.toBeDefined();
  });

  it('refuses a bare address with no payer, naming opts.payer as the fix', async () => {
    const conn = stubConnection({ vaultPda, vaultData: buildVault({ retailer }) });
    await expect(claimPeriod(conn, vaultPda, retailer)).rejects.toThrow(/opts\.payer/);
    expect(sent).not.toHaveBeenCalled();
  });

  it('still pins the DESTINATION: a wrong retailer address is refused before sending', async () => {
    const conn = stubConnection({ vaultPda, vaultData: buildVault({ retailer }) });
    const wrong = Keypair.generate().publicKey;
    await expect(claimPeriod(conn, vaultPda, wrong, { payer: keeper })).rejects.toThrow(
      /is not this vault's retailer/,
    );
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses retailerSigns when there is no retailer key to sign with', async () => {
    const conn = stubConnection({ vaultPda, vaultData: buildVault({ retailer }) });
    await expect(
      claimPeriod(conn, vaultPda, retailer, { payer: keeper, retailerSigns: true }),
    ).rejects.toThrow(/no key to sign with/);
    expect(sent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The self-claim keeps working
// ---------------------------------------------------------------------------

describe('claimPeriod with the retailer as its own Signer', () => {
  const retailerKp = Keypair.generate();
  const vaultPda = Keypair.generate().publicKey;

  it('signs and pays as the retailer, unchanged', async () => {
    const conn = stubConnection({
      vaultPda,
      vaultData: buildVault({ retailer: retailerKp.publicKey }),
      retailerBalance: 1_000_000_000,
    });
    const res = await claimPeriod(conn, vaultPda, retailerKp);
    expect(res.signature).toBe('MOCK_SIGNATURE');

    const { tx, signers } = lastSend();
    expect(tx.feePayer!.equals(retailerKp.publicKey)).toBe(true);
    expect(signers).toEqual([retailerKp]);
  });

  it('adds the retailer as a co-signer for the treasury case (payer + retailerSigns)', async () => {
    const keeper = Keypair.generate();
    const conn = stubConnection({
      vaultPda,
      vaultData: buildVault({ retailer: retailerKp.publicKey }),
    });
    await claimPeriod(conn, vaultPda, retailerKp, { payer: keeper, retailerSigns: true });

    const { tx, signers } = lastSend();
    expect(signers.map((s) => s.publicKey.toBase58())).toEqual([
      keeper.publicKey.toBase58(),
      retailerKp.publicKey.toBase58(),
    ]);
    expect(tx.instructions[0]!.keys[0]!.isSigner).toBe(true);
    expect(tx.compileMessage().header.numRequiredSignatures).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Close-on-exhaustion — the rent release the 2026-08-04 program supports
// ---------------------------------------------------------------------------

describe('claimPeriod on an exhausted vault', () => {
  const retailer = Keypair.generate().publicKey;
  const keeper = Keypair.generate();
  const vaultPda = Keypair.generate().publicKey;
  // 12 funded periods, all collected, with a 500-lamport sub-period remainder
  // integer division left behind (12_000_000_500 / 1e9 = 12).
  const exhausted = () =>
    buildVault({ retailer, totalDeposited: 12_000_000_500n, claimedPeriods: 12n });

  it('still refuses by default, and the error names the closeExhausted opt-in', async () => {
    const conn = stubConnection({ vaultPda, vaultData: exhausted() });
    await expect(claimPeriod(conn, vaultPda, retailer, { payer: keeper })).rejects.toThrow(
      /closeExhausted: true/,
    );
    expect(sent).not.toHaveBeenCalled();
  });

  it('closeExhausted sends the closing claim, permissionless, and reports the rent release', async () => {
    const conn = stubConnection({ vaultPda, vaultData: exhausted(), vaultLamports: 2_616_960 });
    const res = await claimPeriod(conn, vaultPda, retailer, {
      payer: keeper,
      closeExhausted: true,
    });
    expect(res.periodsClaimed).toBe(0n);
    expect(res.amountClaimed).toBe(500n); // the sub-period remainder
    expect(res.closesVault).toBe(true);
    expect(res.rentReleasedLamports).toBe(2_616_960n);

    // Still the permissionless shape: the retailer signs nothing.
    const { tx, signers } = lastSend();
    expect(signers.map((s) => s.publicKey.toBase58())).toEqual([keeper.publicKey.toBase58()]);
    expect(tx.instructions[0]!.keys[0]!.isSigner).toBe(false);
  });

  it('clears the native rent floor on the rent alone — an empty retailer can still be closed into', async () => {
    // Remainder 500 is far under the 890,880 floor; the released rent is what
    // makes the transaction land. If the preflight ignored it, this would
    // throw the strand error.
    const conn = stubConnection({
      vaultPda,
      vaultData: exhausted(),
      retailerBalance: 0,
      vaultLamports: 2_616_960,
    });
    await expect(
      claimPeriod(conn, vaultPda, retailer, { payer: keeper, closeExhausted: true }),
    ).resolves.toBeDefined();
  });

  it('does NOT let closeExhausted force a claim on a vault that is merely between periods', async () => {
    // 12 funded, 5 collected, and the clock has not reached period 6 yet:
    // a claim here really would fail on chain with NoClaimablePeriods.
    const conn = stubConnection({
      vaultPda,
      vaultData: buildVault({ retailer, claimedPeriods: 5n }),
      slot: 1_550, // 5 periods elapsed, all 5 already claimed
    });
    await expect(
      claimPeriod(conn, vaultPda, retailer, { payer: keeper, closeExhausted: true }),
    ).rejects.toThrow(/Wait for the next interval/);
    expect(sent).not.toHaveBeenCalled();
  });

  it('reports the close on the ORDINARY final claim too', async () => {
    // 7 of 12 collected, clock far past the end: this claim sweeps the last 5
    // periods and the program closes the vault in the same transaction.
    const conn = stubConnection({
      vaultPda,
      vaultData: buildVault({ retailer, claimedPeriods: 7n }),
      slot: 99_999,
      vaultLamports: 2_616_960,
    });
    const res = await claimPeriod(conn, vaultPda, retailer, { payer: keeper });
    expect(res.periodsClaimed).toBe(5n);
    expect(res.amountClaimed).toBe(5_000_000_000n);
    expect(res.closesVault).toBe(true);
    expect(res.rentReleasedLamports).toBe(2_616_960n);
  });

  it('reports no close on a mid-life claim', async () => {
    const conn = stubConnection({ vaultPda, vaultData: buildVault({ retailer }) }); // 5 of 12
    const res = await claimPeriod(conn, vaultPda, retailer, { payer: keeper });
    expect(res.closesVault).toBe(false);
    expect(res.rentReleasedLamports).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// The three vault sizes live on chain
// ---------------------------------------------------------------------------

describe('claimPeriod across the three on-chain account sizes', () => {
  // 263 / 328 / 361 bytes, all live on devnet at once. The decoder is
  // variable-width Borsh + trailing zero padding; nothing may assume one LEN.
  const retailer = Keypair.generate().publicKey;
  const keeper = Keypair.generate();

  for (const size of [263, 328, 361]) {
    it(`decodes and claims from a ${size}-byte vault account`, async () => {
      const vaultPda = Keypair.generate().publicKey;
      const data = buildVault({ retailer, size });
      expect(data.length).toBe(size);
      expect(decodeSubscriptionVault(data, vaultPda).retailer.equals(retailer)).toBe(true);

      const conn = stubConnection({ vaultPda, vaultData: data });
      const res = await claimPeriod(conn, vaultPda, retailer, { payer: keeper });
      expect(res.amountClaimed).toBe(5_000_000_000n);
    });
  }
});

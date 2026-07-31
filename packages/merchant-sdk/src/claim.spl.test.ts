import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  assertRetailerCanReceiveClaim,
  assertSplClaimCanSettle,
  buildClaimPeriodInstruction,
  CLAIM_PERIOD_DISCRIMINATOR,
  decodeTokenAccount,
  retailerTokenAccountIsControlledByRetailer,
  TOKEN_ACCOUNT_LEN,
  TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  type SplClaimAccounts,
} from './claim';
import { ZK_SHIELDED_PROGRAM_ID } from './vaults';

/**
 * The SPL branch of `claim_period`
 * (`programs/zk_shielded/src/instructions/claim_period.rs:95-119`) had never
 * executed anywhere until 2026-08-01. It was then exercised end to end on
 * devnet against `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` and every
 * expectation below is pinned to a transaction that really ran.
 *
 * Fixture, all from that run:
 *   mint                26xukGeNZm18eqssCaELNV1MXzApaknrFNreVtPBJ1gD  (decimals 0)
 *   vault PDA           4RtxDQfc2rxFU5a4AQxYvTuYwxwCeNfSM8UkedzeuCe9
 *   vault token account CkEqTELt7bgjnuvB8mUk9zU6E34Nb1nCrnTyHhmhjZjQ  (owner = the PDA)
 *   retailer            5Xo5uSnHj5VRwm1m8t1CAzQYhQgKZXRL695fAp3wbCpm  (0 lamports, throughout)
 *   retailer ATA        8goQ48gdJzgvAtRKDqtBum3cUmNYbQoyoVHXT64ND2n1
 *   subscriber ATA      BeVYznTHSCE9PfeNPDXA5xhSWPuhc85sPU1fw7tRdFBs  (owner = subscriber)
 */
const MINT = new PublicKey('26xukGeNZm18eqssCaELNV1MXzApaknrFNreVtPBJ1gD');
const MINT2 = new PublicKey('2oSC2uBL4R4neSork5oX5e4PjBpNgAcpddn8wYuoRLMH');
const VAULT_PDA = new PublicKey('4RtxDQfc2rxFU5a4AQxYvTuYwxwCeNfSM8UkedzeuCe9');
const VAULT_TA = new PublicKey('CkEqTELt7bgjnuvB8mUk9zU6E34Nb1nCrnTyHhmhjZjQ');
const RETAILER = new PublicKey('5Xo5uSnHj5VRwm1m8t1CAzQYhQgKZXRL695fAp3wbCpm');
const RETAILER_ATA = new PublicKey('8goQ48gdJzgvAtRKDqtBum3cUmNYbQoyoVHXT64ND2n1');
const SUBSCRIBER = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');
const SUBSCRIBER_ATA = new PublicKey('BeVYznTHSCE9PfeNPDXA5xhSWPuhc85sPU1fw7tRdFBs');

/** Build the 165-byte SPL token account layout the program will read. */
function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint, state = 1): Buffer {
  const b = Buffer.alloc(TOKEN_ACCOUNT_LEN);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b[108] = state;
  return b;
}

function accountInfo(data: Buffer, owner = TOKEN_PROGRAM_ID) {
  return { data, owner, lamports: Number(TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS), executable: false, rentEpoch: 0 };
}

/**
 * Minimal `Connection` stand-in. Only the three methods the preflight calls are
 * implemented, so a call to anything else is a test failure rather than a
 * silent pass.
 */
function fakeConnection(accounts: Map<string, ReturnType<typeof accountInfo> | null>, lamports: Record<string, number> = {}) {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => accounts.get(k.toBase58()) ?? null),
    getBalance: async (k: PublicKey) => lamports[k.toBase58()] ?? 0,
    getMinimumBalanceForRentExemption: async (space: number) => (space === 0 ? 890_880 : 2_039_280),
  } as never;
}

const HEALTHY: SplClaimAccounts = {
  vaultPda: VAULT_PDA,
  vaultTokenAccount: VAULT_TA,
  retailerTokenAccount: RETAILER_ATA,
  tokenMint: MINT,
};

function healthyAccounts(vaultBalance = 5n) {
  return new Map([
    [VAULT_TA.toBase58(), accountInfo(tokenAccountData(MINT, VAULT_PDA, vaultBalance))],
    [RETAILER_ATA.toBase58(), accountInfo(tokenAccountData(MINT, RETAILER, 0n))],
  ]);
}

describe('decodeTokenAccount', () => {
  it('reads mint, owner and amount at the spl-token 3.x offsets', () => {
    const d = decodeTokenAccount(tokenAccountData(MINT, VAULT_PDA, 5n));
    expect(d.mint.toBase58()).toBe(MINT.toBase58());
    expect(d.owner.toBase58()).toBe(VAULT_PDA.toBase58());
    expect(d.amount).toBe(5n);
    expect(d.isFrozen).toBe(false);
  });

  it('reads the frozen state byte at offset 108', () => {
    expect(decodeTokenAccount(tokenAccountData(MINT, VAULT_PDA, 5n, 2)).isFrozen).toBe(true);
    expect(decodeTokenAccount(tokenAccountData(MINT, VAULT_PDA, 5n, 1)).isFrozen).toBe(false);
  });

  it('refuses a buffer too short to be a token account', () => {
    expect(() => decodeTokenAccount(Buffer.alloc(64))).toThrow(/not an SPL token account/);
  });

  it('decodes at a non-zero byteOffset without reading the neighbours', () => {
    // getAccountInfo hands back views into a larger buffer; a naive
    // Buffer.from(uint8array.buffer) would silently read from offset 0.
    const outer = Buffer.alloc(TOKEN_ACCOUNT_LEN * 2, 0xab);
    tokenAccountData(MINT, VAULT_PDA, 7n).copy(outer, TOKEN_ACCOUNT_LEN);
    const view = new Uint8Array(outer.buffer, outer.byteOffset + TOKEN_ACCOUNT_LEN, TOKEN_ACCOUNT_LEN);
    const d = decodeTokenAccount(view);
    expect(d.mint.toBase58()).toBe(MINT.toBase58());
    expect(d.amount).toBe(7n);
  });
});

describe('buildClaimPeriodInstruction — the SPL account shape that settled on devnet', () => {
  it('reproduces exactly the six accounts of the successful claim', () => {
    // tx 5Aym1ZiUZMD2w7DUUmWfCEqZoc9h1q7y7RiyMXJGwQqSpBsxqpCvfZoqYNFoHpr6TxBFMcDEofPjDnX8EnH3Gyuh
    // 9,935 CU, retailer ATA 0 -> 5, vault token account 5 -> 0, claimed_periods 0 -> 5.
    const ix = buildClaimPeriodInstruction(VAULT_PDA, RETAILER, {
      vaultTokenAccount: VAULT_TA,
      retailerTokenAccount: RETAILER_ATA,
    });
    expect(ix.programId.toBase58()).toBe(ZK_SHIELDED_PROGRAM_ID.toBase58());
    expect(ix.data).toEqual(Buffer.from(CLAIM_PERIOD_DISCRIMINATOR));
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [RETAILER.toBase58(), true, true],
      [VAULT_PDA.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [VAULT_TA.toBase58(), false, true],
      [RETAILER_ATA.toBase58(), false, true],
    ]);
  });

  it('keeps the token program slot read-only and the two token accounts writable', () => {
    // Anchor declares `token_program: Option<Program<Token>>` non-mut and both
    // token accounts `#[account(mut)]`. Marking the program writable would make
    // the runtime reject the transaction before the program ever runs.
    const ix = buildClaimPeriodInstruction(VAULT_PDA, RETAILER, {
      vaultTokenAccount: VAULT_TA,
      retailerTokenAccount: RETAILER_ATA,
    });
    expect(ix.keys[3]!.isWritable).toBe(false);
    expect(ix.keys[4]!.isWritable).toBe(true);
    expect(ix.keys[5]!.isWritable).toBe(true);
  });

  it('never marks a token account a signer — only the retailer signs', () => {
    const ix = buildClaimPeriodInstruction(VAULT_PDA, RETAILER, {
      vaultTokenAccount: VAULT_TA,
      retailerTokenAccount: RETAILER_ATA,
    });
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      RETAILER.toBase58(),
    ]);
  });

  it('produces the native shape that MEASURABLY fails on an SPL vault', () => {
    // Sending this against an SPL vault gave error 6015 MissingTokenProgram,
    // tx Xe1ZcYQg3RgjZm1qmoF4ZbaNG5sLEoEQsrgHT5JxqXZHFQiXhFqPLYiXuCDjzjJ43JBAvr2ogeUBTutvg6AfD7U.
    // The builder is right to make the two shapes distinct.
    const ix = buildClaimPeriodInstruction(VAULT_PDA, RETAILER);
    expect(ix.keys[3]!.pubkey.toBase58()).toBe(ZK_SHIELDED_PROGRAM_ID.toBase58());
    expect(ix.keys[3]!.pubkey.toBase58()).not.toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe('assertSplClaimCanSettle — one check per measured devnet failure', () => {
  it('passes the wiring that actually settled', async () => {
    await expect(
      assertSplClaimCanSettle(fakeConnection(healthyAccounts(5n)), 5n, HEALTHY),
    ).resolves.toBeUndefined();
  });

  it('names the missing retailer token account instead of leaving Anchor to say "wrong program"', async () => {
    // On chain: Anchor 3007 AccountOwnedByWrongProgram, Left 1111…111.
    const accounts = healthyAccounts();
    accounts.set(RETAILER_ATA.toBase58(), null);
    await expect(
      assertSplClaimCanSettle(fakeConnection(accounts), 5n, HEALTHY),
    ).rejects.toThrow(/retailer_token_account .* does not exist/);
  });

  it('names the missing vault token account too', async () => {
    const accounts = healthyAccounts();
    accounts.set(VAULT_TA.toBase58(), null);
    await expect(
      assertSplClaimCanSettle(fakeConnection(accounts), 5n, HEALTHY),
    ).rejects.toThrow(/vault_token_account .* does not exist/);
  });

  it('rejects an account that exists but is not owned by the token program', async () => {
    const accounts = healthyAccounts();
    accounts.set(
      RETAILER_ATA.toBase58(),
      accountInfo(tokenAccountData(MINT, RETAILER, 0n), SystemProgram.programId),
    );
    await expect(
      assertSplClaimCanSettle(fakeConnection(accounts), 5n, HEALTHY),
    ).rejects.toThrow(/not the\s+SPL token program/);
  });

  it('distinguishes the two 6018 InvalidTokenMint sites the error code cannot', async () => {
    // Both raise 6018; only claim_period.rs:106 vs :107 tells them apart.
    const retailerWrong = healthyAccounts();
    retailerWrong.set(RETAILER_ATA.toBase58(), accountInfo(tokenAccountData(MINT2, RETAILER, 0n)));
    await expect(
      assertSplClaimCanSettle(fakeConnection(retailerWrong), 5n, HEALTHY),
    ).rejects.toThrow(/retailer_token_account .* claim_period\.rs:107/s);

    const vaultWrong = healthyAccounts();
    vaultWrong.set(VAULT_TA.toBase58(), accountInfo(tokenAccountData(MINT2, VAULT_PDA, 5n)));
    await expect(
      assertSplClaimCanSettle(fakeConnection(vaultWrong), 5n, HEALTHY),
    ).rejects.toThrow(/vault_token_account .* claim_period\.rs:106/s);
  });

  it('catches the vault token account that is not owned by the vault PDA', async () => {
    // MEASURED: SPL token 0x4 "owner does not match", surfacing as Custom(4),
    // which is not an Anchor code and names no account.
    const accounts = healthyAccounts();
    accounts.set(VAULT_TA.toBase58(), accountInfo(tokenAccountData(MINT, SUBSCRIBER, 5n)));
    await expect(
      assertSplClaimCanSettle(fakeConnection(accounts), 5n, HEALTHY),
    ).rejects.toThrow(/only the vault PDA .* can sign for it/s);
  });

  it('catches a correctly-owned vault token account that is simply empty', async () => {
    // MEASURED: SPL token 0x1 "insufficient funds", never the program's 6030.
    // total_deposited is bookkeeping; nothing ties it to this account.
    await expect(
      assertSplClaimCanSettle(fakeConnection(healthyAccounts(0n)), 5n, HEALTHY),
    ).rejects.toThrow(/holds 0 atomic units but the claim moves 5/);
  });

  it('allows a payout exactly equal to the balance', async () => {
    await expect(
      assertSplClaimCanSettle(fakeConnection(healthyAccounts(5n)), 5n, HEALTHY),
    ).resolves.toBeUndefined();
  });

  it('flags a frozen account and says so is inferred, not measured', async () => {
    const accounts = healthyAccounts();
    accounts.set(RETAILER_ATA.toBase58(), accountInfo(tokenAccountData(MINT, RETAILER, 0n, 2)));
    await expect(
      assertSplClaimCanSettle(fakeConnection(accounts), 5n, HEALTHY),
    ).rejects.toThrow(/frozen .* NOT\s+measured on devnet/s);
  });
});

describe('assertRetailerCanReceiveClaim — SPL vs native', () => {
  it('does NOT apply the 890,880-lamport system rent floor to an SPL claim', async () => {
    // MEASURED: the successful SPL claim had a retailer holding 0 lamports.
    // The native branch would have thrown on exactly these numbers.
    const conn = fakeConnection(healthyAccounts(5n), { [RETAILER.toBase58()]: 0 });
    await expect(
      assertRetailerCanReceiveClaim(conn, RETAILER, 5n, HEALTHY),
    ).resolves.toBeUndefined();
    await expect(assertRetailerCanReceiveClaim(conn, RETAILER, 5n)).rejects.toThrow(
      /strand the retailer below rent exemption/,
    );
  });

  it('still enforces the rent floor when no SPL accounts are given', async () => {
    const conn = fakeConnection(new Map(), { [RETAILER.toBase58()]: 0 });
    await expect(assertRetailerCanReceiveClaim(conn, RETAILER, 300_000n)).rejects.toThrow(
      /insufficient funds for rent/,
    );
    await expect(
      assertRetailerCanReceiveClaim(conn, RETAILER, 1_000_000n),
    ).resolves.toBeUndefined();
  });

  it('exposes the SPL token account rent floor as 2.29x the system one', () => {
    expect(TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS).toBe(2_039_280n);
    expect(Number(TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS) / 890_880).toBeCloseTo(2.289, 3);
  });
});

describe('retailerTokenAccountIsControlledByRetailer', () => {
  it('is false when the payout is routed to someone else, which the program permits', () => {
    // claim_period checks retailer_token.mint only, never its owner.
    const foreign = decodeTokenAccount(tokenAccountData(MINT, SUBSCRIBER_ATA, 0n));
    expect(retailerTokenAccountIsControlledByRetailer(RETAILER, foreign)).toBe(false);
  });

  it('is true for the retailer’s own ATA', () => {
    const own = decodeTokenAccount(tokenAccountData(MINT, RETAILER, 0n));
    expect(retailerTokenAccountIsControlledByRetailer(RETAILER, own)).toBe(true);
  });
});

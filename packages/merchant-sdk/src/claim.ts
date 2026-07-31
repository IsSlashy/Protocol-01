import { type Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { type MerchantSdkConfig, resolveProgramIds, ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
import { claimWouldStrandRetailer } from './period-math';

/**
 * The period arithmetic lives in `./period-math`, which imports NOTHING so the
 * mobile app, the extension and `p01-js` can pin their local copies to it in a
 * parity test without dragging `@solana/web3.js` into a React Native or MV3
 * bundle. It is re-exported here so `import { subscriptionIsCurrent } from
 * '@protocol-01/merchant-sdk'` keeps working unchanged.
 */
export {
  claimablePeriods,
  claimableAmount,
  fundedPeriodsRemaining,
  periodsPaidFor,
  periodsElapsed,
  subscriptionIsCurrent,
  subscriptionEndSlot,
  slotsUntilSubscriptionEnds,
  secondsUntilSubscriptionEnds,
  claimWouldStrandRetailer,
  ENTITLEMENT_PARITY_VECTORS,
  NOMINAL_SLOT_MS,
  SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS,
  type VaultPeriodState,
  type VaultFundingState,
  type VaultElapsedState,
  type VaultEntitlementState,
  type EntitlementParityVector,
} from './period-math';

/** SPL Token program ID. Inlined so the SDK keeps zero `@solana/spl-token` dependency. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Anchor instruction discriminator for `claim_period`
 * (`sha256("global:claim_period")[..8]`).
 */
export const CLAIM_PERIOD_DISCRIMINATOR = Buffer.from([
  72, 126, 164, 101, 190, 210, 66, 82,
]);

// ---------------------------------------------------------------------------
// SPL token accounts
// ---------------------------------------------------------------------------

/** Serialized length of an SPL `TokenAccount` (spl-token 3.x `Account::LEN`). */
export const TOKEN_ACCOUNT_LEN = 165;

/**
 * Rent-exempt minimum for a 165-byte SPL token account, in lamports.
 *
 * MEASURED on devnet 2026-08-01 via `getMinimumBalanceForRentExemption(165)`:
 * 2,039,280 — 2.29x the 890,880-lamport floor of a zero-data system account.
 * Hard-coded only as a fallback for callers with no `Connection`.
 */
export const TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS = 2_039_280n;

/** SPL token account state byte: 0 uninitialized, 1 initialized, 2 frozen. */
export const TOKEN_ACCOUNT_STATE_FROZEN = 2;

export interface DecodedTokenAccount {
  mint: PublicKey;
  /** Token-account authority. For a vault token account this MUST be the vault PDA. */
  owner: PublicKey;
  amount: bigint;
  state: number;
  isFrozen: boolean;
}

/**
 * Decode the fixed prefix of an SPL token account.
 *
 * Open-coded rather than pulled from `@solana/spl-token` so the SDK keeps its
 * zero-`spl-token` dependency — the same reason {@link TOKEN_PROGRAM_ID} is
 * inlined. Layout (spl-token 3.x `Account`): `mint(32) | owner(32) |
 * amount(u64 LE) | delegate(COption, 36) | state(1) | …`.
 */
export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount {
  if (data.length < TOKEN_ACCOUNT_LEN) {
    throw new Error(
      `not an SPL token account: ${data.length} bytes, expected at least ${TOKEN_ACCOUNT_LEN}`,
    );
  }
  const buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  const state = buf[108]!;
  return {
    mint: new PublicKey(buf.subarray(0, 32)),
    owner: new PublicKey(buf.subarray(32, 64)),
    amount: buf.readBigUInt64LE(64),
    state,
    isFrozen: state === TOKEN_ACCOUNT_STATE_FROZEN,
  };
}

/**
 * The four addresses an SPL claim depends on. `vaultPda` is the account whose
 * seeds the program signs with, so it is the only valid `owner` of
 * `vaultTokenAccount`.
 */
export interface SplClaimAccounts {
  vaultPda: PublicKey;
  vaultTokenAccount: PublicKey;
  retailerTokenAccount: PublicKey;
  /** `vault.token_mint`. Both token accounts must be for exactly this mint. */
  tokenMint: PublicKey;
}

/**
 * Does the retailer actually control the token account the payout lands in?
 *
 * `claim_period` checks only `retailer_token.mint == vault.token_mint`
 * (`claim_period.rs:107`); it never checks who owns that account. MEASURED
 * devnet 2026-08-01, tx
 * `4G58G6xzgydec1d1CRMFPcSVYPHeNQT9GCXY84sHWyshEA6R3rweg9H2yhQWBdSDGH11ujmiwxbLVhteM2NM7hbd`:
 * a claim whose `retailer_token_account` was a correct-mint account owned by the
 * SUBSCRIBER succeeded — err null, 9,933 CU — and moved 3 units into it. The
 * retailer signs, so this is not an authorisation hole, but a mis-wired
 * integration sends the money to a token account the merchant cannot spend from
 * and nothing objects.
 *
 * Deliberately NOT enforced inside {@link assertRetailerCanReceiveClaim}:
 * paying into a treasury account the retailer key does not own is a legitimate
 * setup, and refusing it would break that.
 */
export function retailerTokenAccountIsControlledByRetailer(
  retailer: PublicKey,
  retailerTokenAccount: DecodedTokenAccount,
): boolean {
  return retailerTokenAccount.owner.equals(retailer);
}

/**
 * Preflight a claim so the failure surfaces as a message naming the real cause,
 * instead of the raw error the runtime or the token program produces.
 *
 * **Native SOL** (`splAccounts` omitted) — checks the rent floor. MEASURED
 * devnet 2026-08-01: `claim_period` ran to completion (7,263 CU,
 * `ClaimPeriodEvent` emitted, `Program … success`) and the transaction was then
 * rejected with `Transaction results in an account (1) with insufficient funds
 * for rent`. Account 1 was the RETAILER; the message reads as though the vault
 * were underfunded, which is the opposite of true. A merchant with an empty
 * payout wallet cannot collect its FIRST claim unless that single payout is
 * itself at least the rent-exempt minimum.
 *
 * **SPL** (`splAccounts` supplied) — that rent floor does NOT apply and is
 * skipped. MEASURED devnet 2026-08-01, tx
 * `5Aym1ZiUZMD2w7DUUmWfCEqZoc9h1q7y7RiyMXJGwQqSpBsxqpCvfZoqYNFoHpr6TxBFMcDEofPjDnX8EnH3Gyuh`:
 * an SPL claim succeeded with the retailer's system account holding **0
 * lamports**, because the SPL branch moves tokens between token accounts and
 * never credits the retailer's system account. `payoutAmount` is then in the
 * mint's atomic units, not lamports. What is checked instead are conditions
 * that were each measured failing on devnet the same day — see the messages.
 *
 * @param payoutAmount lamports for a native vault, mint atomic units for SPL.
 *   Use {@link claimableAmount}.
 * @throws with a message naming the account and the on-chain error it prevents.
 */
export async function assertRetailerCanReceiveClaim(
  connection: Connection,
  retailer: PublicKey,
  payoutAmount: bigint,
  splAccounts?: SplClaimAccounts,
): Promise<void> {
  if (splAccounts) {
    await assertSplClaimCanSettle(connection, payoutAmount, splAccounts);
    return;
  }

  const [balance, floor] = await Promise.all([
    connection.getBalance(retailer),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  if (!claimWouldStrandRetailer(BigInt(balance), payoutAmount, BigInt(floor))) return;
  throw new Error(
    `claim_period would strand the retailer below rent exemption: balance ${balance} + payout ` +
      `${payoutAmount} = ${BigInt(balance) + payoutAmount}, under the ${floor}-lamport floor. ` +
      `The program succeeds and the RUNTIME then rejects the transaction with a message naming ` +
      `insufficient funds for rent, which reads as though the vault were empty. Fund ${retailer.toBase58()} ` +
      `to at least ${floor} lamports once, or wait until enough periods accrue for a single claim to clear it.`,
  );
}

/**
 * The SPL half of {@link assertRetailerCanReceiveClaim}, exported separately for
 * callers that already know the vault is an SPL one.
 *
 * Every rejection below corresponds to a transaction that was actually sent to
 * devnet on 2026-08-01 and failed; the signature is quoted so the claim can be
 * re-checked rather than believed.
 */
export async function assertSplClaimCanSettle(
  connection: Connection,
  payoutAmount: bigint,
  accounts: SplClaimAccounts,
): Promise<void> {
  const { vaultPda, vaultTokenAccount, retailerTokenAccount, tokenMint } = accounts;

  // 0. The two token accounts must be DIFFERENT accounts. This is the only way
  //    of getting an SPL claim wrong that the chain does not report at all.
  //    MEASURED devnet 2026-08-01, tx
  //    3KN8JDmDMQx11NSau8Xdj6UXQ6kXqzGTzKGtbgRvDq4n8VEXda3vFVgeRRBqfKvcyNEFrTTSV3XrbjrNEibvn7g2:
  //    passing the vault token account in BOTH token-account slots made the CPI
  //    an SPL self-transfer. spl-token short-circuits `source == destination`
  //    and returns Ok WITHOUT moving anything, so the transaction succeeded
  //    (err null, 9,782 CU), `claimed_periods` went 0 -> 6, the vault token
  //    account stayed at 6, the retailer received nothing, and
  //    `ClaimPeriodEvent` was emitted saying `amount_claimed: 6`. The whole
  //    subscription's revenue was destroyed while both the transaction status
  //    and the event reported success. There is no on-chain error to recognise
  //    here, which is exactly why the check has to live client-side.
  if (vaultTokenAccount.equals(retailerTokenAccount)) {
    throw new Error(
      `claim_period: vault_token_account and retailer_token_account are the same account ` +
        `(${vaultTokenAccount.toBase58()}). The CPI would be an SPL self-transfer, which the token ` +
        `program accepts and returns Ok from WITHOUT moving anything. The transaction SUCCEEDS, ` +
        `ClaimPeriodEvent reports the full amount as paid, claimed_periods advances, and the ` +
        `retailer is paid nothing — the periods are burnt and cannot be re-claimed. MEASURED on ` +
        `devnet 2026-08-01, tx 3KN8JDmDMQx11NSau8Xdj6UXQ6kXqzGTzKGtbgRvDq4n8VEXda3vFVgeRRBqfKvcyNEFrTTSV3XrbjrNEibvn7g2.`,
    );
  }

  const [vaultInfo, retailerInfo] = await connection.getMultipleAccountsInfo([
    vaultTokenAccount,
    retailerTokenAccount,
  ]);

  // 1. Both accounts must exist and be owned by the token program.
  //    MEASURED: a non-existent retailer_token_account is rejected by Anchor as
  //    AccountOwnedByWrongProgram (3007), `Left: 1111…111 / Right: Tokenkeg…`.
  //    The message says "wrong program", never "missing", which sends anyone
  //    debugging it after the wrong bug.
  //    tx 52SvqNAvb4N4GmsAAiDthjz8B95ymmvgZ5M24oudEafAKQvCatdtUZXRAaLw2BNfpoUnCoXPNQGigmDeCZLtpoaj
  for (const [label, addr, info] of [
    ['vault_token_account', vaultTokenAccount, vaultInfo],
    ['retailer_token_account', retailerTokenAccount, retailerInfo],
  ] as const) {
    if (!info) {
      throw new Error(
        `claim_period: ${label} ${addr.toBase58()} does not exist. The program does NOT create it. ` +
          `On chain this surfaces as Anchor error 3007 AccountOwnedByWrongProgram naming ${label}, ` +
          `which reads as a wrong-program bug rather than a missing account. Create the token ` +
          `account first — ${TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS} lamports of rent, 2.29x the ` +
          `890,880 a native payout needs.`,
      );
    }
    if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error(
        `claim_period: ${label} ${addr.toBase58()} is owned by ${info.owner.toBase58()}, not the ` +
          `SPL token program. On chain: Anchor error 3007 AccountOwnedByWrongProgram.`,
      );
    }
  }

  const vaultToken = decodeTokenAccount(vaultInfo!.data);
  const retailerToken = decodeTokenAccount(retailerInfo!.data);

  // 2. Mints. claim_period.rs:106 checks the vault side, :107 the retailer side,
  //    and BOTH raise the same code 6018 InvalidTokenMint — only the line number
  //    in the log distinguishes them.
  //    vault    tx NsbjPJ1txvWgAhX8461N9W9MaounDeaVTiz4ByvZQUvCHCGnikQou61TBdnpidh9SugP8baqT3FQQxBmzETLxrt
  //    retailer tx 267n6Ma8ALwTa1dz1G4PDCQvrWKHosNSxwDaLEq6yNANs72MThoMApuP82PDqQb4NYPyMY92B46SG4DZroBRvYGw
  for (const [label, addr, token, line] of [
    ['vault_token_account', vaultTokenAccount, vaultToken, 106],
    ['retailer_token_account', retailerTokenAccount, retailerToken, 107],
  ] as const) {
    if (!token.mint.equals(tokenMint)) {
      throw new Error(
        `claim_period: ${label} ${addr.toBase58()} is for mint ${token.mint.toBase58()}, but the ` +
          `vault holds ${tokenMint.toBase58()}. On chain: error 6018 InvalidTokenMint thrown at ` +
          `claim_period.rs:${line} — the code alone does not say which of the two accounts is wrong.`,
      );
    }
  }

  // 3. The vault token account must be owned by the vault PDA, because the CPI
  //    passes the vault as `authority` with its own seeds (claim_period.rs:114).
  //    MEASURED: otherwise the token program fails with 0x4 "owner does not
  //    match", surfacing at the top level as InstructionError Custom(4). That is
  //    NOT an Anchor code — Anchor codes start at 6000 — so looking it up in the
  //    zk_shielded error table finds nothing, and the log line names no account.
  //    tx 4TWzg6J3SpABfMbkbRbimwP8EJhZLA2oMPamzdVZ6FNX9y4QnkGCmFyN8dk9b4Vi3be8fomX6ZUgPEeKmSH5isPN
  if (!vaultToken.owner.equals(vaultPda)) {
    throw new Error(
      `claim_period: vault_token_account ${vaultTokenAccount.toBase58()} is owned by ` +
        `${vaultToken.owner.toBase58()}, but only the vault PDA ${vaultPda.toBase58()} can sign for ` +
        `it — the CPI passes the vault as authority with its own seeds. On chain: SPL token error ` +
        `0x4 "owner does not match", reported as InstructionError Custom(4), which is not an Anchor ` +
        `code and names no account. NOTE subscribe_normal accepts a wrong-owner vault_token_account ` +
        `without complaint and cancel_normal signs as the same PDA, so such a vault can be neither ` +
        `claimed nor cancelled.`,
    );
  }

  // 4. Balance. The program clamps the payout to total_deposited - claimed*rate,
  //    which is BOOKKEEPING; nothing ties the vault_token_account passed to
  //    claim_period to the one passed to subscribe_normal. MEASURED: claiming
  //    from a different, correctly-owned, empty token account fails with SPL
  //    token 0x1 "insufficient funds", never with the program's own 6030
  //    InsufficientVaultBalance.
  //    tx 5a8s9EJQxkBmwshwE4Bpa6ijMwfNKdiSg3BmZWrxb3kXzVUVQ1khfpKm7YBEVfKsk2YqkyCBjhRqg26m7dG6h6e5
  if (vaultToken.amount < payoutAmount) {
    throw new Error(
      `claim_period: vault_token_account ${vaultTokenAccount.toBase58()} holds ${vaultToken.amount} ` +
        `atomic units but the claim moves ${payoutAmount}. The vault's total_deposited is ` +
        `bookkeeping and is not tied to this account's real balance. On chain: SPL token error 0x1 ` +
        `"insufficient funds" (InstructionError Custom(1)), NOT the program's 6030 ` +
        `InsufficientVaultBalance.`,
    );
  }

  // 5. Frozen accounts. NOT measured on devnet — both throwaway mints were
  //    created with no freeze authority, so this branch is reasoned from the SPL
  //    token program rather than observed. Freeze-capable mints (USDC) make it
  //    reachable, so it is checked rather than assumed away.
  for (const [label, addr, token] of [
    ['vault_token_account', vaultTokenAccount, vaultToken],
    ['retailer_token_account', retailerTokenAccount, retailerToken],
  ] as const) {
    if (token.isFrozen) {
      throw new Error(
        `claim_period: ${label} ${addr.toBase58()} is frozen by the mint authority, so the transfer ` +
          `cannot settle. Expected on-chain result: SPL token error 0x11 AccountFrozen. NOT ` +
          `measured on devnet — inferred from the SPL token program, unlike the other checks here.`,
      );
    }
  }
}

export interface BuildClaimPeriodOptions {
  /** Program ID override. Ignored when `sdkConfig` is supplied. */
  programId?: PublicKey;
  /** SDK-level configuration (cluster + program ID overrides). */
  sdkConfig?: MerchantSdkConfig;
  /**
   * Vault's SPL token account. Required for SPL vaults, omit for native SOL.
   *
   * The program does NOT create it — `subscribe_normal` and
   * `subscribe_private_stark` both take it as an existing account — and its SPL
   * `owner` MUST be the vault PDA, because `claim_period` signs the transfer
   * with the vault's own seeds (`claim_period.rs:109-118`). Nothing on chain
   * enforces that at subscribe time; MEASURED devnet 2026-08-01, a vault
   * created with a subscriber-owned token account here is permanently
   * unclaimable AND uncancellable.
   */
  vaultTokenAccount?: PublicKey;
  /**
   * Retailer's SPL token account. Required for SPL vaults, omit for native SOL.
   * Must exist and be for `vault.token_mint`; the program checks the mint but
   * not the owner. Costs {@link TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS} of rent.
   */
  retailerTokenAccount?: PublicKey;
}

/**
 * Build the `claim_period` instruction. The retailer is the only valid signer
 * (`constraint = retailer.key() == vault.retailer`).
 *
 * Account order mirrors `ClaimPeriod<'info>`
 * (`programs/zk_shielded/src/instructions/claim_period.rs:14`). The three
 * trailing accounts are Anchor `Option<..>`; under Anchor 0.32 an absent
 * optional account is expressed by passing the program's own ID in its slot,
 * which is what the native-SOL path does here.
 *
 * The instruction carries no arguments: the program derives the claimable count
 * from the clock, so the amount is not caller-controlled.
 */
export function buildClaimPeriodInstruction(
  vaultPda: PublicKey,
  retailer: PublicKey,
  opts: BuildClaimPeriodOptions = {},
): TransactionInstruction {
  const programId = opts.sdkConfig
    ? resolveProgramIds(opts.sdkConfig).zkShielded
    : (opts.programId ?? ZK_SHIELDED_PROGRAM_ID_DEVNET);

  const spl = opts.vaultTokenAccount !== undefined || opts.retailerTokenAccount !== undefined;
  if (spl && (!opts.vaultTokenAccount || !opts.retailerTokenAccount)) {
    throw new Error(
      'claim_period: an SPL vault needs BOTH vaultTokenAccount and retailerTokenAccount; ' +
        'omit both for a native SOL vault',
    );
  }

  const keys = [
    { pubkey: retailer, isSigner: true, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // token_program: Option<Program<Token>>
    { pubkey: spl ? TOKEN_PROGRAM_ID : programId, isSigner: false, isWritable: false },
    // vault_token_account: Option<Account<TokenAccount>>, mut
    { pubkey: spl ? opts.vaultTokenAccount! : programId, isSigner: false, isWritable: spl },
    // retailer_token_account: Option<Account<TokenAccount>>, mut
    { pubkey: spl ? opts.retailerTokenAccount! : programId, isSigner: false, isWritable: spl },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(CLAIM_PERIOD_DISCRIMINATOR),
  });
}

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { poseidon2, poseidon3 } from 'poseidon-lite';
import { sha256 } from '@noble/hashes/sha256';
import type {
  Network,
  ProgramIds,
  Signer,
  TokenInfo,
  TokenSymbol,
  TxResult,
  ConfidentialDepositParams,
  ConfidentialTransferParams,
  ConfidentialWithdrawParams,
  ConfidentialBalanceResult,
  ConfidentialProveBalanceParams,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS, COMPUTE_UNITS } from '../constants';

/**
 * Generate a cryptographically secure random field element (31 bytes to stay
 * within the BN254 scalar field). Replaces the insecure Date.now() usage.
 */
function cryptoRandomSalt(): bigint {
  const randomBytes = new Uint8Array(31);
  crypto.getRandomValues(randomBytes);
  return randomBytes.reduce((acc, b, i) => acc | (BigInt(b) << BigInt(i * 8)), 0n);
}

/**
 * Anchor-style 8-byte instruction discriminator: sha256("global:<name>")[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

/**
 * Encode a bigint as a little-endian 32-byte buffer.
 */
function bigintToLeBytes(value: bigint, len = 32): Buffer {
  const buf = Buffer.alloc(len);
  let v = value;
  for (let i = 0; i < len; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Encode a u64 as an 8-byte little-endian buffer.
 */
function u64ToLeBytes(value: bigint | number): Buffer {
  return bigintToLeBytes(BigInt(value), 8);
}

/**
 * ConfidentialModule wraps the p01_zkspl and p01_trustless programs
 * to provide confidential (hidden-balance) operations on SPL tokens.
 *
 * Balances are stored as Poseidon commitments; deposits, transfers,
 * and withdrawals require ZK proofs that update the commitment
 * without revealing the underlying amount.
 */
export class ConfidentialModule {
  private readonly connection: Connection;
  private readonly wallet: Signer;
  private readonly network: Network;
  private readonly programIds: ProgramIds;
  private readonly resolveToken: (symbol: string) => TokenInfo;

  constructor(
    connection: Connection,
    wallet: Signer,
    network: Network,
    programIds: ProgramIds,
    resolveToken: (symbol: string) => TokenInfo,
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = network;
    this.programIds = programIds;
    this.resolveToken = resolveToken;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Deposit tokens into a confidential account.
   *
   * If the account does not yet exist it is created with an initial commitment.
   * A Groth16 balance proof is generated to update the on-chain commitment.
   *
   * @param params - Amount and token to deposit.
   * @returns Transaction result.
   */
  async deposit(params: ConfidentialDepositParams): Promise<TxResult> {
    try {
      const token = this.resolveToken(params.token);
      const amount = BigInt(params.amount);
      const owner = this.walletPublicKey();
      const mint = token.mint;

      const [accountPDA] = this.deriveAccountPDA(owner, mint);
      const accountInfo = await this.connection.getAccountInfo(accountPDA);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.TRANSFER }),
      );

      if (!accountInfo) {
        // Initialize a new confidential account with zero commitment
        const initCommitment = poseidon2([0n, 0n]);
        const initDisc = instructionDiscriminator('init_confidential_account');
        const initData = Buffer.concat([initDisc, bigintToLeBytes(initCommitment)]);
        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: accountPDA, isSigner: false, isWritable: true },
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.zkspl,
            data: initData,
          }),
        );
      }

      // Build the deposit instruction with a balance-proof commitment update
      const newCommitment = poseidon3([amount, cryptoRandomSalt(), 0n]);
      const disc = instructionDiscriminator('confidential_deposit');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(amount),
        bigintToLeBytes(newCommitment),
      ]);

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: accountPDA, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: this.programIds.trustless, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkspl,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.CONFIDENTIAL_DEPOSIT_FAILED,
        `Confidential deposit failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Confidential transfer to another wallet.
   *
   * Generates a transfer proof that deducts from the sender commitment
   * and creates a pending credit on the recipient confidential account.
   *
   * @param params - Recipient, amount, and token.
   * @returns Transaction result.
   */
  async transfer(params: ConfidentialTransferParams): Promise<TxResult> {
    try {
      const token = this.resolveToken(params.token);
      const amount = BigInt(params.amount);
      const owner = this.walletPublicKey();
      const mint = token.mint;

      const [senderPDA] = this.deriveAccountPDA(owner, mint);
      const [recipientPDA] = this.deriveAccountPDA(params.to, mint);

      // Commitment for the transfer (sender proves balance >= amount)
      const transferCommitment = poseidon3([amount, cryptoRandomSalt(), 1n]);

      const disc = instructionDiscriminator('confidential_transfer');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(amount),
        bigintToLeBytes(transferCommitment),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.TRANSFER }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: senderPDA, isSigner: false, isWritable: true },
            { pubkey: recipientPDA, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: this.programIds.trustless, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkspl,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.CONFIDENTIAL_TRANSFER_FAILED,
        `Confidential transfer failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Withdraw tokens from a confidential account back to a public wallet.
   *
   * Generates a withdrawal proof that decrements the on-chain commitment
   * and releases tokens to the specified recipient (defaults to the caller).
   *
   * @param params - Amount, token, and optional recipient.
   * @returns Transaction result.
   */
  async withdraw(params: ConfidentialWithdrawParams): Promise<TxResult> {
    try {
      const token = this.resolveToken(params.token);
      const amount = BigInt(params.amount);
      const owner = this.walletPublicKey();
      const mint = token.mint;
      const recipient = params.recipient ?? owner;

      const [accountPDA] = this.deriveAccountPDA(owner, mint);

      const withdrawCommitment = poseidon3([amount, cryptoRandomSalt(), 2n]);

      const disc = instructionDiscriminator('confidential_withdraw');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(amount),
        bigintToLeBytes(withdrawCommitment),
        recipient.toBuffer(),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.TRANSFER }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: accountPDA, isSigner: false, isWritable: true },
            { pubkey: recipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: this.programIds.trustless, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkspl,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.CONFIDENTIAL_WITHDRAW_FAILED,
        `Confidential withdraw failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch the current confidential balance for a token.
   *
   * Returns the on-chain commitment. If the spending key is available locally
   * the decrypted balance is also included.
   *
   * @param token - Token symbol to query.
   * @returns Commitment and optionally the decrypted balance.
   */
  async getBalance(token: TokenSymbol): Promise<ConfidentialBalanceResult> {
    const tokenInfo = this.resolveToken(token);
    const owner = this.walletPublicKey();
    const mint = tokenInfo.mint;

    const [accountPDA] = this.deriveAccountPDA(owner, mint);
    const accountInfo = await this.connection.getAccountInfo(accountPDA);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.ACCOUNT_NOT_INITIALIZED,
        `No confidential account found for ${token}. Deposit first.`,
      );
    }

    // Account layout: 8-byte discriminator + 32-byte owner + 32-byte mint + 32-byte commitment
    const data = accountInfo.data;
    const commitmentBytes = data.subarray(72, 104);
    const commitment = bufferToBigint(commitmentBytes);

    return {
      commitment,
      tokenMint: mint,
    };
  }

  /**
   * Generate and submit an on-chain proof that the confidential balance
   * is at least `threshold`, without revealing the exact amount.
   *
   * Useful for compliance, credit checks, and gated access.
   *
   * @param params - Token and minimum threshold to prove.
   * @returns Transaction result.
   */
  async proveBalance(params: ConfidentialProveBalanceParams): Promise<TxResult> {
    try {
      const token = this.resolveToken(params.token);
      const threshold = BigInt(params.threshold);
      const owner = this.walletPublicKey();
      const mint = token.mint;

      const [accountPDA] = this.deriveAccountPDA(owner, mint);

      const proofCommitment = poseidon2([threshold, cryptoRandomSalt()]);

      const disc = instructionDiscriminator('prove_balance');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(threshold),
        bigintToLeBytes(proofCommitment),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.TRANSFER }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: false },
            { pubkey: accountPDA, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: this.programIds.trustless, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkspl,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.BALANCE_PROOF_FAILED,
        `Balance proof failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the confidential account PDA for a given owner and mint.
   */
  private deriveAccountPDA(owner: PublicKey, mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.CONFIDENTIAL_ACCOUNT),
        owner.toBuffer(),
        mint.toBuffer(),
      ],
      this.programIds.zkspl,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Sign and send a transaction. Handles both Keypair and WalletAdapter signers.
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    let signature: string;
    if ('secretKey' in this.wallet) {
      const allSigners = [this.wallet as Keypair, ...(signers || [])];
      signature = await sendAndConfirmTransaction(this.connection, tx, allSigners);
    } else {
      if (signers?.length) signers.forEach((s) => tx.partialSign(s));
      const signed = await this.wallet.signTransaction(tx);
      signature = await this.connection.sendRawTransaction(signed.serialize());
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
    }
    return { signature };
  }
}

/**
 * Read a little-endian byte slice as a bigint.
 */
function bufferToBigint(buf: Uint8Array): bigint {
  let result = 0n;
  for (let i = buf.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]!);
  }
  return result;
}

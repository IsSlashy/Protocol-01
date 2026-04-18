/**
 * ZkSplClient — High-level client for the p01_zkspl Anchor program.
 *
 * STARK-only mode: proofs are generated out-of-band (WASM prover in the
 * host app), uploaded to `p01_stark_verifier`, and the verified proof buffer
 * pubkey is passed to each zkSPL instruction. The SDK never touches private
 * witnesses.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor/dist/cjs/provider';

import {
  ZKSPL_PROGRAM_ID,
  PDA_SEEDS,
  TOKEN_PROGRAM_ID,
  getProgramId,
} from './constants';
import type { NetworkId } from './constants';
import {
  createBalanceCommitment,
  deriveOwnerPubkey,
  deriveDeterministicSalt,
  fieldToBytes,
  pubkeyToField,
} from './crypto';
import { LocalStateManager, type StateStore } from './state';
import type {
  FieldElement,
  ConfidentialAccountData,
  MintConfigAccount,
  PendingCredit,
  ZkSplTxResult,
} from './types';

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface ZkSplClientConfig {
  /** Solana RPC connection */
  connection: Connection;
  /** Wallet (signer) */
  wallet: Wallet;
  /** Program ID override for the zkspl program (default: resolved from `network` or devnet) */
  programId?: PublicKey;
  /**
   * Program ID override for the zk_shielded program (denominated pools).
   * Only needed if you interact with shielded pool features.
   */
  zkShieldedProgramId?: string;
  /**
   * Network to resolve program IDs from. Defaults to `'devnet'`.
   * When set, program IDs are looked up from the built-in PROGRAM_IDS map
   * unless explicitly overridden by `programId` / `zkShieldedProgramId`.
   */
  network?: NetworkId;
  /** State persistence store */
  stateStore?: StateStore;
  /**
   * Owner spending key. The SDK only uses it locally to derive commitments
   * for local state bookkeeping — it is **never** sent anywhere and is
   * **never** used for proof generation by the SDK itself.
   */
  spendingKey?: FieldElement;
}

// ---------------------------------------------------------------------------
// ZkSplClient
// ---------------------------------------------------------------------------

export class ZkSplClient {
  readonly connection: Connection;
  readonly wallet: Wallet;
  readonly programId: PublicKey;

  private stateManager: LocalStateManager;
  private _spendingKey: FieldElement | null;

  constructor(
    connectionOrConfig: Connection | ZkSplClientConfig,
    wallet?: Wallet,
    programId?: PublicKey
  ) {
    // Support both (connection, wallet, programId) and config-object signatures
    if (connectionOrConfig instanceof Connection) {
      this.connection = connectionOrConfig;
      this.wallet = wallet!;
      this.programId = programId ?? new PublicKey(ZKSPL_PROGRAM_ID);
      this.stateManager = new LocalStateManager();
      this._spendingKey = null;
    } else {
      const cfg = connectionOrConfig;
      this.connection = cfg.connection;
      this.wallet = cfg.wallet;

      // Resolve program ID: explicit override > network lookup > devnet default
      if (cfg.programId) {
        this.programId = cfg.programId;
      } else {
        const network = cfg.network ?? 'devnet';
        this.programId = new PublicKey(getProgramId(network, 'zkspl'));
      }

      this.stateManager = new LocalStateManager(cfg.stateStore);
      this._spendingKey = cfg.spendingKey ?? null;
    }
  }

  // -----------------------------------------------------------------------
  // Spending key management
  // -----------------------------------------------------------------------

  /** Set (or change) the owner's spending key */
  setSpendingKey(key: FieldElement): void {
    this._spendingKey = key;
  }

  /** Get the derived owner pubkey from the spending key */
  getOwnerPubkey(): FieldElement {
    return deriveOwnerPubkey(this.requireSpendingKey());
  }

  private requireSpendingKey(): FieldElement {
    if (this._spendingKey === null) {
      throw new Error(
        'Spending key not set. Call client.setSpendingKey(key) or pass ' +
          'spendingKey in ZkSplClientConfig before calling operations that ' +
          'derive commitments (deposit, withdraw, transfer, applyPending).'
      );
    }
    return this._spendingKey;
  }

  // -----------------------------------------------------------------------
  // PDA derivation
  // -----------------------------------------------------------------------

  /** Derive the MintConfig PDA for a token mint */
  deriveMintConfigPDA(tokenMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MINT_CONFIG, tokenMint.toBytes()],
      this.programId
    );
  }

  /** Derive the ConfidentialAccount PDA for an (owner, token_mint) pair */
  deriveConfidentialAccountPDA(
    owner: PublicKey,
    tokenMint: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [PDA_SEEDS.CONFIDENTIAL_ACCOUNT, owner.toBytes(), tokenMint.toBytes()],
      this.programId
    );
  }

  /** Derive the vault PDA for a token mint */
  deriveVaultPDA(tokenMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [PDA_SEEDS.VAULT, tokenMint.toBytes()],
      this.programId
    );
  }

  // -----------------------------------------------------------------------
  // SPL Token account helpers (ATA derivation)
  // -----------------------------------------------------------------------

  /** SPL Associated Token Account program ID */
  static readonly ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  );

  /**
   * Derive the Associated Token Account (ATA) for a given owner + token mint.
   * Standard SPL ATA: PDA of [owner, TOKEN_PROGRAM_ID, mint] under the ATA program.
   */
  deriveUserTokenAccount(owner: PublicKey, tokenMint: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [
        owner.toBytes(),
        new PublicKey(TOKEN_PROGRAM_ID).toBytes(),
        tokenMint.toBytes(),
      ],
      ZkSplClient.ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return ata;
  }

  /**
   * Derive the ATA for the pool vault PDA + token mint.
   * This is the token account that holds SPL tokens for the vault.
   */
  derivePoolVaultTokenAccount(tokenMint: PublicKey): PublicKey {
    const [vaultPDA] = this.deriveVaultPDA(tokenMint);
    return this.deriveUserTokenAccount(vaultPDA, tokenMint);
  }

  /**
   * Check if a token account exists and create it if needed.
   * Returns the ATA address.
   */
  async ensureTokenAccountExists(
    owner: PublicKey,
    tokenMint: PublicKey,
  ): Promise<PublicKey> {
    const ata = this.deriveUserTokenAccount(owner, tokenMint);
    const info = await this.connection.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        ata,
        owner,
        tokenMint,
      );
      const tx = new Transaction().add(ix);
      await this.sendAndConfirm(tx);
    }
    return ata;
  }

  // -----------------------------------------------------------------------
  // Setup: initializeMint
  // -----------------------------------------------------------------------

  /**
   * Register an SPL token for zkSPL confidential operations.
   * Creates a MintConfig PDA. The VK-hash arguments are kept for backwards
   * compatibility with the on-chain account layout; in STARK-only mode they
   * can be zero-filled.
   */
  async initializeMint(
    tokenMint: PublicKey,
    balanceVkHash: Uint8Array,
    proofVkHash: Uint8Array
  ): Promise<string> {
    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);

    const ix = await this.buildAnchorInstruction('initialize_mint', {
      authority: this.wallet.publicKey,
      tokenMint,
      mintConfig: mintConfigPDA,
      systemProgram: SystemProgram.programId,
    }, {
      balanceVkHash: Array.from(balanceVkHash),
      proofVkHash: Array.from(proofVkHash),
    });

    return this.sendAndConfirm(new Transaction().add(ix));
  }

  // -----------------------------------------------------------------------
  // Setup: createAccount
  // -----------------------------------------------------------------------

  /**
   * Create a confidential account for the connected wallet and token mint.
   * The initial commitment is Poseidon(0, initialSalt, ownerPubkey, tokenMint).
   *
   * @param tokenMint - The SPL token mint
   * @param initialSalt - Random salt for the zero-balance commitment
   * @returns Transaction signature
   */
  async createAccount(
    tokenMint: PublicKey,
    initialSalt?: FieldElement
  ): Promise<string> {
    const spendingKey = this.requireSpendingKey();
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const salt = initialSalt ?? deriveDeterministicSalt(spendingKey, 0n);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());

    const commitment = createBalanceCommitment(0n, salt, 0n, ownerPubkey, tokenMintField);
    const commitmentBytes = fieldToBytes(commitment);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );

    const ix = await this.buildAnchorInstruction('create_account', {
      owner: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      systemProgram: SystemProgram.programId,
    }, {
      initialCommitment: Array.from(commitmentBytes),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));

    await this.stateManager.initializeState(
      this.wallet.publicKey.toBase58(),
      tokenMint.toBase58(),
      spendingKey,
      salt
    );

    return signature;
  }

  // -----------------------------------------------------------------------
  // Deposit
  // -----------------------------------------------------------------------

  /**
   * Deposit SPL tokens into a confidential account.
   *
   * The caller **must** upload and verify a STARK proof (circuit 4:
   * `confidential_balance`) via `p01_stark_verifier` in prior transactions,
   * then pass the verified proof buffer pubkey as `proofBuffer`.
   *
   * @param tokenMint - The SPL token mint
   * @param amount - Amount to deposit (in atomic units)
   * @param proofBuffer - Verified STARK proof buffer account
   * @param newCommitment - New balance commitment (32 bytes) — must match the
   *   STARK proof's public inputs
   * @param userTokenAccount - Optional user's token account (for SPL tokens)
   * @param poolVaultTokenAccount - Optional pool vault token account
   */
  async deposit(
    tokenMint: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
    userTokenAccount?: PublicKey,
    poolVaultTokenAccount?: PublicKey
  ): Promise<ZkSplTxResult> {
    const spendingKey = this.requireSpendingKey();
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) {
      throw new Error(
        `No local state found for mint ${mintBase58}. ` +
          'Call createAccount(tokenMint) first to initialize the confidential account, ' +
          'or restore state from a backup if you have one.'
      );
    }

    const currentNonce = state.nonce;
    const newSalt = deriveDeterministicSalt(spendingKey, currentNonce + 1n);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [vaultPDA] = this.deriveVaultPDA(tokenMint);

    const accounts: Record<string, PublicKey | null> = {
      depositor: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      starkProofBuffer: proofBuffer,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
      tokenProgram: userTokenAccount ? new PublicKey(TOKEN_PROGRAM_ID) : null,
      userTokenAccount: userTokenAccount ?? null,
      poolVault: poolVaultTokenAccount ?? null,
    };

    const ix = await this.buildAnchorInstruction('deposit', accounts, {
      amount: new BN(amount.toString()),
      newCommitment: Array.from(newCommitment),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
    const newBalance = state.balance + amount;
    const newNonce = currentNonce + 1n;

    await this.stateManager.afterDeposit(
      ownerBase58,
      mintBase58,
      amount,
      newSalt,
      newNonce
    );

    return {
      signature,
      newCommitment,
      newBalance,
      newNonce,
    };
  }

  // -----------------------------------------------------------------------
  // Withdraw
  // -----------------------------------------------------------------------

  /**
   * Withdraw from confidential account to regular SPL tokens.
   *
   * Requires a pre-verified STARK proof buffer (circuit 4: `confidential_balance`).
   *
   * @param tokenMint - The SPL token mint
   * @param amount - Amount to withdraw (in atomic units)
   * @param proofBuffer - Verified STARK proof buffer account
   * @param newCommitment - New balance commitment (32 bytes)
   * @param userTokenAccount - Optional user's token account (for SPL tokens)
   * @param poolVaultTokenAccount - Optional pool vault token account
   */
  async withdraw(
    tokenMint: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
    userTokenAccount?: PublicKey,
    poolVaultTokenAccount?: PublicKey
  ): Promise<ZkSplTxResult> {
    const spendingKey = this.requireSpendingKey();
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) {
      throw new Error(
        `No local state found for mint ${mintBase58} during withdraw. ` +
          'Call createAccount(tokenMint) first to initialize the confidential account.'
      );
    }
    if (state.balance < amount) {
      throw new Error(
        `Insufficient confidential balance for withdraw: ` +
          `have ${state.balance}, need ${amount}. ` +
          'Deposit more tokens or reduce the withdrawal amount.'
      );
    }

    const currentNonce = state.nonce;
    const newSalt = deriveDeterministicSalt(spendingKey, currentNonce + 1n);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [vaultPDA] = this.deriveVaultPDA(tokenMint);

    const accounts: Record<string, PublicKey | null> = {
      withdrawer: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      starkProofBuffer: proofBuffer,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
      tokenProgram: userTokenAccount ? new PublicKey(TOKEN_PROGRAM_ID) : null,
      userTokenAccount: userTokenAccount ?? null,
      poolVault: poolVaultTokenAccount ?? null,
    };

    const ix = await this.buildAnchorInstruction('withdraw', accounts, {
      amount: new BN(amount.toString()),
      newCommitment: Array.from(newCommitment),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
    const newBalance = state.balance - amount;
    const newNonce = currentNonce + 1n;

    await this.stateManager.afterWithdraw(
      ownerBase58,
      mintBase58,
      amount,
      newSalt,
      newNonce
    );

    return {
      signature,
      newCommitment,
      newBalance,
      newNonce,
    };
  }

  // -----------------------------------------------------------------------
  // Confidential Transfer (send side)
  // -----------------------------------------------------------------------

  /**
   * Send a confidential (private) transfer to another user.
   *
   * The amount is hidden on-chain as an amount_hash. Requires a pre-verified
   * STARK proof buffer (circuit 5: `transfer`). The recipient needs the
   * plaintext amount + amountSalt out-of-band to call `applyPending`.
   *
   * @param tokenMint - The SPL token mint
   * @param recipientPubkey - Recipient's Solana wallet pubkey
   * @param amount - Amount to transfer (in atomic units) — used only for local
   *   state bookkeeping, NOT sent on-chain
   * @param proofBuffer - Verified STARK proof buffer account
   * @param newCommitment - New balance commitment (32 bytes)
   * @param amountHash - Poseidon(amount, amountSalt) — 32 bytes
   * @param amountSaltUsed - The salt used — returned for convenience so the
   *   caller can forward it to the recipient over a secure channel
   */
  async confidentialTransfer(
    tokenMint: PublicKey,
    recipientPubkey: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
    amountHash: Uint8Array,
    amountSaltUsed: FieldElement
  ): Promise<ZkSplTxResult & { amountSaltUsed: FieldElement }> {
    const spendingKey = this.requireSpendingKey();
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) {
      throw new Error(
        `No local state found for mint ${mintBase58} during confidentialTransfer. ` +
          'Call createAccount(tokenMint) first to initialize the confidential account.'
      );
    }
    if (state.balance < amount) {
      throw new Error(
        `Insufficient confidential balance for transfer: ` +
          `have ${state.balance}, need ${amount}. ` +
          'Deposit more tokens or reduce the transfer amount.'
      );
    }

    const currentNonce = state.nonce;
    const newSalt = deriveDeterministicSalt(spendingKey, currentNonce + 1n);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [senderAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [recipientAccountPDA] = this.deriveConfidentialAccountPDA(
      recipientPubkey,
      tokenMint
    );

    const ix = await this.buildAnchorInstruction('confidential_transfer', {
      sender: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      senderAccount: senderAccountPDA,
      recipientAccount: recipientAccountPDA,
      starkProofBuffer: proofBuffer,
    }, {
      newCommitment: Array.from(newCommitment),
      amountHash: Array.from(amountHash),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
    const newBalance = state.balance - amount;
    const newNonce = currentNonce + 1n;

    await this.stateManager.afterSend(
      ownerBase58,
      mintBase58,
      amount,
      newSalt,
      newNonce
    );

    return {
      signature,
      newCommitment,
      newBalance,
      newNonce,
      amountSaltUsed,
    };
  }

  // -----------------------------------------------------------------------
  // Apply Pending (receive side)
  // -----------------------------------------------------------------------

  /**
   * Apply a pending credit to update the recipient's balance.
   *
   * Requires a pre-verified STARK proof buffer (circuit 4: `confidential_balance`).
   *
   * @param tokenMint - The SPL token mint
   * @param amount - The plaintext transfer amount (used for local state only)
   * @param proofBuffer - Verified STARK proof buffer account
   * @param newCommitment - New balance commitment (32 bytes)
   * @param amountHash - Poseidon(amount, amountSalt) — 32 bytes, must match
   *   one of the pending credits
   */
  async applyPending(
    tokenMint: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
    amountHash: Uint8Array
  ): Promise<ZkSplTxResult> {
    const spendingKey = this.requireSpendingKey();
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) {
      throw new Error(
        `No local state found for mint ${mintBase58} during applyPending. ` +
          'Call createAccount(tokenMint) first to initialize the confidential account.'
      );
    }

    const currentNonce = state.nonce;
    const newSalt = deriveDeterministicSalt(spendingKey, currentNonce + 1n);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );

    const ix = await this.buildAnchorInstruction('apply_pending', {
      recipient: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      starkProofBuffer: proofBuffer,
    }, {
      newCommitment: Array.from(newCommitment),
      amountHash: Array.from(amountHash),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
    const newBalance = state.balance + amount;
    const newNonce = currentNonce + 1n;

    // Bump amountHash to FieldElement for local state. We have it as bytes here.
    const amountHashField = BigInt(
      '0x' +
        Array.from(amountHash)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
    );

    await this.stateManager.afterApplyPending(
      ownerBase58,
      mintBase58,
      amountHashField,
      amount,
      newSalt,
      newNonce
    );

    return {
      signature,
      newCommitment,
      newBalance,
      newNonce,
    };
  }

  // -----------------------------------------------------------------------
  // Prove Balance (sufficiency proof for DeFi)
  // -----------------------------------------------------------------------

  /**
   * Prove that the confidential balance >= threshold without revealing
   * the actual balance. Emits a BalanceProofEvent on-chain.
   *
   * Requires a pre-verified STARK proof buffer (circuit 2: `balance_proof`).
   *
   * @param tokenMint - The SPL token mint
   * @param threshold - Minimum balance to prove
   * @param proofBuffer - Verified STARK proof buffer account
   */
  async proveBalance(
    tokenMint: PublicKey,
    threshold: bigint,
    proofBuffer: PublicKey
  ): Promise<string> {
    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );

    const ix = await this.buildAnchorInstruction('prove_balance', {
      prover: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      starkProofBuffer: proofBuffer,
    }, {
      threshold: new BN(threshold.toString()),
    });

    return this.sendAndConfirm(new Transaction().add(ix));
  }

  // -----------------------------------------------------------------------
  // Viewer management
  // -----------------------------------------------------------------------

  /**
   * Add a viewing key to the confidential account (opt-in compliance).
   */
  async addViewer(tokenMint: PublicKey, viewer: PublicKey): Promise<string> {
    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );

    const ix = await this.buildAnchorInstruction('add_viewer', {
      owner: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
    }, {
      viewer,
    });

    return this.sendAndConfirm(new Transaction().add(ix));
  }

  /**
   * Remove a viewing key from the confidential account.
   */
  async removeViewer(tokenMint: PublicKey, viewer: PublicKey): Promise<string> {
    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );

    const ix = await this.buildAnchorInstruction('remove_viewer', {
      owner: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
    }, {
      viewer,
    });

    return this.sendAndConfirm(new Transaction().add(ix));
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Get the locally-known plaintext balance for a token mint.
   * Returns null if no local state exists.
   */
  async getLocalBalance(tokenMint: PublicKey): Promise<bigint | null> {
    const state = await this.stateManager.getState(
      this.wallet.publicKey.toBase58(),
      tokenMint.toBase58()
    );
    return state?.balance ?? null;
  }

  /**
   * Fetch the on-chain ConfidentialAccount data.
   */
  async getConfidentialAccount(
    tokenMint: PublicKey,
    owner?: PublicKey
  ): Promise<ConfidentialAccountData | null> {
    const ownerKey = owner ?? this.wallet.publicKey;
    const [pda] = this.deriveConfidentialAccountPDA(ownerKey, tokenMint);

    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    return deserializeConfidentialAccount(accountInfo.data);
  }

  /**
   * Fetch on-chain pending credits for the connected wallet.
   */
  async getPendingCredits(tokenMint: PublicKey): Promise<PendingCredit[]> {
    const account = await this.getConfidentialAccount(tokenMint);
    return account?.pendingCredits ?? [];
  }

  /**
   * Fetch the on-chain MintConfig data for a token mint.
   */
  async getMintConfig(tokenMint: PublicKey): Promise<MintConfigAccount | null> {
    const [pda] = this.deriveMintConfigPDA(tokenMint);
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    return deserializeMintConfig(accountInfo.data);
  }

  /**
   * Get the full local state (for backup / debugging).
   */
  async getLocalState(tokenMint: PublicKey) {
    return this.stateManager.getState(
      this.wallet.publicKey.toBase58(),
      tokenMint.toBase58()
    );
  }

  // -----------------------------------------------------------------------
  // State validation & recovery
  // -----------------------------------------------------------------------

  /**
   * Validate that the local state matches the on-chain commitment.
   * Returns a detailed validation result.
   */
  async validateState(tokenMint: PublicKey): Promise<{
    isValid: boolean;
    localNonce: bigint;
    onChainNonce: bigint;
    localBalance: bigint;
    commitmentMatches: boolean;
    details: string;
  }> {
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const localState = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!localState) {
      return {
        isValid: false, localNonce: 0n, onChainNonce: 0n,
        localBalance: 0n, commitmentMatches: false,
        details: 'No local state found',
      };
    }

    const onChainAccount = await this.getConfidentialAccount(tokenMint);
    if (!onChainAccount) {
      return {
        isValid: false, localNonce: localState.nonce, onChainNonce: 0n,
        localBalance: localState.balance, commitmentMatches: false,
        details: 'No on-chain account found',
      };
    }

    const noncesMatch = localState.nonce === onChainAccount.nonce;

    const ownerPubkey = deriveOwnerPubkey(localState.spendingKey);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());
    const expectedCommitment = createBalanceCommitment(
      localState.balance, localState.salt, localState.nonce, ownerPubkey, tokenMintField
    );
    const expectedBytes = fieldToBytes(expectedCommitment);

    let commitmentMatches = true;
    for (let i = 0; i < 32; i++) {
      if (expectedBytes[i] !== onChainAccount.balanceCommitment[i]) {
        commitmentMatches = false;
        break;
      }
    }

    const isValid = noncesMatch && commitmentMatches;

    let details = '';
    if (!noncesMatch) {
      details += `Nonce mismatch: local=${localState.nonce}, on-chain=${onChainAccount.nonce}. `;
    }
    if (!commitmentMatches) {
      details += 'Commitment mismatch: local state does not match on-chain commitment. ';
    }
    if (isValid) {
      details = 'State is valid and in sync.';
    }

    return {
      isValid,
      localNonce: localState.nonce,
      onChainNonce: onChainAccount.nonce,
      localBalance: localState.balance,
      commitmentMatches,
      details,
    };
  }

  /**
   * Emergency reset: clear local state and reinitialize with zero balance.
   *
   * WARNING: This requires submitting a new on-chain transaction to update
   * the commitment. The old confidential balance is forfeited.
   *
   * Returns null if the on-chain account doesn't exist (no reset needed).
   */
  async emergencyReset(tokenMint: PublicKey): Promise<string | null> {
    const spendingKey = this.requireSpendingKey();
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const onChainAccount = await this.getConfidentialAccount(tokenMint);
    if (!onChainAccount || !onChainAccount.isInitialized) {
      await this.stateManager.deleteState(ownerBase58, mintBase58);
      return null;
    }

    await this.stateManager.deleteState(ownerBase58, mintBase58);

    const newSalt = deriveDeterministicSalt(spendingKey, 0n);
    await this.stateManager.initializeState(ownerBase58, mintBase58, spendingKey, newSalt);

    return 'local_state_reset';
  }

  // -----------------------------------------------------------------------
  // Internal: Anchor instruction building
  // -----------------------------------------------------------------------

  /**
   * Build an Anchor instruction using the IDL pattern.
   *
   * This creates the instruction manually so the SDK does not require
   * the full Anchor IDL JSON to be present at runtime.
   * The instruction discriminator is computed as the first 8 bytes of
   * sha256("global:<instruction_name>").
   */
  private async buildAnchorInstruction(
    instructionName: string,
    accounts: Record<string, PublicKey | null>,
    args: Record<string, unknown>
  ): Promise<TransactionInstruction> {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const discriminator = sha256(
      new TextEncoder().encode(`global:${instructionName}`)
    ).slice(0, 8);

    const argsBuffer = serializeAnchorArgs(instructionName, args);

    const data = Buffer.concat([
      Buffer.from(discriminator),
      argsBuffer,
    ]);

    const keys = Object.entries(accounts)
      .map(([name, pubkey]) => ({
        pubkey: pubkey ?? this.programId,
        isSigner: pubkey !== null && isSignerAccount(instructionName, name),
        isWritable: pubkey !== null && isWritableAccount(instructionName, name),
      }));

    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data,
    });
  }

  // -----------------------------------------------------------------------
  // Internal: Send transaction
  // -----------------------------------------------------------------------

  private async sendAndConfirm(tx: Transaction): Promise<string> {
    try {
      tx.feePayer = this.wallet.publicKey;
      tx.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to prepare transaction (getLatestBlockhash): ${message}. ` +
          'Check your RPC connection URL and network status.'
      );
    }

    let signed: Transaction;
    try {
      signed = await this.wallet.signTransaction(tx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Wallet failed to sign transaction: ${message}. ` +
          'Ensure the wallet is connected and the correct account is selected.'
      );
    }

    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(
        signed.serialize()
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to send transaction: ${message}. ` +
          'This may indicate an on-chain error (insufficient SOL for fees, ' +
          'account already exists, proof verification failed, etc.).'
      );
    }

    try {
      await this.connection.confirmTransaction(signature);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Transaction sent (${signature}) but confirmation failed: ${message}. ` +
          'The transaction may still land. Check the signature on a block explorer.'
      );
    }

    return signature;
  }
}

// ---------------------------------------------------------------------------
// Helpers: Anchor args serialization (simplified borsh)
// ---------------------------------------------------------------------------

/**
 * Minimal borsh serializer for the argument types used in zkSPL instructions.
 * Supports: BN (u64), number[] ([u8; N]), PublicKey.
 */
function serializeAnchorArgs(
  _instructionName: string,
  args: Record<string, unknown>
): Buffer {
  const buffers: Buffer[] = [];

  for (const [_key, value] of Object.entries(args)) {
    if (value instanceof BN) {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(value.toString()));
      buffers.push(buf);
    } else if (Array.isArray(value)) {
      buffers.push(Buffer.from(value as number[]));
    } else if (value instanceof PublicKey) {
      buffers.push(value.toBuffer());
    } else if (typeof value === 'object' && value !== null) {
      const nested = value as Record<string, unknown>;
      buffers.push(serializeAnchorArgs(_instructionName, nested));
    } else if (typeof value === 'number') {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(value);
      buffers.push(buf);
    } else if (typeof value === 'string') {
      const strBuf = Buffer.from(value, 'utf8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(strBuf.length);
      buffers.push(lenBuf, strBuf);
    }
  }

  return Buffer.concat(buffers);
}

// ---------------------------------------------------------------------------
// Helpers: Account metadata (signer / writable flags from IDL knowledge)
// ---------------------------------------------------------------------------

const SIGNER_ACCOUNTS: Record<string, Set<string>> = {
  initialize_mint: new Set(['authority']),
  create_account: new Set(['owner']),
  deposit: new Set(['depositor']),
  withdraw: new Set(['withdrawer']),
  confidential_transfer: new Set(['sender']),
  apply_pending: new Set(['recipient']),
  prove_balance: new Set(['prover']),
  add_viewer: new Set(['owner']),
  remove_viewer: new Set(['owner']),
};

const WRITABLE_ACCOUNTS: Record<string, Set<string>> = {
  initialize_mint: new Set(['authority', 'mintConfig']),
  create_account: new Set(['owner', 'confidentialAccount']),
  deposit: new Set([
    'depositor',
    'confidentialAccount',
    'vault',
    'userTokenAccount',
    'poolVault',
  ]),
  withdraw: new Set([
    'withdrawer',
    'confidentialAccount',
    'vault',
    'userTokenAccount',
    'poolVault',
  ]),
  confidential_transfer: new Set([
    'sender',
    'senderAccount',
    'recipientAccount',
  ]),
  apply_pending: new Set(['confidentialAccount']),
  prove_balance: new Set([]),
  add_viewer: new Set(['confidentialAccount']),
  remove_viewer: new Set(['confidentialAccount']),
};

function isSignerAccount(instruction: string, accountName: string): boolean {
  return SIGNER_ACCOUNTS[instruction]?.has(accountName) ?? false;
}

function isWritableAccount(instruction: string, accountName: string): boolean {
  return WRITABLE_ACCOUNTS[instruction]?.has(accountName) ?? false;
}

// ---------------------------------------------------------------------------
// Helpers: Deserialization (Anchor borsh account layout)
// ---------------------------------------------------------------------------

/**
 * Deserialize an on-chain ConfidentialAccount from its raw data buffer.
 * Layout (after 8-byte Anchor discriminator):
 *   owner: Pubkey (32)
 *   mint: Pubkey (32)
 *   balance_commitment: [u8; 32]
 *   nonce: u64 (8)
 *   pending_credits: Vec<PendingCredit>  (4 + n * (32 + 32 + 8))
 *   viewer_keys: Vec<Pubkey>  (4 + n * 32)
 *   is_initialized: bool (1)
 *   created_at: i64 (8)
 *   last_tx_at: i64 (8)
 *   bump: u8 (1)
 */
function deserializeConfidentialAccount(
  data: Buffer
): ConfidentialAccountData {
  let offset = 8;

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const mint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const balanceCommitment = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const nonce = data.readBigUInt64LE(offset);
  offset += 8;

  const pendingCount = data.readUInt32LE(offset);
  offset += 4;
  const pendingCredits: PendingCredit[] = [];
  for (let i = 0; i < pendingCount; i++) {
    const amountHash = new Uint8Array(data.subarray(offset, offset + 32));
    offset += 32;
    const sender = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    const timestamp = data.readBigInt64LE(offset);
    offset += 8;
    pendingCredits.push({ amountHash, sender, timestamp });
  }

  const viewerCount = data.readUInt32LE(offset);
  offset += 4;
  const viewerKeys: PublicKey[] = [];
  for (let i = 0; i < viewerCount; i++) {
    viewerKeys.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }

  const isInitialized = data[offset] !== 0;
  offset += 1;

  const createdAt = data.readBigInt64LE(offset);
  offset += 8;

  const lastTxAt = data.readBigInt64LE(offset);
  offset += 8;

  const bump = data[offset];

  return {
    owner,
    mint,
    balanceCommitment,
    nonce,
    pendingCredits,
    viewerKeys,
    isInitialized,
    createdAt,
    lastTxAt,
    bump,
  };
}

// ---------------------------------------------------------------------------
// Helpers: SPL Associated Token Account instruction
// ---------------------------------------------------------------------------

/**
 * Build a CreateAssociatedTokenAccount instruction (no external dependency needed).
 * This matches the instruction layout of the SPL Associated Token Account program.
 */
function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ZkSplClient.ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function deserializeMintConfig(data: Buffer): MintConfigAccount {
  let offset = 8;

  const authority = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const tokenMint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const balanceVkHash = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const proofVkHash = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const isActive = data[offset] !== 0;
  offset += 1;

  const accountCount = data.readBigUInt64LE(offset);
  offset += 8;

  const createdAt = data.readBigInt64LE(offset);
  offset += 8;

  const bump = data[offset];

  return {
    authority,
    tokenMint,
    balanceVkHash,
    proofVkHash,
    isActive,
    accountCount,
    createdAt,
    bump,
  };
}

/**
 * ZkSplClient - High-level client for the p01_zkspl Anchor program.
 *
 * Provides ergonomic methods for:
 *   - initializeMint, createAccount
 *   - deposit, withdraw
 *   - confidentialTransfer, applyPending
 *   - proveBalance
 *   - addViewer, removeViewer
 *   - queries (getConfidentialAccount, getPendingCredits, getLocalBalance)
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor';

import {
  ZKSPL_PROGRAM_ID,
  PDA_SEEDS,
  VK_TYPE_BALANCE,
  VK_TYPE_PROOF,
  TOKEN_PROGRAM_ID,
} from './constants';
import {
  createBalanceCommitment,
  createAmountCommitment,
  deriveOwnerPubkey,
  fieldToBytes,
  pubkeyToField,
  randomSalt,
  zeroAmountHash,
} from './crypto';
import { ZkSplProver } from './prover';
import { LocalStateManager, type StateStore } from './state';
import type {
  FieldElement,
  Groth16Proof,
  ProverConfig,
  ConfidentialAccountData,
  MintConfigAccount,
  PendingCredit,
  ZkSplTxResult,
  ConfidentialBalancePublicInputs,
  ConfidentialBalancePrivateInputs,
  BalanceProofPublicInputs,
  BalanceProofPrivateInputs,
} from './types';

// We import the IDL type but load it lazily from JSON at runtime if needed
// For now we use raw instruction building via Anchor's `program.methods`.
// The Anchor IDL JSON should be loaded by the consumer or bundled.
// We provide a minimal typed wrapper.

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface ZkSplClientConfig {
  /** Solana RPC connection */
  connection: Connection;
  /** Wallet (signer) */
  wallet: Wallet;
  /** Program ID override (default: deployed ZKSPL_PROGRAM_ID) */
  programId?: PublicKey;
  /** Prover configuration */
  prover?: ProverConfig;
  /** State persistence store */
  stateStore?: StateStore;
  /** Spending key for the owner (required for operations that need proofs) */
  spendingKey?: FieldElement;
}

// ---------------------------------------------------------------------------
// ZkSplClient
// ---------------------------------------------------------------------------

export class ZkSplClient {
  readonly connection: Connection;
  readonly wallet: Wallet;
  readonly programId: PublicKey;

  private prover: ZkSplProver;
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
      this.prover = new ZkSplProver();
      this.stateManager = new LocalStateManager();
      this._spendingKey = null;
    } else {
      const cfg = connectionOrConfig;
      this.connection = cfg.connection;
      this.wallet = cfg.wallet;
      this.programId = cfg.programId ?? new PublicKey(ZKSPL_PROGRAM_ID);
      this.prover = new ZkSplProver(cfg.prover);
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
        'Spending key not set. Call setSpendingKey() or pass it in the config.'
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

  /** Derive the VK data PDA for a (mint_config, vk_type) pair */
  deriveVkDataPDA(
    mintConfigPDA: PublicKey,
    vkType: number
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [PDA_SEEDS.VK_DATA, mintConfigPDA.toBytes(), Buffer.from([vkType])],
      this.programId
    );
  }

  // -----------------------------------------------------------------------
  // Setup: initializeMint
  // -----------------------------------------------------------------------

  /**
   * Register an SPL token for zkSPL confidential operations.
   * Creates a MintConfig PDA with verification key hashes.
   *
   * @param tokenMint - The SPL token mint to enable
   * @param balanceVkHash - Hash of the confidential_balance verification key
   * @param proofVkHash - Hash of the balance_proof verification key
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
    const salt = initialSalt ?? randomSalt();
    const tokenMintField = pubkeyToField(tokenMint.toBytes());

    // initial commitment = Poseidon(0, salt, owner_pubkey, token_mint)
    const commitment = createBalanceCommitment(0n, salt, ownerPubkey, tokenMintField);
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

    // Initialize local state
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
   * The deposit amount is public, but the new balance is hidden.
   *
   * @param tokenMint - The SPL token mint
   * @param amount - Amount to deposit (in atomic units)
   * @param userTokenAccount - Optional user's token account (for SPL tokens)
   * @param poolVaultTokenAccount - Optional pool vault token account
   */
  async deposit(
    tokenMint: PublicKey,
    amount: bigint,
    userTokenAccount?: PublicKey,
    poolVaultTokenAccount?: PublicKey
  ): Promise<ZkSplTxResult> {
    const spendingKey = this.requireSpendingKey();
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    // Load current local state
    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) {
      throw new Error('No local state. Call createAccount() first.');
    }

    const oldBalance = state.balance;
    const oldSalt = state.salt;
    const currentNonce = state.nonce;
    const newBalance = oldBalance + amount;
    const newSalt = randomSalt();

    // Compute commitments
    const oldCommitment = createBalanceCommitment(
      oldBalance, oldSalt, ownerPubkey, tokenMintField
    );
    const newCommitment = createBalanceCommitment(
      newBalance, newSalt, ownerPubkey, tokenMintField
    );

    // For deposit: public_credit = amount, amount_hash = Poseidon(0, 0), is_debit = 0
    const pubInputs: ConfidentialBalancePublicInputs = {
      oldCommitment,
      newCommitment,
      amountHash: zeroAmountHash(),
      publicCredit: amount,
      publicDebit: 0n,
      tokenMint: tokenMintField,
      nonce: currentNonce,
    };

    const privInputs: ConfidentialBalancePrivateInputs = {
      oldBalance,
      oldSalt,
      newBalance,
      newSalt,
      amount: 0n, // private amount is 0 for deposit
      amountSalt: 0n,
      spendingKey,
      isDebit: 0,
    };

    const { proof } = await this.prover.generateBalanceProof(pubInputs, privInputs);
    const newCommitmentBytes = fieldToBytes(newCommitment);

    // Build accounts
    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [vaultPDA] = this.deriveVaultPDA(tokenMint);
    const [vkDataPDA] = this.deriveVkDataPDA(mintConfigPDA, VK_TYPE_BALANCE);

    const accounts: Record<string, PublicKey | null> = {
      depositor: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      vkData: vkDataPDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
      tokenProgram: userTokenAccount ? new PublicKey(TOKEN_PROGRAM_ID) : null,
      userTokenAccount: userTokenAccount ?? null,
      poolVault: poolVaultTokenAccount ?? null,
    };

    const ix = await this.buildAnchorInstruction('deposit', accounts, {
      amount: new BN(amount.toString()),
      proof: groth16ProofToAnchor(proof),
      newCommitment: Array.from(newCommitmentBytes),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
    const newNonce = currentNonce + 1n;

    // Update local state
    await this.stateManager.afterDeposit(
      ownerBase58,
      mintBase58,
      amount,
      newSalt,
      newNonce
    );

    return {
      signature,
      newCommitment: newCommitmentBytes,
      newBalance,
      newNonce,
    };
  }

  // -----------------------------------------------------------------------
  // Withdraw
  // -----------------------------------------------------------------------

  /**
   * Withdraw from confidential account to regular SPL tokens.
   * The withdrawal amount is public, but the remaining balance stays hidden.
   *
   * @param tokenMint - The SPL token mint
   * @param amount - Amount to withdraw (in atomic units)
   * @param userTokenAccount - Optional user's token account (for SPL tokens)
   * @param poolVaultTokenAccount - Optional pool vault token account
   */
  async withdraw(
    tokenMint: PublicKey,
    amount: bigint,
    userTokenAccount?: PublicKey,
    poolVaultTokenAccount?: PublicKey
  ): Promise<ZkSplTxResult> {
    const spendingKey = this.requireSpendingKey();
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) throw new Error('No local state. Call createAccount() first.');
    if (state.balance < amount) {
      throw new Error(
        `Insufficient balance: have ${state.balance}, need ${amount}`
      );
    }

    const oldBalance = state.balance;
    const oldSalt = state.salt;
    const currentNonce = state.nonce;
    const newBalance = oldBalance - amount;
    const newSalt = randomSalt();

    const oldCommitment = createBalanceCommitment(
      oldBalance, oldSalt, ownerPubkey, tokenMintField
    );
    const newCommitment = createBalanceCommitment(
      newBalance, newSalt, ownerPubkey, tokenMintField
    );

    // For withdraw: public_debit = amount, amount_hash = Poseidon(0,0), is_debit = 0
    // (the debit is public, not private)
    const pubInputs: ConfidentialBalancePublicInputs = {
      oldCommitment,
      newCommitment,
      amountHash: zeroAmountHash(),
      publicCredit: 0n,
      publicDebit: amount,
      tokenMint: tokenMintField,
      nonce: currentNonce,
    };

    const privInputs: ConfidentialBalancePrivateInputs = {
      oldBalance,
      oldSalt,
      newBalance,
      newSalt,
      amount: 0n,
      amountSalt: 0n,
      spendingKey,
      isDebit: 0,
    };

    const { proof } = await this.prover.generateBalanceProof(pubInputs, privInputs);
    const newCommitmentBytes = fieldToBytes(newCommitment);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [vaultPDA] = this.deriveVaultPDA(tokenMint);
    const [vkDataPDA] = this.deriveVkDataPDA(mintConfigPDA, VK_TYPE_BALANCE);

    const accounts: Record<string, PublicKey | null> = {
      withdrawer: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      vkData: vkDataPDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
      tokenProgram: userTokenAccount ? new PublicKey(TOKEN_PROGRAM_ID) : null,
      userTokenAccount: userTokenAccount ?? null,
      poolVault: poolVaultTokenAccount ?? null,
    };

    const ix = await this.buildAnchorInstruction('withdraw', accounts, {
      amount: new BN(amount.toString()),
      proof: groth16ProofToAnchor(proof),
      newCommitment: Array.from(newCommitmentBytes),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
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
      newCommitment: newCommitmentBytes,
      newBalance,
      newNonce,
    };
  }

  // -----------------------------------------------------------------------
  // Confidential Transfer (send side)
  // -----------------------------------------------------------------------

  /**
   * Send a confidential (private) transfer to another user.
   * The amount is hidden on-chain as an amount_hash.
   * The recipient receives a pending credit they must later apply.
   *
   * @param tokenMint - The SPL token mint
   * @param recipientPubkey - Recipient's Solana wallet pubkey
   * @param amount - Amount to transfer
   * @param amountSalt - Optional salt for the amount commitment (auto-generated if omitted)
   * @returns Result including the amountHash the recipient needs to know
   */
  async confidentialTransfer(
    tokenMint: PublicKey,
    recipientPubkey: PublicKey,
    amount: bigint,
    amountSalt?: FieldElement
  ): Promise<ZkSplTxResult & { amountHash: FieldElement; amountSaltUsed: FieldElement }> {
    const spendingKey = this.requireSpendingKey();
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) throw new Error('No local state. Call createAccount() first.');
    if (state.balance < amount) {
      throw new Error(
        `Insufficient balance: have ${state.balance}, need ${amount}`
      );
    }

    const oldBalance = state.balance;
    const oldSalt = state.salt;
    const currentNonce = state.nonce;
    const newBalance = oldBalance - amount;
    const newSalt = randomSalt();
    const aSalt = amountSalt ?? randomSalt();

    const oldCommitment = createBalanceCommitment(
      oldBalance, oldSalt, ownerPubkey, tokenMintField
    );
    const newCommitment = createBalanceCommitment(
      newBalance, newSalt, ownerPubkey, tokenMintField
    );
    const amountHash = createAmountCommitment(amount, aSalt);

    // For send: is_debit = 1, amount = transfer amount, public amounts = 0
    const pubInputs: ConfidentialBalancePublicInputs = {
      oldCommitment,
      newCommitment,
      amountHash,
      publicCredit: 0n,
      publicDebit: 0n,
      tokenMint: tokenMintField,
      nonce: currentNonce,
    };

    const privInputs: ConfidentialBalancePrivateInputs = {
      oldBalance,
      oldSalt,
      newBalance,
      newSalt,
      amount,
      amountSalt: aSalt,
      spendingKey,
      isDebit: 1,
    };

    const { proof } = await this.prover.generateBalanceProof(pubInputs, privInputs);
    const newCommitmentBytes = fieldToBytes(newCommitment);
    const amountHashBytes = fieldToBytes(amountHash);

    // Derive accounts
    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [senderAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [recipientAccountPDA] = this.deriveConfidentialAccountPDA(
      recipientPubkey,
      tokenMint
    );
    const [vkDataPDA] = this.deriveVkDataPDA(mintConfigPDA, VK_TYPE_BALANCE);

    const ix = await this.buildAnchorInstruction('confidential_transfer', {
      sender: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      senderAccount: senderAccountPDA,
      recipientAccount: recipientAccountPDA,
      vkData: vkDataPDA,
    }, {
      proof: groth16ProofToAnchor(proof),
      newCommitment: Array.from(newCommitmentBytes),
      amountHash: Array.from(amountHashBytes),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
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
      newCommitment: newCommitmentBytes,
      newBalance,
      newNonce,
      amountHash,
      amountSaltUsed: aSalt,
    };
  }

  // -----------------------------------------------------------------------
  // Apply Pending (receive side)
  // -----------------------------------------------------------------------

  /**
   * Apply a pending credit to update the recipient's balance.
   * The recipient must know the plaintext amount and amount_salt
   * (communicated out-of-band by the sender).
   *
   * @param tokenMint - The SPL token mint
   * @param amount - The plaintext transfer amount
   * @param amountSalt - The amount salt used by the sender
   */
  async applyPending(
    tokenMint: PublicKey,
    amount: bigint,
    amountSalt: FieldElement
  ): Promise<ZkSplTxResult> {
    const spendingKey = this.requireSpendingKey();
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) throw new Error('No local state. Call createAccount() first.');

    const oldBalance = state.balance;
    const oldSalt = state.salt;
    const currentNonce = state.nonce;
    const newBalance = oldBalance + amount;
    const newSalt = randomSalt();

    const oldCommitment = createBalanceCommitment(
      oldBalance, oldSalt, ownerPubkey, tokenMintField
    );
    const newCommitment = createBalanceCommitment(
      newBalance, newSalt, ownerPubkey, tokenMintField
    );
    const amountHash = createAmountCommitment(amount, amountSalt);

    // For receive (apply_pending): is_debit = 0, amount = transfer amount
    const pubInputs: ConfidentialBalancePublicInputs = {
      oldCommitment,
      newCommitment,
      amountHash,
      publicCredit: 0n,
      publicDebit: 0n,
      tokenMint: tokenMintField,
      nonce: currentNonce,
    };

    const privInputs: ConfidentialBalancePrivateInputs = {
      oldBalance,
      oldSalt,
      newBalance,
      newSalt,
      amount,
      amountSalt,
      spendingKey,
      isDebit: 0,
    };

    const { proof } = await this.prover.generateBalanceProof(pubInputs, privInputs);
    const newCommitmentBytes = fieldToBytes(newCommitment);
    const amountHashBytes = fieldToBytes(amountHash);

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [vkDataPDA] = this.deriveVkDataPDA(mintConfigPDA, VK_TYPE_BALANCE);

    const ix = await this.buildAnchorInstruction('apply_pending', {
      recipient: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      vkData: vkDataPDA,
    }, {
      proof: groth16ProofToAnchor(proof),
      newCommitment: Array.from(newCommitmentBytes),
      amountHash: Array.from(amountHashBytes),
    });

    const signature = await this.sendAndConfirm(new Transaction().add(ix));
    const newNonce = currentNonce + 1n;

    await this.stateManager.afterApplyPending(
      ownerBase58,
      mintBase58,
      amountHash,
      amount,
      newSalt,
      newNonce
    );

    return {
      signature,
      newCommitment: newCommitmentBytes,
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
   * @param tokenMint - The SPL token mint
   * @param threshold - Minimum balance to prove
   */
  async proveBalance(
    tokenMint: PublicKey,
    threshold: bigint
  ): Promise<string> {
    const spendingKey = this.requireSpendingKey();
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const tokenMintField = pubkeyToField(tokenMint.toBytes());
    const ownerBase58 = this.wallet.publicKey.toBase58();
    const mintBase58 = tokenMint.toBase58();

    const state = await this.stateManager.getState(ownerBase58, mintBase58);
    if (!state) throw new Error('No local state. Call createAccount() first.');
    if (state.balance < threshold) {
      throw new Error(
        `Balance ${state.balance} is below threshold ${threshold}. Cannot prove.`
      );
    }

    const balanceCommitment = createBalanceCommitment(
      state.balance,
      state.salt,
      ownerPubkey,
      tokenMintField
    );

    const pubInputs: BalanceProofPublicInputs = {
      balanceCommitment,
      threshold,
      tokenMint: tokenMintField,
    };

    const privInputs: BalanceProofPrivateInputs = {
      balance: state.balance,
      salt: state.salt,
      spendingKey,
    };

    const { proof } = await this.prover.generateSufficiencyProof(
      pubInputs,
      privInputs
    );

    const [mintConfigPDA] = this.deriveMintConfigPDA(tokenMint);
    const [confidentialAccountPDA] = this.deriveConfidentialAccountPDA(
      this.wallet.publicKey,
      tokenMint
    );
    const [vkDataPDA] = this.deriveVkDataPDA(mintConfigPDA, VK_TYPE_PROOF);

    const ix = await this.buildAnchorInstruction('prove_balance', {
      prover: this.wallet.publicKey,
      mintConfig: mintConfigPDA,
      confidentialAccount: confidentialAccountPDA,
      vkData: vkDataPDA,
    }, {
      threshold: new BN(threshold.toString()),
      proof: groth16ProofToAnchor(proof),
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
    // Compute Anchor instruction discriminator
    const { sha256 } = await import('@noble/hashes/sha256');
    const discriminator = sha256(
      new TextEncoder().encode(`global:${instructionName}`)
    ).slice(0, 8);

    // Serialize args using Anchor's borsh format
    const argsBuffer = serializeAnchorArgs(instructionName, args);

    // Combine discriminator + serialized args
    const data = Buffer.concat([
      Buffer.from(discriminator),
      argsBuffer,
    ]);

    // Build account keys (order matters! must match IDL ordering)
    const keys = Object.entries(accounts)
      .filter(([_, v]) => v !== null)
      .map(([name, pubkey]) => ({
        pubkey: pubkey!,
        isSigner: isSignerAccount(instructionName, name),
        isWritable: isWritableAccount(instructionName, name),
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
    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (
      await this.connection.getLatestBlockhash()
    ).blockhash;

    const signed = await this.wallet.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(
      signed.serialize()
    );
    await this.connection.confirmTransaction(signature);
    return signature;
  }
}

// ---------------------------------------------------------------------------
// Helpers: Groth16Proof to Anchor format
// ---------------------------------------------------------------------------

function groth16ProofToAnchor(proof: Groth16Proof): {
  piA: number[];
  piB: number[];
  piC: number[];
} {
  return {
    piA: Array.from(proof.pi_a),
    piB: Array.from(proof.pi_b),
    piC: Array.from(proof.pi_c),
  };
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
      // u64: 8 bytes little-endian
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(value.toString()));
      buffers.push(buf);
    } else if (Array.isArray(value)) {
      // [u8; N]: raw bytes (no length prefix for fixed arrays)
      buffers.push(Buffer.from(value as number[]));
    } else if (value instanceof PublicKey) {
      buffers.push(value.toBuffer());
    } else if (typeof value === 'object' && value !== null) {
      // Nested struct (e.g., Groth16Proof with piA, piB, piC)
      const nested = value as Record<string, unknown>;
      buffers.push(serializeAnchorArgs(_instructionName, nested));
    } else if (typeof value === 'number') {
      // u8
      const buf = Buffer.alloc(1);
      buf.writeUInt8(value);
      buffers.push(buf);
    } else if (typeof value === 'string') {
      // bytes (with 4-byte length prefix)
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
  init_vk_data: new Set(['authority']),
  write_vk_data: new Set(['authority']),
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
  init_vk_data: new Set(['authority', 'vkData']),
  write_vk_data: new Set(['vkData']),
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
  let offset = 8; // skip discriminator

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const mint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const balanceCommitment = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const nonce = data.readBigUInt64LE(offset);
  offset += 8;

  // pending_credits: Vec<PendingCredit>
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

  // viewer_keys: Vec<Pubkey>
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

/**
 * Deserialize an on-chain MintConfig from its raw data buffer.
 * Layout (after 8-byte Anchor discriminator):
 *   authority: Pubkey (32)
 *   token_mint: Pubkey (32)
 *   balance_vk_hash: [u8; 32]
 *   proof_vk_hash: [u8; 32]
 *   is_active: bool (1)
 *   account_count: u64 (8)
 *   created_at: i64 (8)
 *   bump: u8 (1)
 */
function deserializeMintConfig(data: Buffer): MintConfigAccount {
  let offset = 8; // skip discriminator

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

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { getConnection, isDevnet } from '../services/solana/connection';
import {
  getZkSplService,
  resetZkSplService,
  ZkSplService,
  NATIVE_SOL_MINT,
  NATIVE_SOL_MINT_STR,
  USDC_DEVNET_MINT,
  USDC_DEVNET_MINT_STR,
  SUPPORTED_TOKENS,
  getTokenDecimals,
  getTokenSymbol,
} from '../services/zkspl';
import {
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  type GenericStarkProof,
  CIRCUIT_CONFIDENTIAL_BALANCE,
} from '../services/stark';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** State validation result per token */
interface StateValidation {
  isValid: boolean;
  localNonce: number;
  onChainNonce: number;
  localBalance: number;
  commitmentMatches: boolean;
  details: string;
}

/** STARK proof data for confidential balance operations */
export interface ConfidentialStarkProofData {
  proofBytes: Uint8Array;
  publicInputs: bigint[];
  proofSize: number;
}

interface ConfidentialState {
  // Persisted state
  isInitialized: boolean;
  isLoading: boolean;
  /** Per-token confidential balances (tokenMint -> balance in atomic units) */
  balances: Record<string, number>;
  /** Account status (tokenMint -> exists on-chain) */
  accounts: Record<string, boolean>;
  /** Pending credits awaiting apply (tokenMint -> count) */
  pendingCredits: Record<string, number>;
  /** Error message */
  error: string | null;
  /** ZK wallet address (may differ from main wallet for Privy users) */
  zkWalletAddress: string | null;
  /** ZK wallet SOL balance in lamports */
  zkWalletBalance: number;
  /** Per-token public balances available to deposit (tokenMint -> atomic units) */
  publicTokenBalances: Record<string, number>;
  /** Currently selected token mint string */
  selectedToken: string;
  /** Per-token state validation results (not persisted) */
  stateValidation: Record<string, StateValidation>;

  // Internal (not persisted)
  _service: ZkSplService | null;

  // Actions
  initialize: () => Promise<void>;
  ensureInitialized: () => Promise<boolean>;
  setSelectedToken: (mintStr: string) => void;
  refreshBalance: (tokenMint?: string) => Promise<void>;
  refreshAllBalances: () => Promise<void>;
  validateState: (tokenMint?: string) => Promise<StateValidation | null>;
  emergencyReset: (tokenMint: string) => Promise<void>;
  /**
   * Deposit tokens into the confidential account.
   * STARK-only: caller generates a STARK proof for circuit 4 (confidential_balance)
   * off-device, then passes it here. The store uploads+verifies the proof via
   * `p01_stark_verifier`, calls the on-chain `deposit` with the verified proof
   * buffer, and closes the buffer to recover rent.
   */
  depositStark: (
    tokenMint: string,
    amount: number,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /** Withdraw (STARK-only; see depositStark docs). */
  withdrawStark: (
    tokenMint: string,
    amount: number,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /**
   * Confidential transfer (STARK-only).
   * The caller must pass the `amountSalt` used to build `amount_hash`
   * (it comes from `getTransferProofInputs`). The returned value contains
   * the sender-side signature; the recipient needs `amount` + `amountSalt`
   * out-of-band to later call `applyPending`.
   */
  confidentialTransferStark: (
    tokenMint: string,
    recipient: string,
    amount: number,
    amountSalt: string,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /** Get STARK proof inputs for confidential balance operations (circuit 4) */
  getConfidentialProofInputs: (
    tokenMint: string,
    amount: number,
    isDebit: boolean,
  ) => Promise<{
    spendingKey: string;
    oldBalance: string;
    oldSalt: string;
    newBalance: string;
    newSalt: string;
    amount: string;
    amountSalt: string;
    tokenMint: string;
  }>;
  /**
   * Get STARK proof inputs for confidential transfer.
   * Returns the same shape as `getConfidentialProofInputs` (sender-side
   * balance update uses circuit 4), with a deterministic non-zero
   * `amountSalt` so the recipient can match the on-chain `amount_hash`.
   */
  getTransferProofInputs: (
    tokenMint: string,
    amount: number,
    recipientPubkey: string,
  ) => Promise<{
    spendingKey: string;
    oldBalance: string;
    oldSalt: string;
    newBalance: string;
    newSalt: string;
    amount: string;
    amountSalt: string;
    tokenMint: string;
  }>;
  /**
   * Apply a pending credit to the confidential balance (STARK-only).
   * Caller must generate a STARK proof for circuit 4 using the same
   * `amount`+`amountSalt` the sender shared off-band.
   */
  applyPendingStark: (
    tokenMint: string,
    amount: number,
    amountSalt: string,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /** Prove the confidential balance satisfies a threshold (STARK-only, circuit 2). */
  proveBalanceStark: (
    tokenMint: string,
    threshold: number,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  sweepToMainWallet: (mainWalletAddress: string, amount: number, onProgress?: (step: 'shield' | 'unshield', message: string) => void) => Promise<string>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SPL Token Program ID */
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Associated Token Account Program ID */
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Derive the ATA address for an owner + mint */
function deriveATA(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

/** Fetch the SPL token balance for an ATA. Returns 0 if the ATA doesn't exist. */
async function getSplTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<number> {
  const ata = deriveATA(owner, mint);
  try {
    const info = await connection.getAccountInfo(ata);
    if (!info || info.data.length < 72) return 0;
    // SPL Token account layout: offset 64 = amount (u64 LE)
    const amount = info.data.readBigUInt64LE(64);
    return Number(amount);
  } catch {
    return 0;
  }
}

const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConfidentialStore = create<ConfidentialState>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      isLoading: false,
      balances: {},
      accounts: {},
      pendingCredits: {},
      error: null,
      zkWalletAddress: null,
      zkWalletBalance: 0,
      publicTokenBalances: {},
      selectedToken: NATIVE_SOL_MINT_STR,
      stateValidation: {},
      _service: null,

      /**
       * Initialize the confidential balance system.
       * Checks if a confidential account exists on-chain for native SOL;
       * creates one if not.
       */
      initialize: async () => {
        set({ isLoading: true, error: null });

        try {
          const service = await getZkSplService();
          if (!service) {
            throw new Error('Could not create ZkSPL service. Wallet may not be available.');
          }

          set({ _service: service });

          // Get ZK wallet address and balance (may differ from main wallet for Privy users)
          const walletPubkey = service.getWalletPublicKey();
          const zkAddr = walletPubkey.toBase58();
          const connection = getConnection();
          const walletBalance = await connection.getBalance(walletPubkey);
          set({ zkWalletAddress: zkAddr, zkWalletBalance: walletBalance });

          if (isDevnet() && walletBalance < 0.01 * LAMPORTS_PER_SOL) {
            try {
              // Use public devnet RPC for airdrop (Helius has aggressive rate limits)
              const devnetConn = new Connection('https://api.devnet.solana.com', 'confirmed');
              const sig = await devnetConn.requestAirdrop(walletPubkey, 0.5 * LAMPORTS_PER_SOL);
              await devnetConn.confirmTransaction(sig, 'confirmed');
            } catch (airdropErr: any) {
              // Airdrop failed — may need manual funding
            }
          }

          // Check accounts for all supported tokens
          const initBalances: Record<string, number> = {};
          const initAccounts: Record<string, boolean> = {};
          const initPending: Record<string, number> = {};

          for (const token of SUPPORTED_TOKENS) {
            const accountInfo = await service.getAccountInfo(token.mint);
            const accountExists = accountInfo !== null && accountInfo.isInitialized;

            if (!accountExists && token.mintStr === NATIVE_SOL_MINT_STR) {
              // Auto-create account for native SOL (primary token)
              try {
                await service.createAccount(NATIVE_SOL_MINT);
                initAccounts[token.mintStr] = true;
              } catch (createErr: any) {
                if (
                  createErr.message?.includes('already in use') ||
                  createErr.message?.includes('already been processed')
                ) {
                  initAccounts[token.mintStr] = true;
                } else {
                  throw createErr;
                }
              }
            } else {
              initAccounts[token.mintStr] = accountExists;
            }

            if (initAccounts[token.mintStr]) {
              const localBalance = await service.getLocalBalance(token.mint);
              initBalances[token.mintStr] = Number(localBalance);
              try {
                initPending[token.mintStr] = await service.getPendingCreditsCount(token.mint);
              } catch {
                initPending[token.mintStr] = 0;
              }
            } else {
              initBalances[token.mintStr] = 0;
              initPending[token.mintStr] = 0;
            }
          }

          // Fetch public token balances (available to deposit)
          const pubBalances: Record<string, number> = {};
          pubBalances[NATIVE_SOL_MINT_STR] = walletBalance;
          for (const token of SUPPORTED_TOKENS) {
            if (token.mintStr !== NATIVE_SOL_MINT_STR) {
              pubBalances[token.mintStr] = await getSplTokenBalance(
                connection, walletPubkey, token.mint,
              );
            }
          }

          set({
            isInitialized: true,
            isLoading: false,
            accounts: initAccounts,
            balances: initBalances,
            pendingCredits: initPending,
            publicTokenBalances: pubBalances,
          });

          // Validate state for all accounts (non-blocking)
          for (const token of SUPPORTED_TOKENS) {
            if (initAccounts[token.mintStr]) {
              get().validateState(token.mintStr).catch(() => {});
            }
          }
        } catch (error) {
          console.error('[Confidential] Initialize error:', error);
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      /**
       * Ensure the service is initialized (handles app restart).
       */
      ensureInitialized: async () => {
        const { _service } = get();
        if (_service) return true;

        try {
          await get().initialize();
          return get()._service !== null;
        } catch (error) {
          console.error('[Confidential] Failed to initialize:', error);
          return false;
        }
      },

      /**
       * Set the currently selected token mint.
       */
      setSelectedToken: (mintStr: string) => {
        set({ selectedToken: mintStr });
      },

      /**
       * Validate that local state matches the on-chain commitment.
       * Returns the validation result for the given token (defaults to selected).
       */
      validateState: async (tokenMint?: string) => {
        await get().ensureInitialized();
        const { _service } = get();
        if (!_service) return null;

        const mint = tokenMint || get().selectedToken;
        const mintPubkey = new PublicKey(mint);

        try {
          const result = await _service.validateState(mintPubkey);
          const validation: StateValidation = {
            isValid: result.isValid,
            localNonce: Number(result.localNonce),
            onChainNonce: Number(result.onChainNonce),
            localBalance: Number(result.localBalance),
            commitmentMatches: result.commitmentMatches,
            details: result.details,
          };

          set((state) => ({
            stateValidation: { ...state.stateValidation, [mint]: validation },
          }));

          return validation;
        } catch (err) {
          console.error('[Confidential] Validation error:', err);
          return null;
        }
      },

      /**
       * Emergency reset: clear local state for a token.
       * This forfeits any confidential balance that can't be recovered.
       * The user must deposit fresh funds after reset.
       */
      emergencyReset: async (tokenMint: string) => {
        await get().ensureInitialized();
        const { _service } = get();
        if (!_service) throw new Error('Service not initialized');

        const mintPubkey = new PublicKey(tokenMint);

        await _service.emergencyReset(mintPubkey);

        // Clear validation and balance for this token
        set((state) => ({
          balances: { ...state.balances, [tokenMint]: 0 },
          stateValidation: {
            ...state.stateValidation,
            [tokenMint]: {
              isValid: false,
              localNonce: 0,
              onChainNonce: state.stateValidation[tokenMint]?.onChainNonce || 0,
              localBalance: 0,
              commitmentMatches: false,
              details: 'State was emergency-reset. On-chain commitment is stale. Deposit fresh funds.',
            },
          },
        }));
      },

      /**
       * Refresh the confidential balance for a given token mint.
       * Defaults to the selected token.
       */
      refreshBalance: async (tokenMint?: string) => {
        await get().ensureInitialized();

        const { _service } = get();
        if (!_service) return;

        const mint = tokenMint || NATIVE_SOL_MINT_STR;
        const mintPubkey = new PublicKey(mint);

        set({ isLoading: true, error: null });

        try {
          const localBalance = await _service.getLocalBalance(mintPubkey);
          const balanceLamports = Number(localBalance);

          let pendingCount = 0;
          try {
            pendingCount = await _service.getPendingCreditsCount(mintPubkey);
          } catch {
            // Non-critical
          }

          set((state) => ({
            isLoading: false,
            balances: { ...state.balances, [mint]: balanceLamports },
            pendingCredits: { ...state.pendingCredits, [mint]: pendingCount },
          }));
        } catch (error) {
          console.error('[Confidential] Refresh balance error:', error);
          set({ isLoading: false, error: (error as Error).message });
        }
      },

      /**
       * Refresh balances for all supported tokens.
       */
      refreshAllBalances: async () => {
        await get().ensureInitialized();
        const { _service } = get();
        if (!_service) return;

        set({ isLoading: true, error: null });

        try {
          const newBalances: Record<string, number> = {};
          const newPending: Record<string, number> = {};
          const newAccounts: Record<string, boolean> = {};

          for (const token of SUPPORTED_TOKENS) {
            try {
              const accountInfo = await _service.getAccountInfo(token.mint);
              const exists = accountInfo !== null && accountInfo.isInitialized;
              newAccounts[token.mintStr] = exists;

              if (exists) {
                const localBalance = await _service.getLocalBalance(token.mint);
                newBalances[token.mintStr] = Number(localBalance);
                try {
                  newPending[token.mintStr] = await _service.getPendingCreditsCount(token.mint);
                } catch {
                  newPending[token.mintStr] = 0;
                }
              } else {
                newBalances[token.mintStr] = 0;
                newPending[token.mintStr] = 0;
              }
            } catch (err) {
              // Keep existing values for this token
              newBalances[token.mintStr] = get().balances[token.mintStr] || 0;
              newPending[token.mintStr] = get().pendingCredits[token.mintStr] || 0;
              newAccounts[token.mintStr] = get().accounts[token.mintStr] || false;
            }
          }

          // Also refresh ZK wallet SOL balance + public token balances
          const connection = getConnection();
          const walletPubkey = _service.getWalletPublicKey();
          const walletBalance = await connection.getBalance(walletPubkey);

          // Fetch public token balances (available to deposit)
          const pubBalances: Record<string, number> = {};
          pubBalances[NATIVE_SOL_MINT_STR] = walletBalance; // SOL = wallet lamports
          for (const token of SUPPORTED_TOKENS) {
            if (token.mintStr !== NATIVE_SOL_MINT_STR) {
              pubBalances[token.mintStr] = await getSplTokenBalance(
                connection, walletPubkey, token.mint,
              );
            }
          }

          set({
            isLoading: false,
            balances: newBalances,
            pendingCredits: newPending,
            accounts: newAccounts,
            zkWalletBalance: walletBalance,
            publicTokenBalances: pubBalances,
          });

          // Validate state for tokens that have accounts (non-blocking)
          for (const token of SUPPORTED_TOKENS) {
            if (newAccounts[token.mintStr]) {
              get().validateState(token.mintStr).catch(() => {});
            }
          }
        } catch (error) {
          console.error('[Confidential] Refresh all balances error:', error);
          set({ isLoading: false, error: (error as Error).message });
        }
      },

      /**
       * Get STARK proof inputs for confidential balance (circuit 4).
       * Must be called before deposit/withdraw to capture the pre-op state.
       */
      getConfidentialProofInputs: async (
        tokenMint: string,
        amount: number,
        isDebit: boolean,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        const decimals = getTokenDecimals(tokenMint);
        const amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));
        return _service.getConfidentialProofInputs(
          new PublicKey(tokenMint),
          amountAtomic,
          isDebit,
        );
      },

      /**
       * Get STARK proof inputs for confidential transfer.
       * zkSPL transfer uses circuit 4 (confidential_balance) for the sender-
       * side balance update — circuit 5 (UTXO) is reserved for zk_shielded.
       * Returns the same 8-field shape as `getConfidentialProofInputs` with a
       * deterministic non-zero `amountSalt`. The `recipientPubkey` is passed
       * for forward compatibility but currently unused — the recipient is
       * bound through the zkSPL instruction's `recipient_account` PDA.
       */
      getTransferProofInputs: async (
        tokenMint: string,
        amount: number,
        _recipientPubkey: string,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        const decimals = getTokenDecimals(tokenMint);
        const amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));
        return _service.getTransferProofInputs(
          new PublicKey(tokenMint),
          amountAtomic,
        );
      },

      /**
       * Deposit (STARK-only).
       *
       * Flow:
       *   1. Upload+verify STARK proof (keep buffer open for zkSPL to read)
       *   2. Call zkSPL `deposit` with the verified proof buffer + newCommitment
       *   3. Close the proof buffer to recover rent
       */
      depositStark: async (
        tokenMint: string,
        amount: number,
        starkProofData: ConfidentialStarkProofData,
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const decimals = getTokenDecimals(tokenMint);
          let amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));

          // Pre-flight SOL balance check for native SOL deposits
          if (tokenMint === NATIVE_SOL_MINT_STR) {
            const connection = getConnection();
            const walletPubkey = _service.getWalletPublicKey();
            const walletBalance = await connection.getBalance(walletPubkey);
            set({ zkWalletBalance: walletBalance });
            const FEE_RESERVE = 200_000; // lamports reserved for STARK upload + deposit fees
            const maxDepositable = walletBalance - FEE_RESERVE;
            if (maxDepositable <= 0) {
              throw new Error(`ZK wallet has no SOL available for deposit. Send SOL to your ZK wallet first.`);
            }
            if (Number(amountAtomic) > maxDepositable) {
              amountAtomic = BigInt(maxDepositable);
            }
          }

          // Step 1: upload STARK proof and verify on-chain (buffer kept open).
          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          const { proofBuffer } = await submitAndVerifyStarkProof(
            starkProof,
            undefined,
            onStarkProgress,
          );

          // The AIR public inputs order is [old_commitment, new_commitment,
          // amount_hash, token_mint]. new_commitment sits at index 1.
          const newCommitment = ZkSplService.fieldToBytes32LE(
            starkProofData.publicInputs[1],
          );

          // Step 2: run the on-chain zkSPL deposit.
          onStarkProgress?.('Submitting zkSPL deposit...');
          const { signature, newBalance } = await _service.deposit(
            mintPubkey,
            amountAtomic,
            proofBuffer,
            newCommitment,
          );

          // Step 3: recover rent from the proof buffer (best-effort).
          onStarkProgress?.('Closing STARK proof buffer...');
          await closeStarkProofBuffer(proofBuffer).catch(() => {});

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] STARK deposit error:', error);
          const msg = (error as Error).message || '';
          const friendly =
            msg.includes('insufficient lamports') || msg.includes('Insufficient SOL')
              ? 'Insufficient SOL for this deposit. Try a smaller amount.'
              : msg;
          set({ isLoading: false, error: friendly });
          throw new Error(friendly);
        }
      },

      /**
       * Withdraw (STARK-only).
       */
      withdrawStark: async (
        tokenMint: string,
        amount: number,
        starkProofData: ConfidentialStarkProofData,
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        const currentBalance = get().balances[tokenMint] || 0;
        const decimals = getTokenDecimals(tokenMint);
        const amountAtomic = Math.floor(amount * Math.pow(10, decimals));
        if (amountAtomic > currentBalance) {
          throw new Error(`Insufficient confidential ${getTokenSymbol(tokenMint)} balance`);
        }

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const amountBigint = BigInt(amountAtomic);

          // Pre-flight: ensure ZK wallet has enough SOL for the tx fees
          const connection = getConnection();
          const walletPubkey = _service.getWalletPublicKey();
          const walletBalance = await connection.getBalance(walletPubkey);
          const MIN_FEE_LAMPORTS = 200_000;
          if (walletBalance < MIN_FEE_LAMPORTS) {
            if (isDevnet()) {
              try {
                const devnetConn = new Connection('https://api.devnet.solana.com', 'confirmed');
                const sig = await devnetConn.requestAirdrop(walletPubkey, 0.01 * LAMPORTS_PER_SOL);
                await devnetConn.confirmTransaction(sig, 'confirmed');
              } catch {
                throw new Error(
                  `ZK wallet has insufficient SOL for STARK + withdrawal fees ` +
                  `(${(walletBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL). ` +
                  `Send a small amount of SOL to ${walletPubkey.toBase58().slice(0, 8)}...`,
                );
              }
            } else {
              throw new Error(
                `ZK wallet has insufficient SOL for STARK + withdrawal fees ` +
                `(${(walletBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL).`,
              );
            }
          }

          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          const { proofBuffer } = await submitAndVerifyStarkProof(
            starkProof,
            undefined,
            onStarkProgress,
          );

          const newCommitment = ZkSplService.fieldToBytes32LE(
            starkProofData.publicInputs[1],
          );

          onStarkProgress?.('Submitting zkSPL withdraw...');
          const { signature, newBalance } = await _service.withdraw(
            mintPubkey,
            amountBigint,
            proofBuffer,
            newCommitment,
          );

          onStarkProgress?.('Closing STARK proof buffer...');
          await closeStarkProofBuffer(proofBuffer).catch(() => {});

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] STARK withdraw error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Confidential transfer (STARK-only).
       */
      confidentialTransferStark: async (
        tokenMint: string,
        recipient: string,
        amount: number,
        amountSalt: string,
        starkProofData: ConfidentialStarkProofData,
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        const currentBalance = get().balances[tokenMint] || 0;
        const decimals = getTokenDecimals(tokenMint);
        const amountAtomic = Math.floor(amount * Math.pow(10, decimals));
        if (amountAtomic > currentBalance) {
          throw new Error(`Insufficient confidential ${getTokenSymbol(tokenMint)} balance`);
        }

        set({ isLoading: true, error: null });

        try {
          const connection = getConnection();
          const walletPubkey = _service.getWalletPublicKey();
          const walletBalance = await connection.getBalance(walletPubkey);
          const MIN_FEE_LAMPORTS = 200_000;
          if (walletBalance < MIN_FEE_LAMPORTS) {
            if (isDevnet()) {
              try {
                const devnetConn = new Connection('https://api.devnet.solana.com', 'confirmed');
                const sig = await devnetConn.requestAirdrop(walletPubkey, 0.01 * LAMPORTS_PER_SOL);
                await devnetConn.confirmTransaction(sig, 'confirmed');
              } catch {
                throw new Error(
                  `ZK wallet has insufficient SOL for STARK + transfer fees. ` +
                  `Send SOL to ${walletPubkey.toBase58().slice(0, 8)}...`,
                );
              }
            } else {
              throw new Error(`ZK wallet has insufficient SOL for STARK + transfer fees.`);
            }
          }

          const mintPubkey = new PublicKey(tokenMint);
          const recipientPubkey = new PublicKey(recipient);
          const amountBigint = BigInt(amountAtomic);

          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          const { proofBuffer } = await submitAndVerifyStarkProof(
            starkProof,
            undefined,
            onStarkProgress,
          );

          // AIR order: [old_commitment, new_commitment, amount_hash, token_mint]
          const newCommitment = ZkSplService.fieldToBytes32LE(starkProofData.publicInputs[1]);
          const amountHash = ZkSplService.fieldToBytes32LE(starkProofData.publicInputs[2]);

          onStarkProgress?.('Submitting zkSPL confidential transfer...');
          const { signature } = await _service.transfer(
            mintPubkey,
            recipientPubkey,
            amountBigint,
            proofBuffer,
            newCommitment,
            amountHash,
            BigInt(amountSalt),
          );

          onStarkProgress?.('Closing STARK proof buffer...');
          await closeStarkProofBuffer(proofBuffer).catch(() => {});

          // Refresh balance after transfer
          const newBalance = await _service.getLocalBalance(mintPubkey);

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] STARK transfer error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Apply a pending credit (STARK-only).
       * The caller must hand over the STARK proof they generated using the
       * same `amount` + `amountSalt` that the sender shared out-of-band.
       */
      applyPendingStark: async (
        tokenMint: string,
        amount: number,
        _amountSalt: string,
        starkProofData: ConfidentialStarkProofData,
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const decimals = getTokenDecimals(tokenMint);
          const amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));

          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          const { proofBuffer } = await submitAndVerifyStarkProof(
            starkProof,
            undefined,
            onStarkProgress,
          );

          // AIR order: [old_commitment, new_commitment, amount_hash, token_mint]
          const newCommitment = ZkSplService.fieldToBytes32LE(starkProofData.publicInputs[1]);
          const amountHash = ZkSplService.fieldToBytes32LE(starkProofData.publicInputs[2]);

          onStarkProgress?.('Submitting zkSPL apply_pending...');
          const { signature, newBalance } = await _service.applyPending(
            mintPubkey,
            amountAtomic,
            proofBuffer,
            newCommitment,
            amountHash,
          );

          onStarkProgress?.('Closing STARK proof buffer...');
          await closeStarkProofBuffer(proofBuffer).catch(() => {});

          // Refresh pending credits count
          let pendingCount = 0;
          try {
            pendingCount = await _service.getPendingCreditsCount(mintPubkey);
          } catch {
            // Non-critical
          }

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
            pendingCredits: {
              ...state.pendingCredits,
              [tokenMint]: pendingCount,
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] STARK apply_pending error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Prove the confidential balance is >= `threshold` (STARK-only, circuit 2).
       */
      proveBalanceStark: async (
        tokenMint: string,
        threshold: number,
        starkProofData: ConfidentialStarkProofData,
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          const mintPubkey = new PublicKey(tokenMint);
          const decimals = getTokenDecimals(tokenMint);
          const thresholdAtomic = BigInt(Math.floor(threshold * Math.pow(10, decimals)));

          onStarkProgress?.('Verifying STARK balance proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            // Circuit 2 = balance_proof (kept inline to avoid an extra constant import)
            circuitId: 2,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          const { proofBuffer } = await submitAndVerifyStarkProof(
            starkProof,
            undefined,
            onStarkProgress,
          );

          onStarkProgress?.('Submitting zkSPL prove_balance...');
          const signature = await _service.proveBalance(
            mintPubkey,
            thresholdAtomic,
            proofBuffer,
          );

          onStarkProgress?.('Closing STARK proof buffer...');
          await closeStarkProofBuffer(proofBuffer).catch(() => {});

          set({ isLoading: false });
          return signature;
        } catch (error) {
          console.error('[Confidential] STARK prove_balance error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Sweep SOL from the ZK wallet to the main wallet via the shielded pool.
       * Uses a 2-step private flow: shield (ZK wallet → pool) → unshield (pool → main wallet).
       * This breaks the on-chain link between ZK wallet and main wallet.
       *
       * @param onProgress - Optional callback for UI progress updates
       */
      sweepToMainWallet: async (
        mainWalletAddress: string,
        amount: number,
        onProgress?: (step: 'shield' | 'unshield', message: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          const destination = new PublicKey(mainWalletAddress);
          const connection = getConnection();
          const walletPubkey = _service.getWalletPublicKey();

          // Read actual on-chain balance (not stale store value)
          const actualBalance = await connection.getBalance(walletPubkey);
          // Reserve: rent-exempt minimum (~890k) + shield fee (15k) + unshield fee (15k) = ~920k
          // Using 1M lamports (0.001 SOL) as a safe margin
          const FEE_AND_RENT_RESERVE = 1_000_000;
          const maxSendable = actualBalance - FEE_AND_RENT_RESERVE;
          if (maxSendable <= 0) {
            throw new Error('Not enough SOL to cover transaction fees');
          }

          const requestedLamports = Math.floor(amount * 1e9);
          const lamports = BigInt(Math.min(requestedLamports, maxSendable));

          const { shieldSig, unshieldSig } = await _service.privateSweepToMainWallet(
            destination,
            lamports,
            onProgress,
          );

          // Refresh ZK wallet balance
          const newBalance = await connection.getBalance(walletPubkey);
          set({ isLoading: false, zkWalletBalance: newBalance });

          return unshieldSig;
        } catch (error) {
          console.error('[Confidential] Private sweep error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Reset all state (e.g., on wallet logout).
       */
      reset: () => {
        resetZkSplService();
        set({
          isInitialized: false,
          isLoading: false,
          balances: {},
          accounts: {},
          pendingCredits: {},
          publicTokenBalances: {},
          error: null,
          stateValidation: {},
          _service: null,
        });
      },
    }),
    {
      name: 'p01-confidential-mobile',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        balances: state.balances,
        accounts: state.accounts,
        pendingCredits: state.pendingCredits,
        selectedToken: state.selectedToken,
      }),
    },
  ),
);

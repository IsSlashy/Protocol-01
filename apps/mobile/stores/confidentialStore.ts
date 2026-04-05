import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { getConnection, isDevnet } from '../services/solana/connection';
import {
  getZkSplService,
  resetZkSplService,
  NATIVE_SOL_MINT,
  NATIVE_SOL_MINT_STR,
  USDC_DEVNET_MINT,
  USDC_DEVNET_MINT_STR,
  SUPPORTED_TOKENS,
  getTokenDecimals,
  getTokenSymbol,
  type ZkSplService,
} from '../services/zkspl';
import {
  submitGenericStarkProof,
  type GenericStarkProof,
  CIRCUIT_CONFIDENTIAL_BALANCE,
  CIRCUIT_TRANSFER,
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
  deposit: (tokenMint: string, amount: number) => Promise<string>;
  withdraw: (tokenMint: string, amount: number) => Promise<string>;
  confidentialTransfer: (
    tokenMint: string,
    recipient: string,
    amount: number,
  ) => Promise<string>;
  /** Deposit with supplementary STARK proof (quantum-resistant redundancy) */
  depositStark: (
    tokenMint: string,
    amount: number,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /** Withdraw with supplementary STARK proof (quantum-resistant redundancy) */
  withdrawStark: (
    tokenMint: string,
    amount: number,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /** Transfer with supplementary STARK proof (quantum-resistant redundancy) */
  confidentialTransferStark: (
    tokenMint: string,
    recipient: string,
    amount: number,
    starkProofData: ConfidentialStarkProofData,
    onStarkProgress?: (step: string) => void,
  ) => Promise<string>;
  /** Get STARK proof inputs for confidential balance operations */
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
  /** Get STARK proof inputs for transfer operations */
  getTransferProofInputs: (
    tokenMint: string,
    amount: number,
    recipientPubkey: string,
  ) => Promise<{
    spendingKey: string;
    tokenMint: string;
    inAmount1: string;
    inRand1: string;
    inAmount2: string;
    inRand2: string;
    outAmount1: string;
    outRand1: string;
    outRecipient1: string;
    outAmount2: string;
    outRand2: string;
    outRecipient2: string;
    publicAmount: string;
  }>;
  applyPending: (
    tokenMint: string,
    amount: number,
    amountSalt: string,
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
       * Deposit tokens into the confidential account.
       */
      deposit: async (tokenMint: string, amount: number) => {
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
          let amountAtomic = BigInt(Math.floor(amount * Math.pow(10, decimals)));

          // Pre-flight SOL balance check for native SOL deposits
          if (tokenMint === NATIVE_SOL_MINT_STR) {
            const connection = getConnection();
            const walletPubkey = _service.getWalletPublicKey();
            const walletBalance = await connection.getBalance(walletPubkey);
            set({ zkWalletBalance: walletBalance }); // refresh displayed balance
            const FEE_RESERVE = 15_000; // lamports reserved for tx fee
            const maxDepositable = walletBalance - FEE_RESERVE;
            if (maxDepositable <= 0) {
              throw new Error(`ZK wallet has no SOL available for deposit. Send SOL to your ZK wallet first.`);
            }
            // Auto-cap to max depositable if user entered too much
            if (Number(amountAtomic) > maxDepositable) {
              amountAtomic = BigInt(maxDepositable);
            }
          }

          const { signature, newBalance } = await _service.deposit(
            mintPubkey,
            amountAtomic,
          );

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] Deposit error:', error);
          const msg = (error as Error).message || '';
          // Friendly error for insufficient SOL
          if (msg.includes('insufficient lamports') || msg.includes('Insufficient SOL')) {
            const friendly = msg.includes('Insufficient SOL')
              ? msg
              : 'Insufficient SOL for this deposit. Try a smaller amount.';
            set({ isLoading: false, error: friendly });
            throw new Error(friendly);
          }
          set({ isLoading: false, error: msg });
          throw error;
        }
      },

      /**
       * Withdraw tokens from the confidential account.
       */
      withdraw: async (tokenMint: string, amount: number) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

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

          // Pre-flight: ensure ZK wallet has enough SOL for the tx fee
          const connection = getConnection();
          const walletPubkey = _service.getWalletPublicKey();
          const walletBalance = await connection.getBalance(walletPubkey);
          const MIN_FEE_LAMPORTS = 10_000; // ~2 tx fees worth

          if (walletBalance < MIN_FEE_LAMPORTS) {
            if (isDevnet()) {
              // On devnet, auto-airdrop to cover fees
              try {
                const devnetConn = new Connection('https://api.devnet.solana.com', 'confirmed');
                const sig = await devnetConn.requestAirdrop(walletPubkey, 0.01 * LAMPORTS_PER_SOL);
                await devnetConn.confirmTransaction(sig, 'confirmed');
              } catch (airdropErr: any) {
                throw new Error(
                  `ZK wallet has insufficient SOL for transaction fee (${(walletBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL). ` +
                  `Send a small amount of SOL to ${walletPubkey.toBase58().slice(0, 8)}... to cover fees.`
                );
              }
            } else {
              throw new Error(
                `ZK wallet has insufficient SOL for transaction fee (${(walletBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL). ` +
                `Send a small amount of SOL to ${walletPubkey.toBase58().slice(0, 8)}... to cover fees.`
              );
            }
          }

          const { signature, newBalance } = await _service.withdraw(
            mintPubkey,
            amountBigint,
          );

          set((state) => ({
            isLoading: false,
            balances: {
              ...state.balances,
              [tokenMint]: Number(newBalance),
            },
          }));

          return signature;
        } catch (error) {
          console.error('[Confidential] Withdraw error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Send a confidential transfer to another user.
       */
      confidentialTransfer: async (
        tokenMint: string,
        recipient: string,
        amount: number,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZkSPL service not initialized. Please restart the app.');
        }

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
          // Pre-flight: ensure ZK wallet has enough SOL for the tx fee
          const connection = getConnection();
          const walletPubkey = _service.getWalletPublicKey();
          const walletBalance = await connection.getBalance(walletPubkey);
          const MIN_FEE_LAMPORTS = 10_000;

          if (walletBalance < MIN_FEE_LAMPORTS) {
            if (isDevnet()) {
              try {
                const devnetConn = new Connection('https://api.devnet.solana.com', 'confirmed');
                const sig = await devnetConn.requestAirdrop(walletPubkey, 0.01 * LAMPORTS_PER_SOL);
                await devnetConn.confirmTransaction(sig, 'confirmed');
              } catch {
                throw new Error(
                  `ZK wallet has insufficient SOL for transaction fee. ` +
                  `Send SOL to ${walletPubkey.toBase58().slice(0, 8)}... to cover fees.`
                );
              }
            } else {
              throw new Error(
                `ZK wallet has insufficient SOL for transaction fee. ` +
                `Send SOL to ${walletPubkey.toBase58().slice(0, 8)}... to cover fees.`
              );
            }
          }

          const mintPubkey = new PublicKey(tokenMint);
          const recipientPubkey = new PublicKey(recipient);
          const amountBigint = BigInt(amountAtomic);

          const { signature } = await _service.transfer(
            mintPubkey,
            recipientPubkey,
            amountBigint,
          );

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
          console.error('[Confidential] Transfer error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
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
       * Get STARK proof inputs for transfer (circuit 5).
       * Must be called before confidentialTransfer to capture the pre-op state.
       */
      getTransferProofInputs: async (
        tokenMint: string,
        amount: number,
        recipientPubkey: string,
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
          new PublicKey(recipientPubkey),
        );
      },

      /**
       * Deposit with supplementary STARK proof (quantum-resistant).
       * Generates STARK proof for circuit 4, verifies on-chain, then deposits via Groth16.
       */
      depositStark: async (
        tokenMint: string,
        amount: number,
        starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          // Step 1: Submit STARK proof to on-chain verifier (quantum-resistant audit)
          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          await submitGenericStarkProof(starkProof, undefined, onStarkProgress);

          // Step 2: Execute the Groth16 deposit (existing flow)
          onStarkProgress?.('Executing deposit...');
          const signature = await get().deposit(tokenMint, amount);
          return signature;
        } catch (error) {
          console.error('[Confidential] STARK deposit error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Withdraw with supplementary STARK proof (quantum-resistant).
       */
      withdrawStark: async (
        tokenMint: string,
        amount: number,
        starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          await submitGenericStarkProof(starkProof, undefined, onStarkProgress);

          onStarkProgress?.('Executing withdrawal...');
          const signature = await get().withdraw(tokenMint, amount);
          return signature;
        } catch (error) {
          console.error('[Confidential] STARK withdraw error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Confidential transfer with supplementary STARK proof (quantum-resistant).
       */
      confidentialTransferStark: async (
        tokenMint: string,
        recipient: string,
        amount: number,
        starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
        onStarkProgress?: (step: string) => void,
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) throw new Error('ZkSPL service not initialized');
        const { _service } = get();
        if (!_service) throw new Error('ZkSPL service not available');

        set({ isLoading: true, error: null });

        try {
          onStarkProgress?.('Verifying STARK proof on-chain...');
          const starkProof: GenericStarkProof = {
            proofBytes: starkProofData.proofBytes,
            circuitId: CIRCUIT_TRANSFER,
            publicInputs: starkProofData.publicInputs,
            proofSize: starkProofData.proofSize,
          };
          await submitGenericStarkProof(starkProof, undefined, onStarkProgress);

          onStarkProgress?.('Executing transfer...');
          const signature = await get().confidentialTransfer(tokenMint, recipient, amount);
          return signature;
        } catch (error) {
          console.error('[Confidential] STARK transfer error:', error);
          set({ isLoading: false, error: (error as Error).message });
          throw error;
        }
      },

      /**
       * Apply a pending credit to the confidential balance.
       */
      applyPending: async (
        tokenMint: string,
        amount: number,
        amountSalt: string,
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
          const salt = BigInt(amountSalt);

          const { signature, newBalance } = await _service.applyPending(
            mintPubkey,
            amountAtomic,
            salt,
          );

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
          console.error('[Confidential] Apply pending error:', error);
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

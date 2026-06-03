import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as SecureStore from 'expo-secure-store';
import { generateMnemonic as scureGenerateMnemonic, mnemonicToSeedSync, validateMnemonic as scureValidateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { getConnection } from './connection';

// Secure storage keys
const STORAGE_KEYS = {
  MNEMONIC: 'p01_mnemonic',
  PRIVATE_KEY: 'p01_private_key',
  PUBLIC_KEY: 'p01_public_key',
  WALLET_EXISTS: 'p01_wallet_exists',
};

// Shared secure options for consistent read/write
const SECURE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// Solana derivation path (BIP44) - same as extension
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
const ED25519_CURVE = 'ed25519 seed';
const HARDENED_OFFSET = 0x80000000;

export interface WalletInfo {
  publicKey: string;
  mnemonic?: string;
}

/**
 * HMAC-SHA512 using @noble/hashes
 */
function hmacSha512(key: Uint8Array | string, data: Uint8Array): Uint8Array {
  const keyBytes = typeof key === 'string'
    ? new TextEncoder().encode(key)
    : key;
  return hmac(sha512, keyBytes, data);
}

/**
 * Parse derivation path into array of indices
 */
function parsePath(path: string): number[] {
  const parts = path.replace('m/', '').split('/');
  return parts.map(part => {
    const isHardened = part.endsWith("'");
    const index = parseInt(isHardened ? part.slice(0, -1) : part, 10);
    return isHardened ? index + HARDENED_OFFSET : index;
  });
}

/**
 * Derive master key from seed using HMAC-SHA512
 * This is equivalent to what ed25519-hd-key does internally
 */
function getMasterKeyFromSeed(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmacSha512(ED25519_CURVE, seed);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  return { key: IL, chainCode: IR };
}

/**
 * Derive child key at given index
 */
function deriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number
): { key: Uint8Array; chainCode: Uint8Array } {
  // For hardened keys, prepend 0x00 to the key
  const data = new Uint8Array(37);
  data[0] = 0;
  data.set(parentKey, 1);
  // Add index as big-endian 4 bytes
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;

  const I = hmacSha512(parentChainCode, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  return { key: IL, chainCode: IR };
}

/**
 * Derive key from seed using path - compatible with ed25519-hd-key
 */
function derivePath(path: string, seed: Uint8Array): { key: Uint8Array } {
  const { key, chainCode } = getMasterKeyFromSeed(seed);
  const indices = parsePath(path);

  let currentKey = key;
  let currentChainCode = chainCode;

  for (const index of indices) {
    const derived = deriveChild(currentKey, currentChainCode, index);
    currentKey = derived.key;
    currentChainCode = derived.chainCode;
  }

  return { key: currentKey };
}

/**
 * Generate a new mnemonic phrase (12 words - same as extension)
 */
export function generateMnemonic(): string {
  return scureGenerateMnemonic(wordlist, 128); // 128 bits = 12 words
}

/**
 * Validate a mnemonic phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  return scureValidateMnemonic(mnemonic, wordlist);
}

/**
 * Derive keypair from mnemonic - uses same method as extension
 */
export async function deriveKeypairFromMnemonic(mnemonic: string): Promise<Keypair> {
  // Convert mnemonic to seed (64 bytes)
  const seed = mnemonicToSeedSync(mnemonic);
  // Derive key using SLIP-0010/BIP32-Ed25519 path
  const derivedSeed = derivePath(SOLANA_DERIVATION_PATH, seed).key;
  // Create keypair from the 32-byte derived seed
  const keyPair = nacl.sign.keyPair.fromSeed(derivedSeed);
  return Keypair.fromSecretKey(keyPair.secretKey);
}

/**
 * Write to SecureStore with retry (some Android devices have transient failures)
 */
async function secureSetWithRetry(key: string, value: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await SecureStore.setItemAsync(key, value, SECURE_OPTIONS);
      // Verify the write succeeded
      const stored = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
      if (stored === value) return;
      console.warn(`[Wallet] SecureStore verify failed for ${key}, attempt ${attempt}`);
    } catch (err) {
      console.warn(`[Wallet] SecureStore write failed for ${key}, attempt ${attempt}:`, err);
      if (attempt === maxRetries) throw err;
    }
    await new Promise(r => setTimeout(r, 200 * attempt));
  }
  throw new Error(`Failed to securely store ${key} after ${3} attempts`);
}

/**
 * Create a new wallet and store it securely
 */
export async function createWallet(): Promise<WalletInfo> {
  const mnemonic = generateMnemonic();
  const keypair = await deriveKeypairFromMnemonic(mnemonic);

  // Store all keys with retry + verification (atomic-ish: mnemonic first, flag last)
  await secureSetWithRetry(STORAGE_KEYS.MNEMONIC, mnemonic);
  await secureSetWithRetry(STORAGE_KEYS.PRIVATE_KEY, bs58.encode(keypair.secretKey));
  await secureSetWithRetry(STORAGE_KEYS.PUBLIC_KEY, keypair.publicKey.toBase58());
  await secureSetWithRetry(STORAGE_KEYS.WALLET_EXISTS, 'true');

  // Pre-stamp the recovery-scan flag for this brand-new pubkey — there is
  // nothing on-chain to recover, the user just minted this keypair. Mirrors
  // the pre-stamp in walletStore.createNewWallet so every code path that
  // creates a fresh local wallet (including the onboarding create-wallet
  // screen, which calls this service directly) skips the boot recovery
  // modal on first launch.
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    await AsyncStorage.setItem(
      `p01_auto_recovery_v1_${keypair.publicKey.toBase58()}`,
      Date.now().toString(),
    );
  } catch {
    // Non-fatal — worst case the modal fires once, finds nothing, self-silences.
  }

  return {
    publicKey: keypair.publicKey.toBase58(),
    mnemonic,
  };
}

/**
 * Import wallet from mnemonic with comprehensive validation
 */
export async function importWallet(mnemonic: string): Promise<WalletInfo> {
  // Input validation
  if (!mnemonic || typeof mnemonic !== 'string') {
    throw new Error('Mnemonic is required');
  }

  // Normalize mnemonic - remove extra whitespace, convert to lowercase
  const normalizedMnemonic = mnemonic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ''); // Remove any non-alphanumeric characters

  // Validate word count (12, 15, 18, 21, or 24 words)
  const wordCount = normalizedMnemonic.split(' ').length;
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    throw new Error(`Invalid word count: ${wordCount}. Expected 12, 15, 18, 21, or 24 words.`);
  }

  // Validate mnemonic checksum
  if (!validateMnemonic(normalizedMnemonic)) {
    throw new Error('Invalid mnemonic phrase. Please check the words and their order.');
  }

  const keypair = await deriveKeypairFromMnemonic(normalizedMnemonic);

  await SecureStore.setItemAsync(STORAGE_KEYS.MNEMONIC, normalizedMnemonic, SECURE_OPTIONS);
  await SecureStore.setItemAsync(
    STORAGE_KEYS.PRIVATE_KEY,
    bs58.encode(keypair.secretKey),
    SECURE_OPTIONS
  );
  await SecureStore.setItemAsync(
    STORAGE_KEYS.PUBLIC_KEY,
    keypair.publicKey.toBase58(),
    SECURE_OPTIONS
  );
  await SecureStore.setItemAsync(STORAGE_KEYS.WALLET_EXISTS, 'true', SECURE_OPTIONS);

  return {
    publicKey: keypair.publicKey.toBase58(),
  };
}

/**
 * Check if wallet exists
 */
export async function walletExists(): Promise<boolean> {
  try {
    const exists = await SecureStore.getItemAsync(STORAGE_KEYS.WALLET_EXISTS, SECURE_OPTIONS);
    return exists === 'true';
  } catch (error) {
    console.error('[Wallet] walletExists error:', error);
    return false;
  }
}

/**
 * Get stored public key
 */
export async function getPublicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.PUBLIC_KEY, SECURE_OPTIONS);
}

/**
 * Get keypair from secure storage
 */
export async function getKeypair(): Promise<Keypair | null> {
  const privateKeyStr = await SecureStore.getItemAsync(STORAGE_KEYS.PRIVATE_KEY, SECURE_OPTIONS);
  if (!privateKeyStr) return null;

  const secretKey = bs58.decode(privateKeyStr);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * The resolved local note-seed material for the active wallet.
 *
 * `noteSeed` is the GOLD-PATH shielded-identity seed: the first 32 bytes of the
 * Ed25519 secret key, identical to the historical `secretKey.slice(0, 32)` used
 * everywhere in the ZK stack. This is intentionally NOT the SDK `deriveP01Identity`
 * HKDF output — it is the app-local, byte-for-byte legacy seed (see spec R-15;
 * renamed to `deriveLocalNoteSeed` precisely so it can never be confused with /
 * swapped for the NON-INTERCHANGEABLE SDK HKDF identity).
 */
export interface LocalNoteSeed {
  keypair: Keypair;
  publicKey: PublicKey;
  noteSeed: Uint8Array; // secretKey[0..32) — the gold-path shielded seed
}

/**
 * Resolve the active local wallet's note seed (gold path).
 *
 * Collapses every former Privy/random-seed derivation branch to the single local
 * keypair path. `noteSeed = secretKey.slice(0, 32)` is kept byte-for-byte so
 * existing shielded notes remain spendable.
 *
 * NOTE(Phase4-Hardware): a Ledger / hardware wallet does NOT expose a raw secret
 * key, so this path cannot produce a `noteSeed` for it. Hardware support will use
 * `getSpendingSeed()` (a random, encrypted-at-rest local seed) instead — wired in
 * Phase 4. Until then, a hardware-kind wallet has no local keypair and this throws.
 */
export async function deriveLocalNoteSeed(): Promise<LocalNoteSeed> {
  const keypair = await getKeypair();
  if (!keypair) {
    // No local keypair available. Phase 4 will route hardware wallets to
    // getSpendingSeed(); for now this is an unrecoverable state for callers.
    throw new Error('No local wallet keypair available — cannot derive note seed.');
  }
  return {
    keypair,
    publicKey: keypair.publicKey,
    noteSeed: keypair.secretKey.slice(0, 32),
  };
}

/**
 * Phase 4 seam: returns the spending seed for the active wallet.
 *
 * For local/seed wallets this is the gold-path `noteSeed` (`secretKey[0..32)`).
 * For hardware (Ledger) wallets — wired in Phase 4 — this will return a random,
 * CSPRNG-generated seed encrypted at rest in SecureStore (never signature-derived;
 * see spec §1.2 / R-02 / R-04). Today it always resolves the local keypair path.
 */
export async function getSpendingSeed(): Promise<Uint8Array> {
  // TODO(Phase4-Hardware): branch on persisted walletKind; for 'hardware' decrypt
  // and return the random local spending seed instead of the keypair-derived one.
  const { noteSeed } = await deriveLocalNoteSeed();
  return noteSeed;
}

/**
 * Get mnemonic from secure storage (for backup display)
 */
export async function getMnemonic(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.MNEMONIC, SECURE_OPTIONS);
}

/**
 * Delete wallet from secure storage
 * Also resets onboarding state so user can start fresh
 */
export async function deleteWallet(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.MNEMONIC, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.PRIVATE_KEY, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.PUBLIC_KEY, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.WALLET_EXISTS, SECURE_OPTIONS);
  // Reset onboarding state for fresh start
  await SecureStore.deleteItemAsync('p01_onboarded');
  // Clean up any temp data
  await SecureStore.deleteItemAsync('p01_temp_mnemonic');
  await SecureStore.deleteItemAsync('security_method');
  await SecureStore.deleteItemAsync('wallet_pin');
}

/**
 * Format public key for display (shortened)
 */
export function formatPublicKey(publicKey: string, chars: number = 4): string {
  if (publicKey.length <= chars * 2 + 3) return publicKey;
  return `${publicKey.slice(0, chars)}...${publicKey.slice(-chars)}`;
}

/**
 * Get associated token address for a wallet and mint
 */
export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

/**
 * Check if an associated token account exists
 */
export async function tokenAccountExists(
  connection: Connection,
  tokenAccount: PublicKey
): Promise<boolean> {
  try {
    const accountInfo = await connection.getAccountInfo(tokenAccount);
    return accountInfo !== null;
  } catch {
    return false;
  }
}

/**
 * Send SOL to an address
 */
export async function sendSol(params: {
  connection: Connection;
  fromKeypair: Keypair;
  toAddress: string;
  amount: number; // In SOL
}): Promise<string> {
  const { connection, fromKeypair, toAddress, amount } = params;
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports,
    })
  );

  transaction.feePayer = fromKeypair.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  transaction.sign(fromKeypair);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  return signature;
}

/**
 * Send SPL tokens to an address
 */
export async function sendSplToken(params: {
  connection: Connection;
  fromKeypair: Keypair;
  toAddress: string;
  mintAddress: string;
  amount: number; // In token units (will be converted using decimals)
  decimals: number;
}): Promise<string> {
  const { connection, fromKeypair, toAddress, mintAddress, amount, decimals } = params;

  const mint = new PublicKey(mintAddress);
  const toWallet = new PublicKey(toAddress);

  // Get token accounts
  const fromTokenAccount = getAssociatedTokenAddress(mint, fromKeypair.publicKey);
  const toTokenAccount = getAssociatedTokenAddress(mint, toWallet);

  // Convert amount to token units
  const tokenAmount = BigInt(Math.floor(amount * 10 ** decimals));

  const instructions: TransactionInstruction[] = [];

  // Check if recipient's token account exists, if not create it
  const toAccountExists = await tokenAccountExists(connection, toTokenAccount);
  if (!toAccountExists) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromKeypair.publicKey, // payer
        toTokenAccount,        // associated token account
        toWallet,              // owner
        mint                   // mint
      )
    );
  }

  // Add transfer instruction
  instructions.push(
    createTransferInstruction(
      fromTokenAccount,
      toTokenAccount,
      fromKeypair.publicKey,
      tokenAmount
    )
  );

  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = fromKeypair.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  transaction.sign(fromKeypair);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  return signature;
}

/**
 * Get token balance for a wallet
 */
export async function getTokenBalance(params: {
  connection: Connection;
  walletAddress: string;
  mintAddress: string;
}): Promise<{ balance: number; decimals: number } | null> {
  const { connection, walletAddress, mintAddress } = params;

  try {
    const mint = new PublicKey(mintAddress);
    const wallet = new PublicKey(walletAddress);
    const tokenAccount = getAssociatedTokenAddress(mint, wallet);

    const accountInfo = await connection.getTokenAccountBalance(tokenAccount);
    return {
      balance: accountInfo.value.uiAmount ?? 0,
      decimals: accountInfo.value.decimals,
    };
  } catch (error) {
    // Token account doesn't exist or other error
    return null;
  }
}

/**
 * Get all token accounts for a wallet
 */
export async function getTokenAccounts(params: {
  connection: Connection;
  walletAddress: string;
}): Promise<Array<{
  mint: string;
  balance: number;
  decimals: number;
}>> {
  const { connection, walletAddress } = params;
  const wallet = new PublicKey(walletAddress);

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, {
      programId: TOKEN_PROGRAM_ID,
    });

    return tokenAccounts.value.map(account => ({
      mint: account.account.data.parsed.info.mint,
      balance: account.account.data.parsed.info.tokenAmount.uiAmount ?? 0,
      decimals: account.account.data.parsed.info.tokenAmount.decimals,
    }));
  } catch (error) {
    console.error('[Wallet] Error fetching token accounts:', error);
    return [];
  }
}

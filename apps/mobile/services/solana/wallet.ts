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
import CryptoJS from 'crypto-js';
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
 * Convert Uint8Array to CryptoJS WordArray
 */
function uint8ArrayToWordArray(u8Array: Uint8Array): CryptoJS.lib.WordArray {
  const words: number[] = [];
  for (let i = 0; i < u8Array.length; i += 4) {
    words.push(
      ((u8Array[i] || 0) << 24) |
      ((u8Array[i + 1] || 0) << 16) |
      ((u8Array[i + 2] || 0) << 8) |
      (u8Array[i + 3] || 0)
    );
  }
  return CryptoJS.lib.WordArray.create(words, u8Array.length);
}

/**
 * Convert CryptoJS WordArray to Uint8Array
 */
function wordArrayToUint8Array(wordArray: CryptoJS.lib.WordArray): Uint8Array {
  const words = wordArray.words;
  const sigBytes = wordArray.sigBytes;
  const u8Array = new Uint8Array(sigBytes);

  for (let i = 0; i < sigBytes; i++) {
    u8Array[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }

  return u8Array;
}

/**
 * HMAC-SHA512 using CryptoJS
 */
function hmacSha512(key: Uint8Array | string, data: Uint8Array): Uint8Array {
  const keyWordArray = typeof key === 'string'
    ? CryptoJS.enc.Utf8.parse(key)
    : uint8ArrayToWordArray(key);
  const dataWordArray = uint8ArrayToWordArray(data);
  const hmacResult = CryptoJS.HmacSHA512(dataWordArray, keyWordArray);
  return wordArrayToUint8Array(hmacResult);
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
 * Create a new wallet and store it securely
 */
export async function createWallet(): Promise<WalletInfo> {
  console.log('[Wallet] Creating new wallet...');
  const mnemonic = generateMnemonic();
  const keypair = await deriveKeypairFromMnemonic(mnemonic);

  console.log('[Wallet] Storing wallet data...');
  await SecureStore.setItemAsync(STORAGE_KEYS.MNEMONIC, mnemonic, SECURE_OPTIONS);
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
  console.log('[Wallet] Wallet created successfully, publicKey:', keypair.publicKey.toBase58());

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

  console.log('[Wallet] Deriving keypair from mnemonic...');
  const keypair = await deriveKeypairFromMnemonic(normalizedMnemonic);
  console.log('[Wallet] Derived publicKey:', keypair.publicKey.toBase58());

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
    console.log('[Wallet] walletExists check - raw value:', exists);
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

  console.log('[Wallet] SPL token transfer successful:', signature);
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

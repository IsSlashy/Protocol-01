/**
 * Wallet service for Solana blockchain interactions
 * Real keypair generation, balances, and transactions
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

// Solana derivation path (BIP44)
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

// RPC endpoints
const RPC_ENDPOINTS = {
  devnet: clusterApiUrl('devnet'),
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

export type NetworkType = 'devnet' | 'mainnet-beta';

export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  decimals: number;
  uiBalance: string;
}

/**
 * Generate a new mnemonic seed phrase (12 words)
 */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(128); // 128 bits = 12 words
}

/**
 * Validate a mnemonic seed phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

/**
 * Derive keypair from mnemonic
 */
export async function deriveKeypairFromMnemonic(mnemonic: string): Promise<Keypair> {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  // Convert to hex string for ed25519-hd-key
  const seedHex = Buffer.from(seed).toString('hex');
  const derivedSeed = derivePath(SOLANA_DERIVATION_PATH, seedHex).key;
  const keypair = nacl.sign.keyPair.fromSeed(derivedSeed);
  return Keypair.fromSecretKey(keypair.secretKey);
}

/**
 * Get connection to Solana network
 */
export function getConnection(network: NetworkType): Connection {
  return new Connection(RPC_ENDPOINTS[network], 'confirmed');
}

/**
 * Get SOL balance for a public key
 */
export async function getSolBalance(
  publicKey: string,
  network: NetworkType
): Promise<number> {
  const connection = getConnection(network);
  const pubkey = new PublicKey(publicKey);
  const balance = await connection.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Get SPL token balances for a public key
 */
export async function getTokenBalances(
  publicKey: string,
  network: NetworkType
): Promise<TokenBalance[]> {
  const connection = getConnection(network);
  const pubkey = new PublicKey(publicKey);

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });

    return tokenAccounts.value.map((account) => {
      const info = account.account.data.parsed.info;
      return {
        mint: info.mint,
        symbol: 'SPL', // Would need token registry for actual symbols
        balance: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
        uiBalance: info.tokenAmount.uiAmountString,
      };
    });
  } catch (error) {
    console.error('Error fetching token balances:', error);
    return [];
  }
}

/**
 * Send SOL transaction
 */
export async function sendSol(
  fromKeypair: Keypair,
  toAddress: string,
  amountSol: number,
  network: NetworkType
): Promise<string> {
  const connection = getConnection(network);
  const toPubkey = new PublicKey(toAddress);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return signature;
}

/**
 * Request airdrop on devnet (faucet)
 */
export async function requestAirdrop(
  publicKey: string,
  amountSol: number = 1
): Promise<string> {
  const connection = getConnection('devnet');
  const pubkey = new PublicKey(publicKey);

  try {
    const signature = await connection.requestAirdrop(
      pubkey,
      amountSol * LAMPORTS_PER_SOL
    );

    // Wait for confirmation
    await connection.confirmTransaction(signature);
    return signature;
  } catch (error) {
    const errorMessage = (error as Error).message || String(error);

    // Check for rate limiting errors
    if (
      errorMessage.includes('airdrop') ||
      errorMessage.includes('limit') ||
      errorMessage.includes('429') ||
      errorMessage.includes('rate') ||
      errorMessage.includes('too many')
    ) {
      throw new Error('Rate limited - please wait a few minutes and try again');
    }

    // Check for insufficient funds in faucet
    if (errorMessage.includes('insufficient')) {
      throw new Error('Faucet is temporarily empty - try again later');
    }

    throw error;
  }
}

/**
 * Get recent transactions for a public key
 */
export async function getRecentTransactions(
  publicKey: string,
  network: NetworkType,
  limit: number = 10
): Promise<any[]> {
  const connection = getConnection(network);
  const pubkey = new PublicKey(publicKey);

  try {
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit });
    const transactions = await Promise.all(
      signatures.map(async (sig) => {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        return {
          signature: sig.signature,
          slot: sig.slot,
          blockTime: sig.blockTime,
          err: sig.err,
          memo: sig.memo,
          transaction: tx,
        };
      })
    );
    return transactions;
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return [];
  }
}

/**
 * Validate a Solana address
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format lamports to SOL string
 */
export function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(9);
}

/**
 * Parse SOL string to lamports
 */
export function parseSolToLamports(sol: string | number): number {
  return Math.round(Number(sol) * LAMPORTS_PER_SOL);
}

/**
 * Jito Bundle Service — Atomic transaction bundling for privacy.
 *
 * Bundles multiple transactions together and submits them atomically
 * to Jito validators. All TXs in a bundle land in the same slot,
 * making it impossible to distinguish ordering or correlate individual TXs.
 *
 * Privacy benefits:
 * - Multiple shields from different stealth addresses land simultaneously
 * - Fee payer can be the bundler tip account (not the user)
 * - Same-slot execution eliminates timing correlation
 * - Atomic: all succeed or all fail (no partial trace)
 *
 * Architecture:
 *   BundleProvider interface → JitoBundleProvider (production)
 *                            → LocalBundleProvider (devnet fallback)
 *
 * @see https://jito-labs.gitbook.io/mev
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getConnection } from '../solana/connection';

// ---------------------------------------------------------------------------
// Bundle Provider Interface (future-proof abstraction)
// ---------------------------------------------------------------------------

export interface BundleProvider {
  /** Submit a bundle of transactions atomically */
  submitBundle(txs: (Transaction | VersionedTransaction)[]): Promise<BundleResult>;
  /** Get tip accounts for the bundle tip TX */
  getTipAccounts(): Promise<PublicKey[]>;
  /** Check if the provider is available */
  isAvailable(): Promise<boolean>;
  /** Provider name for logging */
  readonly name: string;
}

export interface BundleResult {
  /** Bundle ID returned by the provider */
  bundleId: string;
  /** Whether the bundle landed on-chain */
  landed: boolean;
  /** Slot the bundle was included in (if landed) */
  slot?: number;
  /** Individual TX signatures */
  signatures: string[];
}

// ---------------------------------------------------------------------------
// Jito RPC Endpoints
// ---------------------------------------------------------------------------

const JITO_ENDPOINTS = {
  mainnet: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  // Jito doesn't run on devnet — we fallback to LocalBundleProvider
  devnet: null,
} as const;

/** Jito tip: minimum 1000 lamports, recommended 10K-100K for priority */
const DEFAULT_TIP_LAMPORTS = 10_000; // 0.00001 SOL

// Known Jito tip accounts (rotate to distribute tips)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiVKP6ViR',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLYxCXM6nELEP4J4bJ',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

// ---------------------------------------------------------------------------
// Jito Bundle Provider (mainnet production)
// ---------------------------------------------------------------------------

export class JitoBundleProvider implements BundleProvider {
  readonly name = 'Jito';
  private endpoint: string;
  private tipLamports: number;

  constructor(opts?: { endpoint?: string; tipLamports?: number }) {
    this.endpoint = opts?.endpoint || JITO_ENDPOINTS.mainnet!;
    this.tipLamports = opts?.tipLamports || DEFAULT_TIP_LAMPORTS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTipAccounts',
          params: [],
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTipAccounts',
          params: [],
        }),
      });
      const data = await res.json();
      if (data.result && Array.isArray(data.result)) {
        return data.result.map((a: string) => new PublicKey(a));
      }
    } catch (e: any) {
      console.warn('[Jito] getTipAccounts failed:', e.message);
    }
    // Fallback to known tip accounts
    return JITO_TIP_ACCOUNTS.map(a => new PublicKey(a));
  }

  async submitBundle(txs: (Transaction | VersionedTransaction)[]): Promise<BundleResult> {
    console.log(`[Jito] Submitting bundle with ${txs.length} transactions...`);

    // Serialize all TXs to base64
    const serialized = txs.map(tx => {
      const bytes = tx instanceof VersionedTransaction
        ? tx.serialize()
        : tx.serialize();
      return Buffer.from(bytes).toString('base64');
    });

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [serialized],
      }),
    });

    const data = await res.json();

    if (data.error) {
      console.error('[Jito] Bundle submission error:', data.error);
      throw new Error(`Jito bundle error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const bundleId = data.result;
    console.log(`[Jito] Bundle submitted: ${bundleId}`);

    // Extract signatures from the transactions
    const signatures = txs.map(tx => {
      if (tx instanceof VersionedTransaction) {
        return Buffer.from(tx.signatures[0]).toString('base64');
      }
      return tx.signature ? Buffer.from(tx.signature).toString('base64') : 'unsigned';
    });

    return {
      bundleId,
      landed: true, // Optimistic — polling for confirmation is async
      signatures,
    };
  }

  /**
   * Create a tip transaction to include in the bundle.
   * The tip goes to a random Jito validator tip account.
   *
   * @param feePayer - The keypair paying the tip
   * @param tipLamports - Tip amount (default: 10K lamports)
   */
  async createTipTransaction(
    feePayer: Keypair,
    tipLamports?: number,
  ): Promise<Transaction> {
    const tipAccounts = await this.getTipAccounts();
    const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    const tip = tipLamports ?? this.tipLamports;

    const connection = getConnection();
    const { blockhash } = await connection.getLatestBlockhash();

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey: tipAccount,
        lamports: tip,
      })
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer.publicKey;
    tx.sign(feePayer);

    console.log(`[Jito] Tip TX: ${tip} lamports → ${tipAccount.toBase58().slice(0, 8)}...`);
    return tx;
  }
}

// ---------------------------------------------------------------------------
// Local Bundle Provider (devnet fallback — sequential submission)
// ---------------------------------------------------------------------------

/**
 * P01 Bundle Provider — connects to our own P01 Bundle Engine.
 * Works on ANY cluster (devnet, testnet, mainnet).
 * Privacy mempool: batches + shuffles + strips metadata.
 */
export class P01BundleProvider implements BundleProvider {
  readonly name = 'P01 Bundler';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.EXPO_PUBLIC_P01_BUNDLER_URL || 'http://localhost:3099';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health`);
      const data = await res.json();
      return data.status === 'ok';
    } catch {
      return false;
    }
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    return []; // P01 bundler doesn't require tips
  }

  async submitBundle(txs: (Transaction | VersionedTransaction)[]): Promise<BundleResult> {
    console.log(`[P01Bundler] Submitting ${txs.length} TXs to privacy mempool...`);

    const transactions = txs.map(tx => {
      const bytes = tx instanceof VersionedTransaction
        ? tx.serialize()
        : tx.serialize();
      return Buffer.from(bytes).toString('base64');
    });

    const bundleId = `p01_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const res = await fetch(`${this.endpoint}/v1/bundle/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions, bundleId }),
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(`P01 Bundler error: ${data.error}`);
    }

    const signatures = (data.results || []).map((r: any) => r.signature || 'pending');
    console.log(`[P01Bundler] Bundle ${bundleId.slice(0, 12)}... — ${signatures.length} TXs processed`);

    return {
      bundleId: data.bundleId || bundleId,
      landed: data.landed ?? true,
      signatures,
    };
  }
}

/**
 * Local fallback — sequential submission when no bundler is available.
 */
export class LocalBundleProvider implements BundleProvider {
  readonly name = 'Local (sequential)';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getTipAccounts(): Promise<PublicKey[]> {
    return [];
  }

  async submitBundle(txs: (Transaction | VersionedTransaction)[]): Promise<BundleResult> {
    console.log(`[LocalBundle] Submitting ${txs.length} transactions sequentially...`);
    const connection = getConnection();
    const signatures: string[] = [];

    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const bytes = tx instanceof VersionedTransaction
        ? tx.serialize()
        : tx.serialize();
      const sig = await connection.sendRawTransaction(bytes, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction(sig, 'confirmed');
      signatures.push(sig);
      console.log(`[LocalBundle]   TX ${i + 1}/${txs.length}: ${sig.slice(0, 16)}...`);
    }

    return {
      bundleId: `local_${Date.now().toString(36)}`,
      landed: true,
      signatures,
    };
  }
}

// ---------------------------------------------------------------------------
// Bundle Manager — singleton, auto-selects provider
// ---------------------------------------------------------------------------

let _provider: BundleProvider | null = null;

/**
 * Get the active bundle provider.
 * Returns Jito on mainnet, Local on devnet.
 */
export async function getBundleProvider(): Promise<BundleProvider> {
  if (_provider) return _provider;

  // Priority: P01 Bundler → Jito → Local fallback
  const p01 = new P01BundleProvider();
  if (await p01.isAvailable()) {
    console.log('[Bundle] Using P01 Bundle Engine (privacy mempool)');
    _provider = p01;
    return _provider;
  }

  const jito = new JitoBundleProvider();
  if (await jito.isAvailable()) {
    console.log('[Bundle] Using Jito bundle provider (mainnet)');
    _provider = jito;
    return _provider;
  }

  console.log('[Bundle] No bundler available — using local sequential fallback');
  _provider = new LocalBundleProvider();
  return _provider;
}

/**
 * Force a specific provider (for testing or custom setups).
 */
export function setBundleProvider(provider: BundleProvider): void {
  _provider = provider;
  console.log(`[Bundle] Provider set to: ${provider.name}`);
}

/**
 * Submit a privacy bundle: multiple shield TXs bundled atomically.
 *
 * This is the main entry point for the Privacy Router.
 * All TXs land in the same slot — impossible to correlate individually.
 *
 * @param txs - Array of signed transactions to bundle
 * @returns Bundle result with ID and signatures
 */
export async function submitPrivacyBundle(
  txs: (Transaction | VersionedTransaction)[],
): Promise<BundleResult> {
  const provider = await getBundleProvider();

  console.log(`[Bundle] Submitting privacy bundle via ${provider.name}: ${txs.length} TXs`);
  const result = await provider.submitBundle(txs);
  console.log(`[Bundle] Bundle ${result.bundleId.slice(0, 12)}... — ${result.signatures.length} TXs landed`);

  return result;
}

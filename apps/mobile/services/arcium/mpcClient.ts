/**
 * Mobile MPC Client — manages Arcium ArciumClient lifecycle.
 *
 * Lazy-initializes on first MPC operation. If initialization fails
 * (polyfill issues, program not deployed, etc.), MPC is gracefully
 * marked unavailable and callers fall back to standard flows.
 *
 * Uses @p01/arcium-sdk which depends on @arcium-hq/client for
 * Rescue-CTR encryption (required by the Arcium MXE).
 */

import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import { getKeypair } from '../solana/wallet';

// Inline to avoid circular dependency with ./index
const P01_ARCIUM_PROGRAM_ID = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');

// Lazy-loaded SDK — avoids static import issues with Node.js polyfills
let ArciumClientClass: any = null;
let clientInstance: any = null;
let initPromise: Promise<any> | null = null;
let initError: string | null = null;

/** Wallet adapter for Anchor (required by ArciumClient) */
function createWalletAdapter(keypair: any) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.sign(keypair);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      txs.forEach((tx) => tx.sign(keypair));
      return txs;
    },
  };
}

/**
 * Lazily initialize the Arcium MPC client.
 * Returns the client or null if unavailable.
 */
export async function getMpcClient(): Promise<any | null> {
  if (clientInstance) return clientInstance;
  if (initError) return null;

  // Avoid concurrent initialization
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Dynamic import to isolate polyfill issues
      const sdk = await import('@p01/arcium-sdk');
      ArciumClientClass = sdk.ArciumClient;

      const keypair = await getKeypair();
      if (!keypair) {
        initError = 'Wallet not available';
        return null;
      }

      const connection = getConnection();
      const wallet = createWalletAdapter(keypair);

      const client = new ArciumClientClass({
        connection,
        wallet,
        programId: P01_ARCIUM_PROGRAM_ID,
      });

      await client.initialize();
      clientInstance = client;
      console.log('[MPC] Arcium client initialized');
      return client;
    } catch (e: any) {
      initError = e.message || 'Unknown MPC init error';
      console.warn('[MPC] Failed to initialize:', initError);
      return null;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/** Reset client (e.g., after wallet change) */
export function resetMpcClient(): void {
  clientInstance = null;
  initPromise = null;
  initError = null;
}

/** Get the last initialization error */
export function getMpcInitError(): string | null {
  return initError;
}

/** Check if MPC client is ready without triggering init */
export function isMpcClientReady(): boolean {
  return clientInstance !== null;
}

/**
 * Get an Anchor Program instance for the P01 Arcium program.
 * Required by SDK functions (commitNullifier, privateLookup, etc.).
 */
export async function getArciumProgram(): Promise<any | null> {
  const client = await getMpcClient();
  if (!client) return null;

  try {
    const { Program } = await import('@coral-xyz/anchor');
    const provider = client.getProvider();

    // Fetch IDL from chain or use minimal IDL with instruction names
    // For now, create program with the provider
    // The SDK functions only use program.methods.<name>() which is Anchor's RPC builder
    return {
      provider,
      programId: P01_ARCIUM_PROGRAM_ID,
      methods: createMethodsProxy(provider, P01_ARCIUM_PROGRAM_ID),
    };
  } catch (e: any) {
    console.warn('[MPC] Failed to create program:', e.message);
    return null;
  }
}

/**
 * Create a proxy for program.methods that builds raw instructions.
 * This avoids needing the full Anchor IDL at runtime.
 */
function createMethodsProxy(provider: any, programId: PublicKey): any {
  return new Proxy(
    {},
    {
      get(_target, methodName: string) {
        return (...args: any[]) => {
          return {
            accountsPartial(accounts: Record<string, PublicKey>) {
              return {
                async rpc(opts?: { commitment?: string }): Promise<string> {
                  // Build instruction from method name + args + accounts
                  const ix = buildInstruction(programId, methodName, args, accounts);
                  const tx = new Transaction().add(ix);
                  tx.feePayer = provider.wallet.publicKey;
                  const { blockhash } = await provider.connection.getLatestBlockhash(
                    opts?.commitment || 'confirmed'
                  );
                  tx.recentBlockhash = blockhash;
                  const signed = await provider.wallet.signTransaction(tx);
                  return provider.connection.sendRawTransaction(signed.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: opts?.commitment || 'confirmed',
                  });
                },
              };
            },
          };
        };
      },
    }
  );
}

/**
 * Build a raw TransactionInstruction from method name, args, and accounts.
 * Uses Anchor's 8-byte discriminator (SHA-256("global:<method_name>")[0..8]).
 */
function buildInstruction(
  programId: PublicKey,
  methodName: string,
  args: any[],
  accounts: Record<string, PublicKey>
): TransactionInstruction {
  // Anchor discriminator = SHA-256("global:<snake_case_name>")[0..8]
  const snakeName = methodName.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const { sha256 } = require('@noble/hashes/sha256');
  const disc = sha256(`global:${snakeName}`).slice(0, 8);

  // Serialize args as Borsh (simplified — enough for our Arcium instructions)
  const argBuffers = args.map((arg) => serializeArg(arg));
  const data = Buffer.concat([Buffer.from(disc), ...argBuffers]);

  const keys = Object.entries(accounts).map(([name, pubkey]) => ({
    pubkey,
    isSigner: name === 'payer',
    isWritable: !name.includes('program') && !name.includes('sysvar') && !name.includes('clock'),
  }));

  return new TransactionInstruction({ programId, keys, data });
}

/** Simplified Borsh serialization for common Anchor types */
function serializeArg(arg: any): Buffer {
  if (arg === null || arg === undefined) return Buffer.alloc(0);

  // BN (computation offset, nonce)
  if (arg && typeof arg.toArray === 'function') {
    const bytes = arg.toArray('le', 8);
    return Buffer.from(bytes);
  }

  // number[] (ciphertext arrays)
  if (Array.isArray(arg)) {
    if (arg.length > 0 && typeof arg[0] === 'number') {
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(arg.length);
      return Buffer.concat([lenBuf, Buffer.from(arg)]);
    }
    // Array of arrays (ciphertext chunks)
    if (arg.length > 0 && Array.isArray(arg[0])) {
      const outerLen = Buffer.alloc(4);
      outerLen.writeUInt32LE(arg.length);
      const inner = arg.map((a: number[]) => {
        const innerLen = Buffer.alloc(4);
        innerLen.writeUInt32LE(a.length);
        return Buffer.concat([innerLen, Buffer.from(a)]);
      });
      return Buffer.concat([outerLen, ...inner]);
    }
    return Buffer.alloc(0);
  }

  // number
  if (typeof arg === 'number') {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(arg));
    return buf;
  }

  // bigint
  if (typeof arg === 'bigint') {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(arg);
    return buf;
  }

  return Buffer.alloc(0);
}

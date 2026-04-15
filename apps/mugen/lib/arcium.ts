/**
 * Arcium MPC client helpers for Mugen server routes.
 *
 * Lazy-singleton ArciumClient bound to a server-side relayer Keypair.
 * The relayer pays fees and signs computation instructions; actual
 * escrow ownership is linked via the maker/taker nonces (opaque to
 * the chain) rather than the relayer's pubkey.
 *
 * MUGEN_RELAYER_KEYPAIR env var accepts EITHER:
 *   - base64 of the 64-byte secret key (preferred on Vercel), OR
 *   - a JSON keypair file path (legacy / local dev).
 * When unset, falls back to ~/.config/solana/id.json for local dev.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ArciumClient,
  P01_ARCIUM_PROGRAM_ID,
} from '@protocol-01/arcium-sdk';
import { loadKeypair } from './keypair-loader';

const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

let cachedRelayer: Keypair | null = null;
let cachedClient: ArciumClient | null = null;
let initPromise: Promise<ArciumClient> | null = null;

/**
 * Read the server-side relayer keypair.
 *
 * Resolution order:
 *   1. MUGEN_RELAYER_KEYPAIR env var — tried as base64 first (Vercel prod),
 *      then as a file path (legacy / local dev) if base64 decode fails.
 *   2. ~/.config/solana/id.json (local dev convenience).
 *
 * Throws a helpful error when neither is available.
 */
export function getRelayerKeypair(): Keypair {
  if (cachedRelayer) return cachedRelayer;

  const envVal = process.env.MUGEN_RELAYER_KEYPAIR;
  const defaultFallback = path.join(os.homedir(), '.config', 'solana', 'id.json');

  if (envVal && envVal.trim().length > 0) {
    const trimmed = envVal.trim();
    // Backward-compat: the value used to be a file path. Heuristic —
    // a base64 encoding of a 64-byte secret key is ~88 chars with no '/'
    // or '.json'; a path will contain at least one of those. We try
    // base64 first, and if the loader rejects it (wrong length or non-
    // base64 chars), fall back to treating the value as a path.
    try {
      cachedRelayer = loadKeypair('MUGEN_RELAYER_KEYPAIR');
      return cachedRelayer;
    } catch {
      // Fall through to path-based loading.
    }

    if (fs.existsSync(trimmed)) {
      const raw = fs.readFileSync(trimmed, 'utf-8');
      const secret = Uint8Array.from(JSON.parse(raw));
      cachedRelayer = Keypair.fromSecretKey(secret);
      return cachedRelayer;
    }

    throw new Error(
      `MUGEN_RELAYER_KEYPAIR is set but could not be parsed as base64 ` +
        `and is not an existing file path. Use base64 of the 64-byte ` +
        `secret key (Buffer.from(kp.secretKey).toString('base64')) or a ` +
        `JSON keypair file path.`,
    );
  }

  // No env var — fall back to ~/.config/solana/id.json for local dev.
  cachedRelayer = loadKeypair('MUGEN_RELAYER_KEYPAIR', defaultFallback);
  return cachedRelayer;
}

/** Anchor-compatible wallet adapter backed by a local Keypair. */
function keypairWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async <T extends Transaction>(tx: T): Promise<T> => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]): Promise<T[]> => {
      txs.forEach((t) => t.partialSign(kp));
      return txs;
    },
  };
}

/**
 * Lazily initialize the ArciumClient singleton.
 * Mirrors the lazy-init pattern from apps/mobile/services/arcium/mpcClient.ts.
 */
export async function getArciumClient(): Promise<ArciumClient> {
  if (cachedClient) return cachedClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const relayer = getRelayerKeypair();
    const connection = new Connection(DEVNET_RPC, 'confirmed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallet = keypairWallet(relayer) as any;
    const client = new ArciumClient({
      connection,
      wallet,
      programId: P01_ARCIUM_PROGRAM_ID,
    });
    await client.initialize();
    cachedClient = client;
    return client;
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

/**
 * Minimal Anchor-program shim with just the `.methods.<name>().accountsPartial().rpc()`
 * surface the arcium-sdk Mugen helpers use. Avoids needing the full IDL at runtime.
 *
 * This mirrors the proxy used in apps/mobile/services/arcium/mpcClient.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getArciumProgram(): Promise<any> {
  const client = await getArciumClient();
  const provider = client.getProvider();
  return {
    provider,
    programId: P01_ARCIUM_PROGRAM_ID,
    methods: createMethodsProxy(provider, P01_ARCIUM_PROGRAM_ID),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMethodsProxy(provider: any, programId: PublicKey): any {
  return new Proxy(
    {},
    {
      get(_target, methodName: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (...args: any[]) => ({
          accountsPartial(accounts: Record<string, PublicKey>) {
            return {
              async rpc(opts?: { commitment?: 'confirmed' | 'finalized' | 'processed' }) {
                const ix = buildInstruction(programId, methodName, args, accounts);
                const tx = new Transaction().add(ix);
                tx.feePayer = provider.wallet.publicKey;
                const { blockhash } = await provider.connection.getLatestBlockhash(
                  opts?.commitment || 'confirmed',
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
        });
      },
    },
  );
}

function buildInstruction(
  programId: PublicKey,
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  accounts: Record<string, PublicKey>,
): TransactionInstruction {
  // Anchor discriminator = SHA-256("global:<snake_case_name>")[0..8]
  const snakeName = methodName.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sha256 } = require('@noble/hashes/sha256');
  const disc = sha256(`global:${snakeName}`).slice(0, 8);
  const argBuffers = args.map(serializeArg);
  const data = Buffer.concat([Buffer.from(disc), ...argBuffers]);

  // Account writability heuristic for Arcium queue instructions:
  //   - *Program / sysvar / lutProgram → read-only
  //   - everything else (including clockAccount, poolAccount, mempool, etc.)
  //     is mut per the queue context structs.
  const READONLY_NAMES = new Set([
    'systemProgram',
    'arciumProgram',
    'lutProgram',
    'mxeAccount',
    'compDefAccount',
  ]);
  const keys = Object.entries(accounts).map(([name, pubkey]) => ({
    pubkey,
    isSigner: name === 'payer',
    isWritable: !READONLY_NAMES.has(name) && !name.toLowerCase().includes('sysvar'),
  }));
  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Sizes that map to fixed-length byte arrays in our Arcium instructions.
 * RescueCipher ciphertext blocks and x25519 pubkeys are 32 bytes.
 * When a number[] of one of these sizes is passed, we emit the raw bytes
 * with NO length prefix (matching `[u8; N]` Anchor encoding). Otherwise we
 * fall back to the `Vec<u8>` encoding (4-byte LE length + bytes).
 *
 * Without this, the Anchor deserializer reads the length prefix as part of
 * the fixed-size array data and misaligns subsequent fields, eventually
 * surfacing a "byte array longer than desired length" error.
 */
const FIXED_BYTE_ARRAY_SIZES = new Set([32, 64]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeArg(arg: any): Buffer {
  if (arg === null || arg === undefined) return Buffer.alloc(0);
  // BN values: pick u64 (8 bytes) or u128 (16 bytes) based on actual bit length.
  // The Arcium SDK's `nonceToU128` returns a BN — without this branch the BN
  // is forced into 8 bytes and any u128 > 2^64 throws "byte array longer than
  // desired length".
  if (arg && typeof arg.toArray === 'function' && typeof arg.bitLength === 'function') {
    const bits: number = arg.bitLength();
    const byteLen = bits <= 64 ? 8 : 16;
    return Buffer.from(arg.toArray('le', byteLen));
  }
  if (arg && typeof arg.toArray === 'function') {
    return Buffer.from(arg.toArray('le', 8));
  }
  if (Array.isArray(arg)) {
    if (arg.length > 0 && typeof arg[0] === 'number') {
      if (FIXED_BYTE_ARRAY_SIZES.has(arg.length)) {
        return Buffer.from(arg as number[]);
      }
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(arg.length);
      return Buffer.concat([lenBuf, Buffer.from(arg as number[])]);
    }
    if (arg.length > 0 && Array.isArray(arg[0])) {
      const outerLen = Buffer.alloc(4);
      outerLen.writeUInt32LE(arg.length);
      const inner = (arg as number[][]).map((a) => {
        if (FIXED_BYTE_ARRAY_SIZES.has(a.length)) {
          return Buffer.from(a);
        }
        const innerLen = Buffer.alloc(4);
        innerLen.writeUInt32LE(a.length);
        return Buffer.concat([innerLen, Buffer.from(a)]);
      });
      return Buffer.concat([outerLen, ...inner]);
    }
    return Buffer.alloc(0);
  }
  if (typeof arg === 'number') {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(arg));
    return buf;
  }
  if (typeof arg === 'bigint') {
    // All bigint args in our Arcium instructions are u128 (the MPC nonce
    // returned by client.nonceToU128). Always emit 16 LE bytes regardless of
    // value — emitting only 8 bytes for small values misaligns subsequent
    // fields and surfaces as "byte array longer than desired length".
    // u64 fields use anchor.BN (handled via `.toArray('le', 8)` above).
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(arg & 0xffffffffffffffffn, 0);
    buf.writeBigUInt64LE(arg >> 64n, 8);
    return buf;
  }
  return Buffer.alloc(0);
}

/**
 * Convert a 32-byte base58 pubkey to a u64 bigint by taking its first 8 bytes LE.
 * The SDK's Mugen circuits use a u64 for maker/taker nonce — this lets callers
 * continue to hand us a 32-byte pubkey for external addressing while matching
 * the circuit input size.
 */
export function pubkeyToNonceU64(b58: string): bigint {
  const bytes = new PublicKey(b58).toBytes();
  let x = 0n;
  for (let i = 7; i >= 0; i--) {
    x = (x << 8n) | BigInt(bytes[i]);
  }
  return x;
}

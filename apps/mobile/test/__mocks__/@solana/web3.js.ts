/**
 * Mock: @solana/web3.js
 *
 * Provides lightweight stubs for Solana SDK types used across the mobile app.
 */
import { randomBytes, createHash } from 'crypto';

export const LAMPORTS_PER_SOL = 1_000_000_000;

export class PublicKey {
  private _key: Uint8Array;

  constructor(value: string | Uint8Array | number[]) {
    if (typeof value === 'string') {
      // Reject empty strings (matches real @solana/web3.js behavior)
      if (!value || value.trim().length === 0) {
        throw new Error('Invalid public key input');
      }
      // Simple deterministic 32-byte key from string
      const hash = createHash('sha256').update(value).digest();
      this._key = new Uint8Array(hash);
    } else {
      this._key = new Uint8Array(value);
    }
  }

  toBase58(): string {
    // Return a deterministic base58-like string
    return Buffer.from(this._key).toString('base64').replace(/[+/=]/g, '').slice(0, 44);
  }

  toBytes(): Uint8Array {
    return this._key;
  }

  toString(): string {
    return this.toBase58();
  }

  equals(other: PublicKey): boolean {
    return this.toBase58() === other.toBase58();
  }

  toBuffer(): Buffer {
    return Buffer.from(this._key);
  }
}

export class Keypair {
  publicKey: PublicKey;
  secretKey: Uint8Array;

  constructor(secretKey?: Uint8Array) {
    if (secretKey && secretKey.length === 64) {
      this.secretKey = secretKey;
      this.publicKey = new PublicKey(secretKey.slice(32));
    } else {
      const seed = randomBytes(32);
      const fullKey = new Uint8Array(64);
      fullKey.set(seed);
      fullKey.set(createHash('sha256').update(seed).digest(), 32);
      this.secretKey = fullKey;
      this.publicKey = new PublicKey(fullKey.slice(32));
    }
  }

  static generate(): Keypair {
    return new Keypair();
  }

  static fromSeed(seed: Uint8Array): Keypair {
    const fullKey = new Uint8Array(64);
    fullKey.set(seed.slice(0, 32));
    fullKey.set(createHash('sha256').update(seed.slice(0, 32)).digest(), 32);
    return new Keypair(fullKey);
  }

  static fromSecretKey(secretKey: Uint8Array): Keypair {
    return new Keypair(secretKey);
  }
}

export class Transaction {
  instructions: any[] = [];
  recentBlockhash: string = '';
  feePayer: PublicKey | null = null;
  signatures: any[] = [];

  add(...items: any[]): Transaction {
    this.instructions.push(...items);
    return this;
  }

  sign(...signers: Keypair[]): void {
    this.signatures = signers.map(s => ({ publicKey: s.publicKey, signature: Buffer.alloc(64) }));
  }

  serialize(): Buffer {
    return Buffer.from('mock-serialized-tx');
  }
}

export class Connection {
  private _endpoint: string;

  constructor(endpoint: string, _commitment?: string) {
    this._endpoint = endpoint;
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    return 5 * LAMPORTS_PER_SOL;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: 'mock-blockhash-' + Date.now(), lastValidBlockHeight: 999999 };
  }

  async getRecentBlockhash(): Promise<{ blockhash: string; feeCalculator: { lamportsPerSignature: number } }> {
    return { blockhash: 'mock-blockhash', feeCalculator: { lamportsPerSignature: 5000 } };
  }

  async sendRawTransaction(_raw: Buffer, _options?: any): Promise<string> {
    return 'mock-signature-' + Math.random().toString(36).slice(2, 10);
  }

  async confirmTransaction(_signature: string, _commitment?: string): Promise<any> {
    return { value: { err: null } };
  }

  async getSignaturesForAddress(_pubkey: PublicKey, _options?: any): Promise<any[]> {
    return [];
  }

  async getParsedTransaction(_sig: string, _opts?: any): Promise<any> {
    return null;
  }

  async getAccountInfo(_pubkey: PublicKey): Promise<any> {
    return null;
  }

  async getTokenAccountBalance(_pubkey: PublicKey): Promise<any> {
    return { value: { uiAmount: 100, decimals: 6 } };
  }

  async getParsedTokenAccountsByOwner(_owner: PublicKey, _filter: any): Promise<any> {
    return { value: [] };
  }
}

export const SystemProgram = {
  transfer: (params: { fromPubkey: PublicKey; toPubkey: PublicKey; lamports: number }) => ({
    programId: new PublicKey('11111111111111111111111111111111'),
    keys: [
      { pubkey: params.fromPubkey, isSigner: true, isWritable: true },
      { pubkey: params.toPubkey, isSigner: false, isWritable: true },
    ],
    data: Buffer.alloc(12),
  }),
};

export async function sendAndConfirmTransaction(
  _connection: Connection,
  _transaction: Transaction,
  _signers: Keypair[],
  _options?: any
): Promise<string> {
  return 'mock-confirmed-signature-' + Math.random().toString(36).slice(2, 10);
}

export const clusterApiUrl = (cluster: string) => `https://api.${cluster}.solana.com`;

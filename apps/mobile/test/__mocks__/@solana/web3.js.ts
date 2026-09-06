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

  /**
   * FAKE derivation — deterministic sha256 over the seeds + program id.
   *
   * This is NOT ed25519 off-curve PDA derivation and the addresses it returns
   * do not match the real chain. It exists so that instruction builders which
   * derive a PDA internally (e.g. `deriveFeeEscrowPDA` in
   * services/denominatedPool/index.ts) can be called from unit tests that only
   * assert on `ix.data`. Never assert on an address produced by this.
   */
  static findProgramAddressSync(
    seeds: Array<Uint8Array | Buffer>,
    programId: PublicKey,
  ): [PublicKey, number] {
    const h = createHash('sha256');
    for (const s of seeds) h.update(Buffer.from(s));
    h.update(programId.toBuffer());
    return [new PublicKey(new Uint8Array(h.digest())), 255];
  }
}

/**
 * Minimal TransactionInstruction stub — a plain data carrier.
 *
 * Enough for tests that assert the serialized `data` buffer of an instruction
 * builder. `keys` is stored verbatim and NOT validated — but "not validated"
 * does NOT mean "not assertable".
 *
 * ⛔ ACCOUNT-ORDER ASSERTIONS DO BELONG HERE, AND ONE DEPENDS ON THIS FILE.
 *
 * This comment said the opposite until 2026-08-26, on the grounds that entries
 * referencing mock globals this file does not implement (it named
 * `SystemProgram.programId`) come out `undefined`. That was true when it was
 * written and is false now: `SystemProgram.programId` is implemented below, for
 * precisely this reason, and the hole it used to leave in a key list is gone.
 *
 * The guard that rests on it is in
 * `apps/mobile/services/denominatedPool/unshieldV4.test.ts`:
 *
 *   "names ONE proof buffer, where v3 named two"
 *
 * which asserts the v4 spend names 11 accounts, that the payer signs, and that
 * the recipient is the LAST key and unsigned — the whole point of v4 being that
 * the recipient has no NAMED slot for an IDL-driven indexer to resolve. One more
 * test in that file, "separates two different recipients", uses
 * `SystemProgram.programId` as its second sample key.
 *
 * MEASURED 2026-08-26 by deleting the `programId` line below: 2 of that file's
 * 12 tests fail, both with `Cannot read properties of undefined`. Restored, 12
 * of 12 pass.
 *
 * So: do not delete that guard as "misplaced", and do not thin this mock on the
 * theory that nothing reads the key list. Something does.
 */
export class TransactionInstruction {
  programId: PublicKey;
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Buffer;

  constructor(opts: {
    programId: PublicKey;
    keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
    data: Buffer;
  }) {
    this.programId = opts.programId;
    this.keys = opts.keys;
    this.data = opts.data;
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

  /**
   * Encodes the instruction list (program id + data) as JSON so a test's fake
   * `Connection.sendRawTransaction` can see WHAT was sent — the upload
   * pipeline tests replay chunk writes off this. Not a wire format.
   */
  serialize(_opts?: any): Buffer {
    return Buffer.from(
      JSON.stringify({
        feePayer: this.feePayer ? this.feePayer.toBase58() : null,
        recentBlockhash: this.recentBlockhash,
        instructions: this.instructions.map((ix: any) => ({
          programId: ix.programId ? ix.programId.toBase58() : null,
          data: Array.from(ix.data ?? []),
        })),
      }),
    );
  }
}

/**
 * Real encodings (matches `buildComputeBudgetIxs` in the app): discriminator
 * 2 + u32 LE for the limit, 3 + u64 LE for the price.
 */
export const ComputeBudgetProgram = {
  programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
  setComputeUnitLimit({ units }: { units: number }): TransactionInstruction {
    const data = Buffer.alloc(5);
    data.writeUInt8(2, 0);
    data.writeUInt32LE(units, 1);
    return new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data });
  },
  setComputeUnitPrice({ microLamports }: { microLamports: number | bigint }): TransactionInstruction {
    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0);
    data.writeBigUInt64LE(BigInt(microLamports), 1);
    return new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data });
  },
};

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
  /**
   * ⛔ THIS WAS MISSING UNTIL 2026-08-25 AND ITS ABSENCE WAS SILENT.
   *
   * Production code puts `SystemProgram.programId` straight into an
   * instruction's key list. Under this mock that was `undefined`, so any test
   * building such an instruction got a key list with a hole in it and only
   * noticed if it happened to read that slot. Caught by the v4 spend test,
   * which reads the last key and got `Cannot read properties of undefined`.
   */
  programId: new PublicKey('11111111111111111111111111111111'),
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

/**
 * [TX-V1 2026-09-13] Proof chunks as TRANSACTION V1 envelopes (SIMD-0385).
 *
 * A legacy / v0 transaction is capped at 1,232 bytes, so an 80 KB proof was 80
 * `write_proof_chunk` transactions and the upload was the whole wall clock of
 * a shield or a withdrawal (MEASURED 2026-09-13, `docs/BENCHMARK-2026-09-13.md`:
 * ~10 s of 14–16 s on the app's RPC, ~60 s of 63–66 s on the public endpoint).
 * Transaction v1 carries 4,096 bytes: 3,840 bytes of proof per transaction,
 * 21 transactions instead of 80, upload ~2 s, the STARK half of a flow 7.8 s.
 *
 * The feature gate is `txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL`: active on
 * devnet since slot 492,480,000, announced for mainnet at epoch 1035
 * (~2026-09-15). This module READS the gate (`isTransactionV1Active`) and the
 * uploader falls back to 1,000-byte legacy chunks when it is off, so the same
 * client works on both sides of the activation.
 *
 * `@solana/web3.js` 1.x cannot build a v1 message, so the message is compiled
 * with `@solana/kit` and signed by the caller's `WalletSigner.signBytes` (raw
 * ed25519 over the message bytes, which every ephemeral keypair signer can do
 * and a browser wallet cannot — those keep the legacy path). The wire bytes
 * then go through the SAME `connection.sendRawTransaction` as every other
 * transaction here, which only base64-encodes them, so the fake connection in
 * the tests sees them too.
 *
 * Two v1 facts that cost a failed run each to learn, MEASURED 2026-09-13:
 * a v1 transaction runs with ZERO compute and ZERO loaded-accounts data unless
 * the message declares them, and "loaded accounts" includes the verifier
 * program's ~780 KB of bytecode — 128 KiB landed and failed with
 * `MaxLoadedAccountsDataSizeExceeded`, 4 MiB passes. The priority fee is a
 * TOTAL in lamports, not micro-lamports per compute unit.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type SignatureBytes,
} from '@solana/kit';
import { PublicKey, type Connection } from '@solana/web3.js';
import { Buffer } from 'buffer';

export const TX_V1_FEATURE_GATE = new PublicKey('txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL');

/** Proof bytes per v1 transaction: 4,096 minus the envelope; measured largest wire 4,080 B. */
export const V1_CHUNK_SIZE = 3_840;
/** The v1 ceiling, asserted on every transaction built here. */
export const V1_MAX_WIRE_BYTES = 4_096;

/** Resource declaration for one chunk write (see the module doc for the 4 MiB). */
const V1_CHUNK_CONFIG = {
  computeUnitLimit: 50_000,
  loadedAccountsDataSizeLimit: 4 * 1024 * 1024,
  priorityFeeLamports: 1_000n,
} as const;

const gateCache = new WeakMap<Connection, Promise<boolean>>();

/**
 * Is the transaction-v1 feature gate activated on this connection's cluster?
 * Reads the Feature account once per connection: `[1, slot u64 LE]` when
 * activated. Any read failure means "no", which is the legacy path.
 */
export function isTransactionV1Active(connection: Connection): Promise<boolean> {
  let p = gateCache.get(connection);
  if (!p) {
    p = connection
      .getAccountInfo(TX_V1_FEATURE_GATE)
      .then((info) => !!info && info.data.length >= 9 && info.data[0] === 1)
      .catch(() => false);
    gateCache.set(connection, p);
  }
  return p;
}

export interface V1ChunkParams {
  programId: PublicKey;
  proofBuffer: PublicKey;
  authority: PublicKey;
  offset: number;
  bytes: Uint8Array;
  blockhash: string;
  lastValidBlockHeight: number;
  /** `sha256("global:write_proof_chunk")[..8]` — passed in so this module owns no discriminator. */
  discriminator: Uint8Array;
}

/** The unsigned v1 message bytes for one `write_proof_chunk`, and the fee payer's address. */
export function compileV1ChunkMessage(p: V1ChunkParams): { messageBytes: Uint8Array; payer: string } {
  const data = Buffer.alloc(8 + 4 + 4 + p.bytes.length);
  Buffer.from(p.discriminator).copy(data, 0);
  data.writeUInt32LE(p.offset, 8);
  data.writeUInt32LE(p.bytes.length, 12);
  Buffer.from(p.bytes).copy(data, 16);
  const payer = address(p.authority.toBase58());
  const ix: Instruction = {
    programAddress: address(p.programId.toBase58()),
    accounts: [
      { address: address(p.proofBuffer.toBase58()), role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: p.blockhash as Blockhash, lastValidBlockHeight: BigInt(p.lastValidBlockHeight) },
        m,
      ),
    (m) => appendTransactionMessageInstruction(ix, m),
    (m) => setTransactionMessageConfig(V1_CHUNK_CONFIG, m),
  );
  const compiled = compileTransaction(message);
  return { messageBytes: new Uint8Array(compiled.messageBytes), payer };
}

/** The wire bytes of a v1 transaction: the compiled message under one ed25519 signature. */
export function encodeV1Wire(messageBytes: Uint8Array, payer: string, signature: Uint8Array): Uint8Array {
  const wire = getTransactionEncoder().encode({
    messageBytes: messageBytes as unknown as Parameters<ReturnType<typeof getTransactionEncoder>['encode']>[0]['messageBytes'],
    signatures: { [payer]: signature as SignatureBytes },
  });
  if (wire.length > V1_MAX_WIRE_BYTES) {
    throw new Error(`v1 transaction serialises to ${wire.length} bytes > ${V1_MAX_WIRE_BYTES}; lower V1_CHUNK_SIZE`);
  }
  return new Uint8Array(wire);
}

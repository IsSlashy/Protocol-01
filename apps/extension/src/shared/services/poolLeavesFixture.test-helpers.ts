/**
 * Shared fixture for the leaf-indexer tests: a fake pool history whose
 * transactions carry real `LeafInserted` events (the V3 universal layout,
 * 144 bytes after the 8-byte Anchor discriminator), served by a fake RPC that
 * understands `before` / `until` exactly like `getSignaturesForAddress`.
 *
 * Not a test file itself (no `.test.ts`), so vitest does not collect it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export interface FixtureTx {
  signature: string;
  err: unknown;
  /** Leaves this transaction inserted, oldest first. */
  leaves: Array<{ leafIndex: number; commitment: bigint }>;
  /** Simulate an RPC that has not indexed this transaction yet. */
  unreadable?: boolean;
}

const LEAF_INSERTED_DISC = sha256(utf8ToBytes('event:LeafInserted')).slice(0, 8);

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}

function le32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** One `Program data:` log line carrying a V3 `LeafInserted` event. */
export function leafInsertedLog(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(LEAF_INSERTED_DISC, 0);
  // pool @8 (32 zero bytes)
  data.set(u64le(BigInt(leafIndex)), 40);
  data.set(le32(commitment), 48);
  data.set(le32(commitment ^ 0x1234n), 80); // new_root: anything
  data.set(le32(commitment ^ 0x5678n), 112); // old_root: anything
  return `Program data: ${toBase64(data)}`;
}

/**
 * A fake RPC over `history` (OLDEST FIRST, like the chain). Counts calls so a
 * test can prove the indexer did not re-read what it already had.
 */
export class FakePoolRpc {
  calls = { getSignaturesForAddress: 0, getTransaction: 0 };
  constructor(public history: FixtureTx[]) {}

  /** Append a new (newest) transaction, like a fresh deposit landing. */
  push(tx: FixtureTx) {
    this.history.push(tx);
  }

  async getSignaturesForAddress(
    _address: { toBase58(): string },
    opts: { limit: number; before?: string; until?: string },
  ): Promise<Array<{ signature: string; err: unknown }>> {
    this.calls.getSignaturesForAddress += 1;
    // Newest first.
    let list = [...this.history].reverse();
    if (opts.before) {
      const i = list.findIndex((t) => t.signature === opts.before);
      list = i >= 0 ? list.slice(i + 1) : [];
    }
    if (opts.until) {
      const i = list.findIndex((t) => t.signature === opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts.limit).map((t) => ({ signature: t.signature, err: t.err }));
  }

  async getTransaction(
    signature: string,
    _opts: { maxSupportedTransactionVersion: number; commitment: 'confirmed' },
  ): Promise<{
    slot: number;
    transaction: { message: { staticAccountKeys: Array<{ toBase58(): string }> } };
    meta: { logMessages: string[] } | null;
  } | null> {
    this.calls.getTransaction += 1;
    const tx = this.history.find((t) => t.signature === signature);
    if (!tx || tx.unreadable) return null;
    return {
      slot: 1 + this.history.indexOf(tx),
      transaction: { message: { staticAccountKeys: [{ toBase58: () => 'payer1111111111111111111111111111111111111111' }] } },
      meta: tx.err ? null : { logMessages: tx.leaves.map((l) => leafInsertedLog(l.leafIndex, l.commitment)) },
    };
  }
}

/** A plausible little history: 7 leaves over 6 transactions, one failed tx. */
export function sampleHistory(): FixtureTx[] {
  return [
    { signature: 'sig1', err: null, leaves: [{ leafIndex: 0, commitment: 11n }] },
    { signature: 'sig2', err: null, leaves: [{ leafIndex: 1, commitment: 22n }, { leafIndex: 2, commitment: 33n }] },
    { signature: 'sig3', err: { InstructionError: [0, 'Custom'] }, leaves: [] },
    { signature: 'sig4', err: null, leaves: [{ leafIndex: 3, commitment: 44n }] },
    { signature: 'sig5', err: null, leaves: [] }, // a withdrawal: touches the pool, inserts nothing
    { signature: 'sig6', err: null, leaves: [{ leafIndex: 4, commitment: 18446744069414584320n }] }, // p - 1
  ];
}

export const SAMPLE_DENSE = ['11', '22', '33', '44', '18446744069414584320'];

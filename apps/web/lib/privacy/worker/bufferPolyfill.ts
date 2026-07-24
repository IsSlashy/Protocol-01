/**
 * Worker-scope Buffer polyfill. MUST be the first static import of the worker
 * entry: ESM evaluates imports in dependency order, so this module runs before
 * the pay-core / specter-sdk / web3.js graph, some of which touch the global
 * Buffer at module-evaluation time.
 */
import { Buffer } from 'buffer';

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

// The `buffer` npm polyfill omits the 64-bit BigInt accessors that Node's
// native Buffer has (writeBigUInt64LE / readBigUInt64LE / …). Any SDK code path
// that encodes a u64/i64 via Buffer throws "…is not a function" in the worker,
// and Node-based e2e tests never catch it because Node's Buffer HAS them. Patch
// the whole family via DataView so no current or future call site can trip on
// it. (Source call sites also use DataView directly; this is the safety net.)
type BigWriter = (this: Uint8Array, value: bigint, offset?: number) => number;
type BigReader = (this: Uint8Array, offset?: number) => bigint;
const proto = Buffer.prototype as unknown as Record<string, unknown>;
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const writers: Record<string, (d: DataView, o: number, v: bigint) => void> = {
  writeBigUInt64LE: (d, o, v) => d.setBigUint64(o, v, true),
  writeBigUInt64BE: (d, o, v) => d.setBigUint64(o, v, false),
  writeBigInt64LE: (d, o, v) => d.setBigInt64(o, v, true),
  writeBigInt64BE: (d, o, v) => d.setBigInt64(o, v, false),
};
for (const [name, fn] of Object.entries(writers)) {
  if (typeof proto[name] !== 'function') {
    const w: BigWriter = function (value, offset = 0) {
      fn(dv(this), offset, value);
      return offset + 8;
    };
    proto[name] = w;
  }
}

const readers: Record<string, (d: DataView, o: number) => bigint> = {
  readBigUInt64LE: (d, o) => d.getBigUint64(o, true),
  readBigUInt64BE: (d, o) => d.getBigUint64(o, false),
  readBigInt64LE: (d, o) => d.getBigInt64(o, true),
  readBigInt64BE: (d, o) => d.getBigInt64(o, false),
};
for (const [name, fn] of Object.entries(readers)) {
  if (typeof proto[name] !== 'function') {
    const r: BigReader = function (offset = 0) {
      return fn(dv(this), offset);
    };
    proto[name] = r;
  }
}

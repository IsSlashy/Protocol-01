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
//
// Patch EVERY Buffer prototype reachable here, not just the one this module
// imports. Modules that do `import { Buffer } from 'buffer'` and modules that
// use the ambient global can end up on different copies (Next ships its own
// compiled buffer), and patching only the imported copy leaves the global one
// bare — which is how `parseFilledSubtrees` still threw
// "treeData.readBigUInt64LE is not a function" with this polyfill loaded.
type BigWriter = (this: Uint8Array, value: bigint, offset?: number) => number;
type BigReader = (this: Uint8Array, offset?: number) => bigint;
// Uint8Array.prototype is in the list on purpose, and it is what actually makes
// this work. A bare `Buffer` reference inside a bundled module can resolve to a
// copy the bundler injects, which is reachable by no name we have here — but
// every Buffer copy is a Uint8Array subclass, and none of them define these
// methods (that IS the gap), so defining them one level up covers all copies,
// present and future.
const globalBuffer = (globalThis as { Buffer?: { prototype?: unknown } }).Buffer;
const prototypes = [
  Uint8Array.prototype as unknown as Record<string, unknown>,
  Buffer.prototype as unknown as Record<string, unknown>,
  globalBuffer?.prototype as Record<string, unknown> | undefined,
].filter((p, i, all): p is Record<string, unknown> => !!p && all.indexOf(p) === i);
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const writers: Record<string, (d: DataView, o: number, v: bigint) => void> = {
  writeBigUInt64LE: (d, o, v) => d.setBigUint64(o, v, true),
  writeBigUInt64BE: (d, o, v) => d.setBigUint64(o, v, false),
  writeBigInt64LE: (d, o, v) => d.setBigInt64(o, v, true),
  writeBigInt64BE: (d, o, v) => d.setBigInt64(o, v, false),
};
for (const proto of prototypes) {
  for (const [name, fn] of Object.entries(writers)) {
    if (typeof proto[name] !== 'function') {
      const w: BigWriter = function (value, offset = 0) {
        fn(dv(this), offset, value);
        return offset + 8;
      };
      proto[name] = w;
    }
  }
}

const readers: Record<string, (d: DataView, o: number) => bigint> = {
  readBigUInt64LE: (d, o) => d.getBigUint64(o, true),
  readBigUInt64BE: (d, o) => d.getBigUint64(o, false),
  readBigInt64LE: (d, o) => d.getBigInt64(o, true),
  readBigInt64BE: (d, o) => d.getBigInt64(o, false),
};
for (const proto of prototypes) {
  for (const [name, fn] of Object.entries(readers)) {
    if (typeof proto[name] !== 'function') {
      const r: BigReader = function (offset = 0) {
        return fn(dv(this), offset);
      };
      proto[name] = r;
    }
  }
}

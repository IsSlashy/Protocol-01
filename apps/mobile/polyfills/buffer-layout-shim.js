/**
 * Buffer-layout polyfill for React Native / Hermes.
 *
 * The old `buffer-layout` package (used by @coral-xyz/anchor and @coral-xyz/borsh)
 * calls Node.js Buffer methods (readUIntLE, writeUIntLE, etc.) directly on data
 * objects. In React Native, @solana/web3.js returns Uint8Array (not Buffer), so
 * these calls fail. This shim adds the missing methods to Uint8Array.prototype.
 *
 * Must be loaded AFTER the Buffer global is set (index.js), but BEFORE any
 * Anchor/Arcium code runs.
 */

const { Buffer } = require('buffer');

const proto = Uint8Array.prototype;

// ── readUIntLE / readUIntBE ──────────────────────────────────────
if (!proto.readUIntLE) {
  proto.readUIntLE = function readUIntLE(offset, byteLength) {
    let val = 0;
    let mul = 1;
    for (let i = 0; i < byteLength; i++) {
      val += this[offset + i] * mul;
      mul *= 0x100;
    }
    return val;
  };
}

if (!proto.readUIntBE) {
  proto.readUIntBE = function readUIntBE(offset, byteLength) {
    let val = 0;
    let mul = 1;
    for (let i = byteLength - 1; i >= 0; i--) {
      val += this[offset + i] * mul;
      mul *= 0x100;
    }
    return val;
  };
}

// ── readIntLE / readIntBE ────────────────────────────────────────
if (!proto.readIntLE) {
  proto.readIntLE = function readIntLE(offset, byteLength) {
    let val = this.readUIntLE(offset, byteLength);
    const limit = Math.pow(2, 8 * byteLength - 1);
    if (val >= limit) val -= Math.pow(2, 8 * byteLength);
    return val;
  };
}

if (!proto.readIntBE) {
  proto.readIntBE = function readIntBE(offset, byteLength) {
    let val = this.readUIntBE(offset, byteLength);
    const limit = Math.pow(2, 8 * byteLength - 1);
    if (val >= limit) val -= Math.pow(2, 8 * byteLength);
    return val;
  };
}

// ── Fixed-width unsigned reads ───────────────────────────────────
if (!proto.readUInt8) {
  proto.readUInt8 = function readUInt8(offset) {
    return this[offset];
  };
}

if (!proto.readUInt16LE) {
  proto.readUInt16LE = function readUInt16LE(offset) {
    return this[offset] | (this[offset + 1] << 8);
  };
}

if (!proto.readUInt16BE) {
  proto.readUInt16BE = function readUInt16BE(offset) {
    return (this[offset] << 8) | this[offset + 1];
  };
}

if (!proto.readUInt32LE) {
  proto.readUInt32LE = function readUInt32LE(offset) {
    return (
      this[offset] |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
    ) >>> 0;
  };
}

if (!proto.readUInt32BE) {
  proto.readUInt32BE = function readUInt32BE(offset) {
    return (
      (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3]
    ) >>> 0;
  };
}

// ── Fixed-width signed reads ─────────────────────────────────────
if (!proto.readInt8) {
  proto.readInt8 = function readInt8(offset) {
    const val = this[offset];
    return val >= 0x80 ? val - 0x100 : val;
  };
}

if (!proto.readInt16LE) {
  proto.readInt16LE = function readInt16LE(offset) {
    const val = this[offset] | (this[offset + 1] << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
  };
}

if (!proto.readInt32LE) {
  proto.readInt32LE = function readInt32LE(offset) {
    return (
      this[offset] |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
    );
  };
}

if (!proto.readInt32BE) {
  proto.readInt32BE = function readInt32BE(offset) {
    return (
      (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3]
    );
  };
}

// ── Float / Double reads (IEEE 754) ─────────────────────────────
const _f32 = new Float32Array(1);
const _u8f32 = new Uint8Array(_f32.buffer);
const _f64 = new Float64Array(1);
const _u8f64 = new Uint8Array(_f64.buffer);

if (!proto.readFloatLE) {
  proto.readFloatLE = function readFloatLE(offset) {
    _u8f32[0] = this[offset];
    _u8f32[1] = this[offset + 1];
    _u8f32[2] = this[offset + 2];
    _u8f32[3] = this[offset + 3];
    return _f32[0];
  };
}

if (!proto.readFloatBE) {
  proto.readFloatBE = function readFloatBE(offset) {
    _u8f32[3] = this[offset];
    _u8f32[2] = this[offset + 1];
    _u8f32[1] = this[offset + 2];
    _u8f32[0] = this[offset + 3];
    return _f32[0];
  };
}

if (!proto.readDoubleLE) {
  proto.readDoubleLE = function readDoubleLE(offset) {
    for (let i = 0; i < 8; i++) _u8f64[i] = this[offset + i];
    return _f64[0];
  };
}

if (!proto.readDoubleBE) {
  proto.readDoubleBE = function readDoubleBE(offset) {
    for (let i = 0; i < 8; i++) _u8f64[7 - i] = this[offset + i];
    return _f64[0];
  };
}

// ── writeUIntLE / writeUIntBE ────────────────────────────────────
if (!proto.writeUIntLE) {
  proto.writeUIntLE = function writeUIntLE(value, offset, byteLength) {
    let val = value;
    for (let i = 0; i < byteLength; i++) {
      this[offset + i] = val & 0xff;
      val = Math.floor(val / 0x100);
    }
    return offset + byteLength;
  };
}

if (!proto.writeUIntBE) {
  proto.writeUIntBE = function writeUIntBE(value, offset, byteLength) {
    let val = value;
    for (let i = byteLength - 1; i >= 0; i--) {
      this[offset + i] = val & 0xff;
      val = Math.floor(val / 0x100);
    }
    return offset + byteLength;
  };
}

// ── writeIntLE / writeIntBE ──────────────────────────────────────
if (!proto.writeIntLE) {
  proto.writeIntLE = function writeIntLE(value, offset, byteLength) {
    let val = value < 0 ? value + Math.pow(2, 8 * byteLength) : value;
    return this.writeUIntLE(val, offset, byteLength);
  };
}

if (!proto.writeIntBE) {
  proto.writeIntBE = function writeIntBE(value, offset, byteLength) {
    let val = value < 0 ? value + Math.pow(2, 8 * byteLength) : value;
    return this.writeUIntBE(val, offset, byteLength);
  };
}

// ── Fixed-width unsigned writes ──────────────────────────────────
if (!proto.writeUInt8) {
  proto.writeUInt8 = function writeUInt8(value, offset) {
    this[offset] = value & 0xff;
    return offset + 1;
  };
}

if (!proto.writeUInt16LE) {
  proto.writeUInt16LE = function writeUInt16LE(value, offset) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    return offset + 2;
  };
}

if (!proto.writeUInt32LE) {
  proto.writeUInt32LE = function writeUInt32LE(value, offset) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    this[offset + 2] = (value >>> 16) & 0xff;
    this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  };
}

if (!proto.writeUInt32BE) {
  proto.writeUInt32BE = function writeUInt32BE(value, offset) {
    this[offset] = (value >>> 24) & 0xff;
    this[offset + 1] = (value >>> 16) & 0xff;
    this[offset + 2] = (value >>> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  };
}

// ── Fixed-width signed writes ────────────────────────────────────
if (!proto.writeInt32LE) {
  proto.writeInt32LE = function writeInt32LE(value, offset) {
    return this.writeUInt32LE(value < 0 ? value + 0x100000000 : value, offset);
  };
}

if (!proto.writeInt32BE) {
  proto.writeInt32BE = function writeInt32BE(value, offset) {
    return this.writeUInt32BE(value < 0 ? value + 0x100000000 : value, offset);
  };
}

// ── Float / Double writes ────────────────────────────────────────
if (!proto.writeFloatLE) {
  proto.writeFloatLE = function writeFloatLE(value, offset) {
    _f32[0] = value;
    this[offset] = _u8f32[0];
    this[offset + 1] = _u8f32[1];
    this[offset + 2] = _u8f32[2];
    this[offset + 3] = _u8f32[3];
    return offset + 4;
  };
}

if (!proto.writeFloatBE) {
  proto.writeFloatBE = function writeFloatBE(value, offset) {
    _f32[0] = value;
    this[offset] = _u8f32[3];
    this[offset + 1] = _u8f32[2];
    this[offset + 2] = _u8f32[1];
    this[offset + 3] = _u8f32[0];
    return offset + 4;
  };
}

if (!proto.writeDoubleLE) {
  proto.writeDoubleLE = function writeDoubleLE(value, offset) {
    _f64[0] = value;
    for (let i = 0; i < 8; i++) this[offset + i] = _u8f64[i];
    return offset + 8;
  };
}

if (!proto.writeDoubleBE) {
  proto.writeDoubleBE = function writeDoubleBE(value, offset) {
    _f64[0] = value;
    for (let i = 0; i < 8; i++) this[offset + i] = _u8f64[7 - i];
    return offset + 8;
  };
}

// ── copy (Uint8Array has set() but not copy()) ───────────────────
if (!proto.copy) {
  proto.copy = function copy(target, targetStart, sourceStart, sourceEnd) {
    targetStart = targetStart || 0;
    sourceStart = sourceStart || 0;
    sourceEnd = sourceEnd || this.length;
    const len = Math.min(sourceEnd - sourceStart, target.length - targetStart);
    target.set(this.subarray(sourceStart, sourceStart + len), targetStart);
    return len;
  };
}

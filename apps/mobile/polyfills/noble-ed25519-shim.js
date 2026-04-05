/**
 * Hermes-compatible shim for @noble/curves/ed25519.
 *
 * Strategy: Try to load the REAL @noble/curves/ed25519 module first.
 * If it loads successfully (sign/verify/getPublicKey work), re-export as-is.
 * If ed25519.CURVE is missing (twistedEdwards failure in Hermes), patch it
 * with hardcoded constants while keeping the working sign/verify/x25519.
 *
 * The real module works for Solana operations (Transaction.sign/verify).
 * Only @arcium-hq/client's access to ed25519.CURVE.n / ed25519.Point.Fp
 * may fail if twistedEdwards didn't produce the legacy CURVE wrapper.
 */

'use strict';

// Try to load the REAL ed25519 module.
// Use '@noble/curves/esm/ed25519' path which bypasses our Metro redirect
// (our redirect only intercepts '@noble/curves/ed25519' exact match).
var realModule = null;
var realEd25519 = null;
var realX25519 = null;
try {
  realModule = require('@noble/curves/esm/ed25519');
  realEd25519 = realModule.ed25519;
  realX25519 = realModule.x25519;
} catch (e) {
  console.warn('[noble-ed25519-shim] Real module failed to load:', e.message);
}

// Check if the real module's ed25519 has working CURVE property
if (realEd25519 && realEd25519.CURVE && typeof realEd25519.CURVE.n === 'bigint') {
  // Real module works perfectly — just re-export everything
  console.log('[noble-ed25519-shim] Real ed25519 module loaded — re-exporting as-is');
  module.exports = realModule;
} else {
  // Real module has issues (CURVE missing or incomplete).
  // Patch with hardcoded constants while preserving working methods.
  console.warn('[noble-ed25519-shim] ed25519.CURVE missing — patching with constants');

  var modular = require('@noble/curves/abstract/modular');
  var Field = modular.Field;
  var mod = modular.mod;
  var pow2 = modular.pow2;
  var isNegativeLE = modular.isNegativeLE;

  var montgomeryModule = require('@noble/curves/abstract/montgomery');
  var montgomery = montgomeryModule.montgomery;

  var _0n = BigInt(0), _1n = BigInt(1), _2n = BigInt(2), _3n = BigInt(3);
  var _5n = BigInt(5), _8n = BigInt(8);

  var ed25519_CURVE_p = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed');
  var ed25519_CURVE_n = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed');

  var Fp = Field(ed25519_CURVE_p, { isLE: true });
  var Fn = Field(ed25519_CURVE_n, { isLE: true });

  function adjustScalarBytes(bytes) {
    bytes[0] &= 248;
    bytes[31] &= 127;
    bytes[31] |= 64;
    return bytes;
  }

  function ed25519_pow_2_252_3(x) {
    var _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
    var P = ed25519_CURVE_p;
    var x2 = (x * x) % P;
    var b2 = (x2 * x) % P;
    var b4 = (pow2(b2, _2n, P) * b2) % P;
    var b5 = (pow2(b4, _1n, P) * x) % P;
    var b10 = (pow2(b5, _5n, P) * b5) % P;
    var b20 = (pow2(b10, _10n, P) * b10) % P;
    var b40 = (pow2(b20, _20n, P) * b20) % P;
    var b80 = (pow2(b40, _40n, P) * b40) % P;
    var b160 = (pow2(b80, _80n, P) * b80) % P;
    var b240 = (pow2(b160, _80n, P) * b80) % P;
    var b250 = (pow2(b240, _10n, P) * b10) % P;
    var pow_p_5_8 = (pow2(b250, _2n, P) * x) % P;
    return { pow_p_5_8: pow_p_5_8, b2: b2 };
  }

  var ED25519_SQRT_M1 = BigInt('19681161376707505956807079304988542015446066515923890162744021073123829784752');

  function uvRatio(u, v) {
    var P = ed25519_CURVE_p;
    var v3 = mod(v * v * v, P);
    var v7 = mod(v3 * v3 * v, P);
    var pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
    var x = mod(u * v3 * pow, P);
    var vx2 = mod(v * x * x, P);
    var root1 = x;
    var root2 = mod(x * ED25519_SQRT_M1, P);
    var useRoot1 = vx2 === u;
    var useRoot2 = vx2 === mod(-u, P);
    if (useRoot1) x = root1;
    if (useRoot2 || vx2 === mod(-u * ED25519_SQRT_M1, P)) x = root2;
    if (isNegativeLE(x, P)) x = mod(-x, P);
    return { isValid: useRoot1 || useRoot2, value: x };
  }

  // Build CURVE constants
  var patchedCURVE = Object.freeze({
    p: ed25519_CURVE_p,
    n: ed25519_CURVE_n,
    h: _8n,
    a: BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec'),
    d: BigInt('0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3'),
    Gx: BigInt('0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a'),
    Gy: BigInt('0x6666666666666666666666666666666666666666666666666666666666666658'),
    Fp: Fp,
    nBitLength: 253,
    nByteLength: 32,
    adjustScalarBytes: adjustScalarBytes,
    uvRatio: uvRatio,
  });

  // Build patched ed25519: keep real methods if available, add CURVE/Point
  var patchedEd25519 = {};
  // Copy everything from real ed25519 if it exists (sign, verify, getPublicKey, etc.)
  if (realEd25519) {
    var keys = Object.getOwnPropertyNames(realEd25519);
    for (var i = 0; i < keys.length; i++) {
      try { patchedEd25519[keys[i]] = realEd25519[keys[i]]; } catch(e) {}
    }
  }
  // Override/add CURVE and Point with our working constants
  patchedEd25519.CURVE = patchedCURVE;
  patchedEd25519.Point = Object.freeze({ Fp: Fp, Fn: Fn, BYTES: 32 });
  patchedEd25519.ExtendedPoint = patchedEd25519.Point;

  // If real ed25519 didn't have utils, add minimal
  if (!patchedEd25519.utils) {
    patchedEd25519.utils = {
      randomPrivateKey: function() {
        var bytes = new Uint8Array(32);
        globalThis.crypto.getRandomValues(bytes);
        return adjustScalarBytes(bytes);
      },
    };
  }

  Object.freeze(patchedEd25519);

  // x25519: use real if available, otherwise construct from montgomery
  var patchedX25519 = realX25519;
  if (!patchedX25519) {
    patchedX25519 = montgomery({
      P: ed25519_CURVE_p,
      type: 'x25519',
      powPminus2: function(x) {
        var result = ed25519_pow_2_252_3(x);
        return mod(pow2(result.pow_p_5_8, _3n, ed25519_CURVE_p) * result.b2, ed25519_CURVE_p);
      },
      adjustScalarBytes: adjustScalarBytes,
    });
  }

  // Export patched module
  var result = {};
  if (realModule) {
    var mkeys = Object.getOwnPropertyNames(realModule);
    for (var j = 0; j < mkeys.length; j++) {
      try { result[mkeys[j]] = realModule[mkeys[j]]; } catch(e) {}
    }
  }
  result.ed25519 = patchedEd25519;
  result.x25519 = patchedX25519;
  result.ed25519ctx = patchedEd25519;
  result.ed25519ph = patchedEd25519;
  result.Fp = Fp;
  result.Fn = Fn;
  result.ED25519_SQRT_M1 = ED25519_SQRT_M1;

  module.exports = result;
}

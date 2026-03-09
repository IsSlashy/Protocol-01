/**
 * Hermes-compatible shim for @noble/curves/abstract/edwards.
 *
 * Wraps the real `twistedEdwards` function with error handling.
 * In Hermes, twistedEdwards() can fail because isEdValidXY() uses BigInt
 * arithmetic that may produce incorrect results, causing the generator
 * validation to throw "bad curve params: generator point".
 *
 * When twistedEdwards fails, this shim returns a stub curve object with
 * the CURVE constants and Field instances that @arcium-hq/client needs.
 * Since the mobile app never directly calls arcisEd25519.sign/verify
 * (MPC nodes handle that), the stub is sufficient.
 */

'use strict';

// Load the REAL edwards module using @noble/curves/esm/abstract/edwards path
// This bypasses our Metro redirect (which intercepts @noble/curves/abstract/edwards)
// because the resolver's subpath logic resolves esm/abstract/edwards → the real file
var realModule;
try {
  realModule = require('@noble/curves/esm/abstract/edwards');
} catch (e) {
  console.warn('[noble-edwards-shim] Failed to load real edwards module:', e.message);
  realModule = {};
}

var modular = require('@noble/curves/abstract/modular');
var Field = modular.Field;

var realTwistedEdwards = realModule.twistedEdwards;
var realEdwards = realModule.edwards;
var realEddsa = realModule.eddsa;
var PrimeEdwardsPoint = realModule.PrimeEdwardsPoint;

/**
 * Safe wrapper for twistedEdwards — catches Hermes BigInt validation failures.
 * Returns a minimal stub curve object when the real implementation throws.
 */
function twistedEdwards(c) {
  // Try the real implementation first
  if (realTwistedEdwards) {
    try {
      return realTwistedEdwards(c);
    } catch (e) {
      console.warn('[noble-edwards-shim] twistedEdwards failed:', e.message, '— using stub');
    }
  }

  // Fallback: construct a minimal curve object with the constants @arcium-hq/client needs.
  // c is the legacy opts format: { a, d, Fp, n, h, Gx, Gy, hash, randomBytes, adjustScalarBytes, uvRatio }
  var Fp = c.Fp;
  var Fn;
  try {
    Fn = Field(c.n, c.nBitLength, true);
  } catch (e2) {
    Fn = Field(c.n, { isLE: true });
  }

  var PointStub = Object.freeze({
    Fp: Fp,
    Fn: Fn,
    BYTES: Fp.BYTES || 32,
  });

  return Object.freeze({
    CURVE: c,
    Point: PointStub,
    ExtendedPoint: PointStub,
    nBitLength: Fn.BITS || 253,
    nByteLength: Fn.BYTES || 32,
    getPublicKey: function() {
      throw new Error('twistedEdwards stub: getPublicKey not available in Hermes');
    },
    sign: function() {
      throw new Error('twistedEdwards stub: sign not available in Hermes');
    },
    verify: function() {
      throw new Error('twistedEdwards stub: verify not available in Hermes');
    },
    utils: {
      randomPrivateKey: function() {
        throw new Error('twistedEdwards stub: randomPrivateKey not available in Hermes');
      },
    },
  });
}

/**
 * Safe wrapper for edwards (new API) — same approach.
 */
function edwards(params, extraOpts) {
  if (realEdwards) {
    try {
      return realEdwards(params, extraOpts);
    } catch (e) {
      console.warn('[noble-edwards-shim] edwards() failed:', e.message, '— using stub');
    }
  }

  // Stub Point class
  var Fp = extraOpts && extraOpts.Fp ? extraOpts.Fp : Field(params.p, { isLE: true });
  var Fn = extraOpts && extraOpts.Fn ? extraOpts.Fn : Field(params.n, { isLE: true });

  return Object.freeze({
    Fp: Fp,
    Fn: Fn,
    BYTES: Fp.BYTES || 32,
  });
}

// Re-export everything from the real module, with our safe wrappers
module.exports = Object.assign({}, realModule, {
  twistedEdwards: twistedEdwards,
  edwards: edwards,
  PrimeEdwardsPoint: PrimeEdwardsPoint || (function PrimeEdwardsPointStub() {}),
});

/**
 * Shim for @arcium-hq/client getArciumEnv()
 *
 * The original function checks isBrowser() and throws in React Native.
 * This shim returns our hardcoded cluster config instead.
 *
 * Applied via patch-package or direct node_modules override.
 */

// Hardcoded Arcium cluster offset (matches deployed MXE: 3EzPEVpU...)
const ARCIUM_CLUSTER_OFFSET = 456;

module.exports = {
  arciumClusterOffset: ARCIUM_CLUSTER_OFFSET,
};

/**
 * Polyfill for ox/erc8010 module
 * This is a stub to satisfy viem's dependency
 */

// ERC-8010 is for signature validation
// Provide a stub implementation
export const SignatureErc8010 = {
  validate: (signature) => {
    // ERC-8010 signatures have a specific format
    // For now, return false as we don't use this feature
    return false;
  },
};

export default {
  SignatureErc8010,
};

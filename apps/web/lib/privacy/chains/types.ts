/**
 * Re-export of the framework-agnostic stealth interface & types.
 *
 * The canonical definitions now live in `@protocol-01/pay-core` so they are
 * shared byte-for-byte with apps/extension. This barrel keeps the existing
 * `@/lib/privacy/chains/types` import path working — do not add app-specific
 * types here; put shared types in pay-core.
 */

export * from '@protocol-01/pay-core';

/**
 * Single source of truth for the P01 identity-derivation constants.
 *
 * These MUST be byte-identical across the SDK, mobile, and the extension —
 * "same user → same shielded identity everywhere" depends on it (spec R-06).
 * Never re-define these per-client; import them from here.
 *
 * See docs/privy-removal-spec.md §1.3.
 */

import { utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The fixed UTF-8 (printable-ASCII) message signed by software/MWA wallets to
 * obtain the HKDF input keying material. ASCII-only so a hardware wallet could
 * in principle clear-sign it (we do NOT use the signature path for hardware,
 * but the message stays clear-signable by policy).
 */
export const IDENTITY_DOMAIN = 'protocol01:identity:v1' as const;

/** Fixed public HKDF salt (RFC-5869-legal). */
export const HKDF_SALT: Uint8Array = utf8ToBytes('protocol01:hkdf:v1');

/** HKDF `info` domain separator producing the spending key. */
export const SPEND_INFO: Uint8Array = utf8ToBytes('p01:spend:v1');

/** HKDF `info` domain separator producing the viewing key. */
export const VIEW_INFO: Uint8Array = utf8ToBytes('p01:view:v1');

/** Output length of each derived sub-key, in bytes. */
export const IDENTITY_KEY_LENGTH = 32 as const;

/**
 * Starknet stealth account derivation — the stark-curve half of the
 * chain-agnostic PQ discovery layer.
 *
 * Reuses specter-sdk's hybrid handshake UNCHANGED (X25519 ECDH + ML-KEM-768 +
 * transcript-bound HKDF). What differs from Solana is only the LAST step: the
 * shared stealth seed grinds to a stark-curve private key whose OpenZeppelin
 * account address is counterfactual — the sender funds it, the recipient
 * deploys it at claim time with the derived key.
 *
 * Sender:    parse meta → ephemeral X25519 + kemEncapsulate → hybrid shared →
 *            deriveStealthSeed(spendingPub, shared) → grindKey → stark pubkey →
 *            OZ account address. Publishes {ephemeralPub, kemCiphertext,
 *            viewTag, announcementId = address} via pq_announcer.
 * Recipient: scan announcements → X25519 + kemDecapsulate → same seed → same
 *            key → same address → deploy + sweep.
 *
 * ⚠ Spend-authority caveat (v1, by design — documented in the UI): the meta
 * carries an Ed25519 spending key, and Ed25519 tweaks cannot transfer to the
 * stark curve, so the stark key derives from the SHARED secret — which the
 * sender also knows. Until the value half runs inside STRK20's pool (whose
 * notes carry their own spend authority), a Starknet stealth payment is
 * bearer-like: the sender could technically reclaim it before the recipient
 * does. Claim promptly. The PQ *discovery* guarantee (who receives stays
 * hidden, quantum-durably) is unaffected.
 */

import nacl from 'tweetnacl';
import { ec, hash, num } from 'starknet';
import {
  parseStealthMetaAddress,
  kemEncapsulate,
  kemDecapsulate,
  deriveSharedSecret,
  deriveHybridSharedSecret,
  deriveStealthSeed,
  computeViewTag,
} from '@protocol-01/specter-sdk/core';

/** OpenZeppelin account class hash (v0.8.1) — predeclared on starknet-devnet
 *  and widely deployed on Sepolia. Override via `accountClassHash` for other
 *  account implementations. */
export const DEFAULT_OZ_ACCOUNT_CLASS_HASH =
  '0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f';

export interface StarknetStealthTarget {
  /** Counterfactual OZ account address (hex felt) — where funds go. */
  address: string;
  /** Stark-curve public key of the one-time account (hex felt). */
  starkPubKey: string;
  /** Ephemeral X25519 public key to publish (32 bytes). */
  ephemeralPubKey: Uint8Array;
  /** ML-KEM-768 ciphertext to publish (1088 bytes). */
  kemCiphertext: Uint8Array;
  /** 1-byte view tag for cheap scan filtering. */
  viewTag: number;
}

export interface StarknetStealthKey extends StarknetStealthTarget {
  /** Stark-curve private key (hex) — SPEND AUTHORITY. Zero the source seed
   *  after use; never post this anywhere. */
  starkPrivKey: string;
}

/** Grind a 32-byte stealth seed onto the stark curve. */
function seedToStarkKey(seed: Uint8Array): { priv: string; pub: string } {
  // grindKey maps arbitrary entropy uniformly into the stark curve's key range.
  // It returns UNPREFIXED hex; normalize to 0x-form for starknet.js APIs.
  const priv = num.toHex(BigInt(`0x${ec.starkCurve.grindKey(seed)}`));
  const pub = ec.starkCurve.getStarkKey(priv);
  return { priv, pub };
}

/** Counterfactual OZ account address for a stark public key. */
export function starkAccountAddress(
  starkPubKey: string,
  accountClassHash: string = DEFAULT_OZ_ACCOUNT_CLASS_HASH,
): string {
  return num.toHex(
    hash.calculateContractAddressFromHash(
      starkPubKey, // salt
      accountClassHash,
      [starkPubKey], // OZ constructor: (public_key)
      0, // deployer (0 = counterfactual / deploy_account)
    ),
  );
}

/**
 * SENDER: derive the one-time Starknet stealth account for a recipient's v2
 * hybrid meta-address. Publish `ephemeralPubKey`/`kemCiphertext`/`viewTag`
 * with announcementId = `address`, and transfer funds to `address`.
 */
export function generateStarknetStealth(
  recipientMeta: string,
  accountClassHash?: string,
): StarknetStealthTarget {
  const meta = parseStealthMetaAddress(recipientMeta);
  if (!meta.kemPubKey) {
    throw new Error('Recipient meta-address is not v2 hybrid (missing ML-KEM key).');
  }

  const ephemeral = nacl.box.keyPair();
  try {
    const classic = deriveSharedSecret(ephemeral.secretKey, meta.viewingPubKey);
    const kem = kemEncapsulate(meta.kemPubKey);
    const shared = deriveHybridSharedSecret(classic, kem.sharedSecret, {
      ephemeralPubKey: ephemeral.publicKey,
      kemCiphertext: kem.cipherText,
    });
    const viewTag = computeViewTag(shared);
    const seed = deriveStealthSeed(meta.spendingPubKey, shared);
    const { pub } = seedToStarkKey(seed);
    seed.fill(0);
    shared.fill(0);
    classic.fill(0);
    kem.sharedSecret.fill(0);

    return {
      address: starkAccountAddress(pub, accountClassHash),
      starkPubKey: pub,
      ephemeralPubKey: ephemeral.publicKey,
      kemCiphertext: kem.cipherText,
      viewTag,
    };
  } finally {
    ephemeral.secretKey.fill(0);
  }
}

/**
 * RECIPIENT: try to derive the stealth account key from an announcement. Uses
 * the session secrets (viewing X25519 private + ML-KEM secret + spending pub).
 * Returns null when the view tag doesn't match (not ours — cheap reject).
 */
export function deriveStarknetStealthKey(params: {
  spendingPubKey: Uint8Array;
  viewingPrivateKey: Uint8Array;
  kemSecretKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  kemCiphertext: Uint8Array;
  /** Announcement view tag (0-255) for the cheap pre-check; pass -1 to skip. */
  viewTag?: number;
  accountClassHash?: string;
}): StarknetStealthKey | null {
  // The classic + KEM intermediates are secret material too — zero them as
  // soon as the hybrid secret is derived, on every path (including a
  // kemDecapsulate throw, where only `classic` exists yet).
  const classic = deriveSharedSecret(params.viewingPrivateKey, params.ephemeralPubKey);
  let kemShared: Uint8Array | undefined;
  let shared: Uint8Array;
  try {
    kemShared = kemDecapsulate(params.kemCiphertext, params.kemSecretKey);
    shared = deriveHybridSharedSecret(classic, kemShared, {
      ephemeralPubKey: params.ephemeralPubKey,
      kemCiphertext: params.kemCiphertext,
    });
  } finally {
    classic.fill(0);
    kemShared?.fill(0);
  }

  const tag = computeViewTag(shared);
  if (params.viewTag !== undefined && params.viewTag >= 0 && tag !== params.viewTag) {
    shared.fill(0);
    return null;
  }

  const seed = deriveStealthSeed(params.spendingPubKey, shared);
  const { priv, pub } = seedToStarkKey(seed);
  seed.fill(0);
  shared.fill(0);

  return {
    address: starkAccountAddress(pub, params.accountClassHash),
    starkPubKey: pub,
    starkPrivKey: priv,
    ephemeralPubKey: params.ephemeralPubKey,
    kemCiphertext: params.kemCiphertext,
    viewTag: tag,
  };
}

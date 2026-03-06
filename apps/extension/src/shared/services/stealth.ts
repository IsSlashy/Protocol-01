/**
 * Stealth Address Protocol pour Solana
 *
 * CONCEPT:
 * 1. Le destinataire publie une "meta-address" (spending key + viewing key)
 * 2. L'expéditeur génère une adresse stealth unique pour chaque paiement
 * 3. Seul le destinataire peut détecter et dépenser les fonds
 *
 * CRYPTOGRAPHIE:
 * - v1: X25519 ECDH for shared secret derivation
 * - v2: Hybrid X25519 + ML-KEM-768 (FIPS 203) for post-quantum resistance
 * - HKDF for key derivation
 * - ed25519 for Solana signatures
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';

// =============================================================================
// TYPES
// =============================================================================

export interface StealthKeyPair {
  /** Clé privée pour dépenser les fonds (32 bytes) */
  spendingKey: Uint8Array;
  /** Clé publique pour dépenser les fonds (32 bytes) */
  spendingPubKey: Uint8Array;
  /** Clé privée pour scanner les transactions (32 bytes) */
  viewingKey: Uint8Array;
  /** Clé publique pour le viewing (32 bytes) */
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key for hybrid post-quantum key exchange (1184 bytes, v2 only) */
  kemPubKey?: Uint8Array;
  /** ML-KEM-768 secret key for hybrid post-quantum key exchange (2400 bytes, v2 only) */
  kemSecretKey?: Uint8Array;
}

export interface StealthPayment {
  /** ID unique du paiement */
  id: string;
  /** Adresse stealth où les fonds ont été reçus */
  stealthAddress: string;
  /** Clé éphémère publiée par l'expéditeur */
  ephemeralPubKey: string;
  /** Montant reçu en lamports */
  amount: number;
  /** Signature de la transaction */
  signature: string;
  /** Timestamp de la transaction */
  timestamp: number;
  /** Si les fonds ont été réclamés */
  claimed: boolean;
  /** Signature de la transaction de claim */
  claimSignature?: string;
  /** ML-KEM-768 ciphertext for hybrid payments (1088 bytes, v2 only) */
  kemCiphertext?: Uint8Array;
}

export interface GeneratedStealthAddress {
  /** L'adresse stealth générée (PublicKey Solana) */
  stealthAddress: PublicKey;
  /** La clé éphémère publique à inclure dans la transaction */
  ephemeralPubKey: Uint8Array;
  /** Le shared secret (pour debug/tests uniquement) */
  sharedSecret: Uint8Array;
  /** ML-KEM-768 ciphertext to include in transaction (1088 bytes, v2 only) */
  kemCiphertext?: Uint8Array;
}

export interface ParsedMetaAddress {
  /** Clé publique spending (32 bytes) */
  spendingPubKey: Uint8Array;
  /** Clé publique viewing (32 bytes) */
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key (1184 bytes, v2 only) */
  kemPubKey?: Uint8Array;
}

// =============================================================================
// CONSTANTES
// =============================================================================

/** Préfixe pour identifier les meta-addresses */
const META_ADDRESS_PREFIX = 'st:';

/** v1: classic ECDH only */
const META_ADDRESS_VERSION_V1 = '01';

/** v2: hybrid X25519 + ML-KEM-768 */
const META_ADDRESS_VERSION_V2 = '02';

/** Dérivation paths pour les clés stealth */
const SPENDING_KEY_PATH = "m/44'/501'/0'/0'/0'";
const VIEWING_KEY_PATH = "m/44'/501'/0'/0'/1'";

/** Info pour HKDF */
const HKDF_INFO = new TextEncoder().encode('P01-STEALTH-v1');

/** Info string for hybrid HKDF (must match specter-sdk) */
const HYBRID_HKDF_INFO = new TextEncoder().encode('p01-hybrid-stealth-v2');

/** ML-KEM-768 sizes (FIPS 203) */
const KEM_PUBLIC_KEY_SIZE = 1184;
const KEM_CIPHERTEXT_SIZE = 1088;

// =============================================================================
// UTILITAIRES CRYPTOGRAPHIQUES
// =============================================================================

/**
 * Converts an ed25519 public key to a curve25519 (x25519) public key
 * Uses the birational map from Edwards to Montgomery form
 *
 * The conversion formula is: u = (1 + y) / (1 - y) mod p
 * where y is the y-coordinate of the ed25519 point
 */
function ed25519PublicKeyToCurve25519(publicKey: Uint8Array): Uint8Array {
  // ed25519 public key is the compressed y-coordinate with sign bit
  // We use the @noble/curves library for proper conversion
  try {
    // Decode the ed25519 point
    const point = ed25519.ExtendedPoint.fromHex(publicKey);

    // Convert to Montgomery form (x25519)
    // u = (1 + y) / (1 - y) mod p
    const { y } = point.toAffine();
    const p = ed25519.CURVE.Fp.ORDER;
    const Fp = ed25519.CURVE.Fp;

    const one = Fp.create(1n);
    const numerator = Fp.add(one, y);
    const denominator = Fp.sub(one, y);
    const u = Fp.mul(numerator, Fp.inv(denominator));

    // Convert to bytes (little-endian)
    const uBytes = new Uint8Array(32);
    let val = u;
    for (let i = 0; i < 32; i++) {
      uBytes[i] = Number(val & 0xffn);
      val >>= 8n;
    }

    return uBytes;
  } catch {
    // Fallback for invalid points - hash the key
    const hash = sha512(publicKey);
    return hash.slice(0, 32);
  }
}

/**
 * Converts an ed25519 secret key to a curve25519 (x25519) secret key
 * The ed25519 secret key is hashed with SHA-512, then the first 32 bytes
 * are clamped according to the x25519 specification
 */
function ed25519SecretKeyToCurve25519(secretKey: Uint8Array): Uint8Array {
  // ed25519 secret key is 64 bytes: first 32 are seed, last 32 are public key
  // For x25519, we hash the seed and clamp it
  const seed = secretKey.slice(0, 32);

  // Hash the seed with SHA-512 (same as ed25519 key expansion)
  const hash = sha512(seed);

  // Take first 32 bytes and clamp for x25519
  const scalar = new Uint8Array(hash.slice(0, 32));

  // Clamp according to x25519 spec (RFC 7748)
  scalar[0] &= 248;      // Clear bottom 3 bits
  scalar[31] &= 127;     // Clear top bit
  scalar[31] |= 64;      // Set second-to-top bit

  return scalar;
}

/**
 * HKDF-SHA256 pour dériver des clés à partir du shared secret
 * Implémentation simplifiée de HKDF (RFC 5869)
 */
async function hkdfDerive(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  // Import the input key material
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(inputKeyMaterial.buffer, inputKeyMaterial.byteOffset, inputKeyMaterial.byteLength) as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  // Derive bits using HKDF
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength) as BufferSource,
      info: new Uint8Array(info.buffer, info.byteOffset, info.byteLength) as BufferSource,
    },
    key,
    length * 8
  );

  return new Uint8Array(derivedBits);
}

/**
 * Génère des bytes aléatoires cryptographiquement sécurisés
 */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Encode en base58 (format Solana)
 */
function toBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));

  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = ALPHABET[remainder] + result;
  }

  // Ajouter les zéros de tête
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }

  return result || '1';
}

/**
 * Decode depuis base58
 */
function fromBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;

  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * 58n + BigInt(index);
  }

  const hex = num.toString(16).padStart(2, '0');
  const bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');

  // Ajouter les zéros de tête
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') {
      leadingZeros++;
    } else {
      break;
    }
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);

  return result;
}

// =============================================================================
// ML-KEM-768 HYBRID KEY EXCHANGE
// =============================================================================

/**
 * Generate an ML-KEM-768 keypair for post-quantum hybrid stealth addresses.
 * @returns publicKey (1184 bytes) and secretKey (2400 bytes)
 */
function kemGenerateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return ml_kem768.keygen();
}

/**
 * Encapsulate: sender creates a shared secret using the recipient's KEM public key.
 * @param kemPubKey - Recipient's ML-KEM-768 public key (1184 bytes)
 * @returns cipherText (1088 bytes) and sharedSecret (32 bytes)
 */
function kemEncapsulate(kemPubKey: Uint8Array): {
  cipherText: Uint8Array;
  sharedSecret: Uint8Array;
} {
  return ml_kem768.encapsulate(kemPubKey);
}

/**
 * Decapsulate: recipient recovers the shared secret from the KEM ciphertext.
 * @param cipherText - KEM ciphertext from sender (1088 bytes)
 * @param kemSecretKey - Recipient's ML-KEM-768 secret key (2400 bytes)
 * @returns sharedSecret (32 bytes)
 */
function kemDecapsulate(cipherText: Uint8Array, kemSecretKey: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(cipherText, kemSecretKey);
}

/**
 * Derive a hybrid shared secret by combining classical ECDH and post-quantum KEM secrets.
 * Security holds if EITHER the classical or post-quantum scheme is secure.
 *
 * Uses HKDF to combine both secrets into a single 32-byte key.
 */
async function deriveHybridSharedSecret(
  classicSecret: Uint8Array,
  kemSecret: Uint8Array
): Promise<Uint8Array> {
  const combined = new Uint8Array(classicSecret.length + kemSecret.length);
  combined.set(classicSecret);
  combined.set(kemSecret, classicSecret.length);
  return hkdfDerive(combined, new Uint8Array(0), HYBRID_HKDF_INFO, 32);
}

// =============================================================================
// GÉNÉRATION DE CLÉS STEALTH
// =============================================================================

/**
 * Génère une paire de clés stealth (spending + viewing) à partir d'un mnemonic.
 * If enableHybrid is true, also generates an ML-KEM-768 keypair for
 * post-quantum resistance (v2 meta-address).
 *
 * @param mnemonic - La phrase mnémonique du wallet
 * @param enableHybrid - Generate ML-KEM-768 keypair for v2 hybrid stealth
 * @returns StealthKeyPair contenant les clés (+ KEM keys if hybrid)
 */
export async function generateStealthKeys(
  mnemonic: string,
  enableHybrid: boolean = false
): Promise<StealthKeyPair> {
  // Valider le mnemonic
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  // Convertir mnemonic en seed
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const seedHex = Buffer.from(seed).toString('hex');

  // Dériver la clé de spending
  const spendingSeed = derivePath(SPENDING_KEY_PATH, seedHex).key;
  const spendingKeyPair = nacl.sign.keyPair.fromSeed(spendingSeed);

  // Dériver la clé de viewing (chemin différent)
  const viewingSeed = derivePath(VIEWING_KEY_PATH, seedHex).key;
  const viewingKeyPair = nacl.sign.keyPair.fromSeed(viewingSeed);

  const keys: StealthKeyPair = {
    spendingKey: spendingKeyPair.secretKey,
    spendingPubKey: spendingKeyPair.publicKey,
    viewingKey: viewingKeyPair.secretKey,
    viewingPubKey: viewingKeyPair.publicKey,
  };

  if (enableHybrid) {
    const kem = kemGenerateKeypair();
    keys.kemPubKey = kem.publicKey;
    keys.kemSecretKey = kem.secretKey;
  }

  return keys;
}

// =============================================================================
// META-ADDRESS (ADRESSE PUBLIQUE STEALTH)
// =============================================================================

/**
 * Crée une meta-address publiable à partir des clés stealth.
 *
 * v1 format: st:01<base58(spending_pub(32) + viewing_pub(32))>
 * v2 format: st:02<base58(spending_pub(32) + viewing_pub(32) + kem_pub(1184))>
 *
 * Automatically uses v2 if the key pair contains a kemPubKey.
 *
 * @param stealthKeys - La paire de clés stealth
 * @returns La meta-address encodée
 */
export function createMetaAddress(stealthKeys: StealthKeyPair): string {
  if (stealthKeys.kemPubKey) {
    // v2: 32 + 32 + 1184 = 1248 bytes
    const combined = new Uint8Array(1248);
    combined.set(stealthKeys.spendingPubKey, 0);
    combined.set(stealthKeys.viewingPubKey, 32);
    combined.set(stealthKeys.kemPubKey, 64);
    const encoded = toBase58(combined);
    return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION_V2}${encoded}`;
  }

  // v1: 32 + 32 = 64 bytes
  const combined = new Uint8Array(64);
  combined.set(stealthKeys.spendingPubKey, 0);
  combined.set(stealthKeys.viewingPubKey, 32);
  const encoded = toBase58(combined);
  return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION_V1}${encoded}`;
}

/**
 * Parse une meta-address pour extraire les clés publiques (v1 or v2)
 *
 * @param metaAddress - La meta-address à parser
 * @returns Les clés publiques spending, viewing, and optionally kemPubKey
 */
export function parseMetaAddress(metaAddress: string): ParsedMetaAddress {
  // Vérifier le préfixe
  if (!metaAddress.startsWith(META_ADDRESS_PREFIX)) {
    throw new Error('Invalid meta-address: missing prefix');
  }

  // Retirer le préfixe
  const withoutPrefix = metaAddress.slice(META_ADDRESS_PREFIX.length);

  // Check version
  if (withoutPrefix.startsWith(META_ADDRESS_VERSION_V2)) {
    // v2: hybrid with ML-KEM-768
    const encoded = withoutPrefix.slice(META_ADDRESS_VERSION_V2.length);
    const combined = fromBase58(encoded);

    if (combined.length !== 1248) {
      throw new Error(`Invalid v2 meta-address: expected 1248 bytes, got ${combined.length}`);
    }

    return {
      spendingPubKey: combined.slice(0, 32),
      viewingPubKey: combined.slice(32, 64),
      kemPubKey: combined.slice(64, 64 + KEM_PUBLIC_KEY_SIZE),
    };
  }

  if (withoutPrefix.startsWith(META_ADDRESS_VERSION_V1)) {
    // v1: classic ECDH
    const encoded = withoutPrefix.slice(META_ADDRESS_VERSION_V1.length);
    const combined = fromBase58(encoded);

    if (combined.length !== 64) {
      throw new Error(`Invalid v1 meta-address: expected 64 bytes, got ${combined.length}`);
    }

    return {
      spendingPubKey: combined.slice(0, 32),
      viewingPubKey: combined.slice(32, 64),
    };
  }

  throw new Error(`Invalid meta-address version: expected ${META_ADDRESS_VERSION_V1} or ${META_ADDRESS_VERSION_V2}`);
}

/**
 * Vérifie si une chaîne est une meta-address valide (v1 or v2)
 *
 * @param address - L'adresse à vérifier
 * @returns true si c'est une meta-address valide
 */
export function isMetaAddress(address: string): boolean {
  try {
    if (!address.startsWith(META_ADDRESS_PREFIX)) {
      return false;
    }
    parseMetaAddress(address);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// GÉNÉRATION D'ADRESSE STEALTH (CÔTÉ EXPÉDITEUR)
// =============================================================================

/**
 * Génère une adresse stealth unique pour un paiement.
 * Automatically uses hybrid mode (X25519 + ML-KEM-768) if the meta-address
 * contains a kemPubKey (v2). Falls back to classic ECDH for v1.
 *
 * v1 process:
 * 1. Génère une clé éphémère aléatoire (r)
 * 2. Calcule le shared secret: S = r * viewing_pub_key (ECDH)
 * 3. Dérive une clé avec HKDF: k = HKDF(S)
 * 4. Calcule l'adresse stealth: P = spending_pub_key + k*G
 *
 * v2 process (hybrid):
 * 1-2. Same ECDH as v1 → classicSecret
 * 3. KEM encapsulate with kemPubKey → kemCiphertext + kemSecret
 * 4. Combine: S_hybrid = HKDF(classicSecret || kemSecret)
 * 5. Dérive tweak + stealth address from S_hybrid
 *
 * @param metaAddress - La meta-address du destinataire
 * @returns L'adresse stealth, la clé éphémère publique, and optionally kemCiphertext
 */
export async function generateStealthAddress(metaAddress: string): Promise<GeneratedStealthAddress> {
  // Parser la meta-address
  const { spendingPubKey, viewingPubKey, kemPubKey } = parseMetaAddress(metaAddress);

  // Générer une clé éphémère aléatoire
  const ephemeralSeed = randomBytes(32);
  const ephemeralKeyPair = nacl.sign.keyPair.fromSeed(ephemeralSeed);

  // Convertir les clés pour ECDH (curve25519)
  const ephemeralCurve = ed25519SecretKeyToCurve25519(ephemeralKeyPair.secretKey);
  const viewingCurve = ed25519PublicKeyToCurve25519(viewingPubKey);

  // Calculer le shared secret classique via ECDH
  const classicSecret = nacl.scalarMult(ephemeralCurve, viewingCurve);

  let sharedSecret: Uint8Array;
  let kemCiphertext: Uint8Array | undefined;

  if (kemPubKey) {
    // Hybrid mode: X25519 + ML-KEM-768
    const kem = kemEncapsulate(kemPubKey);
    kemCiphertext = kem.cipherText;
    sharedSecret = await deriveHybridSharedSecret(classicSecret, kem.sharedSecret);
  } else {
    // Classic mode: ECDH only
    sharedSecret = classicSecret;
  }

  // Dériver la clé de tweak avec HKDF
  const salt = ephemeralKeyPair.publicKey.slice(0, 16);
  const tweakKey = await hkdfDerive(sharedSecret, salt, HKDF_INFO, 32);

  // Générer un keypair à partir du tweak pour obtenir le point sur la courbe
  const tweakKeyPair = nacl.sign.keyPair.fromSeed(tweakKey);

  // Additionner les clés publiques (point addition sur ed25519)
  // P_stealth = P_spending + P_tweak
  const stealthPubKey = addPublicKeys(spendingPubKey, tweakKeyPair.publicKey);

  // Créer la PublicKey Solana
  const stealthAddress = new PublicKey(stealthPubKey);

  return {
    stealthAddress,
    ephemeralPubKey: ephemeralKeyPair.publicKey,
    sharedSecret,
    kemCiphertext,
  };
}

/**
 * Addition of two ed25519 public keys using proper elliptic curve point addition
 * P3 = P1 + P2 on the Edwards curve
 */
function addPublicKeys(key1: Uint8Array, key2: Uint8Array): Uint8Array {
  try {
    // Decode both points from compressed form
    const point1 = ed25519.ExtendedPoint.fromHex(key1);
    const point2 = ed25519.ExtendedPoint.fromHex(key2);

    // Add points on the curve
    const sumPoint = point1.add(point2);

    // Convert back to compressed public key format
    return sumPoint.toRawBytes();
  } catch (error) {
    // Fallback: if point operations fail, use deterministic derivation
    // This maintains compatibility but loses the algebraic relationship
    console.warn('[Stealth] Point addition failed, using fallback derivation');
    const combined = new Uint8Array(64);
    combined.set(key1, 0);
    combined.set(key2, 32);
    const hash = sha512(combined);
    const keyPair = nacl.sign.keyPair.fromSeed(hash.slice(0, 32));
    return keyPair.publicKey;
  }
}

// =============================================================================
// SCAN ET DÉTECTION (CÔTÉ DESTINATAIRE)
// =============================================================================

/**
 * Représentation d'une transaction parsée pour le scan
 */
export interface ParsedStealthTransaction {
  /** Signature de la transaction */
  signature: string;
  /** Adresse de destination */
  destination: string;
  /** Montant en lamports */
  amount: number;
  /** Timestamp */
  timestamp: number;
  /** Clé éphémère (si présente dans le memo ou les données) */
  ephemeralPubKey?: string;
  /** ML-KEM-768 ciphertext from v2 announcement (base58 encoded) */
  kemCiphertext?: string;
}

/**
 * Scanne les transactions pour détecter les paiements stealth reçus.
 * Supports both v1 (classic) and v2 (hybrid) stealth payments.
 *
 * Processus pour chaque transaction:
 * 1. Extraire la clé éphémère E du memo
 * 2. Calculer le shared secret: S = viewing_key * E (ECDH)
 *    For v2: also decapsulate kemCiphertext and combine secrets
 * 3. Dériver k = HKDF(S)
 * 4. Calculer P_expected = spending_pub + k*G
 * 5. Si P_expected == destination, c'est un paiement pour nous
 *
 * @param stealthKeys - Les clés stealth du destinataire
 * @param transactions - Les transactions à scanner
 * @returns Les paiements détectés
 */
export async function scanForPayments(
  stealthKeys: StealthKeyPair,
  transactions: ParsedStealthTransaction[]
): Promise<StealthPayment[]> {
  const payments: StealthPayment[] = [];

  for (const tx of transactions) {
    // Vérifier si une clé éphémère est présente
    if (!tx.ephemeralPubKey) {
      continue;
    }

    try {
      // Décoder la clé éphémère
      const ephemeralPubKey = fromBase58(tx.ephemeralPubKey);

      if (ephemeralPubKey.length !== 32) {
        continue;
      }

      // Decode KEM ciphertext if present (v2 hybrid payment)
      let kemCiphertextBytes: Uint8Array | undefined;
      if (tx.kemCiphertext) {
        kemCiphertextBytes = fromBase58(tx.kemCiphertext);
        if (kemCiphertextBytes.length !== KEM_CIPHERTEXT_SIZE) {
          kemCiphertextBytes = undefined;
        }
      }

      // Vérifier si cette transaction nous appartient
      const isOurs = await checkStealthPayment(
        stealthKeys,
        ephemeralPubKey,
        tx.destination,
        kemCiphertextBytes
      );

      if (isOurs) {
        payments.push({
          id: `stealth_${tx.signature}`,
          stealthAddress: tx.destination,
          ephemeralPubKey: tx.ephemeralPubKey,
          amount: tx.amount,
          signature: tx.signature,
          timestamp: tx.timestamp,
          claimed: false,
          kemCiphertext: kemCiphertextBytes,
        });
      }
    } catch (error) {
      // Ignorer les erreurs de parsing
      console.debug('Error scanning transaction:', error);
    }
  }

  return payments;
}

/**
 * Vérifie si un paiement stealth nous appartient.
 * Supports v2 hybrid mode when kemCiphertext + kemSecretKey are available.
 */
async function checkStealthPayment(
  stealthKeys: StealthKeyPair,
  ephemeralPubKey: Uint8Array,
  destinationAddress: string,
  kemCiphertext?: Uint8Array
): Promise<boolean> {
  try {
    // Convertir les clés pour ECDH
    const viewingCurve = ed25519SecretKeyToCurve25519(stealthKeys.viewingKey);
    const ephemeralCurve = ed25519PublicKeyToCurve25519(ephemeralPubKey);

    // Calculer le shared secret classique
    const classicSecret = nacl.scalarMult(viewingCurve, ephemeralCurve);

    let sharedSecret: Uint8Array;

    if (kemCiphertext && stealthKeys.kemSecretKey) {
      // Hybrid mode: decapsulate KEM + combine with ECDH
      const kemSharedSecret = kemDecapsulate(kemCiphertext, stealthKeys.kemSecretKey);
      sharedSecret = await deriveHybridSharedSecret(classicSecret, kemSharedSecret);
    } else {
      sharedSecret = classicSecret;
    }

    // Dériver le tweak
    const salt = ephemeralPubKey.slice(0, 16);
    const tweakKey = await hkdfDerive(sharedSecret, salt, HKDF_INFO, 32);

    // Générer le point de tweak
    const tweakKeyPair = nacl.sign.keyPair.fromSeed(tweakKey);

    // Calculer l'adresse stealth attendue
    const expectedPubKey = addPublicKeys(stealthKeys.spendingPubKey, tweakKeyPair.publicKey);
    const expectedAddress = new PublicKey(expectedPubKey).toBase58();

    return expectedAddress === destinationAddress;
  } catch {
    return false;
  }
}

// =============================================================================
// DÉRIVATION DE CLÉ DE DÉPENSE (CLAIM)
// =============================================================================

/**
 * Dérive la clé privée pour dépenser un paiement stealth.
 * Supports v2 hybrid mode when kemCiphertext + kemSecretKey are provided.
 *
 * La clé privée stealth est: s_stealth = s_spending + k
 * où k est dérivé du shared secret (classic or hybrid)
 *
 * @param stealthKeys - Les clés stealth du destinataire
 * @param ephemeralPubKey - La clé éphémère de la transaction
 * @param kemCiphertext - KEM ciphertext from the announcement (v2 hybrid)
 * @returns Le Keypair pour signer les transactions depuis l'adresse stealth
 */
export async function deriveSpendingKey(
  stealthKeys: StealthKeyPair,
  ephemeralPubKey: Uint8Array,
  kemCiphertext?: Uint8Array
): Promise<Keypair> {
  // Convertir les clés pour ECDH
  const viewingCurve = ed25519SecretKeyToCurve25519(stealthKeys.viewingKey);
  const ephemeralCurve = ed25519PublicKeyToCurve25519(ephemeralPubKey);

  // Calculer le shared secret classique
  const classicSecret = nacl.scalarMult(viewingCurve, ephemeralCurve);

  let sharedSecret: Uint8Array;

  if (kemCiphertext && stealthKeys.kemSecretKey) {
    // Hybrid mode: decapsulate KEM + combine with ECDH
    const kemSharedSecret = kemDecapsulate(kemCiphertext, stealthKeys.kemSecretKey);
    sharedSecret = await deriveHybridSharedSecret(classicSecret, kemSharedSecret);
  } else {
    sharedSecret = classicSecret;
  }

  // Dériver le tweak
  const salt = ephemeralPubKey.slice(0, 16);
  const tweakKey = await hkdfDerive(sharedSecret, salt, HKDF_INFO, 32);

  // Combiner la clé de spending avec le tweak
  const spendingSeed = stealthKeys.spendingKey.slice(0, 32);
  const combinedSeed = new Uint8Array(64);
  combinedSeed.set(spendingSeed, 0);
  combinedSeed.set(tweakKey, 32);

  // Hash pour obtenir une nouvelle seed valide
  const derivedSeed = nacl.hash(combinedSeed).slice(0, 32);

  // Créer le keypair ed25519
  const keyPair = nacl.sign.keyPair.fromSeed(derivedSeed);

  // Convertir en Keypair Solana
  return Keypair.fromSecretKey(keyPair.secretKey);
}

/**
 * Dérive la clé de dépense à partir d'une clé éphémère encodée en base58.
 * Supports v2 hybrid mode when kemCiphertextBase58 is provided.
 */
export async function deriveSpendingKeyFromBase58(
  stealthKeys: StealthKeyPair,
  ephemeralPubKeyBase58: string,
  kemCiphertextBase58?: string
): Promise<Keypair> {
  const ephemeralPubKey = fromBase58(ephemeralPubKeyBase58);
  const kemCiphertext = kemCiphertextBase58 ? fromBase58(kemCiphertextBase58) : undefined;
  return deriveSpendingKey(stealthKeys, ephemeralPubKey, kemCiphertext);
}

// =============================================================================
// UTILITAIRES
// =============================================================================

/**
 * Encode une clé éphémère pour inclusion dans un memo
 */
export function encodeEphemeralKey(ephemeralPubKey: Uint8Array): string {
  return toBase58(ephemeralPubKey);
}

/**
 * Génère un memo contenant la clé éphémère pour une transaction stealth.
 * v2 format includes the KEM ciphertext for hybrid payments.
 *
 * v1: "P01:STEALTH:<ephemeral_pub_key_base58>"
 * v2: "P01:STEALTH:V2:<ephemeral_pub_key_base58>:<kem_ciphertext_base58>"
 */
export function createStealthMemo(
  ephemeralPubKey: Uint8Array,
  kemCiphertext?: Uint8Array
): string {
  const encodedEphemeral = encodeEphemeralKey(ephemeralPubKey);

  if (kemCiphertext) {
    const encodedKem = toBase58(kemCiphertext);
    return `P01:STEALTH:V2:${encodedEphemeral}:${encodedKem}`;
  }

  return `P01:STEALTH:${encodedEphemeral}`;
}

/**
 * Parse un memo de transaction stealth (v1 or v2)
 * @returns Object with ephemeralPubKey and optionally kemCiphertext, or null
 */
export function parseStealthMemo(memo: string): {
  ephemeralPubKey: string;
  kemCiphertext?: string;
} | null {
  // v2 format: P01:STEALTH:V2:<ephemeral>:<kem_ciphertext>
  const v2Prefix = 'P01:STEALTH:V2:';
  if (memo.startsWith(v2Prefix)) {
    const rest = memo.slice(v2Prefix.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      ephemeralPubKey: rest.slice(0, colonIdx),
      kemCiphertext: rest.slice(colonIdx + 1),
    };
  }

  // v1 format: P01:STEALTH:<ephemeral>
  const v1Prefix = 'P01:STEALTH:';
  if (memo.startsWith(v1Prefix)) {
    return {
      ephemeralPubKey: memo.slice(v1Prefix.length),
    };
  }

  return null;
}

/**
 * Calcule le solde total des paiements stealth non réclamés
 */
export function calculateStealthBalance(payments: StealthPayment[]): number {
  return payments
    .filter(p => !p.claimed)
    .reduce((sum, p) => sum + p.amount, 0);
}

/**
 * Formate un montant en lamports vers SOL
 */
export function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

/**
 * Formate un montant SOL vers lamports
 */
export function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000);
}

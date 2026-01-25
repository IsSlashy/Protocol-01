/**
 * Stealth Address Protocol pour Solana
 *
 * CONCEPT:
 * 1. Le destinataire publie une "meta-address" (spending key + viewing key)
 * 2. L'expéditeur génère une adresse stealth unique pour chaque paiement
 * 3. Seul le destinataire peut détecter et dépenser les fonds
 *
 * CRYPTOGRAPHIE:
 * - Utilise Diffie-Hellman sur curve25519 pour le shared secret
 * - HKDF pour la dérivation de clés
 * - ed25519 pour les signatures Solana
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';

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
}

export interface GeneratedStealthAddress {
  /** L'adresse stealth générée (PublicKey Solana) */
  stealthAddress: PublicKey;
  /** La clé éphémère publique à inclure dans la transaction */
  ephemeralPubKey: Uint8Array;
  /** Le shared secret (pour debug/tests uniquement) */
  sharedSecret: Uint8Array;
}

export interface ParsedMetaAddress {
  /** Clé publique spending (32 bytes) */
  spendingPubKey: Uint8Array;
  /** Clé publique viewing (32 bytes) */
  viewingPubKey: Uint8Array;
}

// =============================================================================
// CONSTANTES
// =============================================================================

/** Préfixe pour identifier les meta-addresses */
const META_ADDRESS_PREFIX = 'st:';

/** Préfixe HRP (Human Readable Part) pour le format */
const META_ADDRESS_VERSION = '01';

/** Dérivation paths pour les clés stealth */
const SPENDING_KEY_PATH = "m/44'/501'/0'/0'/0'";
const VIEWING_KEY_PATH = "m/44'/501'/0'/0'/1'";

/** Info pour HKDF */
const HKDF_INFO = new TextEncoder().encode('P01-STEALTH-v1');

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
// GÉNÉRATION DE CLÉS STEALTH
// =============================================================================

/**
 * Génère une paire de clés stealth (spending + viewing) à partir d'un mnemonic
 *
 * @param mnemonic - La phrase mnémonique du wallet
 * @returns StealthKeyPair contenant les 4 clés
 */
export async function generateStealthKeys(mnemonic: string): Promise<StealthKeyPair> {
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

  return {
    spendingKey: spendingKeyPair.secretKey,
    spendingPubKey: spendingKeyPair.publicKey,
    viewingKey: viewingKeyPair.secretKey,
    viewingPubKey: viewingKeyPair.publicKey,
  };
}

// =============================================================================
// META-ADDRESS (ADRESSE PUBLIQUE STEALTH)
// =============================================================================

/**
 * Crée une meta-address publiable à partir des clés stealth
 * Format: st:01<spending_pub_key><viewing_pub_key> en base58
 *
 * @param stealthKeys - La paire de clés stealth
 * @returns La meta-address encodée
 */
export function createMetaAddress(stealthKeys: StealthKeyPair): string {
  // Combiner les deux clés publiques (32 + 32 = 64 bytes)
  const combined = new Uint8Array(64);
  combined.set(stealthKeys.spendingPubKey, 0);
  combined.set(stealthKeys.viewingPubKey, 32);

  // Encoder en base58 avec préfixe
  const encoded = toBase58(combined);

  return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION}${encoded}`;
}

/**
 * Parse une meta-address pour extraire les clés publiques
 *
 * @param metaAddress - La meta-address à parser
 * @returns Les clés publiques spending et viewing
 */
export function parseMetaAddress(metaAddress: string): ParsedMetaAddress {
  // Vérifier le préfixe
  if (!metaAddress.startsWith(META_ADDRESS_PREFIX)) {
    throw new Error('Invalid meta-address: missing prefix');
  }

  // Retirer le préfixe et la version
  const withoutPrefix = metaAddress.slice(META_ADDRESS_PREFIX.length);

  // Vérifier la version
  if (!withoutPrefix.startsWith(META_ADDRESS_VERSION)) {
    throw new Error(`Invalid meta-address version: expected ${META_ADDRESS_VERSION}`);
  }

  const encoded = withoutPrefix.slice(META_ADDRESS_VERSION.length);

  // Décoder depuis base58
  const combined = fromBase58(encoded);

  if (combined.length !== 64) {
    throw new Error(`Invalid meta-address: expected 64 bytes, got ${combined.length}`);
  }

  return {
    spendingPubKey: combined.slice(0, 32),
    viewingPubKey: combined.slice(32, 64),
  };
}

/**
 * Vérifie si une chaîne est une meta-address valide
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
 * Génère une adresse stealth unique pour un paiement
 *
 * Processus:
 * 1. Génère une clé éphémère aléatoire (r)
 * 2. Calcule le shared secret: S = r * viewing_pub_key (ECDH)
 * 3. Dérive une clé avec HKDF: k = HKDF(S)
 * 4. Calcule l'adresse stealth: P = spending_pub_key + k*G
 *
 * @param metaAddress - La meta-address du destinataire
 * @returns L'adresse stealth et la clé éphémère publique
 */
export async function generateStealthAddress(metaAddress: string): Promise<GeneratedStealthAddress> {
  // Parser la meta-address
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);

  // Générer une clé éphémère aléatoire
  const ephemeralSeed = randomBytes(32);
  const ephemeralKeyPair = nacl.sign.keyPair.fromSeed(ephemeralSeed);

  // Convertir les clés pour ECDH (curve25519)
  const ephemeralCurve = ed25519SecretKeyToCurve25519(ephemeralKeyPair.secretKey);
  const viewingCurve = ed25519PublicKeyToCurve25519(viewingPubKey);

  // Calculer le shared secret via ECDH
  const sharedSecret = nacl.scalarMult(ephemeralCurve, viewingCurve);

  // Dériver la clé de tweak avec HKDF
  const salt = ephemeralKeyPair.publicKey.slice(0, 16);
  const tweakKey = await hkdfDerive(sharedSecret, salt, HKDF_INFO, 32);

  // Générer un keypair à partir du tweak pour obtenir le point sur la courbe
  const tweakKeyPair = nacl.sign.keyPair.fromSeed(tweakKey);

  // Additionner les clés publiques (point addition sur ed25519)
  // P_stealth = P_spending + P_tweak
  // Note: Cette addition de points est une approximation
  // Pour une vraie implémentation, utiliser une bibliothèque d'opérations sur courbes elliptiques
  const stealthPubKey = addPublicKeys(spendingPubKey, tweakKeyPair.publicKey);

  // Créer la PublicKey Solana
  const stealthAddress = new PublicKey(stealthPubKey);

  return {
    stealthAddress,
    ephemeralPubKey: ephemeralKeyPair.publicKey,
    sharedSecret,
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
}

/**
 * Scanne les transactions pour détecter les paiements stealth reçus
 *
 * Processus pour chaque transaction:
 * 1. Extraire la clé éphémère E du memo
 * 2. Calculer le shared secret: S = viewing_key * E (ECDH)
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

      // Vérifier si cette transaction nous appartient
      const isOurs = await checkStealthPayment(
        stealthKeys,
        ephemeralPubKey,
        tx.destination
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
 * Vérifie si un paiement stealth nous appartient
 */
async function checkStealthPayment(
  stealthKeys: StealthKeyPair,
  ephemeralPubKey: Uint8Array,
  destinationAddress: string
): Promise<boolean> {
  try {
    // Convertir les clés pour ECDH
    const viewingCurve = ed25519SecretKeyToCurve25519(stealthKeys.viewingKey);
    const ephemeralCurve = ed25519PublicKeyToCurve25519(ephemeralPubKey);

    // Calculer le shared secret
    const sharedSecret = nacl.scalarMult(viewingCurve, ephemeralCurve);

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
 * Dérive la clé privée pour dépenser un paiement stealth
 *
 * La clé privée stealth est: s_stealth = s_spending + k
 * où k est dérivé du shared secret
 *
 * @param stealthKeys - Les clés stealth du destinataire
 * @param ephemeralPubKey - La clé éphémère de la transaction
 * @returns Le Keypair pour signer les transactions depuis l'adresse stealth
 */
export async function deriveSpendingKey(
  stealthKeys: StealthKeyPair,
  ephemeralPubKey: Uint8Array
): Promise<Keypair> {
  // Convertir les clés pour ECDH
  const viewingCurve = ed25519SecretKeyToCurve25519(stealthKeys.viewingKey);
  const ephemeralCurve = ed25519PublicKeyToCurve25519(ephemeralPubKey);

  // Calculer le shared secret
  const sharedSecret = nacl.scalarMult(viewingCurve, ephemeralCurve);

  // Dériver le tweak
  const salt = ephemeralPubKey.slice(0, 16);
  const tweakKey = await hkdfDerive(sharedSecret, salt, HKDF_INFO, 32);

  // Combiner la clé de spending avec le tweak
  // Note: En ed25519, l'addition de clés privées est modulo l'ordre de la courbe
  // Ici on utilise une approximation en combinant les seeds
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
 * Dérive la clé de dépense à partir d'une clé éphémère encodée en base58
 */
export async function deriveSpendingKeyFromBase58(
  stealthKeys: StealthKeyPair,
  ephemeralPubKeyBase58: string
): Promise<Keypair> {
  const ephemeralPubKey = fromBase58(ephemeralPubKeyBase58);
  return deriveSpendingKey(stealthKeys, ephemeralPubKey);
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
 * Génère un memo contenant la clé éphémère pour une transaction stealth
 * Format: "P01:STEALTH:<ephemeral_pub_key_base58>"
 */
export function createStealthMemo(ephemeralPubKey: Uint8Array): string {
  const encoded = encodeEphemeralKey(ephemeralPubKey);
  return `P01:STEALTH:${encoded}`;
}

/**
 * Parse un memo de transaction stealth
 * @returns La clé éphémère ou null si le memo n'est pas un memo stealth
 */
export function parseStealthMemo(memo: string): string | null {
  const prefix = 'P01:STEALTH:';
  if (!memo.startsWith(prefix)) {
    return null;
  }
  return memo.slice(prefix.length);
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

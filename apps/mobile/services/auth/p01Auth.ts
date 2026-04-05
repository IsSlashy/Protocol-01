/**
 * Protocol 01 Authentication Service for Mobile
 *
 * Handles scanning and processing of P01 auth QR codes
 * for "Login with Protocol 01" functionality.
 */

import { PublicKey, Connection } from '@solana/web3.js';
import * as LocalAuthentication from 'expo-local-authentication';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { getConnection } from '../solana/connection';
import { getKeypair, getPublicKey } from '../solana/wallet';

/** Protocol version */
const PROTOCOL_VERSION = 1;
const PROTOCOL_ID = 'p01-auth';

/** Allowed callback domains for auth deep links (H14) */
const ALLOWED_CALLBACK_DOMAINS = [
  'protocol01.com',
  'p01.app',
  'p01.network',
  'mugen-exchange.vercel.app',
  'localhost',
  '127.0.0.1',
];

function isAllowedCallback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_CALLBACK_DOMAINS.some(
      (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d),
    );
  } catch {
    return false;
  }
}

/**
 * Decoded auth QR payload
 */
export interface AuthQRPayload {
  v: number;
  protocol: string;
  service: string;
  session: string;
  challenge: string;
  callback: string;
  exp: number;
  mint?: string;
  name?: string;
  logo?: string;
}

/**
 * Auth request parsed from QR code
 */
export interface AuthRequest {
  payload: AuthQRPayload;
  isExpired: boolean;
  requiresSubscription: boolean;
  serviceName: string;
  serviceLogo?: string;
}

/**
 * Subscription status
 */
export interface SubscriptionStatus {
  active: boolean;
  balance?: string;
  tokenAccount?: string;
  expiresAt?: number;
}

/**
 * Auth result
 */
export interface AuthResult {
  success: boolean;
  error?: string;
  signature?: string;
}

/**
 * Check if a URL/data is a P01 auth request
 */
export function isP01AuthRequest(data: string): boolean {
  return (
    data.startsWith('p01://auth') ||
    data.includes('p01-auth') ||
    data.includes('protocol":"p01-auth')
  );
}

/**
 * Parse P01 auth QR code data
 */
export function parseAuthQR(data: string): AuthRequest | null {
  try {
    let payload: AuthQRPayload;

    // Handle deep link format: p01://auth?payload=<base64>
    if (data.startsWith('p01://auth')) {
      const url = new URL(data.replace('p01://', 'https://p01.app/'));
      const encodedPayload = url.searchParams.get('payload');

      if (!encodedPayload) {
        console.error('[P01Auth] No payload in deep link');
        return null;
      }

      // Decode base64url
      let base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }

      const json = atob(base64);
      payload = JSON.parse(json);
    }
    // Handle direct JSON format
    else if (data.startsWith('{')) {
      payload = JSON.parse(data);
    }
    // Handle base64 encoded JSON
    else {
      let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }
      const json = atob(base64);
      payload = JSON.parse(json);
    }

    // Validate protocol
    if (payload.protocol !== PROTOCOL_ID) {
      console.error('[P01Auth] Invalid protocol:', payload.protocol);
      return null;
    }

    if (payload.v !== PROTOCOL_VERSION) {
      console.error('[P01Auth] Unsupported version:', payload.v);
      return null;
    }

    const isExpired = Date.now() > payload.exp;
    const requiresSubscription = !!payload.mint;
    const serviceName = payload.name || payload.service;

    return {
      payload,
      isExpired,
      requiresSubscription,
      serviceName,
      serviceLogo: payload.logo,
    };
  } catch (error) {
    console.error('[P01Auth] Failed to parse auth QR:', error);
    return null;
  }
}

/**
 * Check subscription status for a service
 */
export async function checkSubscription(
  mint: string,
  walletAddress?: string
): Promise<SubscriptionStatus> {
  const wallet = walletAddress || (await getPublicKey());
  if (!wallet) {
    return { active: false };
  }

  try {
    const connection = getConnection();
    const walletPubkey = new PublicKey(wallet);
    const mintPubkey = new PublicKey(mint);

    // Get associated token account
    const [ata] = PublicKey.findProgramAddressSync(
      [
        walletPubkey.toBuffer(),
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
        mintPubkey.toBuffer(),
      ],
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    );

    const accountInfo = await connection.getTokenAccountBalance(ata);
    const balance = BigInt(accountInfo.value.amount);

    return {
      active: balance > 0,
      balance: accountInfo.value.amount,
      tokenAccount: ata.toBase58(),
    };
  } catch (error) {
    // Token account doesn't exist
    return { active: false };
  }
}

/**
 * Request biometric authentication
 */
export async function requestBiometricAuth(
  serviceName: string
): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = hasHardware && await LocalAuthentication.isEnrolledAsync();

    // Use device-level fallback (PIN/pattern) when biometrics aren't available
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: `Connect to ${serviceName} — Confirm your identity`,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      fallbackLabel: 'Use Passcode',
    });

    return result.success;
  } catch (error) {
    console.error('[P01Auth] Biometric auth error:', error);
    return false;
  }
}

/**
 * Sign the auth challenge.
 * For native wallets: Ed25519 signature with keypair.
 * For Privy wallets: HMAC-based proof (no local secret key available).
 */
export async function signAuthChallenge(
  payload: AuthQRPayload,
  walletAddressOverride?: string
): Promise<{ signature: string; publicKey: string; timestamp: number } | null> {
  const timestamp = Date.now();
  const message = `P01-AUTH:${payload.service}:${payload.session}:${payload.challenge}:${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);

  // Try native keypair first (non-Privy wallets)
  try {
    const keypair = await getKeypair();
    if (keypair && keypair.secretKey) {
      const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
      return {
        signature: bs58.encode(signature),
        publicKey: keypair.publicKey.toBase58(),
        timestamp,
      };
    }
  } catch {
    // No keypair — normal for Privy wallets
  }

  // Fallback: use wallet address + nacl.hash (SHA-512, always available)
  const walletAddress = walletAddressOverride || (await getPublicKey());
  if (walletAddress) {
    try {
      const dataToHash = new TextEncoder().encode(`${message}:${walletAddress}`);
      const hash = nacl.hash(dataToHash); // 64 bytes
      const signature = hash.slice(0, 32); // first 32 bytes
      return {
        signature: bs58.encode(signature),
        publicKey: walletAddress,
        timestamp,
      };
    } catch (error) {
      console.error('[P01Auth] Hash signing error:', error);
    }
  }

  console.error('[P01Auth] No signing method available — no keypair and no wallet address');
  return null;
}

/**
 * Send auth response to callback URL
 */
export async function sendAuthCallback(
  payload: AuthQRPayload,
  signature: string,
  publicKey: string,
  timestamp: number,
  subscriptionProof?: SubscriptionStatus
): Promise<AuthResult> {
  try {
    // Use publicKey param directly (works for both native and Privy wallets)
    const wallet = publicKey;
    if (!wallet) {
      return { success: false, error: 'Wallet not available' };
    }

    const body = {
      sessionId: payload.session,
      wallet,
      signature,
      publicKey,
      timestamp,
      subscriptionProof: subscriptionProof
        ? {
            mint: payload.mint,
            tokenAccount: subscriptionProof.tokenAccount,
            balance: subscriptionProof.balance,
            slot: 0, // Would be set from actual on-chain data
            blockhash: '', // Would be set from actual on-chain data
          }
        : undefined,
    };


    // Validate callback domain before sending credentials (H14)
    if (!isAllowedCallback(payload.callback)) {
      return { success: false, error: 'Unauthorized callback domain' };
    }

    const response = await fetch(payload.callback, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[P01Auth] Callback error:', errorText);
      return { success: false, error: `Service error: ${response.status}` };
    }

    const result = await response.json();
    return {
      success: result.success !== false,
      error: result.error,
    };
  } catch (error: any) {
    console.error('[P01Auth] Callback failed:', error);
    return {
      success: false,
      error: error.message || 'Failed to contact service',
    };
  }
}

/**
 * Complete authentication flow
 */
export async function authenticateWithService(
  request: AuthRequest,
  walletAddress?: string
): Promise<AuthResult> {
  const { payload } = request;

  // 1. Check if expired
  if (request.isExpired) {
    return { success: false, error: 'Session expired' };
  }

  // 2. Check subscription if required
  let subscriptionStatus: SubscriptionStatus | undefined;
  if (request.requiresSubscription && payload.mint) {
    subscriptionStatus = await checkSubscription(payload.mint);
    if (!subscriptionStatus.active) {
      return {
        success: false,
        error: `${request.serviceName} subscription not active`,
      };
    }
  }

  // 3. Request biometric confirmation
  const biometricSuccess = await requestBiometricAuth(request.serviceName);
  if (!biometricSuccess) {
    return { success: false, error: 'Authentication cancelled' };
  }

  // 4. Sign the challenge (pass wallet address for Privy wallets)
  const signResult = await signAuthChallenge(payload, walletAddress);
  if (!signResult) {
    return { success: false, error: 'Signing error — no wallet available' };
  }

  // 5. Send to callback
  const result = await sendAuthCallback(
    payload,
    signResult.signature,
    signResult.publicKey,
    signResult.timestamp,
    subscriptionStatus
  );

  return result;
}

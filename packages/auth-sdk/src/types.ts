/**
 * Protocol 01 Authentication Types
 *
 * Protocol Flow:
 * 1. Service generates session with challenge
 * 2. User scans QR code with P01 mobile app
 * 3. App verifies user has active subscription
 * 4. User confirms with biometrics
 * 5. App signs challenge and sends to callback
 * 6. Service verifies signature and subscription proof
 */

/**
 * Registered services that can use P01 Auth
 */
export interface ServiceConfig {
  /** Unique service identifier */
  serviceId: string;
  /** Human-readable service name */
  serviceName: string;
  /** Service logo URL for display in mobile app */
  logoUrl?: string;
  /** SPL token mint address for subscription verification */
  subscriptionMint?: string;
  /** Callback URL for auth completion */
  callbackUrl: string;
  /** Allowed origins for CORS */
  allowedOrigins?: string[];
}

/**
 * QR Code payload - embedded in QR code
 */
export interface AuthQRPayload {
  /** Protocol version */
  v: 1;
  /** Protocol identifier */
  protocol: 'p01-auth';
  /** Service identifier */
  service: string;
  /** Unique session ID */
  session: string;
  /** Random challenge to sign */
  challenge: string;
  /** Callback URL */
  callback: string;
  /** Session expiration timestamp (Unix ms) */
  exp: number;
  /** Optional: subscription mint to verify */
  mint?: string;
  /** Optional: service display name */
  name?: string;
  /** Optional: service logo */
  logo?: string;
}

/**
 * Deep link URL format
 * p01://auth?payload=<base64_encoded_AuthQRPayload>
 */
export type AuthDeepLink = `p01://auth?payload=${string}`;

/**
 * Auth session status
 */
export type SessionStatus =
  | 'pending'      // Waiting for user to scan
  | 'scanned'      // User scanned, waiting for confirmation
  | 'confirmed'    // User confirmed with biometrics
  | 'completed'    // Auth successful
  | 'expired'      // Session timed out
  | 'rejected'     // User rejected
  | 'failed';      // Auth failed (invalid subscription, etc.)

/**
 * Auth session stored server-side
 */
export interface AuthSession {
  /** Unique session ID */
  sessionId: string;
  /** Service this session is for */
  serviceId: string;
  /** Challenge string to be signed */
  challenge: string;
  /** Current session status */
  status: SessionStatus;
  /** Session creation timestamp */
  createdAt: number;
  /** Session expiration timestamp */
  expiresAt: number;
  /** User's wallet address (set after scan) */
  walletAddress?: string;
  /** Signature of challenge (set after confirmation) */
  signature?: string;
  /** Subscription proof (set after confirmation) */
  subscriptionProof?: SubscriptionProof;
  /** IP address of scanner */
  scannerIp?: string;
  /** Device info */
  deviceInfo?: string;
}

/**
 * Proof that user has active subscription
 */
export interface SubscriptionProof {
  /** Subscription token mint */
  mint: string;
  /** User's token account */
  tokenAccount: string;
  /** Current balance (should be > 0 for active) */
  balance: string;
  /** Subscription expiration (if applicable) */
  expiresAt?: number;
  /** On-chain slot when verified */
  slot: number;
  /** Blockhash at verification time */
  blockhash: string;
}

/**
 * Auth response sent from mobile app to service
 */
export interface AuthResponse {
  /** Session ID being confirmed */
  sessionId: string;
  /** User's wallet address */
  wallet: string;
  /** Signature of the challenge */
  signature: string;
  /** Public key used for signing (base58) */
  publicKey: string;
  /** Subscription proof (if subscription required) */
  subscriptionProof?: SubscriptionProof;
  /** Timestamp of confirmation */
  timestamp: number;
  /** Device identifier (for session management) */
  deviceId?: string;
}

/**
 * Verification result from server
 */
export interface VerificationResult {
  /** Whether auth was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Verified wallet address */
  wallet?: string;
  /** Whether subscription is active */
  subscriptionActive?: boolean;
  /** Session metadata */
  session?: {
    id: string;
    createdAt: number;
    expiresAt: number;
  };
}

/**
 * Events emitted during auth flow
 */
export type AuthEvent =
  | { type: 'session_created'; session: AuthSession }
  | { type: 'session_scanned'; session: AuthSession }
  | { type: 'session_confirmed'; session: AuthSession }
  | { type: 'session_completed'; session: AuthSession; wallet: string }
  | { type: 'session_expired'; sessionId: string }
  | { type: 'session_rejected'; sessionId: string }
  | { type: 'session_failed'; sessionId: string; error: string };

/**
 * WebSocket message types for real-time updates
 */
export interface WSMessage {
  type: 'subscribe' | 'unsubscribe' | 'event' | 'ping' | 'pong';
  sessionId?: string;
  event?: AuthEvent;
}

/**
 * QR Code display options
 */
export interface QRDisplayOptions {
  /** Size in pixels */
  size?: number;
  /** Include logo in center */
  logo?: boolean;
  /** Logo URL (defaults to service logo) */
  logoUrl?: string;
  /** Error correction level */
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  /** Dark color */
  darkColor?: string;
  /** Light color */
  lightColor?: string;
}

/**
 * Mobile app auth handling options
 */
export interface MobileAuthOptions {
  /** Require biometric confirmation */
  requireBiometrics?: boolean;
  /** Custom confirmation message */
  confirmMessage?: string;
  /** Auto-confirm if already authenticated recently */
  autoConfirmWindow?: number;
  /** Show subscription details */
  showSubscriptionInfo?: boolean;
}

/**
 * Protocol 01 Auth Server SDK
 *
 * Server-side utilities for verifying P01 authentication
 *
 * @example
 * ```typescript
 * import { P01AuthServer } from '@protocol-01/auth-sdk/server';
 *
 * const auth = new P01AuthServer({
 *   serviceId: 'my-service',
 *   subscriptionMint: 'SUBSxxxx...',
 *   rpcUrl: 'https://api.mainnet-beta.solana.com',
 * });
 *
 * // In your callback endpoint
 * app.post('/auth/callback', async (req, res) => {
 *   const result = await auth.verifyCallback(req.body);
 *   if (result.success) {
 *     // Create user session
 *     req.session.wallet = result.wallet;
 *   }
 * });
 * ```
 */

import { Connection, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  AuthResponse,
  SubscriptionProof,
  VerificationResult,
  AuthSession,
} from './types';
import { createSignMessage, isTimestampValid } from './protocol';

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

const NETWORK_RPC_URLS: Record<SolanaNetwork, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
};

export interface P01AuthServerConfig {
  /** Your service ID (must be non-empty) */
  serviceId: string;
  /** SPL token mint for subscription (optional) */
  subscriptionMint?: string;
  /**
   * Solana RPC URL. Defaults to mainnet-beta.
   * For devnet testing, pass `rpcUrl: 'https://api.devnet.solana.com'`
   * or use the `network` option instead.
   */
  rpcUrl?: string;
  /**
   * Solana network to connect to. Auto-selects the right public RPC URL.
   * Ignored if `rpcUrl` is explicitly provided.
   *
   * @example
   * ```typescript
   * // Quick devnet setup:
   * const auth = new P01AuthServer({
   *   serviceId: 'my-service',
   *   network: 'devnet',
   * });
   * ```
   */
  network?: SolanaNetwork;
  /** Maximum age of auth timestamp (default: 60s) */
  maxTimestampAge?: number;
  /**
   * Where the server keeps the sessions it issued. Without one (and without a
   * `session` passed to `verifyCallback`), there is no session to check:
   * "Session not found" / "Session expired" are never returned and a signed
   * callback verifies again within `maxTimestampAge` (a replay).
   */
  sessionStore?: ServerSessionStore;
  /**
   * Fail closed when there is no session to check: `verifyCallback` with
   * neither a `sessionStore` nor a `session` returns "Session not found"
   * before any signature check. Default `false` only because turning it on
   * refuses every caller that verifies without a store today (audit v1 F78);
   * set it to `true`.
   */
  requireSession?: boolean;
}

/**
 * Session store interface for multi-server setups.
 *
 * The server has NO default store: without one, sessions are not checked
 * (see `P01AuthServerConfig.sessionStore`). Implement this interface with a
 * persistent store shared by every server instance.
 *
 * @example Redis implementation:
 * ```typescript
 * import { createClient } from 'redis';
 *
 * const redis = createClient();
 * const sessionStore: ServerSessionStore = {
 *   async get(sessionId) {
 *     const data = await redis.get(`p01:session:${sessionId}`);
 *     return data ? JSON.parse(data) : null;
 *   },
 *   async set(session) {
 *     const ttl = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
 *     await redis.set(`p01:session:${session.sessionId}`, JSON.stringify(session), { EX: ttl });
 *   },
 *   async delete(sessionId) {
 *     await redis.del(`p01:session:${sessionId}`);
 *   },
 * };
 * ```
 *
 * @example PostgreSQL implementation:
 * ```typescript
 * import { Pool } from 'pg';
 *
 * const pool = new Pool();
 * const sessionStore: ServerSessionStore = {
 *   async get(sessionId) {
 *     const { rows } = await pool.query(
 *       'SELECT data FROM p01_sessions WHERE id = $1 AND expires_at > NOW()',
 *       [sessionId]
 *     );
 *     return rows[0]?.data ?? null;
 *   },
 *   async set(session) {
 *     await pool.query(
 *       'INSERT INTO p01_sessions (id, data, expires_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2',
 *       [session.sessionId, session, new Date(session.expiresAt)]
 *     );
 *   },
 *   async delete(sessionId) {
 *     await pool.query('DELETE FROM p01_sessions WHERE id = $1', [sessionId]);
 *   },
 * };
 * ```
 */
export interface ServerSessionStore {
  get(sessionId: string): Promise<AuthSession | null>;
  set(session: AuthSession): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * P01 Auth Server for backend verification
 */
export class P01AuthServer {
  private config: P01AuthServerConfig;
  private connection: Connection | null = null;

  constructor(config: P01AuthServerConfig) {
    if (!config.serviceId) {
      throw new Error('[P01Auth] serviceId is required and must be non-empty');
    }

    // Resolve RPC URL: explicit rpcUrl > network shorthand > mainnet default
    const resolvedRpcUrl =
      config.rpcUrl ??
      (config.network ? NETWORK_RPC_URLS[config.network] : NETWORK_RPC_URLS['mainnet-beta']);

    this.config = {
      maxTimestampAge: 60000,
      ...config,
      rpcUrl: resolvedRpcUrl,
    };

    if (this.config.subscriptionMint) {
      this.connection = new Connection(this.config.rpcUrl!);
    }
  }

  /**
   * Verify an authentication callback from the mobile app.
   *
   * @param response - The auth response received at your callback URL
   * @param session - Optional session object (if not using sessionStore)
   * @returns Verification result with wallet address on success
   *
   * @throws Never throws -- returns `{ success: false, error }` on failure.
   * Common errors:
   * - `"Timestamp expired or invalid"` -- the auth response is too old (> maxTimestampAge)
   * - `"Session not found"` -- a `sessionStore` is configured and does not hold
   *   `response.sessionId`, or the `session` passed has a different id
   * - `"Session expired"` -- the session is past its `expiresAt`
   * - `"Session already completed"` -- the session was already verified once
   * - `"Invalid signature"` -- the Ed25519 signature does not match
   * - `"Subscription not active"` -- the wallet does not hold the required token
   *
   * A session read from `sessionStore` is SINGLE-USE: once its signature
   * verifies it is written back as `completed` (or `failed` if the
   * subscription check then refuses), so the same callback cannot verify
   * twice. A `session` passed as an argument is checked the same way but is
   * not written anywhere: the caller that owns it must mark it used.
   *
   * ⚠️ With neither a `sessionStore` nor a `session`, there is no
   * server-issued challenge to bind the callback to: the signature is checked
   * over an empty challenge, which proves only that the wallet signed this
   * `sessionId` within `maxTimestampAge`. Do not treat that as completing a
   * session you created.
   */
  async verifyCallback(
    response: AuthResponse,
    session?: AuthSession
  ): Promise<VerificationResult> {
    return this.verify(response, session, true);
  }

  /**
   * The verification itself. `enforceSession` is the callback contract above;
   * the header middleware runs without it, because a per-request header rides
   * on a login session that has already completed (and outlived its QR TTL),
   * and it keeps the behaviour it always had.
   */
  private async verify(
    response: AuthResponse,
    session: AuthSession | undefined,
    enforceSession: boolean
  ): Promise<VerificationResult> {
    try {
      // Validate required callback fields
      if (!response || !response.sessionId || !response.wallet || !response.signature || !response.publicKey) {
        return {
          success: false,
          error: 'Invalid callback: missing required fields (sessionId, wallet, signature, publicKey)',
        };
      }

      if (typeof response.timestamp !== 'number' || response.timestamp <= 0) {
        return {
          success: false,
          error: 'Invalid callback: timestamp must be a positive number',
        };
      }

      // Verify timestamp is recent
      if (!isTimestampValid(response.timestamp, this.config.maxTimestampAge)) {
        return { success: false, error: 'Timestamp expired or invalid' };
      }

      // Get session if store provided
      let sessionData = session;
      let fromStore = false;
      if (!sessionData && this.config.sessionStore) {
        sessionData = await this.config.sessionStore.get(response.sessionId) || undefined;
        fromStore = true;
      }

      /**
       * 🚨 THE REFUSALS THE README DOCUMENTS (audit R4, AXIS 8). A missed
       * store lookup used to fall through to an EMPTY challenge, so a callback
       * signed over '' for a session that never existed verified; a session
       * past its expiresAt verified; and nothing marked a session used.
       */
      if (enforceSession) {
        if (fromStore && !sessionData) {
          return { success: false, error: 'Session not found' };
        }
        // Audit v1 F78: nothing to bind the callback to. Opt-in refusal.
        if (!sessionData && this.config.requireSession) {
          return { success: false, error: 'Session not found' };
        }
        if (sessionData) {
          if (sessionData.sessionId !== response.sessionId) {
            return { success: false, error: 'Session not found' };
          }
          if (sessionData.status === 'expired' || Date.now() > sessionData.expiresAt) {
            return { success: false, error: 'Session expired' };
          }
          if (sessionData.status === 'completed') {
            return { success: false, error: 'Session already completed' };
          }
          if (sessionData.status === 'rejected' || sessionData.status === 'failed') {
            return { success: false, error: `Session ${sessionData.status}` };
          }
        }
      }

      // Verify signature
      const signatureValid = await this.verifySignature(
        response,
        sessionData?.challenge
      );

      if (!signatureValid) {
        return { success: false, error: 'Invalid signature' };
      }

      /**
       * ONE USE. Written back the moment the signature verifies, before the
       * subscription RPC, so the window in which a replay could read the
       * session as still open is as short as this interface allows (it has no
       * compare-and-set). A replay then reads `completed` and is refused.
       */
      const consumable = enforceSession && fromStore && sessionData ? sessionData : undefined;
      if (consumable) {
        await this.config.sessionStore!.set({
          ...consumable,
          status: 'completed',
          walletAddress: response.wallet,
          signature: response.signature,
        });
      }

      // Verify subscription if required
      if (this.config.subscriptionMint) {
        const subscriptionValid = await this.verifySubscription(
          response.wallet,
          response.subscriptionProof
        );

        if (!subscriptionValid) {
          if (consumable) {
            await this.config.sessionStore!.set({
              ...consumable,
              status: 'failed',
              walletAddress: response.wallet,
              signature: response.signature,
            });
          }
          return { success: false, error: 'Subscription not active' };
        }

        return {
          success: true,
          wallet: response.wallet,
          subscriptionActive: true,
        };
      }

      return {
        success: true,
        wallet: response.wallet,
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Verification failed' };
    }
  }

  /**
   * Verify a signature
   */
  async verifySignature(
    response: AuthResponse,
    challenge?: string
  ): Promise<boolean> {
    try {
      // Reconstruct signed message
      const message = createSignMessage(
        this.config.serviceId,
        response.sessionId,
        challenge || '',
        response.timestamp
      );

      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.decode(response.signature);
      const publicKeyBytes = bs58.decode(response.publicKey);

      // Verify wallet matches public key
      const derivedWallet = new PublicKey(publicKeyBytes).toBase58();
      if (derivedWallet !== response.wallet) {
        return false;
      }

      return nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes
      );
    } catch (error) {
      console.error('[P01Auth] Signature verification error:', error);
      return false;
    }
  }

  /**
   * Verify subscription on-chain
   */
  async verifySubscription(
    wallet: string,
    proof?: SubscriptionProof
  ): Promise<boolean> {
    if (!this.config.subscriptionMint) {
      return true; // No subscription required
    }

    // First check the provided proof
    if (proof) {
      const proofValid = this.validateSubscriptionProof(proof);
      if (!proofValid) {
        return false;
      }
    }

    // Then verify on-chain
    if (this.connection) {
      try {
        const walletPubkey = new PublicKey(wallet);
        const mintPubkey = new PublicKey(this.config.subscriptionMint);

        // Get associated token account
        const [ata] = PublicKey.findProgramAddressSync(
          [
            walletPubkey.toBuffer(),
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
            mintPubkey.toBuffer(),
          ],
          new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
        );

        const accountInfo = await this.connection.getTokenAccountBalance(ata);
        const balance = BigInt(accountInfo.value.amount);

        return balance > 0;
      } catch (error) {
        // Token account doesn't exist or other error
        console.error('[P01Auth] On-chain verification error:', error);
        return false;
      }
    }

    return false;
  }

  /**
   * Validate subscription proof structure
   */
  validateSubscriptionProof(proof: SubscriptionProof): boolean {
    if (!proof.mint || !proof.balance) {
      return false;
    }

    // Check mint matches expected
    if (this.config.subscriptionMint && proof.mint !== this.config.subscriptionMint) {
      return false;
    }

    // Check balance is positive
    const balance = BigInt(proof.balance);
    if (balance <= 0) {
      return false;
    }

    // Check not expired
    if (proof.expiresAt && Date.now() > proof.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Create Express/Fastify middleware
   */
  middleware() {
    return async (req: any, res: any, next: any) => {
      // Check for P01 auth header
      const authHeader = req.headers['x-p01-auth'];
      if (!authHeader) {
        return next();
      }

      try {
        const authData = JSON.parse(
          Buffer.from(authHeader, 'base64').toString()
        );
        const result = await this.verify(authData, undefined, false);

        if (result.success) {
          req.p01Auth = {
            wallet: result.wallet,
            subscriptionActive: result.subscriptionActive,
          };
        }
      } catch (error) {
        // Invalid auth header, continue without auth
      }

      next();
    };
  }

  /**
   * Check if a wallet has active subscription (direct check)
   */
  async checkSubscription(wallet: string): Promise<{
    active: boolean;
    balance?: string;
    expiresAt?: number;
  }> {
    if (!this.config.subscriptionMint || !this.connection) {
      return { active: true };
    }

    try {
      const walletPubkey = new PublicKey(wallet);
      const mintPubkey = new PublicKey(this.config.subscriptionMint);

      const [ata] = PublicKey.findProgramAddressSync(
        [
          walletPubkey.toBuffer(),
          new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
          mintPubkey.toBuffer(),
        ],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      );

      const accountInfo = await this.connection.getTokenAccountBalance(ata);
      const balance = BigInt(accountInfo.value.amount);

      return {
        active: balance > 0,
        balance: accountInfo.value.amount,
      };
    } catch {
      return { active: false };
    }
  }
}

export default P01AuthServer;

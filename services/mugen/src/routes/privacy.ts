/**
 * Privacy API routes — mixer delivery, noise stats, denominations.
 */

import { Hono } from 'hono';
import { PublicKey } from '@solana/web3.js';
import type { NoiseEngine } from '../services/noise-engine.js';
import type { Mixer } from '../services/mixer.js';
import {
  SOL_TIERS_LAMPORTS,
  SOL_LABELS,
  FIAT_CURRENCIES,
  getAvailableTiers,
} from '../services/denominations.js';

const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export function privacyRouter(
  noiseEngine: NoiseEngine | null,
  mixer: Mixer | null,
) {
  const router = new Hono();

  /**
   * GET /api/privacy/denominations?price=200&currency=USD
   *
   * Returns available SOL tiers with dynamic fiat pricing.
   * The fiat amount adapts to SOL price and rounds UP to a clean number.
   * The user always selects a SOL tier — fiat follows.
   */
  router.get('/denominations', (c) => {
    const priceParam = c.req.query('price');
    const pricePerSol = priceParam ? parseFloat(priceParam) : 150; // fallback

    const tiers = getAvailableTiers(pricePerSol);

    return c.json({
      pricePerSol,
      currencies: FIAT_CURRENCIES,
      tiers: tiers.map((t) => ({
        sol: t.sol,
        lamports: String(t.lamports),
        label: t.label,
        fiatCents: t.fiatCents,
        fiatLabel: t.fiatLabel,
      })),
    });
  });

  /**
   * GET /api/privacy/status
   *
   * Returns noise engine and mixer status (no sensitive info).
   */
  router.get('/status', (c) => {
    return c.json({
      noise: noiseEngine?.getStats() ?? { running: false },
      mixer: mixer?.getStats() ?? { pending: 0, completed: 0, failed: 0 },
      denominatedTiers: SOL_LABELS.length,
    });
  });

  /**
   * POST /api/privacy/deliver
   *
   * Request a multi-hop anonymized delivery for a real trade.
   * The response includes the entry wallet — the web app should
   * set this as the escrow buyer's token account.
   *
   * Body: { amount: string (lamports), destination: string (pubkey), tokenMint?: string }
   */
  router.post('/deliver', async (c) => {
    if (!mixer) {
      return c.json({ error: 'Mixer not enabled' }, 503);
    }

    const body = await c.req.json();
    const { amount, destination, tokenMint } = body;

    if (!amount || !destination) {
      return c.json({ error: 'Missing amount or destination' }, 400);
    }

    try {
      const result = mixer.requestDelivery({
        amount: BigInt(amount),
        tokenMint: tokenMint ? new PublicKey(tokenMint) : NATIVE_SOL_MINT,
        destination: new PublicKey(destination),
      });

      return c.json({
        deliveryId: result.deliveryId,
        entryWallet: result.entryWallet.toBase58(),
        estimatedDeliveryAt: result.estimatedDeliveryAt,
        totalHops: result.totalHops,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return router;
}

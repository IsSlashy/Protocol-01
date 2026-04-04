/**
 * Bot API routes — payment reference lookup and bot status.
 */

import { Hono } from 'hono';
import { RevolutClient } from '../services/revolut-client.js';
import { CONFIG } from '../config.js';
import type { OrderIndexer } from '../services/order-indexer.js';

export function botRouter(indexer: OrderIndexer) {
  const router = new Hono();

  /**
   * GET /api/bot/reference/:escrowAddress
   *
   * Returns the payment reference code for an escrow.
   * The buyer sends fiat with this reference to match the payment.
   */
  router.get('/reference/:escrowAddress', (c) => {
    const escrowAddress = c.req.param('escrowAddress');
    const escrow = indexer.getEscrow(escrowAddress);

    if (!escrow) {
      return c.json({ error: 'Escrow not found' }, 404);
    }

    const reference = RevolutClient.escrowToReference(escrowAddress);

    return c.json({
      escrowAddress,
      reference,
      fiatAmount: escrow.fiatAmount,
      status: escrow.status,
      instructions: `Send the exact fiat amount to the seller's Revolut/bank with reference: ${reference}`,
    });
  });

  /**
   * GET /api/bot/status
   *
   * Returns whether the auto-confirm bot is active.
   */
  router.get('/status', (c) => {
    return c.json({
      enabled: CONFIG.botEnabled,
      revolutConnected: !!CONFIG.revolutApiKey,
      sandbox: CONFIG.revolutSandbox,
    });
  });

  return router;
}

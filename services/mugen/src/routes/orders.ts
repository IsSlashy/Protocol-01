import { Hono } from 'hono';
import type { OrderIndexer } from '../services/order-indexer.js';

export function ordersRouter(indexer: OrderIndexer): Hono {
  const app = new Hono();

  /** GET /api/orders — List orders with optional filters. */
  app.get('/', (c) => {
    const status = c.req.query('status');
    const tokenMint = c.req.query('token_mint');
    const orderType = c.req.query('order_type');
    const fiatCurrency = c.req.query('fiat_currency');

    const orders = indexer.getOrders({
      status: status || undefined,
      tokenMint: tokenMint || undefined,
      orderType: orderType || undefined,
      fiatCurrency: fiatCurrency || undefined,
    });

    return c.json({ orders, count: orders.length });
  });

  /** GET /api/orders/:address — Get a specific order. */
  app.get('/:address', (c) => {
    const address = c.req.param('address');
    const order = indexer.getOrder(address);

    if (!order) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const escrows = indexer.getEscrowsForOrder(address);
    return c.json({ order, escrows });
  });

  /** GET /api/orders/stats — Exchange statistics. */
  app.get('/stats/summary', (c) => {
    return c.json(indexer.getStats());
  });

  return app;
}

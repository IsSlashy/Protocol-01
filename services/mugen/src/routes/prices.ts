import { Hono } from 'hono';
import type { PriceFeed } from '../services/price-feed.js';

export function pricesRouter(priceFeed: PriceFeed): Hono {
  const app = new Hono();

  /** GET /api/prices — All prices. */
  app.get('/', (c) => {
    return c.json({ prices: priceFeed.getAllPrices() });
  });

  /** GET /api/prices/:symbol — Price for a specific token. */
  app.get('/:symbol', (c) => {
    const symbol = c.req.param('symbol').toUpperCase();
    const price = priceFeed.getPrice(symbol);

    if (!price) {
      return c.json({ error: `No price data for ${symbol}` }, 404);
    }

    return c.json(price);
  });

  return app;
}

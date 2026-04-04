/**
 * Mugen Exchange — Fee & Spread Configuration
 *
 * Strategy: Low visible fees + hidden spread in exchange rate.
 * Total take rate varies by payment method (1.3% - 2.9%).
 * User sees only the "fee" line — spread is baked into the rate.
 *
 * Revenue split: P01 20% / Mugen 65% / Treasury 15%
 */

// ─── Spread (hidden in exchange rate) ───────────────────────────────────────

/** Spread applied to the market price. User sees a slightly worse rate. */
export const SPREAD_BPS: Record<string, number> = {
  card: 100,      // 1.0% spread on card
  iban: 80,       // 0.8% spread on bank transfer
  revolut: 80,    // 0.8% spread
  wise: 80,       // 0.8% spread
  sepa: 80,       // 0.8% spread
  cash: 120,      // 1.2% spread (higher risk)
};

// ─── Visible fee (shown to user) ────────────────────────────────────────────

/** Fee displayed to user (separate from spread). */
export const VISIBLE_FEE_BPS: Record<string, number> = {
  card: 190,      // 1.9% visible fee
  iban: 50,       // 0.5% visible fee
  revolut: 50,    // 0.5% visible fee
  wise: 50,       // 0.5% visible fee
  sepa: 50,       // 0.5% visible fee
  cash: 50,       // 0.5% visible fee
};

// ─── Total effective take rate ──────────────────────────────────────────────
// card:     1.9% fee + 1.0% spread = 2.9% total
// iban:     0.5% fee + 0.8% spread = 1.3% total
// revolut:  0.5% fee + 0.8% spread = 1.3% total
// wise:     0.5% fee + 0.8% spread = 1.3% total
// sepa:     0.5% fee + 0.8% spread = 1.3% total
// cash:     0.5% fee + 1.2% spread = 1.7% total

// ─── On-chain protocol fee (from escrow release) ───────────────────────────

/** Total on-chain fee deducted at escrow release (visible fee portion). */
export const ONCHAIN_FEE_BPS = 150; // 1.5% average — split 3 ways

/** Revenue split from on-chain fees. */
export const FEE_SPLIT = {
  p01: 2000,      // 20% → P01 Protocol (app, extension, infra)
  mugen: 6500,    // 65% → Mugen Exchange (exchange ops)
  treasury: 1500, // 15% → Treasury (DAO, governance)
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Apply spread to market price.
 * Returns the price the user pays (slightly higher than market).
 */
export function applySpread(marketPrice: number, method: string): number {
  const spreadBps = SPREAD_BPS[method] || 80;
  return marketPrice * (1 + spreadBps / 10000);
}

/**
 * Calculate visible fee amount.
 */
export function calculateVisibleFee(fiatAmount: number, method: string): number {
  const feeBps = VISIBLE_FEE_BPS[method] || 50;
  return fiatAmount * feeBps / 10000;
}

/**
 * Calculate crypto amount user receives after spread.
 */
export function calculateCryptoAmount(
  fiatAmount: number,
  marketPrice: number,
  method: string,
): { cryptoAmount: number; effectiveRate: number; visibleFee: number; spreadAmount: number } {
  const effectiveRate = applySpread(marketPrice, method);
  const visibleFee = calculateVisibleFee(fiatAmount, method);
  const netFiat = fiatAmount - visibleFee;
  const cryptoAmount = netFiat / effectiveRate;
  const spreadAmount = (fiatAmount / marketPrice) - (fiatAmount / effectiveRate);

  return {
    cryptoAmount,
    effectiveRate,
    visibleFee,
    spreadAmount: spreadAmount * marketPrice, // in fiat terms
  };
}

/**
 * Format fee display for UI.
 */
export function formatFeeDisplay(method: string): string {
  const feeBps = VISIBLE_FEE_BPS[method] || 50;
  return `${(feeBps / 100).toFixed(1)}%`;
}

/**
 * Competitor comparison data.
 */
export const COMPETITOR_FEES: Record<string, { name: string; cardFee: string; bankFee: string }> = {
  moonpay: { name: 'MoonPay', cardFee: '4.5%', bankFee: '1.0%' },
  ramp: { name: 'Ramp', cardFee: '2.9%', bankFee: '1.5%' },
  transak: { name: 'Transak', cardFee: '5.0%', bankFee: '1.5%' },
  coinbase: { name: 'Coinbase', cardFee: '3.99%', bankFee: '1.49%' },
};

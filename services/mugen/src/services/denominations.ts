/**
 * Mugen Denominated Amounts — SOL-first, fiat-adaptive pricing.
 *
 * CORE PRINCIPLE: The SOL denomination is the constant (0.1, 1, 10 SOL)
 * because it maps directly to the shielded pool tiers on the mobile app.
 * The fiat amount ADAPTS to the current SOL price and is always rounded
 * UP to the nearest "nice" number so the bank sees clean amounts.
 *
 * The noise bot uses the exact same rounding at the exact same price,
 * so all fiat transfers (real + noise) are indistinguishable.
 *
 * Example at SOL = $200:
 *   0.1 SOL → $20 fiat (rounded from $20.00)
 *   1 SOL   → $200 fiat
 *   10 SOL  → $2,000 fiat
 *
 * Example at SOL = $450:
 *   0.1 SOL → $50 fiat (rounded UP from $45.00)
 *   1 SOL   → $500 fiat (rounded UP from $450)
 *   10 SOL  → $5,000 fiat (rounded UP from $4,500)
 *
 * The user always gets the full SOL denomination (minus 0.5% fee).
 * The slight fiat overpayment from rounding means more SOL per dollar.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SOL DENOMINATIONS — THE FIXED ANCHOR (maps to shielded pool)
// ═══════════════════════════════════════════════════════════════════════════════

/** SOL denominations: 0.1 / 1 / 10 SOL (maps to mobile app pool tiers) */
export const SOL_TIERS_LAMPORTS = [
  100_000_000n,       // 0.1 SOL
  1_000_000_000n,     // 1 SOL
  10_000_000_000n,    // 10 SOL
] as const;

export const SOL_TIERS_DISPLAY = [0.1, 1, 10] as const;
export const SOL_LABELS = ['0.1 SOL', '1 SOL', '10 SOL'] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// FIAT ROUNDING LADDER — "Nice" numbers the bank won't question
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sorted ladder of acceptable fiat amounts (in cents).
 * When computing fiat for a SOL tier, we round UP to the nearest
 * value in this ladder. This ensures:
 *   1. Bank sees clean round numbers (not $47.23)
 *   2. Noise bot uses same ladder → same amounts
 *   3. User always gets at least the SOL denomination they picked
 */
const FIAT_LADDER_CENTS = [
  500,        // $5
  1_000,      // $10
  1_500,      // $15
  2_000,      // $20
  2_500,      // $25
  3_000,      // $30
  4_000,      // $40
  5_000,      // $50
  7_500,      // $75
  10_000,     // $100
  15_000,     // $150
  20_000,     // $200
  25_000,     // $250
  30_000,     // $300
  40_000,     // $400
  50_000,     // $500
  75_000,     // $750
  100_000,    // $1,000
  150_000,    // $1,500
  200_000,    // $2,000
  250_000,    // $2,500
  300_000,    // $3,000
  400_000,    // $4,000
  500_000,    // $5,000
  750_000,    // $7,500
  1_000_000,  // $10,000
];

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORTED CURRENCIES
// ═══════════════════════════════════════════════════════════════════════════════

export const FIAT_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT METHOD BITMASKS
// ═══════════════════════════════════════════════════════════════════════════════

export const PAYMENT_METHODS = {
  BANK: 1,
  REVOLUT: 2,
  WISE: 4,
  CASH: 8,
  SEPA: 16,
  ZELLE: 32,
} as const;

export const ALL_ELECTRONIC = PAYMENT_METHODS.BANK | PAYMENT_METHODS.REVOLUT | PAYMENT_METHODS.WISE | PAYMENT_METHODS.SEPA | PAYMENT_METHODS.ZELLE;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTION: SOL tier → rounded fiat price
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Round UP a raw fiat amount (cents) to the nearest "nice" ladder step.
 *
 * Examples:
 *   roundUpFiat(1523)  → 2000  ($15.23 → $20)
 *   roundUpFiat(4500)  → 5000  ($45.00 → $50)
 *   roundUpFiat(18700) → 20000 ($187 → $200)
 *   roundUpFiat(45000) → 50000 ($450 → $500)
 */
export function roundUpFiat(rawCents: number): number {
  for (const step of FIAT_LADDER_CENTS) {
    if (step >= rawCents) return step;
  }
  // Above ladder: round up to nearest $1000
  return Math.ceil(rawCents / 100_000) * 100_000;
}

/**
 * Compute the fiat price (in cents) for a SOL denomination at current price.
 * Always rounds UP to the nearest clean fiat amount.
 *
 * @param solLamports SOL tier in lamports (e.g. 100_000_000n = 0.1 SOL)
 * @param pricePerSol Current price of 1 SOL in fiat (e.g. 200.0)
 * @param spreadBps Price spread in basis points (e.g. 200 = 2% markup)
 * @returns Rounded fiat amount in cents
 */
export function solTierToFiatCents(
  solLamports: bigint,
  pricePerSol: number,
  spreadBps: number = 0,
): number {
  const solAmount = Number(solLamports) / 1e9;
  const rawPrice = solAmount * pricePerSol * (1 + spreadBps / 10_000);
  const rawCents = Math.ceil(rawPrice * 100);
  return roundUpFiat(rawCents);
}

/**
 * Get all available SOL tiers with their current fiat prices.
 * This is what the UI displays to the user.
 *
 * @param pricePerSol Current SOL price in the user's currency
 * @param spreadBps Spread (default 200 = 2%)
 * @returns Array of { sol, lamports, fiat, fiatLabel }
 */
export function getAvailableTiers(pricePerSol: number, spreadBps: number = 200) {
  return SOL_TIERS_LAMPORTS.map((lamports, i) => {
    const fiatCents = solTierToFiatCents(lamports, pricePerSol, spreadBps);
    return {
      sol: SOL_TIERS_DISPLAY[i],
      lamports,
      label: SOL_LABELS[i],
      fiatCents,
      fiatLabel: formatFiat(fiatCents),
    };
  });
}

/** Format cents to display string: 2000 → "$20", 150000 → "$1,500" */
function formatFiat(cents: number): string {
  const dollars = cents / 100;
  return '$' + dollars.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOISE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pick a random SOL denomination (in lamports).
 * @param maxTierIndex Limit to tiers 0..maxTierIndex (default: 0 = only 0.1 SOL).
 */
export function pickRandomSolTier(maxTierIndex = 0): bigint {
  const allWeights = [70, 25, 5];
  const weights = allWeights.slice(0, maxTierIndex + 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return SOL_TIERS_LAMPORTS[i];
  }
  return SOL_TIERS_LAMPORTS[0];
}

/** Pick a random fiat currency. */
export function pickRandomCurrency(): FiatCurrency {
  return FIAT_CURRENCIES[Math.floor(Math.random() * FIAT_CURRENCIES.length)];
}

/** Pick a random payment method bitmask (1-3 methods combined). */
export function pickRandomPaymentMethods(): number {
  const methods = Object.values(PAYMENT_METHODS);
  const count = 1 + Math.floor(Math.random() * 3);
  let bitmask = 0;
  const shuffled = [...methods].sort(() => Math.random() - 0.5);
  for (let i = 0; i < count; i++) {
    bitmask |= shuffled[i];
  }
  return bitmask;
}

/**
 * Convert SOL lamports to fiat cents with spread + rounding.
 * Used by both noise engine and real trades → same output = indistinguishable.
 */
export function lamportsToFiatCents(lamports: bigint, pricePerSol: number, spreadBps: number): number {
  return solTierToFiatCents(lamports, pricePerSol, spreadBps);
}

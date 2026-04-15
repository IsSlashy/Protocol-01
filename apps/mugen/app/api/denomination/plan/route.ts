import { NextResponse } from 'next/server';
import {
  splitAmount,
  POOL_SUPPORTED_DENOMINATIONS_SOL,
  type SplitInput,
} from '@protocol-01/privacy-sdk';
import { getSolPriceInFiat } from '@/lib/prices';

/**
 * POST /api/denomination/plan
 *
 * Layer 1 of the 12-layer privacy stack — "Natural Variance Fiat".
 * Takes an arbitrary fiat amount and returns a greedy split into the
 * canonical SOL denominations used by the privacy pools (default:
 * pool-supported only — 0.1, 1, 10, 100 SOL). Any amount that can't
 * fit the ladder is returned as a tracked fiat residual.
 *
 * Always dynamic — price snapshot must be fresh per request.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_FIAT_AMOUNT = 1_000_000;

interface PlanRequestBody {
  fiatAmount?: unknown;
  fiatCurrency?: unknown;
  usePoolSupportedOnly?: unknown;
}

export async function POST(request: Request) {
  let body: PlanRequestBody;
  try {
    body = (await request.json()) as PlanRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  // --- Validate fiatAmount -------------------------------------------------
  if (body.fiatAmount === undefined || body.fiatAmount === null) {
    return NextResponse.json(
      { error: 'fiatAmount is required' },
      { status: 400 },
    );
  }

  const fiatAmount = body.fiatAmount;
  if (
    typeof fiatAmount !== 'number' ||
    !Number.isFinite(fiatAmount) ||
    fiatAmount <= 0
  ) {
    return NextResponse.json(
      { error: 'fiatAmount must be a positive number' },
      { status: 400 },
    );
  }

  if (fiatAmount > MAX_FIAT_AMOUNT) {
    return NextResponse.json(
      { error: 'fiatAmount exceeds maximum (1M)' },
      { status: 400 },
    );
  }

  // --- Validate fiatCurrency ----------------------------------------------
  if (body.fiatCurrency !== 'EUR' && body.fiatCurrency !== 'USD') {
    return NextResponse.json(
      { error: 'fiatCurrency must be EUR or USD' },
      { status: 400 },
    );
  }
  const fiatCurrency: 'EUR' | 'USD' = body.fiatCurrency;

  const usePoolSupportedOnly =
    typeof body.usePoolSupportedOnly === 'boolean'
      ? body.usePoolSupportedOnly
      : true;

  // --- Fetch price --------------------------------------------------------
  let solPriceInFiat: number;
  try {
    solPriceInFiat = await getSolPriceInFiat(fiatCurrency);
  } catch {
    return NextResponse.json(
      { error: 'Unable to fetch SOL price' },
      { status: 503 },
    );
  }

  if (!Number.isFinite(solPriceInFiat) || solPriceInFiat <= 0) {
    return NextResponse.json(
      { error: 'Unable to fetch SOL price' },
      { status: 503 },
    );
  }

  // --- Split --------------------------------------------------------------
  const splitInput: SplitInput = {
    fiatAmount,
    fiatCurrency,
    solPriceInFiat,
    ...(usePoolSupportedOnly
      ? { denominations: POOL_SUPPORTED_DENOMINATIONS_SOL }
      : {}),
  };

  let result;
  try {
    result = splitAmount(splitInput);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Split failed' },
      { status: 400 },
    );
  }

  const residualPercent =
    Math.round((result.residualFiat / fiatAmount) * 10000) / 100;

  const maxDenomination = result.splits.reduce(
    (max, s) => (s.denomination > max ? s.denomination : max),
    0,
  );

  return NextResponse.json(
    {
      splits: result.splits,
      canonicalSolTotal: result.canonicalSolTotal,
      residualFiat: result.residualFiat,
      residualPercent,
      privacyWarning: result.privacyWarning,
      solPriceInFiat,
      fiatCurrency,
      timestamp: Date.now(),
      maxDenomination,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=10, s-maxage=10',
      },
    },
  );
}

/**
 * The deployment's HTTP side of the note-in exchange, as the web client calls it
 * (apps/web/lib/privacy/shieldClient.ts: fetchExchangeTerms, fetchIssuableNote,
 * requestFunding, claimForPayment, requestIssuedNote; the challenge text from
 * apps/web/lib/privacy/claimChallenge.ts). Same routes, same bodies, same
 * headers, so the phone and the browser are two clients of one mechanism.
 *
 * Base URL: EXPO_PUBLIC_P01_API_BASE (the production deployment by default).
 * Ticket: EXPO_PUBLIC_P01_FUNDER_TICKET — the PUBLIC ticket the web bundle
 * ships (NEXT_PUBLIC_P01_FUNDER_TICKET); it authorises a request, never value.
 */
export const P01_API_BASE = (process.env.EXPO_PUBLIC_P01_API_BASE ?? 'https://protocol-01.dev').replace(/\/$/, '');

export function funderTicket(): string | null {
  const t = process.env.EXPO_PUBLIC_P01_FUNDER_TICKET ?? '';
  return t ? t : null;
}

/** Pinned verbatim by the web's claim-for-payment.test.ts; the wire format, not a template. */
export function claimChallenge(signature: string): string {
  return `Protocol 01 - collect the note I paid for.\nPayment: ${signature}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ExchangeTerms {
  configured: boolean;
  till: string | null;
  priceLamports: number;
  reasons: string[];
}

/** Where an exchange pays. */
export async function fetchExchangeTerms(): Promise<ExchangeTerms> {
  const res = await fetch(`${P01_API_BASE}/api/claim-for-payment`, { method: 'GET' });
  const body = await readJson(res);
  if (!res.ok || body.ok !== true) {
    throw new Error(`The deployment could not say where an exchange pays (${res.status}).`);
  }
  return {
    configured: body.configured === true,
    till: typeof body.till === 'string' ? body.till : null,
    priceLamports: Number(body.priceLamports ?? 0),
    reasons: Array.isArray(body.reasons) ? body.reasons.map(String) : [],
  };
}

/** What the deployment stocks, checked BEFORE anything is spent. */
export async function fetchIssuableNote(): Promise<{ denomination: number; token: 'SOL' | 'USDC' } | null> {
  try {
    const res = await fetch(`${P01_API_BASE}/api/issue-note`, { method: 'GET' });
    const body = await readJson(res);
    if (!res.ok || body.ok !== true || body.configured !== true || !body.denomination) return null;
    return { denomination: Number(body.denomination), token: body.token === 'USDC' ? 'USDC' : 'SOL' };
  } catch {
    return null;
  }
}

/**
 * Ask the deployment's funder to arm an ephemeral. The wallet never signs and
 * never appears next to the transaction that pays the till — the join the
 * exchange exists to remove (the web calls this `neverExposeWallet`).
 */
export async function requestFunding(
  ephemeralPubkey: string,
  lamports: number,
): Promise<{ signature: string; sweepTo: string; lamports: number }> {
  const ticket = funderTicket();
  if (!ticket) throw new Error('This app has no funder ticket for the deployment; the exchange cannot arm its signer.');
  const res = await fetch(`${P01_API_BASE}/api/fund-ephemeral`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    body: JSON.stringify({ ephemeralPubkey, lamports }),
  });
  const body = await readJson(res);
  if (!res.ok || body.ok !== true || typeof body.signature !== 'string' || typeof body.sweepTo !== 'string') {
    throw new Error(
      typeof body.error === 'string'
        ? `The deployment's funder refused: ${body.error}`
        : `/api/fund-ephemeral answered ${res.status}`,
    );
  }
  return { signature: body.signature, sweepTo: body.sweepTo, lamports: Number(body.lamports ?? lamports) };
}

export interface ClaimOutcome {
  claimCode: string;
  kind: 'transfer' | 'pool-withdrawal';
  received: number;
}

/** The withdrawal is the payment; the proof is the ephemeral's signature over the challenge. */
export async function claimForPayment(params: {
  signature: string;
  proof: string;
  onProgress?: (step: string) => void;
  attempts?: number;
  delayMs?: number;
}): Promise<ClaimOutcome> {
  const attempts = params.attempts ?? 10;
  const delayMs = params.delayMs ?? 3000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await fetch(`${P01_API_BASE}/api/claim-for-payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: params.signature, proof: params.proof }),
    });
    const body = await readJson(res);
    if (res.status === 404) {
      params.onProgress?.('The deployment has not seen the payment yet; waiting for its node...');
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!res.ok || body.ok !== true || typeof body.claimCode !== 'string' || !body.claimCode) {
      throw new Error(
        typeof body.error === 'string'
          ? `The deployment refused the claim: ${body.error}`
          : `/api/claim-for-payment answered ${res.status}`,
      );
    }
    return {
      claimCode: body.claimCode,
      kind: body.kind === 'pool-withdrawal' ? 'pool-withdrawal' : 'transfer',
      received: Number(body.received ?? 0),
    };
  }
  throw new Error(
    `The deployment could not find payment ${params.signature} after ${attempts} attempts. ` +
      'It is confirmed on our node; retry in a minute. The payment is recorded on this phone and is not lost.',
  );
}

/** Redeem a claim for a note the deployment deposited, sealed to `recipientAddress`. */
export async function requestIssuedNote(params: {
  recipientAddress: string;
  token: 'SOL' | 'USDC';
  denomination: number;
  claimCode: string;
}): Promise<{ sealedNote: string; leafIndex: number | null; disclosure: string }> {
  const ticket = funderTicket();
  if (!ticket) throw new Error('This deployment does not issue notes.');
  const res = await fetch(`${P01_API_BASE}/api/issue-note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    body: JSON.stringify(params),
  });
  const body = await readJson(res);
  if (!res.ok || body.ok !== true || typeof body.sealedNote !== 'string') {
    throw new Error(
      typeof body.error === 'string' ? `No note was issued: ${body.error}` : `The issuer replied ${res.status}.`,
    );
  }
  return {
    sealedNote: body.sealedNote,
    leafIndex: typeof body.leafIndex === 'number' ? body.leafIndex : null,
    disclosure:
      typeof body.disclosure === 'string'
        ? body.disclosure
        : 'This note was deposited by this deployment. It does not hide you from the deployment.',
  };
}

/** The funder's address (where a residue goes back), from GET /api/fund-ephemeral. */
export async function fetchFunderAddress(): Promise<string | null> {
  try {
    const res = await fetch(`${P01_API_BASE}/api/fund-ephemeral`, { method: 'GET' });
    const body = await readJson(res);
    return res.ok && body.ok === true && typeof body.funder === 'string' ? body.funder : null;
  } catch {
    return null;
  }
}

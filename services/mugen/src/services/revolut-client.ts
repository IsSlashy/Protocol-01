/**
 * Revolut Business API client for payment detection.
 *
 * Polls incoming transactions and matches them by reference code
 * to link fiat payments to on-chain escrows.
 *
 * Docs: https://developer.revolut.com/docs/business/transactions
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RevolutTransaction {
  id: string;
  type: string;
  state: 'completed' | 'pending' | 'declined' | 'reverted';
  reference?: string;
  legs: Array<{
    amount: number;
    currency: string;
    description?: string;
    account_id?: string;
  }>;
  created_at: string;
  completed_at?: string;
}

interface TransactionsResponse {
  transactions?: RevolutTransaction[];
  // Sandbox returns array directly, production may wrap
}

export interface PaymentMatch {
  transactionId: string;
  amount: number;
  currency: string;
  reference: string;
  completedAt: string;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class RevolutClient {
  private baseUrl: string;
  private apiKey: string;
  private processedTxIds: Set<string> = new Set();

  constructor(opts: { apiKey: string; sandbox?: boolean }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.sandbox
      ? 'https://sandbox-b2b.revolut.com/api/1.0'
      : 'https://b2b.revolut.com/api/1.0';
  }

  /**
   * Fetch recent incoming transactions and match by reference prefix "MG-".
   * Returns only completed, unprocessed payments.
   */
  async fetchMatchingPayments(): Promise<PaymentMatch[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `${this.baseUrl}/transactions?from=${since}&type=transfer`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[revolut] API error ${res.status}: ${text}`);
      return [];
    }

    const data = await res.json();

    // Revolut returns an array directly
    const txs: RevolutTransaction[] = Array.isArray(data) ? data : (data.transactions ?? []);

    const matches: PaymentMatch[] = [];

    for (const tx of txs) {
      // Skip non-completed or already processed
      if (tx.state !== 'completed') continue;
      if (this.processedTxIds.has(tx.id)) continue;

      // Match reference pattern: MG-XXXXXXXX
      const ref = tx.reference?.trim();
      if (!ref || !ref.startsWith('MG-')) continue;

      // Find the incoming leg (positive amount)
      const incomingLeg = tx.legs.find((l) => l.amount > 0);
      if (!incomingLeg) continue;

      matches.push({
        transactionId: tx.id,
        amount: Math.round(incomingLeg.amount * 100), // Convert to cents
        currency: incomingLeg.currency.toUpperCase(),
        reference: ref,
        completedAt: tx.completed_at ?? tx.created_at,
      });
    }

    return matches;
  }

  /**
   * Mark a transaction as processed so it won't be matched again.
   */
  markProcessed(transactionId: string): void {
    this.processedTxIds.add(transactionId);
  }

  /**
   * Generate the reference code for an escrow address.
   * Format: MG-{first 8 chars of base58 escrow address}
   */
  static escrowToReference(escrowAddress: string): string {
    return `MG-${escrowAddress.slice(0, 8)}`;
  }

  /**
   * Extract the escrow address prefix from a reference code.
   */
  static referenceToPrefix(reference: string): string {
    return reference.replace('MG-', '');
  }
}

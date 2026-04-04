import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';

// ─── On-chain account sizes (from p01_mugen state) ──────────────────────────

const ORDER_ACCOUNT_SIZE = 200; // MugenOrder discriminator + fields
const ESCROW_ACCOUNT_SIZE = 312; // MugenEscrow discriminator + fields

// ─── Status enums (match on-chain) ──────────────────────────────────────────

const ORDER_STATUS: Record<number, string> = {
  0: 'open',
  1: 'in_escrow',
  2: 'completed',
  3: 'cancelled',
  4: 'disputed',
  5: 'expired',
};

const ESCROW_STATUS: Record<number, string> = {
  0: 'awaiting_payment',
  1: 'payment_confirmed',
  2: 'released',
  3: 'disputed',
  4: 'refunded',
  5: 'expired',
};

// ─── Parsed types ───────────────────────────────────────────────────────────

export interface IndexedOrder {
  address: string;
  maker: string;
  orderType: 'buy_crypto' | 'sell_crypto';
  tokenMint: string;
  cryptoAmount: string;
  fiatAmount: string;
  fiatCurrency: string;
  paymentMethods: number;
  minAmount: string;
  maxAmount: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}

export interface IndexedEscrow {
  address: string;
  order: string;
  maker: string;
  taker: string;
  tokenMint: string;
  cryptoAmount: string;
  fiatAmount: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}

// ─── Indexer ────────────────────────────────────────────────────────────────

export class OrderIndexer {
  private connection: Connection;
  private orders: Map<string, IndexedOrder> = new Map();
  private escrows: Map<string, IndexedEscrow> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
  }

  async start(): Promise<void> {
    console.log(`[indexer] Starting order indexer — polling every ${CONFIG.indexerPollMs}ms`);
    await this.poll();
    this.intervalId = setInterval(() => this.poll(), CONFIG.indexerPollMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getOrders(filter?: {
    status?: string;
    tokenMint?: string;
    orderType?: string;
    fiatCurrency?: string;
  }): IndexedOrder[] {
    let results = Array.from(this.orders.values());

    if (filter?.status) results = results.filter((o) => o.status === filter.status);
    if (filter?.tokenMint) results = results.filter((o) => o.tokenMint === filter.tokenMint);
    if (filter?.orderType) results = results.filter((o) => o.orderType === filter.orderType);
    if (filter?.fiatCurrency) results = results.filter((o) => o.fiatCurrency === filter.fiatCurrency);

    // Sort by newest first
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  getOrder(address: string): IndexedOrder | undefined {
    return this.orders.get(address);
  }

  getEscrow(address: string): IndexedEscrow | undefined {
    return this.escrows.get(address);
  }

  getEscrowsForOrder(orderAddress: string): IndexedEscrow[] {
    return Array.from(this.escrows.values()).filter((e) => e.order === orderAddress);
  }

  getStats(): { totalOrders: number; openOrders: number; activeEscrows: number } {
    const orders = Array.from(this.orders.values());
    return {
      totalOrders: orders.length,
      openOrders: orders.filter((o) => o.status === 'open').length,
      activeEscrows: Array.from(this.escrows.values()).filter(
        (e) => e.status === 'awaiting_payment' || e.status === 'payment_confirmed',
      ).length,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      await Promise.all([this.indexOrders(), this.indexEscrows()]);
    } catch (err) {
      console.error('[indexer] Poll error:', (err as Error).message);
    }
  }

  private async indexOrders(): Promise<void> {
    const accounts = await this.connection.getProgramAccounts(CONFIG.programId, {
      filters: [{ dataSize: ORDER_ACCOUNT_SIZE }],
    });

    for (const { pubkey, account } of accounts) {
      const parsed = this.parseOrder(pubkey.toBase58(), account.data);
      if (parsed) this.orders.set(parsed.address, parsed);
    }
  }

  private async indexEscrows(): Promise<void> {
    const accounts = await this.connection.getProgramAccounts(CONFIG.programId, {
      filters: [{ dataSize: ESCROW_ACCOUNT_SIZE }],
    });

    for (const { pubkey, account } of accounts) {
      const parsed = this.parseEscrow(pubkey.toBase58(), account.data);
      if (parsed) this.escrows.set(parsed.address, parsed);
    }
  }

  private parseOrder(address: string, data: Buffer): IndexedOrder | null {
    try {
      let offset = 8; // skip discriminator

      const maker = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
      const orderTypeU8 = data.readUInt8(offset);
      offset += 1;
      const tokenMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
      const cryptoAmount = data.readBigUInt64LE(offset).toString();
      offset += 8;
      const fiatAmount = data.readBigUInt64LE(offset).toString();
      offset += 8;
      const fiatCurrency = data
        .subarray(offset, offset + 3)
        .toString('ascii')
        .replace(/\0/g, '');
      offset += 3;
      const paymentMethods = data.readUInt16LE(offset);
      offset += 2;
      const minAmount = data.readBigUInt64LE(offset).toString();
      offset += 8;
      const maxAmount = data.readBigUInt64LE(offset).toString();
      offset += 8;
      offset += 32; // compliance_attestation
      offset += 32; // reputation_commitment
      offset += 16; // nonce
      const status = data.readUInt8(offset);
      offset += 1;
      const createdAt = Number(data.readBigInt64LE(offset));
      offset += 8;
      const expiresAt = Number(data.readBigInt64LE(offset));

      return {
        address,
        maker,
        orderType: orderTypeU8 === 0 ? 'buy_crypto' : 'sell_crypto',
        tokenMint,
        cryptoAmount,
        fiatAmount,
        fiatCurrency,
        paymentMethods,
        minAmount,
        maxAmount,
        status: ORDER_STATUS[status] ?? 'unknown',
        createdAt,
        expiresAt,
      };
    } catch {
      return null;
    }
  }

  private parseEscrow(address: string, data: Buffer): IndexedEscrow | null {
    try {
      let offset = 8;

      const order = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
      const maker = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
      const taker = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
      const tokenMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
      const cryptoAmount = data.readBigUInt64LE(offset).toString();
      offset += 8;
      const fiatAmount = data.readBigUInt64LE(offset).toString();
      offset += 8;
      offset += 32; // escrow_vault
      offset += 32; // maker_attestation
      offset += 32; // taker_attestation
      offset += 32; // stealth_recipient
      offset += 2; // payment_method
      const status = data.readUInt8(offset);
      offset += 1;
      const createdAt = Number(data.readBigInt64LE(offset));
      offset += 8;
      const expiresAt = Number(data.readBigInt64LE(offset));

      return {
        address,
        order,
        maker,
        taker,
        tokenMint,
        cryptoAmount,
        fiatAmount,
        status: ESCROW_STATUS[status] ?? 'unknown',
        createdAt,
        expiresAt,
      };
    } catch {
      return null;
    }
  }
}

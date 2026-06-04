// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  parseServiceRegistryAccount,
  findServiceByRetailer,
  SERVICE_REGISTRY_DISCRIMINATOR,
  type OnchainServiceEntry,
} from './onchainServiceRegistry';

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function i64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
function str(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

const OWNER = Buffer.alloc(32, 1);
const RETAILER = Buffer.alloc(32, 2);
const MINT = Buffer.alloc(32, 0); // native SOL (System Program, all-zero)

function buildAccount(strings = ['netflix-premium', 'Netflix Premium', 'netflix', 'streaming', '']): Buffer {
  return Buffer.concat([
    SERVICE_REGISTRY_DISCRIMINATOR,
    OWNER,
    RETAILER,
    MINT,
    u64(100_000_000), // price 0.1 SOL
    u64(216_000), // interval slots
    u64(5), // subscriber count
    Buffer.from([1, 1, 1, 1]), // oneshot, vault, verified, active
    Buffer.from([254]), // bump
    i64(1_700_000_000),
    i64(1_700_000_100),
    ...strings.map(str),
  ]);
}

describe('onchainServiceRegistry decoder', () => {
  it('decodes a full account (variable-length string tail)', () => {
    const e = parseServiceRegistryAccount(buildAccount(), 'AcctAddr111');
    expect(e.owner).toBe(new PublicKey(OWNER).toBase58());
    expect(e.retailer).toBe(new PublicKey(RETAILER).toBase58());
    expect(e.tokenMint).toBe('11111111111111111111111111111111'); // native SOL
    expect(e.priceAtomic).toBe(100_000_000);
    expect(e.intervalSlots).toBe(216_000);
    expect(e.subscriberCount).toBe(5);
    expect(e.supportsOneshot).toBe(true);
    expect(e.supportsVault).toBe(true);
    expect(e.verified).toBe(true);
    expect(e.active).toBe(true);
    expect(e.bump).toBe(254);
    expect(e.createdAt).toBe(1_700_000_000);
    expect(e.updatedAt).toBe(1_700_000_100);
    expect(e.slug).toBe('netflix-premium');
    expect(e.name).toBe('Netflix Premium');
    expect(e.iconKey).toBe('netflix');
    expect(e.category).toBe('streaming');
    expect(e.metadataUri).toBe('');
  });

  it('handles the minimum-size account (all 5 strings empty)', () => {
    const e = parseServiceRegistryAccount(buildAccount(['', '', '', '', '']), 'AcctAddr222');
    expect(e.slug).toBe('');
    expect(e.metadataUri).toBe('');
  });

  it('rejects a wrong discriminator', () => {
    const buf = buildAccount();
    buf[0] ^= 0xff;
    expect(() => parseServiceRegistryAccount(buf, 'x')).toThrow(/discriminator/i);
  });

  it('rejects a too-short account', () => {
    expect(() => parseServiceRegistryAccount(Buffer.alloc(40), 'x')).toThrow(/too short/i);
  });

  it('findServiceByRetailer requires matching tokenMint and prefers verified', () => {
    const mk = (retailer: string, tokenMint: string, verified: boolean, name: string): OnchainServiceEntry =>
      ({ retailer, tokenMint, verified, name } as OnchainServiceEntry);
    const services = [
      mk('R1', 'MINT_SOL', false, 'Imposter'),
      mk('R1', 'MINT_SOL', true, 'Netflix'),
      mk('R1', 'MINT_USDC', true, 'Other plan'),
    ];
    expect(findServiceByRetailer(services, 'R1', 'MINT_SOL')?.name).toBe('Netflix'); // verified preferred
    expect(findServiceByRetailer(services, 'R1', 'MINT_USDC')?.name).toBe('Other plan'); // tokenMint disambiguates
    expect(findServiceByRetailer(services, 'R2', 'MINT_SOL')).toBeUndefined();
  });
});

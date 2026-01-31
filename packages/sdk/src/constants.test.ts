import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  STREAM_PROGRAM_ID_DEVNET,
  STREAM_PROGRAM_ID_MAINNET,
  NATIVE_SOL_MINT,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  RPC_ENDPOINTS,
  INTERVALS,
  P01_TIERS,
  STREAM_SEED,
  ESCROW_SEED,
} from './constants';

// ============================================================
// Program IDs
// ============================================================
describe('Program IDs', () => {
  it('STREAM_PROGRAM_ID_DEVNET should be a valid PublicKey', () => {
    expect(STREAM_PROGRAM_ID_DEVNET).toBeInstanceOf(PublicKey);
    expect(STREAM_PROGRAM_ID_DEVNET.toBase58()).toBeTruthy();
  });

  it('STREAM_PROGRAM_ID_MAINNET should be a valid PublicKey', () => {
    expect(STREAM_PROGRAM_ID_MAINNET).toBeInstanceOf(PublicKey);
    expect(STREAM_PROGRAM_ID_MAINNET.toBase58()).toBeTruthy();
  });

  it('devnet and mainnet program IDs should differ', () => {
    expect(STREAM_PROGRAM_ID_DEVNET.equals(STREAM_PROGRAM_ID_MAINNET)).toBe(false);
  });
});

// ============================================================
// Mint addresses
// ============================================================
describe('Mint addresses', () => {
  it('NATIVE_SOL_MINT should be the well-known wrapped SOL address', () => {
    expect(NATIVE_SOL_MINT.toBase58()).toBe('So11111111111111111111111111111111111111112');
  });

  it('USDC_MINT_DEVNET should be a valid PublicKey', () => {
    expect(USDC_MINT_DEVNET).toBeInstanceOf(PublicKey);
    expect(USDC_MINT_DEVNET.toBase58().length).toBeGreaterThan(0);
  });

  it('USDC_MINT_MAINNET should be the well-known mainnet USDC address', () => {
    expect(USDC_MINT_MAINNET.toBase58()).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('devnet and mainnet USDC should differ', () => {
    expect(USDC_MINT_DEVNET.equals(USDC_MINT_MAINNET)).toBe(false);
  });
});

// ============================================================
// RPC Endpoints
// ============================================================
describe('RPC_ENDPOINTS', () => {
  it('should define devnet, mainnet-beta, and testnet endpoints', () => {
    expect(RPC_ENDPOINTS.devnet).toBeDefined();
    expect(RPC_ENDPOINTS['mainnet-beta']).toBeDefined();
    expect(RPC_ENDPOINTS.testnet).toBeDefined();
  });

  it('all endpoints should be valid HTTPS URLs', () => {
    for (const [key, url] of Object.entries(RPC_ENDPOINTS)) {
      expect(url, `RPC_ENDPOINTS.${key}`).toMatch(/^https:\/\//);
    }
  });

  it('devnet URL should contain "devnet"', () => {
    expect(RPC_ENDPOINTS.devnet).toContain('devnet');
  });

  it('mainnet URL should contain "mainnet"', () => {
    expect(RPC_ENDPOINTS['mainnet-beta']).toContain('mainnet');
  });

  it('testnet URL should contain "testnet"', () => {
    expect(RPC_ENDPOINTS.testnet).toContain('testnet');
  });
});

// ============================================================
// INTERVALS
// ============================================================
describe('INTERVALS', () => {
  it('HOURLY should be 3600 seconds', () => {
    expect(INTERVALS.HOURLY).toBe(3600);
  });

  it('DAILY should be 86400 seconds', () => {
    expect(INTERVALS.DAILY).toBe(86400);
  });

  it('WEEKLY should be 604800 seconds', () => {
    expect(INTERVALS.WEEKLY).toBe(604800);
  });

  it('MONTHLY should be 2592000 seconds (30 days)', () => {
    expect(INTERVALS.MONTHLY).toBe(2592000);
  });

  it('YEARLY should be 31536000 seconds (365 days)', () => {
    expect(INTERVALS.YEARLY).toBe(31536000);
  });

  it('should increase: HOURLY < DAILY < WEEKLY < MONTHLY < YEARLY', () => {
    expect(INTERVALS.HOURLY).toBeLessThan(INTERVALS.DAILY);
    expect(INTERVALS.DAILY).toBeLessThan(INTERVALS.WEEKLY);
    expect(INTERVALS.WEEKLY).toBeLessThan(INTERVALS.MONTHLY);
    expect(INTERVALS.MONTHLY).toBeLessThan(INTERVALS.YEARLY);
  });
});

// ============================================================
// P01_TIERS
// ============================================================
describe('P01_TIERS', () => {
  it('should define basic, pro, and enterprise tiers', () => {
    expect(P01_TIERS.basic).toBeDefined();
    expect(P01_TIERS.pro).toBeDefined();
    expect(P01_TIERS.enterprise).toBeDefined();
  });

  it('each tier should have name, pricePerInterval, intervalSeconds, totalIntervals, features', () => {
    for (const [tierKey, tier] of Object.entries(P01_TIERS)) {
      expect(tier.name, `${tierKey}.name`).toBeTruthy();
      expect(typeof tier.pricePerInterval, `${tierKey}.pricePerInterval`).toBe('number');
      expect(tier.pricePerInterval, `${tierKey}.pricePerInterval`).toBeGreaterThan(0);
      expect(tier.intervalSeconds, `${tierKey}.intervalSeconds`).toBe(INTERVALS.MONTHLY);
      expect(tier.totalIntervals, `${tierKey}.totalIntervals`).toBe(12);
      expect(Array.isArray(tier.features), `${tierKey}.features`).toBe(true);
      expect(tier.features.length, `${tierKey}.features.length`).toBeGreaterThan(0);
    }
  });

  it('pro should have more features than basic', () => {
    expect(P01_TIERS.pro.features.length).toBeGreaterThan(P01_TIERS.basic.features.length);
  });

  it('enterprise should have more features than pro', () => {
    expect(P01_TIERS.enterprise.features.length).toBeGreaterThan(P01_TIERS.pro.features.length);
  });
});

// ============================================================
// Seeds
// ============================================================
describe('Seeds', () => {
  it('STREAM_SEED should be "stream"', () => {
    expect(STREAM_SEED).toBe('stream');
  });

  it('ESCROW_SEED should be "escrow"', () => {
    expect(ESCROW_SEED).toBe('escrow');
  });
});

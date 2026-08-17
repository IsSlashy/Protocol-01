/**
 * The identity that buys a subscription instead of the wallet.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS IDENTITY EXISTS
 * ────────────────────────
 * A pool identity is 32 bytes. The connected wallet was only ever needed for two
 * jobs — make those bytes recoverable with nothing stored, and sign the pre-fund
 * — and the funder does the second one now. So the buyer of a subscription does
 * not have to be the wallet, and should not be: the wallet is precisely the
 * thing an observer is trying to reach.
 *
 * The alternative shipped before this was "open a second Phantom in a second
 * browser profile", which is a runbook, not a product.
 *
 * TWO PROPERTIES, AND BOTH ARE EASY TO LOSE
 * ─────────────────────────────────────────
 *  1. UNRELATED to the wallet's own identity. Signing the wallet's usual
 *     derivation message would produce the SAME seeds — an ephemeral buyer that
 *     is the wallet under a label.
 *  2. RE-DERIVABLE. A random identity cannot be rebuilt, and the license key of
 *     every subscription made under it comes from a note secret that lives only
 *     there. A cleared browser would destroy the proof of a subscription that is
 *     still being paid for.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearPoolState,
  handlePoolRequest,
  setPoolSeed,
} from '../worker/poolHandlers';
import { buildAnonymousBuyerMessage } from '../shieldClient';
import { buildDerivationMessage } from '../message';

const WALLET = '7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh';
const ORIGIN = 'http://localhost:3000';
/** Stands in for a wallet signature over the anonymous-buyer message. */
const BUYER_SIG = Array.from(new Uint8Array(64).fill(21));

beforeEach(() => {
  clearPoolState();
});

describe('the message that unlocks a buyer identity', () => {
  it('is NOT the wallet’s own derivation message', () => {
    // The whole design in one assertion. Same message means same signature
    // means same seeds: an "ephemeral buyer" that is the wallet wearing a
    // label, holding the wallet's notes, at the wallet's addresses.
    const anon = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: ORIGIN, index: 0 });
    const own = buildDerivationMessage({ walletPubkey: WALLET, origin: ORIGIN, chainTag: 'solana' });
    expect(anon).not.toBe(own);
  });

  it('is deterministic, so the identity can be rebuilt from the wallet', () => {
    // Not random. A buyer identity that cannot be re-derived takes the license
    // key of every subscription made under it down with the browser.
    const a = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: ORIGIN, index: 0 });
    const b = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: ORIGIN, index: 0 });
    expect(a).toBe(b);
  });

  it('gives a different identity per index, so one wallet can hold several', () => {
    const a = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: ORIGIN, index: 0 });
    const b = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: ORIGIN, index: 1 });
    expect(a).not.toBe(b);
  });

  it('is origin-bound, like every other signature this app asks for', () => {
    // A signature obtained on another site would otherwise unlock the same
    // identity — and this one holds notes.
    const here = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: ORIGIN, index: 0 });
    const there = buildAnonymousBuyerMessage({ walletPubkey: WALLET, origin: 'https://evil.example', index: 0 });
    expect(here).not.toBe(there);
  });
});

describe('registering it in the worker', () => {
  it('returns a receive address and keeps the seeds inside', async () => {
    const res = await handlePoolRequest({
      kind: 'poolDeriveIdentity',
      meta: 'anon:test',
      signature: BUYER_SIG,
    });
    expect(res.address).toMatch(/^p01pq:/);
    // The response carries public key material and nothing else. A seed leaving
    // here would defeat the boundary every other handler holds.
    expect(JSON.stringify(res)).not.toContain('seed');
  });

  it('coexists with the wallet’s own identity rather than replacing it', async () => {
    // `poolSeeds` is keyed by meta, so both live at once — which is what lets
    // one browser hold the wallet's notes AND buy anonymously in the same
    // session. If registering the buyer evicted the wallet, the note lists and
    // the recovery path would empty themselves mid-purchase.
    setPoolSeed('wallet-meta', new Uint8Array(64).fill(9));
    await handlePoolRequest({ kind: 'poolDeriveIdentity', meta: 'anon:test', signature: BUYER_SIG });
    const walletAddr = await handlePoolRequest({ kind: 'poolNoteAddress', meta: 'wallet-meta' });
    expect(walletAddr.address).toMatch(/^p01pq:/);
  });

  it('gives the buyer a DIFFERENT address from the wallet', async () => {
    // The negative control: an implementation that ignored the signature would
    // pass every case above and hand both identities the same address, which is
    // the exact failure — a buyer that is the wallet.
    setPoolSeed('wallet-meta', new Uint8Array(64).fill(9));
    const wallet = await handlePoolRequest({ kind: 'poolNoteAddress', meta: 'wallet-meta' });
    const buyer = await handlePoolRequest({
      kind: 'poolDeriveIdentity',
      meta: 'anon:test',
      signature: BUYER_SIG,
    });
    expect(buyer.address).not.toBe(wallet.address);
  });

  it('rebuilds the SAME identity from the same signature', async () => {
    const first = await handlePoolRequest({
      kind: 'poolDeriveIdentity',
      meta: 'anon:test',
      signature: BUYER_SIG,
    });
    clearPoolState();
    const again = await handlePoolRequest({
      kind: 'poolDeriveIdentity',
      meta: 'anon:test',
      signature: BUYER_SIG,
    });
    expect(again.address).toBe(first.address);
  });

  it('refuses a signature too short to be one', async () => {
    await expect(
      handlePoolRequest({ kind: 'poolDeriveIdentity', meta: 'anon:test', signature: [1, 2, 3] }),
    ).rejects.toThrow(/at least 32 bytes/);
  });
});

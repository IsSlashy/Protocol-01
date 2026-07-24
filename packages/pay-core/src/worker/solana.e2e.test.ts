/**
 * Solana FULL-FLOW e2e against PUBLIC DEVNET — spends real devnet SOL.
 *
 * Drives the exact code the browser worker runs (workerCore, in-process):
 *   deriveMeta → resolveRecipient (pasted-meta path) → buildSend → sign +
 *   submit honoring the funds-last contract → scan → claim to the owner wallet.
 *
 * Legs:
 *   1. Native SOL: 0.02 SOL to a stealth address, claimed back to the payer.
 *   2. "USDC": a throwaway 6-decimal SPL mint (payer = authority) configured
 *      as the worker's usdcMint; 25.000000 units sent + claimed back.
 *
 * Requires the funded local devnet keypair (~/.config/solana/id.json).
 * Everything claimable is swept back to the payer. Unrecoverable residue per
 * run: announcement PDA rent (2 x ~0.0094 SOL), the throwaway mint + ATA
 * rents, and the SPL claim-fund cushion left at the token stealth address
 * (~0.0025 SOL) — well under the 0.35 SOL budget asserted below.
 *
 * Gate: SOLANA_E2E=1 pnpm vitest run solana.e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { configureWorkerCore, handleWorkerRequest, clearWorkerSessions } from './workerCore';
import type { DerivedIdentity, StealthPayment } from '../types';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR ?? join(homedir(), '.config', 'solana', 'id.json');

const SOL_SEND_LAMPORTS = 20_000_000n; // 0.02 SOL
const USDC_MINT_AMOUNT = 1_000_000_000n; // 1000.000000 (6 decimals)
const USDC_SEND_BASE_UNITS = 25_000_000n; // 25.000000
const MAX_SPEND_LAMPORTS = 350_000_000n; // hard budget: 0.35 SOL

const gate = process.env.SOLANA_E2E === '1' ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten an error's message chain (SpecterError keeps the RPC error in .cause). */
function errMsg(err: unknown): string {
  const parts: string[] = [];
  let e = err as { message?: unknown; cause?: unknown } | undefined;
  let depth = 0;
  while (e && depth < 5) {
    parts.push(String(e.message ?? e));
    e = e.cause as typeof e;
    depth += 1;
  }
  return parts.join(' <- ');
}

/** Errors worth retrying against the rate-limited public devnet RPC. */
function isTransient(msg: string): boolean {
  return /429|Too Many Requests|rate.?limit|fetch failed|Failed to fetch|ECONNRESET|ETIMEDOUT|socket hang up|network error|Blockhash not found|502|503|Service Unavailable/i.test(
    msg,
  );
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = errMsg(err);
      if (!isTransient(msg) || i === attempts - 1) throw err;
      console.log(`[retry] ${label} attempt ${i + 1} failed (${msg.slice(0, 120)}), backing off`);
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/** Minimal base58 for the locally-computed tx signature (no bs58 dep here). */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) + BigInt(b);
  let out = '';
  while (x > 0n) {
    out = B58_ALPHABET[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

gate('Solana PQ stealth — full flow on public devnet (workerCore in-process)', () => {
  let connection: Connection;
  let payer: Keypair;
  let payerAddress: string;
  let usdcMint: PublicKey;
  let payerAta: PublicKey;
  let identity: DerivedIdentity;
  let balanceBefore = 0n;

  /**
   * Sign every returned tx with the payer and submit IN ORDER, confirming each
   * against the buildSend blockhash before the next — the same contract the
   * wallet runtime implements. Any throw before the last tx aborts the loop,
   * so the funds tx is never submitted after a failed announcement/chunk.
   */
  async function signSubmitInOrder(
    transactionsB64: string[],
    sendCtx: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<string[]> {
    const sigs: string[] = [];
    for (let i = 0; i < transactionsB64.length; i++) {
      const isFunds = i === transactionsB64.length - 1;
      const tx = Transaction.from(Buffer.from(transactionsB64[i]!, 'base64'));
      tx.sign(payer);
      const sig = b58(tx.signature!);
      const raw = tx.serialize();
      await withRetry(`tx ${i + 1}/${transactionsB64.length}${isFunds ? ' (funds)' : ''}`, async () => {
        try {
          await connection.sendRawTransaction(raw);
        } catch (err) {
          // A retried send whose first attempt landed fails preflight with
          // "already been processed" — that IS success; go confirm it.
          if (!/already been processed/i.test(errMsg(err))) throw err;
        }
        const conf = await connection.confirmTransaction(
          { signature: sig, ...sendCtx },
          'confirmed',
        );
        if (conf.value.err) {
          throw new Error(`tx ${i + 1} (${sig}) failed on-chain: ${JSON.stringify(conf.value.err)}`);
        }
      });
      console.log(`[submit] tx ${i + 1}/${transactionsB64.length}${isFunds ? ' (funds)' : ''}: ${sig}`);
      sigs.push(sig);
    }
    return sigs;
  }

  /** Poll scan (devnet RPC lags/ratelimits) until the payment shows up. */
  async function scanUntilFound(stealthAddress: string, timeoutMs = 90_000): Promise<StealthPayment> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await handleWorkerRequest({ kind: 'scan', meta: identity.meta });
        const payment = res.payments.find((p) => p.stealthAddress === stealthAddress);
        if (payment) return payment;
      } catch (err) {
        console.log(`[scan] transient failure: ${errMsg(err).slice(0, 160)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`scan never surfaced the payment at ${stealthAddress}`);
      }
      await sleep(5000);
    }
  }

  /**
   * Claim with retry. claimStealth confirms internally; if a confirm times out
   * after the tx actually landed, a retry reports "No balance available" — in
   * that case verify the earlier signature (parsed from the timeout message)
   * on-chain and accept it.
   */
  async function claimBack(paymentId: string): Promise<string> {
    const timeoutSigs: string[] = [];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await handleWorkerRequest({
          kind: 'claim',
          meta: identity.meta,
          paymentId,
          destination: payerAddress,
        });
        return res.tx.signature;
      } catch (err) {
        lastErr = err;
        const msg = errMsg(err);
        const sigMatch = msg.match(/signature ([1-9A-HJ-NP-Za-km-z]{80,90})/);
        if (sigMatch) timeoutSigs.push(sigMatch[1]!);
        if (/No balance available/i.test(msg) && timeoutSigs.length > 0) {
          for (const sig of timeoutSigs) {
            const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
            const s = st.value[0];
            if (s && !s.err) {
              console.log(`[claim] earlier timed-out claim ${sig} actually landed`);
              return sig;
            }
          }
        }
        if (!isTransient(msg) && !/Failed to claim|was not confirmed/i.test(msg)) throw err;
        console.log(`[claim] attempt ${attempt + 1} failed (${msg.slice(0, 160)}), retrying`);
        await sleep(3000 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  beforeAll(async () => {
    payer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf-8')) as number[]),
    );
    payerAddress = payer.publicKey.toBase58();
    connection = new Connection(RPC_URL, 'confirmed');

    balanceBefore = BigInt(await withRetry('initial balance', () => connection.getBalance(payer.publicKey)));
    console.log(`[setup] payer ${payerAddress} balance ${Number(balanceBefore) / 1e9} SOL`);
    expect(balanceBefore).toBeGreaterThan(500_000_000n); // need headroom before spending

    // Throwaway 6-decimal SPL mint standing in for USDC (payer = authority).
    usdcMint = await withRetry('createMint', () =>
      createMint(connection, payer, payer.publicKey, null, 6),
    );
    const ata = await withRetry('create payer ATA', () =>
      getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, payer.publicKey),
    );
    payerAta = ata.address;
    await withRetry('mintTo', () =>
      mintTo(connection, payer, usdcMint, payerAta, payer, USDC_MINT_AMOUNT),
    );
    console.log(`[setup] throwaway USDC mint ${usdcMint.toBase58()}, payer ATA ${payerAta.toBase58()}`);

    configureWorkerCore({ rpcUrl: RPC_URL, usdcMint: usdcMint.toBase58() });

    // Fresh recipient identity per run (a reused meta would rediscover residue
    // from earlier runs against the shared devnet program).
    const fakeSig = crypto.getRandomValues(new Uint8Array(64));
    const derived = await handleWorkerRequest({
      kind: 'deriveMeta',
      signature: fakeSig,
      ownerWallet: payerAddress,
    });
    identity = derived.identity;
    expect(identity.meta.startsWith('st')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (connection && payer) {
      const balanceAfter = BigInt(
        await withRetry('final balance', () => connection.getBalance(payer.publicKey)),
      );
      const spent = balanceBefore - balanceAfter;
      console.log(
        `[budget] total lamports spent: ${spent} (${Number(spent) / 1e9} SOL) — budget ${Number(MAX_SPEND_LAMPORTS) / 1e9} SOL`,
      );
      expect(spent).toBeLessThanOrEqual(MAX_SPEND_LAMPORTS);
    }
    clearWorkerSessions();
  }, 60_000);

  it('SOL leg: derive → resolve → send 0.02 → scan → claim back', async () => {
    // Paste path: the meta string itself resolves without touching the registry.
    const resolved = await handleWorkerRequest({ kind: 'resolveRecipient', input: identity.meta });
    expect(resolved.recipient.meta).toBe(identity.meta);
    expect(resolved.recipient.version).toBe(2);

    const built = await withRetry('buildSend SOL', () =>
      handleWorkerRequest({
        kind: 'buildSend',
        senderPubkey: payerAddress,
        recipientMeta: resolved.recipient.meta,
        assetSymbol: 'SOL',
        amountLamports: SOL_SEND_LAMPORTS.toString(),
      }),
    );
    // init + 2 KEM chunks (1088 / 544) + funds transfer
    expect(built.transactionsB64.length).toBe(4);
    console.log(`[SOL] stealth address ${built.stealthAddress}`);

    const sigs = await signSubmitInOrder(built.transactionsB64, {
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
    console.log(`[SOL] send sigs: ${sigs.join(', ')}`);

    const payment = await scanUntilFound(built.stealthAddress);
    expect(payment.assetSymbol).toBe('SOL');
    expect(payment.amount).toBeCloseTo(0.02, 9);
    expect(payment.claimed).toBe(false);

    const balBeforeClaim = BigInt(
      await withRetry('balance pre-claim', () => connection.getBalance(payer.publicKey)),
    );
    const claimSig = await claimBack(payment.id);
    console.log(`[SOL] claim sig: ${claimSig}`);

    const status = await withRetry('claim status', () =>
      connection.getSignatureStatuses([claimSig], { searchTransactionHistory: true }),
    );
    expect(status.value[0]?.err ?? null).toBeNull();
    expect(status.value[0]?.confirmationStatus).toMatch(/confirmed|finalized/);

    // The whole stealth balance minus the 5000-lamport claim fee came back.
    const balAfterClaim = BigInt(
      await withRetry('balance post-claim', () => connection.getBalance(payer.publicKey)),
    );
    expect(balAfterClaim - balBeforeClaim).toBe(SOL_SEND_LAMPORTS - 5000n);
  }, 240_000);

  it('USDC leg: send 25 units of the throwaway mint → scan → claim back', async () => {
    const built = await withRetry('buildSend USDC', () =>
      handleWorkerRequest({
        kind: 'buildSend',
        senderPubkey: payerAddress,
        recipientMeta: identity.meta,
        assetSymbol: 'USDC',
        amountLamports: USDC_SEND_BASE_UNITS.toString(),
      }),
    );
    expect(built.transactionsB64.length).toBe(4);
    console.log(`[USDC] stealth address ${built.stealthAddress}`);

    const sigs = await signSubmitInOrder(built.transactionsB64, {
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
    console.log(`[USDC] send sigs: ${sigs.join(', ')}`);

    const ataAfterSend = await withRetry('ATA post-send', () =>
      connection.getTokenAccountBalance(payerAta),
    );
    expect(BigInt(ataAfterSend.value.amount)).toBe(USDC_MINT_AMOUNT - USDC_SEND_BASE_UNITS);

    const payment = await scanUntilFound(built.stealthAddress);
    expect(payment.assetSymbol).toBe('USDC');
    expect(payment.amount).toBeCloseTo(25, 6);
    expect(payment.claimed).toBe(false);

    const claimSig = await claimBack(payment.id);
    console.log(`[USDC] claim sig: ${claimSig}`);

    const status = await withRetry('claim status', () =>
      connection.getSignatureStatuses([claimSig], { searchTransactionHistory: true }),
    );
    expect(status.value[0]?.err ?? null).toBeNull();
    expect(status.value[0]?.confirmationStatus).toMatch(/confirmed|finalized/);

    // Destination ATA (the payer's) regained exactly the 25.000000 base units.
    const ataAfterClaim = await withRetry('ATA post-claim', () =>
      connection.getTokenAccountBalance(payerAta),
    );
    expect(BigInt(ataAfterClaim.value.amount) - BigInt(ataAfterSend.value.amount)).toBe(
      USDC_SEND_BASE_UNITS,
    );
  }, 240_000);
});

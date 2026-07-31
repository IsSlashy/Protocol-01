/**
 * Example merchant backend for "Netflix Standard".
 *
 * This single-file script stands in for what a real merchant would deploy
 * (Next.js route, Cloudflare Worker, plain Express, etc.) — it shows every
 * piece a merchant needs to ship a Protocol 01 integration:
 *
 *   1. On boot: register the service in the on-chain registry (idempotent).
 *   2. Poll the retailer wallet every 30 s for new one-shot payments.
 *   3. Poll the `SubscriptionVault` accounts owned by the retailer to find
 *      recurring subscribers.
 *   4. For every confirmed payment, issue a short-lived access token the
 *      subscriber can present on later requests.
 *
 * Usage:
 *   cd examples/merchant-netflix
 *   ANCHOR_WALLET=~/.config/solana/id.json pnpm start
 *
 * The script keeps running; Ctrl-C to stop. A production merchant would
 * persist the "last processed signature" and subscriber→token map; here
 * we keep them in memory for brevity.
 */

import { Connection, Keypair, SystemProgram } from '@solana/web3.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  issueAccessToken,
  listVaultsForRetailer,
  pollPaymentsForRetailer,
  registerServiceOnChain,
  subscriptionIsCurrent,
  periodsPaidFor,
  type MerchantRegistrationResult,
} from '@protocol-01/merchant-sdk';

// ---------------------------------------------------------------------------
// Config — swap these for your real values.
// ---------------------------------------------------------------------------

// Set RPC_URL in your environment to a Helius or Alchemy devnet/mainnet endpoint.
// Never hardcode API keys in source files — use environment variables.
//
// Example (.env):
//   RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
const RPC_URL =
  process.env.RPC_URL ??
  'https://api.devnet.solana.com';

/** Path to the merchant's signing keypair. Controls service registration. */
const MERCHANT_KEYPAIR_PATH =
  process.env.MERCHANT_KEYPAIR ??
  process.env.ANCHOR_WALLET ??
  path.join(os.homedir(), '.config', 'solana', 'id.json');

/** Path to the retailer keypair (only needed to see its balance; signing
 *  the actual withdraw is a separate concern). The seed script stored these
 *  at `scripts/seed-services/keypairs/<slug>-retailer.json`. */
const RETAILER_KEYPAIR_PATH =
  process.env.RETAILER_KEYPAIR ??
  path.join(
    process.cwd(),
    '..', '..',
    'scripts', 'seed-services', 'keypairs',
    'netflix-standard-retailer.json',
  );

const SERVICE_SLUG = 'netflix-standard';
const SERVICE_NAME = 'Netflix Standard';
const PRICE_LAMPORTS = 50_000_000n; // 0.05 SOL
const INTERVAL_SLOTS = 6_480_000n; // ≈ 30 days
const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// State (in-memory only for the demo).
// ---------------------------------------------------------------------------

interface AccessRecord {
  subscriberId: string;
  mode: 'oneshot' | 'vault';
  token: string;
  grantedAt: number;
  expiresAt: number;
}

const accessGrants = new Map<string, AccessRecord>();
let lastProcessedSig: string | undefined = undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function logStep(label: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${label}`);
}

// ---------------------------------------------------------------------------
// Boot: register (idempotent)
// ---------------------------------------------------------------------------

async function ensureRegistered(
  connection: Connection,
  merchant: Keypair,
  retailer: Keypair,
): Promise<MerchantRegistrationResult> {
  logStep(`registering service '${SERVICE_SLUG}' …`);
  const result = await registerServiceOnChain(connection, merchant, {
    slug: SERVICE_SLUG,
    name: SERVICE_NAME,
    iconKey: 'netflix',
    category: 'streaming',
    metadataUri: 'https://demo.protocol01.app/services/netflix.json',
    retailer: retailer.publicKey,
    tokenMint: SystemProgram.programId,
    priceAtomic: PRICE_LAMPORTS,
    intervalSlots: INTERVAL_SLOTS,
    supportsOneshot: true,
    supportsVault: true,
    skipIfExists: true,
  });
  if (result.alreadyExisted) {
    logStep(`  already registered at ${result.pda.toBase58()}`);
  } else {
    logStep(`  registered → sig=${result.signature?.slice(0, 16)}… pda=${result.pda.toBase58()}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Poll loop: one-shot payments + vaults.
// ---------------------------------------------------------------------------

async function pollOnce(
  connection: Connection,
  merchant: Keypair,
  retailer: Keypair,
): Promise<void> {
  // 1. One-shot memo-tagged payments to the retailer.
  try {
    const receipts = await pollPaymentsForRetailer(connection, retailer.publicKey, {
      since: lastProcessedSig,
      slugFilter: SERVICE_SLUG,
      limit: 25,
    });

    for (const r of receipts) {
      const subscriberId = `oneshot:${r.signature.slice(0, 12)}`;
      if (accessGrants.has(subscriberId)) continue;

      const token = issueAccessToken({
        merchantKeypair: merchant,
        subscriberId,
        serviceSlug: SERVICE_SLUG,
        ttlSeconds: 60 * 60 * 24 * 31, // 31 days covers a standard month
        extraClaims: { mode: 'oneshot', sig: r.signature },
      });

      accessGrants.set(subscriberId, {
        subscriberId,
        mode: 'oneshot',
        token,
        grantedAt: Date.now(),
        expiresAt: Date.now() + 31 * 86_400_000,
      });
      logStep(
        `  ✓ one-shot payment detected: ${r.sol} SOL sig=${r.signature.slice(0, 12)}…; ` +
          `access token issued for ${subscriberId}`,
      );
    }

    if (receipts.length > 0) {
      lastProcessedSig = receipts[receipts.length - 1]!.signature;
    }
  } catch (err) {
    logStep(`  ! poll payments failed: ${(err as Error).message}`);
  }

  // 2. Vault subscribers.
  //
  // This is a DISCOVERY sweep — it runs on a timer and its job is to notice
  // subscribers the merchant has not seen before, so hydrating the whole book is
  // the point and `listVaultsForRetailer` is the right tool. A per-REQUEST
  // entitlement check must not look like this: use
  // `hasActiveVaultAccessForVault` (or `verifyLicenseAgainstVault`), which reads
  // the one vault the request is about.
  try {
    const slot = BigInt(await connection.getSlot('confirmed'));
    const vaults = await listVaultsForRetailer(connection, retailer.publicKey, {
      includePaused: false,
    });
    for (const v of vaults) {
      const idBytes = v.subscriberCommitment ?? v.subscriberPubkey?.toBytes();
      if (!idBytes) continue;
      const subscriberId = `vault:${Buffer.from(idBytes).toString('hex').slice(0, 16)}`;
      if (accessGrants.has(subscriberId)) continue;

      // Do NOT grant on `is_active`. The program writes it `true` at subscribe
      // time and `false` nowhere, so a vault that has spent everything it
      // deposited still reports `true` for ever — on devnet 2026-08-01, 14 of
      // the 18 live vaults had run out and every one of them said `true`.
      if (!subscriptionIsCurrent(v, slot)) {
        logStep(
          `  – vault ${v.pda.toBase58().slice(0, 12)}… skipped: ran past the ` +
            `${periodsPaidFor(v)} period(s) it was funded for (is_active is still true)`,
        );
        continue;
      }

      const token = issueAccessToken({
        merchantKeypair: merchant,
        subscriberId,
        serviceSlug: SERVICE_SLUG,
        ttlSeconds: 60 * 60 * 24 * 35, // cover one period + buffer
        extraClaims: {
          mode: 'vault',
          vault: v.pda.toBase58(),
          rate: v.rate.toString(),
          intervalSlots: v.intervalSlots.toString(),
        },
      });
      accessGrants.set(subscriberId, {
        subscriberId,
        mode: 'vault',
        token,
        grantedAt: Date.now(),
        expiresAt: Date.now() + 35 * 86_400_000,
      });
      logStep(
        `  ✓ vault subscription detected: ${v.pda.toBase58().slice(0, 12)}…; ` +
          `access token issued for ${subscriberId}`,
      );
    }
  } catch (err) {
    logStep(`  ! poll vaults failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!fs.existsSync(MERCHANT_KEYPAIR_PATH)) {
    throw new Error(`merchant keypair not found at ${MERCHANT_KEYPAIR_PATH}`);
  }
  if (!fs.existsSync(RETAILER_KEYPAIR_PATH)) {
    throw new Error(
      `retailer keypair not found at ${RETAILER_KEYPAIR_PATH}\n` +
        `run scripts/seed-services/seed-demo-services.ts first, or set RETAILER_KEYPAIR`,
    );
  }

  const merchant = loadKeypair(MERCHANT_KEYPAIR_PATH);
  const retailer = loadKeypair(RETAILER_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log('══════════════════════════════════════════════════════════════');
  console.log('Merchant demo — Netflix Standard');
  console.log(`  merchant signer : ${merchant.publicKey.toBase58()}`);
  console.log(`  retailer wallet : ${retailer.publicKey.toBase58()}`);
  console.log(`  slug            : ${SERVICE_SLUG}`);
  console.log(`  price           : ${Number(PRICE_LAMPORTS) / 1e9} SOL / period`);
  console.log(`  interval        : ${INTERVAL_SLOTS} slots (~30 d)`);
  console.log('══════════════════════════════════════════════════════════════\n');

  await ensureRegistered(connection, merchant, retailer);

  logStep(`entering poll loop — Ctrl-C to exit`);
  await pollOnce(connection, merchant, retailer); // immediate first pass

  const interval = setInterval(() => {
    pollOnce(connection, merchant, retailer).catch((err) => {
      logStep(`  ! poll error: ${(err as Error).message}`);
    });
  }, POLL_INTERVAL_MS);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\n─ summary ─');
    console.log(`  grants: ${accessGrants.size}`);
    for (const g of accessGrants.values()) {
      console.log(
        `  ${g.subscriberId.padEnd(24)} mode=${g.mode} token=${g.token.slice(0, 24)}…`,
      );
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('merchant demo failed:', err);
  process.exit(1);
});

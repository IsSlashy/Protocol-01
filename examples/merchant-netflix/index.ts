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
 *   5. Sweep the revenue: claim every accrued period from every vault, and
 *      release the rent of exhausted ones by closing them.
 *
 * ONE THING TO NOTICE about step 5: this script never holds the retailer's
 * secret key. The claim is PERMISSIONLESS — since the 2026-08-04 redeploy the
 * program pins the payout DESTINATION (`retailer.key() == vault.retailer`),
 * not the sender — so the merchant signer here acts as a third-party payer and
 * the money still lands only on the retailer address. The retailer can be a
 * cold wallet, a multisig, or a key that no longer exists; the payments land
 * regardless. That is the shape to copy.
 *
 * Usage:
 *   cd examples/merchant-netflix
 *   RETAILER_ADDRESS=<retailer pubkey> \
 *   ANCHOR_WALLET=~/.config/solana/id.json pnpm start
 *
 * `RETAILER_ADDRESS` is the payout address your service registered. If unset,
 * the script falls back to reading the ADDRESS out of the seed script's
 * keypair file (`scripts/seed-services/keypairs/netflix-standard-retailer.json`)
 * — only the public key is kept; the secret is never used.
 *
 * The script keeps running; Ctrl-C to stop. A production merchant would
 * persist the "last processed signature" and subscriber→token map; here
 * we keep them in memory for brevity.
 */

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimPeriod,
  claimableAmount,
  fundedPeriodsRemaining,
  issueAccessToken,
  listVaultsForRetailer,
  pollPaymentsForRetailer,
  registerServiceOnChain,
  subscriptionIsCurrent,
  periodsPaidFor,
  vaultMatchesService,
  type ServiceScope,
  type MerchantRegistrationResult,
  type SubscriptionVaultAccount,
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

/**
 * The retailer is an ADDRESS, not a keypair. Nothing in this script — not
 * registration, not entitlement checks, not claiming — needs the retailer's
 * secret: registration signs as the merchant and merely NAMES the payout
 * address, and `claim_period` is permissionless (the program pins where the
 * money goes, not who sends the transaction). Prefer `RETAILER_ADDRESS`; the
 * keypair-file fallback below exists only because the seed script happens to
 * store the address inside one, and only the public key is extracted from it.
 */
const RETAILER_ADDRESS = process.env.RETAILER_ADDRESS;
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
  retailer: PublicKey,
): Promise<MerchantRegistrationResult> {
  logStep(`registering service '${SERVICE_SLUG}' …`);
  const result = await registerServiceOnChain(connection, merchant, {
    slug: SERVICE_SLUG,
    name: SERVICE_NAME,
    iconKey: 'netflix',
    category: 'streaming',
    metadataUri: 'https://demo.protocol01.app/services/netflix.json',
    retailer,
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
  retailer: PublicKey,
): Promise<void> {
  // 1. One-shot memo-tagged payments to the retailer.
  try {
    const receipts = await pollPaymentsForRetailer(connection, retailer, {
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
    // Exactly what this service registered on chain, and the only thing that
    // distinguishes a subscription we sold from an account anyone can create.
    const serviceScope: ServiceScope = {
      retailer,
      tokenMint: SystemProgram.programId, // native SOL, as the program records it
      priceAtomic: PRICE_LAMPORTS,
      intervalSlots: INTERVAL_SLOTS,
    };
    const vaults = await listVaultsForRetailer(connection, retailer, {
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

      // A vault naming us proves the program wrote it, NOT that we sold it.
      // `subscribe_private_stark` takes an unsigned retailer and a caller-chosen
      // rate and interval, so a stranger can create a real, "current" vault
      // pointing at this merchant at one atomic unit per period. Check it
      // against the price and interval this service actually registered.
      const scoped = vaultMatchesService(v, serviceScope);
      if (!scoped.matches) {
        logStep(`  – vault ${v.pda.toBase58().slice(0, 12)}… skipped: ${scoped.reason}`);
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

    // 3. The revenue leg — sweep what the vaults owe us.
    await sweepRevenue(connection, merchant, retailer, vaults, slot);
  } catch (err) {
    logStep(`  ! poll vaults failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Revenue sweep: claim accrued periods, close exhausted vaults.
// ---------------------------------------------------------------------------

/**
 * Claim every period that has accrued, across every vault that names us.
 *
 * Two things worth copying, and one worth understanding:
 *
 * - **No retailer key.** `retailer` is a plain address; the MERCHANT keypair
 *   signs and pays the ~5,000-lamport fee as a third-party payer. The program
 *   pins the destination, so this cannot redirect a lamport: whoever sends the
 *   claim, the payout lands on `vault.retailer`. This is what makes a lost
 *   retailer key survivable — the claims keep working.
 *
 * - **Exhausted vaults are worth one last claim.** The claim that collects (or
 *   finds collected) the final funded period CLOSES the account and pays its
 *   rent (~0.003 SOL) to the retailer. Closing deletes the account, so the SDK
 *   makes it an explicit opt-in: `closeExhausted: true`.
 *
 * - **No service scope here, deliberately.** The scope gates ACCESS (step 2 —
 *   only the registry knows what we sold). Collection needs no gate: every
 *   vault naming us can only ever pay us, so we sweep them all — including a
 *   stranger's self-minted decoy, whose deposit simply becomes ours.
 *
 * `claimableAmount` is computed locally from the vault we already fetched, so
 * a vault with nothing to claim costs zero extra RPC calls and no transaction.
 */
async function sweepRevenue(
  connection: Connection,
  merchant: Keypair,
  retailer: PublicKey,
  vaults: SubscriptionVaultAccount[],
  slot: bigint,
): Promise<void> {
  for (const v of vaults) {
    const accrued = claimableAmount(v, slot);
    const exhausted = fundedPeriodsRemaining(v) === 0n;
    if (accrued === 0n && !exhausted) continue; // between periods — nothing to do

    try {
      const res = await claimPeriod(connection, v.pda, retailer, {
        payer: merchant, // third-party payer: the retailer signs NOTHING
        ...(exhausted && accrued === 0n ? { closeExhausted: true } : {}),
      });
      logStep(
        `  $ claimed ${res.amountClaimed} lamports (${res.periodsClaimed} period(s)) from ` +
          `${v.pda.toBase58().slice(0, 12)}… sig=${res.signature.slice(0, 12)}…` +
          (res.closesVault
            ? ` — vault closed, ${res.rentReleasedLamports} lamports of rent released`
            : ''),
      );
    } catch (err) {
      // Typical here: another claimer beat us to it (the claim is
      // permissionless for everyone, not just for us), or the vault closed
      // since the list was fetched. The preflight errors name the real cause.
      logStep(`  ! claim ${v.pda.toBase58().slice(0, 12)}… failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Resolve the retailer ADDRESS. `RETAILER_ADDRESS` wins; otherwise the seed
 * script's keypair file is read for its public key only — the secret is
 * dropped on the floor, because nothing in this script has any use for it.
 */
function resolveRetailerAddress(): PublicKey {
  if (RETAILER_ADDRESS) return new PublicKey(RETAILER_ADDRESS);
  if (fs.existsSync(RETAILER_KEYPAIR_PATH)) {
    return loadKeypair(RETAILER_KEYPAIR_PATH).publicKey;
  }
  throw new Error(
    `no retailer address: set RETAILER_ADDRESS to your payout address ` +
      `(no key needed — registration and claiming both work from the address alone), ` +
      `or point RETAILER_KEYPAIR at a keypair file to read the address from ` +
      `(looked at ${RETAILER_KEYPAIR_PATH})`,
  );
}

async function main(): Promise<void> {
  if (!fs.existsSync(MERCHANT_KEYPAIR_PATH)) {
    throw new Error(`merchant keypair not found at ${MERCHANT_KEYPAIR_PATH}`);
  }

  const merchant = loadKeypair(MERCHANT_KEYPAIR_PATH);
  const retailer = resolveRetailerAddress();
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log('══════════════════════════════════════════════════════════════');
  console.log('Merchant demo — Netflix Standard');
  console.log(`  merchant signer : ${merchant.publicKey.toBase58()}`);
  console.log(`  retailer payout : ${retailer.toBase58()} (address only — no retailer key held)`);
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

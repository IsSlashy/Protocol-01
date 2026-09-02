/**
 * Top up the restock wallet from the float, on the settlement's clock.
 *
 * The step `.github/workflows/restock-inventory.yml` runs BEFORE the restock.
 * Buyers pay the till, `settle-till` moves the till into the float F, and the
 * restock deposits from a third wallet that nothing refilled: the takings
 * reached F and stopped there while the restock logged FLOOR. This moves the
 * smaller of (what F holds above its own floor) and (what the restock wallet is
 * short of its target), only after F has been quiet for the settlement's quiet
 * period, and after a random start delay so the transfers are not "the ones
 * near the cron minute". The arithmetic and the clock are
 * `lib/privacy/pool/restockTopUp.ts`, tested against a stubbed chain.
 *
 * Reads, from the environment and nowhere else:
 *   P01_FUNDER_SECRET_KEY        the float's key (JSON array or base58)
 *   P01_TREASURY_KEYPAIR_JSON    the restock keypair, used ONLY for its public key
 *   P01_RESTOCK_WALLET_ADDRESS   optional: the restock wallet's public key instead
 *   P01_LIVE_RPC or P01_FUNDER_RPC
 *   P01_SETTLE_MIN_PURCHASES, P01_SETTLE_MIN_QUIET_SECONDS   as the settler reads them
 *   P01_TREASURY_TARGET, P01_TREASURY_LOW_WATER, P01_TREASURY_MAX_PER_RUN, P01_TREASURY_FLOOR
 *   P01_TOPUP_MIN_LAMPORTS       smallest transfer worth making (default one note)
 *   P01_TOPUP_JITTER_MS          random start delay ceiling (default 10 minutes)
 *
 * Prints one line, public keys and amounts only. Never prints a key.
 *
 * ⛔ IT MOVES REAL DEVNET SOL unless `--dry-run` (or P01_TOPUP_DRY_RUN=1), and
 * refuses any chain whose genesis is not devnet's.
 *
 *   cd apps/web
 *   npx tsx scripts/topUpRestockWallet.mts --dry-run    # says what it would do
 *   npx tsx scripts/topUpRestockWallet.mts              # does it
 */
import { appendFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import { formatTopUpLine, runTopUp } from '../lib/privacy/pool/restockTopUp';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DRY_RUN = process.argv.includes('--dry-run') || process.env.P01_TOPUP_DRY_RUN === '1';
const JITTER_MS = (() => {
  const n = Number(process.env.P01_TOPUP_JITTER_MS ?? 600_000);
  return Number.isFinite(n) && n >= 0 ? n : 600_000;
})();

function fail(message: string): never {
  // `::error::` is a GitHub annotation; harmless anywhere else.
  console.error(`::error::${message}`);
  process.exit(1);
}

/** The same two shapes the settler accepts. The value is never echoed. */
function secretKeyBytes(raw: string): Uint8Array {
  const s = raw.trim();
  return s.startsWith('[') ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s);
}

function funderKeypair(): Keypair {
  const raw = process.env.P01_FUNDER_SECRET_KEY?.trim();
  if (!raw) {
    return fail(
      'P01_FUNDER_SECRET_KEY is unset, so nothing can move the float to the restock wallet. ' +
        'The restock will run from whatever the wallet still holds.',
    );
  }
  try {
    return Keypair.fromSecretKey(secretKeyBytes(raw));
  } catch {
    return fail('P01_FUNDER_SECRET_KEY is not a keypair (expected a JSON array or base58).');
  }
}

/**
 * The restock wallet's PUBLIC key. Derived from the keypair the restock step
 * uses, so the two steps cannot disagree about which wallet is being filled,
 * and the secret is dropped as soon as the public key is out.
 */
function restockWalletPubkey(): PublicKey {
  const address = process.env.P01_RESTOCK_WALLET_ADDRESS?.trim();
  if (address) {
    try {
      return new PublicKey(address);
    } catch {
      return fail('P01_RESTOCK_WALLET_ADDRESS is not a public key.');
    }
  }
  const raw = process.env.P01_TREASURY_KEYPAIR_JSON?.trim();
  if (!raw) {
    return fail('Neither P01_RESTOCK_WALLET_ADDRESS nor P01_TREASURY_KEYPAIR_JSON is set; nothing to fill.');
  }
  try {
    return Keypair.fromSecretKey(secretKeyBytes(raw)).publicKey;
  } catch {
    return fail('P01_TREASURY_KEYPAIR_JSON is not a keypair (expected a JSON array).');
  }
}

function report(line: string) {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `${line}\n`);
    } catch {
      /* the log has it */
    }
  }
}

async function main() {
  const funder = funderKeypair();
  const restockWallet = restockWalletPubkey();
  const rpc = process.env.P01_LIVE_RPC || process.env.P01_FUNDER_RPC || 'https://api.devnet.solana.com';
  const chain = new Connection(rpc, 'confirmed');

  const genesis = await chain.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    fail(`refusing to run against a non-devnet chain (genesis ${genesis})`);
  }

  // Decide first on a read-only pass, so a refusal costs no waiting and the
  // delay below only precedes a transfer that would actually happen.
  const preview = await runTopUp({ chain, funder, restockWallet, dryRun: true });
  if (DRY_RUN || preview.plan.verdict !== 'move') {
    report(formatTopUpLine(preview));
    return;
  }

  // A random start, for the same reason the restock has one: a transfer that
  // always lands seconds after the cron minute is a recognisable class.
  const jitter = Math.floor(Math.random() * JITTER_MS);
  console.log(`top-up eligible; waiting ${Math.round(jitter / 1000)}s before sending`);
  await new Promise((r) => setTimeout(r, jitter));

  // Re-read after the wait: the clock only got older, but a settlement or a
  // sweep landing meanwhile is exactly what must not be sat beside.
  const result = await runTopUp({ chain, funder, restockWallet, dryRun: false });
  report(formatTopUpLine(result));
}

main().catch((e: unknown) => fail(`top-up failed: ${(e as Error).message}`));

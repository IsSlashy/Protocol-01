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
 *   P01_TREASURY_KEYPAIR_JSON    the restock keypair (JSON array or base58), used ONLY for its public key
 *   P01_RESTOCK_WALLET_ADDRESS   optional: the restock wallet's public key instead
 *   P01_LIVE_RPC or P01_FUNDER_RPC
 *   P01_SETTLE_MIN_PURCHASES, P01_SETTLE_MIN_QUIET_SECONDS   as the settler reads them
 *   P01_TREASURY_TARGET, P01_TREASURY_LOW_WATER, P01_TREASURY_MAX_PER_RUN, P01_TREASURY_FLOOR
 *   P01_TOPUP_MIN_LAMPORTS       smallest transfer worth making (default one note)
 *   P01_TOPUP_JITTER_MS          random start delay ceiling (default 10 minutes)
 *
 * The step's log is public (ledger row E5). This script speaks only through
 * `lib/privacy/ciLog.ts`: one allowlisted verdict (`ciSay`) and, on failure,
 * one redacted `::error::` line (`ciFail`), both into the verdict file the
 * workflow prints. What a LIBRARY prints on its own is not this script's to
 * refuse: web3.js prints the transfer signature when a websocket subscribe
 * fails. So the workflow sends this script's stdout and stderr to private
 * files. Pinned by `lib/privacy/pool/ciLogHygiene.test.ts`: case "the restock
 * job and the top-up script print only through ciLog" reads this file's
 * sinks, case "the public workflows echo no response body and run the restock
 * silently" reads the redirect, and case "the top-up script, run against a
 * fake chain, puts nothing on the record that moves with the keys, the
 * balances, the signature or the random draws" runs it.
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

import { ciFail, ciSay } from '../lib/privacy/ciLog';
import { formatTopUpLine, runTopUp } from '../lib/privacy/pool/restockTopUp';
import { usePollingConfirmation } from '../lib/privacy/worker/pollingConfirm';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DRY_RUN = process.argv.includes('--dry-run') || process.env.P01_TOPUP_DRY_RUN === '1';
const JITTER_MS = (() => {
  const n = Number(process.env.P01_TOPUP_JITTER_MS ?? 600_000);
  return Number.isFinite(n) && n >= 0 ? n : 600_000;
})();

function fail(message: string): never {
  // A GitHub `::error::` annotation, recorded by ciFail in the verdict file:
  // this step's own stderr is private (see the header), so a line written
  // there would raise nothing anyone can read. Redacted by ciFail, because the
  // annotation is public and the message may carry a key or an amount from a
  // library. Pinned by `lib/privacy/pool/ciLogHygiene.test.ts`, case "the
  // top-up script, run against a fake chain, puts nothing on the record that
  // moves with the keys, the balances, the signature or the random draws".
  // The only way out: case "the restock job and the top-up script print only
  // through ciLog" counts the fail() calls against the fake-chain classes, and
  // allows ciFail and process.exit here and nowhere else.
  ciFail(message);
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
    // Fixed text: it quotes nothing of what it read. Pinned by the fake-chain
    // case of `lib/privacy/pool/ciLogHygiene.test.ts`, class "a float key that
    // is not one", across four shapes that hold no keypair and two keys.
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
    return fail('P01_TREASURY_KEYPAIR_JSON is not a keypair (expected a JSON array or base58).');
  }
}

function report(line: string) {
  // ciSay refuses anything that is not an allowlisted verdict, so a line that
  // grew a key or an amount fails the step instead of publishing it (pinned by
  // `lib/privacy/pool/ciLogHygiene.test.ts`, "ciSay refuses a word or a number
  // nothing allowlisted (positive control)").
  const said = ciSay(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `${said}\n`);
    } catch {
      /* the verdict file still has it */
    }
  }
}

async function main() {
  const funder = funderKeypair();
  const restockWallet = restockWalletPubkey();
  const rpc = process.env.P01_LIVE_RPC || process.env.P01_FUNDER_RPC || 'https://api.devnet.solana.com';
  // Confirmed by polling `getSignatureStatuses`, never by a websocket
  // subscription: web3.js answers a failed `signatureSubscribe` by printing
  // the transfer signature, in a retry loop. The workflow keeps this step's
  // streams private anyway; this removes that print at its source. Pinned by
  // the fake-chain case of `lib/privacy/pool/ciLogHygiene.test.ts`, whose
  // chain offers `getSignatureStatuses` and no `confirmTransaction`.
  const chain = usePollingConfirmation(new Connection(rpc, 'confirmed'));

  const genesis = await chain.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    fail(`refusing to run against a non-devnet chain (genesis ${genesis})`);
  }

  // Decide first on a read-only pass, so a refusal costs no waiting and the
  // delay below only precedes a transfer that would actually happen.
  const preview = await runTopUp({ chain, funder, restockWallet, dryRun: true });
  if (DRY_RUN || preview.plan.verdict !== 'move') {
    // The preview is always read-only; the line says whether THIS run was.
    report(formatTopUpLine({ ...preview, dryRun: DRY_RUN }));
    return;
  }

  // A random start, for the same reason the restock has one: a transfer that
  // always lands seconds after the cron minute is a recognisable class.
  const jitter = Math.floor(Math.random() * JITTER_MS);
  // How long it waits is what the delay is for: printing it lets a reader
  // subtract it and recover the cron minute. Pinned by
  // `lib/privacy/pool/ciLogHygiene.test.ts` ("the restock job and the top-up
  // script print only through ciLog"): the jitter is not a vetted count; and
  // by the fake-chain case named above, whose "the random draws" world moves it.
  ciSay('top-up waiting');
  await new Promise((r) => setTimeout(r, jitter));

  // Re-read after the wait: the clock only got older, but a settlement or a
  // sweep landing meanwhile is exactly what must not be sat beside.
  const result = await runTopUp({ chain, funder, restockWallet, dryRun: false });
  report(formatTopUpLine(result));
}

main().catch((e: unknown) => fail(`top-up failed: ${(e as Error).message}`));

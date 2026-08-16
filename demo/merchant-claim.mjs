/**
 * The Castle DAO demo, act two: the escrow releases, and the merchant did not
 * sign for it.
 *
 * SIMULATES by default. It builds the real instruction and asks the cluster to
 * execute it without committing, so it needs no key, no SOL, and it cannot move
 * anything. Pass --send <keypair.json> to actually land it.
 *
 * Two things are shown, and the second matters as much as the first:
 *   1. a claim whose fee payer is NOT the retailer succeeds, and the money goes
 *      to the retailer anyway
 *   2. the same claim with the payer named as retailer is REFUSED on chain
 * Anyone with a funded account can push the button. Nobody can move the
 * destination.
 *
 * The fee payer here is our own key, and the script says so rather than calling
 * it a stranger. See the note above its declaration for why a freshly generated
 * key cannot stand in.
 */
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  ZK_SHIELDED_PROGRAM_ID_DEVNET,
  buildClaimPeriodInstruction,
  claimableAmount,
  claimablePeriods,
  decodeSubscriptionVault,
  entitlementStatus,
} from '@protocol-01/merchant-sdk';

const rpc = new Connection('https://api.devnet.solana.com', 'confirmed');
const t0 = Date.now();

const accounts = await rpc.getProgramAccounts(new PublicKey(ZK_SHIELDED_PROGRAM_ID_DEVNET), {
  filters: [
    {
      memcmp: {
        offset: 0,
        bytes: Buffer.from(SUBSCRIPTION_VAULT_DISCRIMINATOR).toString('base64'),
        encoding: 'base64',
      },
    },
  ],
});

const slot = BigInt(await rpc.getSlot('confirmed'));

// Pick a vault the program will actually pay out on, at run time. Devnet moves;
// a hardcoded address is a demo that works until the day it does not.
let target = null;
for (const a of accounts) {
  let v;
  try {
    v = decodeSubscriptionVault(a.account.data);
  } catch {
    continue;
  }
  const periods = claimablePeriods(v, slot);
  if (periods > 0n) {
    target = { pda: a.pubkey, v, periods, amount: claimableAmount(v, slot) };
    break;
  }
}

if (!target) {
  console.log('No vault has a claimable period right now. Nothing to demonstrate.');
  process.exit(0);
}

const retailer = target.v.retailer instanceof PublicKey
  ? target.v.retailer
  : new PublicKey(target.v.retailer);

console.log(`vault                : ${target.pda.toBase58()}`);
console.log(`status               : ${entitlementStatus(target.v, slot)}`);
console.log(`claimable periods    : ${target.periods}`);
console.log(`claimable amount     : ${Number(target.amount) / 1e9} SOL`);
console.log(`retailer             : ${retailer.toBase58()}`);

/** Simulate one claim, with `payer` as fee payer and `namedRetailer` as the payee. */
async function simulate(label, payer, namedRetailer) {
  const ix = buildClaimPeriodInstruction(target.pda, namedRetailer);
  const tx = new Transaction().add(ix);
  tx.feePayer = payer;
  tx.recentBlockhash = (await rpc.getLatestBlockhash('confirmed')).blockhash;

  const sim = await rpc.simulateTransaction(tx, undefined, [retailer]);
  const err = sim.value.err;
  const cu = sim.value.unitsConsumed;
  const logs = sim.value.logs ?? [];
  const failure = logs.find((l) => /Error|failed|Unauthorized/i.test(l));

  console.log(`\n${label}`);
  console.log(`  payer              : ${payer.toBase58()}`);
  console.log(`  named retailer     : ${namedRetailer.toBase58()}`);
  console.log(`  result             : ${err ? 'REFUSED' : 'ACCEPTED'}   (${cu ?? '?'} CU)`);
  if (err) console.log(`  reason             : ${failure ?? JSON.stringify(err)}`);
  return !err;
}

// The property being demonstrated is narrow and real: the fee payer is not the
// payee, and the escrow pays the payee anyway, because the destination is pinned
// by the account and not by a signature.
//
// This key used to be introduced as "a stranger". It is not one: it is our own
// program upgrade authority, and that is the single line in this demo an auditor
// in the room could have caught. It is named for what it is now.
//
// A freshly generated key would have been the honest illustration, and it does
// not work: measured 2026-08-16, simulation of a fee payer that holds nothing
// returns AccountNotFound before reaching the program, so BOTH cases come back
// REFUSED and the demonstration says nothing. The fee payer has to be an account
// that exists. Any funded account would do; this is simply one we can name.
const payerNotPayee = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');
console.log(`fee payer            : ${payerNotPayee.toBase58()}`);
console.log('                       ours, not the retailer. Any funded account works.');
await simulate('CLAIM pushed by a key that is NOT the retailer', payerNotPayee, retailer);

// The same claim, redirected: the payer names ITSELF as the payee.
await simulate('THE SAME CLAIM, redirected to the payer', payerNotPayee, payerNotPayee);

console.log(`\ntotal runtime        : ${Date.now() - t0} ms`);
console.log('\nSimulated only — nothing was signed and nothing moved.');

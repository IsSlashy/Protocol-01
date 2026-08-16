/**
 * The Castle DAO gate demo, act one.
 *
 * Nothing here is ours except this file: the SDK came from the public npm
 * registry into an empty directory, the RPC is the public devnet endpoint, and
 * there is no key, no SOL and no account anywhere in it. A merchant's whole
 * integration is the two calls below.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  ZK_SHIELDED_PROGRAM_ID_DEVNET,
  decodeSubscriptionVault,
  entitlementStatus,
  fetchVaultByAddress,
  hasActiveVaultAccessForVault,
} from '@protocol-01/merchant-sdk';

const rpc = new Connection('https://api.devnet.solana.com', 'confirmed');

// Discover the live vaults rather than hardcoding one: a demo that only works
// against a pasted address is a demo the audience cannot repeat.
const t0 = Date.now();
const accounts = await rpc.getProgramAccounts(new PublicKey(ZK_SHIELDED_PROGRAM_ID_DEVNET), {
  filters: [
    { memcmp: { offset: 0, bytes: Buffer.from(SUBSCRIPTION_VAULT_DISCRIMINATOR).toString('base64'), encoding: 'base64' } },
  ],
});
console.log(`vaults on chain      : ${accounts.length}   (${Date.now() - t0} ms)`);

const rows = [];
for (const a of accounts) {
  try {
    const v = decodeSubscriptionVault(a.account.data);
    rows.push({ pda: a.pubkey.toBase58(), v });
  } catch {
    // Not a vault this SDK version understands. Three sizes exist; skip quietly.
  }
}

const slot = BigInt(await rpc.getSlot('confirmed'));
const byStatus = new Map();
for (const { v } of rows) {
  const s = entitlementStatus(v, slot);
  byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
}
console.log('decoded              :', rows.length);
console.log('entitlement spread   :', [...byStatus].map(([k, n]) => `${k}=${n}`).join('  '));

// Pick a live one and a dead one, from the chain, at run time.
const live = rows.find(({ v }) => entitlementStatus(v, slot) === 'current');
const dead = rows.find(({ v }) => entitlementStatus(v, slot) === 'ended');

for (const [label, row] of [['CURRENT', live], ['ENDED', dead]]) {
  if (!row) {
    console.log(`\n${label}: none on chain right now`);
    continue;
  }
  // TWO signatures the demo plan got wrong, both found by rehearsing rather
  // than on stage:
  //   fetchVaultByAddress            -> { ok, vault }, NOT the vault itself
  //   hasActiveVaultAccessForVault   -> (connection, vaultPda, retailer,
  //                                      subscriberIdBytes, opts?) and it
  //                                      answers the vault account or null,
  //                                      not a boolean
  const { ok, vault: v } = await fetchVaultByAddress(rpc, new PublicKey(row.pda));
  if (!ok || !v) {
    console.log(`\n${label} ${row.pda}: fetch said not ok`);
    continue;
  }

  const pda = new PublicKey(row.pda);
  const retailer = typeof v.retailer === 'string' ? new PublicKey(v.retailer) : v.retailer;
  const subscriberId = row.v.subscriberCommitment;

  const granted = await hasActiveVaultAccessForVault(rpc, pda, retailer, subscriberId);
  const wrongMerchant = await hasActiveVaultAccessForVault(
    rpc,
    pda,
    new PublicKey('11111111111111111111111111111111'),
    subscriberId,
  );
  const wrongSubscriber = await hasActiveVaultAccessForVault(
    rpc,
    pda,
    retailer,
    new Uint8Array(32).fill(9),
  );

  console.log(`\n${label}  ${row.pda}`);
  console.log(`  status               : ${entitlementStatus(v, slot)}`);
  console.log(`  the real subscriber  : ${granted ? 'GRANTED' : 'DENIED'}`);
  console.log(`  a different merchant : ${wrongMerchant ? 'GRANTED' : 'DENIED'}`);
  console.log(`  a made-up subscriber : ${wrongSubscriber ? 'GRANTED' : 'DENIED'}`);
  console.log(`  is_active on chain   : ${v.isActive}   <- the program never sets it false`);
}

console.log(`\ntotal runtime        : ${Date.now() - t0} ms`);

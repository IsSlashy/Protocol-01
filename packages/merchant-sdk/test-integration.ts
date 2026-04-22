/**
 * Live devnet integration test for @protocol-01/merchant-sdk.
 *
 * Uses the 4 seed services registered earlier to exercise:
 *   - fetchService / fetchAllServices
 *   - listVaultsForRetailer (likely 0 vaults at first run)
 *   - pollPaymentsForRetailer (likely 0 payments)
 *   - issueAccessToken / verifyAccessToken round-trip
 *
 * Run:
 *   pnpm --filter @protocol-01/merchant-sdk tsx test-integration.ts
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  fetchService,
  fetchAllServices,
  listVaultsForRetailer,
  pollPaymentsForRetailer,
  issueAccessToken,
  verifyAccessToken,
} from './src';

const RPC_URL =
  process.env.RPC_URL ??
  'https://devnet.helius-rpc.com/?api-key=ad0d91ac-dda3-4906-81ef-37338de04caa';

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, 'confirmed');

  // 1. Fetch all verified services (what the mobile app sees).
  console.log('── fetchAllServices ──');
  const services = await fetchAllServices(connection, { verifiedOnly: true });
  console.log(`found ${services.length} verified service(s)`);
  for (const s of services) {
    console.log(`  ✓ ${s.name.padEnd(18)} retailer=${s.retailer.toBase58().slice(0, 8)}…`);
  }
  console.log('');

  // 2. Deep-dive Netflix.
  const netflixOwner = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');
  const netflix = await fetchService(connection, netflixOwner, 'netflix-standard');
  if (!netflix) throw new Error('Netflix not found — did seed run?');

  console.log('── Netflix service ──');
  console.log(`  pda:          ${netflix.pda.toBase58()}`);
  console.log(`  retailer:     ${netflix.retailer.toBase58()}`);
  console.log(`  price:        ${Number(netflix.priceAtomic) / 1e9} SOL`);
  console.log(`  interval:     ${netflix.intervalSlots} slots`);
  console.log(`  verified:     ${netflix.verified}`);
  console.log(`  supports:     oneshot=${netflix.supportsOneshot} vault=${netflix.supportsVault}`);
  console.log('');

  // 3. Check for any incoming one-shot payments to the Netflix retailer.
  console.log('── pollPaymentsForRetailer (Netflix) ──');
  const receipts = await pollPaymentsForRetailer(connection, netflix.retailer, {
    slugFilter: 'netflix-standard',
    limit: 20,
  });
  if (receipts.length === 0) {
    console.log('  (no matching payments yet — expected for fresh deploy)');
  } else {
    for (const r of receipts) {
      console.log(
        `  ${r.signature.slice(0, 16)}… +${r.sol} SOL memo=${r.memo?.raw ?? '(none)'}`,
      );
    }
  }
  console.log('');

  // 4. Check for any vault subscriptions to Netflix.
  console.log('── listVaultsForRetailer (Netflix) ──');
  const vaults = await listVaultsForRetailer(connection, netflix.retailer, {
    includePaused: true,
  });
  if (vaults.length === 0) {
    console.log('  (no vaults yet — expected for fresh deploy)');
  } else {
    for (const v of vaults) {
      console.log(
        `  ${v.pda.toBase58().slice(0, 12)}… rate=${Number(v.rate) / 1e9} SOL ` +
          `paused=${v.isPaused} private=${v.subscriberCommitment !== null}`,
      );
    }
  }
  console.log('');

  // 5. Access token round-trip — ensures ed25519 signing works in Node.
  console.log('── access token round-trip ──');
  const deployerPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
  const raw = JSON.parse(fs.readFileSync(deployerPath, 'utf-8')) as number[];
  const merchantKp = Keypair.fromSecretKey(Uint8Array.from(raw));

  const token = issueAccessToken({
    merchantKeypair: merchantKp,
    subscriberId: 'test-subscriber-001',
    serviceSlug: 'netflix-standard',
    ttlSeconds: 60 * 60, // 1 hour
    extraClaims: { tier: 'premium' },
  });
  console.log(`  issued token (${token.length} chars)`);

  const verification = verifyAccessToken(token, merchantKp.publicKey);
  if (!verification.valid) {
    throw new Error(`verify failed: ${verification.reason}`);
  }
  console.log(`  verified OK — sub=${verification.claims?.sub} svc=${verification.claims?.svc} tier=${(verification.claims as { tier?: string })?.tier}`);

  // 6. Tamper test — flip a byte, verification must fail.
  const tampered = token.slice(0, -2) + (token.at(-2) === '1' ? '2' : '1') + token.at(-1);
  const tamperedResult = verifyAccessToken(tampered, merchantKp.publicKey);
  if (tamperedResult.valid) {
    throw new Error('tampered token unexpectedly verified — BROKEN');
  }
  console.log(`  tamper check OK — reason: ${tamperedResult.reason}`);

  console.log('\n✅ merchant-sdk integration test passed');
}

main().catch((err) => {
  console.error('integration test failed:', err);
  process.exit(1);
});

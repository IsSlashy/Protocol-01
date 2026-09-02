#!/usr/bin/env node
/**
 * The merchant-side half of a live measurement.
 *
 * The buyer-side half is `apps/web/lib/privacy/pool/liveDevnetSubscribeV4.test.ts`
 * run with `P01_LIVE_RECORD=<file>`: it opens a real circuit-7 subscription on
 * devnet and writes the key the buyer would paste, the retailer it was sold for
 * and the terms. This script plays merchant X: it waits for that record, then
 * asks `verifyMerchantLicense` the questions an integrator's server would ask,
 * and times the first grant against the moment the subscription landed.
 *
 *   node scripts/verify-live-license.mjs <record.json> [out.json]
 *
 * Environment: P01_LIVE_RPC (default: public devnet).
 *
 * The record holds bearer material for a throwaway retailer. The output file
 * carries the commitment, never the key.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  verifyMerchantLicense,
  createEphemeralSession,
  verifyAccessToken,
  decodeLicenseKey,
  licenseCommitment,
  NATIVE_SOL_MINT,
} from '../dist/index.mjs';

const [recordPath, outPath] = process.argv.slice(2);
if (!recordPath) {
  console.error('usage: verify-live-license.mjs <record.json> [out.json]');
  process.exit(2);
}
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const SLUG = 'live-devnet-v4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (u8) => Buffer.from(u8).toString('hex');

// ------------------------------------------------------------ wait for the buyer
const waitStart = Date.now();
while (!existsSync(recordPath)) {
  if (Date.now() - waitStart > 3_600_000) {
    console.error('no record after an hour; the buyer side did not land');
    process.exit(3);
  }
  await sleep(2_000);
}
const rec = JSON.parse(readFileSync(recordPath, 'utf8'));
const merchant = new PublicKey(rec.retailer);
const service = {
  retailer: merchant,
  tokenMint: NATIVE_SOL_MINT,
  priceAtomic: BigInt(rec.rate),
  intervalSlots: BigInt(rec.intervalSlots),
};
const commitment = hex(licenseCommitment(decodeLicenseKey(rec.licenseKey)));
console.log(`record: tx ${rec.txSig}`);
console.log(`        vault ${rec.vaultPDA}`);
console.log(`        retailer ${rec.retailer} rate ${rec.rate} interval ${rec.intervalSlots}`);
console.log(`        blake3(key) ${commitment}`);
console.log(`        landed ${rec.landedAt}`);

const connection = new Connection(RPC, 'confirmed');
const base = { merchant, service, serviceSlug: SLUG, key: rec.licenseKey };
const out = {
  record: { txSig: rec.txSig, vaultPDA: rec.vaultPDA, retailer: rec.retailer, commitment, landedAt: rec.landedAt },
  rpc: RPC.replace(/api-key=.*/, 'api-key=(redacted)'),
  steps: [],
};
const step = (name, r, extra = {}) => {
  const row = {
    name,
    ok: r.ok,
    reason: r.ok ? undefined : r.reason,
    detail: r.ok ? undefined : r.detail,
    ...extra,
  };
  out.steps.push(row);
  const tail = r.ok ? `id ${r.ephemeralAccountId}` : `${r.reason}: ${r.detail}`;
  console.log(`${r.ok ? 'GRANT ' : 'REFUSE'} ${name.padEnd(46)} ${tail}`);
  return row;
};

// ------------------------------------------------------------ 1. from the key alone, as soon as possible
let first = null;
const pollStart = Date.now();
let attempts = 0;
let lastReason = null;
while (Date.now() - pollStart < 300_000) {
  attempts++;
  const t0 = Date.now();
  const r = await verifyMerchantLicense(connection, base);
  const ms = Date.now() - t0;
  if (r.ok) {
    first = r;
    step('key only, first grant', r, {
      attempts,
      callMs: ms,
      secondsAfterLanding: (Date.now() - Date.parse(rec.landedAt)) / 1000,
      vault: r.vaultPda.toBase58(),
      currentSlot: String(r.currentSlot),
      currentUntilSlot: String(r.currentUntilSlot),
      periodsPaidFor: String(r.periodsPaidFor),
    });
    break;
  }
  if (r.reason !== lastReason) console.log(`  attempt ${attempts}: ${r.reason} (${r.detail})`);
  lastReason = r.reason;
  await sleep(2_000);
}
if (!first) {
  console.error('never granted within 5 minutes');
  writeFileSync(outPath ?? 'live-license-verdict.json', JSON.stringify(out, null, 2));
  process.exit(1);
}
if (!first.vaultPda.equals(new PublicKey(rec.vaultPDA))) {
  console.error(`the key located ${first.vaultPda.toBase58()}, the buyer receipt says ${rec.vaultPDA}`);
  process.exit(1);
}

// ------------------------------------------------------------ 2. the same key again: same account
const again = await verifyMerchantLicense(connection, base);
step('key only, second grant (stable id)', again, {
  sameId: again.ok && again.ephemeralAccountId === first.ephemeralAccountId,
});

// ------------------------------------------------------------ 3. the fast path with the vault from the receipt
const fast = await verifyMerchantLicense(connection, { ...base, vault: new PublicKey(rec.vaultPDA) });
step('with vault from receipt', fast, {
  sameId: fast.ok && fast.ephemeralAccountId === first.ephemeralAccountId,
});

// ------------------------------------------------------------ 4. what must be refused
const stranger = Keypair.generate().publicKey;
step(
  'another merchant, key only',
  await verifyMerchantLicense(connection, {
    ...base,
    merchant: stranger,
    service: { ...service, retailer: stranger },
  }),
);
step(
  'another merchant, with the vault address',
  await verifyMerchantLicense(connection, {
    ...base,
    merchant: stranger,
    service: { ...service, retailer: stranger },
    vault: new PublicKey(rec.vaultPDA),
  }),
);
step(
  'same merchant, dearer service (price + 1)',
  await verifyMerchantLicense(connection, {
    ...base,
    service: { ...service, priceAtomic: service.priceAtomic + 1n },
  }),
);
step(
  'same merchant, other billing period',
  await verifyMerchantLicense(connection, {
    ...base,
    service: { ...service, intervalSlots: service.intervalSlots * 2n },
  }),
);
const lastChar = rec.licenseKey.slice(-1);
const flipped = rec.licenseKey.slice(0, -1) + (lastChar === '0' ? '1' : '0');
step('one character of the key changed', await verifyMerchantLicense(connection, { ...base, key: flipped }));
step(
  'a key from thin air',
  await verifyMerchantLicense(connection, { ...base, key: 'P01-0000-0000-0000-0000-0000-0000-00' }),
);
step('a string that is not a key', await verifyMerchantLicense(connection, { ...base, key: 'hello' }));

// ------------------------------------------------------------ 5. the session an integrator would hand out
const issuer = Keypair.generate();
const session = await createEphemeralSession(connection, { ...base, issuer, ttlSeconds: 3600 });
if (session.ok) {
  const check = verifyAccessToken(session.token, issuer.publicKey, { expectedService: SLUG });
  step('ephemeral session + token re-verified', session, {
    tokenValid: check.valid,
    subject: check.claims?.sub,
    subjectIsEphemeralId: check.claims?.sub === first.ephemeralAccountId,
    expiresAtUnix: session.expiresAtUnix,
    tokenBytes: session.token.length,
  });
} else {
  step('ephemeral session', session);
}

// ------------------------------------------------------------ verdict
const grants = out.steps.filter((s) => s.ok).map((s) => s.name);
const refusals = out.steps.filter((s) => !s.ok).map((s) => `${s.name} -> ${s.reason}`);
out.verdict = {
  recognised: !!first,
  grants,
  refusals,
  expectedGrants: 4,
  expectedRefusals: 7,
  pass:
    grants.length === 4 &&
    refusals.length === 7 &&
    out.steps.every((s) => s.sameId !== false && s.tokenValid !== false && s.subjectIsEphemeralId !== false),
};
console.log(`\nverdict: ${out.verdict.pass ? 'PASS' : 'FAIL'} (${grants.length} grants, ${refusals.length} refusals)`);
writeFileSync(outPath ?? 'live-license-verdict.json', JSON.stringify(out, null, 2));
process.exit(out.verdict.pass ? 0 : 1);

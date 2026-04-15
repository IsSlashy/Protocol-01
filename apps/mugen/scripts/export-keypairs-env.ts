/**
 * One-off helper: read local keypair files and print env var assignments
 * in a copy-paste-ready format for the Vercel dashboard.
 *
 * Run:
 *   pnpm --filter @protocol-01/mugen env:export-keypairs
 *
 * Safe on missing files: prints a warning comment and skips that line.
 * For each successfully loaded keypair we also print the public key's
 * first 8 chars so you can cross-check the value you paste into Vercel.
 *
 * NEVER commit the output of this script — it contains raw secret keys.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Keypair } from '@solana/web3.js';

interface LoadResult {
  b64: string;
  pubkey: string;
}

function loadKeypairFile(filePath: string): LoadResult | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(`# WARN: ${filePath} is not a JSON number array, skipping`);
      return null;
    }
    const bytes = Uint8Array.from(parsed as number[]);
    if (bytes.length !== 64) {
      console.error(
        `# WARN: ${filePath} has ${bytes.length} bytes (expected 64), skipping`,
      );
      return null;
    }
    const kp = Keypair.fromSecretKey(bytes);
    return {
      b64: Buffer.from(kp.secretKey).toString('base64'),
      pubkey: kp.publicKey.toBase58(),
    };
  } catch (err) {
    console.error(
      `# WARN: failed to read ${filePath}: ${(err as Error).message}`,
    );
    return null;
  }
}

const mugenRoot = path.resolve(__dirname, '..');
const secretsDir = path.join(mugenRoot, '.secrets');

console.log('# Paste these into the Vercel dashboard (Settings > Environment Variables)');
console.log('# Pubkey preview (first 8 chars) shown in the comment on each line.');
console.log('# Generated at', new Date().toISOString());
console.log('');

// 1. Relayer — defaults to ~/.config/solana/id.json
const relayerPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
const relayer = loadKeypairFile(relayerPath);
if (relayer) {
  console.log(`# relayer pubkey: ${relayer.pubkey.slice(0, 8)}...`);
  console.log(`MUGEN_RELAYER_KEYPAIR=${relayer.b64}`);
} else {
  console.log(`# WARN: relayer keypair missing at ${relayerPath} — skipping MUGEN_RELAYER_KEYPAIR`);
}
console.log('');

// 2. Taker
const takerPath = path.join(secretsDir, 'taker-keypair.json');
const taker = loadKeypairFile(takerPath);
if (taker) {
  console.log(`# taker pubkey: ${taker.pubkey.slice(0, 8)}...`);
  console.log(`MUGEN_TAKER_KEYPAIR_B64=${taker.b64}`);
} else {
  console.log(`# WARN: taker keypair missing at ${takerPath} — skipping MUGEN_TAKER_KEYPAIR_B64`);
}
console.log('');

// 3. Treasury buffer
const treasuryPath = path.join(secretsDir, 'treasury-buffer-keypair.json');
const treasury = loadKeypairFile(treasuryPath);
if (treasury) {
  console.log(`# treasury buffer pubkey: ${treasury.pubkey.slice(0, 8)}...`);
  console.log(`MUGEN_TREASURY_BUFFER_KEYPAIR_B64=${treasury.b64}`);
} else {
  console.log(
    `# WARN: treasury-buffer keypair missing at ${treasuryPath} — skipping MUGEN_TREASURY_BUFFER_KEYPAIR_B64`,
  );
}
console.log('');

// 4. Noise wallets — JSON array of 5 base64 strings
const NOISE_COUNT = 5;
const noiseEntries: LoadResult[] = [];
const noiseMissing: number[] = [];
for (let i = 0; i < NOISE_COUNT; i++) {
  const p = path.join(secretsDir, `noise-wallet-${i}.keypair.json`);
  const loaded = loadKeypairFile(p);
  if (loaded) {
    noiseEntries.push(loaded);
  } else {
    noiseMissing.push(i);
  }
}

if (noiseEntries.length === NOISE_COUNT) {
  const pubkeyPreviews = noiseEntries
    .map((e, i) => `${i}:${e.pubkey.slice(0, 8)}...`)
    .join(' ');
  console.log(`# noise wallet pubkeys: ${pubkeyPreviews}`);
  const jsonArr = JSON.stringify(noiseEntries.map((e) => e.b64));
  console.log(`MUGEN_NOISE_WALLETS_B64=${jsonArr}`);
} else {
  console.log(
    `# WARN: noise wallets incomplete (missing indices: ${noiseMissing.join(', ')}) — ` +
      `skipping MUGEN_NOISE_WALLETS_B64. Expected ${NOISE_COUNT} files at ` +
      `${secretsDir}/noise-wallet-{0..${NOISE_COUNT - 1}}.keypair.json`,
  );
}
console.log('');
console.log('# END — do not commit this output.');

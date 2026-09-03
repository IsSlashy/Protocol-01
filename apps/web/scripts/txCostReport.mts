/**
 * Per-transaction cost of the flows this deployment actually ran, read from
 * the chain rather than from a report.
 *
 * For every signature given (or found in the records under `--records`), it
 * prints the fee, the slot, the instruction count, and the compute units each
 * program consumed, taken from the `consumed N of M compute units` lines the
 * runtime writes into `meta.logMessages`. With `--flow <ephemeral>` it also
 * sums every transaction that ephemeral ever signed, which is what a whole
 * circuit-7 flow costs: the chunk uploads, the resizes, the verify and the
 * sweep, not just the instruction everyone quotes.
 *
 *   npx tsx scripts/txCostReport.mts --rpc <url> --sig <sig> [--sig ...]
 *   npx tsx scripts/txCostReport.mts --rpc <url> --records <dir> --json out.json
 *
 * Read-only: it sends nothing and signs nothing.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

interface ProgramCost {
  program: string;
  consumed: number;
  budget: number;
}

interface TxCost {
  signature: string;
  slot: number;
  blockTime: number | null;
  feeLamports: number;
  instructions: number;
  accounts: number;
  err: string | null;
  programs: ProgramCost[];
  totalConsumed: number;
}

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function optAll(name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1]) out.push(args[i + 1]);
  });
  return out;
}

const RPC = opt('rpc') ?? process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');

/** `Program <id> consumed 193026 of 1400000 compute units` */
const CONSUMED = /Program (\S+) consumed (\d+) of (\d+) compute units/;

async function costOf(signature: string): Promise<TxCost | { signature: string; missing: true }> {
  const tx = await conn.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return { signature, missing: true };
  const programs: ProgramCost[] = [];
  for (const line of tx.meta?.logMessages ?? []) {
    const m = CONSUMED.exec(line);
    if (m) programs.push({ program: m[1], consumed: Number(m[2]), budget: Number(m[3]) });
  }
  const msg = tx.transaction.message;
  const ixs = 'compiledInstructions' in msg ? msg.compiledInstructions : msg.instructions;
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    feeLamports: tx.meta?.fee ?? 0,
    instructions: ixs.length,
    accounts: (msg.staticAccountKeys ?? []).length,
    err: tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
    programs,
    totalConsumed: programs.reduce((a, p) => a + p.consumed, 0),
  };
}

/** Every transaction one address ever signed or touched, and what they cost together. */
async function flowOf(address: string): Promise<{
  address: string;
  transactions: number;
  feeLamports: number;
  computeUnits: number;
  firstSlot: number | null;
  lastSlot: number | null;
  failed: number;
}> {
  const pk = new PublicKey(address);
  const sigs: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(pk, { limit: 1000, before });
    sigs.push(...page.map((s) => s.signature));
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  let fee = 0;
  let cu = 0;
  let failed = 0;
  let firstSlot: number | null = null;
  let lastSlot: number | null = null;
  for (let i = 0; i < sigs.length; i += 1) {
    const c = await costOf(sigs[i]);
    if ('missing' in c) continue;
    fee += c.feeLamports;
    cu += c.totalConsumed;
    if (c.err) failed += 1;
    firstSlot = firstSlot === null ? c.slot : Math.min(firstSlot, c.slot);
    lastSlot = lastSlot === null ? c.slot : Math.max(lastSlot, c.slot);
  }
  return {
    address,
    transactions: sigs.length,
    feeLamports: fee,
    computeUnits: cu,
    firstSlot,
    lastSlot,
    failed,
  };
}

/** Base58 signatures found anywhere in the JSON files under a directory. */
function signaturesFrom(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/"([1-9A-HJ-NP-Za-km-z]{86,88})"/g)) {
        if (!found.has(m[1])) found.set(m[1], name);
      }
    }
  };
  walk(dir);
  return found;
}

async function main() {
  const sigs = optAll('sig');
  const recordsDir = opt('records');
  const labelled = new Map<string, string>();
  for (const s of sigs) labelled.set(s, 'argument');
  if (recordsDir) for (const [s, src] of signaturesFrom(recordsDir)) labelled.set(s, src);

  const out: {
    rpc: string;
    generatedAt: string;
    transactions: TxCost[];
    missing: string[];
    flows: Awaited<ReturnType<typeof flowOf>>[];
    programs: { id: string; dataLen: number; owner: string; lamports: number }[];
  } = {
    rpc: RPC.replace(/api-key=.*/, 'api-key=(redacted)'),
    generatedAt: new Date().toISOString(),
    transactions: [],
    missing: [],
    flows: [],
    programs: [],
  };

  for (const [sig, src] of labelled) {
    const c = await costOf(sig);
    if ('missing' in c) {
      out.missing.push(`${sig} (${src})`);
      // eslint-disable-next-line no-console
      console.log(`MISSING  ${sig.slice(0, 12)}...  ${src}`);
      continue;
    }
    out.transactions.push(c);
    const per = c.programs.map((p) => `${p.program.slice(0, 6)}:${p.consumed}`).join(' ');
    // eslint-disable-next-line no-console
    console.log(
      `${sig.slice(0, 12)}...  slot ${c.slot}  fee ${c.feeLamports}  ix ${c.instructions}  ` +
        `keys ${c.accounts}  CU ${c.totalConsumed}${c.err ? '  ERR ' + c.err : ''}  [${per}]  ${src}`,
    );
  }

  for (const addr of optAll('flow')) {
    const f = await flowOf(addr);
    out.flows.push(f);
    // eslint-disable-next-line no-console
    console.log(
      `FLOW ${addr.slice(0, 12)}...  ${f.transactions} tx  fee ${f.feeLamports} lamports  ` +
        `CU ${f.computeUnits}  slots ${f.firstSlot}..${f.lastSlot}  failed ${f.failed}`,
    );
  }

  for (const id of optAll('program')) {
    const info = await conn.getAccountInfo(new PublicKey(id));
    if (!info) continue;
    out.programs.push({
      id,
      dataLen: info.data.length,
      owner: info.owner.toBase58(),
      lamports: info.lamports,
    });
    // eslint-disable-next-line no-console
    console.log(`PROGRAM ${id}  account ${info.data.length} bytes  owner ${info.owner.toBase58()}`);
  }

  const jsonPath = opt('json');
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    // eslint-disable-next-line no-console
    console.log(`written ${jsonPath}`);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

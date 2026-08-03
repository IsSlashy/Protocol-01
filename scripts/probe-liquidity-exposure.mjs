#!/usr/bin/env node
/**
 * READ-ONLY devnet probe for the p01_liquidity / p01_zkspl "is this deployed?"
 * question, and for whether the instruction `p01_liquidity::settle` CPIs still
 * exists in the deployed `zk_shielded`.
 *
 * This script exists because that question was answered wrong once. A previous
 * pass concluded "p01_zkspl is NOT DEPLOYED, the account does not exist" and
 * downgraded the phase-2 gap from exposure to debt on that basis. It had
 * probed `AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT`, which is the
 * program's `declare_id!` and its `Anchor.toml [programs.localnet]` entry. The
 * devnet deployment is under a DIFFERENT key,
 * `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah` (`[programs.devnet]`), and it
 * is live. Always probe every id a program is known by.
 *
 *   node scripts/probe-liquidity-exposure.mjs
 *
 * ENV: RPC_URL (default https://api.devnet.solana.com)
 *
 * Sends only getAccountInfo / getProgramAccounts / getSlot. It cannot write,
 * it needs no keypair, and it must stay that way.
 */
import { createHash } from 'node:crypto';

const URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

const PROGRAMS = [
  ['p01_zkspl        (declare_id + Anchor localnet)', 'AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT'],
  ['p01_zkspl        (Anchor devnet + mainnet)     ', 'EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah'],
  ['p01_liquidity    (declare_id, absent from Anchor.toml)', '6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg'],
  ['zk_shielded      (declare_id + Anchor devnet)  ', 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c'],
  ['p01_stark_verifier (declare_id + Anchor devnet)', 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs'],
];

const LIQUIDITY = '6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg';
const ZK_SHIELDED = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

// Instructions to look for inside the deployed zk_shielded ELF. The controls
// are not decoration: a probe that finds nothing looks identical to a probe
// that is broken, and the first version of this probe WAS broken (it searched
// for contiguous discriminator bytes, which the compiler never emits).
const IX_PROBE = [
  ['unshield_denominated_stark', 'TARGET  — p01_liquidity::settle CPIs this'],
  ['unshield_denominated_stark_v3', 'its replacement'],
  ['transfer_denominated_stark', 'other instruction retired by f5bb7514'],
  ['transfer_denominated_stark_v3', 'control: must be PRESENT'],
  ['shield_denominated_v3', 'control: must be PRESENT'],
  ['claim_period', 'control: must be PRESENT'],
  ['subscribe_private_stark', 'control: must be PRESENT'],
  ['cancel_normal', 'founder-deleted from source 2026-08-01'],
  ['cancel_private_stark', 'founder-deleted from source 2026-08-01'],
  ['deposit', 'negative control: must be absent'],
];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const bs58 = (b) => {
  let n = BigInt('0x' + Buffer.from(b).toString('hex'));
  let o = '';
  while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; }
  for (const x of b) { if (x === 0) o = '1' + o; else break; }
  return o;
};
const ixDisc = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
const accDisc = (n) => createHash('sha256').update(`account:${n}`).digest().subarray(0, 8).toString('hex');
const sol = (l) => `${(Number(l) / 1e9).toFixed(9)} SOL`;

async function rpc(method, params) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Upgradeable-loader Program account -> { programdata, slot, authority, elf }. */
async function loadProgram(id) {
  const acc = await rpc('getAccountInfo', [id, { encoding: 'base64' }]);
  if (!acc?.value) return null;
  const data = Buffer.from(acc.value.data[0], 'base64');
  const out = { executable: acc.value.executable, owner: acc.value.owner, lamports: acc.value.lamports };
  if (data.length >= 36 && data.readUInt32LE(0) === 2) {
    out.programdata = bs58(data.subarray(4, 36));
    const pd = await rpc('getAccountInfo', [out.programdata, { encoding: 'base64' }]);
    const p = Buffer.from(pd.value.data[0], 'base64');
    out.slot = p.readBigUInt64LE(4);
    out.authority = p[12] ? bs58(p.subarray(13, 45)) : null;
    out.elf = p.subarray(45); // 4 enum + 8 slot + 1 option + 32 authority
  }
  return out;
}

/**
 * Is this 8-byte discriminator present in an SBF ELF?
 *
 * rustc never stores it as eight contiguous bytes. A 64-bit immediate is
 * emitted as `lddw`: two 8-byte slots, the low 4 bytes of the value at +4 and
 * the high 4 bytes at +12. So look for `d[0..4]` followed 8 bytes later by
 * `d[4..8]`. Contiguous and byte-reversed forms are also tried, because a
 * future compiler could legitimately choose either.
 */
function findDiscriminator(elf, d) {
  const hits = [];
  let i = elf.indexOf(d);
  if (i >= 0) hits.push(`contiguous@0x${i.toString(16)}`);
  i = elf.indexOf(Buffer.from(d).reverse());
  if (i >= 0) hits.push(`reversed@0x${i.toString(16)}`);
  for (const [lo, hi, tag] of [
    [d.subarray(0, 4), d.subarray(4, 8), 'lddw'],
    [Buffer.from(d.subarray(4, 8)).reverse(), Buffer.from(d.subarray(0, 4)).reverse(), 'lddw-rev'],
  ]) {
    let p = 0;
    while ((p = elf.indexOf(lo, p)) >= 0) {
      if (p + 12 <= elf.length && elf.subarray(p + 8, p + 12).equals(hi)) {
        hits.push(`${tag}@0x${p.toString(16)}`);
        break;
      }
      p += 1;
    }
  }
  return hits;
}

async function main() {
  console.log(`RPC: ${URL}`);
  console.log(`slot: ${await rpc('getSlot', [])}\n`);

  console.log('=== 1. Is it deployed? ===');
  for (const [label, id] of PROGRAMS) {
    const p = await loadProgram(id);
    if (!p) { console.log(`  ${label}  ${id}\n    ACCOUNT DOES NOT EXIST`); continue; }
    const owned = await rpc('getProgramAccounts', [id, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    const total = owned.reduce((s, a) => s + a.account.lamports, 0);
    console.log(`  ${label}  ${id}`);
    console.log(`    executable=${p.executable} slot=${p.slot} authority=${p.authority}`);
    console.log(`    owned accounts=${owned.length}  total=${sol(total)}`);
  }

  console.log('\n=== 2. What does p01_liquidity own? ===');
  const known = {
    [accDisc('LiquidityPool')]: 'LiquidityPool',
    [accDisc('PrefundRecord')]: 'PrefundRecord',
    [accDisc('LPShare')]: 'LPShare',
  };
  for (const a of await rpc('getProgramAccounts', [LIQUIDITY, { encoding: 'base64' }])) {
    const d = Buffer.from(a.account.data[0], 'base64');
    const h = d.subarray(0, 8).toString('hex');
    const name = known[h] || `unknown(${h})`;
    console.log(`  ${a.pubkey}  ${name.padEnd(14)} len=${d.length} ${sol(a.account.lamports)}`);
    if (name === 'LiquidityPool') {
      console.log(`    admin=${bs58(d.subarray(8, 40))} reserve=${sol(d.readBigUInt64LE(56))}`);
      console.log(`    prefund_fee_bps=${d.readUInt16LE(64)} settler_reward_bps=${d.readUInt16LE(66)} is_active=${d[68]}`);
    }
    if (name === 'PrefundRecord') {
      console.log(`    denominated_pool=${bs58(d.subarray(40, 72))}`);
      console.log(`    amount=${sol(d.readBigUInt64LE(176))} opened_at_slot=${d.readBigUInt64LE(264)}`);
      console.log(`    proof_buffer=${bs58(d.subarray(192, 224))}`);
      // An unsettleable record is the whole point of this probe: report why.
      const dp = await rpc('getAccountInfo', [bs58(d.subarray(40, 72)), { encoding: 'base64' }]);
      const pb = await rpc('getAccountInfo', [bs58(d.subarray(192, 224)), { encoding: 'base64' }]);
      const dpDisc = dp?.value ? Buffer.from(dp.value.data[0], 'base64').subarray(0, 8).toString('hex') : null;
      console.log(`    -> denominated_pool disc=${dpDisc} (${dpDisc === accDisc('DenominatedPool') ? 'v2 DenominatedPool' : dpDisc === accDisc('DenominatedPoolV3') ? 'V3' : 'unknown/missing'})`);
      console.log(`    -> proof_buffer ${pb?.value ? 'exists' : 'DOES NOT EXIST (closed)'}`);
    }
  }

  console.log('\n=== 3. Does the deployed zk_shielded still have settle\'s CPI target? ===');
  const zk = await loadProgram(ZK_SHIELDED);
  console.log(`  programdata=${zk.programdata} slot=${zk.slot} elf=${zk.elf.length}B magic=${zk.elf.subarray(0, 4).toString('hex')}`);
  let controlsSeen = 0, negativeControlClean = true;
  for (const [name, note] of IX_PROBE) {
    const d = ixDisc(name);
    const hits = findDiscriminator(zk.elf, d);
    const present = hits.length > 0;
    if (note.startsWith('control') && present) controlsSeen++;
    if (note.startsWith('negative') && present) negativeControlClean = false;
    console.log(`  ${present ? 'PRESENT' : 'absent '}  ${d.toString('hex')}  ${name.padEnd(30)} ${hits[0] || ''}   # ${note}`);
  }
  console.log(
    `\n  probe validity: ${controlsSeen}/4 positive controls hit, negative control ${negativeControlClean ? 'clean' : 'DIRTY'}`
  );
  if (controlsSeen < 4 || !negativeControlClean) {
    console.error('  !! The probe cannot discriminate. Treat every "absent" above as UNKNOWN, not as evidence.');
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

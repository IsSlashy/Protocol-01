/**
 * WHICH protocol a run measured, read from the source tree at run time and
 * written into manifest.json (`protocol`). Pure file reads, pinned by
 * protocol.test.mts.
 *
 * This benchmark measures v1 AS DEPLOYED: the verifier DGY37k3J…, the shipped
 * blob, the v3 deposit pool and the v4 spend routes. It is a PRE-v2 (pre-WP10)
 * BASELINE. v2 (a new verifier program and v5 pools, plan WP10) is not
 * deployed; its figures will be a separate run with a separate manifest.
 *
 * On-chain facts (each program's last deploy slot) are added by run.mts
 * through live.mts `readDeploySlots`, in a live run only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const BASELINE_LABEL =
  'pre-v2 (pre-WP10) baseline: v1 as deployed (verifier DGY37k3J…, blob d5583d41, v3 deposit pool, v4 spend routes). v2 is not deployed.';

export interface ProtocolRecord {
  baseline: string;
  verifier_program_id: string;
  pool_program_id: string;
  pool: { token: 'SOL'; denomination_sol: 1; pool_pda: string; tree_pda: string; pool_version: string } | null;
  /** The instruction each flow's last pool step calls (Anchor names), each found in the client source. */
  routes: Record<string, { instruction: string; route_version: string; found_in: string; found: boolean }>;
  errors: string[];
}

const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';

export function readProtocol(root: string): ProtocolRecord {
  const errors: string[] = [];
  const read = (rel: string) => {
    try { return readFileSync(path.join(root, rel), 'utf8'); } catch { errors.push(`cannot read ${rel}`); return ''; }
  };
  const types = read('packages/stark-prover/src/types.ts');
  const pool = read('apps/web/lib/privacy/pool/denominatedPool.ts');
  const sub = read('apps/web/lib/privacy/pool/subscribePrivateStarkV4.ts');

  const verifier = new RegExp(`DEFAULT_STARK_VERIFIER_PROGRAM_ID = '(${B58})'`).exec(types)?.[1] ?? '';
  if (!verifier) errors.push('verifier program id not found in packages/stark-prover/src/types.ts');
  const poolProgram = new RegExp(`ZK_SHIELDED_PROGRAM_ID = new PublicKey\\(\\s*'(${B58})'`).exec(pool)?.[1] ?? '';
  if (!poolProgram) errors.push('ZK_SHIELDED_PROGRAM_ID not found in denominatedPool.ts');

  // The one open 1 SOL SOL pool: the table entry with token SOL and denomination 1.
  const entry = new RegExp(
    `token: 'SOL',[^}]*?denomination: 1,[^}]*?poolPDA: new PublicKey\\('(${B58})'\\),\\s*treePDA: new PublicKey\\('(${B58})'\\),\\s*version: '(v\\d)'`,
  ).exec(pool);
  if (!entry) errors.push('the 1 SOL SOL pool entry was not found in denominatedPool.ts');

  const route = (instruction: string, version: string, rel: string, src: string) => {
    const found = src.includes(`'${instruction}'`) || src.includes(`global:${instruction}'`);
    if (!found) errors.push(`${instruction} not found in ${rel}`);
    return { instruction, route_version: version, found_in: rel, found };
  };
  const poolRel = 'apps/web/lib/privacy/pool/denominatedPool.ts';
  const subRel = 'apps/web/lib/privacy/pool/subscribePrivateStarkV4.ts';

  return {
    baseline: BASELINE_LABEL,
    verifier_program_id: verifier,
    pool_program_id: poolProgram,
    pool: entry ? { token: 'SOL', denomination_sol: 1, pool_pda: entry[1]!, tree_pda: entry[2]!, pool_version: entry[3]! } : null,
    routes: {
      deposit: route('shield_denominated_v3', 'v3', poolRel, pool),
      withdrawal: route('unshield_denominated_stark_v4', 'v4', poolRel, pool),
      subscription: route('subscribe_private_stark_v4', 'v4', subRel, sub),
      purchase: route('unshield_denominated_stark_v4', 'v4 (to the till)', poolRel, pool),
    },
    errors,
  };
}

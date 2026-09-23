/**
 * ShieldModule against the instructions the deployed `zk_shielded` program
 * actually registers.
 *
 * Every pool path of this module builds an instruction the program does not
 * route: `shield_stark`, `transfer_stark` and `unshield_stark` (names the
 * program never had), plus `shield_denominated` and
 * `unshield_denominated_stark` (the v2 instructions, commented out in
 * programs/zk_shielded/src/lib.rs). Before the guard, a caller paid for a STARK
 * proof and its upload, then got InstructionFallbackNotFound.
 *
 * These tests pin three things:
 *   1. Each name the module targets is either registered in lib.rs or listed in
 *      UNREGISTERED_ZK_SHIELDED_INSTRUCTIONS, and each listed name really is
 *      unregistered (a stale guard fails too, so re-enabling an instruction
 *      forces the guard to come off with it).
 *   2. Every public pool call fails closed BEFORE it asks the host for a proof
 *      and before it touches the RPC.
 *   3. The root README does not advertise these calls as working.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { PrivacySDK, PrivacyError } from '../src';
import * as shieldModule from '../src/modules/shield';

const REPO = resolve(__dirname, '..', '..', '..');
const LIB_RS = resolve(REPO, 'programs', 'zk_shielded', 'src', 'lib.rs');
const SHIELD_TS = resolve(__dirname, '..', 'src', 'modules', 'shield.ts');
const README = resolve(REPO, 'README.md');

/** Instruction names the program routes: `pub fn` names once comments are gone. */
function registeredInstructions(): Set<string> {
  const src = readFileSync(LIB_RS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const mod = src.slice(src.indexOf('#[program]'));
  return new Set([...mod.matchAll(/\bpub\s+fn\s+(\w+)\s*[<(]/g)].map((m) => m[1]!));
}

/** Instruction names shield.ts builds: anchorDiscriminator('x') + STARK_DISCRIMINATORS keys. */
function targetedInstructions(): { names: Set<string>; pinned: Map<string, number[]> } {
  const src = readFileSync(SHIELD_TS, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/anchorDiscriminator\('(\w+)'\)/g)) names.add(m[1]!);
  const pinned = new Map<string, number[]>();
  const block = src.match(/const STARK_DISCRIMINATORS = \{([\s\S]*?)\}/);
  expect(block, 'STARK_DISCRIMINATORS block not found in shield.ts').not.toBeNull();
  for (const m of block![1]!.matchAll(/(\w+):\s*Buffer\.from\(\[([\d,\s]+)\]\)/g)) {
    names.add(m[1]!);
    pinned.set(m[1]!, m[2]!.split(',').map((s) => Number(s.trim())));
  }
  return { names, pinned };
}

function guardList(): Record<string, string> {
  const list = (shieldModule as Record<string, unknown>).UNREGISTERED_ZK_SHIELDED_INSTRUCTIONS;
  expect(list, 'shield.ts must export UNREGISTERED_ZK_SHIELDED_INSTRUCTIONS').toBeTypeOf('object');
  return list as Record<string, string>;
}

describe('ShieldModule targets vs the zk_shielded registry (programs/zk_shielded/src/lib.rs)', () => {
  it('parses the live registry (sanity: the v3/v4 production instructions are there)', () => {
    const live = registeredInstructions();
    expect(live.has('shield_denominated_v3')).toBe(true);
    expect(live.has('unshield_denominated_stark_v3')).toBe(true);
    expect(live.has('unshield_denominated_stark_v4')).toBe(true);
    // The base-pool and v2 names are commented out.
    for (const gone of ['shield', 'transfer', 'unshield', 'shield_denominated', 'unshield_denominated_stark']) {
      expect(live.has(gone), `${gone} unexpectedly registered`).toBe(false);
    }
  });

  it('pinned STARK discriminators are sha256("global:<name>")[0..8]', () => {
    const { pinned } = targetedInstructions();
    expect(pinned.size).toBeGreaterThan(0);
    for (const [name, bytes] of pinned) {
      expect(bytes, name).toEqual(Array.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8)));
    }
  });

  it('every instruction the module builds is registered, or guarded as unregistered', () => {
    const live = registeredInstructions();
    const guard = guardList();
    const { names } = targetedInstructions();
    const unguarded = [...names].filter((n) => !live.has(n) && !(n in guard));
    expect(unguarded, 'shield.ts builds these unregistered instructions with no guard').toEqual([]);
  });

  it('the guard list is not stale: each listed name is really unregistered', () => {
    const live = registeredInstructions();
    const stale = Object.keys(guardList()).filter((n) => live.has(n));
    expect(stale, 'these are registered again; remove them from the guard and re-test the path').toEqual([]);
  });
});

// ─── Fail-closed behaviour ────────────────────────────────────────────────────

function recordingConnection() {
  const calls: string[] = [];
  const conn = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // not a thenable
      if (prop === 'rpcEndpoint') return 'http://recording.invalid';
      if (prop === 'commitment') return 'confirmed';
      return (..._args: unknown[]) => {
        calls.push(String(prop));
        if (prop === 'getAccountInfo') return Promise.resolve(null);
        if (prop === 'getLatestBlockhash') {
          return Promise.resolve({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 });
        }
        return Promise.reject(new Error(`recording connection: ${String(prop)} refused`));
      };
    },
  });
  return { conn, calls };
}

function setup() {
  const { conn, calls } = recordingConnection();
  const sdk = new PrivacySDK({
    connection: conn as never,
    wallet: Keypair.generate(),
    network: 'devnet',
    spendingKey: new Uint8Array(32).fill(7),
  } as never);
  const proverCalls: number[] = [];
  sdk.shield.setProverConfig({
    generateStarkProof: async (circuitId: number) => {
      proverCalls.push(circuitId);
      return { proofBuffer: Keypair.generate().publicKey, circuitId };
    },
  });
  return { sdk, calls, proverCalls };
}

const PATHS: Array<[string, string, (sdk: PrivacySDK) => Promise<unknown>]> = [
  ['shield (variable pool)', 'shield_stark', (s) => s.shield.shield({ amount: 1_000_000_000n, token: 'SOL' })],
  ['shield (denominated)', 'shield_denominated', (s) => s.shield.shield({ amount: 1_000_000_000n, token: 'SOL', denominated: true })],
  ['transfer', 'transfer_stark', (s) => s.shield.transfer({ amount: 1_000_000_000n, token: 'SOL', to: new PublicKey(Keypair.generate().publicKey) })],
  ['unshield (variable pool)', 'unshield_stark', (s) => s.shield.unshield({ amount: 1_000_000_000n, token: 'SOL' })],
  ['unshield (denominated)', 'unshield_denominated_stark', (s) => s.shield.unshield({ amount: 1_000_000_000n, token: 'SOL', denominated: true })],
];

describe('ShieldModule pool calls fail closed on the deployed program', () => {
  for (const [label, instruction, call] of PATHS) {
    it(`${label}: rejects naming ${instruction}, with no proof requested and no RPC call`, async () => {
      const { sdk, calls, proverCalls } = setup();
      const err = await call(sdk).then(
        () => { throw new Error('resolved: expected a rejection'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PrivacyError);
      expect((err as Error).message).toContain(`\`${instruction}\``);
      expect((err as Error).message).toMatch(/not registered/);
      expect(proverCalls, 'the host prover was asked for a proof the chain cannot use').toEqual([]);
      expect(calls, 'the module reached the RPC before refusing').toEqual([]);
    });
  }
});

// ─── The root README ──────────────────────────────────────────────────────────

describe('README.md does not advertise the unavailable pool calls as working', () => {
  const readme = readFileSync(README, 'utf8');

  it('the privacy-sdk code sample carries no live sdk.shield / sdk.transfer / sdk.unshield call', () => {
    const blocks = [...readme.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const sdkBlocks = blocks.filter((b) => b.includes('@protocol-01/privacy-sdk'));
    for (const b of sdkBlocks) {
      const live = b.split('\n').filter((l) => /^\s*(await\s+)?sdk\.(shield|transfer|unshield)\b/.test(l));
      expect(live, 'README shows these as working calls').toEqual([]);
    }
  });

  it('the architecture line for privacy-sdk does not say shield/unshield/subscribe work', () => {
    const line = readme.split('\n').find((l) => /│\s+├── privacy-sdk\//.test(l));
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/shield\/unshield\/subscribe with STARK proofs/);
  });

  it('the Testing row for privacy-sdk says its tests never reach the program', () => {
    const row = readme.split('\n').find((l) => /^\| privacy-sdk \|/.test(l));
    expect(row).toBeDefined();
    expect(row!).toMatch(/not registered|never reach/i);
  });
});

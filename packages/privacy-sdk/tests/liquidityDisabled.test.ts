/**
 * The instant-unshield / liquidity path against the DEPLOYED p01_liquidity
 * program. Audit v1, finding F27 (SDK mitigation of a founder item).
 *
 * The deployed `p01_liquidity::prefund` pays the amount the caller names
 * against a STARK proof buffer whose phase-2 verification it does not check,
 * with no Merkle membership: the devnet reserve was drained in litesvm with
 * the deployed ELF. Fixing it needs a program redeploy (founder decision).
 * Until then this SDK must not route anyone through it:
 *
 *   - an LP `deposit` into that reserve is money anyone can take out;
 *   - `prefund` / `settle` and the whole InstantUnshieldFlow drive it.
 *
 * So each of them refuses, before any RPC call, when it targets the deployed
 * program id. LP `withdraw` stays available, so liquidity already in the pool
 * can leave. A builder given another program id (a localnet or a fixed
 * redeploy at a new address) still encodes, which is what the encoding tests
 * in instantUnshield.test.ts and sdk.test.ts exercise.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';

import {
  InstantUnshieldFlow,
  buildInstantUnshield,
  goldilocksU64ToNullifierBytes,
  LiquidityModule,
  P01_LIQUIDITY_PROGRAM_ID,
  PrivacyError,
  PrivacyErrorCode,
  getDeployedProgramIds,
} from '../src';

/** A Connection whose every call is recorded; nothing may reach it. */
function recordingConnection(): { conn: Connection; calls: string[] } {
  const calls: string[] = [];
  const conn = new Proxy({} as Connection, {
    get(_t, prop) {
      return (..._args: unknown[]) => {
        calls.push(String(prop));
        return Promise.resolve(0);
      };
    },
  });
  return { conn, calls };
}

function input() {
  const proofSize = 1200;
  return {
    proofBytes: new Uint8Array(proofSize),
    publicInputs: [0xdeadbeefn, 0x1234n],
    proofSize,
    recipient: Keypair.generate().publicKey,
    denominatedPool: Keypair.generate().publicKey,
    nullifier: goldilocksU64ToNullifierBytes(0xdeadbeefn),
    merkleRoot: new Uint8Array(32).fill(1),
    amount: 1_000_000_000n,
    minEpoch: 1n,
  };
}

function expectDisabled(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected a refusal, got a built instruction').toBeInstanceOf(PrivacyError);
  expect((thrown as PrivacyError).code).toBe(PrivacyErrorCode.LIQUIDITY_DISABLED);
  expect((thrown as PrivacyError).message).toMatch(/disabled/i);
  expect((thrown as PrivacyError).message).toContain(P01_LIQUIDITY_PROGRAM_ID.toBase58());
}

describe('p01_liquidity at its deployed id: the SDK refuses to route through it (F27)', () => {
  const { conn, calls } = recordingConnection();
  const liquidity = new LiquidityModule(conn);
  const me = Keypair.generate().publicKey;
  const any = Keypair.generate().publicKey;

  it('the default LiquidityModule targets the deployed program (this is the case being guarded)', () => {
    expect(liquidity.programId.equals(P01_LIQUIDITY_PROGRAM_ID)).toBe(true);
  });

  it('buildPrefundIx refuses', () => {
    expectDisabled(() =>
      liquidity.buildPrefundIx({
        ephemeralSigner: me,
        recipient: any,
        starkProofBuffer: any,
        denominatedPool: any,
        nullifier: new Uint8Array(32),
        merkleRoot: new Uint8Array(32),
        minEpoch: 1n,
        starkCommitment: 1n,
        amount: 1n,
      }),
    );
  });

  it('buildSettleIx refuses', () => {
    expectDisabled(() =>
      liquidity.buildSettleIx({
        settler: me,
        denominatedPool: any,
        nullifier: new Uint8Array(32),
        merkleTree: any,
        nullifierRecord: any,
        starkProofBuffer: any,
        protocolFeeWallet: any,
        zkShieldedProgram: any,
      }),
    );
  });

  it('buildDepositIx refuses: an LP deposit into a drainable reserve', () => {
    expectDisabled(() => liquidity.buildDepositIx(me, 1_000_000_000n));
  });

  it('buildWithdrawIx still builds, so liquidity already in the pool can leave', () => {
    const ix = liquidity.buildWithdrawIx(me, 1n);
    expect(ix.programId.equals(P01_LIQUIDITY_PROGRAM_ID)).toBe(true);
  });

  it('InstantUnshieldFlow.buildInstructions refuses', () => {
    expectDisabled(() => new InstantUnshieldFlow(conn).buildInstructions(input()));
  });

  it('InstantUnshieldFlow.buildAll and buildInstantUnshield reject before any RPC call', async () => {
    const { minEpoch: _drop, ...noEpoch } = input();
    const before = calls.length;
    await expect(new InstantUnshieldFlow(conn).buildAll(noEpoch)).rejects.toMatchObject({
      code: PrivacyErrorCode.LIQUIDITY_DISABLED,
    });
    await expect(buildInstantUnshield(conn, noEpoch)).rejects.toMatchObject({
      code: PrivacyErrorCode.LIQUIDITY_DISABLED,
    });
    expect(calls.slice(before)).toEqual([]);
  });

  it('another program id (localnet, or a fixed redeploy at a new address) still encodes', () => {
    const other = new LiquidityModule(conn, Keypair.generate().publicKey);
    expect(other.buildDepositIx(me, 1n).programId.equals(other.programId)).toBe(true);
    const flow = new InstantUnshieldFlow(conn, other.programId);
    expect(flow.buildInstructions(input()).prefund.programId.equals(other.programId)).toBe(true);
  });
});

describe('the package README says the instant path is disabled (F27) and the pool calls refuse (F45)', () => {
  const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

  it('names the liquidity / instant-unshield path as disabled, with the deployed id', () => {
    expect(readme).toMatch(/instant[- ]unshield[\s\S]{0,400}disabled/i);
    expect(readme).toContain(P01_LIQUIDITY_PROGRAM_ID.toBase58());
  });

  it('says shield / transfer / unshield refuse on the deployed program instead of showing them as working', () => {
    expect(readme).toMatch(/`?shield`?,\s+`?transfer`?\s+and\s+`?unshield`?[\s\S]{0,300}(refuse|throw)/i);
  });

  it('does not claim any program of this SDK is deployed on mainnet', () => {
    const at = readme.indexOf('## Network Support');
    expect(at, 'README has no "## Network Support" section').toBeGreaterThanOrEqual(0);
    const lines = readme.slice(at).split('\n');
    const first = lines.findIndex((l) => l.startsWith('|'));
    const end = lines.findIndex((l, k) => k > first && !l.startsWith('|'));
    const rows = lines.slice(first, end < 0 ? undefined : end).filter((l) => !/^\|\s*-/.test(l)).slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim());
      expect(cells[3], r).not.toMatch(/^Deployed/);
    }
  });
});

describe('the README does not present getDeployedProgramIds as a deployment check (F45/F27 verifier finding)', () => {
  const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');
  const constantsSrc = readFileSync(resolve(__dirname, '..', 'src', 'constants.ts'), 'utf8');

  it('behaviour pin: it returns declared ids minus System-program placeholders, including programs the table says are not deployed', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const devnet = getDeployedProgramIds('devnet');
      const mainnet = getDeployedProgramIds('mainnet');
      // The Network Support table says "Not deployed" for all of these.
      for (const k of ['zkspl', 'stream', 'subscription', 'whitelist'] as const) {
        expect(devnet[k], `devnet ${k}`).toBeDefined();
      }
      for (const k of ['zkShielded', 'zkspl', 'stream', 'subscription', 'whitelist'] as const) {
        expect(mainnet[k], `mainnet ${k}`).toBeDefined();
      }
    } finally {
      console.warn = warn;
    }
  });

  it('no README line tells the reader to rely on it, or says it returns what is actually deployed', () => {
    expect(readme).not.toMatch(/getDeployedProgramIds\(network\)`? before relying on a module/i);
    expect(readme).not.toMatch(/only programs that are actually deployed/i);
  });

  it('the README says it filters placeholders only and does not check the chain', () => {
    for (const at of [...readme.matchAll(/getDeployedProgramIds\(/g)].map((m) => m.index!)) {
      const around = readme.slice(Math.max(0, at - 600), at + 600);
      expect(around, `mention at offset ${at}`).toMatch(/placeholder/i);
      expect(around, `mention at offset ${at}`).toMatch(/does not (check|query|read) the chain/i);
    }
  });

  it('its JSDoc does not call the result the deployed programs', () => {
    const at = constantsSrc.indexOf('export function getDeployedProgramIds');
    const doc = constantsSrc.slice(constantsSrc.lastIndexOf('/**', at), at);
    expect(doc).not.toMatch(/Get only the deployed program IDs/);
    expect(doc).not.toMatch(/containing only deployed programs/);
    expect(doc).toMatch(/does not (check|query|read) the chain/i);
  });
});

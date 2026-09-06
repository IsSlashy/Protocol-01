/**
 * [L2 2026-09-06] `proofBufferV3.ts` pinned against the verifier's Rust.
 *
 * The discriminators are the sha256 of the Anchor preimage, the data layout is
 * `proof_size: u32 LE || circuit_id: u8`, and the account order is what the
 * `InitProofBufferV3` / `ResetProofBuffer` structs declare. Every one of those
 * facts is read off `programs/p01_stark_verifier/src/lib.rs` here rather than
 * typed twice, so a Rust edit that moves an argument or adds an account fails
 * this file before it fails on chain.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, SystemProgram } from '@solana/web3.js';

import {
  CIRCUIT_ID_UNKNOWN,
  INIT_PROOF_BUFFER_V3_DISCRIMINATOR,
  PROOF_DATA_OFFSET,
  RESET_PROOF_BUFFER_DISCRIMINATOR,
  STARK_VERIFIER_PROGRAM_ID,
  buildCreateAndInitProofBufferV3Ixs,
  buildCreateProofBufferAccountIx,
  buildInitProofBufferV3Ix,
  buildResetProofBufferIx,
  bufferCanBeReset,
  proofBufferSpace,
  rentForProofBuffer,
} from './proofBufferV3';

const REPO = join(__dirname, '../../../../..');
const RUST = readFileSync(join(REPO, 'programs/p01_stark_verifier/src/lib.rs'), 'utf8').replace(/\r\n/g, '\n');

/** Computed independently (python hashlib) on 2026-09-06. */
const INIT_V3 = [239, 25, 230, 31, 173, 116, 84, 51];
const RESET = [54, 87, 185, 180, 122, 35, 136, 127];

const C7_PROOF_SIZE = 79_405;

function accountsStruct(name: string): string {
  const at = RUST.indexOf(`pub struct ${name}<'info>`);
  expect(at, `${name} must exist in lib.rs`).toBeGreaterThan(0);
  const end = RUST.indexOf('\n}\n', at);
  return RUST.slice(at, end);
}

function handlerSignature(name: string): string {
  const at = RUST.indexOf(`pub fn ${name}(`);
  expect(at, `${name} must exist in lib.rs`).toBeGreaterThan(0);
  const end = RUST.indexOf('{', at);
  return RUST.slice(at, end);
}

describe('discriminators', () => {
  it('init_proof_buffer_v3 and reset_proof_buffer hash to the independently computed bytes', () => {
    expect(Array.from(INIT_PROOF_BUFFER_V3_DISCRIMINATOR)).toEqual(INIT_V3);
    expect(Array.from(RESET_PROOF_BUFFER_DISCRIMINATOR)).toEqual(RESET);
    expect(INIT_V3).not.toEqual(RESET);
  });

  it('the Rust declares both handlers with exactly (proof_size: u32, circuit_id: u8)', () => {
    for (const name of ['init_proof_buffer_v3', 'reset_proof_buffer']) {
      const sig = handlerSignature(name).replace(/\s+/g, ' ');
      expect(sig).toMatch(/proof_size: u32, circuit_id: u8,? \)/);
      expect(sig.indexOf('proof_size')).toBeLessThan(sig.indexOf('circuit_id'));
    }
  });
});

describe('data layout', () => {
  it('is disc || proof_size u32 LE || circuit_id u8, 13 bytes, for both instructions', () => {
    const buffer = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const init = buildInitProofBufferV3Ix(C7_PROOF_SIZE, 7, buffer, authority);
    expect(init.data.length).toBe(13);
    expect(Array.from(init.data.subarray(0, 8))).toEqual(INIT_V3);
    expect(init.data.readUInt32LE(8)).toBe(C7_PROOF_SIZE);
    expect(init.data[12]).toBe(7);

    const reset = buildResetProofBufferIx(C7_PROOF_SIZE, 6, buffer, authority);
    expect(reset.data.length).toBe(13);
    expect(Array.from(reset.data.subarray(0, 8))).toEqual(RESET);
    expect(reset.data.readUInt32LE(8)).toBe(C7_PROOF_SIZE);
    expect(reset.data[12]).toBe(6);
  });

  it('PROOF_DATA_OFFSET is the Rust sum 8 + 32 + 1 + 4 + 4 + 1 + 32 + 1', () => {
    const m = RUST.match(/PROOF_DATA_OFFSET: usize = ([0-9 +]+);/);
    expect(m).not.toBeNull();
    const sum = m![1].split('+').map((s) => Number(s.trim())).reduce((a, b) => a + b, 0);
    expect(sum).toBe(83);
    expect(PROOF_DATA_OFFSET).toBe(83);
    expect(proofBufferSpace(C7_PROOF_SIZE)).toBe(83 + C7_PROOF_SIZE);
  });

  it('refuses non-u32 sizes and circuit ids the chain would refuse, and allows the reset sentinel', () => {
    const k = Keypair.generate().publicKey;
    expect(() => buildInitProofBufferV3Ix(-1, 7, k, k)).toThrow(/u32/);
    expect(() => buildInitProofBufferV3Ix(1.5, 7, k, k)).toThrow(/u32/);
    expect(() => buildInitProofBufferV3Ix(2 ** 32, 7, k, k)).toThrow(/u32/);
    expect(() => buildInitProofBufferV3Ix(10, 8, k, k)).toThrow(/circuitId/);
    expect(() => buildInitProofBufferV3Ix(10, CIRCUIT_ID_UNKNOWN, k, k)).toThrow(/circuitId/);
    expect(() => buildResetProofBufferIx(10, 8, k, k)).toThrow(/circuitId/);
    expect(buildResetProofBufferIx(10, CIRCUIT_ID_UNKNOWN, k, k).data[12]).toBe(255);
  });
});

describe('account order', () => {
  it('InitProofBufferV3 is [proof_buffer (zero, writable), authority (signer)] and nothing else', () => {
    const s = accountsStruct('InitProofBufferV3');
    expect(s).toMatch(/#\[account\(zero\)\]\s*pub proof_buffer: Account<'info, ProofBuffer>/);
    expect(s).toMatch(/pub authority: Signer<'info>/);
    expect(s).not.toMatch(/system_program/);
    const fields = [...s.matchAll(/pub (\w+):/g)].map((m) => m[1]);
    expect(fields).toEqual(['proof_buffer', 'authority']);

    const ix = buildInitProofBufferV3Ix(C7_PROOF_SIZE, 7, Keypair.generate().publicKey, Keypair.generate().publicKey);
    expect(ix.programId.equals(STARK_VERIFIER_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0]).toMatchObject({ isSigner: false, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ isSigner: true, isWritable: false });
  });

  it('ResetProofBuffer is [proof_buffer (mut, has_one = authority), authority (signer)]', () => {
    const s = accountsStruct('ResetProofBuffer');
    expect(s).toMatch(/#\[account\(mut, has_one = authority\)\]\s*pub proof_buffer/);
    const fields = [...s.matchAll(/pub (\w+):/g)].map((m) => m[1]);
    expect(fields).toEqual(['proof_buffer', 'authority']);

    const ix = buildResetProofBufferIx(C7_PROOF_SIZE, 7, Keypair.generate().publicKey, Keypair.generate().publicKey);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0]).toMatchObject({ isSigner: false, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ isSigner: true, isWritable: false });
  });

  it('the create + init pair allocates the full space, owned by the verifier, both keys signing', () => {
    const buffer = Keypair.generate();
    const authority = Keypair.generate().publicKey;
    const lamports = 5_000_000_123; // above 2^32: exercises the hi word
    const [create, init] = buildCreateAndInitProofBufferV3Ixs(C7_PROOF_SIZE, 7, buffer, authority, lamports);
    expect(create.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(create.keys).toHaveLength(2);
    expect(create.keys[0].pubkey.toBase58()).toBe(authority.toBase58());
    expect(create.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(create.keys[1].pubkey.toBase58()).toBe(buffer.publicKey.toBase58());
    expect(create.keys[1]).toMatchObject({ isSigner: true, isWritable: true });
    // SystemInstruction::CreateAccount = tag 0 u32 | lamports u64 | space u64 | owner
    const d = create.data;
    expect(d.length).toBe(52);
    const u64 = (off: number) => d.readUInt32LE(off) + d.readUInt32LE(off + 4) * 2 ** 32;
    expect(d.readUInt32LE(0)).toBe(0);
    expect(u64(4)).toBe(lamports);
    expect(u64(12)).toBe(83 + C7_PROOF_SIZE);
    expect(Array.from(d.subarray(20, 52))).toEqual(Array.from(STARK_VERIFIER_PROGRAM_ID.toBytes()));
    expect(init.keys[0].pubkey.toBase58()).toBe(buffer.publicKey.toBase58());
    expect(init.keys[1].pubkey.toBase58()).toBe(authority.toBase58());
    expect(buildCreateProofBufferAccountIx(C7_PROOF_SIZE, buffer.publicKey, authority, 1).data.length).toBe(52);
    expect(() => buildCreateProofBufferAccountIx(C7_PROOF_SIZE, buffer.publicKey, authority, -1)).toThrow(/lamports/);
  });
});

describe('error numbering and reuse helper', () => {
  it('BufferTooSmall is the LAST variant, so every existing code keeps its number (InvalidProof = 6003)', () => {
    const at = RUST.indexOf('pub enum StarkVerifierError');
    const body = RUST.slice(at, RUST.indexOf('\n}', at));
    const variants = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[A-Z][A-Za-z0-9]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(variants[3]).toBe('InvalidProof');
    expect(variants[variants.length - 1]).toBe('BufferTooSmall');
    expect(variants.indexOf('BufferTooSmall')).toBe(8); // 6008
  });

  it('bufferCanBeReset says yes only when the account already holds the space', () => {
    expect(bufferCanBeReset(null, 10)).toBe(false);
    expect(bufferCanBeReset(new Uint8Array(83 + 9), 10)).toBe(false);
    expect(bufferCanBeReset(new Uint8Array(83 + 10), 10)).toBe(true);
    expect(bufferCanBeReset(new Uint8Array(200_000), C7_PROOF_SIZE)).toBe(true);
  });

  it('rentForProofBuffer asks the cluster for exactly the buffer space', async () => {
    const asked: number[] = [];
    const lamports = await rentForProofBuffer(
      { getMinimumBalanceForRentExemption: async (n: number) => { asked.push(n); return 42; } },
      C7_PROOF_SIZE,
    );
    expect(asked).toEqual([83 + C7_PROOF_SIZE]);
    expect(lamports).toBe(42);
  });
});

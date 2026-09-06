// @vitest-environment node
/**
 * 🚨 ACCOUNT ORDER ON THE EXTENSION'S `buildSubscribePrivateStarkV4Ix`, DERIVED
 * FROM THE PROGRAM.
 *
 * Run: cd apps/extension && pnpm test -- subscribeV4AccountOrder
 *
 * The web twin (`apps/web/lib/privacy/pool/subscribeV4AccountOrder.test.ts`)
 * exists because two key entries — `vault` and `denominated_pool` — were once
 * swapped and the whole suite stayed green. Anchor resolves accounts
 * POSITIONALLY: `keys[i]` is whatever the struct's i-th field is, every entry is
 * a `PublicKey`, so TypeScript cannot see a swap and no literal looks wrong. The
 * chain refuses it at the END — after a ~5.5 s circuit-7 proof and a ~78-chunk
 * upload against a rented buffer.
 *
 * ⛔ THE EXPECTED ORDER IS PARSED OUT OF THE RUST, NOT RETYPED HERE. A list
 * written from memory agrees with the encoder by construction whenever the same
 * person wrote both — which is exactly how the swap survived. So this file
 * reads `programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs`,
 * takes the fields of `SubscribePrivateStarkV4<'info>` in declaration order,
 * and binds INDEX to ROLE.
 *
 * ⛔ NOT REDUNDANT WITH THE WEB COPY. This package's encoder is a separate copy
 * of the web one and will drift the same way unless something in this package
 * asserts on it — the 2026-08-21 finding (three surfaces, three prover blobs,
 * one checked) is the measured history behind that.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
  buildSubscribePrivateStarkV4Ix,
  type SubscribeV4IxParams,
} from './subscribePrivateStarkV4';
import { ZK_SHIELDED_PROGRAM_ID } from './denominatedPool';

const REPO = join(__dirname, '../../../../..');
const RUST = 'programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs';
const STRUCT = "pub struct SubscribePrivateStarkV4<'info> {";

interface RustAccount {
  name: string;
  ty: string;
  optional: boolean;
  writable: boolean;
  signer: boolean;
}

/**
 * The accounts struct, field by field, in the order Anchor resolves them.
 * Attribute text is captured ONLY from inside `#[account( … )]`, with `//`
 * comments stripped first: the doc comment on `vault` contains the words
 * `init` and `mut` in prose.
 */
function parseAccountsStruct(): RustAccount[] {
  const src = readFileSync(join(REPO, RUST), 'utf8');
  const start = src.indexOf(STRUCT);
  expect(start, `${RUST} no longer declares ${STRUCT}`).toBeGreaterThan(-1);
  const body = src.slice(start + STRUCT.length, src.indexOf('\n}', start));

  const out: RustAccount[] = [];
  let attr = '';
  let inAttr = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (inAttr) {
      attr += '\n' + line;
      if (trimmed.endsWith(')]')) inAttr = false;
      continue;
    }
    if (trimmed.startsWith('#[account(')) {
      attr += '\n' + line;
      if (!trimmed.endsWith(')]')) inAttr = true;
      continue;
    }

    const field = trimmed.match(/^pub (\w+):\s*(.+?),?$/);
    if (!field) continue;

    const cleanAttr = attr.replace(/\/\/.*$/gm, '');
    out.push({
      name: field[1],
      ty: field[2],
      optional: /^Option</.test(field[2]),
      writable: /\bmut\b/.test(cleanAttr) || /\binit\b/.test(cleanAttr),
      signer: /\bSigner</.test(field[2]),
    });
    attr = '';
  }
  return out;
}

/** One distinct, recognisable key per role, so a swap cannot hide. */
function distinctKeys(): Record<string, PublicKey> {
  const k = () => Keypair.generate().publicKey;
  return {
    payer: k(),
    retailer: k(),
    vaultPDA: k(),
    poolPDA: k(),
    treePDA: k(),
    nullifierPDA: k(),
    c7ProofBuffer: k(),
    tokenProgram: k(),
    poolVault: k(),
    vaultTokenAccount: k(),
  };
}

/** Rust field name → the pubkey the encoder is supposed to put there. A NAME
 *  map, never an ORDER map: the order comes from the Rust file. */
function roleOf(supplied: Record<string, PublicKey>): Record<string, PublicKey> {
  return {
    payer: supplied.payer,
    retailer: supplied.retailer,
    vault: supplied.vaultPDA,
    denominated_pool: supplied.poolPDA,
    merkle_tree: supplied.treePDA,
    nullifier_record: supplied.nullifierPDA,
    c7_proof_buffer: supplied.c7ProofBuffer,
    system_program: SystemProgram.programId,
    token_program: supplied.tokenProgram,
    pool_vault: supplied.poolVault,
    vault_token_account: supplied.vaultTokenAccount,
  };
}

function baseParams(supplied: Record<string, PublicKey>): SubscribeV4IxParams {
  return {
    payer: supplied.payer,
    retailer: supplied.retailer,
    vaultPDA: supplied.vaultPDA,
    poolPDA: supplied.poolPDA,
    treePDA: supplied.treePDA,
    nullifierPDA: supplied.nullifierPDA,
    c7ProofBuffer: supplied.c7ProofBuffer,
    nullifierBytes: new Uint8Array(32).fill(1),
    merkleRootBytes: new Uint8Array(32).fill(2),
    subtreeRoot: 12345n,
    siblings: [1n, 2n, 3n, 4n],
    directions: [0, 1, 0, 1],
    subscriberCommitmentBytes: new Uint8Array(32).fill(3),
    rate: 1_000_000n,
    intervalSlots: 100n,
    vkHashSubscriber: new Uint8Array(32),
  };
}

describe('extension: the v4 subscribe encoder is read against the program it calls', () => {
  it('really parsed the accounts struct', () => {
    // ANTI-VACUITY. A parse that silently returned `[]` would compare nothing
    // to nothing and pass.
    const fields = parseAccountsStruct();
    expect(fields.length).toBeGreaterThan(5);
    const names = fields.map((f) => f.name);
    expect(names[0], 'the payer is no longer the first account').toBe('payer');
    expect(names, 'ONE buffer is the entire point of v4 — v3 named two').toContain('c7_proof_buffer');
    expect(
      names,
      'a fee_escrow appeared in the v4 subscribe accounts. Charging a fee here strands the ' +
        'deposit AND the rent — this is a MONEY decision, not an encoder fix',
    ).not.toContain('fee_escrow');
    expect(fields.find((f) => f.name === 'payer')!.signer).toBe(true);
    expect(fields.find((f) => f.name === 'vault')!.writable).toBe(true);
    expect(fields.find((f) => f.name === 'merkle_tree')!.writable).toBe(false);
  });

  it('every struct field has a role in this test, and no role is invented', () => {
    const names = parseAccountsStruct().map((f) => f.name);
    const mapped = Object.keys(roleOf(distinctKeys()));
    expect(
      [...names].sort(),
      'the accounts struct and this test disagree about WHICH accounts exist. Update roleOf() ' +
        'and the encoder together — a field added on one side only is resolved positionally and ' +
        'shifts every account after it',
    ).toEqual([...mapped].sort());
  });

  it('binds INDEX to ROLE for a native-SOL pool, in the struct order', () => {
    const supplied = distinctKeys();
    const role = roleOf(supplied);
    const ix = buildSubscribePrivateStarkV4Ix(baseParams(supplied));
    const fields = parseAccountsStruct();

    expect(
      ix.keys.length,
      'all ELEVEN keys must be present even for a native-SOL pool: Anchor 0.32 raises ' +
        'AccountNotEnoughKeys (3005) in the resolver, before the handler runs',
    ).toBe(fields.length);

    fields.forEach((f, i) => {
      const expected = f.optional ? ZK_SHIELDED_PROGRAM_ID : role[f.name];
      expect(
        ix.keys[i].pubkey.toBase58(),
        `account ${i} must be \`${f.name}\` (${f.ty}), the ${i}-th field of ` +
          "SubscribePrivateStarkV4<'info>. Anchor resolves positionally, so a key in the wrong " +
          'slot is not a type error and is not caught until the handler runs — after ~5.5 s of ' +
          'proving and a 78-chunk upload have already been paid for.',
      ).toBe(expected.toBase58());
    });
  });

  it('takes signer and writability from the struct too, not from memory', () => {
    const supplied = distinctKeys();
    const ix = buildSubscribePrivateStarkV4Ix(baseParams(supplied));

    parseAccountsStruct().forEach((f, i) => {
      expect(ix.keys[i].isSigner, `\`${f.name}\` (index ${i}): signer flag`).toBe(f.signer);
      const expectWritable = f.optional ? false : f.writable;
      expect(
        ix.keys[i].isWritable,
        `\`${f.name}\` (index ${i}): the struct says ${f.writable ? 'mut/init' : 'read-only'}`,
      ).toBe(expectWritable);
    });
  });

  it('keeps the same order, and marks the optionals writable, once the SPL accounts are supplied', () => {
    const supplied = distinctKeys();
    const role = roleOf(supplied);
    const ix = buildSubscribePrivateStarkV4Ix({
      ...baseParams(supplied),
      tokenProgram: supplied.tokenProgram,
      poolVault: supplied.poolVault,
      vaultTokenAccount: supplied.vaultTokenAccount,
    });

    parseAccountsStruct().forEach((f, i) => {
      expect(ix.keys[i].pubkey.toBase58(), `account ${i} must be \`${f.name}\``).toBe(
        role[f.name].toBase58(),
      );
      expect(ix.keys[i].isSigner, `\`${f.name}\`: signer flag`).toBe(f.signer);
      expect(ix.keys[i].isWritable, `\`${f.name}\`: writable flag`).toBe(f.writable);
    });
  });

  it('POSITIVE CONTROL: the expected order is built from the Rust and DOES move under the swap', () => {
    const supplied = distinctKeys();
    const role = roleOf(supplied);
    const fields = parseAccountsStruct();

    const fromTheStruct = fields.map((f) =>
      (f.optional ? ZK_SHIELDED_PROGRAM_ID : role[f.name]).toBase58(),
    );
    const vaultAt = fields.findIndex((f) => f.name === 'vault');
    const poolAt = fields.findIndex((f) => f.name === 'denominated_pool');
    expect(vaultAt).toBeGreaterThanOrEqual(0);
    expect(poolAt).toBeGreaterThanOrEqual(0);

    const swapped = [...fromTheStruct];
    [swapped[vaultAt], swapped[poolAt]] = [swapped[poolAt], swapped[vaultAt]];
    expect(swapped, 'the two roles are indistinguishable, so no order test could work').not.toEqual(
      fromTheStruct,
    );

    const observed = buildSubscribePrivateStarkV4Ix(baseParams(supplied)).keys.map((k) =>
      k.pubkey.toBase58(),
    );
    expect(observed).toEqual(fromTheStruct);
    expect(
      observed,
      `the encoder emits the vault at index ${poolAt} and the pool at index ${vaultAt} — the two ` +
        'key entries are swapped against SubscribePrivateStarkV4',
    ).not.toEqual(swapped);
  });
});

describe('extension: the v4 subscribe encoder reads the handler ARGUMENTS in the declared order', () => {
  /**
   * The account test above says nothing about the DATA layout. This one parses
   * `pub fn handler(` and checks the encoder writes the arguments in that order
   * and at the widths Borsh gives them — so a reordered or added argument on
   * the Rust side goes red here instead of deserialising as `InvalidProof`.
   */
  function handlerArgs(): string[] {
    const src = readFileSync(join(REPO, RUST), 'utf8');
    const at = src.indexOf('pub fn handler(');
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf(') -> Result<', at);
    const sig = src.slice(at + 'pub fn handler('.length, end);
    return sig
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\w+:\s*/.test(l) && !l.startsWith('ctx:'))
      .map((l) => l.split(':')[0]);
  }

  it('the handler takes exactly these ten arguments, in this order', () => {
    expect(handlerArgs()).toEqual([
      'nullifier',
      'merkle_root',
      'subtree_root',
      'siblings',
      'directions',
      'subscriber_commitment',
      'rate',
      'interval_slots',
      'vk_hash_subscriber',
      'license_commitment',
    ]);
  });

  it('and the encoder lays them out at the widths Borsh gives them', () => {
    const supplied = distinctKeys();
    const p = baseParams(supplied);
    const license = new Uint8Array(32).fill(9);
    const data = buildSubscribePrivateStarkV4Ix({ ...p, licenseCommitment: license }).data;

    let o = 8; // discriminator
    expect(Buffer.from(data.subarray(o, o + 32))).toEqual(Buffer.from(p.nullifierBytes)); o += 32;
    expect(Buffer.from(data.subarray(o, o + 32))).toEqual(Buffer.from(p.merkleRootBytes)); o += 32;
    expect(data.readBigUInt64LE(o)).toBe(p.subtreeRoot); o += 8;
    expect(data.readUInt32LE(o)).toBe(p.siblings.length); o += 4;
    for (const s of p.siblings) { expect(data.readBigUInt64LE(o)).toBe(s); o += 8; }
    expect(data.readUInt32LE(o)).toBe(p.directions.length); o += 4;
    for (const d of p.directions) { expect(data.readUInt8(o)).toBe(d); o += 1; }
    expect(Buffer.from(data.subarray(o, o + 32))).toEqual(Buffer.from(p.subscriberCommitmentBytes)); o += 32;
    expect(data.readBigUInt64LE(o)).toBe(p.rate); o += 8;
    expect(data.readBigUInt64LE(o)).toBe(p.intervalSlots); o += 8;
    expect(Buffer.from(data.subarray(o, o + 32))).toEqual(Buffer.from(p.vkHashSubscriber)); o += 32;
    expect(data.readUInt8(o)).toBe(1); o += 1;
    expect(Buffer.from(data.subarray(o, o + 32))).toEqual(Buffer.from(license)); o += 32;
    expect(o, 'nothing after the license option').toBe(data.length);
  });
});

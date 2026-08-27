/**
 * 🚨 ACCOUNT ORDER ON `buildSubscribePrivateStarkV4Ix`, DERIVED FROM THE PROGRAM.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHAT WENT UNCAUGHT
 * ──────────────────
 * The two key entries at `subscribePrivateStarkV4.ts:317-318` — `vaultPDA` and
 * `poolPDA` — were swapped, and the whole suite stayed green. Nothing anywhere
 * compared the encoder's key list to `SubscribePrivateStarkV4<'info>`.
 *
 * WHY A SWAP IS NOT A COMPILE ERROR AND NOT A CHEAP FAILURE
 * ─────────────────────────────────────────────────────────
 * Anchor resolves accounts POSITIONALLY. `keys[i]` is whatever the struct's i-th
 * field is, whatever this file believed it was putting there. Every entry is a
 * `PublicKey`, so TypeScript cannot see a swap, and the pubkeys are all runtime
 * values, so no literal looks wrong.
 *
 * The chain does refuse a swap — but at the END of the operation. By the time
 * the instruction runs, the ephemeral has proved a circuit-7 spend (~5.5 s) and
 * uploaded 77,965 bytes in ~78 chunks against a rented buffer. The failure is a
 * seeds-constraint error on an account nobody looked at, and it costs a whole
 * upload to learn.
 *
 * ⛔ THE EXPECTED ORDER IS PARSED OUT OF THE RUST, NOT RETYPED HERE.
 * A list written from memory in this file agrees with the encoder by
 * construction whenever the same person wrote both — which is exactly how the
 * swap survived. So this file reads
 * `programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs`, takes
 * the fields of `SubscribePrivateStarkV4<'info>` in declaration order, and binds
 * INDEX to ROLE. Reordering the struct and reordering the encoder must happen
 * together or this goes red.
 *
 * Signer and writability come from the same source: Anchor marks an account
 * writable iff its `#[account(...)]` carries `mut` or `init`, and a signer iff
 * its type is `Signer<'info>`. Both are read off the attribute, not asserted
 * from memory.
 *
 * WHAT THIS DOES NOT COVER: the instruction DATA layout (`nullifier`,
 * `merkle_root`, the two Borsh Vecs, …). That is a separate encoder with a
 * separate failure mode.
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
  /** Field name, in declaration order. */
  name: string;
  /** The declared type, verbatim. */
  ty: string;
  /** `Option<...>` — Anchor lets the caller omit it, and this repo's encoders
   *  pass the program's own id as the "absent" sentinel rather than shortening
   *  the list (Anchor 0.32 raises AccountNotEnoughKeys inside the resolver). */
  optional: boolean;
  /** `#[account(mut)]` or `#[account(init, …)]` — `init` implies `mut`. */
  writable: boolean;
  /** Type is `Signer<'info>`. */
  signer: boolean;
}

/**
 * The accounts struct, field by field, in the order Anchor resolves them.
 *
 * Attribute text is captured ONLY from inside `#[account( … )]`, and `//`
 * comments are stripped out of it first. Both matter: the doc comment on
 * `vault` contains the words `init` and `mut` in prose, and reading those as
 * Anchor attributes would silently invert this test's expectations.
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

/**
 * Rust field name → the pubkey the encoder is supposed to put there.
 *
 * ⛔ This is a NAME map, never an ORDER map, and the difference is the whole
 * point: the order comes from the Rust file. If a struct field is added,
 * removed or renamed, the coverage assertion below fails rather than this map
 * quietly deciding what the new field means.
 */
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
    siblings: [1n, 2n, 3n],
    directions: [0, 1, 0],
    subscriberCommitmentBytes: new Uint8Array(32).fill(3),
    rate: 1_000_000n,
    intervalSlots: 100n,
    vkHashSubscriber: new Uint8Array(32),
  };
}

describe('the v4 subscribe encoder is read against the program it calls', () => {
  /**
   * ANTI-VACUITY, first. Every assertion below is driven by a regex parse of a
   * file on disk. A parse that silently returned `[]` — a moved file, a
   * reformatted struct — would make the order comparison compare nothing to
   * nothing and pass.
   */
  it('really parsed the accounts struct', () => {
    const fields = parseAccountsStruct();
    expect(fields.length).toBeGreaterThan(5);
    // The three landmarks of THIS instruction, which is what makes the parse
    // recognisable rather than merely non-empty.
    const names = fields.map((f) => f.name);
    expect(names[0], 'the payer is no longer the first account').toBe('payer');
    expect(names, 'ONE buffer is the entire point of v4 — v3 named two').toContain(
      'c7_proof_buffer',
    );
    expect(
      names,
      'a fee_escrow appeared in the v4 subscribe accounts. The module header says charging a ' +
        'fee here strands the deposit AND the rent — this is a MONEY decision, not an encoder fix',
    ).not.toContain('fee_escrow');
    // And it must have read the ATTRIBUTES, not just the field lines.
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
          `SubscribePrivateStarkV4<'info>. Anchor resolves positionally, so a key in the wrong ` +
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
      // An ABSENT optional is the sentinel — the program's own id — and must not
      // be marked writable: it is not the account the struct describes.
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
    // The mutation that stayed green was swapping `vault` and `denominated_pool`.
    // This constructs the expected list from the struct alone — never from the
    // encoder — shows that swapping those two produces a DIFFERENT list, and
    // then shows the encoder matches the un-swapped one. Without this, a parse
    // that happened to mirror the encoder's own order would look like agreement.
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

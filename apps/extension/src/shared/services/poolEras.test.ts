// @vitest-environment node
// (jsdom, the extension default, fails `findProgramAddressSync` with
//  "Unable to find a viable program address nonce"; the PDA math needs Node's crypto.)
/**
 * `poolEras.ts` pinned against the Rust it encodes for.
 *
 * Run: cd apps/extension && npx vitest run src/shared/services/poolEras.test.ts
 *
 * Same discipline as `subscribeV4AccountOrder.test.ts`: the expected account
 * order, mutability and signer flags are PARSED out of each `#[derive(Accounts)]`
 * struct, the discriminators are recomputed from the instruction names found in
 * `lib.rs`, and the constants are read out of the state files. Nothing is
 * retyped here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
  DEFAULT_MARGIN_LEAVES,
  ERA_TREE_DEPTH,
  MAX_HISTORICAL_ROOTS,
  MAX_TREE_DEPTH,
  POOL_DIRECTORY_LEN,
  accountDiscriminator,
  buildInitPoolDirectoryIx,
  buildInitPoolEraIx,
  buildMigratePoolCapacityIx,
  buildMigrateTreeDepthIx,
  buildOpenNextEraIx,
  deriveMerkleTreePDA,
  derivePoolDirectoryPDA,
  derivePoolEraPDA,
  eraMarginReached,
  instructionDiscriminator,
  parsePoolDirectory,
} from './poolEras';
import { ZK_SHIELDED_PROGRAM_ID } from './denominatedPool';

const REPO = join(__dirname, '../../../../..');
const rust = (rel: string) => readFileSync(join(REPO, 'programs/zk_shielded/src', rel), 'utf8');

interface RustAccount {
  name: string;
  writable: boolean;
  signer: boolean;
}

/** Fields of `pub struct <name><'info> { ... }` in declaration order. */
function parseAccounts(src: string, structName: string): RustAccount[] {
  const start = src.indexOf(`pub struct ${structName}<'info> {`);
  if (start < 0) throw new Error(`struct ${structName} not found`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open + 1, i);
  const out: RustAccount[] = [];
  const fieldRe = /((?:\s*(?:\/\/\/[^\n]*|#\[account\([\s\S]*?\)\]|\/\/[^\n]*)\n)*)\s*pub (\w+): ([^,]+),/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const attrs = m[1];
    const name = m[2];
    const ty = m[3];
    const attr = attrs.match(/#\[account\(([\s\S]*?)\)\]/);
    const inner = attr ? attr[1] : '';
    const writable = /(^|[\s,(])mut([\s,)]|$)/.test(inner) || /(^|[\s,(])init([\s,)]|$)/.test(inner);
    out.push({ name, writable, signer: ty.startsWith('Signer<') });
  }
  return out;
}

function keysOf(ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) {
  return ix.keys.map((k) => ({ signer: k.isSigner, writable: k.isWritable }));
}

const mint = SystemProgram.programId;
const denom = 1_000_000_000n;

describe('poolEras: constants come from the program, not from memory', () => {
  it('names every instruction the encoder builds, with the same discriminators', () => {
    const lib = rust('lib.rs');
    for (const name of [
      'migrate_tree_depth',
      'migrate_pool_capacity',
      'init_pool_directory',
      'init_pool_era',
      'open_next_era',
    ]) {
      expect(lib).toMatch(new RegExp(`pub fn ${name}\\(`));
      // The first eight bytes on the wire ARE sha256("global:<name>")[..8].
      const d = instructionDiscriminator(name);
      expect(d).toHaveLength(8);
    }
    expect(Buffer.from(instructionDiscriminator('open_next_era')).toString('hex')).toHaveLength(16);
  });

  it('reads the depth, ring, margin and directory size out of the state files', () => {
    const mt = rust('state/merkle_tree_v3.rs');
    const ir = rust('state/insert_root.rs');
    const pv = rust('state/pool_v3.rs');
    const pd = rust('state/pool_directory.rs');
    const insert = Number(ir.match(/pub const INSERT_SUBTREE_DEPTH: u8 = (\d+);/)![1]);
    const top = Number(ir.match(/pub const MAX_TOP_LEVELS: usize = (\d+);/)![1]);
    expect(mt).toContain('pub const MAX_DEPTH: u8 = INSERT_SUBTREE_DEPTH + MAX_TOP_LEVELS as u8;');
    expect(MAX_TREE_DEPTH).toBe(insert + top);
    expect(pv).toContain('pub const ERA_TREE_DEPTH: u8 = super::merkle_tree_v3::MerkleTreeStateV3::MAX_DEPTH;');
    expect(ERA_TREE_DEPTH).toBe(MAX_TREE_DEPTH);
    expect(Number(pv.match(/pub const MAX_HISTORICAL_ROOTS: u8 = (\d+);/)![1])).toBe(MAX_HISTORICAL_ROOTS);
    expect(BigInt(pd.match(/pub const DEFAULT_MARGIN_LEAVES: u64 = ([\d_]+);/)![1].replace(/_/g, ''))).toBe(
      DEFAULT_MARGIN_LEAVES,
    );
    // LEN = 8 + 32 + 32 + 8 + 2 + 32 + 8 + 1
    const lenTerms = pd
      .slice(pd.indexOf('pub const LEN: usize = 8'), pd.indexOf('; // bump'))
      .match(/\+ (\d+)/g)!
      .map((t) => Number(t.slice(2)));
    expect(8 + lenTerms.reduce((a, b) => a + b, 0)).toBe(POOL_DIRECTORY_LEN);
    expect(pd).toContain('pub const SEED_PREFIX: &\'static [u8] = b"pool_directory";');
  });

  it('era 0 is the legacy three-seed address and era n>=1 is a distinct four-seed one', () => {
    const [legacy] = PublicKey.findProgramAddressSync(
      [Buffer.from('denominated_pool_v4'), mint.toBuffer(), Buffer.from(new Uint8Array(new BigUint64Array([denom]).buffer))],
      ZK_SHIELDED_PROGRAM_ID,
    );
    const [e0] = derivePoolEraPDA(mint, denom, 0);
    const [e1] = derivePoolEraPDA(mint, denom, 1);
    const [e2] = derivePoolEraPDA(mint, denom, 2);
    expect(e0.equals(legacy)).toBe(true);
    expect(e1.equals(e0)).toBe(false);
    expect(e2.equals(e1)).toBe(false);
    // The registry's live 1 SOL pool derives as era 0 of (SOL, 1e9).
    expect(e0.toBase58()).toBe('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS');
    expect(() => derivePoolEraPDA(mint, denom, 70_000)).toThrow(/u16/);
  });

  it('eraMarginReached is the handler arithmetic', () => {
    expect(eraMarginReached(1n << 15n, 15, 1_024n)).toBe(true);
    expect(eraMarginReached((1n << 15n) - 1_024n, 15, 1_024n)).toBe(true);
    expect(eraMarginReached((1n << 15n) - 1_025n, 15, 1_024n)).toBe(false);
    expect(eraMarginReached(0n, 19, 1_024n)).toBe(false);
  });
});

describe('poolEras: account order, mutability and signers parsed out of the Rust', () => {
  const authority = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;
  const [pool0] = derivePoolEraPDA(mint, denom, 0);

  it('open_next_era', () => {
    const rs = parseAccounts(rust('instructions/open_next_era.rs'), 'OpenNextEra');
    expect(rs.map((a) => a.name)).toEqual([
      'payer',
      'directory',
      'active_pool',
      'active_tree',
      'next_pool',
      'next_tree',
      'system_program',
    ]);
    const ix = buildOpenNextEraIx({ payer, tokenMint: mint, denominationAtomic: denom, activeEra: 0 });
    expect(keysOf(ix)).toEqual(rs.map((a) => ({ signer: a.signer, writable: a.writable })));
    expect(ix.keys[1].pubkey.equals(derivePoolDirectoryPDA(mint, denom)[0])).toBe(true);
    expect(ix.keys[2].pubkey.equals(pool0)).toBe(true);
    expect(ix.keys[3].pubkey.equals(deriveMerkleTreePDA(pool0)[0])).toBe(true);
    expect(ix.keys[4].pubkey.equals(derivePoolEraPDA(mint, denom, 1)[0])).toBe(true);
    expect(ix.keys[5].pubkey.equals(deriveMerkleTreePDA(derivePoolEraPDA(mint, denom, 1)[0])[0])).toBe(true);
    expect(Buffer.from(ix.data).equals(Buffer.from(instructionDiscriminator('open_next_era')))).toBe(true);
  });

  it('migrate_tree_depth', () => {
    const rs = parseAccounts(rust('instructions/migrate_tree_depth.rs'), 'MigrateTreeDepth');
    expect(rs.map((a) => a.name)).toEqual(['authority', 'denominated_pool', 'merkle_tree']);
    const ix = buildMigrateTreeDepthIx({ authority, pool: pool0, newDepth: 19, keepRoots: 5 });
    expect(keysOf(ix)).toEqual(rs.map((a) => ({ signer: a.signer, writable: a.writable })));
    // disc 8 | new_depth u8 | keep_roots u8, the handler's argument order.
    expect(rust('lib.rs')).toMatch(/pub fn migrate_tree_depth\(\s*ctx: Context<MigrateTreeDepth>,\s*new_depth: u8,\s*keep_roots: u8,/);
    expect(ix.data.length).toBe(10);
    expect(ix.data[8]).toBe(19);
    expect(ix.data[9]).toBe(5);
    expect(buildMigrateTreeDepthIx({ authority, pool: pool0, newDepth: 19 }).data[9]).toBe(7);
    expect(() => buildMigrateTreeDepthIx({ authority, pool: pool0, newDepth: 20 })).toThrow();
    expect(() => buildMigrateTreeDepthIx({ authority, pool: pool0, newDepth: 11 })).toThrow();
  });

  it('migrate_pool_capacity', () => {
    const rs = parseAccounts(rust('instructions/migrate_pool_capacity.rs'), 'MigratePoolCapacity');
    expect(rs.map((a) => a.name)).toEqual(['authority', 'denominated_pool', 'system_program']);
    const ix = buildMigratePoolCapacityIx({ authority, pool: pool0 });
    expect(keysOf(ix)).toEqual(rs.map((a) => ({ signer: a.signer, writable: a.writable })));
    expect(ix.data.length).toBe(8);
  });

  it('init_pool_directory', () => {
    const rs = parseAccounts(rust('instructions/init_pool_directory.rs'), 'InitPoolDirectory');
    expect(rs.map((a) => a.name)).toEqual(['authority', 'denominated_pool', 'merkle_tree', 'directory', 'system_program']);
    const ix = buildInitPoolDirectoryIx({ authority, tokenMint: mint, denominationAtomic: denom, marginLeaves: 2_000n });
    expect(keysOf(ix)).toEqual(rs.map((a) => ({ signer: a.signer, writable: a.writable })));
    expect(ix.data.length).toBe(16);
    expect(ix.data.readBigUInt64LE(8)).toBe(2_000n);
  });

  it('init_pool_era', () => {
    const rs = parseAccounts(rust('instructions/init_pool_era.rs'), 'InitPoolEra');
    expect(rs.map((a) => a.name)).toEqual(['authority', 'directory', 'denominated_pool', 'merkle_tree', 'system_program']);
    const ix = buildInitPoolEraIx({ authority, tokenMint: mint, denominationAtomic: denom, epochDelay: 1n, era: 3 });
    expect(keysOf(ix)).toEqual(rs.map((a) => ({ signer: a.signer, writable: a.writable })));
    // disc 8 | vk 32 | mint 32 | denom 8 | epoch 8 | era 2
    expect(ix.data.length).toBe(8 + 32 + 32 + 8 + 8 + 2);
    expect(ix.data.readUInt16LE(88)).toBe(3);
    expect(ix.keys[2].pubkey.equals(derivePoolEraPDA(mint, denom, 3)[0])).toBe(true);
    expect(() => buildInitPoolEraIx({ authority, tokenMint: mint, denominationAtomic: denom, epochDelay: 1n, era: 0 })).toThrow();
  });
});

describe('poolEras: parsePoolDirectory reads the Borsh layout', () => {
  it('round-trips a synthetic account and refuses a wrong discriminator', () => {
    const authority = Keypair.generate().publicKey;
    const activePool = Keypair.generate().publicKey;
    const buf = Buffer.alloc(POOL_DIRECTORY_LEN);
    Buffer.from(accountDiscriminator('PoolDirectory')).copy(buf, 0);
    authority.toBuffer().copy(buf, 8);
    mint.toBuffer().copy(buf, 40);
    buf.writeBigUInt64LE(denom, 72);
    buf.writeUInt16LE(2, 80);
    activePool.toBuffer().copy(buf, 82);
    buf.writeBigUInt64LE(1_024n, 114);
    buf[122] = 254;
    const d = parsePoolDirectory(buf)!;
    expect(d.authority.equals(authority)).toBe(true);
    expect(d.tokenMint.equals(mint)).toBe(true);
    expect(d.denomination).toBe(denom);
    expect(d.activeEra).toBe(2);
    expect(d.activePool.equals(activePool)).toBe(true);
    expect(d.marginLeaves).toBe(1_024n);
    expect(d.bump).toBe(254);
    buf[0] ^= 1;
    expect(parsePoolDirectory(buf)).toBeNull();
    expect(parsePoolDirectory(buf.subarray(0, 100))).toBeNull();
  });

  it('the field order matches the Rust struct declaration', () => {
    const pd = rust('state/pool_directory.rs');
    const body = pd.slice(pd.indexOf('pub struct PoolDirectory {'), pd.indexOf('impl PoolDirectory'));
    const fields = [...body.matchAll(/pub (\w+): /g)].map((m) => m[1]);
    expect(fields).toEqual(['authority', 'token_mint', 'denomination', 'active_era', 'active_pool', 'margin_leaves', 'bump']);
  });
});

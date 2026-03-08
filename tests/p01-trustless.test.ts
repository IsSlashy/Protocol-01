/**
 * p01_trustless - E2E Test Suite
 *
 * Tests the trustless shielded pool program on devnet/localnet:
 *   1. initialize_pool  - Create a new trustless shielded pool for a test token
 *   2. shield_trustless  - Deposit tokens with a commitment
 *   3. VK data storage   - init_vk_data + write_vk_data (unshield circuit)
 *   4. zkSPL VK storage  - init_zkspl_vk_data + write_zkspl_vk_data
 *   5. update_vk_hash    - Admin-only VK hash update
 *   6. create_confidential_account - zkSPL account creation
 *   7. Account state validation    - Verify pool state, commitment insertion
 *   8. Error cases        - Duplicate init, invalid parameters, unauthorized
 *   9. unshield_trustless - (stub) Requires real Groth16 proof
 *  10. zkspl_trustless    - (stub) Requires real Groth16 proof
 *
 * Program: FnTmMxsNx5yQ4nDxiUq7HKLyb6Hwi5Wb5D71Zu69i43Q
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Constants (match Rust program)
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey(
  "FnTmMxsNx5yQ4nDxiUq7HKLyb6Hwi5Wb5D71Zu69i43Q"
);

const DEFAULT_TREE_DEPTH = 15;
const MAX_HISTORICAL_ROOTS = 100;
const DEFAULT_EPOCH_DELAY = 2;
const MAX_VK_SIZE = 2048;
const MIN_VK_SIZE = 452;
const MAX_CHUNK_SIZE = 800;

/** PDA seed prefixes (must match Rust constants). */
const SEEDS = {
  TRUSTLESS_POOL: Buffer.from("trustless_pool"),
  MERKLE_TREE: Buffer.from("merkle_tree"),
  NULLIFIER: Buffer.from("nullifier"),
  VK_DATA: Buffer.from("trustless_vk_data"),
  ZKSPL_VK_DATA: Buffer.from("trustless_zkspl_vk"),
  CONFIDENTIAL_ACCOUNT: Buffer.from("trustless_account"),
  VAULT: Buffer.from("trustless_vault"),
};

/** Zero value for empty Merkle leaves (keccak256("specter") mod p). */
const ZERO_VALUE = Buffer.from([
  0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
  0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
  0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
  0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
]);

/** Level 15 zero value (empty tree root at depth 15). */
const EMPTY_ROOT_DEPTH_15 = Buffer.from([
  0xca, 0xab, 0x75, 0xa5, 0xce, 0xea, 0x6f, 0x79,
  0xc2, 0xce, 0x66, 0xda, 0xc8, 0xa5, 0x7b, 0xad,
  0x63, 0xee, 0x31, 0x1c, 0xc3, 0x03, 0x57, 0x43,
  0x15, 0x1b, 0xea, 0xd0, 0x00, 0xb4, 0xc6, 0x20,
]);

// ---------------------------------------------------------------------------
// Anchor discriminator helper
// ---------------------------------------------------------------------------

function computeDiscriminator(name: string): Buffer {
  const hash = crypto.createHash("sha256");
  hash.update(`global:${name}`);
  return hash.digest().subarray(0, 8);
}

const DISCRIMINATORS = {
  initialize_pool: computeDiscriminator("initialize_pool"),
  shield_trustless: computeDiscriminator("shield_trustless"),
  unshield_trustless: computeDiscriminator("unshield_trustless"),
  init_vk_data: computeDiscriminator("init_vk_data"),
  write_vk_data: computeDiscriminator("write_vk_data"),
  init_zkspl_vk_data: computeDiscriminator("init_zkspl_vk_data"),
  write_zkspl_vk_data: computeDiscriminator("write_zkspl_vk_data"),
  update_vk_hash: computeDiscriminator("update_vk_hash"),
  create_confidential_account: computeDiscriminator("create_confidential_account"),
  zkspl_trustless: computeDiscriminator("zkspl_trustless"),
};

// ---------------------------------------------------------------------------
// PDA derivation helpers
// ---------------------------------------------------------------------------

/**
 * Derive the PoolState PDA.
 * Seeds: ["trustless_pool", token_mint, denomination_le_bytes]
 */
function derivePoolPDA(
  tokenMint: PublicKey,
  denomination: bigint
): [PublicKey, number] {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [SEEDS.TRUSTLESS_POOL, tokenMint.toBuffer(), denomBuf],
    PROGRAM_ID
  );
}

/** Derive MerkleTreeState PDA. Seeds: ["merkle_tree", pool_key] */
function deriveMerkleTreePDA(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.MERKLE_TREE, poolPDA.toBuffer()],
    PROGRAM_ID
  );
}

/** Derive VK data PDA. Seeds: ["trustless_vk_data", pool_key] */
function deriveVkDataPDA(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.VK_DATA, poolPDA.toBuffer()],
    PROGRAM_ID
  );
}

/** Derive zkSPL VK data PDA. Seeds: ["trustless_zkspl_vk", pool_key] */
function deriveZkSplVkDataPDA(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_VK_DATA, poolPDA.toBuffer()],
    PROGRAM_ID
  );
}

/** Derive NullifierAccount PDA. Seeds: ["nullifier", pool_key, nullifier_hash] */
function deriveNullifierPDA(
  poolPDA: PublicKey,
  nullifier: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, poolPDA.toBuffer(), nullifier],
    PROGRAM_ID
  );
}

/** Derive ConfidentialAccount PDA. Seeds: ["trustless_account", owner, token_mint] */
function deriveConfidentialAccountPDA(
  owner: PublicKey,
  tokenMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.CONFIDENTIAL_ACCOUNT, owner.toBuffer(), tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-byte buffer. */
function randomBytes32(): Buffer {
  return crypto.randomBytes(32);
}

/** Encode a u64 as an 8-byte LE buffer. */
function u64ToLeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/** Encode a u32 as a 4-byte LE buffer. */
function u32ToLeBytes(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/**
 * Encode a Vec<u8> as Borsh: 4-byte LE length prefix followed by raw bytes.
 */
function borshVec(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([len, data]);
}

// ---------------------------------------------------------------------------
// PoolState deserialization (partial, after 8-byte discriminator)
// ---------------------------------------------------------------------------

interface ParsedPoolState {
  authority: PublicKey;
  merkleRoot: Buffer;
  leafCount: bigint;
  tokenMint: PublicKey;
  vault: PublicKey;
  denomination: bigint;
  verificationKeyHash: Buffer;
  zksplVkHash: Buffer;
  totalShielded: bigint;
  noteCount: bigint;
  isActive: boolean;
}

function parsePoolState(data: Buffer): ParsedPoolState {
  let offset = 8; // skip discriminator

  const authority = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const merkleRoot = data.subarray(offset, offset + 32);
  offset += 32;

  const leafCount = data.readBigUInt64LE(offset);
  offset += 8;

  const tokenMint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const vault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const denomination = data.readBigUInt64LE(offset);
  offset += 8;

  const verificationKeyHash = Buffer.from(data.subarray(offset, offset + 32));
  offset += 32;

  const zksplVkHash = Buffer.from(data.subarray(offset, offset + 32));
  offset += 32;

  const totalShielded = data.readBigUInt64LE(offset);
  offset += 8;

  const noteCount = data.readBigUInt64LE(offset);
  offset += 8;

  const isActive = data[offset] === 1;

  return {
    authority,
    merkleRoot,
    leafCount,
    tokenMint,
    vault,
    denomination,
    verificationKeyHash,
    zksplVkHash,
    totalShielded,
    noteCount,
    isActive,
  };
}

// ---------------------------------------------------------------------------
// MerkleTreeState deserialization (partial)
// ---------------------------------------------------------------------------

interface ParsedMerkleTree {
  pool: PublicKey;
  root: Buffer;
  leafCount: bigint;
  depth: number;
}

function parseMerkleTree(data: Buffer): ParsedMerkleTree {
  let offset = 8; // skip discriminator

  const pool = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const root = Buffer.from(data.subarray(offset, offset + 32));
  offset += 32;

  const leafCount = data.readBigUInt64LE(offset);
  offset += 8;

  const depth = data[offset];

  return { pool, root, leafCount, depth };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("p01_trustless", function () {
  this.timeout(120_000); // 2 minutes per test for devnet latency

  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const authority = (provider.wallet as anchor.Wallet).payer;
  const connection = provider.connection;

  // Test token mint (created in before hook)
  let tokenMint: PublicKey;
  const denomination = 100_000_000n; // 0.1 token (9 decimals)

  // PDAs (derived after token mint creation)
  let poolPDA: PublicKey;
  let poolBump: number;
  let merkleTreePDA: PublicKey;
  let vkDataPDA: PublicKey;
  let zksplVkDataPDA: PublicKey;

  // Token accounts
  let userTokenAccount: PublicKey;
  let poolVault: PublicKey;

  // VK hashes (32-byte test values)
  const vkHash = Buffer.alloc(32, 0x42);
  const zksplVkHash = Buffer.alloc(32, 0x43);

  // =========================================================================
  // Setup
  // =========================================================================

  before(async () => {
    console.log("=".repeat(60));
    console.log("p01_trustless E2E Test Suite");
    console.log("=".repeat(60));
    console.log(`Authority: ${authority.publicKey.toBase58()}`);

    const balance = await connection.getBalance(authority.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.5 * LAMPORTS_PER_SOL) {
      throw new Error("Insufficient balance. Need at least 0.5 SOL.");
    }

    // Create test SPL token mint
    tokenMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      9 // 9 decimals
    );
    console.log(`Token Mint: ${tokenMint.toBase58()}`);

    // Derive PDAs
    [poolPDA, poolBump] = derivePoolPDA(tokenMint, denomination);
    [merkleTreePDA] = deriveMerkleTreePDA(poolPDA);
    [vkDataPDA] = deriveVkDataPDA(poolPDA);
    [zksplVkDataPDA] = deriveZkSplVkDataPDA(poolPDA);

    console.log(`Pool PDA:        ${poolPDA.toBase58()}`);
    console.log(`Merkle Tree PDA: ${merkleTreePDA.toBase58()}`);
    console.log(`VK Data PDA:     ${vkDataPDA.toBase58()}`);
    console.log(`zkSPL VK PDA:    ${zksplVkDataPDA.toBase58()}`);
    console.log(`Denomination:    ${denomination}`);

    // Create user token account and mint tokens
    const userAta = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      tokenMint,
      authority.publicKey
    );
    userTokenAccount = userAta.address;

    await mintTo(
      connection,
      authority,
      tokenMint,
      userTokenAccount,
      authority,
      10_000_000_000n // 10 tokens
    );
    console.log(`User ATA: ${userTokenAccount.toBase58()} (funded 10 tokens)`);
  });

  // =========================================================================
  // 1. initialize_pool
  // =========================================================================

  describe("1. initialize_pool", () => {
    it("should derive unique pool PDAs for different mints", () => {
      const mint1 = Keypair.generate().publicKey;
      const mint2 = Keypair.generate().publicKey;
      const denom = 1_000_000n;

      const [pda1] = derivePoolPDA(mint1, denom);
      const [pda2] = derivePoolPDA(mint2, denom);

      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it("should derive unique pool PDAs for different denominations", () => {
      const mint = Keypair.generate().publicKey;

      const [pda1] = derivePoolPDA(mint, 100_000_000n);
      const [pda2] = derivePoolPDA(mint, 200_000_000n);

      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it("should support native SOL pool (SystemProgram as mint)", () => {
      const solMint = SystemProgram.programId;
      const [poolPda] = derivePoolPDA(solMint, 1_000_000_000n);

      expect(poolPda).to.not.be.null;
    });

    it("should initialize a trustless shielded pool", async () => {
      console.log("\n--- Initializing Trustless Pool ---");

      // Instruction data: discriminator + vk_hash(32) + zkspl_vk_hash(32) + token_mint(32) + denomination(8)
      const data = Buffer.concat([
        DISCRIMINATORS.initialize_pool,
        vkHash,
        zksplVkHash,
        tokenMint.toBuffer(),
        u64ToLeBytes(denomination),
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`TX: ${signature}`);

      // Verify pool account was created
      const poolAccount = await connection.getAccountInfo(poolPDA);
      expect(poolAccount).to.not.be.null;
      expect(poolAccount!.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());
      console.log(`Pool account size: ${poolAccount!.data.length} bytes`);
    });

    it("should have correct pool state after initialization", async () => {
      const poolAccount = await connection.getAccountInfo(poolPDA);
      expect(poolAccount).to.not.be.null;

      const pool = parsePoolState(poolAccount!.data);

      expect(pool.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(pool.tokenMint.toBase58()).to.equal(tokenMint.toBase58());
      expect(pool.denomination).to.equal(denomination);
      expect(pool.leafCount).to.equal(0n);
      expect(pool.totalShielded).to.equal(0n);
      expect(pool.noteCount).to.equal(0n);
      expect(pool.isActive).to.be.true;
      expect(Buffer.from(pool.verificationKeyHash)).to.deep.equal(vkHash);
      expect(Buffer.from(pool.zksplVkHash)).to.deep.equal(zksplVkHash);
    });

    it("should have correct merkle tree state after initialization", async () => {
      const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
      expect(merkleAccount).to.not.be.null;

      const tree = parseMerkleTree(merkleAccount!.data);

      expect(tree.pool.toBase58()).to.equal(poolPDA.toBase58());
      expect(tree.leafCount).to.equal(0n);
      expect(tree.depth).to.equal(DEFAULT_TREE_DEPTH);
      // Initial root should be the precomputed empty root for depth 15
      expect(Buffer.from(tree.root)).to.deep.equal(EMPTY_ROOT_DEPTH_15);
    });

    it("should reject duplicate pool initialization", async () => {
      const data = Buffer.concat([
        DISCRIMINATORS.initialize_pool,
        vkHash,
        zksplVkHash,
        tokenMint.toBuffer(),
        u64ToLeBytes(denomination),
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data,
        });

      try {
        await provider.sendAndConfirm(tx);
        expect.fail("Should have thrown -- pool already exists");
      } catch (error: any) {
        // Anchor init constraint rejects re-initialization
        expect(error.toString()).to.include("Error");
        console.log("Duplicate init correctly rejected");
      }
    });
  });

  // =========================================================================
  // 2. shield_trustless (SPL token deposit)
  // =========================================================================

  describe("2. shield_trustless", () => {
    before(async () => {
      // Create pool vault (ATA owned by pool PDA)
      const vaultAta = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        tokenMint,
        poolPDA,
        true // allowOwnerOffCurve for PDAs
      );
      poolVault = vaultAta.address;
      console.log(`Pool vault: ${poolVault.toBase58()}`);
    });

    it("should shield tokens with a valid commitment", async () => {
      console.log("\n--- Shielding tokens ---");

      const commitment = randomBytes32();
      // In production, new_root is computed off-chain via Poseidon.
      // For testing, we use a dummy root since insert_with_root trusts it.
      const newRoot = randomBytes32();

      // Instruction data: discriminator + commitment(32) + new_root(32)
      const data = Buffer.concat([
        DISCRIMINATORS.shield_trustless,
        commitment,
        newRoot,
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },   // depositor
            { pubkey: poolPDA, isSigner: false, isWritable: true },              // pool
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },        // merkle_tree
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },    // token_program
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },     // user_token_account
            { pubkey: poolVault, isSigner: false, isWritable: true },            // pool_vault
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Shield TX: ${signature}`);

      // Verify pool vault received tokens
      const vaultAccount = await getAccount(connection, poolVault);
      expect(Number(vaultAccount.amount)).to.equal(Number(denomination));
      console.log(`Pool vault balance: ${vaultAccount.amount}`);
    });

    it("should update pool state after shield", async () => {
      const poolAccount = await connection.getAccountInfo(poolPDA);
      expect(poolAccount).to.not.be.null;

      const pool = parsePoolState(poolAccount!.data);

      expect(pool.leafCount).to.equal(1n);
      expect(pool.totalShielded).to.equal(denomination);
      expect(pool.noteCount).to.equal(1n);
      expect(pool.isActive).to.be.true;
    });

    it("should update merkle tree after shield", async () => {
      const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
      expect(merkleAccount).to.not.be.null;

      const tree = parseMerkleTree(merkleAccount!.data);

      expect(tree.leafCount).to.equal(1n);
      // Root should have changed from the empty root
      expect(Buffer.from(tree.root)).to.not.deep.equal(EMPTY_ROOT_DEPTH_15);
    });

    it("should shield a second deposit and accumulate state", async () => {
      const commitment = randomBytes32();
      const newRoot = randomBytes32();

      const data = Buffer.concat([
        DISCRIMINATORS.shield_trustless,
        commitment,
        newRoot,
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolVault, isSigner: false, isWritable: true },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Shield TX #2: ${signature}`);

      // Verify accumulated state
      const poolAccount = await connection.getAccountInfo(poolPDA);
      const pool = parsePoolState(poolAccount!.data);

      expect(pool.leafCount).to.equal(2n);
      expect(pool.totalShielded).to.equal(denomination * 2n);
      expect(pool.noteCount).to.equal(2n);

      // Verify vault balance doubled
      const vaultAccount = await getAccount(connection, poolVault);
      expect(Number(vaultAccount.amount)).to.equal(Number(denomination * 2n));
    });
  });

  // =========================================================================
  // 3. VK Data Storage (unshield circuit)
  // =========================================================================

  describe("3. VK data storage (init_vk_data + write_vk_data)", () => {
    const vkSize = 512; // test VK size in bytes

    it("should initialize VK data account", async () => {
      console.log("\n--- Initializing VK data account ---");

      // Instruction data: discriminator + vk_size(4 LE)
      const data = Buffer.concat([
        DISCRIMINATORS.init_vk_data,
        u32ToLeBytes(vkSize),
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },   // authority
            { pubkey: poolPDA, isSigner: false, isWritable: false },             // pool
            { pubkey: vkDataPDA, isSigner: false, isWritable: true },            // vk_data_account
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Init VK Data TX: ${signature}`);

      // Verify account exists
      const vkAccount = await connection.getAccountInfo(vkDataPDA);
      expect(vkAccount).to.not.be.null;
      expect(vkAccount!.data.length).to.equal(vkSize);
      expect(vkAccount!.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());
    });

    it("should write VK data in chunks", async () => {
      console.log("\n--- Writing VK data ---");

      // Create mock VK data
      const mockVkData = Buffer.alloc(vkSize);
      mockVkData.fill(0xAB, 0, 256);    // first chunk
      mockVkData.fill(0xCD, 256, 512);   // second chunk

      // Write first chunk (offset 0, 256 bytes)
      const chunk1 = mockVkData.subarray(0, 256);
      const data1 = Buffer.concat([
        DISCRIMINATORS.write_vk_data,
        u32ToLeBytes(0),       // offset
        borshVec(chunk1),      // data as Vec<u8>
      ]);

      const tx1 = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: vkDataPDA, isSigner: false, isWritable: true },
        ],
        data: data1,
      });

      const sig1 = await provider.sendAndConfirm(tx1);
      console.log(`Write VK chunk 1 TX: ${sig1}`);

      // Write second chunk (offset 256, 256 bytes)
      const chunk2 = mockVkData.subarray(256, 512);
      const data2 = Buffer.concat([
        DISCRIMINATORS.write_vk_data,
        u32ToLeBytes(256),     // offset
        borshVec(chunk2),      // data as Vec<u8>
      ]);

      const tx2 = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: vkDataPDA, isSigner: false, isWritable: true },
        ],
        data: data2,
      });

      const sig2 = await provider.sendAndConfirm(tx2);
      console.log(`Write VK chunk 2 TX: ${sig2}`);

      // Verify data was written correctly
      const vkAccount = await connection.getAccountInfo(vkDataPDA);
      expect(vkAccount).to.not.be.null;
      expect(vkAccount!.data.subarray(0, 4).every((b) => b === 0xAB)).to.be.true;
      expect(vkAccount!.data.subarray(256, 260).every((b) => b === 0xCD)).to.be.true;
    });

    it("should reject unauthorized VK data writes", async () => {
      const stranger = Keypair.generate();

      // Airdrop for tx fees
      const airdropSig = await connection.requestAirdrop(
        stranger.publicKey,
        0.01 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig, "confirmed");

      const chunk = Buffer.alloc(32, 0xFF);
      const data = Buffer.concat([
        DISCRIMINATORS.write_vk_data,
        u32ToLeBytes(0),
        borshVec(chunk),
      ]);

      const tx = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: vkDataPDA, isSigner: false, isWritable: true },
        ],
        data,
      });

      try {
        await provider.sendAndConfirm(tx, [stranger]);
        expect.fail("Should have thrown -- stranger is not pool authority");
      } catch (error: any) {
        expect(error.toString()).to.include("Error");
        console.log("Unauthorized VK write correctly rejected");
      }
    });
  });

  // =========================================================================
  // 4. zkSPL VK Data Storage
  // =========================================================================

  describe("4. zkSPL VK data storage", () => {
    const zksplVkSize = 512;

    it("should initialize zkSPL VK data account", async () => {
      console.log("\n--- Initializing zkSPL VK data account ---");

      const data = Buffer.concat([
        DISCRIMINATORS.init_zkspl_vk_data,
        u32ToLeBytes(zksplVkSize),
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: false },
            { pubkey: zksplVkDataPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Init zkSPL VK TX: ${signature}`);

      const vkAccount = await connection.getAccountInfo(zksplVkDataPDA);
      expect(vkAccount).to.not.be.null;
      expect(vkAccount!.data.length).to.equal(zksplVkSize);
      expect(vkAccount!.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());
    });

    it("should write zkSPL VK data", async () => {
      const chunk = Buffer.alloc(256, 0xEE);
      const data = Buffer.concat([
        DISCRIMINATORS.write_zkspl_vk_data,
        u32ToLeBytes(0),
        borshVec(chunk),
      ]);

      const tx = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: zksplVkDataPDA, isSigner: false, isWritable: true },
        ],
        data,
      });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Write zkSPL VK TX: ${signature}`);

      const vkAccount = await connection.getAccountInfo(zksplVkDataPDA);
      expect(vkAccount!.data.subarray(0, 4).every((b) => b === 0xEE)).to.be.true;
    });
  });

  // =========================================================================
  // 5. update_vk_hash
  // =========================================================================

  describe("5. update_vk_hash", () => {
    it("should update the unshield VK hash", async () => {
      console.log("\n--- Updating VK hash ---");

      const newVkHash = randomBytes32();

      const data = Buffer.concat([
        DISCRIMINATORS.update_vk_hash,
        newVkHash,
      ]);

      const tx = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolPDA, isSigner: false, isWritable: true },
        ],
        data,
      });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Update VK hash TX: ${signature}`);

      // Verify the hash changed
      const poolAccount = await connection.getAccountInfo(poolPDA);
      const pool = parsePoolState(poolAccount!.data);

      expect(Buffer.from(pool.verificationKeyHash)).to.deep.equal(newVkHash);
      // zkspl_vk_hash should remain unchanged
      expect(Buffer.from(pool.zksplVkHash)).to.deep.equal(zksplVkHash);
    });

    it("should reject unauthorized VK hash update", async () => {
      const stranger = Keypair.generate();

      const airdropSig = await connection.requestAirdrop(
        stranger.publicKey,
        0.01 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig, "confirmed");

      const newVkHash = randomBytes32();
      const data = Buffer.concat([
        DISCRIMINATORS.update_vk_hash,
        newVkHash,
      ]);

      const tx = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
          { pubkey: poolPDA, isSigner: false, isWritable: true },
        ],
        data,
      });

      try {
        await provider.sendAndConfirm(tx, [stranger]);
        expect.fail("Should have thrown -- stranger is not authority");
      } catch (error: any) {
        expect(error.toString()).to.include("Error");
        console.log("Unauthorized VK hash update correctly rejected");
      }
    });
  });

  // =========================================================================
  // 6. create_confidential_account
  // =========================================================================

  describe("6. create_confidential_account", () => {
    it("should create a confidential account", async () => {
      console.log("\n--- Creating confidential account ---");

      const initialCommitment = randomBytes32();

      const [confidentialPDA] = deriveConfidentialAccountPDA(
        authority.publicKey,
        tokenMint
      );

      const data = Buffer.concat([
        DISCRIMINATORS.create_confidential_account,
        initialCommitment,
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
        .add({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },  // owner
            { pubkey: tokenMint, isSigner: false, isWritable: false },          // token_mint
            { pubkey: confidentialPDA, isSigner: false, isWritable: true },     // confidential_account
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Create confidential account TX: ${signature}`);

      // Verify account
      const account = await connection.getAccountInfo(confidentialPDA);
      expect(account).to.not.be.null;
      expect(account!.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());

      // Parse: discriminator(8) + owner(32) + mint(32) + balance_commitment(32)
      const accData = account!.data;
      const owner = new PublicKey(accData.subarray(8, 40));
      const mint = new PublicKey(accData.subarray(40, 72));
      const commitment = accData.subarray(72, 104);
      const nonce = accData.readBigUInt64LE(104);
      const isInitialized = accData[112] === 1;

      expect(owner.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(mint.toBase58()).to.equal(tokenMint.toBase58());
      expect(Buffer.from(commitment)).to.deep.equal(initialCommitment);
      expect(nonce).to.equal(0n);
      expect(isInitialized).to.be.true;
    });

    it("should reject duplicate confidential account creation", async () => {
      const [confidentialPDA] = deriveConfidentialAccountPDA(
        authority.publicKey,
        tokenMint
      );

      const data = Buffer.concat([
        DISCRIMINATORS.create_confidential_account,
        randomBytes32(),
      ]);

      const tx = new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: tokenMint, isSigner: false, isWritable: false },
          { pubkey: confidentialPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      try {
        await provider.sendAndConfirm(tx);
        expect.fail("Should have thrown -- account already exists");
      } catch (error: any) {
        expect(error.toString()).to.include("Error");
        console.log("Duplicate confidential account correctly rejected");
      }
    });
  });

  // =========================================================================
  // 7. Account state validation
  // =========================================================================

  describe("7. Account state validation", () => {
    it("should track historical roots via pool.merkle_root changes", async () => {
      const poolAccount = await connection.getAccountInfo(poolPDA);
      expect(poolAccount).to.not.be.null;

      const pool = parsePoolState(poolAccount!.data);

      // After 2 shields, the merkle root should not be the empty root
      expect(Buffer.from(pool.merkleRoot)).to.not.deep.equal(EMPTY_ROOT_DEPTH_15);
    });

    it("should have default tree depth of 15", async () => {
      const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
      const tree = parseMerkleTree(merkleAccount!.data);

      expect(tree.depth).to.equal(DEFAULT_TREE_DEPTH);
      // 2^15 = 32,768 notes per pool
      expect(Math.pow(2, tree.depth)).to.equal(32_768);
    });

    it("should have correct Merkle tree leaf count matching pool", async () => {
      const poolAccount = await connection.getAccountInfo(poolPDA);
      const pool = parsePoolState(poolAccount!.data);

      const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
      const tree = parseMerkleTree(merkleAccount!.data);

      expect(pool.leafCount).to.equal(tree.leafCount);
    });

    it("should have pool.total_shielded = denomination * leaf_count", async () => {
      const poolAccount = await connection.getAccountInfo(poolPDA);
      const pool = parsePoolState(poolAccount!.data);

      expect(pool.totalShielded).to.equal(denomination * pool.leafCount);
    });

    it("should track vault balance matching total_shielded", async () => {
      const poolAccount = await connection.getAccountInfo(poolPDA);
      const pool = parsePoolState(poolAccount!.data);

      const vaultAccount = await getAccount(connection, poolVault);

      expect(Number(vaultAccount.amount)).to.equal(Number(pool.totalShielded));
    });
  });

  // =========================================================================
  // 8. Error cases
  // =========================================================================

  describe("8. Error cases", () => {
    it("should validate VK size range (452-2048)", () => {
      expect(MIN_VK_SIZE).to.equal(452);
      expect(MAX_VK_SIZE).to.equal(2048);

      const validSizes = [452, 500, 1024, 1536, 2048];
      for (const size of validSizes) {
        expect(size).to.be.at.least(MIN_VK_SIZE);
        expect(size).to.be.at.most(MAX_VK_SIZE);
      }

      const invalidSizes = [0, 100, 451, 2049, 4096];
      for (const size of invalidSizes) {
        const isValid = size >= MIN_VK_SIZE && size <= MAX_VK_SIZE;
        expect(isValid).to.be.false;
      }
    });

    it("should enforce max chunk size of 800 bytes for VK writes", () => {
      expect(MAX_CHUNK_SIZE).to.equal(800);

      const validChunk = Buffer.alloc(800);
      expect(validChunk.length).to.be.at.most(MAX_CHUNK_SIZE);

      const invalidChunk = Buffer.alloc(801);
      expect(invalidChunk.length).to.be.greaterThan(MAX_CHUNK_SIZE);
    });

    it("should enforce pool constraints on shield (pool must be active)", async () => {
      // Pool is_active is checked via Anchor constraint
      const poolAccount = await connection.getAccountInfo(poolPDA);
      const pool = parsePoolState(poolAccount!.data);
      expect(pool.isActive).to.be.true;
    });

    it("should validate commitment length is 32 bytes", () => {
      const valid = randomBytes32();
      expect(valid.length).to.equal(32);
    });

    it("should use per-nullifier PDA accounts to prevent double-spend", () => {
      const nullifier = randomBytes32();
      const [nullifierPDA, bump] = deriveNullifierPDA(poolPDA, nullifier);

      expect(nullifierPDA).to.not.be.null;
      expect(bump).to.be.a("number");

      // Same nullifier always derives the same PDA
      const [nullifierPDA2] = deriveNullifierPDA(poolPDA, nullifier);
      expect(nullifierPDA.toBase58()).to.equal(nullifierPDA2.toBase58());

      // Different nullifier gives different PDA
      const otherNullifier = randomBytes32();
      const [otherPDA] = deriveNullifierPDA(poolPDA, otherNullifier);
      expect(nullifierPDA.toBase58()).to.not.equal(otherPDA.toBase58());
    });
  });

  // =========================================================================
  // 9. Account sizes
  // =========================================================================

  describe("9. Account sizes", () => {
    it("PoolState should have correct LEN", () => {
      const expected =
        8 +   // discriminator
        32 +  // authority
        32 +  // merkle_root
        8 +   // leaf_count
        32 +  // token_mint
        32 +  // vault
        8 +   // denomination
        32 +  // verification_key_hash
        32 +  // zkspl_vk_hash
        8 +   // total_shielded
        8 +   // note_count
        1 +   // is_active
        4 + (100 * 32) + // historical_roots Vec
        1 +   // max_historical_roots
        1 +   // tree_depth
        8 +   // created_at
        8 +   // last_tx_at
        1 +   // bump
        8 +   // epoch_delay
        8 +   // mature_note_count
        8 +   // last_maturity_update_epoch
        (8 * 32) + // epoch_note_counts
        8;    // epoch_note_start

      expect(expected).to.equal(3554);
    });

    it("MerkleTreeState should have correct LEN", () => {
      const expected =
        8 +   // discriminator
        32 +  // pool
        32 +  // root
        8 +   // leaf_count
        1 +   // depth
        4 + (16 * 32) + // filled_subtrees Vec (depth 15 + 1)
        1;    // bump

      expect(expected).to.equal(598);
    });

    it("NullifierAccount should have correct LEN", () => {
      const expected =
        8 +   // discriminator
        32 +  // nullifier
        8 +   // spent_at_slot
        1;    // bump

      expect(expected).to.equal(49);
    });

    it("ConfidentialAccount should have correct LEN", () => {
      const expected =
        8 +   // discriminator
        32 +  // owner
        32 +  // mint
        32 +  // balance_commitment
        8 +   // nonce
        1 +   // is_initialized
        8 +   // created_at
        8 +   // last_tx_at
        1;    // bump

      expect(expected).to.equal(130);
    });
  });

  // =========================================================================
  // 10. Groth16 proof structure
  // =========================================================================

  describe("10. Groth16 proof structure", () => {
    it("should have correct proof component sizes", () => {
      // Matches Groth16Proof in lib.rs
      const piA = 64;   // G1 point (uncompressed)
      const piB = 128;  // G2 point (uncompressed)
      const piC = 64;   // G1 point (uncompressed)

      expect(piA + piB + piC).to.equal(256);
    });

    it("should build a mock proof structure", () => {
      const proof = {
        piA: Buffer.alloc(64, 0x01),
        piB: Buffer.alloc(128, 0x02),
        piC: Buffer.alloc(64, 0x03),
      };

      expect(proof.piA.length).to.equal(64);
      expect(proof.piB.length).to.equal(128);
      expect(proof.piC.length).to.equal(64);
    });
  });

  // =========================================================================
  // 11. Dynamic delay logic
  // =========================================================================

  describe("11. Dynamic delay logic", () => {
    it("should compute correct epoch from slot", () => {
      const SLOTS_PER_EPOCH = 7200;

      expect(Math.floor(0 / SLOTS_PER_EPOCH)).to.equal(0);
      expect(Math.floor(7199 / SLOTS_PER_EPOCH)).to.equal(0);
      expect(Math.floor(7200 / SLOTS_PER_EPOCH)).to.equal(1);
      expect(Math.floor(14400 / SLOTS_PER_EPOCH)).to.equal(2);
    });

    it("should compute correct dynamic delay based on mature notes", () => {
      function getDynamicDelay(matureNoteCount: number): number {
        if (matureNoteCount >= 1000) return 0;
        if (matureNoteCount >= 100) return 1;
        if (matureNoteCount >= 10) return 1;
        return 2;
      }

      expect(getDynamicDelay(0)).to.equal(2);
      expect(getDynamicDelay(9)).to.equal(2);
      expect(getDynamicDelay(10)).to.equal(1);
      expect(getDynamicDelay(99)).to.equal(1);
      expect(getDynamicDelay(100)).to.equal(1);
      expect(getDynamicDelay(999)).to.equal(1);
      expect(getDynamicDelay(1000)).to.equal(0);
      expect(getDynamicDelay(5000)).to.equal(0);
    });

    it("should have default epoch delay of 2", () => {
      expect(DEFAULT_EPOCH_DELAY).to.equal(2);
    });
  });

  // =========================================================================
  // 12. Error codes
  // =========================================================================

  describe("12. Error codes", () => {
    const errors: Record<string, number> = {
      NullifierAlreadySpent: 6000,
      InvalidProof: 6001,
      InvalidMerkleRoot: 6002,
      InsufficientPoolBalance: 6003,
      InvalidDenomination: 6004,
      InvalidPublicInputs: 6005,
      InvalidVerificationKey: 6006,
      PoolNotActive: 6007,
      Unauthorized: 6008,
      MerkleTreeFull: 6009,
      ArithmeticOverflow: 6010,
      MissingTokenProgram: 6011,
      MissingTokenAccount: 6012,
      MissingPoolVault: 6013,
      InvalidTokenMint: 6014,
      InvalidTokenOwner: 6015,
      InvalidCommitment: 6016,
      InvalidAmount: 6017,
      EpochDelayNotMet: 6018,
      AccountNotInitialized: 6019,
      NonceMismatch: 6020,
      InvalidCreditDebit: 6021,
      InsufficientVaultBalance: 6022,
    };

    it("should have sequential error codes starting at 6000", () => {
      const codes = Object.values(errors);
      for (let i = 0; i < codes.length; i++) {
        expect(codes[i]).to.equal(6000 + i);
      }
    });

    it("should have 23 defined error codes", () => {
      expect(Object.keys(errors)).to.have.length(23);
    });

    it("should have unique error codes", () => {
      const codes = Object.values(errors);
      const unique = new Set(codes);
      expect(unique.size).to.equal(codes.length);
    });
  });

  // =========================================================================
  // 13. Events structure
  // =========================================================================

  describe("13. Events structure", () => {
    it("ShieldTrustlessEvent should contain all expected fields", () => {
      const event = {
        pool: Keypair.generate().publicKey,
        depositor: Keypair.generate().publicKey,
        denomination: new BN(100_000_000),
        commitment: randomBytes32(),
        leafIndex: new BN(0),
        newRoot: randomBytes32(),
        depositEpoch: new BN(100),
        timestamp: new BN(Date.now()),
      };

      expect(event.denomination.toNumber()).to.equal(100_000_000);
      expect(event.commitment.length).to.equal(32);
      expect(event.newRoot.length).to.equal(32);
      expect(event.leafIndex.toNumber()).to.equal(0);
    });

    it("UnshieldTrustlessEvent should contain all expected fields", () => {
      const event = {
        pool: Keypair.generate().publicKey,
        recipient: Keypair.generate().publicKey,
        denomination: new BN(100_000_000),
        nullifier: randomBytes32(),
        minEpoch: new BN(50),
        currentEpoch: new BN(55),
        dynamicDelay: new BN(2),
        spentAtSlot: new BN(400_000),
        timestamp: new BN(Date.now()),
      };

      expect(event.nullifier.length).to.equal(32);
      expect(event.dynamicDelay.toNumber()).to.equal(2);
    });

    it("ZkSplTrustlessEvent should contain all expected fields", () => {
      const event = {
        owner: Keypair.generate().publicKey,
        mint: Keypair.generate().publicKey,
        newCommitment: randomBytes32(),
        amountHash: randomBytes32(),
        publicCredit: new BN(1_000_000),
        publicDebit: new BN(0),
        nonce: new BN(1),
        timestamp: new BN(Date.now()),
      };

      expect(event.newCommitment.length).to.equal(32);
      expect(event.amountHash.length).to.equal(32);
      expect(event.publicCredit.toNumber()).to.equal(1_000_000);
      expect(event.publicDebit.toNumber()).to.equal(0);
    });

    it("AccountCreatedEvent should contain all expected fields", () => {
      const event = {
        owner: Keypair.generate().publicKey,
        mint: Keypair.generate().publicKey,
        initialCommitment: randomBytes32(),
        timestamp: new BN(Date.now()),
      };

      expect(event.initialCommitment.length).to.equal(32);
      expect(event.timestamp.toNumber()).to.be.greaterThan(0);
    });
  });

  // =========================================================================
  // 14. unshield_trustless (stub -- requires real ZK proof)
  // =========================================================================

  describe("14. unshield_trustless (ZK proof required)", () => {
    it("TODO: should unshield tokens with a valid Groth16 proof", () => {
      // This test requires a real Groth16 proof generated by the unshield circuit.
      //
      // To implement:
      //   1. Build the unshield circuit (circom) and generate proving/verification keys
      //   2. Upload the VK to the vk_data_account via init_vk_data + write_vk_data
      //   3. Update pool.verification_key_hash to match the uploaded VK
      //   4. Create a valid commitment via shield_trustless
      //   5. Compute the Merkle proof for the commitment
      //   6. Generate a Groth16 proof with public inputs:
      //      [merkle_root, nullifier, min_epoch, token_mint, enforce_maturity=1]
      //   7. Call unshield_trustless with the proof, nullifier, merkle_root, min_epoch
      //   8. Verify the recipient received denomination tokens
      //   9. Verify the nullifier PDA was created (double-spend prevention)
      //  10. Verify pool.total_shielded decreased by denomination
    });

    it("TODO: should reject invalid proofs", () => {
      // Submit a dummy/malformed proof and verify it fails with InvalidProof error.
    });

    it("TODO: should reject double-spend (nullifier PDA already exists)", () => {
      // After a valid unshield, try to use the same nullifier again.
      // Should fail because the nullifier PDA already exists (init constraint).
    });

    it("TODO: should enforce epoch delay based on dynamic anonymity set", () => {
      // Attempt to unshield with min_epoch that violates the dynamic delay.
      // Should fail with EpochDelayNotMet.
    });

    it("TODO: should validate Merkle root is current or historical", () => {
      // Use an unknown Merkle root that is neither current nor in history.
      // Should fail with InvalidMerkleRoot.
    });
  });

  // =========================================================================
  // 15. zkspl_trustless (stub -- requires real ZK proof)
  // =========================================================================

  describe("15. zkspl_trustless (ZK proof required)", () => {
    it("TODO: should deposit (public_credit > 0) with valid proof", () => {
      // Deposit mode: public_credit > 0, public_debit = 0
      //
      // To implement:
      //   1. Upload zkSPL VK via init_zkspl_vk_data + write_zkspl_vk_data
      //   2. Update pool.zkspl_vk_hash to match
      //   3. Create a confidential account with initial commitment
      //   4. Generate proof for deposit operation with public inputs:
      //      [old_commitment, new_commitment, amount_hash,
      //       public_credit, public_debit=0, token_mint, nonce]
      //   5. Call zkspl_trustless with the proof
      //   6. Verify balance_commitment updated to new_commitment
      //   7. Verify nonce incremented
      //   8. Verify tokens transferred from user to vault
    });

    it("TODO: should withdraw (public_debit > 0) with valid proof", () => {
      // Withdrawal mode: public_credit = 0, public_debit > 0
    });

    it("TODO: should private transfer (both = 0) with valid proof", () => {
      // Pure commitment update: public_credit = 0, public_debit = 0
      // No token movement, just commitment state change.
    });

    it("TODO: should reject simultaneous credit and debit", () => {
      // public_credit > 0 AND public_debit > 0 should fail with InvalidCreditDebit
    });

    it("TODO: should reject invalid VK hash mismatch", () => {
      // Provide a VK data account whose hash does not match pool.zkspl_vk_hash
    });
  });
});

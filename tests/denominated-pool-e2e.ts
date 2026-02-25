/**
 * Denominated Pool — Real ZK Proof End-to-End Tests
 *
 * Full flow test with REAL Groth16 proof generation via snarkjs:
 *   1. Convert VK JSON → binary, compute Keccak256 hash
 *   2. Initialize ShieldedPool + upload VK data to program-owned PDA
 *   3. Initialize DenominatedPool with matching vk_hash
 *   4. Shield 1 SOL (deposit + insert commitment into Merkle tree)
 *   5. Generate REAL Groth16 proof (witness + prove) using denominated_pool circuit
 *   6. Unshield 1 SOL with the real proof → verify on-chain pairing check passes
 *   7. Verify recipient received exactly pool.denomination
 *   8. Verify nullifier PDA was created (double-spend guard active)
 *
 * Also tests:
 *   - Time delay: deposit then unshield with future min_epoch → EpochDelayNotMet
 *   - Double-spend: same nullifier twice → "already in use"
 *
 * IMPORTANT: This test requires the local validator to support alt_bn128 syscalls
 * (Agave ≥ 2.0). The on-chain verifier runs REAL pairing checks — no mock proofs.
 *
 * Program: GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ZkShielded } from "../target/types/zk_shielded";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import * as path from "path";
import * as fs from "fs";

// Use require for snarkjs (no TS types) and js-sha3
const snarkjs = require("snarkjs");
const { keccak_256 } = require("js-sha3");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey(
  "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c"
);

const NATIVE_SOL_MINT = SystemProgram.programId;
const ONE_SOL = new BN(LAMPORTS_PER_SOL);
const EPOCH_DELAY = new BN(1);
const MERKLE_DEPTH = 15;

/** Circuit build artifacts */
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits");
const WASM_PATH = path.join(
  CIRCUITS_DIR,
  "build",
  "denominated_pool_js",
  "denominated_pool.wasm"
);
const ZKEY_PATH = path.join(
  CIRCUITS_DIR,
  "build",
  "denominated_pool_final.zkey"
);
const VK_JSON_PATH = path.join(
  CIRCUITS_DIR,
  "build",
  "denominated_pool_vk.json"
);

/** PDA seed prefixes */
const SEEDS = {
  DENOMINATED_POOL: Buffer.from("denominated_pool"),
  SHIELDED_POOL: Buffer.from("shielded_pool"),
  MERKLE_TREE: Buffer.from("merkle_tree"),
  NULLIFIER: Buffer.from("nullifier"),
  VK_DATA: Buffer.from("vk_data"),
  NULLIFIER_SET: Buffer.from("nullifier_set"),
};

/**
 * Zero value for empty Merkle leaves.
 * Must match MerkleTreeState::ZERO_VALUE in the Rust program
 * and the circuit's zero_value.
 */
const ZERO_VALUE = BigInt(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

// ---------------------------------------------------------------------------
// Poseidon helpers
// ---------------------------------------------------------------------------

let poseidon: any;
let F: any;

async function initPoseidon(): Promise<void> {
  const circomlibjs = await import("circomlibjs");
  poseidon = await (circomlibjs as any).buildPoseidon();
  F = poseidon.F;
}

function poseidonHash(inputs: bigint[]): bigint {
  const hash = poseidon(inputs.map((x: bigint) => F.e(x)));
  return F.toObject(hash);
}

// ---------------------------------------------------------------------------
// Sparse Merkle tree (matches circuit)
// ---------------------------------------------------------------------------

function computeZeroHashes(depth: number): bigint[] {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= depth; i++) {
    zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

class SparseMerkleTree {
  depth: number;
  zeroHashes: bigint[];
  leaves: Map<number, bigint>;
  nextIndex: number;

  constructor(depth: number) {
    this.depth = depth;
    this.zeroHashes = computeZeroHashes(depth);
    this.leaves = new Map();
    this.nextIndex = 0;
  }

  insert(leaf: bigint): number {
    const idx = this.nextIndex++;
    this.leaves.set(idx, leaf);
    return idx;
  }

  private getLeaf(idx: number): bigint {
    return this.leaves.get(idx) ?? this.zeroHashes[0];
  }

  private computeRoot(nodeIdx: number, level: number): bigint {
    if (level === 0) return this.getLeaf(nodeIdx);
    const rangeStart = nodeIdx * (1 << level);
    const rangeEnd = rangeStart + (1 << level);
    let hasLeaf = false;
    for (const [k] of this.leaves) {
      if (k >= rangeStart && k < rangeEnd) {
        hasLeaf = true;
        break;
      }
    }
    if (!hasLeaf) return this.zeroHashes[level];
    const left = this.computeRoot(nodeIdx * 2, level - 1);
    const right = this.computeRoot(nodeIdx * 2 + 1, level - 1);
    return poseidonHash([left, right]);
  }

  get root(): bigint {
    return this.computeRoot(0, this.depth);
  }

  getPath(leafIndex: number): {
    pathElements: bigint[];
    pathIndices: number[];
  } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let d = 0; d < this.depth; d++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(this.computeRoot(siblingIdx, d));
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }
}

// ---------------------------------------------------------------------------
// VK JSON → binary conversion (matches on-chain parse_vk format)
// ---------------------------------------------------------------------------

/** Convert a decimal string to 32-byte big-endian */
function fieldToBytesBE(decimalStr: string): Uint8Array {
  let n = BigInt(decimalStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

/** G1 point → 64 bytes BE (x || y) */
function g1ToBytes(point: string[]): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(fieldToBytesBE(point[0]), 0);
  buf.set(fieldToBytesBE(point[1]), 32);
  return buf;
}

/**
 * G2 point → 128 bytes (EIP-197 encoding)
 * snarkjs JSON: [[x_real, x_imag], [y_real, y_imag], ["1","0"]]
 * EIP-197:      [x_imag, x_real, y_imag, y_real]
 */
function g2ToBytes(point: string[][]): Uint8Array {
  const buf = new Uint8Array(128);
  buf.set(fieldToBytesBE(point[0][1]), 0); // x_imag
  buf.set(fieldToBytesBE(point[0][0]), 32); // x_real
  buf.set(fieldToBytesBE(point[1][1]), 64); // y_imag
  buf.set(fieldToBytesBE(point[1][0]), 96); // y_real
  return buf;
}

/** Convert VK JSON to binary format matching on-chain parse_vk() */
function vkJsonToBinary(vkJson: any): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(g1ToBytes(vkJson.vk_alpha_1)); // 64
  parts.push(g2ToBytes(vkJson.vk_beta_2)); // 128
  parts.push(g2ToBytes(vkJson.vk_gamma_2)); // 128
  parts.push(g2ToBytes(vkJson.vk_delta_2)); // 128

  // IC count as u32 LE
  const icCount = new Uint8Array(4);
  const count = vkJson.IC.length;
  icCount[0] = count & 0xff;
  icCount[1] = (count >> 8) & 0xff;
  icCount[2] = (count >> 16) & 0xff;
  icCount[3] = (count >> 24) & 0xff;
  parts.push(icCount); // 4

  for (const ic of vkJson.IC) {
    parts.push(g1ToBytes(ic)); // 64 each
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Keccak256 hash (matches on-chain sha3::Keccak256) */
function keccak256(data: Uint8Array): number[] {
  const hash = keccak_256(data);
  return Array.from(Buffer.from(hash, "hex"));
}

// ---------------------------------------------------------------------------
// Proof conversion: snarkjs → on-chain Groth16Proof
// ---------------------------------------------------------------------------

/**
 * Convert snarkjs proof to on-chain format.
 * snarkjs pi_a/pi_c: [x, y, "1"] (G1 affine)
 * snarkjs pi_b: [[x_real, x_imag], [y_real, y_imag], ["1","0"]] (G2 affine)
 */
function proofToOnChain(proof: any): {
  piA: number[];
  piB: number[];
  piC: number[];
} {
  // G1: [x BE, y BE]
  const piA = Array.from(g1ToBytes([proof.pi_a[0], proof.pi_a[1]]));
  const piC = Array.from(g1ToBytes([proof.pi_c[0], proof.pi_c[1]]));

  // G2: [x_imag, x_real, y_imag, y_real]
  const piB = Array.from(g2ToBytes(proof.pi_b));

  return { piA, piB, piC };
}

// ---------------------------------------------------------------------------
// Byte conversion for on-chain public inputs (LE format)
// ---------------------------------------------------------------------------

/**
 * Convert a bigint to 32-byte little-endian (for on-chain [u8; 32]).
 * The on-chain verifier does le_to_be() before using in pairing check.
 */
function bigintToLeBytes(value: bigint): number[] {
  const buf: number[] = new Array(32).fill(0);
  let val = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// PDA derivation helpers
// ---------------------------------------------------------------------------

function deriveDenominatedPoolPDA(
  tokenMint: PublicKey,
  denomination: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.DENOMINATED_POOL,
      tokenMint.toBuffer(),
      denomination.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );
}

function deriveShieldedPoolPDA(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SHIELDED_POOL, tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

function deriveMerkleTreePDA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.MERKLE_TREE, pool.toBuffer()],
    PROGRAM_ID
  );
}

function deriveNullifierSetPDA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER_SET, pool.toBuffer()],
    PROGRAM_ID
  );
}

function deriveVkDataPDA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.VK_DATA, pool.toBuffer()],
    PROGRAM_ID
  );
}

function deriveNullifierPDA(
  pool: PublicKey,
  nullifier: number[]
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, pool.toBuffer(), Buffer.from(nullifier)],
    PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Denominated Pool — Real ZK Proof E2E", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();

  // Cryptographic material
  const secret = BigInt("98765432109876543210");
  const nullifierPreimage = BigInt("11111111111111111111");
  const depositEpoch = BigInt(0); // epoch 0 — guaranteed to be in the past
  const tokenMintBigint = BigInt(0); // native SOL = system program = 0...0

  // Derived values (set in before())
  let commitment: bigint;
  let nullifierHash: bigint;
  let tree: SparseMerkleTree;
  let merkleRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];
  let leafIndex: number;

  // VK binary and hash
  let vkBinary: Uint8Array;
  let vkHash: number[];

  // PDAs
  let denomPoolPDA: PublicKey;
  let denomTreePDA: PublicKey;
  let shieldedPoolPDA: PublicKey;
  let shieldedTreePDA: PublicKey;
  let shieldedNullifierSetPDA: PublicKey;
  let vkDataPDA: PublicKey;

  before(async function () {
    this.timeout(60000);

    // Initialize Poseidon
    await initPoseidon();

    // Compute commitment and nullifier
    commitment = poseidonHash([
      nullifierPreimage,
      secret,
      depositEpoch,
      tokenMintBigint,
    ]);
    nullifierHash = poseidonHash([nullifierPreimage, secret]);

    console.log("  commitment:", commitment.toString().slice(0, 40) + "...");
    console.log("  nullifier: ", nullifierHash.toString().slice(0, 40) + "...");

    // Build Merkle tree and insert our commitment
    tree = new SparseMerkleTree(MERKLE_DEPTH);
    leafIndex = tree.insert(commitment);
    merkleRoot = tree.root;
    const pathData = tree.getPath(leafIndex);
    pathElements = pathData.pathElements;
    pathIndices = pathData.pathIndices;

    console.log("  merkle root:", merkleRoot.toString().slice(0, 40) + "...");
    console.log("  leaf index:", leafIndex);

    // Load and convert VK
    const vkJson = JSON.parse(fs.readFileSync(VK_JSON_PATH, "utf8"));
    vkBinary = vkJsonToBinary(vkJson);
    vkHash = keccak256(vkBinary);
    console.log("  VK binary size:", vkBinary.length, "bytes");

    // Derive all PDAs
    [denomPoolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, ONE_SOL);
    [denomTreePDA] = deriveMerkleTreePDA(denomPoolPDA);
    [shieldedPoolPDA] = deriveShieldedPoolPDA(NATIVE_SOL_MINT);
    [shieldedTreePDA] = deriveMerkleTreePDA(shieldedPoolPDA);
    [shieldedNullifierSetPDA] = deriveNullifierSetPDA(shieldedPoolPDA);
    [vkDataPDA] = deriveVkDataPDA(shieldedPoolPDA);

    // Airdrop SOL
    const balance = await provider.connection.getBalance(authority.publicKey);
    if (balance < 30 * LAMPORTS_PER_SOL) {
      const sig = await provider.connection.requestAirdrop(
        authority.publicKey,
        30 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Fund recipient so account exists for lamport transfer
    const recipSig = await provider.connection.requestAirdrop(
      recipient.publicKey,
      0.01 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(recipSig);
  });

  // =========================================================================
  // Step 1: Upload VK via ShieldedPool infrastructure
  // =========================================================================

  describe("VK upload (via ShieldedPool)", () => {
    it("initializes ShieldedPool for native SOL", async function () {
      this.timeout(30000);

      // Need a ShieldedPool to use init_vk_data / write_vk_data
      // The VK data PDA is derived from the ShieldedPool key.
      // unshield_denominated uses verification_key_data as unchecked AccountInfo,
      // so it can reference any account — we just need the hash to match.
      const dummyVkHash = new Array(32).fill(0);
      await program.methods
        .initializePool(dummyVkHash, NATIVE_SOL_MINT)
        .accountsPartial({
          authority: authority.publicKey,
          shieldedPool: shieldedPoolPDA,
          merkleTree: shieldedTreePDA,
          nullifierSet: shieldedNullifierSetPDA,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const pool = await program.account.shieldedPool.fetch(shieldedPoolPDA);
      expect(pool.isActive).to.be.true;
    });

    it("creates VK data account (init_vk_data)", async function () {
      this.timeout(30000);

      await program.methods
        .initVkData(vkBinary.length)
        .accountsPartial({
          authority: authority.publicKey,
          shieldedPool: shieldedPoolPDA,
          vkDataAccount: vkDataPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const info = await provider.connection.getAccountInfo(vkDataPDA);
      expect(info).to.not.be.null;
      expect(info!.data.length).to.equal(vkBinary.length);
    });

    it("writes VK binary data (write_vk_data)", async function () {
      this.timeout(30000);

      const CHUNK_SIZE = 700;
      const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);

      for (let i = 0; i < totalChunks; i++) {
        const offset = i * CHUNK_SIZE;
        const chunk = vkBinary.slice(
          offset,
          Math.min(offset + CHUNK_SIZE, vkBinary.length)
        );

        await program.methods
          .writeVkData(offset, Buffer.from(chunk))
          .accountsPartial({
            authority: authority.publicKey,
            shieldedPool: shieldedPoolPDA,
            vkDataAccount: vkDataPDA,
          })
          .rpc();
      }

      // Verify VK data written correctly
      const info = await provider.connection.getAccountInfo(vkDataPDA);
      const stored = info!.data;
      expect(Buffer.from(stored)).to.deep.equal(Buffer.from(vkBinary));

      // Verify hash matches what we'll use for the denominated pool
      const storedHash = keccak256(new Uint8Array(stored));
      expect(storedHash).to.deep.equal(vkHash);
    });
  });

  // =========================================================================
  // Step 2: Initialize denominated pool with real VK hash
  // =========================================================================

  describe("init denominated pool", () => {
    it("creates 1 SOL pool with real VK hash", async () => {
      await program.methods
        .initDenominatedPool(vkHash, NATIVE_SOL_MINT, ONE_SOL, EPOCH_DELAY)
        .accountsPartial({
          authority: authority.publicKey,
          denominatedPool: denomPoolPDA,
          merkleTree: denomTreePDA,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const pool = await program.account.denominatedPool.fetch(denomPoolPDA);
      expect(pool.denomination.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(Buffer.from(pool.vkHash)).to.deep.equal(Buffer.from(vkHash));
      expect(pool.isActive).to.be.true;
    });
  });

  // =========================================================================
  // Step 3: Shield 1 SOL with real commitment
  // =========================================================================

  describe("shield 1 SOL", () => {
    it("deposits with real Poseidon commitment + Merkle root", async () => {
      const commitmentBytes = bigintToLeBytes(commitment);
      const rootBytes = bigintToLeBytes(merkleRoot);

      const poolBefore = await provider.connection.getBalance(denomPoolPDA);

      await program.methods
        .shieldDenominated(commitmentBytes, rootBytes)
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: denomPoolPDA,
          merkleTree: denomTreePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Pool gained exactly 1 SOL
      const poolAfter = await provider.connection.getBalance(denomPoolPDA);
      expect(poolAfter - poolBefore).to.equal(LAMPORTS_PER_SOL);

      // State updated
      const pool = await program.account.denominatedPool.fetch(denomPoolPDA);
      expect(pool.totalShielded.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(pool.noteCount.toNumber()).to.equal(1);

      // On-chain Merkle root matches our computed root
      expect(Buffer.from(pool.merkleRoot)).to.deep.equal(
        Buffer.from(rootBytes)
      );
    });
  });

  // =========================================================================
  // Step 4: Generate real Groth16 proof + unshield
  // =========================================================================

  describe("unshield 1 SOL with real ZK proof", () => {
    let proof: any;
    let publicSignals: string[];
    let onChainProof: { piA: number[]; piB: number[]; piC: number[] };
    let nullifierLeBytes: number[];
    let merkleRootLeBytes: number[];
    let minEpoch: bigint;

    before(async function () {
      this.timeout(60000);

      // min_epoch must be:
      //   1. >= deposit_epoch (circuit enforces deposit_epoch <= min_epoch)
      //   2. <= current_epoch (program enforces current_epoch >= min_epoch)
      // deposit_epoch = 0, so min_epoch = 0 works if current_epoch >= 0 (always true)
      minEpoch = BigInt(0);

      // Build circuit inputs
      const circuitInputs = {
        merkle_root: merkleRoot.toString(),
        nullifier: nullifierHash.toString(),
        min_epoch: minEpoch.toString(),
        token_mint: tokenMintBigint.toString(),
        secret: secret.toString(),
        nullifier_preimage: nullifierPreimage.toString(),
        deposit_epoch: depositEpoch.toString(),
        path_elements: pathElements.map((x) => x.toString()),
        path_indices: pathIndices.map((x) => x.toString()),
      };

      console.log("    Generating real Groth16 proof...");
      const t0 = Date.now();
      const result = await snarkjs.groth16.fullProve(
        circuitInputs,
        WASM_PATH,
        ZKEY_PATH
      );
      proof = result.proof;
      publicSignals = result.publicSignals;
      const t1 = Date.now();
      console.log(`    Proof generated in ${t1 - t0}ms`);

      // Verify locally first
      const vkJson = JSON.parse(fs.readFileSync(VK_JSON_PATH, "utf8"));
      const isValid = await snarkjs.groth16.verify(
        vkJson,
        publicSignals,
        proof
      );
      console.log("    Local verification:", isValid);
      expect(isValid).to.be.true;

      // Verify public signals match our expected values
      // Public signals order: [merkle_root, nullifier, min_epoch, token_mint]
      expect(BigInt(publicSignals[0])).to.equal(merkleRoot);
      expect(BigInt(publicSignals[1])).to.equal(nullifierHash);
      expect(BigInt(publicSignals[2])).to.equal(minEpoch);
      expect(BigInt(publicSignals[3])).to.equal(tokenMintBigint);

      // Convert proof to on-chain format
      onChainProof = proofToOnChain(proof);

      // Convert public inputs to LE bytes for instruction args
      nullifierLeBytes = bigintToLeBytes(nullifierHash);
      merkleRootLeBytes = bigintToLeBytes(merkleRoot);
    });

    it("on-chain unshield succeeds with real proof", async function () {
      this.timeout(60000);

      const [nullPDA] = deriveNullifierPDA(denomPoolPDA, nullifierLeBytes);

      // Verify nullifier PDA doesn't exist yet
      let nullInfo = await provider.connection.getAccountInfo(nullPDA);
      expect(nullInfo).to.be.null;

      const recipientBefore = await provider.connection.getBalance(
        recipient.publicKey
      );
      const poolBefore = await provider.connection.getBalance(denomPoolPDA);

      await program.methods
        .unshieldDenominated(
          onChainProof,
          nullifierLeBytes,
          merkleRootLeBytes,
          new BN(Number(minEpoch))
        )
        .accountsPartial({
          payer: authority.publicKey,
          recipient: recipient.publicKey,
          denominatedPool: denomPoolPDA,
          merkleTree: denomTreePDA,
          nullifierRecord: nullPDA,
          verificationKeyData: vkDataPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Recipient gained exactly 1 SOL
      const recipientAfter = await provider.connection.getBalance(
        recipient.publicKey
      );
      expect(recipientAfter - recipientBefore).to.equal(LAMPORTS_PER_SOL);

      // Pool lost exactly 1 SOL
      const poolAfter = await provider.connection.getBalance(denomPoolPDA);
      expect(poolBefore - poolAfter).to.equal(LAMPORTS_PER_SOL);

      // Pool state updated
      const pool = await program.account.denominatedPool.fetch(denomPoolPDA);
      expect(pool.totalShielded.toNumber()).to.equal(0);
      expect(pool.noteCount.toNumber()).to.equal(0);

      // Nullifier PDA was created (double-spend guard)
      nullInfo = await provider.connection.getAccountInfo(nullPDA);
      expect(nullInfo).to.not.be.null;
      expect(nullInfo!.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());
    });

    it("double-spend: same nullifier is rejected", async function () {
      this.timeout(30000);

      // Shield another note first (pool needs balance for unshield)
      const commitment2 = poseidonHash([
        BigInt("22222222222222222222"),
        BigInt("33333333333333333333"),
        BigInt(0),
        tokenMintBigint,
      ]);
      const tree2 = new SparseMerkleTree(MERKLE_DEPTH);
      tree2.insert(commitment2);
      const root2 = tree2.root;

      await program.methods
        .shieldDenominated(bigintToLeBytes(commitment2), bigintToLeBytes(root2))
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: denomPoolPDA,
          merkleTree: denomTreePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Try to reuse the SAME nullifier from the first unshield
      const [nullPDA] = deriveNullifierPDA(denomPoolPDA, nullifierLeBytes);

      // PDA already exists from the first unshield
      const nullInfo = await provider.connection.getAccountInfo(nullPDA);
      expect(nullInfo).to.not.be.null;

      try {
        await program.methods
          .unshieldDenominated(
            onChainProof,
            nullifierLeBytes,
            merkleRootLeBytes,
            new BN(Number(minEpoch))
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: denomPoolPDA,
            merkleTree: denomTreePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: vkDataPDA,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown — nullifier already spent");
      } catch (err: any) {
        // init constraint fails: PDA already exists
        const msg = err.toString();
        expect(
          msg.includes("already in use") ||
            msg.includes("0x0") ||
            msg.includes("custom program error")
        ).to.be.true;
      }
    });
  });

  // =========================================================================
  // Step 5: Time delay test
  // =========================================================================

  describe("time delay enforcement", () => {
    it("rejects unshield when min_epoch > current_epoch", async function () {
      this.timeout(30000);

      // The pool already has 1 SOL from the double-spend test shield.
      // Try to unshield with min_epoch = 999999999 (far in the future).
      // The program checks: current_epoch >= min_epoch → fails.
      //
      // We use a valid Merkle root (passes constraint check) but a future
      // min_epoch. The epoch check happens BEFORE VK/proof verification,
      // so we don't need a real proof for this test.
      const pool = await program.account.denominatedPool.fetch(denomPoolPDA);
      const validRoot = Array.from(pool.merkleRoot);

      const futureEpoch = new BN("999999999");
      const fakeNullifier = Array.from(Keypair.generate().publicKey.toBuffer());
      const [nullPDA] = deriveNullifierPDA(denomPoolPDA, fakeNullifier);

      const mockProof = {
        piA: new Array(64).fill(0),
        piB: new Array(128).fill(0),
        piC: new Array(64).fill(0),
      };

      try {
        await program.methods
          .unshieldDenominated(mockProof, fakeNullifier, validRoot, futureEpoch)
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: denomPoolPDA,
            merkleTree: denomTreePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: vkDataPDA,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown — epoch delay not met");
      } catch (err: any) {
        expect(err.toString()).to.include("EpochDelayNotMet");
      }
    });

    it("epoch 0 (past) is accepted by program check", async function () {
      this.timeout(30000);

      // min_epoch = 0 should always pass the program check (current_epoch >= 0).
      // But the proof/VK check will still fail (we use mock proof here).
      // The point: the epoch check PASSES, so we get a later error.
      const pool = await program.account.denominatedPool.fetch(denomPoolPDA);
      const validRoot = Array.from(pool.merkleRoot);

      const pastEpoch = new BN(0);
      const fakeNullifier = Array.from(Keypair.generate().publicKey.toBuffer());
      const [nullPDA] = deriveNullifierPDA(denomPoolPDA, fakeNullifier);

      const mockProof = {
        piA: new Array(64).fill(0),
        piB: new Array(128).fill(0),
        piC: new Array(64).fill(0),
      };

      try {
        await program.methods
          .unshieldDenominated(mockProof, fakeNullifier, validRoot, pastEpoch)
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: denomPoolPDA,
            merkleTree: denomTreePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: vkDataPDA,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown — proof is invalid");
      } catch (err: any) {
        // Should NOT be EpochDelayNotMet — epoch check passed.
        // Should fail at VK hash or proof verification instead.
        const msg = err.toString();
        expect(msg).to.not.include("EpochDelayNotMet");
        expect(
          msg.includes("InvalidVerificationKey") ||
            msg.includes("InvalidProof") ||
            msg.includes("custom program error")
        ).to.be.true;
      }
    });
  });
});

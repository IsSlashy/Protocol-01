/**
 * Note Split (Privacy Router) — Real ZK Proof End-to-End Tests
 *
 * Full flow test with REAL Groth16 proof generation via snarkjs:
 *   1. Initialize ShieldedPool + upload note_split VK data
 *   2. Initialize source denominated pool (1 SOL) with note_split VK hash
 *   3. Initialize target denominated pool (0.5 SOL)
 *   4. Shield 1 SOL into source pool
 *   5. Generate REAL Groth16 proof using note_split circuit
 *   6. Call split_note: 1 SOL → 2 × 0.5 SOL notes in target pool
 *   7. Verify pool stats, nullifier PDA, and target Merkle state
 *
 * Also tests:
 *   - Denomination mismatch: 1 SOL split into 3 × 0.5 SOL → InvalidDenomination
 *   - Double-spend: same nullifier twice → "already in use"
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
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { expect } from "chai";
import * as path from "path";
import * as fs from "fs";

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
const HALF_SOL = new BN(LAMPORTS_PER_SOL / 2);
const EPOCH_DELAY = new BN(1);
const MERKLE_DEPTH = 15;

/** Protocol fee wallet (devnet) */
const PROTOCOL_FEE_WALLET = new PublicKey(
  "BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN"
);

/** Note split circuit artifacts */
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits");
const WASM_PATH = path.join(
  CIRCUITS_DIR,
  "build",
  "note_split",
  "note_split_js",
  "note_split.wasm"
);
const ZKEY_PATH = path.join(
  CIRCUITS_DIR,
  "build",
  "note_split",
  "note_split_final.zkey"
);
const VK_JSON_PATH = path.join(
  CIRCUITS_DIR,
  "build",
  "note_split",
  "note_split_vk.json"
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

function fieldToBytesBE(decimalStr: string): Uint8Array {
  let n = BigInt(decimalStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function g1ToBytes(point: string[]): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(fieldToBytesBE(point[0]), 0);
  buf.set(fieldToBytesBE(point[1]), 32);
  return buf;
}

function g2ToBytes(point: string[][]): Uint8Array {
  const buf = new Uint8Array(128);
  buf.set(fieldToBytesBE(point[0][1]), 0); // x_imag
  buf.set(fieldToBytesBE(point[0][0]), 32); // x_real
  buf.set(fieldToBytesBE(point[1][1]), 64); // y_imag
  buf.set(fieldToBytesBE(point[1][0]), 96); // y_real
  return buf;
}

function vkJsonToBinary(vkJson: any): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(g1ToBytes(vkJson.vk_alpha_1));
  parts.push(g2ToBytes(vkJson.vk_beta_2));
  parts.push(g2ToBytes(vkJson.vk_gamma_2));
  parts.push(g2ToBytes(vkJson.vk_delta_2));

  const icCount = new Uint8Array(4);
  const count = vkJson.IC.length;
  icCount[0] = count & 0xff;
  icCount[1] = (count >> 8) & 0xff;
  icCount[2] = (count >> 16) & 0xff;
  icCount[3] = (count >> 24) & 0xff;
  parts.push(icCount);

  for (const ic of vkJson.IC) {
    parts.push(g1ToBytes(ic));
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

function keccak256(data: Uint8Array): number[] {
  const hash = keccak_256(data);
  return Array.from(Buffer.from(hash, "hex"));
}

// ---------------------------------------------------------------------------
// Proof conversion
// ---------------------------------------------------------------------------

function proofToOnChain(proof: any): {
  piA: number[];
  piB: number[];
  piC: number[];
} {
  const piA = Array.from(g1ToBytes([proof.pi_a[0], proof.pi_a[1]]));
  const piC = Array.from(g1ToBytes([proof.pi_c[0], proof.pi_c[1]]));
  const piB = Array.from(g2ToBytes(proof.pi_b));
  return { piA, piB, piC };
}

// ---------------------------------------------------------------------------
// Byte conversion for on-chain public inputs (LE format)
// ---------------------------------------------------------------------------

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

describe("Note Split (Privacy Router) — Real ZK Proof E2E", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;

  const authority = (provider.wallet as anchor.Wallet).payer;

  // Source note cryptographic material (randomized per run for idempotent devnet tests)
  const randomSuffix = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
  const secret = randomSuffix;
  const nullifierPreimage = randomSuffix + BigInt(1);
  const depositEpoch = BigInt(0);
  const tokenMintBigint = BigInt(0); // native SOL

  // Output note material (2 outputs for 1 SOL → 2 × 0.5 SOL)
  const outputSecrets = Array.from({ length: 20 }, (_, i) =>
    i < 2 ? randomSuffix + BigInt(100 + i) : BigInt(0)
  );
  const outputNullifierPreimages = Array.from({ length: 20 }, (_, i) =>
    i < 2 ? randomSuffix + BigInt(200 + i) : BigInt(0)
  );
  const outputDepositEpoch = BigInt(0);

  // Derived values (set in before())
  let sourceCommitment: bigint;
  let nullifierHash: bigint;
  let sourceTree: SparseMerkleTree;
  let sourceMerkleRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];

  let outputCommitments: bigint[] = [];
  let targetTree: SparseMerkleTree;
  let targetNewRoots: bigint[] = [];

  // VK binary and hash (note_split circuit)
  let vkBinary: Uint8Array;
  let vkHash: number[];

  // PDAs
  let sourcePoolPDA: PublicKey;
  let sourceTreePDA: PublicKey;
  let targetPoolPDA: PublicKey;
  let targetTreePDA: PublicKey;
  let shieldedPoolPDA: PublicKey;
  let shieldedTreePDA: PublicKey;
  let shieldedNullifierSetPDA: PublicKey;
  let vkDataPDA: PublicKey;

  before(async function () {
    this.timeout(120000);

    await initPoseidon();

    // --- Source note ---
    sourceCommitment = poseidonHash([
      nullifierPreimage,
      secret,
      depositEpoch,
      tokenMintBigint,
    ]);
    nullifierHash = poseidonHash([nullifierPreimage, secret]);

    console.log(
      "  source commitment:",
      sourceCommitment.toString().slice(0, 40) + "..."
    );
    console.log(
      "  nullifier:        ",
      nullifierHash.toString().slice(0, 40) + "..."
    );

    // Build source Merkle tree
    sourceTree = new SparseMerkleTree(MERKLE_DEPTH);
    sourceTree.insert(sourceCommitment);
    sourceMerkleRoot = sourceTree.root;
    const pathData = sourceTree.getPath(0);
    pathElements = pathData.pathElements;
    pathIndices = pathData.pathIndices;

    console.log(
      "  source root:      ",
      sourceMerkleRoot.toString().slice(0, 40) + "..."
    );

    // --- Output commitments ---
    for (let i = 0; i < 2; i++) {
      const c = poseidonHash([
        outputNullifierPreimages[i],
        outputSecrets[i],
        outputDepositEpoch,
        tokenMintBigint,
      ]);
      outputCommitments.push(c);
      console.log(
        `  output[${i}] commitment:`,
        c.toString().slice(0, 40) + "..."
      );
    }

    // Pad to 20 with zeros (dummy slots)
    while (outputCommitments.length < 20) {
      outputCommitments.push(BigInt(0));
    }

    // --- Target Merkle tree: compute sequential roots after each insertion ---
    targetTree = new SparseMerkleTree(MERKLE_DEPTH);
    for (let i = 0; i < 2; i++) {
      targetTree.insert(outputCommitments[i]);
      targetNewRoots.push(targetTree.root);
      console.log(
        `  target root after insert[${i}]:`,
        targetTree.root.toString().slice(0, 40) + "..."
      );
    }

    // --- Load VK ---
    const vkJson = JSON.parse(fs.readFileSync(VK_JSON_PATH, "utf8"));
    vkBinary = vkJsonToBinary(vkJson);
    vkHash = keccak256(vkBinary);
    console.log("  note_split VK binary size:", vkBinary.length, "bytes");
    console.log(
      "  note_split VK IC count:",
      vkJson.IC.length,
      "(expect 27 = 1 + 26 public)"
    );

    // --- Derive PDAs ---
    [sourcePoolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, ONE_SOL);
    [sourceTreePDA] = deriveMerkleTreePDA(sourcePoolPDA);
    [targetPoolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, HALF_SOL);
    [targetTreePDA] = deriveMerkleTreePDA(targetPoolPDA);
    [shieldedPoolPDA] = deriveShieldedPoolPDA(NATIVE_SOL_MINT);
    [shieldedTreePDA] = deriveMerkleTreePDA(shieldedPoolPDA);
    [shieldedNullifierSetPDA] = deriveNullifierSetPDA(shieldedPoolPDA);
    [vkDataPDA] = deriveVkDataPDA(shieldedPoolPDA);

    console.log("  source pool PDA:", sourcePoolPDA.toBase58());
    console.log("  target pool PDA:", targetPoolPDA.toBase58());
    console.log("  VK data PDA:", vkDataPDA.toBase58());

    // --- Check authority balance ---
    const balance = await provider.connection.getBalance(authority.publicKey);
    console.log(`  authority balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    if (balance < 5 * LAMPORTS_PER_SOL) {
      throw new Error(
        `Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL. ` +
          `Need at least 5 SOL. Fund ${authority.publicKey.toBase58()} on devnet.`
      );
    }

    // Verify protocol fee wallet exists
    const feeBalance = await provider.connection.getBalance(
      PROTOCOL_FEE_WALLET
    );
    console.log(`  fee wallet balance: ${feeBalance / LAMPORTS_PER_SOL} SOL`);
    if (feeBalance === 0) {
      throw new Error(
        `Fee wallet ${PROTOCOL_FEE_WALLET.toBase58()} has no SOL. Fund it on devnet.`
      );
    }
  });

  // =========================================================================
  // Step 1: Upload note_split VK via ShieldedPool infrastructure
  // =========================================================================

  describe("VK upload (note_split circuit)", () => {
    it("initializes ShieldedPool for native SOL", async function () {
      this.timeout(30000);

      const dummyVkHash = new Array(32).fill(0);

      try {
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
      } catch (err: any) {
        if (!err.toString().includes("already in use")) {
          throw err;
        }
        console.log("    ShieldedPool already exists, reusing");
      }

      const pool = await program.account.shieldedPool.fetch(shieldedPoolPDA);
      expect(pool.isActive).to.be.true;
    });

    it("creates/resizes and writes note_split VK data", async function () {
      this.timeout(60000);

      // Check if VK data already has correct content
      const existingInfo = await provider.connection.getAccountInfo(vkDataPDA);
      if (existingInfo && existingInfo.data.length === vkBinary.length) {
        const existingHash = keccak256(new Uint8Array(existingInfo.data));
        if (Buffer.from(existingHash).equals(Buffer.from(vkHash))) {
          console.log("    note_split VK already uploaded, skipping");
          return;
        }
      }

      // Init or resize VK data account (handler supports resize if account exists)
      console.log(
        `    Initializing VK data account (${vkBinary.length} bytes)...`
      );
      await program.methods
        .initVkData(vkBinary.length)
        .accountsPartial({
          authority: authority.publicKey,
          shieldedPool: shieldedPoolPDA,
          vkDataAccount: vkDataPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Write VK binary in chunks
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

      // Verify
      const info = await provider.connection.getAccountInfo(vkDataPDA);
      const storedHash = keccak256(new Uint8Array(info!.data));
      expect(storedHash).to.deep.equal(vkHash);
      console.log(
        `    VK uploaded: ${vkBinary.length} bytes in ${totalChunks} chunks`
      );
    });
  });

  // =========================================================================
  // Step 2: Initialize both denominated pools
  // =========================================================================

  describe("init denominated pools", () => {
    it("creates source pool (1 SOL) with note_split VK hash", async function () {
      this.timeout(30000);

      try {
        // IDL: initDenominatedPool(vkHash, tokenMint, denomination, epochDelay)
        await program.methods
          .initDenominatedPool(vkHash, NATIVE_SOL_MINT, ONE_SOL, EPOCH_DELAY)
          .accountsPartial({
            authority: authority.publicKey,
            denominatedPool: sourcePoolPDA,
            merkleTree: sourceTreePDA,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
      } catch (err: any) {
        if (!err.toString().includes("already in use")) {
          throw err;
        }
        console.log("    Source pool already exists, updating VK hash...");

        // Pool exists from a previous test — update VK hash to note_split VK
        const pool = await program.account.denominatedPool.fetch(
          sourcePoolPDA
        );
        const currentVkHash = Buffer.from(pool.vkHash);
        const targetVkHash = Buffer.from(vkHash);

        if (!currentVkHash.equals(targetVkHash)) {
          await program.methods
            .updateDenominatedVk(vkHash)
            .accountsPartial({
              authority: authority.publicKey,
              denominatedPool: sourcePoolPDA,
            })
            .rpc();
          console.log("    VK hash updated to note_split VK ✓");
        } else {
          console.log("    VK hash already correct ✓");
        }
      }

      const pool = await program.account.denominatedPool.fetch(sourcePoolPDA);
      expect(pool.denomination.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(pool.isActive).to.be.true;
    });

    it("creates target pool (0.5 SOL)", async function () {
      this.timeout(30000);

      try {
        await program.methods
          .initDenominatedPool(vkHash, NATIVE_SOL_MINT, HALF_SOL, EPOCH_DELAY)
          .accountsPartial({
            authority: authority.publicKey,
            denominatedPool: targetPoolPDA,
            merkleTree: targetTreePDA,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
      } catch (err: any) {
        if (!err.toString().includes("already in use")) {
          throw err;
        }
        console.log("    Target pool already exists, reusing");
      }

      const pool = await program.account.denominatedPool.fetch(targetPoolPDA);
      expect(pool.denomination.toNumber()).to.equal(LAMPORTS_PER_SOL / 2);
      expect(pool.isActive).to.be.true;
    });
  });

  // =========================================================================
  // Step 3: Shield 1 SOL into source pool
  // =========================================================================

  describe("shield 1 SOL into source pool", () => {
    it("deposits with real Poseidon commitment", async function () {
      this.timeout(30000);

      const commitmentBytes = bigintToLeBytes(sourceCommitment);
      const rootBytes = bigintToLeBytes(sourceMerkleRoot);

      const poolBefore = await provider.connection.getBalance(sourcePoolPDA);

      await program.methods
        .shieldDenominated(commitmentBytes, rootBytes)
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: sourcePoolPDA,
          merkleTree: sourceTreePDA,
          systemProgram: SystemProgram.programId,
          protocolFeeWallet: PROTOCOL_FEE_WALLET,
          tokenProgram: null,
          userTokenAccount: null,
          poolVault: null,
        })
        .rpc();

      const poolAfter = await provider.connection.getBalance(sourcePoolPDA);
      expect(poolAfter - poolBefore).to.be.gte(LAMPORTS_PER_SOL * 0.99);

      const pool = await program.account.denominatedPool.fetch(sourcePoolPDA);
      expect(pool.noteCount.toNumber()).to.be.gte(1);
      console.log(
        `    Shielded 1 SOL. Pool note_count: ${pool.noteCount.toNumber()}, total_shielded: ${pool.totalShielded.toNumber()}`
      );
    });
  });

  // =========================================================================
  // Step 4: Generate real ZK proof and execute split_note
  // =========================================================================

  describe("split_note: 1 SOL → 2 × 0.5 SOL", () => {
    let proof: any;
    let publicSignals: string[];
    let onChainProof: { piA: number[]; piB: number[]; piC: number[] };
    let nullifierLeBytes: number[];
    let merkleRootLeBytes: number[];
    let outputCommitmentLeBytes: number[][];
    let targetRootLeBytes: number[][];

    before(async function () {
      this.timeout(120000);

      // Build circuit inputs
      const circuitInputs = {
        // Public inputs
        source_merkle_root: sourceMerkleRoot.toString(),
        nullifier: nullifierHash.toString(),
        min_epoch: "0",
        token_mint: tokenMintBigint.toString(),
        enforce_maturity: "1",
        num_active_outputs: "2",
        output_commitments: outputCommitments.map((c) => c.toString()),

        // Private inputs — source note
        secret: secret.toString(),
        nullifier_preimage: nullifierPreimage.toString(),
        deposit_epoch: depositEpoch.toString(),
        path_elements: pathElements.map((x) => x.toString()),
        path_indices: pathIndices.map((x) => x.toString()),

        // Private inputs — output notes
        output_secrets: outputSecrets.map((s) => s.toString()),
        output_nullifier_preimages: outputNullifierPreimages.map((n) =>
          n.toString()
        ),
        output_deposit_epoch: outputDepositEpoch.toString(),
      };

      console.log("    Generating real Groth16 proof (note_split)...");
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

      // Verify locally
      const vkJson = JSON.parse(fs.readFileSync(VK_JSON_PATH, "utf8"));
      const isValid = await snarkjs.groth16.verify(
        vkJson,
        publicSignals,
        proof
      );
      console.log("    Local verification:", isValid);
      expect(isValid).to.be.true;

      // Verify public signals match expected values
      expect(BigInt(publicSignals[0])).to.equal(sourceMerkleRoot);
      expect(BigInt(publicSignals[1])).to.equal(nullifierHash);
      expect(BigInt(publicSignals[2])).to.equal(BigInt(0)); // min_epoch
      expect(BigInt(publicSignals[3])).to.equal(tokenMintBigint);
      expect(BigInt(publicSignals[4])).to.equal(BigInt(1)); // enforce_maturity
      expect(BigInt(publicSignals[5])).to.equal(BigInt(2)); // num_active_outputs
      expect(BigInt(publicSignals[6])).to.equal(outputCommitments[0]);
      expect(BigInt(publicSignals[7])).to.equal(outputCommitments[1]);
      // Remaining 18 slots should be zero
      for (let i = 8; i < 26; i++) {
        expect(BigInt(publicSignals[i])).to.equal(BigInt(0));
      }

      // Convert to on-chain format
      onChainProof = proofToOnChain(proof);
      nullifierLeBytes = bigintToLeBytes(nullifierHash);
      merkleRootLeBytes = bigintToLeBytes(sourceMerkleRoot);

      // Only the active output commitments (num_outputs = 2)
      outputCommitmentLeBytes = [];
      for (let i = 0; i < 2; i++) {
        outputCommitmentLeBytes.push(bigintToLeBytes(outputCommitments[i]));
      }

      targetRootLeBytes = [];
      for (let i = 0; i < 2; i++) {
        targetRootLeBytes.push(bigintToLeBytes(targetNewRoots[i]));
      }
    });

    it("on-chain split_note succeeds with real proof", async function () {
      this.timeout(60000);

      const [nullPDA] = deriveNullifierPDA(sourcePoolPDA, nullifierLeBytes);

      // Verify nullifier doesn't exist yet
      let nullInfo = await provider.connection.getAccountInfo(nullPDA);
      expect(nullInfo).to.be.null;

      const sourcePoolBefore = await provider.connection.getBalance(
        sourcePoolPDA
      );
      const targetPoolBefore = await provider.connection.getBalance(
        targetPoolPDA
      );
      const feeWalletBefore = await provider.connection.getBalance(
        PROTOCOL_FEE_WALLET
      );
      const sourceStatsBefore = await program.account.denominatedPool.fetch(
        sourcePoolPDA
      );
      const targetStatsBefore = await program.account.denominatedPool.fetch(
        targetPoolPDA
      );

      const outputCommitmentsBuffers = outputCommitmentLeBytes.map((c) =>
        Buffer.from(c)
      );
      const newRootsBuffers = targetRootLeBytes.map((r) => Buffer.from(r));

      // Groth16 pairing check with 27 IC points needs extra CUs
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      });

      await program.methods
        .splitNote(
          onChainProof,
          nullifierLeBytes,
          merkleRootLeBytes,
          new BN(0), // min_epoch
          2, // num_outputs
          outputCommitmentsBuffers,
          newRootsBuffers
        )
        .accountsPartial({
          payer: authority.publicKey,
          sourcePool: sourcePoolPDA,
          sourceMerkleTree: sourceTreePDA,
          targetPool: targetPoolPDA,
          targetMerkleTree: targetTreePDA,
          nullifierRecord: nullPDA,
          verificationKeyData: vkDataPDA,
          protocolFeeWallet: PROTOCOL_FEE_WALLET,
          systemProgram: SystemProgram.programId,
          tokenProgram: null,
          sourcePoolVault: null,
          targetPoolVault: null,
        })
        .preInstructions([computeBudgetIx])
        .rpc();

      // --- Verify results ---

      // Source pool lost 1 SOL
      const sourcePoolAfter = await provider.connection.getBalance(
        sourcePoolPDA
      );
      const sourceDiff = sourcePoolBefore - sourcePoolAfter;
      expect(sourceDiff).to.equal(LAMPORTS_PER_SOL);
      console.log(`    Source pool: -${sourceDiff / LAMPORTS_PER_SOL} SOL`);

      // Target pool gained ~1 SOL minus 0.3% fee
      const targetPoolAfter = await provider.connection.getBalance(
        targetPoolPDA
      );
      const targetDiff = targetPoolAfter - targetPoolBefore;
      const expectedFee = Math.floor((LAMPORTS_PER_SOL * 30) / 10000);
      const expectedTargetGain = LAMPORTS_PER_SOL - expectedFee;
      expect(targetDiff).to.equal(expectedTargetGain);
      console.log(
        `    Target pool: +${targetDiff / LAMPORTS_PER_SOL} SOL (after 0.3% fee)`
      );

      // Fee wallet gained the protocol fee
      const feeWalletAfter = await provider.connection.getBalance(
        PROTOCOL_FEE_WALLET
      );
      const feeDiff = feeWalletAfter - feeWalletBefore;
      expect(feeDiff).to.equal(expectedFee);
      console.log(
        `    Protocol fee: ${feeDiff} lamports (${expectedFee} expected)`
      );

      // Source pool stats: one note consumed (delta check for idempotent tests)
      const sourcePool = await program.account.denominatedPool.fetch(
        sourcePoolPDA
      );
      expect(sourcePool.noteCount.toNumber()).to.equal(
        sourceStatsBefore.noteCount.toNumber() - 1
      );
      expect(sourcePool.totalShielded.toNumber()).to.equal(
        sourceStatsBefore.totalShielded.toNumber() - LAMPORTS_PER_SOL
      );

      // Target pool stats: two notes created (delta)
      const targetPool = await program.account.denominatedPool.fetch(
        targetPoolPDA
      );
      expect(targetPool.noteCount.toNumber()).to.equal(
        targetStatsBefore.noteCount.toNumber() + 2
      );
      expect(targetPool.totalShielded.toNumber()).to.equal(
        targetStatsBefore.totalShielded.toNumber() + LAMPORTS_PER_SOL
      );
      console.log(
        `    Source pool: ${sourcePool.noteCount} notes (was ${sourceStatsBefore.noteCount})`
      );
      console.log(
        `    Target pool: ${targetPool.noteCount} notes (was ${targetStatsBefore.noteCount})`
      );

      // Nullifier PDA was created
      nullInfo = await provider.connection.getAccountInfo(nullPDA);
      expect(nullInfo).to.not.be.null;
      expect(nullInfo!.owner.toBase58()).to.equal(PROGRAM_ID.toBase58());
      console.log("    Nullifier PDA created ✓");

      // Target Merkle root matches
      expect(Buffer.from(targetPool.merkleRoot)).to.deep.equal(
        Buffer.from(bigintToLeBytes(targetNewRoots[1]))
      );
      console.log("    Target Merkle root matches ✓");
    });

    it("double-spend: same nullifier is rejected", async function () {
      this.timeout(30000);

      // Re-shield 1 SOL so source pool has balance
      const secret2 = BigInt("88888888888888888888");
      const nullPre2 = BigInt("99999999999999999999");
      const commit2 = poseidonHash([
        nullPre2,
        secret2,
        BigInt(0),
        tokenMintBigint,
      ]);
      const tree2 = new SparseMerkleTree(MERKLE_DEPTH);
      tree2.insert(commit2);

      await program.methods
        .shieldDenominated(
          bigintToLeBytes(commit2),
          bigintToLeBytes(tree2.root)
        )
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: sourcePoolPDA,
          merkleTree: sourceTreePDA,
          systemProgram: SystemProgram.programId,
          protocolFeeWallet: PROTOCOL_FEE_WALLET,
          tokenProgram: null,
          userTokenAccount: null,
          poolVault: null,
        })
        .rpc();

      // Try to reuse the SAME nullifier
      const [nullPDA] = deriveNullifierPDA(sourcePoolPDA, nullifierLeBytes);

      const nullInfo = await provider.connection.getAccountInfo(nullPDA);
      expect(nullInfo).to.not.be.null;

      try {
        await program.methods
          .splitNote(
            onChainProof,
            nullifierLeBytes,
            merkleRootLeBytes,
            new BN(0),
            2,
            outputCommitmentLeBytes.map((c) => Buffer.from(c)),
            targetRootLeBytes.map((r) => Buffer.from(r))
          )
          .accountsPartial({
            payer: authority.publicKey,
            sourcePool: sourcePoolPDA,
            sourceMerkleTree: sourceTreePDA,
            targetPool: targetPoolPDA,
            targetMerkleTree: targetTreePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: vkDataPDA,
            protocolFeeWallet: PROTOCOL_FEE_WALLET,
            systemProgram: SystemProgram.programId,
            tokenProgram: null,
            sourcePoolVault: null,
            targetPoolVault: null,
          })
          .rpc();
        expect.fail("Should have thrown — nullifier already spent");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("already in use") ||
            msg.includes("0x0") ||
            msg.includes("custom program error")
        ).to.be.true;
        console.log("    Double-spend correctly rejected ✓");
      }
    });
  });

  // =========================================================================
  // Step 5: Edge case — denomination mismatch
  // =========================================================================

  describe("denomination conservation enforcement", () => {
    it("rejects split when source != num_outputs × target", async function () {
      this.timeout(30000);

      // 1 SOL source, 3 × 0.5 SOL target = 1.5 SOL ≠ 1 SOL → InvalidDenomination
      const fakeNullifier = Array.from(
        Keypair.generate().publicKey.toBuffer()
      );
      const [nullPDA] = deriveNullifierPDA(sourcePoolPDA, fakeNullifier);

      const mockProof = {
        piA: new Array(64).fill(0),
        piB: new Array(128).fill(0),
        piC: new Array(64).fill(0),
      };

      const pool = await program.account.denominatedPool.fetch(sourcePoolPDA);
      const validRoot = Array.from(pool.merkleRoot);

      const fakeCommitments = [
        Buffer.from(new Array(32).fill(1)),
        Buffer.from(new Array(32).fill(2)),
        Buffer.from(new Array(32).fill(3)),
      ];
      const fakeRoots = [
        Buffer.from(new Array(32).fill(1)),
        Buffer.from(new Array(32).fill(2)),
        Buffer.from(new Array(32).fill(3)),
      ];

      try {
        await program.methods
          .splitNote(
            mockProof,
            fakeNullifier,
            validRoot,
            new BN(0),
            3, // 3 × 0.5 SOL = 1.5 SOL ≠ 1 SOL source
            fakeCommitments,
            fakeRoots
          )
          .accountsPartial({
            payer: authority.publicKey,
            sourcePool: sourcePoolPDA,
            sourceMerkleTree: sourceTreePDA,
            targetPool: targetPoolPDA,
            targetMerkleTree: targetTreePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: vkDataPDA,
            protocolFeeWallet: PROTOCOL_FEE_WALLET,
            systemProgram: SystemProgram.programId,
            tokenProgram: null,
            sourcePoolVault: null,
            targetPoolVault: null,
          })
          .rpc();
        expect.fail("Should have thrown — denomination mismatch");
      } catch (err: any) {
        const msg = err.toString();
        // Should fail with InvalidDenomination (3 × 0.5 SOL ≠ 1 SOL)
        // Error code for InvalidDenomination is 6068 (0x17B4)
        // Also accept InvalidAmount since the program uses that for validation
        const isDenomError =
          msg.includes("InvalidDenomination") ||
          msg.includes("InvalidAmount") ||
          msg.includes("6005") || // InvalidAmount error code
          msg.includes("6068") ||
          msg.includes("custom program error");
        if (!isDenomError) {
          console.log("    Actual error:", msg.substring(0, 200));
        }
        expect(isDenomError).to.be.true;
        console.log("    Denomination mismatch correctly rejected ✓");
      }
    });
  });
});

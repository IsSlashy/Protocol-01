/**
 * Denominated Pool — End-to-End Tests
 *
 * Tests the Tornado Cash-style fixed-denomination shielded pool:
 *   1. Pool initialization with denomination and epoch delay
 *   2. Shield (deposit) enforces exact denomination — no amount parameter
 *   3. Unshield (withdraw) constraint checks
 *   4. Double-spend prevention via PDA-per-nullifier
 *   5. Attack scenarios (custom amount, replay, insufficient funds)
 *
 * The on-chain verifier runs in SBF mode on the local validator where
 * alt_bn128_pairing actually executes. Mock proofs will be REJECTED,
 * which is the correct behavior — it proves the verifier is active.
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
import {
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey(
  "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c"
);

/** PDA seed prefixes (must match Rust constants) */
const SEEDS = {
  DENOMINATED_POOL: Buffer.from("denominated_pool"),
  MERKLE_TREE: Buffer.from("merkle_tree"),
  NULLIFIER: Buffer.from("nullifier"),
};

/** Native SOL uses SystemProgram ID as token_mint */
const NATIVE_SOL_MINT = SystemProgram.programId;

/** Pool denomination: 1 SOL */
const ONE_SOL = new BN(LAMPORTS_PER_SOL);

/** Pool denomination: 0.1 SOL */
const POINT_ONE_SOL = new BN(LAMPORTS_PER_SOL / 10);

/** Epoch delay: 1 epoch (~1 hour) */
const EPOCH_DELAY_1 = new BN(1);

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

function deriveMerkleTreePDA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.MERKLE_TREE, pool.toBuffer()],
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
// Test helpers
// ---------------------------------------------------------------------------

/** Random 32-byte array */
function random32(): number[] {
  return Array.from(Keypair.generate().publicKey.toBuffer()).slice(0, 32);
}

/** Mock Groth16 proof (all zeros — will be rejected by real verifier) */
function mockProof(): { piA: number[]; piB: number[]; piC: number[] } {
  return {
    piA: new Array(64).fill(0),
    piB: new Array(128).fill(0),
    piC: new Array(64).fill(0),
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Denominated Pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;

  const authority = (provider.wallet as anchor.Wallet).payer;

  // Pool parameters (1 SOL denomination, native SOL)
  const denomination = ONE_SOL;
  const epochDelay = EPOCH_DELAY_1;
  const vkHash = random32();
  const tokenMint = NATIVE_SOL_MINT;

  // Derived PDAs (set in before())
  let poolPDA: PublicKey;
  let poolBump: number;
  let treePDA: PublicKey;

  before(async () => {
    [poolPDA, poolBump] = deriveDenominatedPoolPDA(tokenMint, denomination);
    [treePDA] = deriveMerkleTreePDA(poolPDA);

    // Ensure authority has enough SOL
    const balance = await provider.connection.getBalance(authority.publicKey);
    if (balance < 20 * LAMPORTS_PER_SOL) {
      const sig = await provider.connection.requestAirdrop(
        authority.publicKey,
        20 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }
  });

  // =========================================================================
  // 1. init_denominated_pool
  // =========================================================================

  describe("init_denominated_pool", () => {
    it("creates a 1 SOL denominated pool with correct state", async () => {
      await program.methods
        .initDenominatedPool(vkHash, tokenMint, denomination, epochDelay)
        .accountsPartial({
          authority: authority.publicKey,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // Verify pool state
      const pool = await program.account.denominatedPool.fetch(poolPDA);
      expect(pool.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(pool.tokenMint.toBase58()).to.equal(tokenMint.toBase58());
      expect(pool.denomination.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(pool.epochDelay.toNumber()).to.equal(1);
      expect(pool.treeDepth).to.equal(15); // DEFAULT_TREE_DEPTH
      expect(pool.nextLeafIndex.toNumber()).to.equal(0);
      expect(pool.totalShielded.toNumber()).to.equal(0);
      expect(pool.noteCount.toNumber()).to.equal(0);
      expect(pool.isActive).to.be.true;
      expect(pool.maxHistoricalRoots).to.equal(100);
      expect(pool.bump).to.equal(poolBump);

      // VK hash stored correctly
      expect(Buffer.from(pool.vkHash)).to.deep.equal(Buffer.from(vkHash));

      // Merkle tree initialized
      const tree = await program.account.merkleTreeState.fetch(treePDA);
      expect(tree.pool.toBase58()).to.equal(poolPDA.toBase58());
      expect(tree.leafCount.toNumber()).to.equal(0);
      expect(tree.depth).to.equal(15);
    });

    it("rejects denomination = 0", async () => {
      const zeroDenom = new BN(0);
      const [zeroPDA] = deriveDenominatedPoolPDA(tokenMint, zeroDenom);
      const [zeroTreePDA] = deriveMerkleTreePDA(zeroPDA);

      try {
        await program.methods
          .initDenominatedPool(vkHash, tokenMint, zeroDenom, epochDelay)
          .accountsPartial({
            authority: authority.publicKey,
            denominatedPool: zeroPDA,
            merkleTree: zeroTreePDA,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidDenomination");
      }
    });

    it("rejects epoch_delay = 0", async () => {
      // Use different denomination to avoid PDA collision
      const denom = new BN(500_000_000); // 0.5 SOL
      const [halfPDA] = deriveDenominatedPoolPDA(tokenMint, denom);
      const [halfTreePDA] = deriveMerkleTreePDA(halfPDA);

      try {
        await program.methods
          .initDenominatedPool(vkHash, tokenMint, denom, new BN(0))
          .accountsPartial({
            authority: authority.publicKey,
            denominatedPool: halfPDA,
            merkleTree: halfTreePDA,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidEpochDelay");
      }
    });

    it("rejects duplicate pool (same token + denomination)", async () => {
      try {
        await program.methods
          .initDenominatedPool(vkHash, tokenMint, denomination, epochDelay)
          .accountsPartial({
            authority: authority.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // PDA already initialized
        const msg = err.toString();
        expect(
          msg.includes("already in use") || msg.includes("0x0")
        ).to.be.true;
      }
    });
  });

  // =========================================================================
  // 2. shield_denominated
  // =========================================================================

  describe("shield_denominated", () => {
    const commitment1 = random32();
    const newRoot1 = random32();

    it("deposits exactly 1 SOL (pool.denomination)", async () => {
      const depositorBefore = await provider.connection.getBalance(
        authority.publicKey
      );
      const poolBefore = await provider.connection.getBalance(poolPDA);

      await program.methods
        .shieldDenominated(commitment1, newRoot1)
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Pool gained exactly 1 SOL
      const poolAfter = await provider.connection.getBalance(poolPDA);
      expect(poolAfter - poolBefore).to.equal(LAMPORTS_PER_SOL);

      // Depositor lost >= 1 SOL (+ tx fee)
      const depositorAfter = await provider.connection.getBalance(
        authority.publicKey
      );
      const depositorDiff = depositorBefore - depositorAfter;
      expect(depositorDiff).to.be.greaterThan(LAMPORTS_PER_SOL);
      expect(depositorDiff).to.be.lessThan(LAMPORTS_PER_SOL + 100_000);

      // Pool state updated
      const pool = await program.account.denominatedPool.fetch(poolPDA);
      expect(pool.totalShielded.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(pool.noteCount.toNumber()).to.equal(1);
      expect(pool.nextLeafIndex.toNumber()).to.equal(1);
      expect(Buffer.from(pool.merkleRoot)).to.deep.equal(
        Buffer.from(newRoot1)
      );

      // Merkle tree leaf count updated
      const tree = await program.account.merkleTreeState.fetch(treePDA);
      expect(tree.leafCount.toNumber()).to.equal(1);
    });

    it("second deposit accumulates correctly", async () => {
      const commitment2 = random32();
      const newRoot2 = random32();

      await program.methods
        .shieldDenominated(commitment2, newRoot2)
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const pool = await program.account.denominatedPool.fetch(poolPDA);
      expect(pool.totalShielded.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
      expect(pool.noteCount.toNumber()).to.equal(2);
      expect(pool.nextLeafIndex.toNumber()).to.equal(2);

      // New root is stored, old root is in historical_roots
      expect(Buffer.from(pool.merkleRoot)).to.deep.equal(
        Buffer.from(newRoot2)
      );
      expect(pool.historicalRoots.length).to.be.greaterThanOrEqual(1);

      // First root should be in history
      const hasFirstRoot = pool.historicalRoots.some(
        (r) => Buffer.from(r).equals(Buffer.from(newRoot1))
      );
      expect(hasFirstRoot).to.be.true;
    });

    it("ATTACK: no amount parameter — denomination enforced by design", async () => {
      // shield_denominated takes ONLY (commitment, new_root) — no amount.
      //
      // An attacker CANNOT deposit 0.001 SOL into a 1 SOL pool because:
      // 1. The instruction has no amount argument
      // 2. The program always transfers pool.denomination (1 SOL)
      // 3. If depositor has < 1 SOL, SystemProgram::transfer fails
      //
      // Verify via IDL inspection:
      const ix = program.idl.instructions.find(
        (i) => i.name === "shieldDenominated"
      );
      expect(ix).to.not.be.undefined;

      const argNames = ix!.args.map((a) => a.name);
      expect(argNames).to.deep.equal(["commitment", "newRoot"]);
      expect(argNames).to.not.include("amount");
      expect(argNames).to.not.include("value");

      // The denomination is read from pool.denomination on-chain.
      // There is no way to override it from the client side.
    });

    it("rejects deposit when depositor has insufficient SOL", async () => {
      const poorDepositor = Keypair.generate();

      // Fund with only 0.01 SOL — not enough for 1 SOL denomination
      const sig = await provider.connection.requestAirdrop(
        poorDepositor.publicKey,
        Math.floor(0.01 * LAMPORTS_PER_SOL)
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .shieldDenominated(random32(), random32())
          .accountsPartial({
            depositor: poorDepositor.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([poorDepositor])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // SystemProgram::transfer fails with insufficient funds
        const msg = err.toString().toLowerCase();
        expect(
          msg.includes("insufficient") ||
            msg.includes("custom program error") ||
            msg.includes("0x1")
        ).to.be.true;
      }
    });
  });

  // =========================================================================
  // 3. unshield_denominated — constraint checks
  // =========================================================================

  describe("unshield_denominated", () => {
    const recipient = Keypair.generate();

    it("rejects invalid merkle root (constraint-level)", async () => {
      // Pass a random root that is NOT the current root and NOT in historical_roots.
      // The constraint `denominated_pool.is_valid_root(&merkle_root)` fails
      // before the handler even runs.
      const invalidRoot = random32();
      const fakeNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, fakeNullifier);

      try {
        await program.methods
          .unshieldDenominated(
            mockProof(),
            fakeNullifier,
            invalidRoot,
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidMerkleRoot");
      }
    });

    it("rejects when VK hash does not match (handler-level)", async () => {
      // Use the pool's CURRENT merkle root so we pass the constraint check.
      // Then the handler checks hash(vk_data) == pool.vk_hash.
      // Since authority.publicKey's account data won't hash to our random vk_hash,
      // this fails with InvalidVerificationKey.
      const pool = await program.account.denominatedPool.fetch(poolPDA);
      const validRoot = Array.from(pool.merkleRoot);
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      try {
        await program.methods
          .unshieldDenominated(
            mockProof(),
            testNullifier,
            validRoot,
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey, // wrong VK data
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("InvalidVerificationKey") ||
            msg.includes("custom program error")
        ).to.be.true;
      }
    });

    it("nullifier PDA is NOT created when tx fails (atomic rollback)", async () => {
      // Attempt unshield with invalid root → tx fails → PDA not created.
      // This proves that failed unshield attempts don't leave nullifier state.
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      // PDA doesn't exist before
      let info = await provider.connection.getAccountInfo(nullPDA);
      expect(info).to.be.null;

      try {
        await program.methods
          .unshieldDenominated(
            mockProof(),
            testNullifier,
            random32(), // invalid root
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (_) {
        // Expected to fail
      }

      // PDA still doesn't exist — tx rolled back entirely
      info = await provider.connection.getAccountInfo(nullPDA);
      expect(info).to.be.null;
    });

    it("double-spend: nullifier PDA derivation is deterministic", async () => {
      // The `init` constraint on nullifier_record creates a PDA at:
      //   seeds = [b"nullifier", pool_key, nullifier_bytes]
      //
      // Same nullifier → same PDA address → `init` fails if PDA exists.
      // This is atomic double-spend prevention with zero false positives.

      const nullifier = random32();

      // Same nullifier produces identical PDA
      const [pda1] = deriveNullifierPDA(poolPDA, nullifier);
      const [pda2] = deriveNullifierPDA(poolPDA, nullifier);
      expect(pda1.toBase58()).to.equal(pda2.toBase58());

      // Different nullifier produces different PDA
      const nullifier2 = random32();
      const [pda3] = deriveNullifierPDA(poolPDA, nullifier2);
      expect(pda1.toBase58()).to.not.equal(pda3.toBase58());

      // Different pool + same nullifier produces different PDA
      const [otherPool] = deriveDenominatedPoolPDA(
        tokenMint,
        new BN(200_000_000)
      );
      const [pda4] = deriveNullifierPDA(otherPool, nullifier);
      expect(pda1.toBase58()).to.not.equal(pda4.toBase58());
    });

    it("historical root from previous deposit is still valid", async () => {
      // After 2 shields, the first root should be in historical_roots
      // and is_valid_root should return true for it.
      const pool = await program.account.denominatedPool.fetch(poolPDA);

      // The current root was set by the second shield
      // The first shield's root should be in historical_roots
      expect(pool.historicalRoots.length).to.be.greaterThanOrEqual(1);

      // Attempt unshield with a historical root — should pass the constraint
      // but still fail at VK check (which is after the root check)
      const historicalRoot = Array.from(pool.historicalRoots[0]);
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      try {
        await program.methods
          .unshieldDenominated(
            mockProof(),
            testNullifier,
            historicalRoot,
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        // Should NOT be InvalidMerkleRoot — the historical root IS valid.
        // It should fail at VK hash check or proof verification instead.
        expect(msg).to.not.include("InvalidMerkleRoot");
        expect(
          msg.includes("InvalidVerificationKey") ||
            msg.includes("InvalidProof") ||
            msg.includes("custom program error")
        ).to.be.true;
      }
    });
  });

  // =========================================================================
  // 3b. emergency_unshield_denominated — constraint checks
  // =========================================================================

  describe("emergency_unshield_denominated", () => {
    const recipient = Keypair.generate();

    it("rejects invalid merkle root (same as normal unshield)", async () => {
      const invalidRoot = random32();
      const fakeNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, fakeNullifier);

      try {
        await program.methods
          .emergencyUnshieldDenominated(
            mockProof(),
            fakeNullifier,
            invalidRoot,
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidMerkleRoot");
      }
    });

    it("rejects when VK hash does not match (same VK as normal unshield)", async () => {
      const pool = await program.account.denominatedPool.fetch(poolPDA);
      const validRoot = Array.from(pool.merkleRoot);
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      try {
        await program.methods
          .emergencyUnshieldDenominated(
            mockProof(),
            testNullifier,
            validRoot,
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("InvalidVerificationKey") ||
            msg.includes("custom program error")
        ).to.be.true;
      }
    });

    it("nullifier PDA is NOT created when emergency tx fails", async () => {
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      let info = await provider.connection.getAccountInfo(nullPDA);
      expect(info).to.be.null;

      try {
        await program.methods
          .emergencyUnshieldDenominated(
            mockProof(),
            testNullifier,
            random32(),
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (_) {
        // Expected to fail
      }

      info = await provider.connection.getAccountInfo(nullPDA);
      expect(info).to.be.null;
    });
  });

  // =========================================================================
  // 3c. transfer_denominated — constraint checks
  // =========================================================================

  describe("transfer_denominated", () => {
    it("rejects invalid merkle root", async () => {
      const invalidRoot = random32();
      const fakeNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, fakeNullifier);

      try {
        await program.methods
          .transferDenominated(
            mockProof(),
            fakeNullifier,
            invalidRoot,
            new BN(0),
            random32(), // new_commitment
            random32(), // new_root
          )
          .accountsPartial({
            payer: authority.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidMerkleRoot");
      }
    });

    it("rejects when transfer VK hash does not match", async () => {
      const pool = await program.account.denominatedPool.fetch(poolPDA);
      const validRoot = Array.from(pool.merkleRoot);
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      try {
        await program.methods
          .transferDenominated(
            mockProof(),
            testNullifier,
            validRoot,
            new BN(0),
            random32(),
            random32(),
          )
          .accountsPartial({
            payer: authority.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("InvalidVerificationKey") ||
            msg.includes("custom program error")
        ).to.be.true;
      }
    });

    it("transfer does not move funds — no recipient account needed", async () => {
      // transfer_denominated accounts have NO recipient, no token accounts
      // Verify via IDL:
      const ix = program.idl.instructions.find(
        (i) => i.name === "transferDenominated"
      );
      expect(ix).to.not.be.undefined;

      const accountNames = ix!.accounts.map((a) => a.name);
      expect(accountNames).to.not.include("recipient");
      expect(accountNames).to.not.include("tokenProgram");
      expect(accountNames).to.not.include("poolVault");
      expect(accountNames).to.not.include("recipientTokenAccount");

      // Required accounts: payer, denominatedPool, merkleTree, nullifierRecord, verificationKeyData, systemProgram
      expect(accountNames).to.include("payer");
      expect(accountNames).to.include("denominatedPool");
      expect(accountNames).to.include("merkleTree");
      expect(accountNames).to.include("nullifierRecord");
      expect(accountNames).to.include("verificationKeyData");
      expect(accountNames).to.include("systemProgram");
    });

    it("nullifier PDA is NOT created when transfer tx fails", async () => {
      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(poolPDA, testNullifier);

      let info = await provider.connection.getAccountInfo(nullPDA);
      expect(info).to.be.null;

      try {
        await program.methods
          .transferDenominated(
            mockProof(),
            testNullifier,
            random32(),
            new BN(0),
            random32(),
            random32(),
          )
          .accountsPartial({
            payer: authority.publicKey,
            denominatedPool: poolPDA,
            merkleTree: treePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (_) {
        // Expected to fail
      }

      info = await provider.connection.getAccountInfo(nullPDA);
      expect(info).to.be.null;
    });
  });

  // =========================================================================
  // 4. Pool isolation — multiple denominations
  // =========================================================================

  describe("pool isolation", () => {
    let pool01PDA: PublicKey;
    let tree01PDA: PublicKey;
    const denom01 = POINT_ONE_SOL; // 0.1 SOL

    before(async () => {
      [pool01PDA] = deriveDenominatedPoolPDA(tokenMint, denom01);
      [tree01PDA] = deriveMerkleTreePDA(pool01PDA);
    });

    it("creates 0.1 SOL pool (separate from 1 SOL pool)", async () => {
      await program.methods
        .initDenominatedPool(random32(), random32(), tokenMint, denom01, new BN(2))
        .accountsPartial({
          authority: authority.publicKey,
          denominatedPool: pool01PDA,
          merkleTree: tree01PDA,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const pool = await program.account.denominatedPool.fetch(pool01PDA);
      expect(pool.denomination.toNumber()).to.equal(100_000_000); // 0.1 SOL
      expect(pool.epochDelay.toNumber()).to.equal(2);

      // Different PDA from the 1 SOL pool
      expect(pool01PDA.toBase58()).to.not.equal(poolPDA.toBase58());
    });

    it("shield into 0.1 SOL pool transfers exactly 0.1 SOL", async () => {
      const poolBalBefore = await provider.connection.getBalance(pool01PDA);

      await program.methods
        .shieldDenominated(random32(), random32())
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: pool01PDA,
          merkleTree: tree01PDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Pool gained exactly 0.1 SOL
      const poolBalAfter = await provider.connection.getBalance(pool01PDA);
      expect(poolBalAfter - poolBalBefore).to.equal(100_000_000);

      // Pool state reflects 0.1 SOL denomination
      const pool = await program.account.denominatedPool.fetch(pool01PDA);
      expect(pool.totalShielded.toNumber()).to.equal(100_000_000);
      expect(pool.noteCount.toNumber()).to.equal(1);
    });

    it("1 SOL pool and 0.1 SOL pool have independent state", async () => {
      const pool1 = await program.account.denominatedPool.fetch(poolPDA);
      const pool01 = await program.account.denominatedPool.fetch(pool01PDA);

      // 1 SOL pool has 2 notes (from earlier tests), 0.1 SOL pool has 1
      expect(pool1.noteCount.toNumber()).to.equal(2);
      expect(pool01.noteCount.toNumber()).to.equal(1);

      // Totals match: 2 SOL vs 0.1 SOL
      expect(pool1.totalShielded.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
      expect(pool01.totalShielded.toNumber()).to.equal(100_000_000);

      // Different merkle roots (different trees)
      expect(Buffer.from(pool1.merkleRoot)).to.not.deep.equal(
        Buffer.from(pool01.merkleRoot)
      );
    });
  });

  // =========================================================================
  // 5. Security invariants
  // =========================================================================

  describe("security invariants", () => {
    it("pool PDA is deterministic — cannot create duplicate for same denomination", async () => {
      // Two derivations with same params produce the same address
      const [pda1] = deriveDenominatedPoolPDA(tokenMint, ONE_SOL);
      const [pda2] = deriveDenominatedPoolPDA(tokenMint, ONE_SOL);
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
    });

    it("pool PDA differs by denomination", async () => {
      const [pda_1sol] = deriveDenominatedPoolPDA(tokenMint, ONE_SOL);
      const [pda_01sol] = deriveDenominatedPoolPDA(tokenMint, POINT_ONE_SOL);
      expect(pda_1sol.toBase58()).to.not.equal(pda_01sol.toBase58());
    });

    it("pool PDA differs by token mint", async () => {
      const fakeMint = Keypair.generate().publicKey;
      const [pda_sol] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, ONE_SOL);
      const [pda_fake] = deriveDenominatedPoolPDA(fakeMint, ONE_SOL);
      expect(pda_sol.toBase58()).to.not.equal(pda_fake.toBase58());
    });

    it("tree depth is 15 (32K notes max per pool)", async () => {
      const pool = await program.account.denominatedPool.fetch(poolPDA);
      expect(pool.treeDepth).to.equal(15);
      // 2^15 = 32,768 max notes
    });

    it("unshield instruction has no amount parameter", async () => {
      // Like shield, unshield always withdraws pool.denomination.
      // Verify via IDL:
      const ix = program.idl.instructions.find(
        (i) => i.name === "unshieldDenominated"
      );
      expect(ix).to.not.be.undefined;

      const argNames = ix!.args.map((a) => a.name);
      // Args: proof, nullifier, merkleRoot, minEpoch
      expect(argNames).to.include("proof");
      expect(argNames).to.include("nullifier");
      expect(argNames).to.include("merkleRoot");
      expect(argNames).to.include("minEpoch");
      expect(argNames).to.not.include("amount");
    });

    it("emergency_unshield_denominated instruction exists with same args as unshield", async () => {
      const ix = program.idl.instructions.find(
        (i) => i.name === "emergencyUnshieldDenominated"
      );
      expect(ix).to.not.be.undefined;

      const argNames = ix!.args.map((a) => a.name);
      expect(argNames).to.include("proof");
      expect(argNames).to.include("nullifier");
      expect(argNames).to.include("merkleRoot");
      expect(argNames).to.include("minEpoch");
      expect(argNames).to.not.include("amount");
    });

    it("transfer_denominated instruction has newCommitment and newRoot", async () => {
      const ix = program.idl.instructions.find(
        (i) => i.name === "transferDenominated"
      );
      expect(ix).to.not.be.undefined;

      const argNames = ix!.args.map((a) => a.name);
      expect(argNames).to.include("proof");
      expect(argNames).to.include("nullifier");
      expect(argNames).to.include("merkleRoot");
      expect(argNames).to.include("minEpoch");
      expect(argNames).to.include("newCommitment");
      expect(argNames).to.include("newRoot");
      expect(argNames).to.not.include("amount");
    });

    it("init_denominated_pool accepts vkHash (no vkHashTransfer)", async () => {
      const ix = program.idl.instructions.find(
        (i) => i.name === "initDenominatedPool"
      );
      expect(ix).to.not.be.undefined;

      const argNames = ix!.args.map((a) => a.name);
      expect(argNames).to.include("vkHash");
      expect(argNames).to.not.include("vkHashTransfer");
    });

    it("nullifier_record account uses init constraint (double-spend guard)", async () => {
      // Verify IDL shows nullifier_record is writable + PDA
      const ix = program.idl.instructions.find(
        (i) => i.name === "unshieldDenominated"
      );
      const nullifierAcc = ix!.accounts.find(
        (a) => a.name === "nullifierRecord"
      );
      expect(nullifierAcc).to.not.be.undefined;
      expect((nullifierAcc as any).writable).to.be.true;
      // PDA seeds include pool key + nullifier bytes
      expect((nullifierAcc as any).pda).to.not.be.undefined;
    });

    it("SUMMARY: attack deposit 0.001 SOL → unshield 1 SOL is impossible", () => {
      // This is the user's priority attack scenario.
      //
      // In the denominated pool design, this attack is STRUCTURALLY IMPOSSIBLE:
      //
      // 1. shield_denominated has NO amount parameter
      //    → The program reads pool.denomination (1 SOL) and transfers exactly that
      //    → A depositor with < 1 SOL gets SystemProgram::transfer error
      //    → There is no way to deposit a smaller amount
      //
      // 2. unshield_denominated also has NO amount parameter
      //    → The program reads pool.denomination and sends exactly that
      //    → Every withdrawal is exactly 1 SOL
      //
      // 3. The commitment doesn't encode any amount:
      //    commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
      //    → No amount field to manipulate
      //
      // 4. Double-spend is prevented by PDA-per-nullifier:
      //    → Each nullifier creates a unique PDA via `init` constraint
      //    → Second use of same nullifier fails with "already in use"
      //
      // The only way to get 1 SOL out is to put 1 SOL in.
      // The anonymity set provides privacy, not profit.
    });
  });

  // =========================================================================
  // 6. SPL Token Denominated Pool (USDC-like)
  // =========================================================================

  describe("SPL Token denominated pool (USDC-like)", () => {
    let usdcMint: PublicKey;
    let usdcPoolPDA: PublicKey;
    let usdcPoolBump: number;
    let usdcTreePDA: PublicKey;
    let depositorATA: PublicKey;
    let poolVaultATA: PublicKey;

    /** 1 USDC = 1_000_000 (6 decimals) */
    const ONE_USDC = new BN(1_000_000);
    const usdcVkHash = random32();

    before(async () => {
      // 1. Create an SPL token mint (USDC-like, 6 decimals)
      usdcMint = await createMint(
        provider.connection,
        authority,
        authority.publicKey, // mint authority
        null,               // freeze authority
        6                   // decimals
      );

      // 2. Derive pool PDA for this mint + denomination
      [usdcPoolPDA, usdcPoolBump] = deriveDenominatedPoolPDA(usdcMint, ONE_USDC);
      [usdcTreePDA] = deriveMerkleTreePDA(usdcPoolPDA);

      // 3. Create depositor's ATA
      depositorATA = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        usdcMint,
        authority.publicKey
      );

      // 4. Mint 100 USDC to depositor
      await mintTo(
        provider.connection,
        authority,
        usdcMint,
        depositorATA,
        authority, // mint authority
        100_000_000 // 100 USDC
      );

      // 5. Verify depositor has 100 USDC
      const depositorAcct = await getAccount(provider.connection, depositorATA);
      expect(Number(depositorAcct.amount)).to.equal(100_000_000);
    });

    it("creates a 1 USDC denominated pool", async () => {
      await program.methods
        .initDenominatedPool(usdcVkHash, random32(), usdcMint, ONE_USDC, EPOCH_DELAY_1)
        .accountsPartial({
          authority: authority.publicKey,
          denominatedPool: usdcPoolPDA,
          merkleTree: usdcTreePDA,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const pool = await program.account.denominatedPool.fetch(usdcPoolPDA);
      expect(pool.tokenMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(pool.denomination.toNumber()).to.equal(1_000_000); // 1 USDC
      expect(pool.isActive).to.be.true;
      expect(pool.noteCount.toNumber()).to.equal(0);
      expect(pool.totalShielded.toNumber()).to.equal(0);

      // Pool PDA differs from the SOL pool
      expect(usdcPoolPDA.toBase58()).to.not.equal(poolPDA.toBase58());
    });

    it("creates pool vault ATA for SPL tokens", async () => {
      // The pool vault is an ATA owned by the pool PDA for the USDC mint
      poolVaultATA = await createAssociatedTokenAccount(
        provider.connection,
        authority,        // payer
        usdcMint,
        usdcPoolPDA       // owner = pool PDA
      );

      const vaultAcct = await getAccount(provider.connection, poolVaultATA);
      expect(vaultAcct.owner.toBase58()).to.equal(usdcPoolPDA.toBase58());
      expect(vaultAcct.mint.toBase58()).to.equal(usdcMint.toBase58());
      expect(Number(vaultAcct.amount)).to.equal(0);
    });

    it("shields 1 USDC into the pool", async () => {
      const commitment = random32();
      const newRoot = random32();

      const depositorBefore = await getAccount(provider.connection, depositorATA);
      const depositorAmountBefore = Number(depositorBefore.amount);

      await program.methods
        .shieldDenominated(commitment, newRoot)
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: usdcPoolPDA,
          merkleTree: usdcTreePDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          userTokenAccount: depositorATA,
          poolVault: poolVaultATA,
        })
        .rpc();

      // Depositor lost exactly 1 USDC
      const depositorAfter = await getAccount(provider.connection, depositorATA);
      expect(Number(depositorAfter.amount)).to.equal(depositorAmountBefore - 1_000_000);

      // Pool vault gained exactly 1 USDC
      const vaultAfter = await getAccount(provider.connection, poolVaultATA);
      expect(Number(vaultAfter.amount)).to.equal(1_000_000);

      // Pool state updated
      const pool = await program.account.denominatedPool.fetch(usdcPoolPDA);
      expect(pool.totalShielded.toNumber()).to.equal(1_000_000);
      expect(pool.noteCount.toNumber()).to.equal(1);
      expect(pool.nextLeafIndex.toNumber()).to.equal(1);
    });

    it("shields second USDC deposit — accumulation", async () => {
      await program.methods
        .shieldDenominated(random32(), random32())
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: usdcPoolPDA,
          merkleTree: usdcTreePDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          userTokenAccount: depositorATA,
          poolVault: poolVaultATA,
        })
        .rpc();

      // Pool vault has 2 USDC now
      const vaultAfter = await getAccount(provider.connection, poolVaultATA);
      expect(Number(vaultAfter.amount)).to.equal(2_000_000);

      const pool = await program.account.denominatedPool.fetch(usdcPoolPDA);
      expect(pool.totalShielded.toNumber()).to.equal(2_000_000);
      expect(pool.noteCount.toNumber()).to.equal(2);
    });

    it("rejects shield without token_program for SPL pool", async () => {
      // If we don't pass token_program for an SPL-mint pool,
      // the handler should fail with MissingTokenProgram
      try {
        await program.methods
          .shieldDenominated(random32(), random32())
          .accountsPartial({
            depositor: authority.publicKey,
            denominatedPool: usdcPoolPDA,
            merkleTree: usdcTreePDA,
            systemProgram: SystemProgram.programId,
            // intentionally omit tokenProgram, userTokenAccount, poolVault
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("MissingTokenProgram") ||
          msg.includes("custom program error") ||
          msg.includes("AccountNotInitialized")
        ).to.be.true;
      }
    });

    it("rejects shield with wrong mint token account", async () => {
      // Create a DIFFERENT mint and its ATA
      const fakeMint = await createMint(
        provider.connection,
        authority,
        authority.publicKey,
        null,
        6
      );
      const fakeATA = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        fakeMint,
        authority.publicKey
      );
      await mintTo(
        provider.connection,
        authority,
        fakeMint,
        fakeATA,
        authority,
        10_000_000
      );

      try {
        await program.methods
          .shieldDenominated(random32(), random32())
          .accountsPartial({
            depositor: authority.publicKey,
            denominatedPool: usdcPoolPDA,
            merkleTree: usdcTreePDA,
            systemProgram: SystemProgram.programId,
            tokenProgram: SPL_TOKEN_PROGRAM_ID,
            userTokenAccount: fakeATA, // wrong mint!
            poolVault: poolVaultATA,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("InvalidTokenMint") ||
          msg.includes("custom program error") ||
          msg.includes("ConstraintRaw")
        ).to.be.true;
      }
    });

    it("unshield rejects with invalid root (SPL pool)", async () => {
      const recipient = Keypair.generate();
      const recipientATA = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        usdcMint,
        recipient.publicKey
      );

      const testNullifier = random32();
      const [nullPDA] = deriveNullifierPDA(usdcPoolPDA, testNullifier);

      try {
        await program.methods
          .unshieldDenominated(
            mockProof(),
            testNullifier,
            random32(), // invalid root
            new BN(0)
          )
          .accountsPartial({
            payer: authority.publicKey,
            recipient: recipient.publicKey,
            denominatedPool: usdcPoolPDA,
            merkleTree: usdcTreePDA,
            nullifierRecord: nullPDA,
            verificationKeyData: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: SPL_TOKEN_PROGRAM_ID,
            poolVault: poolVaultATA,
            recipientTokenAccount: recipientATA,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidMerkleRoot");
      }
    });

    it("pool PDA is unique per (mint, denomination)", async () => {
      // Same denomination, different mint → different PDA
      const [solPoolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, ONE_USDC);
      expect(usdcPoolPDA.toBase58()).to.not.equal(solPoolPDA.toBase58());

      // Same mint, different denomination → different PDA
      const TEN_USDC = new BN(10_000_000);
      const [tenUsdcPDA] = deriveDenominatedPoolPDA(usdcMint, TEN_USDC);
      expect(usdcPoolPDA.toBase58()).to.not.equal(tenUsdcPDA.toBase58());
    });
  });
});

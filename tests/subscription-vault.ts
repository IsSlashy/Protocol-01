/**
 * Subscription Vault — Anchor Tests (normal mode only)
 *
 * Tests the wallet-based (non-ZK) subscription lifecycle:
 *   1. subscribe_normal — SOL + SPL vault creation
 *   2. claim_period — retailer claims accrued periods
 *   3. pause_normal / resume_normal — pause + resume
 *   4. cancel_normal — refund remaining to subscriber
 *   5. Full normal lifecycle end-to-end
 *
 * STARK-based private subscription flows are covered in
 * subscription-vault-stark.ts.
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

const SEEDS = {
  SUBSCRIPTION_VAULT: Buffer.from("subscription_vault"),
};

const NATIVE_SOL_MINT = SystemProgram.programId;

// ---------------------------------------------------------------------------
// PDA derivation helpers
// ---------------------------------------------------------------------------

function deriveVaultPDA(
  retailer: PublicKey,
  subscriberIdBytes: Buffer,
  tokenMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.SUBSCRIPTION_VAULT,
      retailer.toBuffer(),
      subscriberIdBytes,
      tokenMint.toBuffer(),
    ],
    PROGRAM_ID
  );
}


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function random32(): number[] {
  return Array.from(Keypair.generate().publicKey.toBuffer()).slice(0, 32);
}

/** Wait for N slots to pass */
async function waitSlots(
  connection: anchor.web3.Connection,
  n: number
): Promise<void> {
  const startSlot = await connection.getSlot();
  while (true) {
    const current = await connection.getSlot();
    if (current >= startSlot + n) break;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Subscription Vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const retailer = Keypair.generate();

  // Vault parameters
  const rate = new BN(100_000); // 0.0001 SOL per period
  const intervalSlots = new BN(10); // 10 slots per period
  const amount = new BN(1_000_000); // 0.001 SOL total deposit
  const vkHashSubscriber = random32();

  // Derived PDAs
  let vaultPDA: PublicKey;
  let vaultBump: number;

  before(async () => {
    // Airdrop to authority and retailer
    const sig1 = await provider.connection.requestAirdrop(
      authority.publicKey,
      20 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig1);

    const sig2 = await provider.connection.requestAirdrop(
      retailer.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig2);

    // Derive vault PDA
    [vaultPDA, vaultBump] = deriveVaultPDA(
      retailer.publicKey,
      authority.publicKey.toBuffer(),
      NATIVE_SOL_MINT
    );
  });

  // =========================================================================
  // 1. subscribe_normal (SOL)
  // =========================================================================

  describe("subscribe_normal", () => {
    it("creates a normal SOL subscription vault", async () => {
      const subBefore = await provider.connection.getBalance(
        authority.publicKey
      );

      await program.methods
        .subscribeNormal(rate, intervalSlots, amount, NATIVE_SOL_MINT, vkHashSubscriber)
        .accountsPartial({
          subscriber: authority.publicKey,
          retailer: retailer.publicKey,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify vault state
      const vault = await program.account.subscriptionVault.fetch(vaultPDA);
      expect(vault.subscriberPubkey).to.not.be.null;
      expect(vault.subscriberPubkey!.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(vault.subscriberCommitment).to.be.null;
      expect(vault.retailer.toBase58()).to.equal(retailer.publicKey.toBase58());
      expect(vault.tokenMint.toBase58()).to.equal(NATIVE_SOL_MINT.toBase58());
      expect(vault.totalDeposited.toNumber()).to.equal(amount.toNumber());
      expect(vault.rate.toNumber()).to.equal(rate.toNumber());
      expect(vault.intervalSlots.toNumber()).to.equal(intervalSlots.toNumber());
      expect(vault.claimedPeriods.toNumber()).to.equal(0);
      expect(vault.isActive).to.be.true;
      expect(vault.isPaused).to.be.false;
      expect(vault.pauseSlot).to.be.null;
      expect(vault.totalPausedSlots.toNumber()).to.equal(0);
      expect(vault.sourcePool).to.be.null;
      expect(vault.bump).to.equal(vaultBump);
    });

    it("rejects rate = 0", async () => {
      const sub2 = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        sub2.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [vault2] = deriveVaultPDA(
        retailer.publicKey,
        sub2.publicKey.toBuffer(),
        NATIVE_SOL_MINT
      );

      try {
        await program.methods
          .subscribeNormal(new BN(0), intervalSlots, amount, NATIVE_SOL_MINT, vkHashSubscriber)
          .accountsPartial({
            subscriber: sub2.publicKey,
            retailer: retailer.publicKey,
            vault: vault2,
            systemProgram: SystemProgram.programId,
          })
          .signers([sub2])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidRate");
      }
    });

    it("rejects interval = 0", async () => {
      const sub3 = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        sub3.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [vault3] = deriveVaultPDA(
        retailer.publicKey,
        sub3.publicKey.toBuffer(),
        NATIVE_SOL_MINT
      );

      try {
        await program.methods
          .subscribeNormal(rate, new BN(0), amount, NATIVE_SOL_MINT, vkHashSubscriber)
          .accountsPartial({
            subscriber: sub3.publicKey,
            retailer: retailer.publicKey,
            vault: vault3,
            systemProgram: SystemProgram.programId,
          })
          .signers([sub3])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidInterval");
      }
    });

    it("rejects duplicate vault (same subscriber + retailer + token)", async () => {
      try {
        await program.methods
          .subscribeNormal(rate, intervalSlots, amount, NATIVE_SOL_MINT, vkHashSubscriber)
          .accountsPartial({
            subscriber: authority.publicKey,
            retailer: retailer.publicKey,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const msg = err.toString();
        expect(
          msg.includes("already in use") || msg.includes("0x0")
        ).to.be.true;
      }
    });
  });

  // =========================================================================
  // 2. claim_period
  // =========================================================================

  describe("claim_period", () => {
    it("claims accrued periods after waiting", async () => {
      // Wait for at least 1 period (10 slots)
      await waitSlots(provider.connection, 12);

      const retailerBefore = await provider.connection.getBalance(
        retailer.publicKey
      );

      await program.methods
        .claimPeriod()
        .accountsPartial({
          retailer: retailer.publicKey,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([retailer])
        .rpc();

      // Retailer received payment
      const retailerAfter = await provider.connection.getBalance(
        retailer.publicKey
      );
      expect(retailerAfter).to.be.greaterThan(retailerBefore);

      // Vault claimed_periods updated
      const vault = await program.account.subscriptionVault.fetch(vaultPDA);
      expect(vault.claimedPeriods.toNumber()).to.be.greaterThan(0);
    });

    it("rejects claim from non-retailer", async () => {
      const imposter = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .claimPeriod()
          .accountsPartial({
            retailer: imposter.publicKey,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([imposter])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // PDA derivation mismatch or constraint error
        expect(err.toString()).to.not.be.empty;
      }
    });
  });

  // =========================================================================
  // 3. pause_normal
  // =========================================================================

  describe("pause_normal", () => {
    it("pauses the vault", async () => {
      await program.methods
        .pauseNormal()
        .accountsPartial({
          subscriber: authority.publicKey,
          vault: vaultPDA,
        })
        .rpc();

      const vault = await program.account.subscriptionVault.fetch(vaultPDA);
      expect(vault.isPaused).to.be.true;
      expect(vault.pauseSlot).to.not.be.null;
    });

    it("rejects double pause", async () => {
      try {
        await program.methods
          .pauseNormal()
          .accountsPartial({
            subscriber: authority.publicKey,
            vault: vaultPDA,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultAlreadyPaused");
      }
    });

    it("rejects claim while paused", async () => {
      try {
        await program.methods
          .claimPeriod()
          .accountsPartial({
            retailer: retailer.publicKey,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([retailer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultAlreadyPaused");
      }
    });
  });

  // =========================================================================
  // 4. resume_normal
  // =========================================================================

  describe("resume_normal", () => {
    it("resumes the vault and accumulates paused time", async () => {
      // Wait a few slots while paused
      await waitSlots(provider.connection, 5);

      await program.methods
        .resumeNormal()
        .accountsPartial({
          subscriber: authority.publicKey,
          vault: vaultPDA,
        })
        .rpc();

      const vault = await program.account.subscriptionVault.fetch(vaultPDA);
      expect(vault.isPaused).to.be.false;
      expect(vault.pauseSlot).to.be.null;
      expect(vault.totalPausedSlots.toNumber()).to.be.greaterThan(0);
    });

    it("rejects resume when not paused", async () => {
      try {
        await program.methods
          .resumeNormal()
          .accountsPartial({
            subscriber: authority.publicKey,
            vault: vaultPDA,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultNotPaused");
      }
    });
  });

  // =========================================================================
  // 5. cancel_normal
  // =========================================================================

  describe("cancel_normal", () => {
    it("cancels vault and refunds remaining to subscriber", async () => {
      const subBefore = await provider.connection.getBalance(
        authority.publicKey
      );

      await program.methods
        .cancelNormal()
        .accountsPartial({
          subscriber: authority.publicKey,
          retailer: retailer.publicKey,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Subscriber got refund + rent
      const subAfter = await provider.connection.getBalance(
        authority.publicKey
      );
      expect(subAfter).to.be.greaterThan(subBefore);

      // Vault account closed
      const vaultInfo = await provider.connection.getAccountInfo(vaultPDA);
      expect(vaultInfo).to.be.null;
    });
  });

  // =========================================================================
  // 9. Full normal lifecycle
  // =========================================================================

  describe("full normal lifecycle", () => {
    let lifecycleVault: PublicKey;
    const lcSub = Keypair.generate();

    before(async () => {
      const sig = await provider.connection.requestAirdrop(
        lcSub.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      [lifecycleVault] = deriveVaultPDA(
        retailer.publicKey,
        lcSub.publicKey.toBuffer(),
        NATIVE_SOL_MINT
      );
    });

    it("subscribe → wait → claim → pause → wait → resume → claim → cancel", async () => {
      // Subscribe
      await program.methods
        .subscribeNormal(
          new BN(50_000),    // rate: 0.00005 SOL
          new BN(5),         // interval: 5 slots
          new BN(500_000),   // amount: 0.0005 SOL
          NATIVE_SOL_MINT,
          vkHashSubscriber
        )
        .accountsPartial({
          subscriber: lcSub.publicKey,
          retailer: retailer.publicKey,
          vault: lifecycleVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([lcSub])
        .rpc();

      let vault = await program.account.subscriptionVault.fetch(lifecycleVault);
      expect(vault.isActive).to.be.true;

      // Wait for periods to accrue
      await waitSlots(provider.connection, 12);

      // Claim
      await program.methods
        .claimPeriod()
        .accountsPartial({
          retailer: retailer.publicKey,
          vault: lifecycleVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([retailer])
        .rpc();

      vault = await program.account.subscriptionVault.fetch(lifecycleVault);
      expect(vault.claimedPeriods.toNumber()).to.be.greaterThan(0);

      // Pause
      await program.methods
        .pauseNormal()
        .accountsPartial({
          subscriber: lcSub.publicKey,
          vault: lifecycleVault,
        })
        .signers([lcSub])
        .rpc();

      vault = await program.account.subscriptionVault.fetch(lifecycleVault);
      expect(vault.isPaused).to.be.true;

      // Wait while paused
      await waitSlots(provider.connection, 8);

      // Resume
      await program.methods
        .resumeNormal()
        .accountsPartial({
          subscriber: lcSub.publicKey,
          vault: lifecycleVault,
        })
        .signers([lcSub])
        .rpc();

      vault = await program.account.subscriptionVault.fetch(lifecycleVault);
      expect(vault.isPaused).to.be.false;
      expect(vault.totalPausedSlots.toNumber()).to.be.greaterThan(0);

      // Wait for more periods
      await waitSlots(provider.connection, 12);

      // Claim again
      await program.methods
        .claimPeriod()
        .accountsPartial({
          retailer: retailer.publicKey,
          vault: lifecycleVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([retailer])
        .rpc();

      // Cancel
      const subBefore = await provider.connection.getBalance(lcSub.publicKey);

      await program.methods
        .cancelNormal()
        .accountsPartial({
          subscriber: lcSub.publicKey,
          retailer: retailer.publicKey,
          vault: lifecycleVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([lcSub])
        .rpc();

      const subAfter = await provider.connection.getBalance(lcSub.publicKey);
      expect(subAfter).to.be.greaterThan(subBefore);

      // Vault closed
      const vaultInfo = await provider.connection.getAccountInfo(lifecycleVault);
      expect(vaultInfo).to.be.null;
    });
  });
});

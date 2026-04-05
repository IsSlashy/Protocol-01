/**
 * p01_zkspl - Comprehensive End-to-End Test Suite
 *
 * Tests the full lifecycle of zkSPL confidential token operations:
 *   1. Initialize mint config for native SOL
 *   2. Upload verification keys (init_vk_data + write_vk_data)
 *   3. Create confidential accounts for Alice and Bob
 *   4. Alice deposits 100 SOL
 *   5. Alice privately transfers 30 SOL to Bob
 *   6. Bob applies the pending credit
 *   7. Alice withdraws 20 SOL
 *   8. Alice proves balance >= 40 SOL
 *   9. Viewer key management (add + remove)
 *  10. Error cases (wrong signer, overflow, double-apply, etc.)
 *
 * The on-chain verifier returns `true` in non-Solana mode (cfg(not(target_os = "solana"))),
 * so mock Groth16 proofs work for testing account logic on a local validator.
 *
 * Program: EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { P01Zkspl } from "../target/types/p01_zkspl";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey(
  "EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah"
);

const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

/** PDA seed prefixes (must match Rust constants). */
const SEEDS = {
  ZKSPL_MINT: Buffer.from("zkspl_mint"),
  ZKSPL_ACCOUNT: Buffer.from("zkspl_account"),
  ZKSPL_VAULT: Buffer.from("zkspl_vault"),
  ZKSPL_VK: Buffer.from("zkspl_vk"),
};

/** VK types */
const VK_TYPE_BALANCE = 0;
const VK_TYPE_PROOF = 1;

// On-chain VK binary format:
//   alpha_g1(64) | beta_g2(128) | gamma_g2(128) | delta_g2(128) | ic_count(4) | IC[](64 each)
// For the confidential_balance circuit, public inputs = 7, so ic_count = 8 (7+1)
const G1_SIZE = 64;
const G2_SIZE = 128;

// ---------------------------------------------------------------------------
// Poseidon helpers (circomlibjs)
// ---------------------------------------------------------------------------

let poseidon: any;
let F: any; // Finite field

async function initPoseidon(): Promise<void> {
  const circomlibjs = await import("circomlibjs");
  poseidon = await (circomlibjs as any).buildPoseidon();
  F = poseidon.F;
}

function poseidonHash(inputs: bigint[]): bigint {
  const hash = poseidon(inputs.map((x: bigint) => F.e(x)));
  return F.toObject(hash);
}

/** Balance commitment = Poseidon(balance, Poseidon(salt, nonce), owner_pubkey, token_mint) */
function createBalanceCommitment(
  balance: bigint,
  salt: bigint,
  nonce: bigint,
  ownerPubkey: bigint,
  tokenMint: bigint
): bigint {
  const augmentedSalt = poseidonHash([salt, nonce]);
  return poseidonHash([balance, augmentedSalt, ownerPubkey, tokenMint]);
}

/** Amount commitment = Poseidon(amount, amount_salt) */
function createAmountCommitment(amount: bigint, amountSalt: bigint): bigint {
  return poseidonHash([amount, amountSalt]);
}

/** Owner pubkey = Poseidon(spending_key, 0) — domain tag 0 */
function deriveOwnerPubkey(spendingKey: bigint): bigint {
  return poseidonHash([spendingKey, BigInt(0)]);
}

// ---------------------------------------------------------------------------
// Byte conversion helpers
// ---------------------------------------------------------------------------

/** Convert a BigInt to a 32-byte little-endian Uint8Array (for on-chain [u8; 32]). */
function bigintToLeBytes(value: bigint): number[] {
  const buf: number[] = new Array(32).fill(0);
  let val = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

/** Create a mock Groth16Proof (all zeros -- verifier returns true in non-Solana mode). */
function mockProof(): { piA: number[]; piB: number[]; piC: number[] } {
  return {
    piA: new Array(64).fill(0),
    piB: new Array(128).fill(0),
    piC: new Array(64).fill(0),
  };
}

/**
 * Build a minimal valid VK binary blob.
 * Format: alpha_g1(64) | beta_g2(128) | gamma_g2(128) | delta_g2(128) | ic_count(4LE) | IC[](64 each)
 * For the confidential_balance circuit: 7 public inputs => ic_count = 8
 * For the balance_proof circuit: 3 public inputs => ic_count = 4
 */
function buildMockVk(publicInputCount: number): Buffer {
  const icCount = publicInputCount + 1;
  const headerSize = G1_SIZE + G2_SIZE * 3 + 4;
  const totalSize = headerSize + icCount * G1_SIZE;
  const buf = Buffer.alloc(totalSize);

  // Fill with non-zero data so it looks like a real VK (the verifier in test mode
  // doesn't actually process VK contents -- it always returns true)
  buf.fill(0x01, 0, G1_SIZE); // alpha_g1
  buf.fill(0x02, G1_SIZE, G1_SIZE + G2_SIZE); // beta_g2
  buf.fill(0x03, G1_SIZE + G2_SIZE, G1_SIZE + G2_SIZE * 2); // gamma_g2
  buf.fill(0x04, G1_SIZE + G2_SIZE * 2, G1_SIZE + G2_SIZE * 3); // delta_g2

  // ic_count as u32 LE
  const offset = G1_SIZE + G2_SIZE * 3;
  buf.writeUInt32LE(icCount, offset);

  // IC points (just fill with 0x05)
  buf.fill(0x05, offset + 4, offset + 4 + icCount * G1_SIZE);

  return buf;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function deriveMintConfig(
  tokenMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_MINT, tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

function deriveConfidentialAccount(
  owner: PublicKey,
  tokenMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_ACCOUNT, owner.toBuffer(), tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

function deriveVault(
  tokenMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_VAULT, tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

function deriveVkData(
  mintConfigKey: PublicKey,
  vkType: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_VK, mintConfigKey.toBuffer(), Buffer.from([vkType])],
    PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("p01_zkspl", () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.P01Zkspl as Program<P01Zkspl>;

  // Users
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const viewer = Keypair.generate();
  const stranger = Keypair.generate();

  // We use native SOL as the "token" -- represented by system program ID
  const tokenMint = SystemProgram.programId;

  // Derived PDAs (populated in before())
  let mintConfigPDA: PublicKey;
  let mintConfigBump: number;
  let aliceAccountPDA: PublicKey;
  let bobAccountPDA: PublicKey;
  let vaultPDA: PublicKey;
  let balanceVkPDA: PublicKey;
  let proofVkPDA: PublicKey;

  // Crypto state
  const aliceSpendingKey = BigInt("98765432101234567890");
  const bobSpendingKey = BigInt("55555555555555555555");
  let aliceOwnerPubkey: bigint;
  let bobOwnerPubkey: bigint;
  const tokenMintField = BigInt(0); // system_program::ID -> all zeros -> 0 as field element

  // Mock VK hashes (32 bytes each)
  const balanceVkHash = new Array(32).fill(0xab);
  const proofVkHash = new Array(32).fill(0xcd);

  // Track Alice's balance state across tests
  let aliceBalance = 0n;
  let aliceSalt = BigInt("111111111111");
  let aliceCommitment: bigint;
  let aliceNonce = 0;

  // Track Bob's balance state across tests
  let bobBalance = 0n;
  let bobSalt = BigInt("666666666666");
  let bobCommitment: bigint;
  let bobNonce = 0;

  // Amount hash from the transfer (shared between sender and recipient)
  let transferAmountHash: number[];
  let transferAmountSalt: bigint;

  before(async () => {
    // Initialize Poseidon hasher
    await initPoseidon();

    // Derive crypto keys
    aliceOwnerPubkey = deriveOwnerPubkey(aliceSpendingKey);
    bobOwnerPubkey = deriveOwnerPubkey(bobSpendingKey);

    // Derive PDAs
    [mintConfigPDA, mintConfigBump] = deriveMintConfig(tokenMint);
    [aliceAccountPDA] = deriveConfidentialAccount(alice.publicKey, tokenMint);
    [bobAccountPDA] = deriveConfidentialAccount(bob.publicKey, tokenMint);
    [vaultPDA] = deriveVault(tokenMint);
    [balanceVkPDA] = deriveVkData(mintConfigPDA, VK_TYPE_BALANCE);
    [proofVkPDA] = deriveVkData(mintConfigPDA, VK_TYPE_PROOF);

    // Compute initial commitments for balance=0
    aliceCommitment = createBalanceCommitment(
      aliceBalance,
      aliceSalt,
      BigInt(aliceNonce),
      aliceOwnerPubkey,
      tokenMintField
    );
    bobCommitment = createBalanceCommitment(
      bobBalance,
      bobSalt,
      BigInt(bobNonce),
      bobOwnerPubkey,
      tokenMintField
    );

    // Fund accounts
    const fundAmount = 200 * LAMPORTS_PER_SOL;
    const fundSigs = await Promise.all([
      provider.connection.requestAirdrop(alice.publicKey, fundAmount),
      provider.connection.requestAirdrop(bob.publicKey, fundAmount),
      provider.connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL),
    ]);
    for (const sig of fundSigs) {
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Fund the vault PDA with rent-exempt minimum so it exists for withdrawals
    const vaultFundSig = await provider.connection.requestAirdrop(
      vaultPDA,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(vaultFundSig, "confirmed");

    console.log("  Setup complete:");
    console.log(`    Alice:       ${alice.publicKey.toBase58()}`);
    console.log(`    Bob:         ${bob.publicKey.toBase58()}`);
    console.log(`    MintConfig:  ${mintConfigPDA.toBase58()}`);
    console.log(`    Vault:       ${vaultPDA.toBase58()}`);
    console.log(`    Balance VK:  ${balanceVkPDA.toBase58()}`);
    console.log(`    Proof VK:    ${proofVkPDA.toBase58()}`);
  });

  // =========================================================================
  // 1. Initialize Mint
  // =========================================================================
  describe("1. Initialize Mint", () => {
    it("should register native SOL for zkSPL", async () => {
      await program.methods
        .initializeMint(balanceVkHash, proofVkHash)
        .accounts({
          authority: alice.publicKey,
          tokenMint: tokenMint,
          mintConfig: mintConfigPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      // Fetch and verify
      const config = await program.account.mintConfig.fetch(mintConfigPDA);
      expect(config.authority.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(config.tokenMint.toBase58()).to.equal(tokenMint.toBase58());
      expect(config.isActive).to.be.true;
      expect(config.accountCount.toNumber()).to.equal(0);
      expect(Buffer.from(config.balanceVkHash)).to.deep.equal(
        Buffer.from(balanceVkHash)
      );
      expect(Buffer.from(config.proofVkHash)).to.deep.equal(
        Buffer.from(proofVkHash)
      );
    });

    it("should fail to initialize the same mint twice", async () => {
      try {
        await program.methods
          .initializeMint(balanceVkHash, proofVkHash)
          .accounts({
            authority: alice.publicKey,
            tokenMint: tokenMint,
            mintConfig: mintConfigPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // PDA already exists -- Anchor will throw
        expect(err).to.exist;
      }
    });
  });

  // =========================================================================
  // 2. Upload Verification Keys
  // =========================================================================
  describe("2. Upload Verification Keys", () => {
    const balanceVkData = buildMockVk(7); // 7 public inputs for confidential_balance
    const proofVkData = buildMockVk(3); // 3 public inputs for balance_proof

    it("should init balance VK data account", async () => {
      await program.methods
        .initVkData(VK_TYPE_BALANCE, balanceVkData.length)
        .accounts({
          authority: alice.publicKey,
          mintConfig: mintConfigPDA,
          vkData: balanceVkPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const accountInfo = await provider.connection.getAccountInfo(
        balanceVkPDA
      );
      expect(accountInfo).to.not.be.null;
      // Account size: 8 discriminator + 4 size header + vk bytes
      expect(accountInfo!.data.length).to.equal(8 + 4 + balanceVkData.length);
    });

    it("should write balance VK data in chunks", async () => {
      // Write in a single chunk (test data is small enough)
      await program.methods
        .writeVkData(VK_TYPE_BALANCE, 0, balanceVkData)
        .accounts({
          authority: alice.publicKey,
          mintConfig: mintConfigPDA,
          vkData: balanceVkPDA,
        })
        .signers([alice])
        .rpc();

      // Verify data was written
      const accountInfo = await provider.connection.getAccountInfo(
        balanceVkPDA
      );
      expect(accountInfo).to.not.be.null;
      // Check the data portion (after 8 byte discriminator + 4 byte size header)
      const dataSlice = accountInfo!.data.slice(12, 12 + balanceVkData.length);
      expect(Buffer.from(dataSlice)).to.deep.equal(balanceVkData);
    });

    it("should init and write proof VK data account", async () => {
      await program.methods
        .initVkData(VK_TYPE_PROOF, proofVkData.length)
        .accounts({
          authority: alice.publicKey,
          mintConfig: mintConfigPDA,
          vkData: proofVkPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      await program.methods
        .writeVkData(VK_TYPE_PROOF, 0, proofVkData)
        .accounts({
          authority: alice.publicKey,
          mintConfig: mintConfigPDA,
          vkData: proofVkPDA,
        })
        .signers([alice])
        .rpc();

      const accountInfo = await provider.connection.getAccountInfo(proofVkPDA);
      expect(accountInfo).to.not.be.null;
      const dataSlice = accountInfo!.data.slice(12, 12 + proofVkData.length);
      expect(Buffer.from(dataSlice)).to.deep.equal(proofVkData);
    });

    it("should write VK data in multiple chunks", async () => {
      // Create a new VK type to test chunked upload
      // We reuse the balance VK but write in two parts
      const halfSize = Math.floor(balanceVkData.length / 2);
      const chunk1 = balanceVkData.slice(0, halfSize);
      const chunk2 = balanceVkData.slice(halfSize);

      // Overwrite existing balance VK with chunked writes
      await program.methods
        .writeVkData(VK_TYPE_BALANCE, 0, chunk1)
        .accounts({
          authority: alice.publicKey,
          mintConfig: mintConfigPDA,
          vkData: balanceVkPDA,
        })
        .signers([alice])
        .rpc();

      await program.methods
        .writeVkData(VK_TYPE_BALANCE, halfSize, chunk2)
        .accounts({
          authority: alice.publicKey,
          mintConfig: mintConfigPDA,
          vkData: balanceVkPDA,
        })
        .signers([alice])
        .rpc();

      const accountInfo = await provider.connection.getAccountInfo(
        balanceVkPDA
      );
      const dataSlice = accountInfo!.data.slice(12, 12 + balanceVkData.length);
      expect(Buffer.from(dataSlice)).to.deep.equal(balanceVkData);
    });

    it("should reject VK write from non-authority", async () => {
      try {
        await program.methods
          .writeVkData(VK_TYPE_BALANCE, 0, Buffer.from([0x00]))
          .accounts({
            authority: bob.publicKey,
            mintConfig: mintConfigPDA,
            vkData: balanceVkPDA,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown -- bob is not authority");
      } catch (err: any) {
        // Unauthorized constraint error
        expect(err).to.exist;
      }
    });
  });

  // =========================================================================
  // 3. Create Confidential Accounts
  // =========================================================================
  describe("3. Create Confidential Accounts", () => {
    it("should create Alice's confidential account", async () => {
      const initialCommitment = bigintToLeBytes(aliceCommitment);

      await program.methods
        .createAccount(initialCommitment)
        .accounts({
          owner: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.owner.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(account.mint.toBase58()).to.equal(tokenMint.toBase58());
      expect(account.isInitialized).to.be.true;
      expect(account.nonce.toNumber()).to.equal(0);
      expect(account.pendingCredits).to.have.length(0);
      expect(account.viewerKeys).to.have.length(0);
      expect(Buffer.from(account.balanceCommitment)).to.deep.equal(
        Buffer.from(initialCommitment)
      );
    });

    it("should create Bob's confidential account", async () => {
      const initialCommitment = bigintToLeBytes(bobCommitment);

      await program.methods
        .createAccount(initialCommitment)
        .accounts({
          owner: bob.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: bobAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();

      const account = await program.account.confidentialAccount.fetch(
        bobAccountPDA
      );
      expect(account.owner.toBase58()).to.equal(bob.publicKey.toBase58());
      expect(account.isInitialized).to.be.true;
      expect(account.nonce.toNumber()).to.equal(0);
    });

    it("should fail to create duplicate account for Alice", async () => {
      try {
        const initialCommitment = bigintToLeBytes(aliceCommitment);
        await program.methods
          .createAccount(initialCommitment)
          .accounts({
            owner: alice.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: aliceAccountPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // PDA already exists
        expect(err).to.exist;
      }
    });
  });

  // =========================================================================
  // 4. Deposit -- Alice deposits 100 SOL
  // =========================================================================
  describe("4. Deposit", () => {
    const depositAmountSol = 100;
    const depositAmountLamports = BigInt(depositAmountSol) * BigInt(LAMPORTS_PER_SOL);

    it("should deposit 100 SOL into Alice's confidential account", async () => {
      // Compute new commitment after deposit
      const newBalance = aliceBalance + depositAmountLamports;
      const newSalt = BigInt("222222222222");
      const newCommitment = createBalanceCommitment(
        newBalance,
        newSalt,
        BigInt(aliceNonce),
        aliceOwnerPubkey,
        tokenMintField
      );
      const newCommitmentBytes = bigintToLeBytes(newCommitment);
      const proof = mockProof();

      const aliceBalanceBefore = await provider.connection.getBalance(
        alice.publicKey
      );

      await program.methods
        .deposit(
          new BN(depositAmountLamports.toString()),
          proof,
          newCommitmentBytes
        )
        .accounts({
          depositor: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
          vkData: balanceVkPDA,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: null,
          userTokenAccount: null,
          poolVault: null,
        })
        .signers([alice])
        .rpc();

      // Update local state
      aliceBalance = newBalance;
      aliceSalt = newSalt;
      aliceCommitment = newCommitment;
      aliceNonce += 1;

      // Verify on-chain state
      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.nonce.toNumber()).to.equal(aliceNonce);
      expect(Buffer.from(account.balanceCommitment)).to.deep.equal(
        Buffer.from(newCommitmentBytes)
      );

      // Verify SOL was transferred to vault
      const aliceBalanceAfter = await provider.connection.getBalance(
        alice.publicKey
      );
      // Alice should have spent depositAmount + tx fees
      expect(aliceBalanceBefore - aliceBalanceAfter).to.be.greaterThan(
        Number(depositAmountLamports)
      );

      const vaultBalance = await provider.connection.getBalance(vaultPDA);
      // Vault should have at least the deposited amount (plus its initial rent)
      expect(vaultBalance).to.be.greaterThanOrEqual(
        Number(depositAmountLamports)
      );
    });

    it("should reject deposit of 0 amount", async () => {
      const newCommitmentBytes = bigintToLeBytes(aliceCommitment);
      const proof = mockProof();

      try {
        await program.methods
          .deposit(new BN(0), proof, newCommitmentBytes)
          .accounts({
            depositor: alice.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: aliceAccountPDA,
            vkData: balanceVkPDA,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
            tokenProgram: null,
            userTokenAccount: null,
            poolVault: null,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown -- zero amount");
      } catch (err: any) {
        expect(err.toString()).to.contain("InvalidAmount");
      }
    });
  });

  // =========================================================================
  // 5. Private Transfer -- Alice sends 30 SOL to Bob
  // =========================================================================
  describe("5. Confidential Transfer", () => {
    const transferAmountLamports = BigInt(30) * BigInt(LAMPORTS_PER_SOL);

    it("should transfer 30 SOL privately from Alice to Bob", async () => {
      // Sender (Alice) -- reduce balance
      const aliceNewBalance = aliceBalance - transferAmountLamports;
      const aliceNewSalt = BigInt("333333333333");
      const aliceNewCommitment = createBalanceCommitment(
        aliceNewBalance,
        aliceNewSalt,
        BigInt(aliceNonce),
        aliceOwnerPubkey,
        tokenMintField
      );
      const aliceNewCommitmentBytes = bigintToLeBytes(aliceNewCommitment);

      // Amount hash = Poseidon(amount, amount_salt) -- links sender and recipient
      transferAmountSalt = BigInt("555555555555");
      const amountHashBigint = createAmountCommitment(
        transferAmountLamports,
        transferAmountSalt
      );
      transferAmountHash = bigintToLeBytes(amountHashBigint);

      const proof = mockProof();

      await program.methods
        .confidentialTransfer(proof, aliceNewCommitmentBytes, transferAmountHash)
        .accounts({
          sender: alice.publicKey,
          mintConfig: mintConfigPDA,
          senderAccount: aliceAccountPDA,
          recipientAccount: bobAccountPDA,
          vkData: balanceVkPDA,
        })
        .signers([alice])
        .rpc();

      // Update local Alice state
      aliceBalance = aliceNewBalance;
      aliceSalt = aliceNewSalt;
      aliceCommitment = aliceNewCommitment;
      aliceNonce += 1;

      // Verify sender account
      const aliceAccount = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(aliceAccount.nonce.toNumber()).to.equal(aliceNonce);
      expect(Buffer.from(aliceAccount.balanceCommitment)).to.deep.equal(
        Buffer.from(aliceNewCommitmentBytes)
      );

      // Verify recipient has a pending credit
      const bobAccount = await program.account.confidentialAccount.fetch(
        bobAccountPDA
      );
      expect(bobAccount.pendingCredits).to.have.length(1);
      expect(Buffer.from(bobAccount.pendingCredits[0].amountHash)).to.deep.equal(
        Buffer.from(transferAmountHash)
      );
      expect(bobAccount.pendingCredits[0].sender.toBase58()).to.equal(
        alice.publicKey.toBase58()
      );
    });
  });

  // =========================================================================
  // 6. Apply Pending -- Bob applies the incoming credit
  // =========================================================================
  describe("6. Apply Pending", () => {
    const transferAmountLamports = BigInt(30) * BigInt(LAMPORTS_PER_SOL);

    it("should apply pending credit to Bob's account", async () => {
      // Bob adds the received amount to his balance
      const bobNewBalance = bobBalance + transferAmountLamports;
      const bobNewSalt = BigInt("777777777777");
      const bobNewCommitment = createBalanceCommitment(
        bobNewBalance,
        bobNewSalt,
        BigInt(bobNonce),
        bobOwnerPubkey,
        tokenMintField
      );
      const bobNewCommitmentBytes = bigintToLeBytes(bobNewCommitment);

      const proof = mockProof();

      await program.methods
        .applyPending(proof, bobNewCommitmentBytes, transferAmountHash)
        .accounts({
          recipient: bob.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: bobAccountPDA,
          vkData: balanceVkPDA,
        })
        .signers([bob])
        .rpc();

      // Update local Bob state
      bobBalance = bobNewBalance;
      bobSalt = bobNewSalt;
      bobCommitment = bobNewCommitment;
      bobNonce += 1;

      // Verify
      const bobAccount = await program.account.confidentialAccount.fetch(
        bobAccountPDA
      );
      expect(bobAccount.nonce.toNumber()).to.equal(bobNonce);
      expect(bobAccount.pendingCredits).to.have.length(0);
      expect(Buffer.from(bobAccount.balanceCommitment)).to.deep.equal(
        Buffer.from(bobNewCommitmentBytes)
      );
    });

    it("should fail to apply the same pending credit twice (double-apply)", async () => {
      const bobNewCommitmentBytes = bigintToLeBytes(bobCommitment);
      const proof = mockProof();

      try {
        await program.methods
          .applyPending(proof, bobNewCommitmentBytes, transferAmountHash)
          .accounts({
            recipient: bob.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: bobAccountPDA,
            vkData: balanceVkPDA,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown -- pending credit already consumed");
      } catch (err: any) {
        expect(err.toString()).to.contain("PendingCreditNotFound");
      }
    });
  });

  // =========================================================================
  // 7. Withdraw -- Alice withdraws 20 SOL
  // =========================================================================
  describe("7. Withdraw", () => {
    const withdrawAmountLamports = BigInt(20) * BigInt(LAMPORTS_PER_SOL);

    it("should withdraw 20 SOL from Alice's confidential account", async () => {
      const aliceNewBalance = aliceBalance - withdrawAmountLamports;
      const aliceNewSalt = BigInt("444444444444");
      const aliceNewCommitment = createBalanceCommitment(
        aliceNewBalance,
        aliceNewSalt,
        BigInt(aliceNonce),
        aliceOwnerPubkey,
        tokenMintField
      );
      const aliceNewCommitmentBytes = bigintToLeBytes(aliceNewCommitment);
      const proof = mockProof();

      const aliceSolBefore = await provider.connection.getBalance(
        alice.publicKey
      );

      await program.methods
        .withdraw(
          new BN(withdrawAmountLamports.toString()),
          proof,
          aliceNewCommitmentBytes
        )
        .accounts({
          withdrawer: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
          vkData: balanceVkPDA,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: null,
          userTokenAccount: null,
          poolVault: null,
        })
        .signers([alice])
        .rpc();

      // Update local state
      aliceBalance = aliceNewBalance;
      aliceSalt = aliceNewSalt;
      aliceCommitment = aliceNewCommitment;
      aliceNonce += 1;

      // Verify on-chain
      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.nonce.toNumber()).to.equal(aliceNonce);
      expect(Buffer.from(account.balanceCommitment)).to.deep.equal(
        Buffer.from(aliceNewCommitmentBytes)
      );

      // Alice should have received SOL back (minus tx fee)
      const aliceSolAfter = await provider.connection.getBalance(
        alice.publicKey
      );
      // Her SOL should have increased by roughly the withdraw amount (minus small tx fee)
      const netGain = aliceSolAfter - aliceSolBefore;
      expect(netGain).to.be.greaterThan(
        Number(withdrawAmountLamports) - 100_000 // allow for tx fee
      );
    });

    it("should reject withdrawal of 0 amount", async () => {
      const commitmentBytes = bigintToLeBytes(aliceCommitment);
      const proof = mockProof();

      try {
        await program.methods
          .withdraw(new BN(0), proof, commitmentBytes)
          .accounts({
            withdrawer: alice.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: aliceAccountPDA,
            vkData: balanceVkPDA,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
            tokenProgram: null,
            userTokenAccount: null,
            poolVault: null,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown -- zero amount");
      } catch (err: any) {
        expect(err.toString()).to.contain("InvalidAmount");
      }
    });
  });

  // =========================================================================
  // 8. Prove Balance -- Alice proves balance >= 40 SOL
  // =========================================================================
  describe("8. Prove Balance", () => {
    it("should prove Alice has >= 40 SOL", async () => {
      // Alice's balance after deposit(100) - transfer(30) - withdraw(20) = 50 SOL
      // She should be able to prove >= 40 SOL
      const threshold = new BN((40n * BigInt(LAMPORTS_PER_SOL)).toString());
      const proof = mockProof();

      await program.methods
        .proveBalance(threshold, proof)
        .accounts({
          prover: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
          vkData: proofVkPDA,
        })
        .signers([alice])
        .rpc();

      // If we get here without error, the proof was accepted
    });

    it("should prove Bob has >= 20 SOL", async () => {
      // Bob received 30 SOL, so >= 20 should pass
      const threshold = new BN((20n * BigInt(LAMPORTS_PER_SOL)).toString());
      const proof = mockProof();

      await program.methods
        .proveBalance(threshold, proof)
        .accounts({
          prover: bob.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: bobAccountPDA,
          vkData: proofVkPDA,
        })
        .signers([bob])
        .rpc();
    });
  });

  // =========================================================================
  // 9. Viewer Management
  // =========================================================================
  describe("9. Viewer Management", () => {
    it("should add a viewer key to Alice's account", async () => {
      await program.methods
        .addViewer(viewer.publicKey)
        .accounts({
          owner: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
        })
        .signers([alice])
        .rpc();

      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.viewerKeys).to.have.length(1);
      expect(account.viewerKeys[0].toBase58()).to.equal(
        viewer.publicKey.toBase58()
      );
    });

    it("should reject duplicate viewer key", async () => {
      try {
        await program.methods
          .addViewer(viewer.publicKey)
          .accounts({
            owner: alice.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: aliceAccountPDA,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown -- viewer already exists");
      } catch (err: any) {
        expect(err.toString()).to.contain("ViewerKeyAlreadyExists");
      }
    });

    it("should add a second viewer key", async () => {
      const viewer2 = Keypair.generate();

      await program.methods
        .addViewer(viewer2.publicKey)
        .accounts({
          owner: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
        })
        .signers([alice])
        .rpc();

      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.viewerKeys).to.have.length(2);
    });

    it("should remove a viewer key", async () => {
      await program.methods
        .removeViewer(viewer.publicKey)
        .accounts({
          owner: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
        })
        .signers([alice])
        .rpc();

      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.viewerKeys).to.have.length(1);
      // The remaining viewer should NOT be the removed one
      expect(account.viewerKeys[0].toBase58()).to.not.equal(
        viewer.publicKey.toBase58()
      );
    });

    it("should reject removing a non-existent viewer key", async () => {
      const nonExistentViewer = Keypair.generate();

      try {
        await program.methods
          .removeViewer(nonExistentViewer.publicKey)
          .accounts({
            owner: alice.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: aliceAccountPDA,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown -- viewer not found");
      } catch (err: any) {
        expect(err.toString()).to.contain("ViewerKeyNotFound");
      }
    });

    it("should reject viewer management from non-owner", async () => {
      try {
        await program.methods
          .addViewer(stranger.publicKey)
          .accounts({
            owner: stranger.publicKey,
            mintConfig: mintConfigPDA,
            // stranger doesn't have a confidential account for this mint,
            // so PDA derivation will fail
            confidentialAccount: aliceAccountPDA,
          })
          .signers([stranger])
          .rpc();
        expect.fail("Should have thrown -- stranger is not account owner");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });
  });

  // =========================================================================
  // 10. Error Cases
  // =========================================================================
  describe("10. Error Cases", () => {
    it("should reject deposit from wrong signer (PDA mismatch)", async () => {
      // Bob tries to deposit into Alice's account
      const proof = mockProof();
      const commitmentBytes = bigintToLeBytes(aliceCommitment);

      try {
        await program.methods
          .deposit(new BN(LAMPORTS_PER_SOL), proof, commitmentBytes)
          .accounts({
            depositor: bob.publicKey,
            mintConfig: mintConfigPDA,
            // Alice's account PDA -- but depositor is Bob, so seeds mismatch
            confidentialAccount: aliceAccountPDA,
            vkData: balanceVkPDA,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
            tokenProgram: null,
            userTokenAccount: null,
            poolVault: null,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown -- PDA seeds mismatch");
      } catch (err: any) {
        // Anchor will reject because PDA derivation from bob.publicKey != aliceAccountPDA
        expect(err).to.exist;
      }
    });

    it("should reject withdraw from wrong signer (PDA mismatch)", async () => {
      const proof = mockProof();
      const commitmentBytes = bigintToLeBytes(aliceCommitment);

      try {
        await program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL), proof, commitmentBytes)
          .accounts({
            withdrawer: bob.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: aliceAccountPDA,
            vkData: balanceVkPDA,
            vault: vaultPDA,
            systemProgram: SystemProgram.programId,
            tokenProgram: null,
            userTokenAccount: null,
            poolVault: null,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown -- PDA seeds mismatch");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });

    it("should reject apply_pending with non-existent amount_hash", async () => {
      const proof = mockProof();
      const commitmentBytes = bigintToLeBytes(bobCommitment);
      const fakeAmountHash = new Array(32).fill(0xff);

      try {
        await program.methods
          .applyPending(proof, commitmentBytes, fakeAmountHash)
          .accounts({
            recipient: bob.publicKey,
            mintConfig: mintConfigPDA,
            confidentialAccount: bobAccountPDA,
            vkData: balanceVkPDA,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown -- no matching pending credit");
      } catch (err: any) {
        expect(err.toString()).to.contain("PendingCreditNotFound");
      }
    });

    it("should reject prove_balance from non-owner (PDA mismatch)", async () => {
      const proof = mockProof();

      try {
        await program.methods
          .proveBalance(new BN(0), proof)
          .accounts({
            prover: bob.publicKey,
            mintConfig: mintConfigPDA,
            // Alice's account -- but prover is Bob
            confidentialAccount: aliceAccountPDA,
            vkData: proofVkPDA,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown -- PDA mismatch");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });

    it("should correctly track nonces across operations", async () => {
      // Alice has done: create(nonce=0), deposit(nonce->1), transfer(nonce->2), withdraw(nonce->3)
      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.nonce.toNumber()).to.equal(aliceNonce);
      expect(account.nonce.toNumber()).to.equal(3);
    });

    it("should verify commitment privacy (same balance, different salts)", async () => {
      const balance = BigInt(100) * BigInt(LAMPORTS_PER_SOL);
      const salt1 = BigInt("111111111111");
      const salt2 = BigInt("999999999999");

      const comm1 = createBalanceCommitment(
        balance,
        salt1,
        0n,
        aliceOwnerPubkey,
        tokenMintField
      );
      const comm2 = createBalanceCommitment(
        balance,
        salt2,
        0n,
        aliceOwnerPubkey,
        tokenMintField
      );

      expect(comm1).to.not.equal(comm2);
    });

    it("should verify wrong spending key produces different owner pubkey", async () => {
      const wrongKey = BigInt("11111111111111111111");
      const wrongPubkey = deriveOwnerPubkey(wrongKey);

      expect(wrongPubkey).to.not.equal(aliceOwnerPubkey);

      // Commitment with wrong key differs
      const balance = BigInt(100) * BigInt(LAMPORTS_PER_SOL);
      const salt = BigInt("123456789");
      const realComm = createBalanceCommitment(
        balance,
        salt,
        0n,
        aliceOwnerPubkey,
        tokenMintField
      );
      const wrongComm = createBalanceCommitment(
        balance,
        salt,
        0n,
        wrongPubkey,
        tokenMintField
      );

      expect(realComm).to.not.equal(wrongComm);
    });

    it("should verify overflow protection (negative balance in field > 2^64)", async () => {
      // If someone tried to withdraw more than they have, the "new balance"
      // in field arithmetic would be p - delta, which exceeds 2^64.
      // The Num2Bits(64) constraint in the circuit would reject this.
      const balance = BigInt(100) * BigInt(LAMPORTS_PER_SOL);
      const excessiveWithdraw = BigInt(200) * BigInt(LAMPORTS_PER_SOL);
      const badNewBalance =
        (FIELD_MODULUS + balance - excessiveWithdraw) % FIELD_MODULUS;

      expect(badNewBalance).to.be.greaterThan(BigInt(2) ** BigInt(64));
    });

    it("should verify amount commitment linkage between sender and recipient", async () => {
      const amount = BigInt(30) * BigInt(LAMPORTS_PER_SOL);
      const salt = BigInt("555555555555");

      const senderHash = createAmountCommitment(amount, salt);
      const recipientHash = createAmountCommitment(amount, salt);

      // Same amount + salt = same hash (sender and recipient agree)
      expect(senderHash).to.equal(recipientHash);

      // Different amount = different hash (can't claim different amount)
      const wrongHash = createAmountCommitment(
        BigInt(50) * BigInt(LAMPORTS_PER_SOL),
        salt
      );
      expect(senderHash).to.not.equal(wrongHash);
    });
  });

  // =========================================================================
  // 11. Additional Flow -- Second Deposit + Transfer Sequence
  // =========================================================================
  describe("11. Additional Flow", () => {
    it("should allow a second deposit from Alice", async () => {
      const depositAmount = BigInt(10) * BigInt(LAMPORTS_PER_SOL);
      const newBalance = aliceBalance + depositAmount;
      const newSalt = BigInt("888888888888");
      const newCommitment = createBalanceCommitment(
        newBalance,
        newSalt,
        BigInt(aliceNonce),
        aliceOwnerPubkey,
        tokenMintField
      );
      const newCommitmentBytes = bigintToLeBytes(newCommitment);
      const proof = mockProof();

      await program.methods
        .deposit(new BN(depositAmount.toString()), proof, newCommitmentBytes)
        .accounts({
          depositor: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
          vkData: balanceVkPDA,
          vault: vaultPDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: null,
          userTokenAccount: null,
          poolVault: null,
        })
        .signers([alice])
        .rpc();

      aliceBalance = newBalance;
      aliceSalt = newSalt;
      aliceCommitment = newCommitment;
      aliceNonce += 1;

      const account = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(account.nonce.toNumber()).to.equal(aliceNonce);
    });

    it("should allow Bob to send back to Alice", async () => {
      const transferAmount = BigInt(10) * BigInt(LAMPORTS_PER_SOL);
      const bobNewBalance = bobBalance - transferAmount;
      const bobNewSalt = BigInt("999999999999");
      const bobNewCommitment = createBalanceCommitment(
        bobNewBalance,
        bobNewSalt,
        BigInt(bobNonce),
        bobOwnerPubkey,
        tokenMintField
      );
      const bobNewCommitmentBytes = bigintToLeBytes(bobNewCommitment);

      const amtSalt = BigInt("101010101010");
      const amountHashBigint = createAmountCommitment(transferAmount, amtSalt);
      const amountHashBytes = bigintToLeBytes(amountHashBigint);
      const proof = mockProof();

      await program.methods
        .confidentialTransfer(proof, bobNewCommitmentBytes, amountHashBytes)
        .accounts({
          sender: bob.publicKey,
          mintConfig: mintConfigPDA,
          senderAccount: bobAccountPDA,
          recipientAccount: aliceAccountPDA,
          vkData: balanceVkPDA,
        })
        .signers([bob])
        .rpc();

      bobBalance = bobNewBalance;
      bobSalt = bobNewSalt;
      bobCommitment = bobNewCommitment;
      bobNonce += 1;

      // Verify Alice has pending credit
      const aliceAccount = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(aliceAccount.pendingCredits).to.have.length(1);
      expect(aliceAccount.pendingCredits[0].sender.toBase58()).to.equal(
        bob.publicKey.toBase58()
      );

      // Alice applies the pending credit
      const aliceNewBalance = aliceBalance + transferAmount;
      const aliceNewSalt = BigInt("121212121212");
      const aliceNewCommitment = createBalanceCommitment(
        aliceNewBalance,
        aliceNewSalt,
        BigInt(aliceNonce),
        aliceOwnerPubkey,
        tokenMintField
      );
      const aliceNewCommitmentBytes = bigintToLeBytes(aliceNewCommitment);

      await program.methods
        .applyPending(proof, aliceNewCommitmentBytes, amountHashBytes)
        .accounts({
          recipient: alice.publicKey,
          mintConfig: mintConfigPDA,
          confidentialAccount: aliceAccountPDA,
          vkData: balanceVkPDA,
        })
        .signers([alice])
        .rpc();

      aliceBalance = aliceNewBalance;
      aliceSalt = aliceNewSalt;
      aliceCommitment = aliceNewCommitment;
      aliceNonce += 1;

      // Verify clean state
      const aliceAccountAfter = await program.account.confidentialAccount.fetch(
        aliceAccountPDA
      );
      expect(aliceAccountAfter.pendingCredits).to.have.length(0);
      expect(aliceAccountAfter.nonce.toNumber()).to.equal(aliceNonce);
    });

    it("should verify final balance expectations via local tracking", () => {
      // Alice: started 0, +100, -30, -20, +10, +10 = 70 SOL
      const expectedAlice = BigInt(70) * BigInt(LAMPORTS_PER_SOL);
      expect(aliceBalance).to.equal(expectedAlice);

      // Bob: started 0, +30, -10 = 20 SOL
      const expectedBob = BigInt(20) * BigInt(LAMPORTS_PER_SOL);
      expect(bobBalance).to.equal(expectedBob);

      // Nonces: alice = 5 ops (deposit, transfer, withdraw, deposit, apply)
      expect(aliceNonce).to.equal(5);
      // Bob = 2 ops (apply, transfer)
      expect(bobNonce).to.equal(2);
    });
  });
});

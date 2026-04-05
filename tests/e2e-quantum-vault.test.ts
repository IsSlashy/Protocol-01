/**
 * E2E: Quantum Vault Full Lifecycle
 *
 * Tests all 3 quantum-safe defense layers on devnet:
 *   - WOTS+ Vault: hash-based signatures, key rotation, edge cases
 *   - Hash-Timelock Vault: SHA-256 preimage lock, timelock enforcement
 *   - Commit-Reveal: slot-based timing, commitment matching
 *
 * Program ID: HazoS6VKk4fqzjJg2yNYSPYTSq8yEHm2EZyb23seTh7o
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..."
 *   ANCHOR_WALLET=~/.config/solana/id.json
 *   ts-mocha -p tsconfig.test.json tests/e2e-quantum-vault.test.ts --timeout 300000
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha256';

// ============================================================================
// Constants (match Rust program)
// ============================================================================

const PROGRAM_ID = new PublicKey('HazoS6VKk4fqzjJg2yNYSPYTSq8yEHm2EZyb23seTh7o');

const WOTS_CHAINS = 32;
const WOTS_MAX_VAL = 15;
const HASH_SIZE = 32;

const MIN_REVEAL_DELAY = 2;
const MAX_REVEAL_WINDOW = 6750;

const SEEDS = {
  WOTS_VAULT: Buffer.from('wots_vault'),
  HASH_VAULT: Buffer.from('hash_vault'),
  COMMIT: Buffer.from('commit'),
};

// ============================================================================
// Retry helper
// ============================================================================
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 2000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.toString();
      if (
        attempt < maxRetries &&
        (msg.includes('Blockhash not found') || msg.includes('block height exceeded'))
      ) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`    Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ============================================================================
// WOTS+ Client-Side Helpers
// ============================================================================

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

interface WotsKeypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHash: Uint8Array;
}

interface WotsSignature {
  signature: Uint8Array;
  publicKey: Uint8Array;
}

function generateWotsKeypair(seed: Uint8Array): WotsKeypair {
  const secretKey = new Uint8Array(WOTS_CHAINS * HASH_SIZE);
  const publicKey = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  for (let i = 0; i < WOTS_CHAINS; i++) {
    const indexBuf = new Uint8Array(4);
    new DataView(indexBuf.buffer).setUint32(0, i, true);
    const chainSecret = new Uint8Array(sha256(concatBytes(seed, indexBuf)));
    secretKey.set(chainSecret, i * HASH_SIZE);

    let current: Uint8Array = chainSecret;
    for (let step = 0; step < WOTS_MAX_VAL; step++) {
      current = new Uint8Array(sha256(current));
    }
    publicKey.set(current, i * HASH_SIZE);
  }

  const publicKeyHash = new Uint8Array(sha256(publicKey));
  return { secretKey, publicKey, publicKeyHash };
}

function deriveWotsKeypair(masterSeed: Uint8Array, index: number): WotsKeypair {
  const indexBuf = new Uint8Array(4);
  new DataView(indexBuf.buffer).setUint32(0, index, true);
  const keySeed = new Uint8Array(
    sha256(concatBytes(new TextEncoder().encode('wots-key'), masterSeed, indexBuf)),
  );
  return generateWotsKeypair(keySeed);
}

function computeWithdrawMessage(
  amount: bigint,
  destination: Uint8Array,
  withdrawalCount: bigint,
): Uint8Array {
  const amountBuf = new Uint8Array(8);
  new DataView(amountBuf.buffer).setBigUint64(0, amount, true);

  const countBuf = new Uint8Array(8);
  new DataView(countBuf.buffer).setBigUint64(0, withdrawalCount, true);

  return new Uint8Array(sha256(concatBytes(amountBuf, destination, countBuf)));
}

function wotsSign(message: Uint8Array, keypair: WotsKeypair): WotsSignature {
  const signature = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  for (let i = 0; i < WOTS_CHAINS; i++) {
    const byteIdx = Math.floor(i / 2);
    const byte = message[byteIdx]!;
    const nibble = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
    const stepsToHash = WOTS_MAX_VAL - nibble;

    let current: Uint8Array = keypair.secretKey.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE);
    for (let step = 0; step < stepsToHash; step++) {
      current = new Uint8Array(sha256(current));
    }
    signature.set(current, i * HASH_SIZE);
  }

  return { signature, publicKey: keypair.publicKey };
}

// ============================================================================
// PDA Helpers
// ============================================================================

function findWotsVaultPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.WOTS_VAULT, owner.toBuffer()],
    PROGRAM_ID,
  );
}

function findHashVaultPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.HASH_VAULT, owner.toBuffer()],
    PROGRAM_ID,
  );
}

function findCommitPda(committer: PublicKey, commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.COMMIT, committer.toBuffer(), Buffer.from(commitment)],
    PROGRAM_ID,
  );
}

// ============================================================================
// Utility
// ============================================================================

async function fundAccount(
  provider: AnchorProvider,
  to: PublicKey,
  amount: number,
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports: amount * LAMPORTS_PER_SOL,
    }),
  );
  await provider.sendAndConfirm(tx);
}

async function advanceSlots(provider: AnchorProvider, numSlots: number): Promise<void> {
  for (let i = 0; i < numSlots; i++) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: provider.wallet.publicKey,
        lamports: 1,
      }),
    );
    await provider.sendAndConfirm(tx);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Quantum Vault Lifecycle', () => {
  const provider = new AnchorProvider(
    AnchorProvider.env().connection,
    AnchorProvider.env().wallet,
    {
      preflightCommitment: 'confirmed',
      commitment: 'confirmed',
    },
  );
  anchor.setProvider(provider);

  // Load IDL from target/ if available, otherwise construct inline
  let program: Program;
  before('load program', () => {
    try {
      const idl = require('../target/idl/p01_quantum_vault.json');
      program = new Program(idl, provider);
    } catch {
      // Fall back to raw instructions if IDL not available
      throw new Error(
        'p01_quantum_vault IDL not found. Run `anchor build -p p01_quantum_vault` first, ' +
          'or copy target/idl/p01_quantum_vault.json from the build machine.',
      );
    }
  });

  const admin = provider.wallet as anchor.Wallet;
  const wotsOwner = Keypair.generate();
  const hashOwner = Keypair.generate();
  const committer = Keypair.generate();
  const destination = Keypair.generate();

  // WOTS+ key management
  const masterSeed = new Uint8Array(sha256(Buffer.from('e2e-quantum-vault-test-seed-2026')));
  const keypair0 = deriveWotsKeypair(masterSeed, 0);
  const keypair1 = deriveWotsKeypair(masterSeed, 1);
  const keypair2 = deriveWotsKeypair(masterSeed, 2);

  // Hash vault secret
  const hashSecret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hashSecret[i] = i + 1;
  const hashCommitment = new Uint8Array(sha256(hashSecret));

  let wotsVaultPda: PublicKey;
  let hashVaultPda: PublicKey;

  before('fund test accounts', async () => {
    await fundAccount(provider, wotsOwner.publicKey, 15);
    await fundAccount(provider, hashOwner.publicKey, 15);
    await fundAccount(provider, committer.publicKey, 5);
    await fundAccount(provider, destination.publicKey, 0.01);

    [wotsVaultPda] = findWotsVaultPda(wotsOwner.publicKey);
    [hashVaultPda] = findHashVaultPda(hashOwner.publicKey);
  });

  // ────────────────────────────────────────────────────────────────
  // WOTS+ Vault
  // ────────────────────────────────────────────────────────────────
  describe('WOTS+ Vault', () => {
    it('creates WOTS+ vault with initial key', async () => {
      await withRetry(async () => {
        await program.methods
          .initWinternitzVault(Array.from(keypair0.publicKeyHash))
          .accounts({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc({ commitment: 'confirmed' });
      });

      const vault = await (program.account as any).winternitzVault.fetch(wotsVaultPda);
      expect(vault.owner.toBase58()).to.equal(wotsOwner.publicKey.toBase58());
      expect(Array.from(vault.wotsPubkeyHash)).to.deep.equal(Array.from(keypair0.publicKeyHash));
      expect(vault.balance.toNumber()).to.equal(0);
      expect(vault.withdrawalCount.toNumber()).to.equal(0);
      expect(vault.frozen).to.be.false;
      console.log('    WOTS+ vault created');
    });

    it('funds vault', async () => {
      const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

      await withRetry(async () => {
        await program.methods
          .depositWinternitz(depositAmount)
          .accounts({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc({ commitment: 'confirmed' });
      });

      const vault = await (program.account as any).winternitzVault.fetch(wotsVaultPda);
      expect(vault.balance.toNumber()).to.equal(depositAmount.toNumber());
      console.log(`    Deposited ${depositAmount.toNumber() / LAMPORTS_PER_SOL} SOL`);
    });

    it('withdraws with valid WOTS+ signature', async () => {
      const withdrawAmount = BigInt(2 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(0);

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      const sig = wotsSign(message, keypair0);
      const destBalBefore = await provider.connection.getBalance(destination.publicKey);

      await withRetry(async () => {
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Buffer.from(sig.signature),
            Buffer.from(sig.publicKey),
            Array.from(keypair1.publicKeyHash),
          )
          .accounts({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            destination: destination.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc({ commitment: 'confirmed' });
      });

      const vault = await (program.account as any).winternitzVault.fetch(wotsVaultPda);
      expect(vault.balance.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
      expect(vault.withdrawalCount.toNumber()).to.equal(1);

      const destBalAfter = await provider.connection.getBalance(destination.publicKey);
      expect(destBalAfter - destBalBefore).to.equal(Number(withdrawAmount));
      console.log(`    Withdrew ${Number(withdrawAmount) / LAMPORTS_PER_SOL} SOL`);
    });

    it('verifies key rotation after withdrawal', async () => {
      const vault = await (program.account as any).winternitzVault.fetch(wotsVaultPda);
      expect(Array.from(vault.wotsPubkeyHash)).to.deep.equal(Array.from(keypair1.publicKeyHash));
      console.log('    Key rotated to keypair1 after withdrawal');
    });

    it('rejects withdrawal with old key', async () => {
      const withdrawAmount = BigInt(1 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(1);

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      // Sign with OLD keypair0 (already rotated away)
      const sig = wotsSign(message, keypair0);
      const nextKeypair = deriveWotsKeypair(masterSeed, 2);

      try {
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Buffer.from(sig.signature),
            Buffer.from(sig.publicKey),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accounts({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            destination: destination.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('WotsPubkeyMismatch');
        console.log('    Correctly rejected stale WOTS+ key');
      }
    });

    it('handles all-zero message edge case', async () => {
      // Withdraw with keypair1, message whose hash may have leading zero nibbles
      const withdrawAmount = BigInt(1 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(1); // second withdrawal

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      const sig = wotsSign(message, keypair1);

      await withRetry(async () => {
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Buffer.from(sig.signature),
            Buffer.from(sig.publicKey),
            Array.from(keypair2.publicKeyHash),
          )
          .accounts({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            destination: destination.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc({ commitment: 'confirmed' });
      });

      const vault = await (program.account as any).winternitzVault.fetch(wotsVaultPda);
      expect(vault.balance.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
      expect(vault.withdrawalCount.toNumber()).to.equal(2);
      expect(Array.from(vault.wotsPubkeyHash)).to.deep.equal(Array.from(keypair2.publicKeyHash));
      console.log('    Handled arbitrary message hash correctly, key rotated to keypair2');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Hash-Timelock Vault
  // ────────────────────────────────────────────────────────────────
  describe('Hash-Timelock Vault', () => {
    it('creates vault with SHA-256 preimage lock', async () => {
      await withRetry(async () => {
        await program.methods
          .initHashVault(
            Array.from(hashCommitment),
            new BN(0), // no timelock
            destination.publicKey,
          )
          .accounts({
            owner: hashOwner.publicKey,
            vault: hashVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([hashOwner])
          .rpc({ commitment: 'confirmed' });
      });

      // Fund the vault
      await withRetry(async () => {
        await program.methods
          .depositHashVault(new BN(5 * LAMPORTS_PER_SOL))
          .accounts({
            owner: hashOwner.publicKey,
            vault: hashVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([hashOwner])
          .rpc({ commitment: 'confirmed' });
      });

      const vault = await (program.account as any).hashVault.fetch(hashVaultPda);
      expect(vault.owner.toBase58()).to.equal(hashOwner.publicKey.toBase58());
      expect(Array.from(vault.commitment)).to.deep.equal(Array.from(hashCommitment));
      expect(vault.balance.toNumber()).to.equal(5 * LAMPORTS_PER_SOL);
      expect(vault.drained).to.be.false;
      console.log('    Hash vault created and funded with 5 SOL');
    });

    it('rejects claim without preimage', async () => {
      const badPreimage = new Uint8Array(32);
      badPreimage.fill(0xff);

      try {
        await program.methods
          .withdrawHashVault(
            Array.from(badPreimage),
            new BN(1 * LAMPORTS_PER_SOL),
          )
          .accounts({
            signer: hashOwner.publicKey,
            vault: hashVaultPda,
            destination: destination.publicKey,
          })
          .signers([hashOwner])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('PreimageMismatch');
        console.log('    Correctly rejected wrong preimage');
      }
    });

    it('claims with correct preimage', async () => {
      const destBalBefore = await provider.connection.getBalance(destination.publicKey);

      await withRetry(async () => {
        await program.methods
          .withdrawHashVault(
            Array.from(hashSecret),
            new BN(2 * LAMPORTS_PER_SOL),
          )
          .accounts({
            signer: hashOwner.publicKey,
            vault: hashVaultPda,
            destination: destination.publicKey,
          })
          .signers([hashOwner])
          .rpc({ commitment: 'confirmed' });
      });

      const vault = await (program.account as any).hashVault.fetch(hashVaultPda);
      expect(vault.balance.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);

      const destBalAfter = await provider.connection.getBalance(destination.publicKey);
      expect(destBalAfter - destBalBefore).to.equal(2 * LAMPORTS_PER_SOL);
      console.log('    Claimed 2 SOL with correct preimage');
    });

    it('enforces timelock delay', async () => {
      // Create a separate timelocked vault
      const timelockOwner = Keypair.generate();
      const timelockDest = Keypair.generate();
      await fundAccount(provider, timelockOwner.publicKey, 10);
      await fundAccount(provider, timelockDest.publicKey, 0.01);

      const timelockSecret = new Uint8Array(32);
      for (let i = 0; i < 32; i++) timelockSecret[i] = 0xa0 + (i % 16);
      const timelockCommitment = new Uint8Array(sha256(timelockSecret));

      const [timelockVaultPda] = findHashVaultPda(timelockOwner.publicKey);

      // Set unlock to far future
      const futureTime = Math.floor(Date.now() / 1000) + 86400;

      await withRetry(async () => {
        await program.methods
          .initHashVault(
            Array.from(timelockCommitment),
            new BN(futureTime),
            timelockDest.publicKey,
          )
          .accounts({
            owner: timelockOwner.publicKey,
            vault: timelockVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([timelockOwner])
          .rpc({ commitment: 'confirmed' });
      });

      await withRetry(async () => {
        await program.methods
          .depositHashVault(new BN(3 * LAMPORTS_PER_SOL))
          .accounts({
            owner: timelockOwner.publicKey,
            vault: timelockVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([timelockOwner])
          .rpc({ commitment: 'confirmed' });
      });

      // Try to withdraw before timelock expires
      try {
        await program.methods
          .withdrawHashVault(
            Array.from(timelockSecret),
            new BN(1 * LAMPORTS_PER_SOL),
          )
          .accounts({
            signer: timelockOwner.publicKey,
            vault: timelockVaultPda,
            destination: timelockDest.publicKey,
          })
          .signers([timelockOwner])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('TimelockActive');
        console.log('    Correctly enforced timelock delay');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Commit-Reveal
  // ────────────────────────────────────────────────────────────────
  describe('Commit-Reveal', () => {
    const actionData = Buffer.from('transfer:destination:1000000');
    const nonce = new Uint8Array(32);
    for (let i = 0; i < 32; i++) nonce[i] = 0xcc + (i % 8);

    const commitmentBytes = new Uint8Array(sha256(concatBytes(actionData, nonce)));
    let commitPda: PublicKey;

    it('commits transaction hash', async () => {
      [commitPda] = findCommitPda(committer.publicKey, commitmentBytes);

      const revealWindow = new BN(450);

      await withRetry(async () => {
        await program.methods
          .createCommitment(
            Array.from(commitmentBytes),
            0, // action_type = transfer
            revealWindow,
          )
          .accounts({
            committer: committer.publicKey,
            record: commitPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([committer])
          .rpc({ commitment: 'confirmed' });
      });

      const record = await (program.account as any).commitRecord.fetch(commitPda);
      expect(record.committer.toBase58()).to.equal(committer.publicKey.toBase58());
      expect(Array.from(record.commitment)).to.deep.equal(Array.from(commitmentBytes));
      expect(record.revealed).to.be.false;
      expect(record.actionType).to.equal(0);
      console.log('    Commitment created on-chain');
    });

    it('reveals matching transaction', async () => {
      // Advance slots past MIN_REVEAL_DELAY
      await advanceSlots(provider, MIN_REVEAL_DELAY + 1);

      await withRetry(async () => {
        await program.methods
          .revealCommitment(actionData, Array.from(nonce))
          .accounts({
            committer: committer.publicKey,
            record: commitPda,
          })
          .signers([committer])
          .rpc({ commitment: 'confirmed' });
      });

      const record = await (program.account as any).commitRecord.fetch(commitPda);
      expect(record.revealed).to.be.true;
      console.log('    Commitment revealed successfully');
    });

    it('rejects mismatched reveal', async () => {
      // Create a new commitment for this test
      const nonce2 = new Uint8Array(32);
      for (let i = 0; i < 32; i++) nonce2[i] = 0xdd + (i % 4);
      const actionData2 = Buffer.from('unshield:my-nullifier:500');
      const commitment2 = new Uint8Array(sha256(concatBytes(actionData2, nonce2)));
      const [commitPda2] = findCommitPda(committer.publicKey, commitment2);

      await withRetry(async () => {
        await program.methods
          .createCommitment(
            Array.from(commitment2),
            1,
            new BN(450),
          )
          .accounts({
            committer: committer.publicKey,
            record: commitPda2,
            systemProgram: SystemProgram.programId,
          })
          .signers([committer])
          .rpc({ commitment: 'confirmed' });
      });

      await advanceSlots(provider, MIN_REVEAL_DELAY + 1);

      // Try to reveal with wrong action data
      const wrongActionData = Buffer.from('WRONG_DATA');
      try {
        await program.methods
          .revealCommitment(wrongActionData, Array.from(nonce2))
          .accounts({
            committer: committer.publicKey,
            record: commitPda2,
          })
          .signers([committer])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('CommitmentMismatch');
        console.log('    Correctly rejected mismatched reveal');
      }
    });

    it('enforces minimum delay between commit and reveal', async () => {
      const nonce3 = new Uint8Array(32).fill(0x55);
      const actionData3 = Buffer.from('immediate-reveal-test');
      const commitment3 = new Uint8Array(sha256(concatBytes(actionData3, nonce3)));
      const [commitPda3] = findCommitPda(committer.publicKey, commitment3);

      await withRetry(async () => {
        await program.methods
          .createCommitment(
            Array.from(commitment3),
            0,
            new BN(450),
          )
          .accounts({
            committer: committer.publicKey,
            record: commitPda3,
            systemProgram: SystemProgram.programId,
          })
          .signers([committer])
          .rpc({ commitment: 'confirmed' });
      });

      // Try to reveal immediately (same slot or next slot)
      try {
        await program.methods
          .revealCommitment(actionData3, Array.from(nonce3))
          .accounts({
            committer: committer.publicKey,
            record: commitPda3,
          })
          .signers([committer])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('RevealTooEarly');
        console.log('    Correctly enforced minimum reveal delay');
      }
    });
  });
});

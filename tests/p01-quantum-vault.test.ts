/**
 * p01_quantum_vault - Quantum-Safe Vault Test Suite
 *
 * Tests the quantum vault program that provides:
 *   - Winternitz OTS vaults (WOTS+ hash-based signatures)
 *   - Hash-timelock vaults (SHA-256 preimage + timelock)
 *   - Commit-then-reveal protocol (slot-based timing)
 *
 * Program ID: 9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv
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
import { sha256 } from '@noble/hashes/sha2.js';
import type { P01QuantumVault } from '../target/types/p01_quantum_vault';

// ============================================================================
// Constants (match Rust program)
// ============================================================================

const PROGRAM_ID = new PublicKey('9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv');

const WOTS_MSG_CHAINS = 64;
const WOTS_CHECKSUM_CHAINS = 3;
const WOTS_CHAINS = WOTS_MSG_CHAINS + WOTS_CHECKSUM_CHAINS; // 67
const WOTS_MAX_VAL = 15;
const HASH_SIZE = 32;

const MIN_REVEAL_DELAY = 2;
const MAX_REVEAL_WINDOW = 6750;

const SEEDS = {
  WOTS_VAULT: Buffer.from('wots_vault'),
  WOTS_SIG: Buffer.from('wots_sig'),
  HASH_VAULT: Buffer.from('hash_vault'),
  COMMIT: Buffer.from('commit'),
};

const WOTS_SIG_SIZE = 67 * 32; // 2144 bytes
const WOTS_SIG_CHUNK = 900;

// ============================================================================
// WOTS+ Client-Side Helpers (mirrors packages/specter-sdk/src/quantum/wots.ts)
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

/**
 * Compute the message hash for a Winternitz vault withdrawal.
 * Must match on-chain: SHA-256(amount_le || destination_pubkey || withdrawal_count_le)
 */
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

/**
 * Sign a message with a WOTS+ keypair.
 */
function wotsSign(message: Uint8Array, keypair: WotsKeypair): WotsSignature {
  const signature = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  // Extract 64 message nibbles from the full 32-byte digest
  const nibbles = new Array<number>(WOTS_CHAINS);
  for (let i = 0; i < WOTS_MSG_CHAINS; i++) {
    const byteIdx = i >> 1;
    const byte = message[byteIdx]!;
    nibbles[i] = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
  }

  // Checksum = sum(15 - m_i); encode MSB-first as 3 nibbles
  let checksum = 0;
  for (let i = 0; i < WOTS_MSG_CHAINS; i++) {
    checksum += WOTS_MAX_VAL - nibbles[i]!;
  }
  nibbles[WOTS_MSG_CHAINS] = (checksum >> 8) & 0x0f;
  nibbles[WOTS_MSG_CHAINS + 1] = (checksum >> 4) & 0x0f;
  nibbles[WOTS_MSG_CHAINS + 2] = checksum & 0x0f;

  for (let i = 0; i < WOTS_CHAINS; i++) {
    const stepsToHash = WOTS_MAX_VAL - nibbles[i]!;
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

function findWotsSigBufferPda(
  vault: PublicKey,
  authority: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.WOTS_SIG, vault.toBuffer(), authority.toBuffer()],
    PROGRAM_ID,
  );
}

/**
 * Upload a WOTS+ signature into a buffer PDA in chunks.
 * Returns the buffer PDA. Caller is responsible for closing it.
 */
async function uploadWotsSig(
  program: Program<P01QuantumVault>,
  authority: Keypair,
  vaultPda: PublicKey,
  signature: Uint8Array,
): Promise<PublicKey> {
  const [bufferPda] = findWotsSigBufferPda(vaultPda, authority.publicKey);

  await program.methods
    .initWotsSigBuffer(signature.length)
    .accountsPartial({
      authority: authority.publicKey,
      vault: vaultPda,
      buffer: bufferPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  for (let off = 0; off < signature.length; off += WOTS_SIG_CHUNK) {
    const slice = signature.slice(off, off + WOTS_SIG_CHUNK);
    await program.methods
      .writeWotsSigChunk(off, Buffer.from(slice))
      .accountsPartial({
        authority: authority.publicKey,
        buffer: bufferPda,
      })
      .signers([authority])
      .rpc();
  }

  return bufferPda;
}

async function closeWotsSigBuffer(
  program: Program<P01QuantumVault>,
  authority: Keypair,
  vaultPda: PublicKey,
): Promise<void> {
  const [bufferPda] = findWotsSigBufferPda(vaultPda, authority.publicKey);
  try {
    await program.methods
      .closeWotsSigBuffer()
      .accountsPartial({
        authority: authority.publicKey,
        buffer: bufferPda,
      })
      .signers([authority])
      .rpc();
  } catch {
    // buffer may not exist if init failed — ignore
  }
}

// ============================================================================
// Utility
// ============================================================================

async function fundAccount(
  provider: AnchorProvider,
  to: PublicKey,
  amount: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports: amount * LAMPORTS_PER_SOL,
    }),
  );
  await provider.sendAndConfirm(tx);
}

async function confirmTxAndAdvanceSlots(
  provider: AnchorProvider,
  numSlots: number,
) {
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

describe('p01_quantum_vault', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program<P01QuantumVault>(
    require('../target/idl/p01_quantum_vault.json'),
    provider,
  );

  const admin = provider.wallet as anchor.Wallet;
  const wotsOwner = Keypair.generate();
  const hashOwner = Keypair.generate();
  const committer = Keypair.generate();
  const destination = Keypair.generate();
  const attacker = Keypair.generate();

  // WOTS+ key management
  const masterSeed = new Uint8Array(sha256(Buffer.from('test-master-seed-quantum-vault')));
  const keypair0 = deriveWotsKeypair(masterSeed, 0);
  const keypair1 = deriveWotsKeypair(masterSeed, 1);
  const keypair2 = deriveWotsKeypair(masterSeed, 2);

  // Hash vault secret
  const hashSecret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hashSecret[i] = i + 1;
  const hashCommitment = new Uint8Array(sha256(hashSecret));

  let wotsVaultPda: PublicKey;
  let hashVaultPda: PublicKey;

  before(async () => {
    await fundAccount(provider, wotsOwner.publicKey, 20);
    await fundAccount(provider, hashOwner.publicKey, 20);
    await fundAccount(provider, committer.publicKey, 10);
    await fundAccount(provider, destination.publicKey, 0.01);
    await fundAccount(provider, attacker.publicKey, 5);

    [wotsVaultPda] = findWotsVaultPda(wotsOwner.publicKey);
    [hashVaultPda] = findHashVaultPda(hashOwner.publicKey);
  });

  // ────────────────────────────────────────────────────────────────
  // Winternitz OTS Vault
  // ────────────────────────────────────────────────────────────────

  describe('Winternitz OTS Vault', () => {
    it('initializes a WOTS+ vault', async () => {
      await program.methods
        .initWinternitzVault(Array.from(keypair0.publicKeyHash))
        .accountsPartial({
          owner: wotsOwner.publicKey,
          vault: wotsVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([wotsOwner])
        .rpc();

      const vault = await program.account.winternitzVault.fetch(wotsVaultPda);
      expect(vault.owner.toBase58()).to.equal(wotsOwner.publicKey.toBase58());
      expect(Array.from(vault.wotsPubkeyHash)).to.deep.equal(Array.from(keypair0.publicKeyHash));
      expect(vault.balance.toNumber()).to.equal(0);
      expect(vault.withdrawalCount.toNumber()).to.equal(0);
      expect(vault.frozen).to.be.false;
    });

    it('rejects duplicate vault initialization', async () => {
      try {
        await program.methods
          .initWinternitzVault(Array.from(keypair0.publicKeyHash))
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        // PDA already initialized — Anchor rejects re-init
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('already in use') ||
          msg.includes('already been processed') ||
          msg.includes('custom program error'),
        );
      }
    });

    it('deposits SOL into the vault', async () => {
      const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

      await program.methods
        .depositWinternitz(depositAmount)
        .accountsPartial({
          owner: wotsOwner.publicKey,
          vault: wotsVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([wotsOwner])
        .rpc();

      const vault = await program.account.winternitzVault.fetch(wotsVaultPda);
      expect(vault.balance.toNumber()).to.equal(depositAmount.toNumber());
    });

    it('rejects zero deposit', async () => {
      try {
        await program.methods
          .depositWinternitz(new BN(0))
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('ZeroAmount');
      }
    });

    it('rejects deposit from non-owner', async () => {
      try {
        await program.methods
          .depositWinternitz(new BN(1 * LAMPORTS_PER_SOL))
          .accountsPartial({
            owner: attacker.publicKey,
            vault: wotsVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        // PDA seeds won't match or has_one constraint fails
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('ConstraintSeeds') ||
          msg.includes('ConstraintHasOne') ||
          msg.includes('A seeds constraint was violated') ||
          msg.includes('has one constraint'),
        );
      }
    });

    it('withdraws with valid WOTS+ signature and rotates key', async () => {
      const withdrawAmount = BigInt(2 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(0);

      // Compute the message the on-chain program will reconstruct
      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      // Sign with keypair0
      const sig = wotsSign(message, keypair0);

      const destBalBefore = await provider.connection.getBalance(destination.publicKey);

      const sigBufferPda = await uploadWotsSig(program, wotsOwner, wotsVaultPda, sig.signature);

      await program.methods
        .withdrawWinternitz(
          new BN(Number(withdrawAmount)),
          Array.from(keypair1.publicKeyHash),
        )
        .accountsPartial({
          owner: wotsOwner.publicKey,
          vault: wotsVaultPda,
          sigBuffer: sigBufferPda,
          destination: destination.publicKey,
          authority: wotsOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wotsOwner])
        .rpc();

      await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);

      const vault = await program.account.winternitzVault.fetch(wotsVaultPda);
      expect(vault.balance.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
      expect(vault.withdrawalCount.toNumber()).to.equal(1);
      // Key rotated to keypair1
      expect(Array.from(vault.wotsPubkeyHash)).to.deep.equal(Array.from(keypair1.publicKeyHash));

      const destBalAfter = await provider.connection.getBalance(destination.publicKey);
      expect(destBalAfter - destBalBefore).to.equal(Number(withdrawAmount));
    });

    it('second withdrawal uses the rotated key (keypair1)', async () => {
      const withdrawAmount = BigInt(1 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(1); // second withdrawal

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      const sig = wotsSign(message, keypair1);

      const sigBufferPda = await uploadWotsSig(program, wotsOwner, wotsVaultPda, sig.signature);

      await program.methods
        .withdrawWinternitz(
          new BN(Number(withdrawAmount)),
          Array.from(keypair2.publicKeyHash),
        )
        .accountsPartial({
          owner: wotsOwner.publicKey,
          vault: wotsVaultPda,
          sigBuffer: sigBufferPda,
          destination: destination.publicKey,
          authority: wotsOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wotsOwner])
        .rpc();

      await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);

      const vault = await program.account.winternitzVault.fetch(wotsVaultPda);
      expect(vault.balance.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
      expect(vault.withdrawalCount.toNumber()).to.equal(2);
      expect(Array.from(vault.wotsPubkeyHash)).to.deep.equal(Array.from(keypair2.publicKeyHash));
    });

    it('rejects withdrawal with stale WOTS+ key (keypair0 after rotation)', async () => {
      const withdrawAmount = BigInt(1 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(2);

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      // Sign with the OLD keypair0 (already rotated away)
      const sig = wotsSign(message, keypair0);
      const nextKeypair = deriveWotsKeypair(masterSeed, 3);

      try {
        const sigBufferPda = await uploadWotsSig(program, wotsOwner, wotsVaultPda, sig.signature);
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            sigBuffer: sigBufferPda,
            destination: destination.publicKey,
            authority: wotsOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('WotsPubkeyMismatch');
      } finally {
        await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);
      }
    });

    it('rejects withdrawal exceeding balance', async () => {
      const withdrawAmount = BigInt(100 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(2);

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      const sig = wotsSign(message, keypair2);
      const nextKeypair = deriveWotsKeypair(masterSeed, 3);

      try {
        const sigBufferPda = await uploadWotsSig(program, wotsOwner, wotsVaultPda, sig.signature);
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            sigBuffer: sigBufferPda,
            destination: destination.publicKey,
            authority: wotsOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InsufficientBalance');
      } finally {
        await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);
      }
    });

    it('rejects withdrawal with zero amount', async () => {
      const message = computeWithdrawMessage(
        BigInt(0),
        destination.publicKey.toBytes(),
        BigInt(2),
      );

      const sig = wotsSign(message, keypair2);
      const nextKeypair = deriveWotsKeypair(masterSeed, 3);

      try {
        const sigBufferPda = await uploadWotsSig(program, wotsOwner, wotsVaultPda, sig.signature);
        await program.methods
          .withdrawWinternitz(
            new BN(0),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            sigBuffer: sigBufferPda,
            destination: destination.publicKey,
            authority: wotsOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('ZeroAmount');
      } finally {
        await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);
      }
    });

    it('rejects withdrawal with wrong signature length', async () => {
      // Buffer size is validated at init time — initializing with wrong size should fail.
      const nextKeypair = deriveWotsKeypair(masterSeed, 3);
      const [sigBufferPda] = findWotsSigBufferPda(wotsVaultPda, wotsOwner.publicKey);

      try {
        await program.methods
          .initWotsSigBuffer(512) // 512 != WOTS_SIG_SIZE (2144)
          .accountsPartial({
            authority: wotsOwner.publicKey,
            vault: wotsVaultPda,
            buffer: sigBufferPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();

        await program.methods
          .withdrawWinternitz(
            new BN(1 * LAMPORTS_PER_SOL),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            sigBuffer: sigBufferPda,
            destination: destination.publicKey,
            authority: wotsOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('InvalidWotsSignature') ||
          msg.includes('InvalidSigSize') ||
          msg.includes('custom program error'),
        );
      } finally {
        await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);
      }
    });

    it('rejects withdrawal with tampered signature (wrong chain value)', async () => {
      const withdrawAmount = BigInt(1 * LAMPORTS_PER_SOL);
      const withdrawalCount = BigInt(2);

      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        withdrawalCount,
      );

      const sig = wotsSign(message, keypair2);

      // Tamper with the first chain in the signature
      const tamperedSig = new Uint8Array(sig.signature);
      tamperedSig[0] ^= 0xff;

      const nextKeypair = deriveWotsKeypair(masterSeed, 3);

      try {
        const sigBufferPda = await uploadWotsSig(program, wotsOwner, wotsVaultPda, tamperedSig);
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accountsPartial({
            owner: wotsOwner.publicKey,
            vault: wotsVaultPda,
            sigBuffer: sigBufferPda,
            destination: destination.publicKey,
            authority: wotsOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wotsOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('InvalidWotsSignature') ||
          msg.includes('WotsPubkeyMismatch'),
        );
      } finally {
        await closeWotsSigBuffer(program, wotsOwner, wotsVaultPda);
      }
    });

    it('rejects withdrawal signed by non-owner', async () => {
      const withdrawAmount = BigInt(1 * LAMPORTS_PER_SOL);

      // Attacker tries to use the correct WOTS+ sig but signs with their key
      const message = computeWithdrawMessage(
        withdrawAmount,
        destination.publicKey.toBytes(),
        BigInt(2),
      );
      const sig = wotsSign(message, keypair2);
      const nextKeypair = deriveWotsKeypair(masterSeed, 3);

      try {
        // Attacker uploads their own sig buffer scoped to their pubkey.
        const sigBufferPda = await uploadWotsSig(program, attacker, wotsVaultPda, sig.signature);
        await program.methods
          .withdrawWinternitz(
            new BN(Number(withdrawAmount)),
            Array.from(nextKeypair.publicKeyHash),
          )
          .accountsPartial({
            owner: attacker.publicKey,
            vault: wotsVaultPda,
            sigBuffer: sigBufferPda,
            destination: destination.publicKey,
            authority: attacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('ConstraintSeeds') ||
          msg.includes('ConstraintHasOne') ||
          msg.includes('A seeds constraint was violated') ||
          msg.includes('has one constraint'),
        );
      } finally {
        await closeWotsSigBuffer(program, attacker, wotsVaultPda);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Hash-Timelock Vault
  // ────────────────────────────────────────────────────────────────

  describe('Hash-Timelock Vault', () => {
    it('initializes a hash vault with no timelock', async () => {
      await program.methods
        .initHashVault(
          Array.from(hashCommitment),
          new BN(0),                   // no timelock
          destination.publicKey,
        )
        .accountsPartial({
          owner: hashOwner.publicKey,
          vault: hashVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([hashOwner])
        .rpc();

      const vault = await program.account.hashVault.fetch(hashVaultPda);
      expect(vault.owner.toBase58()).to.equal(hashOwner.publicKey.toBase58());
      expect(Array.from(vault.commitment)).to.deep.equal(Array.from(hashCommitment));
      expect(vault.balance.toNumber()).to.equal(0);
      expect(vault.unlockAfter.toNumber()).to.equal(0);
      expect(vault.destination.toBase58()).to.equal(destination.publicKey.toBase58());
      expect(vault.drained).to.be.false;
    });

    it('deposits SOL into the hash vault', async () => {
      const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

      await program.methods
        .depositHashVault(depositAmount)
        .accountsPartial({
          owner: hashOwner.publicKey,
          vault: hashVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([hashOwner])
        .rpc();

      const vault = await program.account.hashVault.fetch(hashVaultPda);
      expect(vault.balance.toNumber()).to.equal(depositAmount.toNumber());
    });

    it('rejects zero deposit', async () => {
      try {
        await program.methods
          .depositHashVault(new BN(0))
          .accountsPartial({
            owner: hashOwner.publicKey,
            vault: hashVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([hashOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('ZeroAmount');
      }
    });

    it('rejects deposit from non-owner', async () => {
      try {
        await program.methods
          .depositHashVault(new BN(1 * LAMPORTS_PER_SOL))
          .accountsPartial({
            owner: attacker.publicKey,
            vault: hashVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('ConstraintSeeds') ||
          msg.includes('ConstraintHasOne') ||
          msg.includes('A seeds constraint was violated') ||
          msg.includes('has one constraint'),
        );
      }
    });

    it('withdraws with correct preimage (no timelock)', async () => {
      const withdrawAmount = new BN(2 * LAMPORTS_PER_SOL);
      const destBalBefore = await provider.connection.getBalance(destination.publicKey);

      await program.methods
        .withdrawHashVault(
          Array.from(hashSecret),
          withdrawAmount,
        )
        .accountsPartial({
          signer: hashOwner.publicKey,
          vault: hashVaultPda,
          destination: destination.publicKey,
        })
        .signers([hashOwner])
        .rpc();

      const vault = await program.account.hashVault.fetch(hashVaultPda);
      expect(vault.balance.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
      expect(vault.drained).to.be.false;

      const destBalAfter = await provider.connection.getBalance(destination.publicKey);
      expect(destBalAfter - destBalBefore).to.equal(withdrawAmount.toNumber());
    });

    it('anyone with preimage can withdraw (quantum-safe property)', async () => {
      const withdrawAmount = new BN(1 * LAMPORTS_PER_SOL);
      const destBalBefore = await provider.connection.getBalance(destination.publicKey);

      // A third-party signer (not the owner) calls withdraw with the correct preimage
      await program.methods
        .withdrawHashVault(
          Array.from(hashSecret),
          withdrawAmount,
        )
        .accountsPartial({
          signer: attacker.publicKey,
          vault: hashVaultPda,
          destination: destination.publicKey,
        })
        .signers([attacker])
        .rpc();

      const vault = await program.account.hashVault.fetch(hashVaultPda);
      expect(vault.balance.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);

      const destBalAfter = await provider.connection.getBalance(destination.publicKey);
      expect(destBalAfter - destBalBefore).to.equal(withdrawAmount.toNumber());
    });

    it('rejects withdrawal with wrong preimage', async () => {
      const badPreimage = new Uint8Array(32);
      badPreimage.fill(0xff);

      try {
        await program.methods
          .withdrawHashVault(
            Array.from(badPreimage),
            new BN(1 * LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            signer: hashOwner.publicKey,
            vault: hashVaultPda,
            destination: destination.publicKey,
          })
          .signers([hashOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('PreimageMismatch');
      }
    });

    it('rejects withdrawal to wrong destination', async () => {
      const wrongDest = Keypair.generate();
      await fundAccount(provider, wrongDest.publicKey, 0.01);

      try {
        await program.methods
          .withdrawHashVault(
            Array.from(hashSecret),
            new BN(1 * LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            signer: hashOwner.publicKey,
            vault: hashVaultPda,
            destination: wrongDest.publicKey,
          })
          .signers([hashOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('PreimageMismatch');
      }
    });

    it('rejects withdrawal exceeding balance', async () => {
      try {
        await program.methods
          .withdrawHashVault(
            Array.from(hashSecret),
            new BN(100 * LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            signer: hashOwner.publicKey,
            vault: hashVaultPda,
            destination: destination.publicKey,
          })
          .signers([hashOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InsufficientBalance');
      }
    });

    it('drains the remaining balance and marks as drained', async () => {
      const vault = await program.account.hashVault.fetch(hashVaultPda);
      const remaining = vault.balance;

      await program.methods
        .withdrawHashVault(
          Array.from(hashSecret),
          remaining,
        )
        .accountsPartial({
          signer: hashOwner.publicKey,
          vault: hashVaultPda,
          destination: destination.publicKey,
        })
        .signers([hashOwner])
        .rpc();

      const vaultAfter = await program.account.hashVault.fetch(hashVaultPda);
      expect(vaultAfter.balance.toNumber()).to.equal(0);
      expect(vaultAfter.drained).to.be.true;
    });

    it('rejects withdrawal from a drained vault', async () => {
      try {
        await program.methods
          .withdrawHashVault(
            Array.from(hashSecret),
            new BN(1),
          )
          .accountsPartial({
            signer: hashOwner.publicKey,
            vault: hashVaultPda,
            destination: destination.publicKey,
          })
          .signers([hashOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('AlreadyDrained');
      }
    });

    it('rejects deposit into a drained vault', async () => {
      try {
        await program.methods
          .depositHashVault(new BN(1 * LAMPORTS_PER_SOL))
          .accountsPartial({
            owner: hashOwner.publicKey,
            vault: hashVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([hashOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('AlreadyDrained');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Hash-Timelock Vault (with timelock)
  // ────────────────────────────────────────────────────────────────

  describe('Hash-Timelock Vault (timelock)', () => {
    const timelockOwner = Keypair.generate();
    const timelockDest = Keypair.generate();
    const timelockSecret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) timelockSecret[i] = 0xa0 + (i % 16);
    const timelockCommitment = new Uint8Array(sha256(timelockSecret));
    let timelockVaultPda: PublicKey;

    before(async () => {
      await fundAccount(provider, timelockOwner.publicKey, 10);
      await fundAccount(provider, timelockDest.publicKey, 0.01);
      [timelockVaultPda] = findHashVaultPda(timelockOwner.publicKey);
    });

    it('initializes a hash vault with a future timelock', async () => {
      // Set unlock_after to a time far in the future
      const futureTime = Math.floor(Date.now() / 1000) + 86400; // +1 day

      await program.methods
        .initHashVault(
          Array.from(timelockCommitment),
          new BN(futureTime),
          timelockDest.publicKey,
        )
        .accountsPartial({
          owner: timelockOwner.publicKey,
          vault: timelockVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([timelockOwner])
        .rpc();

      const vault = await program.account.hashVault.fetch(timelockVaultPda);
      expect(vault.unlockAfter.toNumber()).to.equal(futureTime);
    });

    it('deposits into the timelocked vault', async () => {
      await program.methods
        .depositHashVault(new BN(3 * LAMPORTS_PER_SOL))
        .accountsPartial({
          owner: timelockOwner.publicKey,
          vault: timelockVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([timelockOwner])
        .rpc();

      const vault = await program.account.hashVault.fetch(timelockVaultPda);
      expect(vault.balance.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
    });

    it('rejects withdrawal before timelock expires', async () => {
      try {
        await program.methods
          .withdrawHashVault(
            Array.from(timelockSecret),
            new BN(1 * LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            signer: timelockOwner.publicKey,
            vault: timelockVaultPda,
            destination: timelockDest.publicKey,
          })
          .signers([timelockOwner])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('TimelockActive');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Commit-Then-Reveal
  // ────────────────────────────────────────────────────────────────

  describe('Commit-Then-Reveal', () => {
    const actionData = Buffer.from('transfer:destination:1000000');
    const nonce = new Uint8Array(32);
    for (let i = 0; i < 32; i++) nonce[i] = 0xcc + (i % 8);

    // Compute commitment: SHA-256(action_data || nonce)
    const commitmentBytes = new Uint8Array(sha256(concatBytes(actionData, nonce)));
    let commitPda: PublicKey;

    it('creates a commitment', async () => {
      [commitPda] = findCommitPda(committer.publicKey, commitmentBytes);

      const revealWindow = new BN(450); // default reveal window

      await program.methods
        .createCommitment(
          Array.from(commitmentBytes),
          0,              // action_type = transfer
          revealWindow,
        )
        .accountsPartial({
          committer: committer.publicKey,
          record: commitPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([committer])
        .rpc();

      const record = await program.account.commitRecord.fetch(commitPda);
      expect(record.committer.toBase58()).to.equal(committer.publicKey.toBase58());
      expect(Array.from(record.commitment)).to.deep.equal(Array.from(commitmentBytes));
      expect(record.revealed).to.be.false;
      expect(record.actionType).to.equal(0);
      expect(record.minRevealDelay.toNumber()).to.equal(MIN_REVEAL_DELAY);
      expect(record.maxRevealWindow.toNumber()).to.equal(450);
      expect(record.commitSlot.toNumber()).to.be.greaterThan(0);
    });

    it('rejects reveal too early (within min_reveal_delay)', async () => {
      // Try to reveal immediately (same slot or next slot)
      try {
        await program.methods
          .revealCommitment(actionData, Array.from(nonce))
          .accountsPartial({
            committer: committer.publicKey,
            record: commitPda,
          })
          .signers([committer])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('RevealTooEarly');
      }
    });

    it('reveals after minimum delay', async () => {
      // Advance slots past MIN_REVEAL_DELAY by sending transactions
      await confirmTxAndAdvanceSlots(provider, MIN_REVEAL_DELAY + 1);

      await program.methods
        .revealCommitment(actionData, Array.from(nonce))
        .accountsPartial({
          committer: committer.publicKey,
          record: commitPda,
        })
        .signers([committer])
        .rpc();

      const record = await program.account.commitRecord.fetch(commitPda);
      expect(record.revealed).to.be.true;
    });

    it('rejects double reveal', async () => {
      try {
        await program.methods
          .revealCommitment(actionData, Array.from(nonce))
          .accountsPartial({
            committer: committer.publicKey,
            record: commitPda,
          })
          .signers([committer])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('AlreadyRevealed');
      }
    });

    it('rejects reveal with wrong data (commitment mismatch)', async () => {
      // Create a new commitment for this test
      const nonce2 = new Uint8Array(32);
      for (let i = 0; i < 32; i++) nonce2[i] = 0xdd + (i % 4);
      const actionData2 = Buffer.from('unshield:my-nullifier:500');
      const commitment2 = new Uint8Array(sha256(concatBytes(actionData2, nonce2)));
      const [commitPda2] = findCommitPda(committer.publicKey, commitment2);

      await program.methods
        .createCommitment(
          Array.from(commitment2),
          1,
          new BN(450),
        )
        .accountsPartial({
          committer: committer.publicKey,
          record: commitPda2,
          systemProgram: SystemProgram.programId,
        })
        .signers([committer])
        .rpc();

      // Advance past delay
      await confirmTxAndAdvanceSlots(provider, MIN_REVEAL_DELAY + 1);

      // Try to reveal with wrong action data
      const wrongActionData = Buffer.from('WRONG_DATA');
      try {
        await program.methods
          .revealCommitment(wrongActionData, Array.from(nonce2))
          .accountsPartial({
            committer: committer.publicKey,
            record: commitPda2,
          })
          .signers([committer])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('CommitmentMismatch');
      }
    });

    it('rejects reveal with wrong nonce (commitment mismatch)', async () => {
      // Create a fresh commitment
      const nonce3 = new Uint8Array(32);
      for (let i = 0; i < 32; i++) nonce3[i] = 0xee + (i % 3);
      const actionData3 = Buffer.from('claim:stealth:42');
      const commitment3 = new Uint8Array(sha256(concatBytes(actionData3, nonce3)));
      const [commitPda3] = findCommitPda(committer.publicKey, commitment3);

      await program.methods
        .createCommitment(
          Array.from(commitment3),
          2,
          new BN(450),
        )
        .accountsPartial({
          committer: committer.publicKey,
          record: commitPda3,
          systemProgram: SystemProgram.programId,
        })
        .signers([committer])
        .rpc();

      await confirmTxAndAdvanceSlots(provider, MIN_REVEAL_DELAY + 1);

      const wrongNonce = new Uint8Array(32);
      wrongNonce.fill(0x00);

      try {
        await program.methods
          .revealCommitment(actionData3, Array.from(wrongNonce))
          .accountsPartial({
            committer: committer.publicKey,
            record: commitPda3,
          })
          .signers([committer])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('CommitmentMismatch');
      }
    });

    it('rejects invalid reveal window (too small)', async () => {
      const badActionData = Buffer.from('test-bad-window');
      const badNonce = new Uint8Array(32).fill(0x11);
      const badCommitment = new Uint8Array(sha256(concatBytes(badActionData, badNonce)));
      const [badPda] = findCommitPda(committer.publicKey, badCommitment);

      try {
        await program.methods
          .createCommitment(
            Array.from(badCommitment),
            0,
            new BN(1), // too small, less than MIN_REVEAL_DELAY
          )
          .accountsPartial({
            committer: committer.publicKey,
            record: badPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([committer])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidRevealWindow');
      }
    });

    it('rejects invalid reveal window (too large)', async () => {
      const bigActionData = Buffer.from('test-big-window');
      const bigNonce = new Uint8Array(32).fill(0x22);
      const bigCommitment = new Uint8Array(sha256(concatBytes(bigActionData, bigNonce)));
      const [bigPda] = findCommitPda(committer.publicKey, bigCommitment);

      try {
        await program.methods
          .createCommitment(
            Array.from(bigCommitment),
            0,
            new BN(MAX_REVEAL_WINDOW + 1), // too large
          )
          .accountsPartial({
            committer: committer.publicKey,
            record: bigPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([committer])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidRevealWindow');
      }
    });

    it('rejects reveal from non-committer', async () => {
      const nonce4 = new Uint8Array(32).fill(0x44);
      const actionData4 = Buffer.from('transfer:foreign:999');
      const commitment4 = new Uint8Array(sha256(concatBytes(actionData4, nonce4)));
      const [commitPda4] = findCommitPda(committer.publicKey, commitment4);

      await program.methods
        .createCommitment(
          Array.from(commitment4),
          0,
          new BN(450),
        )
        .accountsPartial({
          committer: committer.publicKey,
          record: commitPda4,
          systemProgram: SystemProgram.programId,
        })
        .signers([committer])
        .rpc();

      await confirmTxAndAdvanceSlots(provider, MIN_REVEAL_DELAY + 1);

      // Attacker tries to reveal someone else's commitment
      try {
        await program.methods
          .revealCommitment(actionData4, Array.from(nonce4))
          .accountsPartial({
            committer: attacker.publicKey,
            record: commitPda4,
          })
          .signers([attacker])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('ConstraintSeeds') ||
          msg.includes('ConstraintHasOne') ||
          msg.includes('A seeds constraint was violated') ||
          msg.includes('has one constraint'),
        );
      }
    });
  });
});

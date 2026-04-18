/**
 * p01_registry - Stealth Meta-Address Registry Test Suite
 *
 * Tests the registry program that provides:
 *   - v1 registration (classical X25519 stealth meta-address)
 *   - v2 registration (hybrid X25519 + ML-KEM-768)
 *   - Key updates (v1 and v2)
 *   - Name updates
 *   - Deregistration (rent reclaim)
 *
 * Program ID: Hz4ZULacefgJzq94YJTSq3WmQAySyYuzCRiEzNXCA2sZ
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
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import type { P01Registry } from '../target/types/p01_registry';

// ============================================================================
// Constants (match Rust program)
// ============================================================================

const PROGRAM_ID = new PublicKey('Hz4ZULacefgJzq94YJTSq3WmQAySyYuzCRiEzNXCA2sZ');

/** ML-KEM-768 public key size per FIPS 203 */
const KEM_PUBKEY_LEN = 1184;

/** Maximum display name length (UTF-8 bytes) */
const MAX_NAME_LEN = 32;

const SEEDS = {
  USER_REGISTRY: Buffer.from('user_registry'),
};

// ============================================================================
// PDA Helpers
// ============================================================================

function findRegistryPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.USER_REGISTRY, owner.toBuffer()],
    PROGRAM_ID,
  );
}

// ============================================================================
// Key Generation Helpers
// ============================================================================

function randomKey32(): number[] {
  return Array.from(Keypair.generate().publicKey.toBuffer());
}

function zeroKey32(): number[] {
  return new Array(32).fill(0);
}

function realKemPublicKey(): { publicKey: number[]; secretKey: Uint8Array } {
  const keys = ml_kem768.keygen();
  return { publicKey: Array.from(keys.publicKey), secretKey: keys.secretKey };
}

function randomKemPublicKey(): number[] {
  const key = new Uint8Array(KEM_PUBKEY_LEN);
  for (let i = 0; i < KEM_PUBKEY_LEN; i++) key[i] = Math.floor(Math.random() * 256);
  return Array.from(key);
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

// ============================================================================
// Tests
// ============================================================================

describe('p01_registry', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program<P01Registry>(
    require('../target/idl/p01_registry.json'),
    provider,
  );

  const admin = provider.wallet as anchor.Wallet;
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const user3 = Keypair.generate();
  const attacker = Keypair.generate();

  let user1Pda: PublicKey;
  let user2Pda: PublicKey;
  let user3Pda: PublicKey;

  // Pre-generate keys for tests
  const spendingKey1 = randomKey32();
  const viewingKey1 = randomKey32();
  const spendingKey2 = randomKey32();
  const viewingKey2 = randomKey32();

  before(async () => {
    await fundAccount(provider, user1.publicKey, 10);
    await fundAccount(provider, user2.publicKey, 10);
    await fundAccount(provider, user3.publicKey, 10);
    await fundAccount(provider, attacker.publicKey, 5);

    [user1Pda] = findRegistryPda(user1.publicKey);
    [user2Pda] = findRegistryPda(user2.publicKey);
    [user3Pda] = findRegistryPda(user3.publicKey);
  });

  // ────────────────────────────────────────────────────────────────
  // register_v1
  // ────────────────────────────────────────────────────────────────

  describe('register_v1', () => {
    it('registers a v1 meta-address with spending and viewing keys', async () => {
      await program.methods
        .registerV1(spendingKey1, viewingKey1, 'alice.sol')
        .accountsPartial({
          owner: user1.publicKey,
          entry: user1Pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user1Pda);
      expect(entry.owner.toBase58()).to.equal(user1.publicKey.toBase58());
      expect(Array.from(entry.spendingPubKey)).to.deep.equal(spendingKey1);
      expect(Array.from(entry.viewingPubKey)).to.deep.equal(viewingKey1);
      expect(entry.version).to.equal(1);
      expect(entry.hasKemKey).to.be.false;
      expect(Array.from(entry.kemPubKey).every((b: number) => b === 0)).to.be.true;
      expect(entry.name).to.equal('alice.sol');
      expect(entry.createdAt.toNumber()).to.be.greaterThan(0);
      expect(entry.updatedAt.toNumber()).to.equal(entry.createdAt.toNumber());
    });

    it('rejects duplicate registration', async () => {
      try {
        await program.methods
          .registerV1(spendingKey1, viewingKey1, 'alice-dup')
          .accountsPartial({
            owner: user1.publicKey,
            entry: user1Pda,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('already in use') ||
          msg.includes('already been processed') ||
          msg.includes('custom program error'),
        );
      }
    });

    it('rejects zero spending key', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      try {
        await program.methods
          .registerV1(zeroKey32(), viewingKey1, 'zero-spend')
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });

    it('rejects zero viewing key', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      try {
        await program.methods
          .registerV1(spendingKey1, zeroKey32(), 'zero-view')
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });

    it('rejects name exceeding 32 bytes', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      const longName = 'a'.repeat(MAX_NAME_LEN + 1);

      try {
        await program.methods
          .registerV1(randomKey32(), randomKey32(), longName)
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('NameTooLong');
      }
    });

    it('accepts empty name', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      await program.methods
        .registerV1(randomKey32(), randomKey32(), '')
        .accountsPartial({
          owner: tempUser.publicKey,
          entry: tempPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([tempUser])
        .rpc();

      const entry = await program.account.userRegistry.fetch(tempPda);
      expect(entry.name).to.equal('');
      expect(entry.version).to.equal(1);
    });

    it('accepts max-length name (32 bytes)', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      const maxName = 'b'.repeat(MAX_NAME_LEN);

      await program.methods
        .registerV1(randomKey32(), randomKey32(), maxName)
        .accountsPartial({
          owner: tempUser.publicKey,
          entry: tempPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([tempUser])
        .rpc();

      const entry = await program.account.userRegistry.fetch(tempPda);
      expect(entry.name).to.equal(maxName);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // register_v2
  // ────────────────────────────────────────────────────────────────

  describe('register_v2', () => {
    it('registers a v2 hybrid meta-address with ML-KEM-768 key', async () => {
      const kem = realKemPublicKey();

      await program.methods
        .registerV2(
          spendingKey2,
          viewingKey2,
          Buffer.from(kem.publicKey),
          'bob-pq.sol',
        )
        .accountsPartial({
          owner: user2.publicKey,
          entry: user2Pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user2Pda);
      expect(entry.owner.toBase58()).to.equal(user2.publicKey.toBase58());
      expect(Array.from(entry.spendingPubKey)).to.deep.equal(spendingKey2);
      expect(Array.from(entry.viewingPubKey)).to.deep.equal(viewingKey2);
      expect(entry.version).to.equal(2);
      expect(entry.hasKemKey).to.be.true;
      expect(entry.kemPubKey.length).to.equal(KEM_PUBKEY_LEN);
      // Verify first 32 bytes of KEM key match
      expect(Array.from(entry.kemPubKey).slice(0, 32)).to.deep.equal(kem.publicKey.slice(0, 32));
      expect(entry.name).to.equal('bob-pq.sol');
    });

    it('rejects v2 registration with wrong KEM key size', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      const badKemKey = Buffer.alloc(100, 0xaa); // wrong size

      try {
        await program.methods
          .registerV2(
            randomKey32(),
            randomKey32(),
            badKemKey,
            'bad-kem',
          )
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKemKey');
      }
    });

    it('rejects v2 registration with zero spending key', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      try {
        await program.methods
          .registerV2(
            zeroKey32(),
            randomKey32(),
            Buffer.from(randomKemPublicKey()),
            'bad-spend',
          )
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });

    it('rejects v2 registration with zero viewing key', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      try {
        await program.methods
          .registerV2(
            randomKey32(),
            zeroKey32(),
            Buffer.from(randomKemPublicKey()),
            'bad-view',
          )
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });

    it('rejects v2 registration with name too long', async () => {
      const tempUser = Keypair.generate();
      await fundAccount(provider, tempUser.publicKey, 5);
      const [tempPda] = findRegistryPda(tempUser.publicKey);

      const longName = 'x'.repeat(MAX_NAME_LEN + 1);

      try {
        await program.methods
          .registerV2(
            randomKey32(),
            randomKey32(),
            Buffer.from(randomKemPublicKey()),
            longName,
          )
          .accountsPartial({
            owner: tempUser.publicKey,
            entry: tempPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([tempUser])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('NameTooLong');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // update_keys_v1
  // ────────────────────────────────────────────────────────────────

  describe('update_keys_v1', () => {
    it('updates keys to new v1 values', async () => {
      const newSpending = randomKey32();
      const newViewing = randomKey32();

      await program.methods
        .updateKeysV1(newSpending, newViewing)
        .accountsPartial({
          owner: user1.publicKey,
          entry: user1Pda,
        })
        .signers([user1])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user1Pda);
      expect(Array.from(entry.spendingPubKey)).to.deep.equal(newSpending);
      expect(Array.from(entry.viewingPubKey)).to.deep.equal(newViewing);
      expect(entry.version).to.equal(1);
      expect(entry.hasKemKey).to.be.false;
      // KEM key should be zeroed after v1 update
      expect(Array.from(entry.kemPubKey).every((b: number) => b === 0)).to.be.true;
      expect(entry.updatedAt.toNumber()).to.be.greaterThan(entry.createdAt.toNumber());
    });

    it('rejects update_keys_v1 from non-owner', async () => {
      try {
        await program.methods
          .updateKeysV1(randomKey32(), randomKey32())
          .accountsPartial({
            owner: attacker.publicKey,
            entry: user1Pda,
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

    it('rejects update_keys_v1 with zero spending key', async () => {
      try {
        await program.methods
          .updateKeysV1(zeroKey32(), randomKey32())
          .accountsPartial({
            owner: user1.publicKey,
            entry: user1Pda,
          })
          .signers([user1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });

    it('rejects update_keys_v1 with zero viewing key', async () => {
      try {
        await program.methods
          .updateKeysV1(randomKey32(), zeroKey32())
          .accountsPartial({
            owner: user1.publicKey,
            entry: user1Pda,
          })
          .signers([user1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // update_keys_v2
  // ────────────────────────────────────────────────────────────────

  describe('update_keys_v2', () => {
    it('upgrades a v1 entry to v2 with KEM key', async () => {
      const newSpending = randomKey32();
      const newViewing = randomKey32();
      const kem = realKemPublicKey();

      await program.methods
        .updateKeysV2(newSpending, newViewing, Buffer.from(kem.publicKey))
        .accountsPartial({
          owner: user1.publicKey,
          entry: user1Pda,
        })
        .signers([user1])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user1Pda);
      expect(Array.from(entry.spendingPubKey)).to.deep.equal(newSpending);
      expect(Array.from(entry.viewingPubKey)).to.deep.equal(newViewing);
      expect(entry.version).to.equal(2);
      expect(entry.hasKemKey).to.be.true;
      expect(entry.kemPubKey.length).to.equal(KEM_PUBKEY_LEN);
      expect(Array.from(entry.kemPubKey).slice(0, 32)).to.deep.equal(kem.publicKey.slice(0, 32));
    });

    it('rotates KEM key on an existing v2 entry', async () => {
      const newSpending = randomKey32();
      const newViewing = randomKey32();
      const newKem = realKemPublicKey();

      await program.methods
        .updateKeysV2(newSpending, newViewing, Buffer.from(newKem.publicKey))
        .accountsPartial({
          owner: user2.publicKey,
          entry: user2Pda,
        })
        .signers([user2])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user2Pda);
      expect(entry.version).to.equal(2);
      expect(entry.hasKemKey).to.be.true;
      expect(Array.from(entry.kemPubKey).slice(0, 32)).to.deep.equal(newKem.publicKey.slice(0, 32));
    });

    it('rejects update_keys_v2 from non-owner', async () => {
      try {
        await program.methods
          .updateKeysV2(randomKey32(), randomKey32(), Buffer.from(randomKemPublicKey()))
          .accountsPartial({
            owner: attacker.publicKey,
            entry: user2Pda,
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

    it('rejects update_keys_v2 with wrong KEM key size', async () => {
      const badKemKey = Buffer.alloc(500, 0xbb);

      try {
        await program.methods
          .updateKeysV2(randomKey32(), randomKey32(), badKemKey)
          .accountsPartial({
            owner: user1.publicKey,
            entry: user1Pda,
          })
          .signers([user1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKemKey');
      }
    });

    it('rejects update_keys_v2 with zero spending key', async () => {
      try {
        await program.methods
          .updateKeysV2(zeroKey32(), randomKey32(), Buffer.from(randomKemPublicKey()))
          .accountsPartial({
            owner: user1.publicKey,
            entry: user1Pda,
          })
          .signers([user1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidKey');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // update_name
  // ────────────────────────────────────────────────────────────────

  describe('update_name', () => {
    it('updates the display name', async () => {
      await program.methods
        .updateName('alice-v2.sol')
        .accountsPartial({
          owner: user1.publicKey,
          entry: user1Pda,
        })
        .signers([user1])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user1Pda);
      expect(entry.name).to.equal('alice-v2.sol');
    });

    it('updates name to empty string', async () => {
      await program.methods
        .updateName('')
        .accountsPartial({
          owner: user1.publicKey,
          entry: user1Pda,
        })
        .signers([user1])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user1Pda);
      expect(entry.name).to.equal('');
    });

    it('updates name to max length', async () => {
      const maxName = 'z'.repeat(MAX_NAME_LEN);

      await program.methods
        .updateName(maxName)
        .accountsPartial({
          owner: user1.publicKey,
          entry: user1Pda,
        })
        .signers([user1])
        .rpc();

      const entry = await program.account.userRegistry.fetch(user1Pda);
      expect(entry.name).to.equal(maxName);
    });

    it('rejects name exceeding max length', async () => {
      const longName = 'q'.repeat(MAX_NAME_LEN + 1);

      try {
        await program.methods
          .updateName(longName)
          .accountsPartial({
            owner: user1.publicKey,
            entry: user1Pda,
          })
          .signers([user1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('NameTooLong');
      }
    });

    it('rejects name update from non-owner', async () => {
      try {
        await program.methods
          .updateName('hacked')
          .accountsPartial({
            owner: attacker.publicKey,
            entry: user1Pda,
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

  // ────────────────────────────────────────────────────────────────
  // deregister
  // ────────────────────────────────────────────────────────────────

  describe('deregister', () => {
    let deregUser: Keypair;
    let deregPda: PublicKey;

    before(async () => {
      deregUser = Keypair.generate();
      await fundAccount(provider, deregUser.publicKey, 10);
      [deregPda] = findRegistryPda(deregUser.publicKey);

      // Register a v1 entry to deregister
      await program.methods
        .registerV1(randomKey32(), randomKey32(), 'to-delete')
        .accountsPartial({
          owner: deregUser.publicKey,
          entry: deregPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([deregUser])
        .rpc();
    });

    it('rejects deregistration from non-owner', async () => {
      try {
        await program.methods
          .deregister()
          .accountsPartial({
            owner: attacker.publicKey,
            entry: deregPda,
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

    it('deregisters and reclaims rent', async () => {
      const balBefore = await provider.connection.getBalance(deregUser.publicKey);

      await program.methods
        .deregister()
        .accountsPartial({
          owner: deregUser.publicKey,
          entry: deregPda,
        })
        .signers([deregUser])
        .rpc();

      // Account should be closed
      const accountInfo = await provider.connection.getAccountInfo(deregPda);
      expect(accountInfo).to.be.null;

      // Owner should have received rent back (minus tx fee)
      const balAfter = await provider.connection.getBalance(deregUser.publicKey);
      expect(balAfter).to.be.greaterThan(balBefore);
    });

    it('can re-register after deregistration', async () => {
      const newSpending = randomKey32();
      const newViewing = randomKey32();

      await program.methods
        .registerV1(newSpending, newViewing, 're-registered')
        .accountsPartial({
          owner: deregUser.publicKey,
          entry: deregPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([deregUser])
        .rpc();

      const entry = await program.account.userRegistry.fetch(deregPda);
      expect(entry.owner.toBase58()).to.equal(deregUser.publicKey.toBase58());
      expect(entry.name).to.equal('re-registered');
      expect(Array.from(entry.spendingPubKey)).to.deep.equal(newSpending);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Cross-version upgrade/downgrade flows
  // ────────────────────────────────────────────────────────────────

  describe('Version upgrade/downgrade flows', () => {
    let flowUser: Keypair;
    let flowPda: PublicKey;

    before(async () => {
      flowUser = Keypair.generate();
      await fundAccount(provider, flowUser.publicKey, 10);
      [flowPda] = findRegistryPda(flowUser.publicKey);
    });

    it('registers as v2, then downgrades to v1 via update_keys_v1', async () => {
      const kem = realKemPublicKey();

      // Register as v2
      await program.methods
        .registerV2(
          randomKey32(),
          randomKey32(),
          Buffer.from(kem.publicKey),
          'quantum-user',
        )
        .accountsPartial({
          owner: flowUser.publicKey,
          entry: flowPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([flowUser])
        .rpc();

      let entry = await program.account.userRegistry.fetch(flowPda);
      expect(entry.version).to.equal(2);
      expect(entry.hasKemKey).to.be.true;

      // Downgrade to v1
      const newSpending = randomKey32();
      const newViewing = randomKey32();

      await program.methods
        .updateKeysV1(newSpending, newViewing)
        .accountsPartial({
          owner: flowUser.publicKey,
          entry: flowPda,
        })
        .signers([flowUser])
        .rpc();

      entry = await program.account.userRegistry.fetch(flowPda);
      expect(entry.version).to.equal(1);
      expect(entry.hasKemKey).to.be.false;
      expect(Array.from(entry.kemPubKey).every((b: number) => b === 0)).to.be.true;
      expect(Array.from(entry.spendingPubKey)).to.deep.equal(newSpending);
      expect(Array.from(entry.viewingPubKey)).to.deep.equal(newViewing);
    });

    it('upgrades back to v2 from v1 via update_keys_v2', async () => {
      const kem2 = realKemPublicKey();
      const newSpending = randomKey32();
      const newViewing = randomKey32();

      await program.methods
        .updateKeysV2(newSpending, newViewing, Buffer.from(kem2.publicKey))
        .accountsPartial({
          owner: flowUser.publicKey,
          entry: flowPda,
        })
        .signers([flowUser])
        .rpc();

      const entry = await program.account.userRegistry.fetch(flowPda);
      expect(entry.version).to.equal(2);
      expect(entry.hasKemKey).to.be.true;
      expect(Array.from(entry.kemPubKey).slice(0, 32)).to.deep.equal(kem2.publicKey.slice(0, 32));
    });
  });
});

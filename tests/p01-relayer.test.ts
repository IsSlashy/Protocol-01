/**
 * p01_relayer - Decentralized Relayer Network Test Suite
 *
 * Program ID: 2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW
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
import type { P01Relayer } from '../target/types/p01_relayer';

/** ML-KEM-768 public key size per FIPS 203 */
const KEM_PUBLIC_KEY_SIZE = 1184;

const PROGRAM_ID = new PublicKey('2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW');

const SEEDS = {
  CONFIG: Buffer.from('relayer_config'),
  RELAYER_NODE: Buffer.from('relayer_node'),
  RELAY_JOB: Buffer.from('relay_job'),
};

const MIN_STAKE = new BN(1 * LAMPORTS_PER_SOL);
const MAX_RELAYERS = 10;
const JOB_FEE = new BN(0.01 * LAMPORTS_PER_SOL);
const PROTOCOL_FEE_BPS = 500;
const JOB_TIMEOUT_SLOTS = 300;
const SLASH_AMOUNT = new BN(0.1 * LAMPORTS_PER_SOL);
const COOLDOWN_SLOTS = new BN(100);

function findConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEEDS.CONFIG], PROGRAM_ID);
}

function findRelayerNodePda(operator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.RELAYER_NODE, operator.toBuffer()],
    PROGRAM_ID,
  );
}

function findJobPda(jobId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.RELAY_JOB, jobId],
    PROGRAM_ID,
  );
}

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

function randomJobId(): Buffer {
  return Buffer.from(sha256(Keypair.generate().publicKey.toBuffer()));
}

function randomEncryptionKey(): number[] {
  return Array.from(Keypair.generate().publicKey.toBuffer()).slice(0, 32);
}

function randomEndpointHash(): number[] {
  return Array.from(sha256(Buffer.from('https://relay.protocol01.io')));
}

function randomKemPublicKey(): number[] {
  const key = new Uint8Array(KEM_PUBLIC_KEY_SIZE);
  for (let i = 0; i < KEM_PUBLIC_KEY_SIZE; i++) key[i] = Math.floor(Math.random() * 256);
  return Array.from(key);
}

function realKemPublicKey(): { publicKey: number[]; secretKey: Uint8Array } {
  const keys = ml_kem768.keygen();
  return { publicKey: Array.from(keys.publicKey), secretKey: keys.secretKey };
}

describe('p01_relayer', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program<P01Relayer>(
    require('../target/idl/p01_relayer.json'),
    provider,
  );

  const admin = provider.wallet as anchor.Wallet;
  const protocolFeeWallet = Keypair.generate();
  const operator1 = Keypair.generate();
  const operator2 = Keypair.generate();
  const submitter = Keypair.generate();

  const [configPda] = findConfigPda();
  let relayer1Pda: PublicKey;
  let relayer2Pda: PublicKey;

  before(async () => {
    await fundAccount(provider, operator1.publicKey, 10);
    await fundAccount(provider, operator2.publicKey, 10);
    await fundAccount(provider, submitter.publicKey, 5);
    await fundAccount(provider, protocolFeeWallet.publicKey, 0.01);

    [relayer1Pda] = findRelayerNodePda(operator1.publicKey);
    [relayer2Pda] = findRelayerNodePda(operator2.publicKey);
  });

  describe('Config', () => {
    it('initializes relayer config', async () => {
      await program.methods
        .initializeConfig(
          MIN_STAKE,
          MAX_RELAYERS,
          JOB_FEE,
          PROTOCOL_FEE_BPS,
          protocolFeeWallet.publicKey,
          new BN(JOB_TIMEOUT_SLOTS),
          SLASH_AMOUNT,
          COOLDOWN_SLOTS,
        )
        .accountsPartial({
          authority: admin.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await program.account.relayerConfig.fetch(configPda);
      expect(config.authority.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(config.minStake.toNumber()).to.equal(MIN_STAKE.toNumber());
      expect(config.maxRelayers).to.equal(MAX_RELAYERS);
      expect(config.jobFeeLamports.toNumber()).to.equal(JOB_FEE.toNumber());
      expect(config.protocolFeeBps).to.equal(PROTOCOL_FEE_BPS);
      expect(config.activeRelayerCount).to.equal(0);
      expect(config.isActive).to.be.true;
    });

    it('updates config parameters', async () => {
      const newFee = new BN(0.02 * LAMPORTS_PER_SOL);
      await program.methods
        .updateConfig(null, null, newFee, null, null, null, null, null, null)
        .accountsPartial({ authority: admin.publicKey, config: configPda })
        .rpc();

      const config = await program.account.relayerConfig.fetch(configPda);
      expect(config.jobFeeLamports.toNumber()).to.equal(newFee.toNumber());

      await program.methods
        .updateConfig(null, null, JOB_FEE, null, null, null, null, null, null)
        .accountsPartial({ authority: admin.publicKey, config: configPda })
        .rpc();
    });

    it('rejects update from non-authority', async () => {
      try {
        await program.methods
          .updateConfig(null, null, null, null, null, null, null, null, null)
          .accountsPartial({ authority: operator1.publicKey, config: configPda })
          .signers([operator1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('Unauthorized');
      }
    });
  });

  describe('Relayer Registration', () => {
    it('registers relayer 1 with stake (no KEM key)', async () => {
      const encKey = randomEncryptionKey();
      const endpointHash = randomEndpointHash();

      await program.methods
        .registerRelayer(encKey, endpointHash, null)
        .accountsPartial({
          operator: operator1.publicKey,
          config: configPda,
          relayerNode: relayer1Pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator1])
        .rpc();

      const node = await program.account.relayerNode.fetch(relayer1Pda);
      expect(node.operator.toBase58()).to.equal(operator1.publicKey.toBase58());
      expect(node.isActive).to.be.true;
      expect(node.stake.toNumber()).to.equal(MIN_STAKE.toNumber());
      expect(node.reputationScore).to.equal(5000);
      expect(node.jobsCompleted.toNumber()).to.equal(0);
      expect(node.hasKemKey).to.be.false;
      expect(Array.from(node.kemEncryptionKey).every((b: number) => b === 0)).to.be.true;

      const config = await program.account.relayerConfig.fetch(configPda);
      expect(config.activeRelayerCount).to.equal(1);
    });

    it('registers relayer 2 (no KEM key)', async () => {
      await program.methods
        .registerRelayer(randomEncryptionKey(), randomEndpointHash(), null)
        .accountsPartial({
          operator: operator2.publicKey,
          config: configPda,
          relayerNode: relayer2Pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator2])
        .rpc();

      const config = await program.account.relayerConfig.fetch(configPda);
      expect(config.activeRelayerCount).to.equal(2);
    });

    it('rotates encryption key (X25519 only, no KEM update)', async () => {
      const newKey = randomEncryptionKey();
      await program.methods
        .updateRelayerKey(newKey, null)
        .accountsPartial({
          operator: operator1.publicKey,
          relayerNode: relayer1Pda,
        })
        .signers([operator1])
        .rpc();

      const node = await program.account.relayerNode.fetch(relayer1Pda);
      expect(Array.from(node.encryptionKey)).to.deep.equal(newKey);
      expect(node.hasKemKey).to.be.false;
    });
  });

  describe('ML-KEM-768 Key Management', () => {
    it('registers relayer with KEM public key', async () => {
      const newOp = Keypair.generate();
      await fundAccount(provider, newOp.publicKey, 10);
      const [newPda] = findRelayerNodePda(newOp.publicKey);

      const kem = realKemPublicKey();
      await program.methods
        .registerRelayer(randomEncryptionKey(), randomEndpointHash(), Buffer.from(kem.publicKey))
        .accountsPartial({
          operator: newOp.publicKey,
          config: configPda,
          relayerNode: newPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([newOp])
        .rpc();

      const node = await program.account.relayerNode.fetch(newPda);
      expect(node.hasKemKey).to.be.true;
      expect(node.kemEncryptionKey.length).to.equal(KEM_PUBLIC_KEY_SIZE);
      expect(Array.from(node.kemEncryptionKey).slice(0, 32)).to.deep.equal(kem.publicKey.slice(0, 32));

      await program.methods
        .deactivateRelayer()
        .accountsPartial({ operator: newOp.publicKey, config: configPda, relayerNode: newPda })
        .signers([newOp])
        .rpc();
    });

    it('adds KEM key to existing relayer via updateRelayerKey', async () => {
      const kem = realKemPublicKey();
      await program.methods
        .updateRelayerKey(randomEncryptionKey(), Buffer.from(kem.publicKey))
        .accountsPartial({
          operator: operator1.publicKey,
          relayerNode: relayer1Pda,
        })
        .signers([operator1])
        .rpc();

      const node = await program.account.relayerNode.fetch(relayer1Pda);
      expect(node.hasKemKey).to.be.true;
      expect(Array.from(node.kemEncryptionKey).slice(0, 32)).to.deep.equal(kem.publicKey.slice(0, 32));
    });

    it('rejects invalid KEM key size', async () => {
      const badKey = Buffer.alloc(100, 0xaa);
      try {
        await program.methods
          .updateRelayerKey(randomEncryptionKey(), badKey)
          .accountsPartial({
            operator: operator1.publicKey,
            relayerNode: relayer1Pda,
          })
          .signers([operator1])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('InvalidEncryptionKey');
      }
    });

    it('rotates both X25519 and KEM keys simultaneously', async () => {
      const newX25519 = randomEncryptionKey();
      const newKem = realKemPublicKey();
      await program.methods
        .updateRelayerKey(newX25519, Buffer.from(newKem.publicKey))
        .accountsPartial({
          operator: operator1.publicKey,
          relayerNode: relayer1Pda,
        })
        .signers([operator1])
        .rpc();

      const node = await program.account.relayerNode.fetch(relayer1Pda);
      expect(Array.from(node.encryptionKey)).to.deep.equal(newX25519);
      expect(node.hasKemKey).to.be.true;
      expect(Array.from(node.kemEncryptionKey).slice(0, 32)).to.deep.equal(newKem.publicKey.slice(0, 32));
    });
  });

  describe('Job Submission & Completion', () => {
    let jobId: Buffer;
    let jobPda: PublicKey;

    it('submits an encrypted relay job', async () => {
      jobId = randomJobId();
      [jobPda] = findJobPda(jobId);

      const encryptedTx = Buffer.alloc(256);
      encryptedTx.fill(0xab);

      await program.methods
        .submitJob(Array.from(jobId), encryptedTx)
        .accountsPartial({
          submitter: submitter.publicKey,
          config: configPda,
          assignedRelayer: relayer1Pda,
          job: jobPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([submitter])
        .rpc();

      const job = await program.account.relayJob.fetch(jobPda);
      expect(Buffer.from(job.jobId)).to.deep.equal(jobId);
      expect(job.assignedRelayer.toBase58()).to.equal(relayer1Pda.toBase58());
      expect(job.submitter.toBase58()).to.equal(submitter.publicKey.toBase58());
      expect(job.feeLamports.toNumber()).to.equal(JOB_FEE.toNumber());
    });

    it('completes the job (relayer gets reward)', async () => {
      const txSig = Buffer.alloc(64);
      txSig.fill(0xcc);

      const protocolBalBefore = await provider.connection.getBalance(protocolFeeWallet.publicKey);

      await program.methods
        .completeJob(Array.from(txSig))
        .accountsPartial({
          operator: operator1.publicKey,
          config: configPda,
          relayerNode: relayer1Pda,
          job: jobPda,
          protocolFeeWallet: protocolFeeWallet.publicKey,
          submitter: submitter.publicKey,
        })
        .signers([operator1])
        .rpc();

      const jobAccount = await provider.connection.getAccountInfo(jobPda);
      expect(jobAccount).to.be.null;

      const protocolBalAfter = await provider.connection.getBalance(protocolFeeWallet.publicKey);
      const expectedProtocolFee = Math.floor(JOB_FEE.toNumber() * PROTOCOL_FEE_BPS / 10000);
      expect(protocolBalAfter - protocolBalBefore).to.equal(expectedProtocolFee);

      const node = await program.account.relayerNode.fetch(relayer1Pda);
      expect(node.jobsCompleted.toNumber()).to.equal(1);

      const config = await program.account.relayerConfig.fetch(configPda);
      expect(config.totalJobsCompleted.toNumber()).to.equal(1);
    });
  });

  describe('Job Cancellation', () => {
    it('submitter can cancel a pending job', async () => {
      const jobId = randomJobId();
      const [jobPda] = findJobPda(jobId);
      const encryptedTx = Buffer.alloc(128, 0xdd);

      await program.methods
        .submitJob(Array.from(jobId), encryptedTx)
        .accountsPartial({
          submitter: submitter.publicKey,
          config: configPda,
          assignedRelayer: relayer1Pda,
          job: jobPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([submitter])
        .rpc();

      const balBefore = await provider.connection.getBalance(submitter.publicKey);

      await program.methods
        .cancelJob()
        .accountsPartial({
          submitter: submitter.publicKey,
          job: jobPda,
        })
        .signers([submitter])
        .rpc();

      const jobAccount = await provider.connection.getAccountInfo(jobPda);
      expect(jobAccount).to.be.null;

      const balAfter = await provider.connection.getBalance(submitter.publicKey);
      expect(balAfter).to.be.greaterThan(balBefore);
    });
  });

  describe('Deactivation & Unstaking', () => {
    it('deactivates relayer 2', async () => {
      await program.methods
        .deactivateRelayer()
        .accountsPartial({
          operator: operator2.publicKey,
          config: configPda,
          relayerNode: relayer2Pda,
        })
        .signers([operator2])
        .rpc();

      const node = await program.account.relayerNode.fetch(relayer2Pda);
      expect(node.isActive).to.be.false;
      expect(node.deactivatedAtSlot.toNumber()).to.be.greaterThan(0);

      const config = await program.account.relayerConfig.fetch(configPda);
      expect(config.activeRelayerCount).to.equal(1);
    });

    it('rejects unstake before cooldown', async () => {
      try {
        await program.methods
          .unstakeRelayer()
          .accountsPartial({
            operator: operator2.publicKey,
            config: configPda,
            relayerNode: relayer2Pda,
            systemProgram: SystemProgram.programId,
          })
          .signers([operator2])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('Cooldown');
      }
    });
  });

  describe('Error Cases', () => {
    it('rejects oversized encrypted tx', async () => {
      const jobId = randomJobId();
      const [jobPda] = findJobPda(jobId);
      const oversizedTx = Buffer.alloc(1500, 0xff);

      try {
        await program.methods
          .submitJob(Array.from(jobId), oversizedTx)
          .accountsPartial({
            submitter: submitter.publicKey,
            config: configPda,
            assignedRelayer: relayer1Pda,
            job: jobPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([submitter])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.satisfy((msg: string) =>
          msg.includes('EncryptedTxTooLarge') || msg.includes('overruns') || msg.includes('too large'),
        );
      }
    });

    it('rejects registration when protocol is paused', async () => {
      await program.methods
        .updateConfig(null, null, null, null, null, null, null, null, false)
        .accountsPartial({ authority: admin.publicKey, config: configPda })
        .rpc();

      const newOp = Keypair.generate();
      await fundAccount(provider, newOp.publicKey, 5);
      const [newPda] = findRelayerNodePda(newOp.publicKey);

      try {
        await program.methods
          .registerRelayer(randomEncryptionKey(), randomEndpointHash(), null)
          .accountsPartial({
            operator: newOp.publicKey,
            config: configPda,
            relayerNode: newPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([newOp])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('ProtocolPaused');
      }

      await program.methods
        .updateConfig(null, null, null, null, null, null, null, null, true)
        .accountsPartial({ authority: admin.publicKey, config: configPda })
        .rpc();
    });

    it('rejects job on inactive relayer', async () => {
      const jobId = randomJobId();
      const [jobPda] = findJobPda(jobId);

      try {
        await program.methods
          .submitJob(Array.from(jobId), Buffer.alloc(64, 0xaa))
          .accountsPartial({
            submitter: submitter.publicKey,
            config: configPda,
            assignedRelayer: relayer2Pda,
            job: jobPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([submitter])
          .rpc();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('RelayerNotActive');
      }
    });
  });
});

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import {
  RescueCipher,
  x25519,
  getMXEPublicKey,
  deserializeLE,
  getArciumEnv,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
} from '@arcium-hq/client';
import { randomBytes } from 'crypto';
import { expect } from 'chai';

// Program ID — deployed on devnet
const PROGRAM_ID = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');
const CLUSTER_OFFSET = 456;

describe('p01_arcium — Arcium MPC Integration', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let program: Program;
  let ephemeralPrivKey: Uint8Array;
  let ephemeralPubKey: Uint8Array;
  let sharedSecret: Uint8Array;
  let cipher: RescueCipher;

  before(async () => {
    program = await anchor.workspace.P01Arcium;

    // Setup x25519 key exchange with MXE
    ephemeralPrivKey = x25519.utils.randomSecretKey();
    ephemeralPubKey = x25519.getPublicKey(ephemeralPrivKey);
    const mxePubKey = await getMXEPublicKey(provider, PROGRAM_ID);
    sharedSecret = x25519.getSharedSecret(ephemeralPrivKey, mxePubKey);
    cipher = new RescueCipher(sharedSecret);
  });

  function encrypt(values: bigint[]) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt(values, nonce);
    return { ciphertexts, nonce, pubKey: ephemeralPubKey };
  }

  function getAccounts(circuitName: string, computationOffset: anchor.BN) {
    const env = getArciumEnv();
    return {
      computationAccount: getComputationAccAddress(env.arciumClusterOffset, computationOffset),
      clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(PROGRAM_ID),
      mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(
        PROGRAM_ID,
        Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE()
      ),
    };
  }

  // =========================================================================
  // Initialization — register all computation definitions
  // =========================================================================

  describe('Initialization', () => {
    const circuits = [
      'balance_audit',
      'finalize_audit',
      'private_vote',
      'finalize_tally',
      'private_vote_binary',
      'finalize_tally_binary',
      'nullifier_commit',
      'private_lookup',
      'register_viewing_key',
      'stealth_scan_single',
      'threshold_decrypt',
    ];

    for (const circuit of circuits) {
      it(`Init comp_def: ${circuit}`, async () => {
        const methodName = `init${circuit
          .split('_')
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join('')}CompDef`;

        try {
          await (program.methods as any)[methodName]()
            .accountsPartial({})
            .rpc({ commitment: 'confirmed' });
        } catch (e: any) {
          // Already initialized is OK
          if (!e.message.includes('already in use')) throw e;
        }
      });
    }
  });

  // =========================================================================
  // UC4: Confidential Balance Audit
  // =========================================================================

  describe('UC4: Confidential Balance Audit', () => {
    const auditId = randomBytes(32);

    it('Submit encrypted balance', async () => {
      const balance = 1_000_000_000n; // 1 SOL in lamports
      const { ciphertexts, nonce, pubKey } = encrypt([balance]);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('balance_audit', computationOffset);

      const [accumulatorAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_audit'), auditId],
        PROGRAM_ID
      );

      const tx = await program.methods
        .submitBalanceAudit(
          computationOffset,
          Array.from(ciphertexts[0]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString()),
          Array.from(auditId)
        )
        .accountsPartial({
          ...accounts,
          auditAccumulator: accumulatorAddress,
          payer: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Balance audit submitted:', tx);

      // Wait for MPC finalization
      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC finalized:', finalizeSig);
    });
  });

  // =========================================================================
  // UC6: Private Governance Vote
  // =========================================================================

  describe('UC6: Private Governance Vote', () => {
    const proposalId = randomBytes(32);

    it('Create proposal', async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const [proposalAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_proposal'), proposalId],
        PROGRAM_ID
      );

      const tx = await program.methods
        .createProposal(Array.from(proposalId), 2, new anchor.BN(deadline))
        .accountsPartial({
          proposal: proposalAddress,
          authority: provider.wallet.publicKey,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Proposal created:', tx);
    });

    it('Cast encrypted vote', async () => {
      const optionIndex = 1n; // Vote for option 1
      const weight = 1n;
      const { ciphertexts, nonce, pubKey } = encrypt([optionIndex, weight]);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('private_vote', computationOffset);

      const [proposalAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_proposal'), proposalId],
        PROGRAM_ID
      );
      const [ballotAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('p01_ballot'),
          proposalId,
          provider.wallet.publicKey.toBuffer(),
        ],
        PROGRAM_ID
      );

      const tx = await program.methods
        .castVote(
          computationOffset,
          Array.from(proposalId),
          Array.from(ciphertexts[0]),
          Array.from(ciphertexts[1]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          ...accounts,
          proposal: proposalAddress,
          ballot: ballotAddress,
          voter: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Vote cast:', tx);

      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC finalized:', finalizeSig);
    });

    it('Rejects double-vote', async () => {
      const { ciphertexts, nonce, pubKey } = encrypt([0n, 1n]);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('private_vote', computationOffset);

      const [proposalAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_proposal'), proposalId],
        PROGRAM_ID
      );
      const [ballotAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('p01_ballot'),
          proposalId,
          provider.wallet.publicKey.toBuffer(),
        ],
        PROGRAM_ID
      );

      try {
        await program.methods
          .castVote(
            computationOffset,
            Array.from(proposalId),
            Array.from(ciphertexts[0]),
            Array.from(ciphertexts[1]),
            Array.from(pubKey),
            new anchor.BN(deserializeLE(nonce).toString())
          )
          .accountsPartial({
            ...accounts,
            proposal: proposalAddress,
            ballot: ballotAddress,
            voter: provider.wallet.publicKey,
          })
          .rpc({ commitment: 'confirmed' });

        throw new Error('Should have failed — double vote');
      } catch (e: any) {
        expect(e.message).to.include('already in use');
        console.log('  Double-vote correctly rejected');
      }
    });
  });

  // =========================================================================
  // UC6b: Binary Vote (optimized — 2 comparisons)
  // =========================================================================

  describe('UC6b: Binary Vote (optimized)', () => {
    const proposalId = randomBytes(32);

    it('Create proposal for binary vote', async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const [proposalAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_proposal'), proposalId],
        PROGRAM_ID
      );

      const tx = await program.methods
        .createProposal(Array.from(proposalId), 2, new anchor.BN(deadline))
        .accountsPartial({
          proposal: proposalAddress,
          authority: provider.wallet.publicKey,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Binary proposal created:', tx);
    });

    it('Cast binary vote (yes)', async () => {
      const optionIndex = 1n; // yes
      const weight = 1n;
      const { ciphertexts, nonce, pubKey } = encrypt([optionIndex, weight]);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('private_vote_binary', computationOffset);

      const [proposalAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_proposal'), proposalId],
        PROGRAM_ID
      );
      const [ballotAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('p01_ballot'),
          proposalId,
          provider.wallet.publicKey.toBuffer(),
        ],
        PROGRAM_ID
      );

      const tx = await program.methods
        .privateVoteBinary(
          computationOffset,
          Array.from(ciphertexts[0]),
          Array.from(ciphertexts[1]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          ...accounts,
          proposal: proposalAddress,
          ballot: ballotAddress,
          voter: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Binary vote cast:', tx);

      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC finalized:', finalizeSig);
    });
  });

  // =========================================================================
  // UC3: Hidden Nullifier Commitment
  // =========================================================================

  describe('UC3: Hidden Nullifier Commitment', () => {
    it('Commit nullifier via MPC', async () => {
      const poolId = randomBytes(32);
      const nullifier = randomBytes(32);
      const nullifierBigint = BigInt('0x' + Buffer.from(nullifier).toString('hex'));

      const { ciphertexts, nonce, pubKey } = encrypt([nullifierBigint]);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('nullifier_commit', computationOffset);

      const [nullifierSetAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_nullifier_set'), poolId],
        PROGRAM_ID
      );

      const tx = await program.methods
        .commitNullifier(
          computationOffset,
          Array.from(poolId),
          Array.from(ciphertexts[0]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          ...accounts,
          nullifierSet: nullifierSetAddress,
          payer: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Nullifier committed:', tx);

      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC returned commitment:', finalizeSig);

      // Verify commitment is on-chain in logs
      const txData = await provider.connection.getTransaction(finalizeSig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      const logs = txData?.meta?.logMessages || [];
      const commitLog = logs.find((l) => l.includes('NullifierCommitment:'));
      expect(commitLog).to.not.be.undefined;
      console.log('  Commitment:', commitLog);
    });
  });

  // =========================================================================
  // UC1: Confidential Relay
  // =========================================================================

  describe('UC1: Confidential Relay', () => {
    it('Submit encrypted TX for threshold decryption', async () => {
      // Create a dummy serialized TX (64 bytes for one chunk)
      const dummyTx = randomBytes(64);
      const chunks: bigint[] = [];
      for (let i = 0; i < dummyTx.length; i += 8) {
        chunks.push(
          BigInt('0x' + Buffer.from(dummyTx.slice(i, i + 8)).reverse().toString('hex'))
        );
      }

      const { ciphertexts, nonce, pubKey } = encrypt(chunks);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('threshold_decrypt', computationOffset);

      const [relayJobAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_arcium_relay'), computationOffset.toArray('le', 8)],
        PROGRAM_ID
      );

      const fee = 5000n; // 5000 lamports
      const slot = await provider.connection.getSlot();
      const deadline = BigInt(slot) + 100n;

      const tx = await program.methods
        .submitConfidentialRelay(
          computationOffset,
          Array.from(ciphertexts[0]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString()),
          new anchor.BN(fee.toString()),
          new anchor.BN(deadline.toString()),
          dummyTx.length
        )
        .accountsPartial({
          ...accounts,
          relayJob: relayJobAddress,
          payer: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Relay job submitted:', tx);

      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC decrypted:', finalizeSig);

      // Verify relay job account
      const jobAccount = await program.account.relayJob.fetch(relayJobAddress);
      expect(jobAccount.fee.toNumber()).to.equal(5000);
      expect(jobAccount.originalTxLen).to.equal(64);
      console.log('  Relay job verified on-chain');
    });
  });

  // =========================================================================
  // UC5: Threshold Stealth Scanning
  // =========================================================================

  describe('UC5: Threshold Stealth Scanning', () => {
    it('Register viewing key via MPC', async () => {
      const viewingKey = randomBytes(32);
      const chunks: bigint[] = [];
      for (let i = 0; i < 32; i += 8) {
        chunks.push(
          BigInt('0x' + Buffer.from(viewingKey.slice(i, i + 8)).reverse().toString('hex'))
        );
      }

      const { ciphertexts, nonce, pubKey } = encrypt(chunks);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('register_viewing_key', computationOffset);

      const [viewingKeyAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_viewing_key'), provider.wallet.publicKey.toBuffer()],
        PROGRAM_ID
      );

      const tx = await program.methods
        .registerViewingKey(
          computationOffset,
          Array.from(ciphertexts[0]),
          Array.from(ciphertexts[1]),
          Array.from(ciphertexts[2]),
          Array.from(ciphertexts[3]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          ...accounts,
          viewingKeyAccount: viewingKeyAddress,
          owner: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Viewing key registered:', tx);

      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC stored key:', finalizeSig);
    });
  });

  // =========================================================================
  // UC2: Anonymous Registry Lookup
  // =========================================================================

  describe('UC2: Anonymous Registry Lookup', () => {
    it('Private lookup without revealing target', async () => {
      const targetWallet = Keypair.generate().publicKey;
      const walletBytes = targetWallet.toBuffer();
      const chunks: bigint[] = [];
      for (let i = 0; i < 32; i += 8) {
        chunks.push(
          BigInt('0x' + Buffer.from(walletBytes.slice(i, i + 8)).reverse().toString('hex'))
        );
      }

      const { ciphertexts, nonce, pubKey } = encrypt(chunks);
      const computationOffset = new anchor.BN(randomBytes(8), 'hex');
      const accounts = getAccounts('private_lookup', computationOffset);

      const [registryAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), targetWallet.toBuffer()],
        new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB')
      );

      const tx = await program.methods
        .privateLookup(
          computationOffset,
          Array.from(ciphertexts[0]),
          Array.from(ciphertexts[1]),
          Array.from(ciphertexts[2]),
          Array.from(ciphertexts[3]),
          Array.from(pubKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          ...accounts,
          registryAccount: registryAddress,
          payer: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log('  Private lookup submitted:', tx);

      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        'confirmed'
      );

      console.log('  MPC returned result:', finalizeSig);
    });
  });
});

import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS, type EncryptedPayload } from '../client';

/**
 * UC6: Private Governance Voting -- Encrypted Ballot Tallying
 *
 * Encrypted votes are accumulated by MPC; only the final tally is revealed.
 * Individual votes are never disclosed to any party.
 *
 * Supports binary (yes/no), multi-option (1-of-N), and weighted (token-weighted)
 * voting. A ballot receipt PDA prevents double-voting.
 *
 * **Inputs**: Encrypted vote (option index + weight).
 * **Output**: Per-option tallies and winner (revealed after deadline).
 *
 * @module governance
 */

/** Configuration for creating a new governance proposal. */
export interface ProposalConfig {
  /** Unique proposal identifier (arbitrary bytes, typically a hash). */
  proposalId: Uint8Array;
  /** Number of voting options (2 for yes/no, N for multi-choice). */
  optionCount: number;
  /** Voting deadline as a Unix timestamp (seconds). */
  deadline: number;
  /** Authority wallet that can finalize the tally. */
  authority: PublicKey;
}

/** Receipt returned after casting an encrypted vote. */
export interface VoteReceipt {
  /** Computation offset for tracking this MPC job. */
  computationOffset: anchor.BN;
  /** Public key of the voter. */
  voter: PublicKey;
  /** First ciphertext block of the encrypted vote (opaque after submission). */
  encryptedVote: number[];
  /** Transaction signature of the vote submission. */
  signature: string;
}

/** Finalized tally result with per-option vote counts. */
export interface TallyResult {
  /** Vote count per option (index-aligned with proposal options). */
  tallies: bigint[];
  /** Total votes cast across all options. */
  totalVotes: bigint;
  /** Index of the winning option (highest vote count). */
  winner: number;
  /** Finalization callback transaction signature. */
  signature: string;
}

const PROPOSAL_SEED = 'p01_proposal';
const BALLOT_SEED = 'p01_ballot';

/** Derive the proposal account PDA (stores encrypted accumulator) */
export function getProposalAddress(
  programId: PublicKey,
  proposalId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PROPOSAL_SEED), proposalId],
    programId
  );
}

/** Derive the ballot receipt PDA (prevents double-voting) */
export function getBallotAddress(
  programId: PublicKey,
  proposalId: Uint8Array,
  voter: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BALLOT_SEED), proposalId, voter.toBuffer()],
    programId
  );
}

/**
 * Create a new governance proposal.
 *
 * Initializes the encrypted accumulator in MXE state (all zeros).
 * The proposal PDA tracks metadata; the MPC accumulator holds encrypted tallies.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param config - Proposal configuration (ID, options, deadline, authority).
 * @returns Transaction signature of the proposal creation.
 * @throws {Error} "Governance MPC computation failed: ..." if creation fails.
 */
export async function createProposal(
  client: ArciumClient,
  program: anchor.Program,
  config: ProposalConfig
): Promise<string> {
  const [proposalAddress] = getProposalAddress(client.programId, config.proposalId);

  try {
    const sig = await program.methods
      .createProposal(
        Array.from(config.proposalId),
        config.optionCount,
        new anchor.BN(config.deadline)
      )
      .accountsPartial({
        proposal: proposalAddress,
        authority: config.authority,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    return sig;
  } catch (err) {
    throw new Error(
      `Governance MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }
}

/**
 * Cast an encrypted vote on a proposal.
 *
 * The voter encrypts their choice (option index + weight) with the
 * Arcium shared secret. MPC adds it to the accumulator without
 * decrypting any individual vote. A ballot PDA prevents double-voting.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param proposalId - The proposal to vote on.
 * @param optionIndex - Which option to vote for (0-indexed).
 * @param weight - Vote weight (default 1n for unweighted voting).
 * @returns Vote receipt with encrypted vote and signature.
 * @throws {Error} "Governance MPC computation failed: ..." if the vote fails.
 */
export async function castVote(
  client: ArciumClient,
  program: anchor.Program,
  proposalId: Uint8Array,
  optionIndex: number,
  weight: bigint = 1n
): Promise<VoteReceipt> {
  // Encrypt: [option_index, weight]
  const payload = client.encrypt([BigInt(optionIndex), weight]);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.PRIVATE_VOTE, computationOffset);

  const [proposalAddress] = getProposalAddress(client.programId, proposalId);
  const [ballotAddress] = getBallotAddress(client.programId, proposalId, client.wallet.publicKey);

  let sig: string;
  try {
    sig = await program.methods
      .castVote(
        computationOffset,
        Array.from(proposalId),
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.ciphertexts[1]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce)
      )
      .accountsPartial({
        ...accounts,
        proposal: proposalAddress,
        ballot: ballotAddress,
        voter: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });
  } catch (err) {
    throw new Error(
      `Governance MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  return {
    computationOffset,
    voter: client.wallet.publicKey,
    encryptedVote: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Finalize voting and reveal the tally.
 *
 * Only callable by the proposal authority after the deadline.
 * MPC reveals the accumulated totals per option via threshold decryption.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param proposalId - The proposal to finalize.
 * @returns Per-option tallies, total votes, winner index, and signature.
 * @throws {Error} "Governance MPC computation failed: ..." if finalization fails.
 */
export async function finalizeTally(
  client: ArciumClient,
  program: anchor.Program,
  proposalId: Uint8Array
): Promise<TallyResult> {
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.PRIVATE_VOTE, computationOffset);
  const [proposalAddress] = getProposalAddress(client.programId, proposalId);

  const sig = await program.methods
    .finalizeTally(computationOffset, Array.from(proposalId))
    .accountsPartial({
      ...accounts,
      proposal: proposalAddress,
      authority: client.wallet.publicKey,
    })
    .rpc({ commitment: 'confirmed' });

  const finalizeSig = await client.awaitFinalization(computationOffset);

  // Parse tally from callback event
  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const tallyLine = logs.find((l) => l.includes('TallyResult:'));
  const tallies = tallyLine
    ? tallyLine.split('TallyResult:')[1].trim().split(',').map(BigInt)
    : [];

  const totalVotes = tallies.reduce((a, b) => a + b, 0n);
  const winner = tallies.indexOf(
    tallies.reduce((max, v) => (v > max ? v : max), 0n)
  );

  return { tallies, totalVotes, winner, signature: finalizeSig };
}

// ============================================================================
// UC6b: Binary Voting (optimized — 2 MPC comparisons instead of 8)
// ============================================================================

/** Finalized binary (yes/no) tally result. */
export interface BinaryTallyResult {
  /** Votes for option 0 ("no"). */
  no: bigint;
  /** Votes for option 1 ("yes"). */
  yes: bigint;
  /** Total votes cast (no + yes). */
  totalVotes: bigint;
  /** Finalization callback transaction signature. */
  signature: string;
}

/**
 * Cast an encrypted binary vote (yes/no).
 *
 * Uses the `private_vote_binary` circuit for 75% fewer MPC comparisons
 * compared to the general multi-option circuit.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param proposalId - The proposal to vote on.
 * @param vote - `true` for yes, `false` for no.
 * @param weight - Vote weight (default 1n).
 * @returns Vote receipt.
 * @throws {Error} "Governance MPC computation failed: ..." if the vote fails.
 */
export async function castBinaryVote(
  client: ArciumClient,
  program: anchor.Program,
  proposalId: Uint8Array,
  vote: boolean,
  weight: bigint = 1n
): Promise<VoteReceipt> {
  const optionIndex = vote ? 1 : 0;
  const payload = client.encrypt([BigInt(optionIndex), weight]);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.PRIVATE_VOTE_BINARY, computationOffset);

  const [proposalAddress] = getProposalAddress(client.programId, proposalId);
  const [ballotAddress] = getBallotAddress(client.programId, proposalId, client.wallet.publicKey);

  const sig = await program.methods
    .privateVoteBinary(
      computationOffset,
      Array.from(payload.ciphertexts[0]),
      Array.from(payload.ciphertexts[1]),
      Array.from(payload.publicKey),
      client.nonceToU128(payload.nonce)
    )
    .accountsPartial({
      ...accounts,
      proposal: proposalAddress,
      ballot: ballotAddress,
      voter: client.wallet.publicKey,
    })
    .rpc({ commitment: 'confirmed' });

  return {
    computationOffset,
    voter: client.wallet.publicKey,
    encryptedVote: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Finalize binary voting and reveal the yes/no tally.
 *
 * Only callable by the proposal authority after the deadline.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param proposalId - The proposal to finalize.
 * @returns Binary tally (yes, no, total) and finalization signature.
 * @throws {Error} "Governance MPC computation failed: ..." if finalization fails.
 */
export async function finalizeBinaryTally(
  client: ArciumClient,
  program: anchor.Program,
  proposalId: Uint8Array
): Promise<BinaryTallyResult> {
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.PRIVATE_VOTE_BINARY, computationOffset);
  const [proposalAddress] = getProposalAddress(client.programId, proposalId);

  const sig = await program.methods
    .finalizeTallyBinary(computationOffset)
    .accountsPartial({
      ...accounts,
      proposal: proposalAddress,
      authority: client.wallet.publicKey,
    })
    .remainingAccounts([
      { pubkey: proposalAddress, isWritable: false, isSigner: false },
    ])
    .rpc({ commitment: 'confirmed' });

  const finalizeSig = await client.awaitFinalization(computationOffset);

  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const tallyLine = logs.find((l) => l.includes('BinaryTallyResult:'));
  let no = 0n;
  let yes = 0n;
  if (tallyLine) {
    const match = tallyLine.match(/no=(\d+), yes=(\d+)/);
    if (match) {
      no = BigInt(match[1]);
      yes = BigInt(match[2]);
    }
  }

  return { no, yes, totalVotes: no + yes, signature: finalizeSig };
}

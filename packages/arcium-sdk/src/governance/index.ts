import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS, type EncryptedPayload } from '../client';

/**
 * UC6: Private Governance Voting
 *
 * Encrypted votes → MPC tallies → reveal result only.
 * Individual votes never disclosed.
 *
 * Supports:
 * - Binary votes (yes/no)
 * - Multi-option votes (1-of-N)
 * - Weighted votes (token-weighted governance)
 */

export interface ProposalConfig {
  /** Unique proposal identifier */
  proposalId: Uint8Array;
  /** Number of options (2 for yes/no, N for multi-choice) */
  optionCount: number;
  /** Voting deadline (Unix timestamp) */
  deadline: number;
  /** Authority who can finalize */
  authority: PublicKey;
}

export interface VoteReceipt {
  /** Computation offset (for tracking) */
  computationOffset: anchor.BN;
  /** Voter's public key */
  voter: PublicKey;
  /** Encrypted vote (opaque to everyone including voter after submission) */
  encryptedVote: number[];
  /** Signature of the vote transaction */
  signature: string;
}

export interface TallyResult {
  /** Vote count per option (revealed after deadline) */
  tallies: bigint[];
  /** Total votes cast */
  totalVotes: bigint;
  /** Winning option index */
  winner: number;
  /** Finalization signature */
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
 * Initializes encrypted accumulator in MXE state (all zeros).
 */
export async function createProposal(
  client: ArciumClient,
  program: anchor.Program,
  config: ProposalConfig
): Promise<string> {
  const [proposalAddress] = getProposalAddress(client.programId, config.proposalId);

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
}

/**
 * Cast an encrypted vote.
 *
 * Flow:
 * 1. Voter encrypts their choice (option index) with Arcium shared secret
 * 2. Submits to P01 Arcium program
 * 3. Program checks: no double-vote (ballot PDA), deadline not passed
 * 4. CPIs to Arcium → MPC adds encrypted vote to accumulator
 * 5. Accumulator state updated (Enc<Mxe, T>) — only MPC nodes can read
 * 6. Receipt PDA created to prevent re-voting
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

  const sig = await program.methods
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

  return {
    computationOffset,
    voter: client.wallet.publicKey,
    encryptedVote: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Finalize voting and reveal tally.
 * Only callable by authority after deadline.
 * MPC reveals accumulated totals per option.
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

export interface BinaryTallyResult {
  /** Votes for option 0 (no) */
  no: bigint;
  /** Votes for option 1 (yes) */
  yes: bigint;
  /** Total votes cast */
  totalVotes: bigint;
  /** Finalization signature */
  signature: string;
}

/**
 * Cast an encrypted binary vote (yes/no).
 * Uses private_vote_binary circuit — 75% fewer MPC comparisons.
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
 * Finalize binary voting and reveal tally.
 * Only callable by authority after deadline.
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

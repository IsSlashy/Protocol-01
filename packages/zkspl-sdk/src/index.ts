// ==========================================================================
// @protocol-01/zkspl-sdk — SDK for Protocol 01 zkSPL Confidential Token Balances
// ==========================================================================

// Core client
export { ZkSplClient, type ZkSplClientConfig } from './client';

// Crypto utilities
export {
  poseidonHash,
  createBalanceCommitment,
  createAmountCommitment,
  deriveOwnerPubkey,
  randomSalt,
  deriveDeterministicSalt,
  fieldToBytes,
  fieldToBytesBE,
  bytesToField,
  pubkeyToField,
  zeroAmountHash,
} from './crypto';

// Prover
export {
  ZkSplProver,
  buildBalanceCircuitInputs,
  buildProofCircuitInputs,
  snarkjsProofToBytes,
} from './prover';

// Local state management
export {
  LocalStateManager,
  InMemoryStateStore,
  type StateStore,
} from './state';

// Types
export type {
  // Field / byte aliases
  Bytes32,
  FieldElement,

  // Groth16
  Groth16Proof,

  // On-chain accounts
  MintConfigAccount,
  ConfidentialAccountData,
  PendingCredit,

  // Circuit inputs
  ConfidentialBalancePublicInputs,
  ConfidentialBalancePrivateInputs,
  BalanceProofPublicInputs,
  BalanceProofPrivateInputs,

  // Local state
  LocalAccountState,
  KnownPendingCredit,

  // Config
  ProverConfig,

  // Results
  ZkSplTxResult,

  // Events
  AccountCreatedEvent,
  DepositEvent,
  WithdrawEvent,
  TransferEvent,
  ApplyPendingEvent,
  BalanceProofEvent,
} from './types';

// Constants
export {
  FIELD_MODULUS,
  ZKSPL_PROGRAM_ID,
  ZK_SHIELDED_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_DEVNET_MINT,
  TOKEN_DECIMALS,
  PDA_SEEDS,
  ZK_SHIELDED_PDA_SEEDS,
  USDC_DENOMINATIONS,
  VK_TYPE_BALANCE,
  VK_TYPE_PROOF,
  MAX_PENDING_CREDITS,
  MAX_VIEWER_KEYS,
  PROOF_GENERATION_TIMEOUT,
  CIRCUIT_FILES,
  PROGRAM_IDS,
  getProgramId,
  registerTokenDecimals,
} from './constants';
export type { NetworkId, ProgramName } from './constants';

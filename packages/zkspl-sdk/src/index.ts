// ==========================================================================
// @protocol-01/zkspl-sdk — SDK for Protocol 01 zkSPL Confidential Token Balances
// ==========================================================================
//
// STARK-only mode (post Groth16 migration):
// All proofs are generated out-of-band by the caller (typically via the
// Winterfell-backed WASM prover in apps/mobile or apps/extension), uploaded
// to `p01_stark_verifier`, and the verified proof buffer pubkey is passed
// to each zkSPL instruction. The SDK never generates proofs and never sees
// private witnesses.

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
  bytesToField,
  pubkeyToField,
  zeroAmountHash,
} from './crypto';

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

  // On-chain accounts
  MintConfigAccount,
  ConfidentialAccountData,
  PendingCredit,

  // Public inputs (for preparing STARK proofs out-of-band)
  ConfidentialBalancePublicInputs,
  BalanceProofPublicInputs,

  // Local state
  LocalAccountState,
  KnownPendingCredit,

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

// STARK circuit IDs
export {
  CIRCUIT_BALANCE_PROOF,
  CIRCUIT_CONFIDENTIAL_BALANCE,
} from './types';

// Constants
export {
  FIELD_MODULUS,
  ZKSPL_PROGRAM_ID,
  ZK_SHIELDED_PROGRAM_ID,
  STARK_VERIFIER_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_DEVNET_MINT,
  TOKEN_DECIMALS,
  PDA_SEEDS,
  ZK_SHIELDED_PDA_SEEDS,
  USDC_DENOMINATIONS,
  MAX_PENDING_CREDITS,
  MAX_VIEWER_KEYS,
  PROGRAM_IDS,
  getProgramId,
  registerTokenDecimals,
} from './constants';
export type { NetworkId, ProgramName } from './constants';

// Relay module — decentralized transaction relay via p01_relayer
//
// Usage:
//   1. Build your privacy transaction (unshield, stealth claim, etc.)
//   2. Fund an ephemeral keypair from the shielded pool
//   3. Call submitRelayJob() to encrypt + post the job on-chain
//   4. Call monitorJob() to wait for the relayer to execute it
//
// The relayer never knows who you are — only an ephemeral keypair
// appears on-chain, and the transaction payload is encrypted.

// Submit
export { submitRelayJob, generateJobId } from './submit';

// Encryption (for relayer node decryption too)
export { encryptForRelayer, decryptRelayJob } from './encrypt';

// Selection
export {
  fetchActiveRelayers,
  fetchRelayerConfig,
  selectRelayer,
} from './select';

// Monitoring
export { monitorJob, cancelRelayJob } from './monitor';

// Types
export {
  RELAYER_PROGRAM_ID_DEVNET,
  RELAY_SEEDS,
  ENCRYPTED_PAYLOAD_OVERHEAD,
  JobStatus,
  type RelayerNodeInfo,
  type RelayerConfigInfo,
  type RelayJobInfo,
  type SubmitRelayJobOptions,
  type RelayJobResult,
  type JobCompletionResult,
} from './types';

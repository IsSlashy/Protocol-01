/**
 * Indexing Module — Client-Side Blockchain Indexers
 *
 * Moves ALL indexing client-side so users talk directly to Solana.
 * No relayer, no WebSocket server, no custom API.
 */

// Commitment indexer (replaces relayer's /pool/state & /pool/commitments)
export {
  CommitmentIndexer,
  type CommitmentIndexerOptions,
  type IndexerStatus,
} from './commitment-indexer';

// Stealth payment indexer (replaces relayer's /relay/stealth-payments)
export {
  StealthIndexer,
  type StealthIndexerOptions,
} from './stealth-indexer';

// Cache backends for offline persistence
export {
  type IndexerCache,
  MemoryCache,
  LocalStorageCache,
} from './cache';

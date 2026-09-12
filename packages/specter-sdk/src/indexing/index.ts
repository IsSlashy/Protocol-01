/**
 * Indexing Module — Client-Side Blockchain Indexers
 *
 * Moves indexing client-side so users talk directly to Solana.
 * No relayer, no WebSocket server, no custom API.
 *
 * [2026-09-13] `StealthIndexer` left with the `specter` program whose
 * announcements it indexed (closed on devnet on 2026-09-13).
 */

// Commitment indexer (replaces relayer's /pool/state & /pool/commitments)
export {
  CommitmentIndexer,
  type CommitmentIndexerOptions,
  type IndexerStatus,
} from './commitment-indexer';

// Cache backends for offline persistence
export {
  type IndexerCache,
  MemoryCache,
  LocalStorageCache,
} from './cache';

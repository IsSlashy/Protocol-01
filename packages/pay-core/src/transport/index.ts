/**
 * Chain-agnostic announcement transport layer.
 *
 * `AnnouncementTransport` is the single per-chain seam for Specter's PQ
 * recipient-discovery. The Solana impl streams the ML-KEM ciphertext into a
 * program PDA (in specter-sdk); the Starknet impl here emits it as
 * `AnnouncementChunk` events from the `pq_announcer` Cairo contract.
 */

export type {
  AnnouncementTransport,
  Announcement,
  RawAnnouncement,
  TxRef,
} from './types';

export {
  StarknetTransport,
  PQ_ANNOUNCER_ABI,
  ANNOUNCEMENT_CHUNK_SELECTOR,
  bytesToFelts,
  feltsToBytes,
  type StarknetTransportConfig,
} from './starknetTransport';

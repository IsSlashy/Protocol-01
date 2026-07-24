/**
 * Chain-agnostic announcement transport.
 *
 * Specter's PQ recipient-discovery layer (X25519 + ML-KEM-768) is entirely
 * chain-agnostic — the ONLY per-chain piece is *where the ML-KEM ciphertext
 * gets published and how it is read back*. That coupling lives behind this
 * `AnnouncementTransport` interface so the same specter-sdk crypto drives every
 * chain:
 *
 *   - Solana  → a program that streams the ciphertext into a PDA (exists in
 *               specter-sdk `stealth/announcement-v2`, "in spirit" here).
 *   - Starknet→ the `pq_announcer` Cairo contract that emits the ciphertext as
 *               `AnnouncementChunk` events (see `./starknetTransport.ts` and
 *               `contracts/starknet/src/pq_announcer.cairo`).
 *
 * A transport does two things and nothing else: PUBLISH a chunked announcement,
 * and SCAN for announcements (optionally narrowed by a recipient view tag). It
 * carries NO token / note / amount semantics — that is STRK20's native Privacy
 * Pool on Starknet, and the transfer program on Solana. See
 * `contracts/starknet/ARCHITECTURE.md`.
 */

/** A published transport transaction. Chain-agnostic; `hash` is the tx id. */
export interface TxRef {
  /** Transaction hash / signature (chain-native id). */
  hash: string;
  /** Optional block explorer deep-link. */
  explorerUrl?: string;
}

/**
 * A recipient-discovery announcement to publish. Purely PQ discovery material —
 * never an identity, amount, or token. The `ciphertext` is the ML-KEM-768 KEM
 * ciphertext (1088 bytes for ML-KEM-768) that the recipient decapsulates to
 * recover the one-time shared secret; `ephemeralPubkey` is the sender's
 * ephemeral X25519 public key (32 bytes) for the classical half of the hybrid.
 */
export interface Announcement {
  /** Unique announcement id (a felt, hex `0x…`). Groups the chunks. */
  announcementId: string;
  /** Fast-reject view tag (one byte, as a felt hex `0x…` or small number). */
  viewTag: string | number;
  /** Tag powering optional PQ viewing-key disclosure (a felt, hex `0x…`). */
  viewingKeyTag: string | number;
  /** Sender ephemeral X25519 public key (raw bytes). */
  ephemeralPubkey: Uint8Array;
  /** ML-KEM-768 KEM ciphertext (raw bytes). */
  ciphertext: Uint8Array;
}

/**
 * A reassembled announcement read back from the chain. The transport has
 * already grouped and re-ordered every `AnnouncementChunk` sharing an
 * `announcementId` and rebuilt the original `ciphertext` / `ephemeralPubkey`
 * byte arrays. Higher layers (specter-sdk stealth scan) do the crypto.
 */
export interface RawAnnouncement {
  announcementId: string;
  /** View tag as a felt hex `0x…`. */
  viewTag: string;
  /** Viewing-key tag as a felt hex `0x…`. */
  viewingKeyTag: string;
  /** Sender ephemeral X25519 public key (raw bytes). */
  ephemeralPubkey: Uint8Array;
  /** Reassembled ML-KEM-768 KEM ciphertext (raw bytes). */
  ciphertext: Uint8Array;
  /** Number of chunks the announcement was split into. */
  totalChunks: number;
  /** Tx hash of the (first) chunk, if the source exposed it. */
  txHash?: string;
  /** Block number of the (first) chunk, if known. */
  blockNumber?: number;
}

/**
 * The one per-chain seam. Implementations wrap a concrete chain client
 * (starknet.js `RpcProvider`/`Contract`, or a Solana `Connection`/program) and
 * translate to/from `Announcement` / `RawAnnouncement`.
 */
export interface AnnouncementTransport {
  /**
   * Publish a chunked announcement on-chain. Splits `ciphertext` into felt
   * chunks and emits them (one `AnnouncementChunk` per chunk on Starknet).
   * Requires a signer configured on the transport.
   */
  publish(announcement: Announcement): Promise<TxRef>;

  /**
   * Scan for announcements. When `viewTag` is provided the transport narrows
   * the query by the indexed view-tag key (fast reject); when omitted it
   * returns every announcement so the caller can filter cryptographically.
   */
  scan(viewTag?: string | number): Promise<RawAnnouncement[]>;
}

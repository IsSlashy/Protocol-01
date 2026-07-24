/**
 * StarknetTransport — the Starknet implementation of `AnnouncementTransport`.
 *
 * Publishes / reads ML-KEM ciphertext chunks against the `pq_announcer` Cairo
 * contract (see `contracts/starknet/src/pq_announcer.cairo`). This is the ONLY
 * chain-specific piece of the PQ discovery layer; the crypto is unchanged
 * specter-sdk. The contract is NOT deployed yet (Phase 0) — this code targets
 * its ABI so the whole flow is wired and ready to flip live once the address
 * exists.
 *
 * publish: split the KEM ciphertext into felt252 words, group them into chunks,
 *          and `announce()` each chunk (one multicall) against
 *          `NEXT_PUBLIC_PQ_ANNOUNCER_ADDRESS`.
 * scan:    `provider.getEvents` filtered by the `AnnouncementChunk` selector
 *          (+ optional `view_tag` key), then reassemble the chunks per
 *          `announcement_id` back into ciphertext + ephemeral pubkey bytes.
 *
 * felt packing: a felt252 holds < 2^252, so we pack raw bytes in 31-byte
 * big-endian words (248 bits, always safe). The exact byte length is carried as
 * a length-prefix felt (word[0]) so reassembly recovers the original bytes
 * precisely — including a short trailing word.
 */

import {
  RpcProvider,
  Contract,
  CallData,
  hash,
  num,
  type Abi,
  type Call,
  type ProviderInterface,
  type AccountInterface,
} from 'starknet';
import type {
  Announcement,
  AnnouncementTransport,
  RawAnnouncement,
  TxRef,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// pq_announcer ABI — derived from the Cairo `IPqAnnouncer` interface + the
// `AnnouncementChunk` event. Kept inline as a const so the transport needs no
// build artifact / IDL fetch. Field ORDER matches the Cairo source exactly.
// ─────────────────────────────────────────────────────────────────────────────
export const PQ_ANNOUNCER_ABI = [
  {
    type: 'impl',
    name: 'PqAnnouncerImpl',
    interface_name: 'pq_announcer::IPqAnnouncer',
  },
  {
    type: 'interface',
    name: 'pq_announcer::IPqAnnouncer',
    items: [
      {
        type: 'function',
        name: 'announce',
        inputs: [
          { name: 'announcement_id', type: 'core::felt252' },
          { name: 'view_tag', type: 'core::felt252' },
          { name: 'viewing_key_tag', type: 'core::felt252' },
          { name: 'total_chunks', type: 'core::integer::u32' },
          { name: 'chunk_index', type: 'core::integer::u32' },
          { name: 'ephemeral_pubkey', type: 'core::array::Array::<core::felt252>' },
          { name: 'chunk', type: 'core::array::Array::<core::felt252>' },
        ],
        outputs: [],
        state_mutability: 'external',
      },
      {
        type: 'function',
        name: 'version',
        inputs: [],
        outputs: [{ type: 'core::felt252' }],
        state_mutability: 'view',
      },
      {
        type: 'function',
        name: 'announced_count',
        inputs: [],
        outputs: [{ type: 'core::integer::u64' }],
        state_mutability: 'view',
      },
    ],
  },
  {
    type: 'event',
    name: 'pq_announcer::PqAnnouncer::AnnouncementChunk',
    kind: 'struct',
    members: [
      { name: 'announcement_id', type: 'core::felt252', kind: 'key' },
      { name: 'view_tag', type: 'core::felt252', kind: 'key' },
      { name: 'viewing_key_tag', type: 'core::felt252', kind: 'data' },
      { name: 'chunk_index', type: 'core::integer::u32', kind: 'data' },
      { name: 'total_chunks', type: 'core::integer::u32', kind: 'data' },
      { name: 'ephemeral_pubkey', type: 'core::array::Array::<core::felt252>', kind: 'data' },
      { name: 'chunk', type: 'core::array::Array::<core::felt252>', kind: 'data' },
    ],
  },
  {
    type: 'event',
    name: 'pq_announcer::PqAnnouncer::Event',
    kind: 'enum',
    variants: [
      {
        name: 'AnnouncementChunk',
        type: 'pq_announcer::PqAnnouncer::AnnouncementChunk',
        kind: 'nested',
      },
    ],
  },
] as const satisfies Abi;

/** starknet_keccak selector of the `AnnouncementChunk` event name (event key[0]). */
export const ANNOUNCEMENT_CHUNK_SELECTOR = hash.getSelectorFromName('AnnouncementChunk');

/** Bytes packed per felt252 word (248 bits — always < the felt prime). */
const BYTES_PER_FELT = 31;

/** Default felt words per `announce()` chunk. ML-KEM-768 ct (1088 B) ≈ 36 words
 * so it usually fits in a single chunk; the multi-chunk path stays exercised
 * for larger payloads / conservative calldata budgets. */
const DEFAULT_FELTS_PER_CHUNK = 256;

export interface StarknetTransportConfig {
  /** JSON-RPC node url (e.g. a Sepolia endpoint). */
  nodeUrl: string;
  /** Deployed `pq_announcer` address — `NEXT_PUBLIC_PQ_ANNOUNCER_ADDRESS`.
   * The contract is not deployed in Phase 0; publish/scan throw a clear error
   * until this is set to a real address. */
  announcerAddress: string;
  /** Signer for `publish`. Read-only `scan` does not need it. */
  account?: AccountInterface;
  /** Pre-built provider (else an `RpcProvider` is created from `nodeUrl`). */
  provider?: ProviderInterface;
  /** Block to start scanning from (default 0). */
  fromBlock?: number;
  /** Override felt words per emitted chunk. */
  feltsPerChunk?: number;
  /** Page size for `getEvents` pagination (default 100). */
  pageSize?: number;
  /** Explorer base for `TxRef.explorerUrl` (e.g. https://sepolia.starkscan.co). */
  explorerBase?: string;
}

const NOT_DEPLOYED =
  'pq_announcer contract is not deployed yet — set NEXT_PUBLIC_PQ_ANNOUNCER_ADDRESS ' +
  'to a deployed address. See contracts/starknet/ARCHITECTURE.md (Phase 0).';

// ─── felt <-> bytes packing ──────────────────────────────────────────────────

/** Pack raw bytes into felt words: [byteLength, ...31-byte big-endian words]. */
export function bytesToFelts(bytes: Uint8Array): bigint[] {
  const felts: bigint[] = [BigInt(bytes.length)];
  for (let i = 0; i < bytes.length; i += BYTES_PER_FELT) {
    let word = 0n;
    const end = Math.min(i + BYTES_PER_FELT, bytes.length);
    for (let j = i; j < end; j++) {
      word = (word << 8n) | BigInt(bytes[j]!);
    }
    felts.push(word);
  }
  return felts;
}

/** Inverse of {@link bytesToFelts}: read the length prefix, unpack the words. */
export function feltsToBytes(felts: bigint[]): Uint8Array {
  if (felts.length === 0) return new Uint8Array(0);
  const byteLen = Number(felts[0]!);
  const out = new Uint8Array(byteLen);
  let written = 0;
  for (let w = 1; w < felts.length && written < byteLen; w++) {
    const remaining = byteLen - written;
    const width = Math.min(BYTES_PER_FELT, remaining);
    let word = felts[w]!;
    // Big-endian: the low-order `width` bytes are this word's payload.
    for (let b = width - 1; b >= 0; b--) {
      out[written + b] = Number(word & 0xffn);
      word >>= 8n;
    }
    written += width;
  }
  return out;
}

const toFeltHex = (v: bigint): string => num.toHex(v);
const feltStr = (v: string | number | bigint): string => num.toHex(v);

// ─────────────────────────────────────────────────────────────────────────────

export class StarknetTransport implements AnnouncementTransport {
  private readonly provider: ProviderInterface;
  private readonly contract: Contract;
  private readonly cfg: Required<
    Pick<StarknetTransportConfig, 'fromBlock' | 'feltsPerChunk' | 'pageSize'>
  > &
    StarknetTransportConfig;

  constructor(config: StarknetTransportConfig) {
    if (!config.announcerAddress) throw new Error(NOT_DEPLOYED);
    // Defaults AFTER the spread — an undefined field in `config` must not
    // clobber them (spread order bug: from_block {block_number: undefined}
    // serializes to an invalid BLOCK_ID and kills getEvents).
    this.cfg = {
      ...config,
      fromBlock: config.fromBlock ?? 0,
      feltsPerChunk: config.feltsPerChunk ?? DEFAULT_FELTS_PER_CHUNK,
      pageSize: config.pageSize ?? 100,
    };
    this.provider = config.provider ?? new RpcProvider({ nodeUrl: config.nodeUrl });
    this.contract = new Contract({
      abi: PQ_ANNOUNCER_ABI as unknown as Abi,
      address: config.announcerAddress,
      providerOrAccount: config.account ?? this.provider,
    });
  }

  /** Build the `announce()` calls for one announcement (one per chunk). */
  buildAnnounceCalls(announcement: Announcement): Call[] {
    const { announcementId, viewTag, viewingKeyTag, ephemeralPubkey, ciphertext } =
      announcement;

    const ephFelts = bytesToFelts(ephemeralPubkey).map(toFeltHex);
    const ctFelts = bytesToFelts(ciphertext).map(toFeltHex);

    // Split the ciphertext felts into per-tx chunks.
    const chunks: string[][] = [];
    for (let i = 0; i < ctFelts.length; i += this.cfg.feltsPerChunk) {
      chunks.push(ctFelts.slice(i, i + this.cfg.feltsPerChunk));
    }
    if (chunks.length === 0) chunks.push([]); // always emit at least one chunk
    const totalChunks = chunks.length;

    const calldata = new CallData(PQ_ANNOUNCER_ABI as unknown as Abi);
    return chunks.map((chunk, index) => ({
      contractAddress: this.contract.address,
      entrypoint: 'announce',
      calldata: calldata.compile('announce', {
        announcement_id: feltStr(announcementId),
        view_tag: feltStr(viewTag),
        viewing_key_tag: feltStr(viewingKeyTag),
        total_chunks: totalChunks,
        chunk_index: index,
        ephemeral_pubkey: ephFelts,
        chunk,
      }),
    }));
  }

  async publish(announcement: Announcement): Promise<TxRef> {
    if (!this.cfg.account) {
      throw new Error('StarknetTransport.publish requires a signer (config.account).');
    }
    const calls = this.buildAnnounceCalls(announcement);
    // One atomic multicall — every chunk lands in a single tx.
    const { transaction_hash } = await this.cfg.account.execute(calls);
    return {
      hash: transaction_hash,
      explorerUrl: this.cfg.explorerBase
        ? `${this.cfg.explorerBase.replace(/\/$/, '')}/tx/${transaction_hash}`
        : undefined,
    };
  }

  async scan(viewTag?: string | number): Promise<RawAnnouncement[]> {
    // key filter: [ [selector], [any announcement_id], [view_tag?] ]
    const keys: string[][] = [[ANNOUNCEMENT_CHUNK_SELECTOR]];
    if (viewTag !== undefined) keys.push([], [feltStr(viewTag)]);

    const raw: DecodedChunk[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await (this.provider as RpcProvider).getEvents({
        address: this.contract.address,
        from_block: { block_number: this.cfg.fromBlock },
        to_block: 'latest',
        keys,
        chunk_size: this.cfg.pageSize,
        continuation_token: continuationToken,
      });
      for (const ev of page.events) {
        const decoded = decodeChunkEvent(ev);
        if (decoded) raw.push(decoded);
      }
      continuationToken = page.continuation_token;
    } while (continuationToken);

    return reassemble(raw);
  }
}

// ─── event decode + reassembly ───────────────────────────────────────────────

interface DecodedChunk {
  announcementId: string;
  viewTag: string;
  viewingKeyTag: string;
  chunkIndex: number;
  totalChunks: number;
  ephemeralFelts: bigint[];
  chunkFelts: bigint[];
  txHash?: string;
  blockNumber?: number;
}

interface EmittedEventLike {
  keys: string[];
  data: string[];
  transaction_hash?: string;
  block_number?: number;
}

/**
 * Decode a raw `AnnouncementChunk` emitted event by hand (no IDL parse), per the
 * known Cairo layout:
 *   keys = [selector, announcement_id, view_tag]
 *   data = [viewing_key_tag, chunk_index, total_chunks,
 *           eph_len, ...eph, chunk_len, ...chunk]
 */
function decodeChunkEvent(ev: EmittedEventLike): DecodedChunk | null {
  const { keys, data } = ev;
  if (!keys || keys.length < 3 || !data || data.length < 3) return null;
  if (BigInt(keys[0]!) !== BigInt(ANNOUNCEMENT_CHUNK_SELECTOR)) return null;

  const announcementId = num.toHex(keys[1]!);
  const viewTag = num.toHex(keys[2]!);

  let i = 0;
  const viewingKeyTag = num.toHex(data[i++]!);
  const chunkIndex = Number(BigInt(data[i++]!));
  const totalChunks = Number(BigInt(data[i++]!));

  const ephLen = Number(BigInt(data[i++]!));
  const ephemeralFelts: bigint[] = [];
  for (let k = 0; k < ephLen; k++) ephemeralFelts.push(BigInt(data[i++]!));

  const chunkLen = Number(BigInt(data[i++]!));
  const chunkFelts: bigint[] = [];
  for (let k = 0; k < chunkLen; k++) chunkFelts.push(BigInt(data[i++]!));

  return {
    announcementId,
    viewTag,
    viewingKeyTag,
    chunkIndex,
    totalChunks,
    ephemeralFelts,
    chunkFelts,
    txHash: ev.transaction_hash,
    blockNumber: ev.block_number,
  };
}

/** Group chunks by announcement_id, order by chunk_index, rebuild the bytes. */
function reassemble(chunks: DecodedChunk[]): RawAnnouncement[] {
  const byId = new Map<string, DecodedChunk[]>();
  for (const c of chunks) {
    const key = c.announcementId;
    const list = byId.get(key);
    if (list) list.push(c);
    else byId.set(key, [c]);
  }

  const out: RawAnnouncement[] = [];
  for (const [announcementId, list] of byId) {
    list.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const totalChunks = list[0]!.totalChunks;
    // Only reassemble complete announcements (all chunks present).
    if (list.length < totalChunks) continue;

    // The ciphertext felt array is the concatenation of every chunk's felts,
    // in chunk_index order (the length prefix lives at word[0] of chunk 0).
    const ctFelts: bigint[] = [];
    for (const c of list) ctFelts.push(...c.chunkFelts);

    out.push({
      announcementId,
      viewTag: list[0]!.viewTag,
      viewingKeyTag: list[0]!.viewingKeyTag,
      ephemeralPubkey: feltsToBytes(list[0]!.ephemeralFelts),
      ciphertext: feltsToBytes(ctFelts),
      totalChunks,
      txHash: list[0]!.txHash,
      blockNumber: list[0]!.blockNumber,
    });
  }
  return out;
}

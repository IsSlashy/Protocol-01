/**
 * noteTransfer — main-thread driver for handing a shielded note to someone else.
 *
 * This is the thinnest file in the pool stack, and that is the design. Every
 * other pool operation needs this layer to do real work, because the user's
 * wallet lives on the main thread and has to sign a pre-fund. A note handoff
 * has nothing to sign: it builds no transaction, asks for no approval, and
 * touches no chain except the read the worker performs to find the note. So
 * this file is a single typed call across the worker boundary and nothing else.
 *
 * WHY THE ASSEMBLY IS NOT HERE
 * ────────────────────────────
 * The thing being handed over is the note's SECRETS. `PoolNoteView` — the only
 * note shape the main thread is ever given (`worker/poolHandlers.ts`) — carries
 * pool, denomination, counter, leaf index, commitment and spent-ness, and no
 * secret at all. So the page cannot build the payload even if it wanted to; the
 * worker encodes and seals it, and only ciphertext comes back. If a future
 * change makes it convenient to "just return the note and encrypt here", that
 * is the boundary being deleted, not a refactor.
 *
 * WHAT THIS BUYS, EXACTLY
 * ───────────────────────
 * No transaction exists, so there is no send for an observer to pair with a
 * receive — no timing, no amount, no counterparty. That much is unconditional.
 * It is NOT anonymity for the note itself: when the recipient eventually
 * withdraws, that withdrawal republishes the same commitment the sender's
 * deposit published, which is publicly matchable (measured on devnet: leaf 16,
 * commitment 8901821612542787864, in both the deposit and the withdrawal). The
 * handoff is unobservable; the note's exit from the pool is not. Only the C7
 * spend circuit changes that — `docs/C7_SPEND_CIRCUIT_PLAN.md`.
 */

import { poolRequest } from './workerClient';
import { isNoteEncryptionAddress } from './pool/noteCrypto';
import type { PoolToken } from './pool/denominatedPool';

export interface SealNoteParams {
  /** Session key from `deriveMeta`. */
  meta: string;
  token: PoolToken;
  denomination: number;
  /** Which note to hand over, by the leaf index it occupies. */
  leafIndex: number;
  /** The recipient's published `p01pq:` note address. */
  recipientAddress: string;
  /** Blobs stored at shield time; the matching one supplies the Merkle path so
   *  the recipient does not need this pool's RPC history to withdraw. */
  encryptedNotes?: string[];
  onProgress?: (step: string) => void;
}

export interface SealedNoteHandoff {
  /** `p01enc1:…` — hybrid X25519 + ML-KEM-768, opened only by the recipient. */
  sealedNote: string;
  denomination: number;
  leafIndex: number;
  /** Public: the deposit put this on chain. Shown so the sender can tell two
   *  handoffs apart. */
  commitment: string;
  /** Whether a Merkle path travels with the note, and where it came from. */
  merklePath: 'stored' | 'rebuilt' | 'none';
}

/**
 * True when `input` parses as a `p01pq:` note address.
 *
 * Re-exported through this module rather than imported from `pool/noteCrypto`
 * directly by the UI, so the page's contract is "call noteTransfer" and the
 * crypto module keeps exactly one main-thread consumer. It is the SAME function
 * the worker re-checks with before doing any work, so a form that accepts an
 * address can never hand the worker one it will reject.
 */
export function isP01NoteAddress(input: string): boolean {
  return isNoteEncryptionAddress(input.trim());
}

/**
 * Seal one owned note to a recipient's note address.
 *
 * Sends nothing. On success the caller holds a string that is worthless to
 * anyone but the recipient — and, once the recipient opens it, spendable by
 * whoever holds the contents.
 *
 * The note is NOT consumed and NOT reserved. Its secrets come from the sender's
 * own pool seed, so the sender can still withdraw it afterwards; whoever spends
 * first wins and the other side's copy becomes worthless. Callers must say so.
 */
export async function sealNoteFor(params: SealNoteParams): Promise<SealedNoteHandoff> {
  const recipientAddress = params.recipientAddress.trim();
  if (!isP01NoteAddress(recipientAddress)) {
    throw new Error(
      'That is not a Protocol 01 note address. It starts with "p01pq:" — ask the recipient ' +
        'for theirs. Nothing was read or sent.',
    );
  }

  const res = await poolRequest(
    {
      kind: 'poolExportNote',
      meta: params.meta,
      token: params.token,
      denomination: params.denomination,
      leafIndex: params.leafIndex,
      recipientAddress,
      encryptedNotes: params.encryptedNotes,
    },
    params.onProgress,
  );

  return {
    sealedNote: res.sealedNote,
    denomination: res.denomination,
    leafIndex: res.leafIndex,
    commitment: res.commitment,
    merklePath: res.merklePath,
  };
}

/**
 * shieldClient — main-thread driver for a denominated-pool shield.
 *
 * The worker does everything secret; this file exists only because the user's
 * wallet lives on the main thread and must sign the ONE transaction that funds
 * the ephemeral depositor. Order matters:
 *
 *   prepare (worker, proves C6)  →  fund the ephemeral (wallet, 1 signature)
 *   →  execute (worker, ~150 chunk uploads + shield + sweep)
 *
 * If `prepare` throws, nothing has moved. If the pre-fund lands but `execute`
 * never completes, the ephemeral is derived from the wallet seed and is
 * therefore re-derivable on any device — the funds are recoverable, not lost.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import { poolRequest } from './workerClient';

/** Sign one transaction with the connected wallet. */
export type SignOne = (tx: Transaction) => Promise<Transaction>;

export interface ShieldParams {
  /** Session key from `deriveMeta`. */
  meta: string;
  token: 'SOL';
  denomination: number;
  owner: PublicKey;
  connection: Connection;
  signOne: SignOne;
  onProgress?: (step: string) => void;
}

export interface ShieldOutcome {
  txSig: string;
  commitment: string;
  leafIndex: number;
  denomination: number;
  /** Already encrypted to the user's own PQ address — safe to persist as-is. */
  encryptedNote: string;
  /** Lamports the wallet moved onto the ephemeral (most of it comes back). */
  fundedLamports: number;
}

export async function shieldToPool(params: ShieldParams): Promise<ShieldOutcome> {
  const { meta, token, denomination, owner, connection, signOne, onProgress } = params;

  const prep = await poolRequest(
    { kind: 'poolShieldPrepare', meta, token, denomination },
    onProgress,
  );

  onProgress?.('Approve the funding transaction in your wallet...');
  const ephemeral = new PublicKey(prep.ephemeralPubkey);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ephemeral,
      lamports: prep.requiredLamports,
    }),
  );
  fundTx.recentBlockhash = blockhash;
  fundTx.feePayer = owner;

  const signed = await signOne(fundTx);
  const fundSig = await connection.sendRawTransaction(signed.serialize());
  const conf = await connection.confirmTransaction(
    { signature: fundSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  const done = await poolRequest(
    { kind: 'poolShieldExecute', jobId: prep.jobId, ownerPubkey: owner.toBase58() },
    onProgress,
  );

  return {
    txSig: done.txSig,
    commitment: done.commitment,
    leafIndex: done.leafIndex,
    denomination: done.denomination,
    encryptedNote: done.encryptedNote,
    fundedLamports: prep.requiredLamports,
  };
}

export interface UnshieldParams {
  meta: string;
  token: 'SOL';
  denomination: number;
  /** Which note to spend, by the leaf index it occupies. */
  leafIndex: number;
  /** Address that receives the funds. */
  recipient: PublicKey;
  /** Wallet paying the proof float; receives the swept residual. */
  owner: PublicKey;
  /** Note blobs stored at shield time. The worker picks the one matching this
   *  note and uses its Merkle path, skipping the history rebuild. */
  encryptedNotes?: string[];
  connection: Connection;
  signOne: SignOne;
  onProgress?: (step: string) => void;
}

/**
 * Withdraw one note. Same two-phase shape as a shield: the worker proves and
 * prices, the wallet signs a single pre-fund, the worker uploads both proofs
 * and withdraws.
 */
export async function unshieldFromPool(
  params: UnshieldParams,
): Promise<{ txSig: string; denomination: number }> {
  const { meta, token, denomination, leafIndex, recipient, owner, connection, signOne, onProgress } =
    params;

  const prep = await poolRequest(
    {
      kind: 'poolUnshieldPrepare',
      meta,
      token,
      denomination,
      leafIndex,
      encryptedNotes: params.encryptedNotes,
    },
    onProgress,
  );

  onProgress?.('Approve the funding transaction in your wallet...');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: new PublicKey(prep.ephemeralPubkey),
      lamports: prep.requiredLamports,
    }),
  );
  fundTx.recentBlockhash = blockhash;
  fundTx.feePayer = owner;

  const signed = await signOne(fundTx);
  const fundSig = await connection.sendRawTransaction(signed.serialize());
  const conf = await connection.confirmTransaction(
    { signature: fundSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  const done = await poolRequest(
    {
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: recipient.toBase58(),
      ownerPubkey: owner.toBase58(),
    },
    onProgress,
  );

  return { txSig: done.txSig, denomination: done.denomination };
}

/**
 * Reclaim SOL left on ephemerals by earlier failed runs. Proof-buffer rent can
 * only be released by the ephemeral that created it, so this is the only way
 * that money comes back.
 */
export function recoverStuckFunds(
  meta: string,
  denomination: number,
  owner: PublicKey,
  onProgress?: (step: string) => void,
) {
  return poolRequest(
    { kind: 'poolRecover', meta, token: 'SOL', denomination, ownerPubkey: owner.toBase58() },
    onProgress,
  );
}

/** Read the shielded balance + note list for this identity. */
export function scanPool(
  meta: string,
  token: 'SOL',
  onProgress?: (step: string) => void,
) {
  return poolRequest({ kind: 'poolScan', meta, token }, onProgress);
}

// ---------------------------------------------------------------------------
// Note persistence (opaque blobs only)
// ---------------------------------------------------------------------------

const NOTE_STORE_KEY = 'p01_pay_notes_v1';

/**
 * Persist an encrypted note blob. The main thread cannot read these — only the
 * worker, holding the pool seed, can decrypt them.
 *
 * NOTE ON WHAT THIS IS AND IS NOT: nothing currently reads these blobs back.
 * `loadEncryptedNotes` is used only to show a count, and `decryptNote` has no
 * caller. Discovery and withdrawal both work from the pool seed plus on-chain
 * event history (`pool/poolNotes.ts`), so the blob is a forward-looking record,
 * not a recovery path — and it could not be one anyway while withdrawal needs
 * event history to rebuild the Merkle proof. Do not describe it as a fallback.
 */
export function storeEncryptedNote(walletPubkey: string, blob: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = readNoteStore();
    const list = all[walletPubkey] ?? [];
    if (!list.includes(blob)) list.push(blob);
    all[walletPubkey] = list;
    localStorage.setItem(NOTE_STORE_KEY, JSON.stringify(all));
  } catch {
    // Quota or private-mode failure — recovery-by-scan still covers the user.
  }
}

export function loadEncryptedNotes(walletPubkey: string): string[] {
  return readNoteStore()[walletPubkey] ?? [];
}

function readNoteStore(): Record<string, string[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(NOTE_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

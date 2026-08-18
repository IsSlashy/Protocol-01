import type { PoolToken } from './pool/denominatedPool';
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
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { poolRequest } from './workerClient';
import {
  fetchFunderLookup,
  funderTicket,
  fundEphemeralForJob,
  loadFunderAddress,
} from './pool/ephemeralFunder';
import { loadSubscriptions } from '../pay/subscriptions';
import {
  isSessionLostError,
  openSealedRecords,
  readMap,
  sealRecord,
  storeSession,
  writeMap,
  type StoreSession,
} from './sealedStore';
import type { PoolNoteView, PoolScanResponse } from './worker/poolHandlers';

/** Sign one transaction with the connected wallet. */
export type SignOne = (tx: Transaction) => Promise<Transaction>;

export interface ShieldParams {
  /** Session key from `deriveMeta`. */
  meta: string;
  token: PoolToken;
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

  // ── Who pays ───────────────────────────────────────────────────────────────
  // The wallet. Always, on this leg, and the refusal is STRUCTURAL rather than
  // an omission: `valueLamports` is non-zero for every deposit — the
  // denomination plus the 0.3% fee, 1,003,475,300 of a 1 SOL deposit's
  // 1,573,486,080 — so `fundEphemeralForJob` will not ask the funder and says
  // why. Routed through the shared decision anyway, deliberately: it is how the
  // deposit leg gets the same dirty-ephemeral guard as the others, and it means
  // a future contributor wiring this to the treasury "for consistency" gets a
  // typed refusal instead of a mint-your-own-note faucet.
  // ── The deposit is paid THROUGH the deployment ───────────────────────────
  //
  // The comment above is still true about who provides the value: it is the
  // user's, and the funder will not cover it. What changed on 2026-08-18 is
  // where the wallet sends it.
  //
  // Paying the ephemeral directly put the wallet one hop from the deposit, and
  // the deposit is one hop from every subscription that spends the note —
  // `subscribe_private_stark` republishes its commitment in cleartext.
  // MEASURED the same day: P9 found four edges from the deposit payer naming
  // the wallet, and P11 found the wallet by listing account keys alone.
  //
  // So the wallet pays the deployment and the deployment funds the ephemeral.
  // The wallet still signs — it is still their money — but what it signs points
  // at the deployment instead of at the pool.
  //
  // Falls back to the direct path when the deployment cannot relay, because a
  // deposit that cannot happen is worse than a deposit that is linkable, and
  // the screen says which one occurred.
  await loadFunderAddress();
  const funding = await fundEphemeralForJob({
    ephemeralPubkey: prep.ephemeralPubkey,
    requiredLamports: prep.requiredLamports,
    valueLamports: prep.valueLamports,
    owner,
    connection,
    signOne,
    onProgress,
    relayThroughDeployment: true,
  });

  const done = await poolRequest(
    {
      kind: 'poolShieldExecute',
      jobId: prep.jobId,
      ownerPubkey: owner.toBase58(),
      // ⚠️ The residual follows whoever funded the ephemeral. When the
      // deployment relayed, that residual is its refundable rent and sending it
      // to the wallet would both take money that is not the wallet's and
      // rebuild the edge the relay removed.
      sweepTo: funding.sweepTo,
    },
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
  token: PoolToken;
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
  /**
   * Refuse rather than let the wallet pay. Same contract as `SubscribeParams`.
   *
   * 🚨 THIS LEG WAS LEFT OUT WHEN THE GUARD WAS ADDED, AND THAT MADE THE
   * PROTECTION ONE OPERATION WIDE. A buyer who subscribes cleanly and later
   * withdraws got a withdrawal that fell back to the wallet silently — and a
   * withdrawal publishes the note's `stark_commitment` at byte 80 AND a
   * recipient at byte 88 in the same transaction, so it hands an auditor the
   * note, the payee and the payer at once. Hardening only the leg that was
   * being demonstrated is how a demo passes and a user does not.
   */
  neverExposeWallet?: boolean;
}

/**
 * Withdraw one note. Same two-phase shape as a shield: the worker proves and
 * prices, the wallet signs a single pre-fund, the worker uploads both proofs
 * and withdraws.
 */
export interface UnshieldOutcome {
  txSig: string;
  denomination: number;
  /**
   * Who paid for the job, and therefore whether the user's wallet is on chain
   * for this withdrawal. A RESULT, never a request parameter — the caller asks
   * for a funder, it may not be there, and the user is entitled to know which
   * of the two worlds they ended up in.
   */
  fundedBy: 'wallet' | 'funder';
  /** Why the funder was not used, when one was configured but did not serve.
   *  🚨 Render it. A 429, a 409 and an operator switching the funder off are
   *  otherwise indistinguishable, and all three put the wallet back on chain. */
  funderFallbackReason?: string;
}

export async function unshieldFromPool(params: UnshieldParams): Promise<UnshieldOutcome> {
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

  // ── Who pays ───────────────────────────────────────────────────────────────
  // `valueLamports: 0` and that is a measured fact, not an assumption: a
  // withdrawal's pre-fund is `r1 + r3 + NULLIFIER_RENT + E_TX_FEE_BUDGET`
  // (`unshieldEphemeral.ts`), with no denomination term — the note's value comes
  // out of the POOL. That is what makes this leg fundable at all, and it is
  // exactly what the deposit leg is not.
  const funding = await fundEphemeralForJob({
    ephemeralPubkey: prep.ephemeralPubkey,
    requiredLamports: prep.requiredLamports,
    valueLamports: 0,
    owner,
    connection,
    signOne,
    onProgress,
    neverExposeWallet: params.neverExposeWallet,
  });

  const done = await poolRequest(
    {
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: recipient.toBase58(),
      // Identity, not money. The worker refuses `recipient === ownerPubkey`.
      ownerPubkey: owner.toBase58(),
      sweepTo: funding.sweepTo,
    },
    onProgress,
  );

  return {
    txSig: done.txSig,
    denomination: done.denomination,
    fundedBy: funding.fundedBy,
    funderFallbackReason: funding.funderFallbackReason,
  };
}

export interface SubscribeParams {
  meta: string;
  token: PoolToken;
  denomination: number;
  /** Which note pays for the subscription, by the leaf index it occupies. */
  leafIndex: number;
  /** Merchant who can claim each period. */
  retailer: PublicKey;
  /** Per-period amount, in the pool token's smallest unit. */
  rate: bigint;
  /** Slots between claimable periods. Must be > 0; the program rejects 0. */
  intervalSlots: bigint;
  /** Registry `serviceId`. Omitted, the key is scoped to the retailer address. */
  serviceId?: string | null;
  /** Wallet paying the proof float; receives the swept residual. */
  owner: PublicKey;
  /** Note blobs stored at shield time; the worker uses the matching Merkle path. */
  encryptedNotes?: string[];
  connection: Connection;
  signOne: SignOne;
  onProgress?: (step: string) => void;
  /**
   * Refuse rather than let the wallet pay. See `fundEphemeralForJob`.
   *
   * This is the only switch in this file that can turn a working subscription
   * into a refusal, and it exists because the alternative is worse: a user told
   * their wallet stays off chain, whose funder was unavailable, ends up with a
   * subscription they cannot tell apart from the private one and a public
   * transfer they cannot undo.
   */
  neverExposeWallet?: boolean;
}

/**
 * Thrown when the note being spent was deposited by the wallet doing the
 * spending, and the caller asked to stay off chain.
 *
 * Named separately from `WalletExposureRefusedError` because the cure is
 * completely different and saying the wrong one wastes the user's time: this is
 * not "the funder is down, retry later", it is "this note cannot give you what
 * you asked for, no matter who pays — use a note somebody else deposited".
 */
export class SelfDepositedNoteError extends Error {
  constructor(
    readonly depositPayer: string | null,
    readonly depositSignature: string | null,
  ) {
    super(
      depositPayer === null
        ? 'Stopped before spending anything: this note\'s deposit could not be found in the ' +
            'scanned history, so there is no way to tell whether your own wallet made it. ' +
            'Spending republishes the deposit\'s identifier in the clear, so an unknown deposit ' +
            'is an unknown exposure — it is not the same as a safe one.'
        : 'Stopped before spending anything: this note was deposited by your own wallet ' +
            `(${depositPayer}${depositSignature ? `, ${depositSignature.slice(0, 12)}…` : ''}). ` +
            'Spending it republishes that deposit\'s identifier in the clear, so anyone reading ' +
            'the subscription reaches your wallet in one hop through the deposit — whoever pays ' +
            'for the subscription itself. Use a note deposited by someone else.',
    );
    this.name = 'SelfDepositedNoteError';
  }
}

export interface SubscribeOutcome {
  txSig: string;
  /** Base58 subscription vault PDA. */
  vaultPDA: string;
  /** The "P01-…" key to show the user. Reproducible from the note, so losing it
   *  is recoverable — but nothing else stores it, so show it. */
  licenseKey: string;
  /** The string the key is scoped to; a merchant needs it to verify. */
  serviceTag: string;
  denomination: number;
  fundedLamports: number;
  /**
   * Who paid for the job, and therefore whether the user's wallet is on chain.
   *
   * This is the honest half of the privacy claim, so it is a RESULT and not a
   * request parameter: the caller asks for a funder, it may not be there, and
   * the user is entitled to know which of the two worlds they ended up in
   * before they are told anything about unlinkability. `'wallet'` means their
   * address signed a transfer to the ephemeral and received the sweep — probe
   * P6 reads exactly those two transactions.
   */
  fundedBy: 'wallet' | 'funder';
  /** Set when `fundedBy === 'funder'`; the funding transaction, for the user to check. */
  funderSignature?: string;
  /** Why the funder was not used, when one was configured but did not serve. */
  funderFallbackReason?: string;
  /**
   * Who paid for the DEPOSIT of the note this subscription spent.
   *
   * Reported even when the run succeeded, because it is half the answer to
   * "is my wallet reachable from this" and no other surface shows it. `null`
   * means the deposit was not found in the scanned window — unknown, which the
   * result screen must not render as clean.
   */
  depositPayer: string | null;
  /** True when `depositPayer` is this wallet, or is unknown. The subscription
   *  is then reachable from the buyer in one hop THROUGH THE DEPOSIT, whoever
   *  paid for the subscription itself. */
  reachableViaDeposit: boolean;
}

/**
 * Open a subscription vault from one shielded note. Same two-phase shape as a
 * withdrawal, and for the same reason: the worker proves C1 + C3 and prices the
 * job, the wallet signs a single pre-fund, the worker uploads ~150 proof chunks
 * and sends the subscribe.
 *
 * The pre-fund is larger than a withdrawal's by the subscription vault's rent
 * (361 bytes), and that part does NOT come back — the vault stays open until the
 * merchant's final `claim_period` closes it.
 *
 * No secret crosses this boundary in either direction. The license key comes
 * back derived; the note secret it came from does not.
 */
export async function subscribeFromPool(params: SubscribeParams): Promise<SubscribeOutcome> {
  const {
    meta, token, denomination, leafIndex, retailer, rate, intervalSlots,
    owner, connection, signOne, onProgress,
  } = params;

  const prep = await poolRequest(
    {
      kind: 'poolSubscribePrepare',
      meta,
      token,
      denomination,
      leafIndex,
      encryptedNotes: params.encryptedNotes,
    },
    onProgress,
  );

  // ── Who DEPOSITED, which decides whether paying matters ───────────────────
  //
  // 🚨 THE CONFIGURATION IN WHICH EVERYTHING ELSE HERE BUYS NOTHING.
  //
  // Spending republishes the deposit's commitment in cleartext — the program
  // forces it, and no client change can alter that before the verifier is
  // redeployed. So a stranger walks: subscription → commitment at byte 160 →
  // the deposit that emitted it → that deposit's fee payer. One hop, no
  // cryptography.
  //
  // If that fee payer is the wallet now subscribing, the funder is irrelevant.
  // The spend can be paid by a treasury, swept to a treasury, and signed by an
  // ephemeral, and the buyer is STILL one hop away through their own deposit.
  // It is the single way to do all of this correctly and remain findable, and
  // nothing on the subscribe screen shows it — the note looks the same either
  // way.
  //
  // So it is checked here, in code, rather than asked for in a runbook. Under
  // `neverExposeWallet` it REFUSES; otherwise it is reported so the result
  // screen can say which world the user ended up in.
  //
  // ⚠️ `null` means the leaf was not found in the scanned window, NOT that the
  // deposit is safe. An unknown answer is refused under the flag for the same
  // reason an unreadable funder lookup is: this file does not convert "could
  // not see" into "there is nothing there".
  // 🚨 COMPARED AGAINST `depositFunder`, NOT `depositPayer`. The first version
  // of this used the payer and could therefore never fire: a deposit is signed
  // by a fresh ephemeral, so its payer is a key nobody has heard of and never
  // equals the wallet. MEASURED on a real devnet shield — wallet `BRop…TjNN`,
  // deposit payer `8Eq1jsbB…`. The guard would have passed, the screen would
  // have said "your wallet did not sign or pay for this subscription", and that
  // true sentence would have been read as "nobody can reach me" while the walk
  // deposit → ephemeral → funder → wallet was one call away.
  //
  // Either being unknown is refused. An unresolvable deposit is not a safe one:
  // it is far more often a pruned history than an origin that does not exist.
  const selfDeposited =
    prep.depositPayer === null ||
    prep.depositFunder === null ||
    prep.depositPayer === owner.toBase58() ||
    prep.depositFunder === owner.toBase58();
  if (params.neverExposeWallet && selfDeposited) {
    throw new SelfDepositedNoteError(
      prep.depositFunder ?? prep.depositPayer,
      prep.depositSignature,
    );
  }

  // ── Who pays ───────────────────────────────────────────────────────────────
  // One decision, made in `fundEphemeralForJob` and shared with the withdrawal
  // leg. It used to live inline here and nowhere else, which is exactly why the
  // other two legs never got it.
  //
  // `valueLamports: 0` because a subscribe's pre-fund is float only — two proof
  // buffers' rent, the nullifier record's, the vault's, and a fee budget. The
  // note's value comes from the POOL, not from the payer.
  const funding = await fundEphemeralForJob({
    ephemeralPubkey: prep.ephemeralPubkey,
    requiredLamports: prep.requiredLamports,
    valueLamports: 0,
    owner,
    connection,
    signOne,
    onProgress,
    neverExposeWallet: params.neverExposeWallet,
  });
  const { fundedBy, funderSignature, funderFallbackReason, sweepTo } = funding;

  const done = await poolRequest(
    {
      kind: 'poolSubscribeExecute',
      jobId: prep.jobId,
      ownerPubkey: owner.toBase58(),
      sweepTo,
      retailer: retailer.toBase58(),
      // u64 decimal strings — the worker boundary carries JSON-safe primitives.
      rate: rate.toString(),
      intervalSlots: intervalSlots.toString(),
      serviceId: params.serviceId ?? null,
    },
    onProgress,
  );

  return {
    txSig: done.txSig,
    vaultPDA: done.vaultPDA,
    licenseKey: done.licenseKey,
    serviceTag: done.serviceTag,
    denomination: done.denomination,
    fundedLamports: prep.requiredLamports,
    fundedBy,
    funderSignature,
    funderFallbackReason,
    depositPayer: prep.depositFunder ?? prep.depositPayer,
    reachableViaDeposit: selfDeposited,
  };
}

/**
 * Reclaim SOL left on ephemerals by earlier failed runs. Proof-buffer rent can
 * only be released by the ephemeral that created it, so this is the only way
 * that money comes back.
 *
 * TWO INPUTS THAT LOOK OPTIONAL AND ARE NOT
 * ─────────────────────────────────────────
 * `leafIndices` — the leaf indices of the notes this browser holds. A spend's
 * ephemeral is derived from the leaf index of the note being SPENT, and a spend
 * advances no tree, so an old note's stranded float sits far below the
 * head-relative window `recoverFloat` scans on its own. Passing an empty list
 * silently shrinks what Recover can find; the money is not lost, but nothing
 * else can reach it.
 *
 * The funder address — fetched here, not passed in, because every caller would
 * otherwise have to remember to. Without it `recoverStuckFloat` cannot tell the
 * treasury's money from the user's and sweeps everything home, which is how a
 * crashed funder-paid subscription used to hand ~1.03 SOL of someone else's SOL
 * to the user's wallet and write that wallet back onto the ephemeral. A failed
 * fetch degrades to the old behaviour, which is correct exactly when there is
 * no funder — see `fetchFunderPubkey`.
 */
export async function recoverStuckFunds(
  meta: string,
  denomination: number,
  owner: PublicKey,
  onProgress?: (step: string) => void,
  leafIndices?: number[],
) {
  // ⚠️ THE THREE-STATE ANSWER MATTERS HERE AND NOWHERE ELSE SO MUCH.
  // "no funder" lets a sweep go home; "could not tell" must not, because
  // treasury money might be on the key and sweeping it home writes the buyer's
  // wallet onto the ephemeral that signed their subscription — which is
  // accountKeys[0] of that subscription. One transient fetch failure used to be
  // enough, and it fires on a Recover click, i.e. after the verification run.
  const lookup = await fetchFunderLookup();
  return poolRequest(
    {
      kind: 'poolRecover',
      meta,
      token: 'SOL',
      denomination,
      ownerPubkey: owner.toBase58(),
      funderPubkey: lookup.state === 'configured' ? lookup.pubkey : undefined,
      funderUnknown: lookup.state === 'unknown',
      unshieldLeafIndices: leafIndices,
    },
    onProgress,
  );
}

/**
 * Read the shielded balance + note list for this identity.
 *
 * The scan is two-phase (see `handlePoolScan`): the blinded single-hash pass
 * finds current-scheme notes in milliseconds of CPU, the legacy epoch search
 * takes ~41 s of hashing per derivation. `onPartial` delivers the fast pass's
 * cumulative results as they exist, each payload marked `complete: false` —
 * paint them, but SAY the check for older notes is still running: a partial
 * list presented as complete makes a legacy note read as lost money. The
 * returned promise resolves with the terminal, complete response.
 */
export function scanPool(
  meta: string,
  token: PoolToken,
  onProgress?: (step: string) => void,
  onPartial?: (partial: PoolScanResponse) => void,
) {
  return poolRequest({ kind: 'poolScan', meta, token }, onProgress, onPartial);
}

/**
 * The caller's notes, instantly, from the blobs written at shield time.
 *
 * `scanPool` walks every denomination's on-chain history and re-derives per seed
 * candidate — tens of seconds against the public devnet RPC, during which the UI
 * can only say "Scanning the 0.1 SOL pool...". Everything needed to DRAW the
 * list is already in local storage, encrypted under the pool seed. This reads it
 * without touching the network.
 *
 * 🚨 The returned notes carry `spentKnown: false`. Whether a note has been spent
 * lives in an on-chain nullifier PDA and nothing here has seen one. Show these
 * as provisional and follow with a real `scanPool`; presenting a spent note as
 * available would invite the user to spend money that is gone, which is worse
 * than the wait this removes.
 *
 * Notes shielded on another device are absent — the blob is local. That is why
 * this is a fast FIRST paint, never a replacement.
 */
export async function scanPoolLocal(meta: string, walletPubkey: string) {
  return poolRequest({
    kind: 'poolScanLocal',
    meta,
    blobs: await loadEncryptedNotes(meta, walletPubkey),
  });
}

/**
 * Merge the authoritative chain scan into the locally painted note list.
 *
 * WHY THIS EXISTS. Every panel paints from `scanPoolLocal` first and then used
 * to REPLACE the list with the chain scan's result wholesale. The chain scan
 * re-derives notes from the pool seed, so there are exactly two kinds of note
 * it can never return: a RECEIVED note (its secrets came from the sender's
 * seed; only the local blob knows them) and a note whose leaf events this RPC
 * has pruned. Wholesale replacement therefore made received money vanish from
 * the lists tens of seconds after it appeared, precisely when the slow scan
 * finished. The rule here: the chain scan wins for every leaf it can see (its
 * `spent` is a reading, the local one a default), and a local note the scan
 * has NO row for is kept, because for those two kinds the local store is the
 * only witness. A seed-derived, RPC-visible note always has a chain row, spent
 * or not, so nothing stale is ever resurrected by keeping the remainder.
 */
export function mergeScanWithLocal(
  chainNotes: PoolNoteView[],
  localNotes: PoolNoteView[],
): PoolNoteView[] {
  const seen = new Set(chainNotes.map((n) => `${n.pool}:${n.leafIndex}`));
  return [...chainNotes, ...localNotes.filter((n) => !seen.has(`${n.pool}:${n.leafIndex}`))].sort(
    (a, b) => a.denomination - b.denomination || a.leafIndex - b.leafIndex,
  );
}

export interface ImportNoteOutcome {
  /** Public view of the received note. Carries `spentKnown: false` when the
   *  chain could not be asked whether it is still unspent; say so on screen. */
  note: PoolNoteView;
  /** Whether a withdrawal path travelled with the note. */
  merklePath: 'stored' | 'none';
}

/**
 * Import a sealed `p01enc1:` note somebody handed this wallet.
 *
 * The worker opens it, recomputes its commitment from the secrets (refusing a
 * mismatch), refuses a duplicate or provably spent note, and returns it
 * re-encrypted to this identity's own address. The blob is persisted into the
 * same local store the shield writes, which is exactly what makes the note
 * appear in the note lists with no pool scan: `scanPoolLocal` reads that store,
 * and `resolveSpentNotes` covers the note's spent status from then on.
 *
 * NO transaction is involved in receiving. What the mechanism does not give:
 * when this note is later withdrawn, the withdrawal republishes the commitment
 * the original deposit published, and the sender keeps a spendable copy until
 * someone spends it. Every surface that shows the import must say both.
 */
export async function importReceivedNote(params: {
  meta: string;
  walletPubkey: string;
  sealedNote: string;
  onProgress?: (step: string) => void;
}): Promise<ImportNoteOutcome> {
  const res = await poolRequest(
    {
      kind: 'poolImportNote',
      meta: params.meta,
      sealedNote: params.sealedNote,
      encryptedNotes: await loadEncryptedNotes(params.meta, params.walletPubkey),
    },
    params.onProgress,
  );
  // The blob IS the note's existence on this device; store it before reporting
  // success so a render error can never lose what was just received.
  await storeEncryptedNote(params.meta, params.walletPubkey, res.encryptedNote);
  return { note: res.note, merklePath: res.merklePath };
}

/**
 * Export the ACTIVE pool seed, for configuring a note-issuing treasury.
 *
 * ⛔ THE MOST DANGEROUS CALL IN THIS FILE. The seed derives every secret, every
 * nullifier and every commitment of every note this identity will ever own, and
 * whoever holds it can spend all of them — including notes not yet created.
 *
 * It exists because `P01_TREASURY_POOL_SEED` is derivable only from a wallet
 * signature made in a browser, so a deployment that issues notes cannot be
 * configured without it. The alternatives are worse: a wallet private key on a
 * server, or an operator hand-porting an HKDF chain and getting it subtly wrong
 * in a way that only shows up as notes that cannot be spent.
 *
 * The confirmation string is not security — anyone who can call this can pass
 * it — it guards against the call being reached by a refactor or an
 * autocomplete. A value that has to be typed out is a value somebody meant.
 */
export async function exportPoolSeed(meta: string) {
  return poolRequest({
    kind: 'poolExportSeed',
    meta,
    confirm:
      'I am configuring a note-issuing treasury and accept that this seed can spend every note it derives',
  });
}

export interface IssuedNoteOutcome {
  note: PoolNoteView;
  /** The deployment's leaf index, so the caller can name what it received. */
  leafIndex: number;
  /** Whether a Merkle path travelled with it, or the spend must rebuild one. */
  merklePath: 'stored' | 'none';
  /** The issuer's own words about what this does and does not hide. Render it. */
  disclosure: string;
}

/**
 * The message the wallet signs to unlock ONE anonymous buyer identity.
 *
 * WHY THERE IS A SEPARATE MESSAGE AT ALL
 * ──────────────────────────────────────
 * A pool identity is 32 bytes. The wallet was only ever needed to make those
 * bytes recoverable without stored state, and to sign the pre-fund — and the
 * funder does the second job now. So the buyer of a subscription does not have
 * to be the connected wallet, and should not be: the wallet is the thing an
 * observer is trying to reach.
 *
 * ⛔ SIGNING `buildDerivationMessage` INSTEAD WOULD PRODUCE THE SAME IDENTITY.
 * Same signature, same seeds, same notes, same addresses — an "ephemeral buyer"
 * that is the wallet wearing a label. In this app it fails loudly rather than
 * silently, because the issuing treasury may be that same wallet and the
 * self-deposit guard refuses a note the buyer's own identity deposited. That is
 * luck, not design. The message is different on purpose.
 *
 * DETERMINISTIC, NOT RANDOM, and that is the second half of the design. A buyer
 * identity built from `crypto.getRandomValues` cannot be re-derived, and the
 * license key of every subscription made under it is derived from a note secret
 * that lives only there — so a cleared browser would destroy the proof of a
 * subscription that is still being paid for. Keying on the wallet plus an index
 * keeps it re-derivable forever, with nothing stored, from the same wallet.
 *
 * The index is what lets one wallet hold several unrelated buyer identities.
 * Nothing on chain connects them to each other or to the wallet.
 */
export function buildAnonymousBuyerMessage(params: {
  walletPubkey: string;
  origin: string;
  index: number;
}): string {
  return [
    'Protocol 01 — Anonymous subscription identity',
    '',
    'Sign to derive a one-off identity that buys a subscription on your behalf.',
    'This does NOT send a transaction and costs no gas.',
    '',
    'The identity holds the note and signs nothing on chain. Your wallet is not',
    'part of the subscription it creates.',
    '',
    `ONLY sign this on ${params.origin}.`,
    '',
    `Domain: ${params.origin}`,
    `Wallet: ${params.walletPubkey}`,
    `Identity: ${params.index}`,
    'Version: anon-buyer-v1',
  ].join('\n');
}

/**
 * Derive an anonymous buyer identity in the worker and return its handle.
 *
 * `meta` is a label for this worker session, derived from the signature so that
 * re-deriving the same identity reaches the same label without storing one. The
 * signature itself is wiped here the moment the worker has answered — the worker
 * keeps the derived seeds, which is the weaker secret of the two.
 */
export async function deriveAnonymousBuyer(params: {
  signature: Uint8Array;
}): Promise<{ meta: string; address: string }> {
  const label = `anon:${Buffer.from(sha256(params.signature)).toString('hex').slice(0, 32)}`;
  const res = await poolRequest({
    kind: 'poolDeriveIdentity',
    meta: label,
    signature: Array.from(params.signature),
  });
  params.signature.fill(0);
  return { meta: res.meta, address: res.address };
}

/**
 * What this deployment issues, so a caller can ask for what exists.
 *
 * Leaf indices are only meaningful inside ONE pool — leaf 34 of the 1 SOL pool
 * and leaf 34 of the 0.1 SOL pool are different notes. A client that hard-codes
 * a denomination therefore makes every treasury that chose another pool
 * unreachable, and the symptom is an inventory that "does not match the chain",
 * which reads like a derivation bug.
 *
 * Returns null when this deployment issues nothing, or could not say.
 */
export async function fetchIssuableNote(): Promise<{ denomination: number; token: PoolToken } | null> {
  try {
    const res = await fetch('/api/issue-note', { method: 'GET' });
    const body: { ok?: boolean; configured?: boolean; denomination?: number; token?: string } =
      await res.json();
    if (!res.ok || !body.ok || !body.configured || !body.denomination) return null;
    return { denomination: body.denomination, token: body.token === 'USDC' ? 'USDC' : 'SOL' };
  } catch {
    return null;
  }
}

/**
 * Ask this deployment for a note IT deposited, sealed to this identity.
 *
 * WHY THIS IS THE DIFFERENCE BETWEEN A RUNBOOK AND A PRODUCT
 * ─────────────────────────────────────────────────────────
 * A note the buyer deposited themselves links every subscription bought with it
 * straight back to them, in one hop, through the deposit — whoever pays for the
 * subscription. The fix is to spend a note somebody else deposited, and until
 * now that meant a two-wallet ritual: shield from A, seal to B, import into B,
 * subscribe from B. Nobody opens a second Phantom to buy a subscription. They
 * click once, and if the click does not work they leave.
 *
 * So the deployment deposits, and this fetches. One wallet, one action, and the
 * part that has to be true — the depositor is not the buyer — is true by
 * construction rather than by the user having followed instructions.
 *
 * ⛔ AND IT DOES NOT HIDE THEM FROM THE ISSUER. The note derives from a seed the
 * server holds, so the issuer can regenerate every value this note will ever
 * publish — subscriber_commitment, the nullifier, the vault PDA — with no
 * records kept. It can also spend the note itself until the recipient does.
 * `disclosure` carries the issuer's own statement of that, and callers must show
 * it rather than summarise it away.
 *
 * Throws with the endpoint's reason. Callers must NOT fall back to a
 * self-deposited note on failure: that silently delivers the linked outcome the
 * whole mechanism exists to avoid, which is the fallback mistake this codebase
 * has already made once with the funder.
 */
export async function requestIssuedNote(params: {
  meta: string;
  walletPubkey: string;
  token: PoolToken;
  denomination: number;
  /**
   * A claim minted against a payment. Required — a note is the denomination
   * itself, and the ticket that authorises the request ships in the browser
   * bundle, so it cannot also be what authorises the value.
   */
  claimCode: string;
  onProgress?: (step: string) => void;
}): Promise<IssuedNoteOutcome> {
  const ticket = funderTicket();
  if (!ticket) throw new Error('This deployment does not issue notes.');

  // The address is derived in the worker from the pool seed, so the server only
  // ever learns a public encryption key — never a secret, and never the wallet.
  params.onProgress?.('Asking for a note (your wallet does not deposit one)...');
  const recipientAddress = await fetchNoteReceiveAddress(params.meta);

  const res = await fetch('/api/issue-note', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    body: JSON.stringify({
      recipientAddress,
      token: params.token,
      denomination: params.denomination,
      claimCode: params.claimCode,
    }),
  });
  let body: {
    ok?: boolean;
    error?: string;
    sealedNote?: string;
    leafIndex?: number;
    disclosure?: string;
  };
  try {
    body = await res.json();
  } catch {
    throw new Error(`The note issuer replied with a non-JSON ${res.status}.`);
  }
  if (!res.ok || !body.ok || !body.sealedNote) {
    throw new Error(body.error ? `No note was issued: ${body.error}` : `The issuer replied ${res.status}.`);
  }

  // Import through the SAME path a hand-delivered note takes. That is
  // deliberate: `poolImportNote` recomputes the commitment from the secrets and
  // refuses a mismatch, so a wrong or corrupted issuance cannot enter the store
  // looking like money — and the issuer is not trusted to have sealed a real
  // note just because it is the issuer.
  params.onProgress?.('Opening the note...');
  const imported = await importReceivedNote({
    meta: params.meta,
    walletPubkey: params.walletPubkey,
    sealedNote: body.sealedNote,
  });

  return {
    note: imported.note,
    leafIndex: body.leafIndex ?? imported.note.leafIndex,
    merklePath: imported.merklePath,
    disclosure:
      body.disclosure ??
      'This note was deposited by this deployment. It does not hide you from the deployment.',
  };
}

/**
 * This identity's `p01pq:` note address, the one to hand to whoever wants to
 * seal a note to this wallet. Public key material, safe to display and share;
 * derived in the worker because it is a function of the pool seed.
 */
export async function fetchNoteReceiveAddress(meta: string): Promise<string> {
  const res = await poolRequest({ kind: 'poolNoteAddress', meta });
  return res.address;
}

// ---------------------------------------------------------------------------
// Local persistence — encrypted values, opaque index (leak L5)
// ---------------------------------------------------------------------------

/**
 * WHAT THE v1 STORES LEAKED, AND WHAT v2 CHANGES
 * ──────────────────────────────────────────────
 * Until 2026-08-12 the three stores below sat in localStorage keyed by the
 * WALLET PUBKEY in cleartext, and two of them held cleartext values: the payout
 * store's `{pool, leafIndex, address, txSig}` rows were exactly the
 * (wallet, note, payout address, withdrawal) linkage table that the derived
 * payout address, the worker boundary and the C7 plan all exist to keep apart.
 * Readable by any XSS, any extension with the `storage` permission, any disk
 * forensic, any export-my-data flow.
 *
 * v2 keeps the same localStorage transport but changes both halves:
 *
 *   INDEX — an opaque label from the worker (`poolStoreLabel`): a 16-byte HKDF
 *   leg of the v1 pool seed, meaningless without the wallet signature. The
 *   wallet pubkey no longer appears anywhere in the stores.
 *
 *   VALUES — payout and spent records are sealed with the SAME hybrid
 *   X25519 + ML-KEM-768 `encryptNote` the note store already uses, to this
 *   identity's own `p01pq:` address. Encryption needs only the PUBLIC address,
 *   so it runs here on the main thread; decryption needs the pool seed and
 *   happens only in the worker (`poolOpenRecords`), which whitelists what may
 *   cross back. The seed itself never reaches this thread — that boundary is
 *   the same one `handlePoolExportNote` documents, unchanged.
 *
 * WHAT THIS CANNOT LOSE. Every v2 read degrades, never destroys: the payout
 * ADDRESS derivation below is untouched and re-derives every address from
 * (wallet signature, pool, leafIndex) with no store at all; spent status
 * re-resolves from the chain; shielded-note blobs re-derive from the seed.
 * The one exception is a RECEIVED note's blob, which was already ciphertext in
 * v1 and moves bytes-unchanged.
 *
 * MIGRATION. v1 entries are moved lazily, per wallet, the first time a live
 * session touches a store: note blobs move as-is under the label; payout and
 * spent rows are sealed and appended, and only then is the wallet's v1 bucket
 * deleted — in the same synchronous turn, so a thrown encrypt leaves v1
 * intact. Until a wallet has migrated, every read UNIONS the v1 leftovers, so
 * no record written before this change ever disappears — a user who cannot
 * find a payout address loses the money sitting on it.
 */

const NOTE_STORE_KEY = 'p01_pay_notes_v2';
const SPENT_STORE_KEY = 'p01_pay_spent_notes_v2';
const PAYOUT_STORE_KEY = 'p01_pay_pool_payouts_v2';

/** The pre-L5 stores, keyed by wallet pubkey. Read as migration fallback
 *  forever; written never (except the quota-failure note path below). */
const NOTE_STORE_KEY_V1 = 'p01_pay_notes_v1';
const SPENT_STORE_KEY_V1 = 'p01_pay_spent_notes_v1';
const PAYOUT_STORE_KEY_V1 = 'p01_pay_pool_payouts_v1';

// The session (label + sealing address), map helpers and `sealRecord` live in
// `sealedStore.ts`, shared with the handoff store — see its header.

/**
 * Move one wallet's v1 note blobs under the opaque label. The values are
 * already ciphertext — only the index changes, so this is pure bookkeeping and
 * cannot fail in a way that loses a blob: the v2 write lands before the v1
 * bucket is deleted, in the same synchronous turn.
 */
function migrateNoteStore(walletPubkey: string, label: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const old = readMap<string>(NOTE_STORE_KEY_V1);
    const mine = old[walletPubkey];
    if (!mine || mine.length === 0) return;
    const all = readMap<string>(NOTE_STORE_KEY);
    const list = all[label] ?? [];
    for (const blob of mine) if (!list.includes(blob)) list.push(blob);
    all[label] = list;
    writeMap(NOTE_STORE_KEY, all);
    delete old[walletPubkey];
    writeMap(NOTE_STORE_KEY_V1, old);
  } catch {
    // Quota or private-mode failure: the fallback read below still serves v1.
  }
}

/**
 * Seal one wallet's v1 payout/spent rows into the v2 stores and delete the v1
 * bucket. Order is the fund-safety property: encrypt-and-write v2 FIRST, then
 * delete v1 in the same synchronous turn. A throw anywhere leaves v1 exactly
 * as it was, and every read path unions the v1 leftovers regardless.
 */
function migrateLinkageStores(session: StoreSession, walletPubkey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const oldPayouts = readMap<PayoutRecord>(PAYOUT_STORE_KEY_V1);
    const minePayouts = oldPayouts[walletPubkey];
    if (minePayouts && minePayouts.length > 0) {
      const all = readMap<string>(PAYOUT_STORE_KEY);
      const list = all[session.label] ?? [];
      for (const rec of minePayouts) {
        list.push(
          sealRecord(session.address, {
            p01store: 1,
            kind: 'payout',
            pool: rec.pool,
            leafIndex: rec.leafIndex,
            address: rec.address,
            txSig: rec.txSig,
            denomination: rec.denomination,
          }),
        );
      }
      all[session.label] = list;
      writeMap(PAYOUT_STORE_KEY, all);
      delete oldPayouts[walletPubkey];
      writeMap(PAYOUT_STORE_KEY_V1, oldPayouts);
    }

    const oldSpent = readMap<string>(SPENT_STORE_KEY_V1);
    const mineSpent = oldSpent[walletPubkey];
    if (mineSpent && mineSpent.length > 0) {
      const all = readMap<string>(SPENT_STORE_KEY);
      const list = all[session.label] ?? [];
      for (const key of mineSpent) {
        list.push(sealRecord(session.address, { p01store: 1, kind: 'spent', key }));
      }
      all[session.label] = list;
      writeMap(SPENT_STORE_KEY, all);
      delete oldSpent[walletPubkey];
      writeMap(SPENT_STORE_KEY_V1, oldSpent);
    }
  } catch {
    // Same contract as migrateNoteStore: v1 stays, fallback reads still serve.
  }
}

/**
 * Raised whenever a note blob lands in the store, so an already-rendered count
 * catches up without a rescan. Same contract as `HANDOFFS_CHANGED_EVENT`
 * (lib/pay/handoffs.ts): dispatched on write, no payload, listeners re-read.
 *
 * Why it exists: PayApp keeps visited panels mounted and merely CSS-hidden, so
 * PoolPanel's backup count — state since the async store conversion, written
 * only inside its own `rescan` — froze whenever another surface wrote a blob.
 * The writer that matters is `importReceivedNote` on the Receive tab: a
 * received note's blob is its ONLY record (see `storeEncryptedNote`), so the
 * count under-reported the one kind of note no rescan can bring back.
 */
export const NOTES_CHANGED_EVENT = 'p01:notes-changed';

function announceNotesChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(NOTES_CHANGED_EVENT));
  } catch {
    // An environment without Event is not worth failing a write over.
  }
}

/**
 * Persist an encrypted note blob. The main thread cannot read these — only the
 * worker, holding the pool seed, can decrypt them.
 *
 * NOTE ON WHAT THIS IS AND IS NOT. For a SHIELDED note the blob is the fast
 * path, not the recovery path: `scanPoolLocal` paints the lists from it,
 * `resolveSpentNotes` resolves spent status through it, and the stored Merkle
 * path spares the withdrawal a history rebuild, but a wiped store loses nothing
 * because discovery re-derives everything from the pool seed plus on-chain
 * history (`pool/poolNotes.ts`). For a RECEIVED note (`importReceivedNote`)
 * the blob is the ONLY record: its secrets are not derivable from this wallet's
 * seed, so no rescan brings it back. Do not treat this store as disposable —
 * which is also why a failed label fetch falls back to the v1 wallet-keyed
 * store rather than dropping the blob: a worse index beats a lost note.
 */
export async function storeEncryptedNote(
  meta: string,
  walletPubkey: string,
  blob: string,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    const { label } = await storeSession(meta);
    migrateNoteStore(walletPubkey, label);
    const all = readMap<string>(NOTE_STORE_KEY);
    const list = all[label] ?? [];
    if (!list.includes(blob)) list.push(blob);
    all[label] = list;
    writeMap(NOTE_STORE_KEY, all);
  } catch {
    // No session, quota, or private mode. Every caller reaches here moments
    // after a successful worker round trip, so "no session" is near-impossible
    // — but a received note's blob is its only record, so the last resort is
    // the v1 store, which every read path still unions.
    try {
      const all = readMap<string>(NOTE_STORE_KEY_V1);
      const list = all[walletPubkey] ?? [];
      if (!list.includes(blob)) list.push(blob);
      all[walletPubkey] = list;
      writeMap(NOTE_STORE_KEY_V1, all);
    } catch {
      // Quota failure on both: recovery-by-scan still covers a shielded note.
    }
  }
  // After both attempts, like `recordHandoff`: listeners re-read through
  // `loadEncryptedNotes`, which unions the v2 and v1 stores, so the event is
  // right whichever write landed — and harmless if neither did.
  announceNotesChanged();
}

export async function loadEncryptedNotes(meta: string, walletPubkey: string): Promise<string[]> {
  try {
    const { label } = await storeSession(meta);
    migrateNoteStore(walletPubkey, label);
    return [
      ...(readMap<string>(NOTE_STORE_KEY)[label] ?? []),
      // Post-migration this is empty; until then (or after a quota failure
      // above) it is where the blobs still live.
      ...(readMap<string>(NOTE_STORE_KEY_V1)[walletPubkey] ?? []),
    ];
  } catch {
    // No worker session: only the v1 view exists. Callers that need the blobs
    // for a worker request are about to fail on the same missing session anyway.
    return readMap<string>(NOTE_STORE_KEY_V1)[walletPubkey] ?? [];
  }
}

/** The decrypted view of the two linkage stores, plus the v1 leftovers. */
interface LinkageView {
  payouts: PayoutRecord[];
  spentKeys: Set<string>;
  /** True when a version-skewed worker could not open the sealed records: the
   *  two fields above are then missing everything sealed, and post-migration
   *  the v1 union no longer covers for them. Callers must surface this, not
   *  serve the shortfall as truth — an absent spent key re-offers a spent note
   *  (~1 SOL of buffer rent to fail), an absent payout row hides funds. */
  staleWorker: boolean;
  /** True when the worker LOST this identity's seeds mid-session — it crashed
   *  under the open tab and workerClient rebooted it with every secret wiped.
   *  Same shortfall as `staleWorker` (the two fields above are missing
   *  everything sealed), DIFFERENT cure: only a fresh wallet signature
   *  re-derives the seeds; a reload alone changes nothing. Callers must never
   *  show the reload line for this, or the user tries it, it fails, and they
   *  conclude the money is gone. Structural like the skew flag: it can only
   *  be raised after sealed blobs were FOUND and the open round trip refused
   *  them, so a genuinely empty store cannot fire it. */
  lostSession: boolean;
}

/**
 * Open both linkage stores in ONE worker round trip (`poolOpenRecords` sorts
 * the mixed blobs back into payouts and spent keys), then union whatever is
 * still sitting in v1 — either because there is no session to migrate under,
 * or because a quota failure aborted a migration.
 *
 * The v1→v2 migration runs AFTER a successful open, never before: sealing the
 * v1 rows moments before discovering the worker cannot read them back (skewed
 * or restarted) would make records the user could see seconds ago vanish
 * behind a banner. The zero-blob round trip is the deliberate probe for that
 * case — see `openSealedRecords`.
 */
async function openLinkage(meta: string, walletPubkey: string): Promise<LinkageView> {
  let payouts: PayoutRecord[] = [];
  let spentKeys: string[] = [];
  let staleWorker = false;
  let lostSession = false;
  // Snapshot the v1 leftovers FIRST: the union at the bottom is built from
  // this copy, so the rows a migration seals in this very call keep serving
  // on this call's answer. Nothing is counted twice — the by-note map and the
  // Set below deduplicate on the plaintext key either way.
  const leftPayouts = readMap<PayoutRecord>(PAYOUT_STORE_KEY_V1)[walletPubkey] ?? [];
  const leftSpent = readMap<string>(SPENT_STORE_KEY_V1)[walletPubkey] ?? [];
  // `storeSession` runs on its own first because its rejection means the
  // worker holds no seeds AND this page never saw it hold any ("not signed
  // yet"): nothing has migrated under a session that never existed, the v1
  // snapshot above is the complete view, and a banner over a complete list
  // would be the false alarm in the other direction. The SAME no-keys
  // rejection after a session existed is a different fact, classified below.
  let session: StoreSession | null = null;
  try {
    session = await storeSession(meta);
  } catch {
    // No worker session ever derived: the v1 snapshot still serves, so
    // nothing recorded before the L5 change disappears.
  }
  if (session) {
    // Note blobs are ciphertext in v1 and v2 alike — this migration only
    // moves the index, cannot change readability, and so runs regardless of
    // what the worker turns out to be able to open.
    migrateNoteStore(walletPubkey, session.label);
    const blobs = [
      ...(readMap<string>(PAYOUT_STORE_KEY)[session.label] ?? []),
      ...(readMap<string>(SPENT_STORE_KEY)[session.label] ?? []),
    ];
    if (blobs.length > 0 || leftPayouts.length > 0 || leftSpent.length > 0) {
      try {
        const res = await openSealedRecords(meta, blobs);
        // A version-skewed worker (old worker, new page, tab open across a
        // deploy) answers without one array or both — it predates the record
        // kind, NOT "there are no records". Degrade to the v1 union below
        // rather than throwing, but carry the skew out as `staleWorker`: after
        // migration the v1 buckets are empty, and silence here painted the
        // payout list empty and re-offered spent notes. The flag is gated on
        // `blobs.length > 0` because only sealed records can be hidden by
        // skew: a zero-blob answer was a migration probe, and flagging it
        // would banner a list the v1 snapshot serves in full. The genuinely
        // empty store (no blobs, no v1 rows) never reaches this branch at
        // all. See sealedStore.SealedRecordsAnswer.
        const answered = res.payouts !== undefined && res.spentKeys !== undefined;
        staleWorker = !answered && blobs.length > 0;
        payouts = res.payouts ?? [];
        spentKeys = res.spentKeys ?? [];
        // Only a worker that just proved it reads both kinds may take the v1
        // rows away from the cleartext store: their sealed copies are
        // readable the moment they land.
        if (answered) migrateLinkageStores(session, walletPubkey);
      } catch (err) {
        // `storeSession` succeeded above — live, or from the cache a previous
        // success left — so seeds existed for this meta, and a no-keys
        // refusal now means the worker lost them under the open tab: it was
        // rebooted with every secret wiped. Same empty-looking shortfall as
        // skew, DIFFERENT cure (a fresh signature, not a reload), so it gets
        // its own flag. The position of this catch is the classification —
        // the never-derived shape rejects at `storeSession` above and stays
        // flagless — and the same `blobs.length > 0` gate as the skew flag
        // keeps a probe rejection from bannering a complete v1 view.
        if (isSessionLostError(err) && blobs.length > 0) lostSession = true;
        // Anything else (timeout, crash mid-call): degrade exactly as
        // before — the v1 snapshot below still serves, flagless.
      }
    }
  }
  const byNote = new Map<string, PayoutRecord>();
  for (const rec of [...payouts, ...leftPayouts]) {
    const k = `${rec.pool}:${rec.leafIndex}`;
    if (!byNote.has(k)) byNote.set(k, rec);
  }
  return {
    payouts: [...byNote.values()],
    spentKeys: new Set([...spentKeys, ...leftSpent]),
    staleWorker,
    lostSession,
  };
}

/**
 * Notes this browser has withdrawn, keyed `pool:leafIndex`.
 *
 * WHY THIS EXISTS. Whether a note is spent lives in an on-chain nullifier PDA,
 * and reading it means the full pool scan — which enumerates candidate epochs
 * per note per denomination and runs for minutes on devnet. Until it answers,
 * every list is drawn from the local blobs, whose `spent` is a default and not
 * a reading, so a note withdrawn ten minutes ago comes back offering Withdraw.
 * Measured on devnet 2026-08-04: leaf #18 survived its own withdrawal, the
 * sweep, and a page reload.
 *
 * Acting on one of those rows locks ~1 SOL of proof-buffer rent and spends
 * minutes uploading before it can only fail on a nullifier collision.
 *
 * APPEND-ONLY AND NON-DESTRUCTIVE ON PURPOSE. The note blob is left alone, so
 * nothing is lost if this record is wrong; and since a spent note cannot become
 * unspent, an entry here can only ever correct a stale read, never hide a live
 * note. It is a local memory of our own actions, not a substitute for the chain.
 */
export async function recordSpentNote(
  meta: string,
  walletPubkey: string,
  noteKey: string,
): Promise<void> {
  return recordSpentNotes(meta, walletPubkey, [noteKey]);
}

/** Batched form: `resolveSpentNotes` confirms several at once, and reading the
 *  store back for dedup costs a worker round trip — pay it once, not per key. */
async function recordSpentNotes(
  meta: string,
  walletPubkey: string,
  noteKeys: string[],
): Promise<void> {
  if (typeof localStorage === 'undefined' || noteKeys.length === 0) return;
  try {
    // The read migrates, and its Set is the dedup: sealed blobs are randomized
    // ciphertext, so equality of records can only be checked on the plaintext.
    // A blinded read (`staleWorker` or `lostSession`) only weakens the dedup —
    // this path APPENDS and never rewrites, so the worst outcome is a
    // duplicate blob the read-side Set absorbs. No guard needed, unlike the
    // rewriting stores.
    const existing = (await openLinkage(meta, walletPubkey)).spentKeys;
    const fresh = noteKeys.filter((k) => !existing.has(k));
    if (fresh.length === 0) return;
    const session = await storeSession(meta);
    const all = readMap<string>(SPENT_STORE_KEY);
    const list = all[session.label] ?? [];
    for (const key of fresh) {
      list.push(sealRecord(session.address, { p01store: 1, kind: 'spent', key }));
    }
    all[session.label] = list;
    writeMap(SPENT_STORE_KEY, all);
  } catch {
    // Quota or private-mode failure. The chain scan still resolves it, slowly.
  }
}

/**
 * Every note this browser knows it has spent, keyed `pool:leafIndex`.
 *
 * Unions the explicit record above with the payout history, because a payout
 * record is written only when a withdrawal has succeeded — it is already proof
 * of a spend, and it exists for withdrawals made before the explicit record was
 * introduced. Without that second source the fix would only protect notes spent
 * from this version onward, and would leave exactly the note that exposed the
 * bug still sitting in the list.
 *
 * Subscription records are the third source, by the same argument: one is
 * written only when a subscribe has succeeded, and it names the note that was
 * escrowed (`pool` + `leafIndex`). Records imported by vault address carry no
 * note identity and contribute nothing here; for those, and for anything
 * recorded by no one, `resolveSpentNotes` below reads the chain itself.
 *
 * `meta: null` (no session yet) still answers from the v1 leftovers and the
 * subscription store, so the pickers keep whatever protection exists before
 * the wallet has signed.
 *
 * `staleWorker: true` means a version-skewed worker left the set SHORT of
 * sealed spends (from either source), so a picker filtering on it may re-offer
 * a note that is already gone — the caller must surface the flag alongside
 * whatever protection the readable sources still gave.
 *
 * `lostSession: true` is the same shortfall with a different cure: the worker
 * restarted mid-session and lost the seeds, so the sealed spends are
 * unreadable until the user SIGNS again — a reload alone changes nothing.
 * The caller must say the right cure for the flag it renders.
 */
export async function knownSpentNoteKeys(
  meta: string | null,
  walletPubkey: string,
): Promise<{ keys: Set<string>; staleWorker: boolean; lostSession: boolean }> {
  const keys = new Set<string>();
  let staleWorker = false;
  let lostSession = false;
  if (meta) {
    const view = await openLinkage(meta, walletPubkey);
    staleWorker = view.staleWorker;
    lostSession = view.lostSession;
    for (const k of view.spentKeys) keys.add(k);
    for (const p of view.payouts) keys.add(`${p.pool}:${p.leafIndex}`);
  } else {
    for (const k of readMap<string>(SPENT_STORE_KEY_V1)[walletPubkey] ?? []) keys.add(k);
    for (const p of readMap<PayoutRecord>(PAYOUT_STORE_KEY_V1)[walletPubkey] ?? []) {
      keys.add(`${p.pool}:${p.leafIndex}`);
    }
  }
  // `meta` (or null) flows through: the subscription store is sealed too now,
  // and its loader internally unions the v1 cleartext leftovers until they are
  // provably empty — a subscribed note that stopped being known here would
  // walk back into a picker and fail only after a proof and ~1 SOL of rent.
  // Skew or a lost session in either store leaves this set short, so each
  // flag ORs across the stores it blinds.
  const subs = await loadSubscriptions(meta, walletPubkey);
  staleWorker = staleWorker || subs.staleWorker;
  lostSession = lostSession || subs.lostSession;
  for (const s of subs.records) {
    if (s.pool !== undefined && s.leafIndex !== undefined) {
      keys.add(`${s.pool}:${s.leafIndex}`);
    }
  }
  return { keys, staleWorker, lostSession };
}

// ---------------------------------------------------------------------------
// Withdrawal payout addresses
// ---------------------------------------------------------------------------

/**
 * WHY A WITHDRAWAL NO LONGER PAYS THE CONNECTED WALLET
 * ───────────────────────────────────────────────────
 * `unshield_denominated_stark_v3` takes the recipient as a plain account, and
 * /pay used to pass the connected wallet (`PoolPanel.tsx:125`, `recipient: owner`).
 * That put the user's wallet in the withdrawal transaction by name, which is the
 * one thing a shielded pool exists to avoid. The withdrawal now pays a fresh
 * address, one per note, and the user moves the funds on afterwards at a time
 * and to a destination they choose.
 *
 * THE DERIVATION, AND THE MOBILE BUG IT DELIBERATELY DOES NOT COPY
 * ───────────────────────────────────────────────────────────────
 * Mobile derives its per-note stealth signer as
 *
 *   hmac(sha256, walletAddr, 'stealth_unshield_v3_' + noteId)
 *       — apps/mobile/stores/denominatedPoolStore.ts:1545
 *
 * Both inputs are PUBLIC, so anybody who watches the chain recomputes the
 * private key. "Each note id is used only once" is a collision argument, not a
 * secrecy argument. Do not port that.
 *
 * Here the root is a wallet SIGNATURE over a fixed, origin-bound, version-tagged
 * message — the same class of secret `seedDerivation.ts` already builds the pool
 * seed from, and the same recoverability property: deterministic Ed25519, so the
 * same wallet reaches the same payout addresses on any device, forever, with
 * nothing stored.
 *
 *   payoutRoot = HKDF-SHA256(ikm = signature, salt = ∅, info = <root info>)
 *   payoutKey(pool, leaf) = Ed25519(HKDF-SHA256(ikm = payoutRoot, salt = ∅,
 *                                   info = <key info> ‖ poolPDA ‖ u32le(leaf)))
 *
 * The message is NOT `buildDerivationMessage`. That is load-bearing: this root
 * lives on the MAIN THREAD, and the pool seed must stay derivable only inside
 * the Worker. A different message means a leak of this signature yields payout
 * keys and nothing else — no note secret, no nullifier, no stealth spend key.
 *
 * WHAT THIS DOES **NOT** BUY — read before writing any copy
 * ────────────────────────────────────────────────────────
 * The wallet still publicly funds the withdrawal ephemeral E before the
 * withdrawal runs (`unshieldFromPool` above builds `owner -> E` and the wallet
 * signs it), and E is the withdrawal's own signer. So an observer still reads
 * "wallet funded E, E withdrew note X". Moving the RECIPIENT off the wallet stops
 * the note's value from landing in the wallet and stops the wallet appearing as
 * the pool's payee; it does not unlink the wallet from the withdrawal. Closing
 * that needs the pre-fund to stop coming from the wallet, which is not built.
 *
 * And sweeping a payout address straight back to the wallet re-establishes the
 * link, exactly as the measured mobile withdrawal did (stealth recipient
 * C4MqLbEx… forwarded 0.994995 SOL to the user's wallet 8 seconds later, slot
 * 481027703). That is why the sweep is a separate, user-initiated action with a
 * free-text destination, and never automatic.
 *
 * QUANTUM: the root is an Ed25519 signature, so a CRQC adversary who recovers
 * the wallet key re-signs this message and reproduces every payout key. Same
 * exposure `seedDerivation.ts:17-25` documents for the pool seed. Payout
 * addresses are meant to be swept promptly, not used as storage.
 */
export const POOL_PAYOUT_DERIVATION_VERSION = 'pool-payout-v1';

/** HKDF info for the root. Distinct from every pool-seed info string. */
const PAYOUT_ROOT_INFO = utf8ToBytes('p01:web:pool-payout-root:v1');

/** HKDF info prefix for one note's payout key. */
const PAYOUT_KEY_INFO = utf8ToBytes('p01:web:pool-payout-key:v1');

/**
 * The string the wallet signs to unlock its payout addresses.
 *
 * Origin-bound and version-tagged for the same reasons `buildDerivationMessage`
 * is (see `message.ts`), and deliberately different from it so the two roots
 * cannot be derived from one another.
 */
export function buildPoolPayoutMessage(params: {
  walletPubkey: string;
  origin: string;
}): string {
  const { walletPubkey, origin } = params;
  return [
    'Protocol 01 — Pool Withdrawal Payout Keys',
    '',
    'Sign to derive the one-time addresses your shielded withdrawals pay out to.',
    'This does NOT send a transaction and costs no gas.',
    '',
    `ONLY sign this on ${origin}. Signing it elsewhere exposes those addresses.`,
    '',
    `Domain: ${origin}`,
    `Wallet: ${walletPubkey}`,
    `Version: ${POOL_PAYOUT_DERIVATION_VERSION}`,
  ].join('\n');
}

/** HKDF the signature into the 32-byte payout root. The caller should wipe the
 *  signature afterwards — it is the stronger secret of the two. */
export function derivePoolPayoutRoot(signature: Uint8Array): Uint8Array {
  return hkdf(sha256, signature, undefined, PAYOUT_ROOT_INFO, 32);
}

/**
 * The address one note's withdrawal pays out to.
 *
 * Keyed by (pool, leaf index) so it is fresh per note and re-derivable from the
 * note list alone — a withdrawn note keeps its leaf index forever, so a user who
 * clears local storage still recovers every payout address from a rescan.
 */
export function derivePoolPayoutKeypair(
  payoutRoot: Uint8Array,
  poolPDA: PublicKey | string,
  leafIndex: number,
): Keypair {
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error(`Refusing to derive a payout key for leaf index ${leafIndex}.`);
  }
  const pool = typeof poolPDA === 'string' ? new PublicKey(poolPDA) : poolPDA;
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, leafIndex, true);
  const info = concatBytes(PAYOUT_KEY_INFO, pool.toBytes(), idx);
  return Keypair.fromSeed(hkdf(sha256, payoutRoot, undefined, info, 32));
}

/** One withdrawal's payout address, as remembered locally. */
export interface PayoutRecord {
  /** Pool PDA, base58. */
  pool: string;
  leafIndex: number;
  /** The derived payout address, base58. Public — no secret is stored. */
  address: string;
  /** Withdrawal signature, for the explorer link. */
  txSig: string;
  denomination: number;
}

/**
 * Remember a payout address so the UI can list it without a full rescan.
 *
 * This is a CONVENIENCE, not the recovery path: the address is a pure function
 * of (wallet signature, pool, leaf index), so a wiped store costs a rescan and
 * nothing else. Only public values go IN — but together they are the exact
 * deposit↔withdrawal↔wallet linkage table, which is why the record is sealed
 * before it is persisted (see the L5 header above) instead of sitting readable
 * next to it.
 */
export async function recordPayout(
  meta: string,
  walletPubkey: string,
  rec: PayoutRecord,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    // The read migrates, and its records are the dedup: sealed blobs are
    // randomized ciphertext, so (pool, leafIndex) can only be compared on the
    // plaintext the worker hands back.
    // A blinded read (`staleWorker` or `lostSession`) only weakens the dedup —
    // this path APPENDS and never rewrites, so the worst outcome is a
    // duplicate blob the read-side (pool, leafIndex) map absorbs. No guard
    // needed.
    const existing = (await openLinkage(meta, walletPubkey)).payouts;
    if (existing.some((r) => r.pool === rec.pool && r.leafIndex === rec.leafIndex)) return;
    const session = await storeSession(meta);
    const all = readMap<string>(PAYOUT_STORE_KEY);
    const list = all[session.label] ?? [];
    list.push(
      sealRecord(session.address, {
        p01store: 1,
        kind: 'payout',
        pool: rec.pool,
        leafIndex: rec.leafIndex,
        address: rec.address,
        txSig: rec.txSig,
        denomination: rec.denomination,
      }),
    );
    all[session.label] = list;
    writeMap(PAYOUT_STORE_KEY, all);
  } catch {
    // Quota or private-mode failure — re-derivation from the note list still
    // finds every payout address.
  }
}

/** `staleWorker: true` = a skewed worker could not open the sealed records, so
 *  `records` is missing every sealed payout — money the user cannot otherwise
 *  see. The caller must say so (a reload heals it), never render the shortfall
 *  as an empty history.
 *  `lostSession: true` = the worker restarted and lost the seeds mid-session:
 *  the same records are missing, but only signing again heals it — the caller
 *  must never show the reload line for this one. */
export async function loadPayouts(
  meta: string,
  walletPubkey: string,
): Promise<{ records: PayoutRecord[]; staleWorker: boolean; lostSession: boolean }> {
  const view = await openLinkage(meta, walletPubkey);
  return { records: view.payouts, staleWorker: view.staleWorker, lostSession: view.lostSession };
}

/** Exactly the sweep transaction's own fee, so the payout account lands on zero.
 *  Any smaller residue leaves a 0-data system account rent-paying, which the
 *  runtime rejects outright — the same trap documented in `unshieldEphemeral.ts`. */
const PAYOUT_SWEEP_FEE = 5_000;

/**
 * Move a payout address's whole balance to `destination`, signed by the derived
 * key alone. The user's wallet is not involved and approves nothing.
 *
 * `destination` is whatever the caller passes. Sweeping to the wallet that
 * funded the withdrawal is allowed and is sometimes what the user wants; it also
 * re-links the two on-chain, so whatever surfaces this MUST say so.
 */
export async function sweepPayout(params: {
  connection: Connection;
  payout: Keypair;
  destination: PublicKey;
}): Promise<{ txSig: string; lamports: number }> {
  const { connection, payout, destination } = params;
  const balance = await connection.getBalance(payout.publicKey, 'confirmed');
  const lamports = balance - PAYOUT_SWEEP_FEE;
  if (lamports <= 0) {
    throw new Error('This payout address is empty — nothing to sweep.');
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payout.publicKey,
      toPubkey: destination,
      lamports,
    }),
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payout.publicKey;
  tx.sign(payout);
  const txSig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(
    { signature: txSig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`Sweep failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return { txSig, lamports };
}

// ---------------------------------------------------------------------------
// Spent resolution for locally stored notes
// ---------------------------------------------------------------------------

export interface ResolveSpentOutcome {
  /** Note keys ("pool:leafIndex") the chain confirms SPENT, now recorded. */
  confirmedSpent: string[];
  /** Notes checked against the chain. */
  checked: number;
  /** Blobs that decrypted under no seed this identity holds. */
  skipped: number;
  /** Notes whose nullifier read failed; their status is unchanged. */
  unresolved: number;
}

/**
 * Ask the chain which of this browser's notes are actually spent, and record
 * the confirmations.
 *
 * Closes the gap `scanPoolLocal` documents: the locally painted list carries
 * `spentKnown: false`, and the full `poolScan` that would reconcile it walks
 * candidate epochs across six denominations first: it does not finish in a
 * time a user waits. This resolves ONLY the notes already known locally, one
 * nullifier-PDA read each, a few seconds total. It catches spends nothing
 * recorded: a subscription made before `recordSubscription` existed, a spend
 * from another device, a wiped session.
 *
 * One-directional on purpose: confirmations are written through
 * `recordSpentNote`, so a note only ever moves from unspent to spent. A note
 * the chain reports unspent is left exactly as it was, because the chain saying "no
 * nullifier yet" must never resurrect a note something else knows is gone.
 *
 * Callers should re-read `knownSpentNoteKeys` afterwards and re-filter.
 */
export async function resolveSpentNotes(
  meta: string,
  walletPubkey: string,
  onProgress?: (step: string) => void,
): Promise<ResolveSpentOutcome> {
  const res = await poolRequest(
    { kind: 'poolResolveSpent', meta, blobs: await loadEncryptedNotes(meta, walletPubkey) },
    onProgress,
  );
  const confirmedSpent = Object.entries(res.spent)
    .filter(([, isSpent]) => isSpent)
    .map(([key]) => key);
  await recordSpentNotes(meta, walletPubkey, confirmedSpent);
  return {
    confirmedSpent,
    checked: res.checked,
    skipped: res.skipped,
    unresolved: res.unresolved,
  };
}

// ---------------------------------------------------------------------------
// License key re-derivation
// ---------------------------------------------------------------------------

/**
 * Re-derive the license key of a subscription paid for by one of this
 * browser's notes. Derived on demand in the worker from the note secret, which
 * is why no store anywhere has to hold it; the same key the subscribe flow
 * showed once. Throws when this browser does not hold the paying note's blob
 * (spent from another device, or storage wiped); the key is then only
 * re-derivable on a device that does.
 *
 * ⛔ The returned key is a bearer credential. Show it, let the user copy it,
 * and never log or persist it.
 */
export async function deriveSubscriptionLicenseKey(params: {
  meta: string;
  walletPubkey: string;
  /** Pool PDA (base58) + leaf index of the note that paid, from the record. */
  pool: string;
  leafIndex: number;
  /** The tag the key is scoped to: registry slug, else retailer address. */
  serviceTag: string;
}): Promise<string> {
  const res = await poolRequest({
    kind: 'poolLicenseKey',
    meta: params.meta,
    blobs: await loadEncryptedNotes(params.meta, params.walletPubkey),
    pool: params.pool,
    leafIndex: params.leafIndex,
    serviceTag: params.serviceTag,
  });
  return res.licenseKey;
}

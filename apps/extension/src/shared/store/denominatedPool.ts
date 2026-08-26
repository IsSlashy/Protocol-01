/**
 * Denominated Pool Store — Extension
 *
 * Zustand store with chrome.storage.local persistence for denominated pool
 * notes (ShieldReceipt[]). Implements shieldNote (C6 shield) and
 * getSpendableNote (lookup for C1 subscribe).
 *
 * Storage adapter pattern mirrors subscriptionVault store.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { PublicKey } from '@solana/web3.js';

import {
  type ShieldReceipt,
  type PoolConfig,
  type PrepareUnshieldV4Result,
  type ShareableNote,
  findPoolV3,
  prepareShieldInsert,
  shieldV3,
  prepareUnshield,
  unshieldDenominatedStarkV3,
  prepareUnshieldV4,
  unshieldDenominatedStarkV4,
  isNullifierSpent,
  V4Unprovable,
  prepareTransfer,
  transferDenominatedStarkV3,
  importNote,
  shareableNoteToReceipt,
} from '../services/denominatedPool';
import {
  decryptNote,
  createNoteEncryptionAddress,
  isEncryptedNoteBlob,
} from '../services/noteCrypto';
import { noteMaturity } from '../services/maturity';

import { useWalletStore } from './wallet';
import { getConnection } from '../services/wallet';
import type { WalletSigner } from '../services/stark';

// ---------------------------------------------------------------------------
// WHICH SPEND CIRCUIT A NOTE CAN USE — decided here, once, for the store and
// for the screen.
// ---------------------------------------------------------------------------

/**
 * Above this, the commitment's third input is a PRF draw. Below it, it is a
 * deposit epoch.
 *
 * MEASURED 2026-08-26: the live epoch is `slot / 7200` = 67,838 — five digits.
 * A blinding from `deriveNoteBlinding` is 63 bits, up to ~9.2e18. A ceiling at
 * 2**32 sits 63,000x above any real epoch, and a PRF draw landing below it has
 * probability 2**-31, about one in 2.1 billion. The two populations do not
 * overlap in practice, and `unshieldRouting.test.ts` states that as arithmetic
 * rather than leaving it as a magic number.
 */
export const LEGACY_BLINDING_CEILING = 2n ** 32n;

/**
 * Why circuit 7 cannot prove this note, or `null` if it can. Pure and
 * synchronous — no RPC, no wallet, no proof — so the screen can ask before the
 * user commits to a 2-3 minute withdrawal, and a test can ask with nothing
 * mocked.
 *
 * 🚨 A PRE-BLINDING NOTE GAINS NOTHING FROM CIRCUIT 7, AND SAYING OTHERWISE IS
 * THE LIE. The commitment is `poseidon(nullifier, poseidon(blinding, token_mint))`
 * (`createCommitmentV3`). Circuit 7 keeps the commitment off the wire, but the
 * NULLIFIER is published by construction — it is the double-spend guard and a
 * PDA seed, it cannot be hidden — and `token_mint` is the pool's, public. So
 * `blinding` is the only unknown, and for a note minted before blinding landed
 * it is the deposit EPOCH: a few thousand candidates rebuild the leaf and reach
 * the deposit. `services/noteBlinding.ts` opens with exactly this attack and
 * the words "Anonymity set: one".
 *
 * The circuit cannot close it. `blinding` is a private witness and
 * `stark/src/air/spend.rs:908-913` forbids constraining it — a boundary
 * assertion, a range check, a bit decomposition or promoting it to a public
 * input all "brick that note with no recovery path". So this is a ROUTING
 * decision, and this is where it belongs.
 *
 * ⛔ IT MUST NOT BLOCK THE NOTE. The caller falls back to the C1 + C3 pair,
 * which publishes the commitment and is honest about it.
 *
 * 🚨 ON THIS SURFACE THIS IS NOT AN EDGE CASE. apps/web has exactly one such
 * note (unspent leaf 30 of the 0.1 SOL pool). Here, `prepareTransfer` in
 * services/denominatedPool.ts still mints the RECIPIENT's note with
 * `slotToEpoch(await connection.getSlot())` — a real epoch, not a blinding — so
 * every note ever received through an extension transfer is pre-blinding and
 * lands on this branch. That is the guard working; it is ALSO the extension
 * still minting leaky notes in 2026-08. Fixing it is a `ShareableNote` wire
 * change (the recipient must be able to recompute the commitment) and belongs
 * in its own session, not here.
 *
 * ⚠️ ASSUMED, NOT MEASURED: that `depositEpoch` is the only signal separating
 * the two populations. There is no per-note "minted with blinding" flag on
 * `ShieldReceipt`, and adding one would not help the notes already in storage —
 * which is the whole population this has to classify.
 *
 * 🚨 KNOWN AND ACCEPTED: THIS CLASSIFIES BY MAGNITUDE, AND ON AN IMPORTED NOTE
 * THE MAGNITUDE IS THE SENDER'S CHOICE. `importNoteAction` →
 * `shareableNoteToReceipt` validates only that the commitment recomputes; it
 * cannot check that `blinding` came out of a PRF, because a blinding is a
 * private witness the sender picked and `stark/src/air/spend.rs:908-913`
 * forbids constraining it. So a sender who wanted to can mint a note whose
 * blinding is low-entropy but sits just ABOVE this ceiling — 2**32 + 1 is
 * admitted to circuit 7, pinned in `unshieldRouting.test.ts` — leaving the leaf
 * recoverable from the published nullifier in ~2**32 Poseidon evaluations while
 * the withdrawal takes the route this screen calls the private one. That is a
 * real hole in the guard's PURPOSE. It is not a hole in its SAFETY, and the
 * distinction is why it is accepted rather than closed:
 *
 *   - The outcome is never worse than the fallback. The pair publishes the
 *     commitment outright, at zero work; the weakened circuit-7 route still
 *     costs ~2**32 hashes. There is no input for which this routes a note
 *     somewhere strictly more linkable than where refusing would put it.
 *   - The party who would exploit it is the sender, who already holds the
 *     strongest possible link: they know the nullifier, which is published by
 *     construction. A weak blinding buys them nothing they do not have. It buys
 *     a THIRD party a 2**32 search — the narrow case this accepts.
 *   - On the natural population the misclassification runs the SAFE way.
 *     `deriveNoteBlinding` is 63 bits, so a draw landing under the ceiling has
 *     probability 2**-31 and goes to the pair, which always works.
 *
 * ⛔ THE LEVER EXISTS AND IS DELIBERATELY NOT PULLED: `SerializedReceipt.source`
 * is already set to 'received' by `importNoteAction` (line 698), so refusing
 * circuit 7 for every imported note would close the case completely and would
 * change NO behaviour today — every received note carries a real epoch and is
 * refused here anyway. It is not pulled because it would foreclose circuit 7 for
 * received notes permanently, including after `prepareTransfer` is fixed to mint
 * PRF blindings, in exchange for a threat whose beneficiary is a third party and
 * whose worst case is the route we would have taken instead. Revisit it in the
 * same session that fixes `prepareTransfer`, where the trade is actually live.
 */
export function whyCircuit7Cannot(receipt: Pick<ShieldReceipt, 'depositEpoch'>): string | null {
  if (receipt.depositEpoch < LEGACY_BLINDING_CEILING) {
    // Wording kept aligned with apps/web (`unshieldEphemeral.ts`), `circuit 7
    // needs at least` included, so a reader diffing the two surfaces sees one
    // design. ⚠️ Nothing here ROUTES on the wording — see `V4Unprovable`.
    return (
      'circuit 7 needs at least a randomised blinding, and this note carries its deposit ' +
      `epoch (${receipt.depositEpoch}) instead — it predates commitment blinding. Proving ` +
      'it on circuit 7 would hide the commitment while leaving the leaf recoverable from ' +
      'the published nullifier by trying a few thousand epochs, which is worse than the ' +
      'C1 + C3 pair only in that it looks private. Falling back to the pair.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serialised ShieldReceipt (bigints → strings for JSON). */
interface SerializedReceipt {
  secret: string;
  nullifierPreimage: string;
  depositEpoch: string;
  tokenMint: string;
  commitment: string;
  leafIndex: number;
  denomination: string;
  pool: string;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt: number;
  merklePathElements?: string[];
  merklePathIndices?: number[];
  merkleRoot?: string;
  source?: 'shielded' | 'received';
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function serializeReceipt(r: ShieldReceipt): SerializedReceipt {
  return {
    secret: r.secret.toString(),
    nullifierPreimage: r.nullifierPreimage.toString(),
    depositEpoch: r.depositEpoch.toString(),
    tokenMint: r.tokenMint.toString(),
    commitment: r.commitment.toString(),
    leafIndex: r.leafIndex,
    denomination: r.denomination.toString(),
    pool: r.pool,
    token: r.token,
    denominationHuman: r.denominationHuman,
    shieldedAt: r.shieldedAt,
    merklePathElements: r.merklePathElements?.map(e => e.toString()),
    merklePathIndices: r.merklePathIndices,
    merkleRoot: r.merkleRoot?.toString(),
    source: r.source,
  };
}

function deserializeReceipt(s: SerializedReceipt): ShieldReceipt {
  return {
    secret: BigInt(s.secret),
    nullifierPreimage: BigInt(s.nullifierPreimage),
    depositEpoch: BigInt(s.depositEpoch),
    tokenMint: BigInt(s.tokenMint),
    commitment: BigInt(s.commitment),
    leafIndex: s.leafIndex,
    denomination: BigInt(s.denomination),
    pool: s.pool,
    token: s.token,
    denominationHuman: s.denominationHuman,
    shieldedAt: s.shieldedAt,
    merklePathElements: s.merklePathElements?.map(BigInt),
    merklePathIndices: s.merklePathIndices,
    merkleRoot: s.merkleRoot !== undefined ? BigInt(s.merkleRoot) : undefined,
    source: s.source,
  };
}

// ---------------------------------------------------------------------------
// Store state / actions
// ---------------------------------------------------------------------------

interface DenominatedPoolState {
  /** Stored notes (serialised for JSON persistence). */
  serializedNotes: SerializedReceipt[];
  /** Per-pool note counter: poolPDA (base58) -> next counter. */
  counterByPool: Record<string, number>;
  loading: boolean;
  error: string | null;

  // Computed
  getNotes: () => ShieldReceipt[];
  getSpendableNote: (token: 'SOL' | 'USDC', denomination: number) => ShieldReceipt | null;

  // Actions
  addNote: (receipt: ShieldReceipt) => void;
  /** Drop a note from the local picker by its commitment string (e.g. once it
   * has been spent by a subscription, or detected spent on-chain). */
  removeNote: (noteId: string) => void;
  shieldNote: (params: {
    token: 'SOL' | 'USDC';
    denomination: number;
    onProgress?: (step: string) => void;
  }) => Promise<{ txSig: string; receipt: ShieldReceipt }>;
  unshieldNote: (params: {
    noteId: string; // commitment.toString() — uniquely identifies the note
    /**
     * Solana address. Defaults to the wallet — and the wallet is then REFUSED.
     * The default is kept so that leaving the field blank and typing your own
     * address get the same answer instead of two different ones.
     */
    recipient?: string;
    // Accepted for call-site compatibility but INERT: min_epoch is always 0
    // (UNSHIELD_MIN_EPOCH) and the V3 handler ignores it. Both modes produce a
    // byte-identical instruction. It reaches the v3 leg only — v4 HAS NO
    // min_epoch FIELD AT ALL (see buildUnshieldDenominatedStarkV4Ix), so on the
    // circuit-7 route the argument cannot even be set wrong.
    emergency?: boolean;
    onProgress?: (step: string) => void;
    /** Returns which circuit actually ran. A caller that cannot tell cannot
     *  tell the user the truth: on `v3` the commitment was republished. */
  }) => Promise<{ txSig: string; version: 'v3' | 'v4' }>;
  /**
   * Private note-to-note transfer (C1+C3+C6). Spends a mature note and mints a
   * fresh note for the recipient, returned as a post-quantum ENCRYPTED blob
   * addressed to `recipientAddress` (p01pq:…). Only the recipient's wallet seed
   * can decrypt it, so the blob is safe to intercept. The note must be MATURE
   * (the on-chain handler enforces it).
   */
  transferNote: (params: {
    noteId: string; // commitment.toString() of the note to spend
    recipientAddress: string; // recipient's p01pq:… note address
    onProgress?: (step: string) => void;
  }) => Promise<{ txSig: string; encryptedNote: string }>;
  /** Import a received note (plaintext or p01enc1 encrypted) into the note set. */
  importNoteAction: (params: {
    encoded: string;
    source?: 'received';
  }) => Promise<ShieldReceipt>;
  /** Decode a received note for preview (decrypts p01enc1 blobs with the seed). */
  peekNote: (encoded: string) => ShareableNote;
  /** This wallet's public p01pq:… address — share it to receive private notes. */
  getMyNoteAddress: () => string;
  reset: () => void;
  setError: (error: string | null) => void;
}

// ⛔ `_preparedUnshield` WAS DELETED HERE ON 2026-08-26. DO NOT RESTORE IT
// WITHOUT A READER. It was written in three places and read in NONE (grep finds
// writes only), while its doc comment claimed it "avoids re-generating proofs
// on retry" — which nothing did, because nothing looked at it. Circuit 7 would
// have forced it to become a `{ version: 'v3' | 'v4'; ctx }` union just to stay
// type-correct: real work to keep a cache no code consumes. A dead field that
// documents a behaviour the code does not have is worse than no field.

// ---------------------------------------------------------------------------
// WalletSigner factory (same pattern as subscriptionVault)
// ---------------------------------------------------------------------------

function createWalletSigner(): { signer: WalletSigner; connection: ReturnType<typeof getConnection> } {
  const walletState = useWalletStore.getState();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  if (!keypair) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const signer: WalletSigner = {
    publicKey: walletPublicKey,
    signTransaction: async (tx) => {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
      if (!tx.feePayer) tx.feePayer = walletPublicKey;
      tx.sign(keypair);
      return tx;
    },
  };

  return { signer, connection };
}

/**
 * Derive walletSeed from the current wallet store.
 * Uses _keypair.secretKey.slice(0,32) (mirrors mobile
 * denominatedPoolStore.ts:841). The local keypair is the only key source post
 * Privy-removal — throws if the wallet is locked.
 */
function getWalletSeed(): Uint8Array {
  const walletState = useWalletStore.getState();
  const keypair = walletState._keypair;
  if (!keypair) {
    throw new Error(
      'Cannot derive wallet seed: wallet is locked. Unlock and try again.',
    );
  }
  return keypair.secretKey.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDenominatedPoolStore = create<DenominatedPoolState>()(
  persist(
    (set, get) => ({
      serializedNotes: [],
      counterByPool: {},
      loading: false,
      error: null,

      getNotes: () => get().serializedNotes.map(deserializeReceipt),

      getSpendableNote: (token, denomination) => {
        const pool = findPoolV3(token, denomination);
        if (!pool) return null;
        const poolAddr = pool.poolPDA.toBase58();
        const notes = get().serializedNotes
          .map(deserializeReceipt)
          .filter(n => n.pool === poolAddr);
        return notes[0] ?? null;
      },

      addNote: (receipt) => {
        set((state) => ({
          serializedNotes: [...state.serializedNotes, serializeReceipt(receipt)],
        }));
      },

      removeNote: (noteId) => {
        set((state) => ({
          serializedNotes: state.serializedNotes.filter((n) => n.commitment !== noteId),
        }));
      },

      shieldNote: async ({ token, denomination, onProgress }) => {
        const pool: PoolConfig | undefined = findPoolV3(token, denomination);
        if (!pool) {
          throw new Error(`No V3 pool found for ${token} ${denomination}`);
        }

        set({ loading: true, error: null });

        try {
          const { signer, connection } = createWalletSigner();
          const walletSeed = getWalletSeed();

          const poolAddr = pool.poolPDA.toBase58();
          const counter = get().counterByPool[poolAddr] ?? 0;

          // Prepare (derive note, compute path, generate C6 proof).
          const { c6ProofResult, insertParams } = await prepareShieldInsert(
            pool,
            connection,
            walletSeed,
            counter,
            onProgress,
          );

          // Shield on-chain.
          const { txSig, receipt } = await shieldV3(
            pool,
            c6ProofResult,
            insertParams,
            signer,
            connection,
            onProgress,
          );

          // Persist note + advance counter.
          set((state) => ({
            serializedNotes: [...state.serializedNotes, serializeReceipt(receipt)],
            counterByPool: {
              ...state.counterByPool,
              [poolAddr]: counter + 1,
            },
            loading: false,
          }));

          return { txSig, receipt };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ loading: false, error: msg });
          throw err;
        }
      },

      unshieldNote: async ({ noteId, recipient, emergency = false, onProgress }) => {
        const notes = get().getNotes();
        const receipt = notes.find((n) => n.commitment.toString() === noteId);
        if (!receipt) {
          throw new Error(`Note ${noteId} not found in store`);
        }

        const { signer, connection } = createWalletSigner();

        // Resolve the payee. Circuit 7 binds sha256(recipient) into four of its
        // six public inputs, so the proof does not exist without it — but on
        // this surface that costs no plumbing: this block already ran twenty
        // lines above the prepare before circuit 7 was wired in. (The web twin
        // had to MOVE it: a C1 + C3 proof names no payee, so v3 there only
        // learns one at execute.)
        //
        // ⛔ THE TWO `await import('@solana/web3.js')` CALLS THIS BLOCK USED TO
        // MAKE ARE GONE, AND THAT IS NOT TIDYING. `PublicKey` is imported
        // statically at the top of this file, so they resolved the same module
        // and bought nothing — while costing the one thing that matters here:
        // they were `await`s sitting ABOVE the refusal below. A guard under an
        // await cannot be reached without a live connection, which is exactly
        // the property the guard tests lean on when they hand this store a
        // connection object with no methods on it.
        let recipientPubkey: PublicKey;
        if (recipient) {
          recipientPubkey = new PublicKey(recipient);
        } else {
          const walletState = useWalletStore.getState();
          if (!walletState.publicKey) throw new Error('Wallet not unlocked');
          recipientPubkey = new PublicKey(walletState.publicKey);
        }

        const poolConfig: PoolConfig | undefined = findPoolV3(receipt.token, receipt.denominationHuman);
        if (!poolConfig) {
          throw new Error(`Pool not found for note: ${receipt.token} ${receipt.denominationHuman}`);
        }

        set({ loading: true, error: null });
        try {
          // ── REFUSAL: THE PAYEE IS THE FUNDER ────────────────────────────
          //
          // Paying the note's full value back to the wallet that pays for the
          // withdrawal lands the money at the address that made the deposit.
          // Refused before anything is proved, because the payee is known here
          // and proving costs 2-3 minutes and a real upload.
          //
          // 🚨 BE HONEST ABOUT WHAT THIS DOES NOT DO, because the web twin's
          // version of this comment does not transfer. On apps/web an EPHEMERAL
          // signs the withdrawal, so the wallet appears only in the pre-fund and
          // the payee is the one remaining thing that would name it — refusing
          // there is decisive. THIS SURFACE HAS NO EPHEMERAL ON THIS PATH:
          // `createWalletSigner` hands the same wallet to
          // `submitAndVerifyStarkProof` as the proof-buffer authority AND to the
          // instruction builder as the unshield payer, so the depositor's wallet
          // signs the withdrawal whatever the payee is. This refusal moves where
          // the money lands; it does not remove the wallet from the transaction,
          // and no copy on the screen may say it does. Landing the value
          // elsewhere is still worth it — it stops the deposit↔withdrawal
          // round-trip by BALANCE — but it is a partial measure, and the message
          // below says so rather than implying a property the tree has measured
          // to be false ("v4 seul = FAUX VERT", 2026-08-16).
          //
          // ⛔ WHY THERE IS NO DERIVED PAYOUT ADDRESS HERE, unlike apps/web.
          // `shieldClient.ts:1833` gives every web caller a
          // `derivePoolPayoutKeypair(pool, leafIndex)`, and it would be EASIER
          // here (`getWalletSeed()` already exists, so no signature prompt). It
          // is deliberately not ported: `grep -rn "payout" src/` returns two
          // unrelated comments in tests — this package has no payout store, no
          // payout list and no sweep for such an address. Deriving one would put
          // the note's whole value at an address with NO SPEND PATH IN THIS
          // CLIENT, which is how this repository has already stranded funds
          // once. The refusal is actionable without it: "Send to" is a text
          // field on the same screen, and the fix is to fill it in.
          if (recipientPubkey.equals(signer.publicKey)) {
            throw new Error(
              'Refusing to withdraw to the wallet that pays for this withdrawal. It would ' +
                "land the note's full value back at the address that deposited it, which " +
                're-links the two by balance even when circuit 7 keeps the commitment off ' +
                'the wire. Enter a different address in "Send to".\n\n' +
                'It does NOT make this withdrawal anonymous: on this client your own wallet ' +
                'signs the transaction and rents the proof buffer, so it is on-chain either ' +
                'way.',
            );
          }

          // ── PRE-FLIGHT: IS THE NOTE ALREADY SPENT? ──────────────────────
          //
          // One `getAccountInfo` against the nullifier PDA, no proof. On BOTH
          // routes, not just circuit 7 — this was missing entirely before, and a
          // double-spend attempt therefore cost ~2 SOL of buffer rent and 2-3
          // minutes of proving to learn what the on-chain guard would have said
          // for free. `transferNote` in this same store has carried its balance
          // and maturity pre-flights for exactly this reason; the withdrawal had
          // neither.
          onProgress?.('Checking the note is unspent...');
          const spent = await isNullifierSpent(
            connection,
            poolConfig.poolPDA,
            receipt.nullifierPreimage,
            receipt.secret,
          );
          if (spent) {
            throw new Error('This note has already been withdrawn.');
          }

          // ── ROUTE: CIRCUIT 7, OR THE C1 + C3 PAIR ───────────────────────
          //
          // THE ROUTE IS PER NOTE, NOT A MIGRATION. `unshield_denominated_stark_v3`
          // stays reachable indefinitely: a note whose blinding is unknown can
          // be spent nowhere else, and `prepareUnshieldV4` has no stored-path
          // fast path, so a note whose root aged out of the pool's 100-root ring
          // still needs the v3 rebuild. Neither leg is legacy.
          let preparedV4: PrepareUnshieldV4Result | null = null;
          // Asked synchronously first, so a pre-blinding note never enters the
          // try below and can never be mistaken for a prover failure.
          let v4Refusal: string | null = whyCircuit7Cannot(receipt);
          if (v4Refusal === null) {
            try {
              onProgress?.('Preparing the circuit-7 spend proof...');
              preparedV4 = await prepareUnshieldV4(
                receipt,
                recipientPubkey,
                poolConfig,
                connection,
                onProgress,
              );
            } catch (err: unknown) {
              // ⛔ AN ALLOW-LIST, AND THAT IS THE WHOLE SAFETY PROPERTY. Only
              // `V4Unprovable` — "this NOTE cannot go through this circuit" —
              // routes to the pair. A wrong felt count or a transcript bound to
              // the wrong payee is a broken PROVER, and answering that by
              // republishing the commitment and reporting success is the exact
              // failure the pair exists to remove. Anything else fails closed.
              //
              // Routed on the TYPE, not on a string. The web twin matches
              // `msg.includes('circuit 7 needs at least')` because its error
              // crosses a worker `postMessage` boundary that strips the
              // prototype; this store imports the service and calls it in the
              // same realm, so `instanceof` survives and cannot be broken by
              // rewording a message.
              if (!(err instanceof V4Unprovable)) throw err;
              v4Refusal = err.message;
            }
          }
          if (v4Refusal !== null) {
            console.warn(
              '[DenomPool/ext] circuit 7 could not prove this note; falling back to the ' +
                'C1 + C3 pair, which publishes the note commitment:',
              v4Refusal,
            );
            // The user is TOLD the withdrawal became the linkable kind. A silent
            // downgrade is the failure mode this whole change exists to avoid.
            onProgress?.('Circuit 7 cannot prove this note — falling back to the C1 + C3 pair...');
          }

          // ⛔ NOTHING BELOW THIS LINE MAY FALL BACK, AND THE STRUCTURE IS THE
          // GUARANTEE — the catch above wraps the PREPARE only. Once
          // `unshieldDenominatedStarkV4` has uploaded a proof and initialised
          // the nullifier PDA, a retry on v3 would pay the buffer rent twice and
          // then die on the double-spend guard, having already spent the note.
          let txSig: string;
          let version: 'v3' | 'v4';
          if (preparedV4) {
            // ONE proof buffer instead of two, and no `stark_commitment` on the
            // wire. `emergency` does not appear: v4 has no min_epoch field.
            txSig = await unshieldDenominatedStarkV4(
              poolConfig,
              recipientPubkey,
              preparedV4,
              signer,
              connection,
              onProgress,
            );
            version = 'v4';
          } else {
            // Byte for byte what this store did before circuit 7 existed.
            onProgress?.('Preparing unshield proofs...');
            const prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);
            txSig = await unshieldDenominatedStarkV3(
              receipt,
              poolConfig,
              recipientPubkey,
              prepared,
              signer,
              connection,
              onProgress,
              emergency,
            );
            version = 'v3';
          }

          // Remove spent note from store.
          set((state) => ({
            serializedNotes: state.serializedNotes.filter(
              (n) => n.commitment !== noteId,
            ),
            loading: false,
          }));

          return { txSig, version };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ loading: false, error: msg });
          throw err;
        }
      },

      transferNote: async ({ noteId, recipientAddress, onProgress }) => {
        const notes = get().getNotes();
        const receipt = notes.find((n) => n.commitment.toString() === noteId);
        if (!receipt) {
          throw new Error(`Note ${noteId} not found in store`);
        }

        const poolConfig: PoolConfig | undefined = findPoolV3(receipt.token, receipt.denominationHuman);
        if (!poolConfig) {
          throw new Error(`Pool not found for note: ${receipt.token} ${receipt.denominationHuman}`);
        }

        const { signer, connection } = createWalletSigner();

        set({ loading: true, error: null });
        try {
          // Fast pre-flight BEFORE the ~2-3 min of proving: the transfer funds an
          // ephemeral signer with ~2.7 SOL (3 STARK proof buffers held open at
          // once, ~0.9 SOL rent each, all swept back after). Gate on the full
          // 3-buffer estimate so we never prove then fail to fund the ephemeral.
          onProgress?.('Checking wallet balance...');
          const balance = await connection.getBalance(signer.publicKey);
          const perBuffer = await connection.getMinimumBalanceForRentExemption(83 + 135_000);
          const estRequired = perBuffer * 3 + 10_000_000; // 3 buffers + nullifier + fees + margin
          if (balance < estRequired) {
            throw new Error(
              `Insufficient SOL for transfer. It needs ~${(estRequired / 1e9).toFixed(2)} SOL ` +
              `of temporary proof-buffer rent (3 STARK proofs, fully recovered after the tx), but ` +
              `the wallet has only ${(balance / 1e9).toFixed(3)} SOL. Fund the wallet (devnet: ` +
              `request an airdrop) and try again.`,
            );
          }

          // Maturity pre-flight: transfer ENFORCES current_epoch >= deposit_epoch +
          // dynamic_delay on-chain (unlike unshield). Fail BEFORE the ~2-3 min of
          // proving + buffer-rent churn instead of dying on EpochDelayNotMet (6023).
          // Same logic as the live countdown the user sees (shared noteMaturity).
          onProgress?.('Checking note maturity...');
          const slot = await connection.getSlot('confirmed');
          const mat = noteMaturity(receipt.depositEpoch, { slot, at: Date.now() }, Date.now());
          if (!mat.ready) {
            throw new Error(
              `Note is not mature enough to transfer yet (${mat.label}). ` +
              `Wait for it to mature, then transfer.`,
            );
          }

          // Prepare: C1+C3 over the old note + fresh-secret C6 for the new note.
          onProgress?.('Preparing transfer proofs...');
          const prepared = await prepareTransfer(receipt, poolConfig, connection, onProgress);

          // Submit C1+C3+C6, send transfer ix; the service encrypts the output
          // note to recipientAddress (post-quantum hybrid).
          const { txSig, encryptedNote } = await transferDenominatedStarkV3(
            receipt,
            poolConfig,
            prepared,
            signer,
            connection,
            recipientAddress,
            onProgress,
          );

          // The old note is spent (nullified on-chain) — drop it from the picker.
          set((state) => ({
            serializedNotes: state.serializedNotes.filter((n) => n.commitment !== noteId),
            loading: false,
          }));

          return { txSig, encryptedNote };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ loading: false, error: msg });
          throw err;
        }
      },

      peekNote: (encoded) => {
        const trimmed = encoded.trim();
        if (isEncryptedNoteBlob(trimmed)) {
          const plaintext = decryptNote(getWalletSeed(), trimmed);
          return JSON.parse(new TextDecoder().decode(plaintext)) as ShareableNote;
        }
        // Plaintext fallback (legacy / cross-client).
        return JSON.parse(atob(trimmed)) as ShareableNote;
      },

      getMyNoteAddress: () => createNoteEncryptionAddress(getWalletSeed()),

      importNoteAction: async ({ encoded, source = 'received' }) => {
        const trimmed = encoded.trim();
        let receipt: ShieldReceipt;
        if (isEncryptedNoteBlob(trimmed)) {
          // Decrypt with this wallet's seed, then validate + reconstruct.
          const plaintext = decryptNote(getWalletSeed(), trimmed);
          const note = JSON.parse(new TextDecoder().decode(plaintext)) as ShareableNote;
          receipt = shareableNoteToReceipt(note);
        } else {
          receipt = importNote(trimmed);
        }
        receipt.source = source;

        const exists = get().serializedNotes.some(
          (n) => n.commitment === receipt.commitment.toString(),
        );
        if (exists) {
          throw new Error('This note is already in your wallet.');
        }

        set((state) => ({
          serializedNotes: [...state.serializedNotes, serializeReceipt(receipt)],
        }));

        return receipt;
      },

      reset: () => set({ serializedNotes: [], counterByPool: {}, loading: false, error: null }),

      setError: (error) => set({ error }),
    }),
    {
      name: 'p01-denominated-pool',
      storage: createJSONStorage(() => ({
        getItem: async (name: string) => {
          const result = await chrome.storage.local.get(name);
          return result[name] || null;
        },
        setItem: async (name: string, value: string) => {
          await chrome.storage.local.set({ [name]: value });
        },
        removeItem: async (name: string) => {
          await chrome.storage.local.remove(name);
        },
      })),
      partialize: (state) => ({
        serializedNotes: state.serializedNotes,
        counterByPool: state.counterByPool,
      }),
    },
  ),
);

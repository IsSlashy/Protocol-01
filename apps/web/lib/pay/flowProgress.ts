/**
 * Deterministic progress for the pool flows.
 *
 * WHY THIS EXISTS. A shield, a withdrawal or a subscription runs for minutes:
 * ~162 chunk transactions, one or two STARK proofs at ~60 s each, and a Merkle
 * rebuild from event history. The UI used to show a single sentence that did
 * not move, so nothing on screen distinguished "working" from "stuck". That is
 * not a hypothetical, it fooled the people building it, measured 2026-08-04.
 *
 * Nothing here is invented. The worker already emits every step by name through
 * `onProgress`, and the upload step carries `i/N` with N known before it starts,
 * so the longest phase reports REAL progress rather than an animation.
 *
 * The weights come from the durations actually observed on devnet on
 * 2026-08-04, not from guesses. They are deliberately coarse: their job is to
 * stop the bar from lying about which half you are in, not to predict seconds.
 */

export interface FlowPhase {
  id: string;
  /** Shown to the user. Plain language: no "nullifier", no "leaf", no "buffer". */
  label: string;
  /** Share of the whole flow, 0..1. The phases of a flow sum to 1. */
  weight: number;
  /** Matches the worker's step strings. First match in order wins. */
  match: RegExp;
}

/** `Uploading proof chunk 12/162...` → { done: 12, total: 162 }. */
export function parseChunk(step: string | null): { done: number; total: number } | null {
  if (!step) return null;
  const m = /chunk\s+(\d+)\s*\/\s*(\d+)/i.exec(step);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? { done, total } : null;
}

/**
 * `Resizing proof buffer (5/6)...` → { done: 5, total: 6 }. Same idea as chunks:
 * the step already carries its own progress, so use it instead of freezing.
 */
export function parseResize(step: string | null): { done: number; total: number } | null {
  if (!step) return null;
  const m = /resiz\w*[^(]*\((\d+)\s*\/\s*(\d+)\)/i.exec(step);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? { done, total } : null;
}

// ---------------------------------------------------------------------------
// The flows
//
// Labels answer "what is happening to my money", not "which subroutine is
// running". `Generating C1 (pool_commitment) STARK proof` becomes "Proving you
// own the note", the same event, in the user's vocabulary.
// ---------------------------------------------------------------------------

export const SHIELD_PHASES: FlowPhase[] = [
  { id: 'price', label: 'Working out the cost', weight: 0.05, match: /pricing|looking for funds left/i },
  { id: 'derive', label: 'Creating your note', weight: 0.05, match: /deriving note|building v3 shield|reading on-chain tree|computing merkle path/i },
  // ⚠️ `generating …stark proof`, NOT a bare `stark proof`.
  //
  // `progressFor` takes the FIRST phase whose regex matches, and this phase sits
  // at index 2 while verification sits at index 5. A bare `/stark proof/i`
  // therefore swallowed "Verifying STARK proof phase 2 (DEEP-ALI)..." and
  // reported it as proving — a LOWER percent than the floor already reached, so
  // the monotonic guard discarded it and the bar sat frozen while the raw
  // sentence underneath kept moving. Every verification string must fall
  // through to the phase that actually names it.
  { id: 'prove', label: 'Proving the deposit', weight: 0.25, match: /generating c6|generating the deposit proof|generating[^.]*stark proof/i },
  { id: 'buffer', label: 'Reserving space on Solana', weight: 0.05, match: /initializ|resiz/i },
  // 0.50, not 0.45: the shield's phases summed to 0.95, so a shield could never
  // report more than 95% and jumped from there to done. Caught by the sum
  // assertion in the label test, never by looking at it. The missing weight goes
  // to the upload because it is the longest phase by far — ~150 chunk
  // transactions against everything else's seconds.
  { id: 'upload', label: 'Uploading the proof', weight: 0.5, match: /uploading|confirming chunk|resending|readback|checking uploaded/i },
  { id: 'verify', label: 'Solana is checking the proof', weight: 0.1, match: /verif|closing|submitting c6|sending v3 shield|v3 shield confirmed/i },
];

// ⚠️ THE FIFTH MISS, AND THE ONE THAT WOULD HAVE GONE ON STAGE.
//
// Circuit 7 replaced the C1 + C3 proof pair with a single trace, and the web
// client's v4 spend speaks a new vocabulary for it: "one trace" instead of
// "c1"/"c3", "circuit-7", and V4 rather than V3. Every regex below knew only
// the old words. `91207b23` added the six sentences to `denominatedPool.ts` and
// did not touch this file, so `progressFor` returned `{ index: -1 }` for all
// six — and an unmatched sentence leaves the previous label standing.
//
// The practical effect: on the v4 path, which is the whole point of C7, the bar
// went silent from the moment proving started, through the upload, through the
// submit, through confirmation. Every second the user most needs to be told
// something is happening. That is the same failure this file has now recorded
// four times above; the seam it describes caught it a fifth time.
//
// The three v3 spellings stay. v3 remains registered on-chain and notes whose
// blinding is unknown can only be spent there, so both vocabularies are live.
export const WITHDRAW_PHASES: FlowPhase[] = [
  { id: 'locate', label: 'Finding your note', weight: 0.12, match: /locating|matching notes|scanning the|reading spent markers|pool for older notes|looking for funds left|fetching pool leaves|scanning events|root not in ring/i },
  { id: 'path', label: 'Rebuilding its history', weight: 0.08, match: /merkle|pre-flight root|stored merkle root|checking the note/i },
  // `proving ownership and membership in one trace` is C7's single-proof
  // sentence, and it is also the heartbeat: the same words come back every ten
  // seconds carrying an elapsed count, so the regex must match on the words and
  // never on the number.
  { id: 'prove', label: 'Proving you own it', weight: 0.3, match: /generating c1|generating c3|proving you own the note|proving the note is in the pool|proving ownership and membership in one trace|generating[^.]*stark proof/i },
  { id: 'buffer', label: 'Reserving space on Solana', weight: 0.05, match: /initializ|resiz|pricing/i },
  // `submitting the circuit-7 spend proof on-chain` announces the upload rather
  // than the verification: it is emitted immediately before
  // `submitAndVerifyStarkProof`, whose own per-chunk sentences land here too.
  { id: 'upload', label: 'Uploading the proof', weight: 0.35, match: /uploading|confirming chunk|resending|readback|checking uploaded|submitting the circuit-7 spend proof/i },
  { id: 'verify', label: 'Solana is checking the proof', weight: 0.1, match: /verif|building v3 unshield|sending v3 unshield|v3 unshield confirmed|building v4 unshield|sending v4 unshield|v4 unshield confirmed|submitting c1|closing/i },
];

export const SUBSCRIBE_PHASES: FlowPhase[] = [
  // Only on the path where the buyer holds nothing and the deployment issues
  // them a note. Short — ~2.4s measured — but it is the FIRST thing that
  // happens, and both of its sentences (`shieldClient.ts:790` and `:824`) used
  // to match nothing at all. An unmatched sentence leaves the previous label
  // standing, and there is no previous label at the start of a run, so the
  // screen read "Starting · 0%" through the whole thing. That is the frozen bar
  // reported all evening, and it was never the worker being stuck.
  //
  // It gets its own label rather than being folded into `locate`, because
  // "Finding your note" would be a lie: there is no note yet, one is being
  // bought.
  { id: 'issue', label: 'Getting you a note', weight: 0.03, match: /asking for a note|opening the note/i },
  // `still looking` and `checking notes you already hold` are the worker's
  // heartbeat and its blob-first probe. They were added to `locateOwnedNote`
  // without being added here, so a run that was working fine sat on "Starting"
  // at 5% for minutes — the phase table is the only thing that turns a worker
  // sentence into a label, and an unmatched sentence leaves the previous one
  // standing. Before any phase has matched, that previous one is nothing.
  { id: 'locate', label: 'Finding your note', weight: 0.1, match: /locating|matching notes|still looking|checking notes you already hold|scanning the|reading spent markers|pool for older notes|looking for funds left|fetching pool leaves|scanning events|root not in ring/i },
  { id: 'path', label: 'Rebuilding its history', weight: 0.07, match: /merkle|pre-flight root|checking the note|checking who (?:deposited|paid|pays)|subscriber commitment/i },
  { id: 'prove', label: 'Proving you own it', weight: 0.28, match: /generating c1|generating c3|proving you own the note|proving the note is in the pool|generating[^.]*stark proof/i },
  { id: 'buffer', label: 'Reserving space on Solana', weight: 0.05, match: /initializ|resiz|pricing/i },
  { id: 'upload', label: 'Uploading the proofs', weight: 0.37, match: /uploading|confirming chunk|resending|readback|checking uploaded/i },
  { id: 'open', label: 'Opening your subscription', weight: 0.1, match: /verif|opening the subscription|closing/i },
];

export interface FlowProgressState {
  /** 0..100, monotonic within a run. */
  percent: number;
  /** Index into the phase list, -1 before anything matches. */
  index: number;
  /** The phase currently running, if any. */
  current: FlowPhase | null;
  /** Sub-progress inside the current phase, when the step carries it. */
  detail: { done: number; total: number } | null;
}

/**
 * Map a worker step onto a phase and a percentage.
 *
 * 🚨 A step that matches NOTHING must not reset the bar. Unknown steps keep the
 * previous position: an unrecognised sentence is a gap in this table, and the
 * user should never be told they went backwards because of it. Pass the last
 * known percent as `floor`.
 */
export function progressFor(
  phases: FlowPhase[],
  step: string | null,
  floor = 0,
): FlowProgressState {
  if (!step) return { percent: floor, index: -1, current: null, detail: null };

  const index = phases.findIndex((p) => p.match.test(step));
  if (index < 0) return { percent: floor, index: -1, current: null, detail: null };

  const before = phases.slice(0, index).reduce((n, p) => n + p.weight, 0);
  const phase = phases[index]!;
  const detail = parseChunk(step) ?? parseResize(step);
  // Inside a phase that reports its own progress, follow it. Otherwise sit at
  // its midpoint: claiming a phase is 90% done when nothing measured that would
  // be the same lie in a smaller font.
  const within = detail ? detail.done / detail.total : 0.5;
  const percent = (before + phase.weight * within) * 100;

  return { percent: Math.max(floor, Math.min(99, percent)), index, current: phase, detail };
}

// ---------------------------------------------------------------------------
// Send-tab flows. Appended for SendForm; nothing above this line moves.
// ---------------------------------------------------------------------------

/**
 * Sealing a note for handoff. No transaction and no proof: the worker finds
 * the note on chain, packs the Merkle path the recipient will withdraw with,
 * and encrypts the note's secrets to the recipient's address. The weight sits
 * on the lookup because that is the RPC history walk; the cryptography at the
 * end is near-instant. Steps come from `handlePoolExportNote` and
 * `locateOwnedNote` in `worker/poolHandlers.ts`.
 */
export const SEAL_PHASES: FlowPhase[] = [
  { id: 'locate', label: 'Finding your note in the pool', weight: 0.7, match: /locating|reading pool history|matching notes|scanning the|reading spent markers|pool for older notes|still looking|checking notes you already hold/i },
  { id: 'path', label: 'Packing its withdrawal path', weight: 0.15, match: /merkle/i },
  { id: 'seal', label: 'Sealing it to the recipient', weight: 0.15, match: /sealing the note/i },
];

/**
 * The stealth send has no worker step stream: `adapter.send` is one opaque
 * call that builds the transfer, opens the wallet for approval and submits.
 * The page cannot observe those boundaries, so this table refuses to invent
 * them: one phase, driven by the single step the form synthesizes itself.
 * Listing sub-steps nothing measures would be exactly the moving-anyway
 * animation the header of this file exists to prevent.
 */
export const STEALTH_SEND_PHASES: FlowPhase[] = [
  { id: 'wallet', label: 'Approve in your wallet; Solana sends', weight: 1, match: /one-time address|approve/i },
];

/**
 * Importing a received note (the Receive tab). Everything is local
 * cryptography except one nullifier read that answers "is this note still
 * unspent", so that read carries the weight: on a slow devnet RPC it is the
 * only part of the flow a user can actually wait on. Steps come from
 * `handlePoolImportNote` in `worker/poolHandlers.ts`.
 */
export const RECEIVE_NOTE_PHASES: FlowPhase[] = [
  { id: 'open', label: 'Opening the sealed note', weight: 0.2, match: /opening the sealed note/i },
  { id: 'check', label: 'Checking it is still unspent', weight: 0.6, match: /checking the note against the chain/i },
  { id: 'file', label: 'Filing it with your notes', weight: 0.2, match: /filing it with your notes/i },
];

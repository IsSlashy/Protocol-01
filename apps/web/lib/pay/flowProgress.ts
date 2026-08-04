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
  { id: 'price', label: 'Working out the cost', weight: 0.05, match: /pricing/i },
  { id: 'derive', label: 'Creating your note', weight: 0.05, match: /deriving note|building v3 shield/i },
  { id: 'prove', label: 'Proving the deposit', weight: 0.25, match: /generating c6|stark proof/i },
  { id: 'buffer', label: 'Reserving space on Solana', weight: 0.05, match: /initializ|resiz/i },
  { id: 'upload', label: 'Uploading the proof', weight: 0.45, match: /uploading|confirming chunk/i },
  { id: 'verify', label: 'Solana is checking the proof', weight: 0.1, match: /verif|closing/i },
];

export const WITHDRAW_PHASES: FlowPhase[] = [
  { id: 'locate', label: 'Finding your note', weight: 0.12, match: /locating|fetching pool leaves|matching notes|reading on-chain tree/i },
  { id: 'path', label: 'Rebuilding its history', weight: 0.08, match: /merkle|pre-flight root|stored merkle root|checking the note/i },
  { id: 'prove', label: 'Proving you own it', weight: 0.3, match: /generating c1|generating c3|stark proof/i },
  { id: 'buffer', label: 'Reserving space on Solana', weight: 0.05, match: /initializ|resiz|pricing/i },
  { id: 'upload', label: 'Uploading the proof', weight: 0.35, match: /uploading|confirming chunk/i },
  { id: 'verify', label: 'Solana is checking the proof', weight: 0.1, match: /verif|building v3 unshield|closing/i },
];

export const SUBSCRIBE_PHASES: FlowPhase[] = [
  { id: 'locate', label: 'Finding your note', weight: 0.1, match: /locating|fetching pool leaves|matching notes|reading on-chain tree/i },
  { id: 'path', label: 'Rebuilding its history', weight: 0.07, match: /merkle|pre-flight root|checking the note|subscriber commitment/i },
  { id: 'prove', label: 'Proving you own it', weight: 0.28, match: /generating c1|generating c3|stark proof/i },
  { id: 'buffer', label: 'Reserving space on Solana', weight: 0.05, match: /initializ|resiz|pricing/i },
  { id: 'upload', label: 'Uploading the proofs', weight: 0.4, match: /uploading|confirming chunk/i },
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

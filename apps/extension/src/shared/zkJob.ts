/**
 * ZK job state — shared between the offscreen runner (writer) and the popup
 * (reader/poller).
 *
 * Long-running ZK flows (subscribe ≈ 2 min: C0/C1 proof → chunk upload → verify
 * → subscribe_private_stark → close buffer) cannot run in the popup: Chrome
 * destroys the popup the moment it loses focus, killing the JS context. So the
 * work runs in an OFFSCREEN DOCUMENT (spawned by the background service worker),
 * which survives popup close. The two contexts coordinate purely through
 * `chrome.storage.local`:
 *
 *   - Offscreen runner: `writeJobState` / `patchJobState` as it progresses.
 *   - Popup: `readJobState` on mount + `subscribeJobState` (storage.onChanged)
 *     to render live progress, then the success panel from `result`.
 *
 * State is keyed by `jobId`; `ACTIVE_KEY` points at the most recent job so the
 * popup can re-attach to an in-flight job after being reopened.
 */

export type ZkJobKind = 'subscribe';

export type ZkJobPhase =
  | 'queued'       // accepted by the SW, offscreen not yet started
  | 'proving'      // generating STARK proof(s) in the worker
  | 'submitting'   // uploading proof chunks + verifying on-chain
  | 'finalizing'   // sending the subscribe ix + closing the proof buffer
  | 'done'
  | 'error';

export interface ZkJobResult {
  signature?: string;
  vault?: string;
  /** base58 retailer the subscription pays. */
  retailer?: string;
  mode?: 'standard' | 'zk';
  /** Anonymous merchant license key minted on success. */
  licenseKey?: string;
  ephemeralAccountId?: string;
  serviceName?: string;
  /** Subscriber secret (decimal string) to persist for pause/resume/cancel. */
  subscriberSecret?: string;
  /** Vault PDA the secret is keyed by. */
  vaultPda?: string;
  /** Commitment of the spent note, so the popup can drop it from the picker. */
  spentNoteId?: string;
}

export interface ZkJobState {
  jobId: string;
  kind: ZkJobKind;
  phase: ZkJobPhase;
  /** Human-readable current step (mirrors the old onProgress messages). */
  step: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  result?: ZkJobResult;
}

const keyFor = (jobId: string) => `p01-zk-job:${jobId}`;
const ACTIVE_KEY = 'p01-zk-job:active';

/** True while the job is still running (popup should show progress, not idle). */
export function isJobActive(s: ZkJobState | null): boolean {
  return !!s && s.phase !== 'done' && s.phase !== 'error';
}

export async function writeJobState(state: ZkJobState): Promise<void> {
  await chrome.storage.local.set({
    [keyFor(state.jobId)]: { ...state, updatedAt: Date.now() },
    [ACTIVE_KEY]: state.jobId,
  });
}

export async function patchJobState(
  jobId: string,
  patch: Partial<Omit<ZkJobState, 'jobId' | 'kind' | 'startedAt'>>,
): Promise<void> {
  const cur = await readJobState(jobId);
  if (!cur) return;
  await writeJobState({ ...cur, ...patch });
}

export async function readJobState(jobId: string): Promise<ZkJobState | null> {
  const r = await chrome.storage.local.get(keyFor(jobId));
  return (r[keyFor(jobId)] as ZkJobState | undefined) ?? null;
}

/** The most recent job (for the popup to re-attach after reopening). */
export async function readActiveJob(): Promise<ZkJobState | null> {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  const id = r[ACTIVE_KEY] as string | undefined;
  if (!id) return null;
  return readJobState(id);
}

/** Clear a finished job so the popup returns to its normal flow. */
export async function clearJob(jobId: string): Promise<void> {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  const updates: Record<string, unknown> = {};
  await chrome.storage.local.remove(keyFor(jobId));
  if ((r[ACTIVE_KEY] as string | undefined) === jobId) {
    await chrome.storage.local.remove(ACTIVE_KEY);
  }
  void updates;
}

/**
 * Subscribe to live updates for a specific job via chrome.storage.onChanged.
 * Returns an unsubscribe function. The popup uses this for real-time progress
 * without polling.
 */
export function subscribeJobState(
  jobId: string,
  cb: (state: ZkJobState | null) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local') return;
    const change = changes[keyFor(jobId)];
    if (change) cb((change.newValue as ZkJobState | undefined) ?? null);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Generate a job id without Math.random reliance issues (timestamp + counter). */
export function newJobId(): string {
  const rand = (globalThis.crypto?.getRandomValues?.(new Uint8Array(6)) ?? new Uint8Array(6));
  const hex = Array.from(rand).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `zk_${Date.now().toString(36)}_${hex}`;
}

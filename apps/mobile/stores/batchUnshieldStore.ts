/**
 * Batch Unshield Store — transient, non-persisted.
 *
 * Orchestrates sequential unshield of multiple denominated notes toward a
 * single recipient. Sequential (not parallel) is intentional:
 *   - each unshield blocks ~0.85 SOL rent on an ephemeral stealth signer
 *     while its proof buffer is open; running in parallel would require
 *     N × rent in-flight and N proof buffers open simultaneously
 *   - the prover WASM is single-threaded, so parallel proof gen doesn't
 *     save wall time anyway
 *
 * The store only tracks UI state (selection, per-note progress). The actual
 * proof generation and on-chain submission happens in the batch screen, which
 * has access to the StarkProverProvider hook and reuses the existing
 * `unshieldNoteStark` action on `denominatedPoolStore`.
 */

import { create } from 'zustand';

export type BatchNoteStatus =
  | 'queued'
  | 'proving'
  | 'unshielding'
  | 'sweeping'
  | 'done'
  | 'failed';

export interface BatchNoteState {
  status: BatchNoteStatus;
  error?: string;
  txSig?: string;
  /** Progress message surfaced by the underlying store (proof step, etc.) */
  progress?: string;
}

interface BatchUnshieldState {
  /** IDs the user picked in the multi-select UI (order preserved) */
  selectedIds: string[];
  /** Recipient address or meta-address — shared across all notes in the batch */
  recipient: string;
  /** True while the sequential loop is running */
  running: boolean;
  /** Index of the note currently being processed (-1 when idle) */
  currentIndex: number;
  /** Per-note state keyed by noteId */
  states: Record<string, BatchNoteState>;

  // Selection actions
  toggle: (id: string) => void;
  setSelection: (ids: string[]) => void;
  clearSelection: () => void;

  // Run actions
  setRecipient: (r: string) => void;
  beginRun: () => void;
  advance: (index: number) => void;
  finishRun: () => void;
  updateNote: (id: string, patch: Partial<BatchNoteState>) => void;
  resetAll: () => void;
}

export const useBatchUnshieldStore = create<BatchUnshieldState>((set) => ({
  selectedIds: [],
  recipient: '',
  running: false,
  currentIndex: -1,
  states: {},

  toggle: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id);
      return {
        selectedIds: has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id],
      };
    }),

  setSelection: (ids) => set({ selectedIds: [...ids] }),
  clearSelection: () => set({ selectedIds: [], states: {} }),

  setRecipient: (r) => set({ recipient: r }),

  beginRun: () =>
    set((s) => {
      const states: Record<string, BatchNoteState> = {};
      for (const id of s.selectedIds) states[id] = { status: 'queued' };
      return { running: true, currentIndex: -1, states };
    }),

  advance: (index) => set({ currentIndex: index }),

  finishRun: () => set({ running: false, currentIndex: -1 }),

  updateNote: (id, patch) =>
    set((s) => ({
      states: {
        ...s.states,
        [id]: { ...(s.states[id] ?? { status: 'queued' }), ...patch },
      },
    })),

  resetAll: () =>
    set({
      selectedIds: [],
      recipient: '',
      running: false,
      currentIndex: -1,
      states: {},
    }),
}));

/**
 * Note maturity countdown — shared between the private-subscribe picker and the
 * shielded-wallet funds list so both show the SAME live, ticking estimate.
 *
 * A denominated note must age `dynamic_delay` epochs before it can fund a
 * private subscribe or a transfer (on-chain EpochDelayNotMet). `get_dynamic_delay`
 * caps at 2 epochs, so using the max is SAFE — a note this old always passes the
 * on-chain check. The countdown is "live": we fetch the slot once, then
 * extrapolate from wall-clock so the label ticks down every second.
 *
 * What is real vs estimated:
 *  - deposit_epoch: the note's real value.
 *  - current slot: real (fetched), then extrapolated by elapsed wall-clock.
 *  - SLOTS_PER_EPOCH (7200): a fixed on-chain protocol constant, not a guess.
 *  - delay (2): the max dynamic_delay (conservative; never says "ready" early).
 *  - SLOT_MS (~450): the ONLY genuine estimate (chain timing isn't guaranteed),
 *    hence the "~"-free "Matures in …" is still approximate by nature.
 */

export interface SlotInfo {
  /** Slot value at the moment it was fetched. */
  slot: number;
  /** Date.now() when `slot` was fetched, for wall-clock extrapolation. */
  at: number;
}

/** Max anti-correlation delay before a note matures (get_dynamic_delay caps at 2). */
export const MAX_DELAY_EPOCHS = 2;

/** Fixed on-chain protocol constant. */
export const SLOTS_PER_EPOCH_UI = 7200;

/** Devnet slot time estimate (~0.4-0.5s/slot). The only non-exact input. */
export const SLOT_MS = 450;

/**
 * Compute a live maturity label for a note from its deposit epoch and the last
 * fetched slot. Returns `ready` (transfer/subscribe allowed) + a human label.
 */
export function noteMaturity(
  depositEpoch: bigint,
  slotInfo: SlotInfo | null,
  nowTs: number,
): { ready: boolean; label: string } {
  if (!slotInfo) return { ready: true, label: '' }; // unknown → don't block
  const estSlot = slotInfo.slot + (nowTs - slotInfo.at) / SLOT_MS;
  const matureAtSlot = (Number(depositEpoch) + MAX_DELAY_EPOCHS) * SLOTS_PER_EPOCH_UI;
  if (estSlot >= matureAtSlot) return { ready: true, label: 'Ready' };
  const totalSec = Math.max(0, Math.floor(((matureAtSlot - estSlot) * SLOT_MS) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const t = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return { ready: false, label: `Matures in ${t}` };
}

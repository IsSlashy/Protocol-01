/**
 * `/send/confirm` — kept as a route, emptied of its screen.
 *
 * 🎯 WHY THIS FILE STILL EXISTS AND RENDERS SOMETHING ELSE
 * ───────────────────────────────────────────────────────
 * This used to be the second half of the send flow: a screen that re-printed
 * the recipient, the amount and the fee the user had just typed, added a TOTAL
 * derived from that same fee, and then offered the button that actually signs.
 * It asked for a decision without supplying one fact the previous screen had
 * not already shown, so it was a pause, not a confirmation. Signing now happens
 * on `Send` itself, where the numbers are being entered.
 *
 * ⚠️ THE ROUTE IS NOT DELETED ON PURPOSE. `/send/confirm` is registered in
 * App.tsx and may be sitting in someone's history or in a pinned popup state.
 * A route that 404s after an update is worse than one that lands on the send
 * form, so this renders `Send`. Nothing navigates here any more.
 *
 * ⛔ Do not rebuild a confirmation step here. If a send ever needs a second
 * look — a large amount, an unrecognised address — that belongs inline on the
 * send screen, next to the field that triggered it.
 */

import Send from './Send';

export default function SendConfirm() {
  return <Send />;
}

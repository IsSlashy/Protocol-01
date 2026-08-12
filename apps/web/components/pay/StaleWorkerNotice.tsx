"use client";

import { RefreshCw } from "lucide-react";

/**
 * The one line a panel says when a VERSION-SKEWED worker could not open the
 * sealed local records (tab left open across a deploy: newer page, older
 * worker — `lib/privacy/sealedStore.ts:SealedRecordsAnswer` holds the
 * detection contract, each store's loader raises the flag).
 *
 * WHY THIS EXISTS AS COPY AND NOT JUST A FLAG. Post-migration the v1 cleartext
 * buckets are gone, so a skewed worker's answer used to paint the lists EMPTY
 * — to a user, indistinguishable from their notes, payouts or subscriptions
 * having vanished, on a product whose whole subject is money they cannot see
 * any other way. The records are intact; only this tab cannot read them. The
 * line must make the user reload, not panic.
 *
 * EVERY SENTENCE MUST STAY TRUE IN EVERY STATE THIS CAN RENDER IN (standing
 * rule: never simplify a sentence into falsehood):
 *   - "cannot read some of the records" — exact: kinds the worker predates
 *     are unreadable, others may still have been served;
 *   - "incomplete or out of date" — covers both failure directions: a list
 *     painting short (payout history, subscriptions) AND a filter running
 *     short (a spent or handed-over note re-offered in a picker);
 *   - "your records are intact" — the sealed blobs are untouched in
 *     localStorage; nothing on any skew path deletes them (the rewriting
 *     writers refuse to run against a skew-blinded snapshot);
 *   - "reload this tab" — a reload loads the current worker, which reads
 *     every kind. Verified as the actual healing step, not a placebo.
 *
 * The genuinely empty store must never show this: every loader can only raise
 * the flag after finding sealed blobs it could not get opened, so an empty
 * wallet keeps its ordinary empty state.
 */
export default function StaleWorkerNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-p01-yellow/30 bg-p01-yellow/5 p-3 text-xs text-p01-yellow">
      <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>
        This tab is still running an older version of the app and cannot read some of the
        records saved on this device, so what it shows may be incomplete or out of date. Your
        records are intact — reload this tab to see them.
      </p>
    </div>
  );
}

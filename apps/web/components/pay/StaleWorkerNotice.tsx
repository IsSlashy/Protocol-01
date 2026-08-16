"use client";

import { KeyRound, RefreshCw } from "lucide-react";

/**
 * The one line a panel says when the sealed local records could not be opened.
 * TWO causes share that symptom, and each has its own cure — the reason this
 * takes a prop instead of staying one sentence:
 *
 *   default (skew)  — a VERSION-SKEWED worker: tab left open across a deploy,
 *     newer page, older worker. `lib/privacy/sealedStore.ts:SealedRecordsAnswer`
 *     holds the detection contract (absence of a per-kind array). Cure: reload.
 *   `lostSession`   — a RESTARTED worker: it crashed under the open tab and
 *     workerClient rebooted it with every seed wiped, so it refuses to open
 *     anything (`sealedStore.isSessionLostError`). Cure: sign again. A reload
 *     alone changes nothing here, which is why this variant exists at all — the
 *     reload line over a restart tells the user to do something that does not
 *     fix it, they try it, it fails, and they conclude the money is gone.
 *
 * WHY THIS EXISTS AS COPY AND NOT JUST A FLAG. Post-migration the v1 cleartext
 * buckets are gone, so an unreadable store used to paint the lists EMPTY — to
 * a user, indistinguishable from their notes, payouts or subscriptions having
 * vanished, on a product whose whole subject is money they cannot see any
 * other way. The records are intact; only this tab cannot read them. The line
 * must make the user do the one thing that heals it, not panic.
 *
 * EVERY SENTENCE MUST STAY TRUE IN EVERY STATE IT CAN RENDER IN (standing
 * rule: never simplify a sentence into falsehood). For the skew line:
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
 * For the lost-session line:
 *   - "lost its private-key session … restarted" — the flag is only raised
 *     when a worker that once served this identity's session now refuses it,
 *     which in a live tab is exactly the crash-and-reboot path;
 *   - "cannot unlock your encrypted records" — exact: every sealed record
 *     needs the wiped seeds; v1 cleartext leftovers, where they still exist,
 *     keep serving, which "may be incomplete or out of date" covers;
 *   - "your records are safe on this device" — nothing on this path deletes
 *     a blob: readers never write, writers append or fall back to v1, and
 *     the rewriting writers bail out when the open is refused;
 *   - "reconnect … and sign to derive your keys again" — echoes the actual
 *     button ("Sign to derive keys"); a fresh signature re-derives the seeds
 *     and the very next read serves everything. Verified as the healing step;
 *   - "a reload alone is not enough" — true: after a reload nothing sealed is
 *     readable until the signature either, the app only forces the signing
 *     gate first. The signature is the cure in both flows.
 *
 * The genuinely empty store must never show either line: every loader can
 * only raise its flag after finding sealed blobs it could not get opened, so
 * an empty wallet keeps its ordinary empty state.
 */
export default function StaleWorkerNotice({ lostSession = false }: { lostSession?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-p01-yellow/30 bg-p01-yellow/5 p-3 text-xs text-p01-yellow">
      {lostSession ? (
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      {lostSession ? (
        <p>
          This tab lost its private-key session: the in-page worker holding your derived keys
          restarted, and until you sign again it cannot unlock your encrypted records, so what
          is shown may be incomplete or out of date. Your records are safe on this device —
          reconnect your wallet and sign to derive your keys again to see them. A reload alone
          is not enough; the signature is what unlocks them.
        </p>
      ) : (
        <p>
          This tab is still running an older version of the app and cannot read some of the
          records saved on this device, so what it shows may be incomplete or out of date. Your
          records are intact — reload this tab to see them.
        </p>
      )}
    </div>
  );
}

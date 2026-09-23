"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useT } from "@/i18n";

/**
 * ⛔ AN ISSUED NOTE IS HELD ON THIS DEVICE ONLY, AND THE CARD SAYS SO
 * (audit v1 round 1, fix lane 2; moved here and translated in close-v1).
 *
 * A contribution (the default Shield click when stock is issuable), an
 * exchange and a resumed contribution all leave the buyer an ISSUED note. Its
 * secrets come from the treasury seed, so the buyer's own seed scan never
 * finds it (`shieldClient.ts`, `storeEncryptedNote`: "For a RECEIVED note the
 * blob is the ONLY record"). The claim code is the one thing that brings it
 * back: the issuer keeps the sealed reply under the hash of the code and hands
 * it again to the same code (`app/api/issue-note/route.ts`, "A RETRY IS NOT A
 * SECOND SALE"), and the worker re-derives the address it was sealed to from
 * this wallet's pool seed and that code. The code is handed to the buyer here,
 * behind a click like every other id on these cards, and "Restore the note"
 * under the Shield tab's Recover line redeems it.
 *
 * `restoreWhere` says where that form is: on this panel (PoolPanel) or on the
 * Shield tab (SubscribePanel, whose exchanged note is the same kind of note).
 * Without a code the card still carries the warning.
 *
 * Every sentence is `pay.pool.*` in both dictionaries (close-v1, F07). Pinned
 * by `__tests__/components/PoolPanel.test.tsx` ("audit r1: an issued note is
 * held on this device only", "close-v1: the resumed card ...") and
 * `SubscribePanel.test.tsx` ("close-v1: issued notes ...").
 */
export default function IssuedNoteOnlyCopy({
  claimCode,
  restoreWhere = "here",
}: {
  claimCode?: string;
  restoreWhere?: "here" | "shieldTab";
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-2 space-y-1 text-xs text-p01-text-muted">
      <p className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
        <span>
          <strong className="text-p01-text">{t("pay.pool.issuedOnlyCopyLead")}</strong>
          {t("pay.pool.issuedOnlyCopyBody")}
          {claimCode
            ? t(
                restoreWhere === "shieldTab"
                  ? "pay.pool.issuedOnlyCopyWithCodeShieldTab"
                  : "pay.pool.issuedOnlyCopyWithCode",
              )
            : t("pay.pool.issuedOnlyCopyNoCode")}
        </span>
      </p>
      {claimCode ? (
        shown ? (
          <p>
            <span className="text-p01-text-dim">{t("pay.pool.recoveryCodeLabel")}: </span>
            <code className="select-all break-all font-mono text-p01-text">{claimCode}</code>{" "}
            <button
              type="button"
              onClick={() => setShown(false)}
              className="text-p01-text-dim underline-offset-2 hover:text-p01-cyan hover:underline"
            >
              {t("pay.pool.hideRecoveryCode")}
            </button>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setShown(true)}
            className="text-p01-cyan underline-offset-2 hover:underline"
          >
            {t("pay.pool.showRecoveryCode")}
          </button>
        )
      ) : null}
    </div>
  );
}

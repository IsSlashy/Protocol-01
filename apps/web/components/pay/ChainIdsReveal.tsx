"use client";

/**
 * ChainIdsReveal: a card's on-chain ids behind one click (UI-1 fix round 1,
 * ledger row D14).
 *
 * A success card's transaction signature, payout address or vault is public on
 * chain and names the one transaction the card is about: the deposit that
 * created the note, or the spend of it. A screenshot, a screen recording or a
 * support ticket that carries one is an explorer lookup away from that
 * transaction, and from there to the note (a deposit publishes the leaf and
 * the commitment). So a card shows a sentence and a button, and the ids only
 * once the user asks.
 *
 * Closed means NOT RENDERED, not hidden with CSS: while closed the children are
 * not in the DOM, so a copy of the page carries no window of them
 * (`__tests__/components/PoolPanel.test.tsx`, "an own deposit: its transaction
 * stays off the card until asked" and its siblings for the exchange,
 * withdrawal, payout and sweep ids; `__tests__/components/SubscribePanel.test.tsx`,
 * "keeps the vault and the opening transaction off the card until asked").
 *
 * It starts closed on every mount. Callers key it on the result it describes,
 * so a new result starts closed even where the card itself stays mounted
 * ("a second deposit starts with its transaction hidden again").
 *
 * [SWEEP round 1 of run logs8, storage lens] OPEN, IT SAYS WHAT A LINK COSTS.
 * The children are explorer links, and opening one hands the id to two parties
 * the screen rule says nothing about: explorer.solana.com, which sees the
 * lookup from the user's network address, and the browser's own history, which
 * keeps the exact URL with a visit time and syncs it. The sentence stands above
 * the links and only while they are shown
 * (`__tests__/components/ChainIdsReveal.test.tsx`). It is a warning, not a
 * closure: the ids are public and the choice to look one up stays the user's.
 */

import { useState, type ReactNode } from "react";

import { useT } from "@/i18n";

export default function ChainIdsReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className={className}>
      {shown ? (
        <>
          <p className="mb-1 text-xs text-p01-text-dim">{t("pay.shared.chainIdsLinkWarning")}</p>
          {children}
          <button
            type="button"
            onClick={() => setShown(false)}
            className="mt-1 block text-xs text-p01-text-muted underline hover:text-p01-cyan"
          >
            {t("pay.shared.chainIdsHide")}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-p01-text-dim">{t("pay.shared.chainIdsHidden")}</p>
          <button
            type="button"
            onClick={() => setShown(true)}
            className="mt-1 text-xs text-p01-cyan underline hover:text-p01-text"
          >
            {t("pay.shared.chainIdsShow")}
          </button>
        </>
      )}
    </div>
  );
}

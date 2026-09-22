/**
 * ChainIdsReveal: what stands next to an explorer link once the ids are shown
 * (sweep round 1 of run logs8, storage lens; ledger row D14's residual, "the
 * on-chain ids stay one click away").
 *
 * The reveal keeps a card's transaction, payout address or vault out of the DOM
 * until asked. Once asked, the link under it opens
 * `https://explorer.solana.com/tx/<the user's own withdrawal, exchange spend or
 * subscription opening>` in a new tab. Two parties then hold that id who did
 * not before: the explorer's operator, which sees the lookup from the user's
 * network address (a third party, not the RPC provider the app already uses),
 * and the browser's History database, which keeps the exact URL with a visit
 * time and syncs it to the user's other devices. That is the same fact the app
 * seals in `p01_pay_pool_payouts_v2`. The copy in front of the links spoke only
 * of the screen (`logs8/r1-storage/probe-D-explorer-links.txt`).
 *
 * No test can read a browser's History, so what is pinned is the warning: it is
 * on the page whenever a link is, it names the site and the history, and it is
 * NOT there while the ids are hidden (a warning about a link that is not on the
 * page is noise, and the closed state is what a screenshot carries).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ChainIdsReveal from "@/components/pay/ChainIdsReveal";
import en from "@/i18n/en";
import fr from "@/i18n/fr";

const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt79bLMnu9aq9GyiEBgWGN8tcJYWbZUMY9f5CBJzG7";

function renderReveal() {
  return render(
    <ChainIdsReveal>
      <a href={`https://explorer.solana.com/tx/${SIG}?cluster=devnet`} target="_blank" rel="noreferrer">
        open
      </a>
    </ChainIdsReveal>,
  );
}

describe("ChainIdsReveal says what opening a link tells, and to whom (sweep r1, storage)", () => {
  it("while the ids are hidden there is no link and no warning about one", () => {
    const view = renderReveal();
    expect(view.container.querySelector("a")).toBeNull();
    expect(view.container.textContent).not.toMatch(/explorer\.solana\.com/);
  });

  it("once shown, the link comes with the site's name and the browser's history", async () => {
    const user = userEvent.setup();
    const view = renderReveal();
    await user.click(screen.getByRole("button", { name: /^Show the on-chain links$/ }));
    // Positive control: the link is there, so the warning has something to warn about.
    expect(view.container.querySelector("a")?.getAttribute("href")).toContain(SIG);
    const text = view.container.textContent ?? "";
    expect(text, "nothing names the third party the link goes to").toMatch(/explorer\.solana\.com/);
    expect(text, "nothing says the browser keeps the address").toMatch(/history/i);
    // The warning stands BEFORE the link, where it is read first.
    const warning = screen.getByText(/explorer\.solana\.com/);
    const link = view.container.querySelector("a")!;
    expect(warning.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the sentence exists in both languages and names the same two things", () => {
    const sentence = (d: unknown) =>
      ((d as { pay: { shared: Record<string, string | undefined> } }).pay.shared.chainIdsLinkWarning ?? "");
    expect(sentence(en)).toMatch(/explorer\.solana\.com/);
    expect(sentence(en)).toMatch(/history/i);
    expect(sentence(fr)).toMatch(/explorer\.solana\.com/);
    expect(sentence(fr)).toMatch(/historique/i);
  });
});

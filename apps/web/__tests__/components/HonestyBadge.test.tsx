/**
 * HonestyBadge — the disclosure that sits under the stealth send.
 *
 * This badge is the only privacy claim on the stealth path that a user reads
 * before pressing the button, so what it must NOT say matters more than what it
 * does. Two failure modes have already shipped in this repo and each has an
 * assertion here:
 *
 *   1. OVERSTATING. A success toast once said the send was "hidden behind a
 *      one-time stealth address" while the badge one element above said the
 *      sender and amount were public (SendForm.tsx:328-336). The stealth send is
 *      a plain transfer out of the connected wallet —
 *      `SystemProgram.transfer({ fromPubkey: sender, toPubkey: stealth.address })`
 *      at packages/pay-core/src/worker/workerCore.ts:352, with
 *      `tx.feePayer = sender` at workerCore.ts:363, submitted by the browser
 *      itself at PayApp.tsx:120-133. The badge must keep saying so.
 *
 *   2. VAGUE UNDERSTATING. The badge used to end "sender unlinkability is on the
 *      roadmap", which reads as a feature not yet built rather than as the
 *      actual state: there is no relayer on /pay at all, so nothing on this path
 *      is even attempting to hide the sender. "Roadmap" is the word this test
 *      exists to keep out.
 *
 * The pointer to the note-handoff tab is asserted in BOTH halves deliberately.
 * "Broadcasts nothing" on its own is the overstate — the recipient's later
 * withdrawal still republishes the deposit's commitment (devnet leaf 16,
 * commitment 8901821612542787864, present in both transactions), so the two
 * clauses have to travel together.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import HonestyBadge from "@/components/pay/HonestyBadge";

/** Whole-badge text, whitespace-normalised, so assertions can span elements. */
function badgeText(): string {
  const p = document.querySelector("p");
  return (p?.textContent ?? "").replace(/\s+/g, " ");
}

describe("HonestyBadge — Solana stealth send", () => {
  it("says the recipient is the one thing that is hidden", () => {
    render(<HonestyBadge chain="solana" />);
    expect(screen.getByText("Recipient hidden")).toBeInTheDocument();
    expect(badgeText()).toContain("one-time post-quantum stealth address");
  });

  it("says the sender and the amount are public", () => {
    render(<HonestyBadge chain="solana" />);
    expect(badgeText()).toContain("Sender and amount public on this path");
  });

  it("names the wallet's three public roles rather than gesturing at them", () => {
    render(<HonestyBadge chain="solana" />);
    const text = badgeText();
    expect(text).toMatch(/wallet signs the transfer, pays the fee and funds the one-time address/);
  });

  it("states that there is no relayer, instead of deferring it to a roadmap", () => {
    render(<HonestyBadge chain="solana" />);
    const text = badgeText();
    expect(text).toContain("there is no relayer");
    expect(text).toContain("nothing here hides the sender");
    expect(text).not.toMatch(/roadmap/i);
  });

  it("points at the note handoff with its caveat attached, not on its own", () => {
    render(<HonestyBadge chain="solana" />);
    const text = badgeText();
    expect(text).toContain("broadcasts nothing at all");
    // The half that stops it being an upsell.
    expect(text).toMatch(/still republishes your deposit's commitment/);
  });

  it("never claims the send is unlinkable, private or anonymous", () => {
    render(<HonestyBadge chain="solana" />);
    expect(badgeText()).not.toMatch(/unlinkab|anonymous|untraceable|fully private/i);
  });
});

describe("HonestyBadge — Starknet variant", () => {
  /**
   * Currently unreachable: STRK, ETH and Starknet USDC were retired from the
   * selector, so `asset.chainId` (the only thing SendForm passes, SendForm.tsx:645)
   * can only be 'solana'. It is kept so the copy returns with the chain in one
   * edit — asserted here so "unreachable" does not quietly become "deleted".
   */
  it("still renders its own disclosure, with the unclaimed-spend-authority caveat", () => {
    render(<HonestyBadge chain="starknet" />);
    const text = badgeText();
    expect(text).toContain("Amounts public on this path");
    expect(text).toContain("the sender technically retains spend authority");
  });
});

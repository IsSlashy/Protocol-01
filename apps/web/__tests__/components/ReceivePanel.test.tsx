/**
 * ReceivePanel — receiving is a note import, and the stealth inbox is parked.
 *
 * Three classes of assertion, in order of how much they matter:
 *
 *   1. The tab is notes-only. The stealth scanner must never run
 *      (`adapter.scan` uncalled) and none of its UI (meta-address, Unshield,
 *      Rescan) may render: with the stealth SEND parked in SendForm, an inbox
 *      for payments nobody can emit would be a dead end shown as a feature.
 *   2. The disclosures are the accurate ones, on the screens a user actually
 *      reads. Receiving broadcasts nothing AND the eventual withdrawal is
 *      still matchable to the original deposit AND the sender keeps a
 *      spendable copy. The success screen carries all of it itself, because
 *      it replaces the disclosure fold.
 *   3. A string that cannot be a sealed note is refused at the form with its
 *      reason next to the disabled button, before the worker is asked.
 *
 * `createNoteEncryptionAddress` is NOT stubbed: the address card shows a real
 * `p01pq:` address built by the real key derivation. Only the two shieldClient
 * calls that would reach the Web Worker are replaced.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicKey } from "@solana/web3.js";

import ReceivePanel from "@/components/pay/ReceivePanel";
import { createNoteEncryptionAddress } from "@/lib/privacy/pool/noteCrypto";
import type { ImportNoteOutcome } from "@/lib/privacy/shieldClient";
import type {
  ChainStealthAdapter,
  DerivedIdentity,
} from "@/lib/privacy/chains/types";

// ---------------------------------------------------------------------------
// Stubs: only what would reach the Web Worker.
// ---------------------------------------------------------------------------

const importReceivedNote = vi.fn();
const fetchNoteReceiveAddress = vi.fn();

vi.mock("@/lib/privacy/shieldClient", () => ({
  importReceivedNote: (params: unknown) => importReceivedNote(params),
  fetchNoteReceiveAddress: (meta: string) => fetchNoteReceiveAddress(meta),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real address: real hybrid keygen, ~1,600 characters. */
const MY_ADDRESS = createNoteEncryptionAddress(new Uint8Array(32).fill(0x5a));

const SEALED = `p01enc1:${"A".repeat(1800)}`;

const IDENTITY = { meta: "meta-1" } as DerivedIdentity;

const ADAPTER = {
  id: "solana",
  label: "Solana",
  scan: vi.fn(),
  claim: vi.fn(),
} as unknown as ChainStealthAdapter;

const OWNER = { toBase58: () => "7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU" } as PublicKey;

function outcome(over: Partial<ImportNoteOutcome["note"]> = {}): ImportNoteOutcome {
  return {
    note: {
      pool: "HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG",
      token: "SOL",
      denomination: 0.1,
      counter: 0,
      leafIndex: 47,
      commitment: "8901821612542787864",
      spent: false,
      spentKnown: true,
      derivation: 1,
      ...over,
    },
    merklePath: "stored",
  };
}

/** A sealed note is ~1,800 characters; nobody types one. Paste it. */
async function pasteBlob(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByLabelText(/Sealed note you were given/i));
  await user.paste(value);
}

function renderPanel(props: { meta?: string | null; owner?: PublicKey | null } = {}) {
  return render(
    <ReceivePanel
      adapter={ADAPTER}
      identity={IDENTITY}
      destination="dest"
      meta={"meta" in props ? props.meta : "meta-1"}
      owner={"owner" in props ? props.owner : OWNER}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchNoteReceiveAddress.mockResolvedValue(MY_ADDRESS);
  importReceivedNote.mockResolvedValue(outcome());
});

// ---------------------------------------------------------------------------

describe("the tab is notes-only: the stealth inbox is parked", () => {
  it("never scans for stealth payments and shows none of that UI", async () => {
    renderPanel();
    await screen.findByRole("button", { name: /Copy note address/i });

    expect(ADAPTER.scan).not.toHaveBeenCalled();
    expect(screen.queryByText(/meta-address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unshield/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rescan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Incoming/i)).not.toBeInTheDocument();
  });
});

describe("the note address is the receiving half", () => {
  it("shows the p01pq address with QR and copy", async () => {
    const user = userEvent.setup();
    renderPanel();

    const copy = await screen.findByRole("button", { name: /Copy note address/i });
    expect(fetchNoteReceiveAddress).toHaveBeenCalledWith("meta-1");
    expect(screen.getByTestId("qr-code")).toHaveAttribute("data-value", MY_ADDRESS);

    // Read back through userEvent's clipboard stub; a spy on writeText would be
    // replaced by userEvent.setup() and pass by never being called.
    await user.click(copy);
    await expect(navigator.clipboard.readText()).resolves.toBe(MY_ADDRESS);
    expect(await screen.findByRole("button", { name: /Copied/i })).toBeInTheDocument();
  });

  it("offers a retry when the address cannot be derived, instead of a dead card", async () => {
    fetchNoteReceiveAddress.mockRejectedValueOnce(new Error("worker restarted"));
    renderPanel();
    expect(await screen.findByText("worker restarted")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Try again/i }));
    expect(await screen.findByRole("button", { name: /Copy note address/i })).toBeInTheDocument();
  });
});

describe("the paste box refuses what cannot be a sealed note", () => {
  it("starts disabled, with the reason next to the button", async () => {
    renderPanel();
    await screen.findByRole("button", { name: /Copy note address/i });

    expect(screen.getByRole("button", { name: /Add it to my notes/i })).toBeDisabled();
    expect(screen.getByText(/Paste the sealed note you were given/i)).toBeInTheDocument();
  });

  it("names a p01pq address for what it is: not a sealed note", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("button", { name: /Copy note address/i });
    // The classic mix-up: pasting an ADDRESS where the sealed NOTE goes.
    await pasteBlob(user, "p01pq:AAAA");

    expect(screen.getAllByText(/Not a sealed note/i).length).toBeGreaterThan(0);
    const button = screen.getByRole("button", { name: /Add it to my notes/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(importReceivedNote).not.toHaveBeenCalled();
  });
});

describe("importing", () => {
  async function importSealed() {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("button", { name: /Copy note address/i });
    await pasteBlob(user, SEALED);
    await user.click(screen.getByRole("button", { name: /Add it to my notes/i }));
    return user;
  }

  it("passes the session, wallet and blob through to the worker driver", async () => {
    await importSealed();
    await waitFor(() => expect(importReceivedNote).toHaveBeenCalledTimes(1));
    expect(importReceivedNote.mock.calls[0][0]).toMatchObject({
      meta: "meta-1",
      walletPubkey: OWNER.toBase58(),
      sealedNote: SEALED,
    });
  });

  it("announces the received note by its denomination, in plain words", async () => {
    await importSealed();
    expect(await screen.findByText("Received a 0.1 SOL note")).toBeInTheDocument();
    // Second plane: the protocol's name for it.
    expect(screen.getByText(/leaf #47/)).toBeInTheDocument();
  });

  it("tells both truths on the success screen itself", async () => {
    // The success screen replaces the disclosure fold, so it must carry the
    // whole disclosure: nothing was broadcast, AND the eventual withdrawal is
    // still matchable to the original deposit, AND the sender keeps a copy.
    await importSealed();
    await screen.findByText("Received a 0.1 SOL note");
    expect(screen.getByText(/sent nothing to the chain/i)).toBeInTheDocument();
    expect(
      screen.getByText(/same\s+commitment the original deposit published/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/sender still holds a spendable copy/i)).toBeInTheDocument();
    expect(screen.getByText(/This device holds your only copy/i)).toBeInTheDocument();
  });

  it("points at the Pool tab's existing Withdraw button as the way to spend it", async () => {
    // The founder's criterion: a received note is withdrawn from the Pool tab
    // with the button that already exists, so the success screen may say so.
    await importSealed();
    await screen.findByText("Received a 0.1 SOL note");
    expect(
      screen.getByText(/same\s+Withdraw button as a note you shielded yourself/i),
    ).toBeInTheDocument();
  });

  it("says when the unspent check could not run, instead of implying it did", async () => {
    importReceivedNote.mockResolvedValue(outcome({ spentKnown: false }));
    await importSealed();
    await screen.findByText("Received a 0.1 SOL note");
    expect(screen.getByText(/could not be reached to confirm/i)).toBeInTheDocument();
    expect(screen.queryByText(/has not been withdrawn/i)).not.toBeInTheDocument();
  });

  it("surfaces a refusal instead of pretending it worked", async () => {
    importReceivedNote.mockRejectedValue(
      new Error("Invalid note: commitment does not match its secrets."),
    );
    await importSealed();
    expect(
      await screen.findByText(/commitment does not match its secrets/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Received a/)).not.toBeInTheDocument();
  });
});

describe("the disclosure before any import", () => {
  it("claims no broadcast, and does NOT claim the note becomes untraceable", async () => {
    renderPanel();
    await screen.findByRole("button", { name: /Copy note address/i });
    expect(
      screen.getByText(/Receiving a note broadcasts nothing/i),
    ).toBeInTheDocument();
    // 🚨 CONDITIONAL SINCE C7 SHIPPED. This used to pin the collapsed v3 claim
    // that the exit is always matchable to the deposit. Both halves are pinned
    // now, because either one alone is a lie: circuit 7 (here and the extension)
    // carries no commitment, while the phone -- and any note C7 cannot prove --
    // still republishes it.
    expect(screen.getByText(/carries no commitment/i)).toBeInTheDocument();
    expect(screen.getByText(/publicly matchable to it/i)).toBeInTheDocument();
    expect(screen.getByText(/sender keeps a spendable copy/i)).toBeInTheDocument();
  });
});

describe("without a pool session", () => {
  it("says what is missing instead of rendering a dead form", async () => {
    renderPanel({ meta: null, owner: null });
    expect(screen.getByText(/needs your derived pool keys/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Sealed note you were given/i)).not.toBeInTheDocument();
    expect(fetchNoteReceiveAddress).not.toHaveBeenCalled();
    expect(ADAPTER.scan).not.toHaveBeenCalled();
  });
});

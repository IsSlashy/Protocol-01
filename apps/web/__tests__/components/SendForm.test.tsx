/**
 * SendForm — the note handoff, and the wall between it and the stealth send.
 *
 * Three classes of assertion, in order of how much they matter:
 *
 *   1. The two paths cannot be confused. The note handoff has NO amount field
 *      (a note is one of six fixed sizes; "send 0.2 privately" is the thing this
 *      feature exists to refuse) and the stealth send still has one, still
 *      labelled as public. A regression that put an amount box back on the
 *      private path would be a privacy claim the code does not deliver.
 *   2. The disclosures are present and are the accurate ones. This repo has
 *      shipped success screens that contradicted the badge above them; the copy
 *      here states what the mechanism gives (no transaction) AND what it does
 *      not (the recipient's withdrawal is still matchable to the sender's
 *      deposit, and the sender keeps a spendable copy).
 *   3. A recipient address that cannot be sealed to is refused at the form,
 *      before a pool scan that takes minutes on devnet.
 *
 * `isP01NoteAddress` is NOT stubbed — the real parser runs, over a real
 * `p01pq:` address built from the real key derivation, so "valid address" means
 * what it means in production. Only `sealNoteFor` (which would post to a Web
 * Worker) and the pool scan are replaced.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicKey } from "@solana/web3.js";

import SendForm from "@/components/pay/SendForm";
import { createNoteEncryptionAddress } from "@/lib/privacy/pool/noteCrypto";
import type { PoolNoteView } from "@/lib/privacy/worker/poolHandlers";
import type { Asset, ChainStealthAdapter } from "@/lib/privacy/chains/types";

// ---------------------------------------------------------------------------
// Stubs: only the two things that would reach a Worker or the network.
// ---------------------------------------------------------------------------

const scanPool = vi.fn();
const loadEncryptedNotes = vi.fn((_wallet: string): string[] => ["p01enc1:stored-blob"]);

vi.mock("@/lib/privacy/shieldClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/shieldClient")>();
  return {
    scanPool: (meta: string, token: string, onProgress?: (s: string) => void) =>
      scanPool(meta, token, onProgress),
    loadEncryptedNotes: (wallet: string) => loadEncryptedNotes(wallet),
    // Nothing spent in this browser: these tests are about what the form offers
    // from a scan, not about the local spent record. A test that wants that
    // behaviour should override this rather than rely on the default.
    knownSpentNoteKeys: () => new Set<string>(),
    // The chain resolution is fire-and-forget in the component. Resolving to
    // nothing keeps these tests about what the form offers from a scan, which is
    // what they were written for.
    resolveSpentNotes: async () => undefined,
    // The REAL merge: a pure function on the scan results, and the thing that
    // keeps a received note in this picker after the chain scan lands. Stubbing
    // it would let the form pass while dropping received money.
    mergeScanWithLocal: actual.mergeScanWithLocal,
  };
});

const sealNoteFor = vi.fn();

vi.mock("@/lib/privacy/noteTransfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/noteTransfer")>();
  return { ...actual, sealNoteFor: (...args: unknown[]) => sealNoteFor(...args) };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real address: derived with the real hybrid keygen, parsed by the real parser. */
const RECIPIENT_ADDRESS = createNoteEncryptionAddress(new Uint8Array(32).fill(0x5a));

const SEALED = `p01enc1:${"A".repeat(1800)}`;

const ASSET: Asset = {
  symbol: "SOL",
  name: "Solana",
  chainId: "solana",
  decimals: 9,
  minSend: 0.002,
  status: "live",
};

const ADAPTER = {
  id: "solana",
  label: "Solana",
  status: "live",
  assets: [ASSET],
  deriveMeta: vi.fn(),
  resolveRecipient: vi.fn(),
  quoteFees: () => ({
    networkFee: 0.000005,
    protocolFee: 0,
    minSend: 0.002,
    estTime: "~10s",
    approvals: 1,
  }),
  send: vi.fn(),
  scan: vi.fn(),
  claim: vi.fn(),
  registerSelf: vi.fn(),
} as unknown as ChainStealthAdapter;

const OWNER = { toBase58: () => "7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU" } as PublicKey;

function noteView(over: Partial<PoolNoteView> = {}): PoolNoteView {
  return {
    pool: "HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG",
    token: "SOL",
    denomination: 0.1,
    counter: 11,
    leafIndex: 11,
    commitment: "8901821612542787864",
    spent: false,
    derivation: 1,
    ...over,
  };
}

/**
 * A p01pq address is ~1,600 characters (an ML-KEM-768 public key). Nobody types
 * one and `user.type` would spend the whole test budget doing it a keystroke at
 * a time, so paste it — which is also the real interaction.
 */
async function pasteAddress(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByLabelText(/Recipient's note address/i));
  await user.paste(value);
}

function renderForm(props: { meta?: string | null; owner?: PublicKey | null } = {}) {
  return render(
    <SendForm
      adapter={ADAPTER}
      asset={ASSET}
      meta={"meta" in props ? props.meta : "meta-1"}
      owner={"owner" in props ? props.owner : OWNER}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  scanPool.mockResolvedValue({
    notes: [noteView(), noteView({ counter: 22, leafIndex: 22, denomination: 1, commitment: "42" })],
    shieldedBalance: 1.1,
    poolSizes: [],
  });
  sealNoteFor.mockResolvedValue({
    sealedNote: SEALED,
    denomination: 0.1,
    leafIndex: 11,
    commitment: "8901821612542787864",
    merklePath: "stored",
  });
});

// ---------------------------------------------------------------------------

describe("the note handoff replaces the amount box", () => {
  it("opens on the note path and offers no free-form amount", async () => {
    renderForm();
    expect(await screen.findByText("0.1 SOL")).toBeInTheDocument();
    // The founder's requirement, as an assertion: there is no number to type.
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("0.0")).not.toBeInTheDocument();
  });

  it("lists the unspent notes as the thing you pick", async () => {
    scanPool.mockResolvedValue({
      notes: [
        noteView(),
        noteView({ counter: 22, leafIndex: 22, denomination: 1, commitment: "42", spent: true }),
      ],
      shieldedBalance: 0.1,
      poolSizes: [],
    });
    renderForm();
    expect(await screen.findByText("0.1 SOL")).toBeInTheDocument();
    // A spent note is not a thing you can hand over.
    expect(screen.queryByText("1 SOL")).not.toBeInTheDocument();
  });

  it("says what to do when there is nothing to hand over", async () => {
    scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [] });
    renderForm();
    expect(await screen.findByText(/No unspent notes/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot hand over 0\.2 SOL/i)).toBeInTheDocument();
  });
});

describe("the recipient address is checked before any work", () => {
  it("refuses to seal to something that is not a p01pq address", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    // A perfectly good Solana wallet address — and useless here.
    await pasteAddress(user, "7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU");

    expect(screen.getByText(/Not a note address/i)).toBeInTheDocument();
    const seal = screen.getByRole("button", { name: /Seal this note to them/i });
    expect(seal).toBeDisabled();
    await user.click(seal);
    expect(sealNoteFor).not.toHaveBeenCalled();
  });

  it("accepts a real note address", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    await pasteAddress(user, RECIPIENT_ADDRESS);

    expect(screen.getByText(/Valid note address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Seal this note to them/i })).toBeEnabled();
  });

  it("will not seal until a note is picked", async () => {
    const user = userEvent.setup();
    renderForm();
    await screen.findByText("0.1 SOL");
    await pasteAddress(user, RECIPIENT_ADDRESS);
    expect(screen.getByRole("button", { name: /Seal this note to them/i })).toBeDisabled();
  });
});

describe("sealing", () => {
  async function seal() {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    await pasteAddress(user, RECIPIENT_ADDRESS);
    await user.click(screen.getByRole("button", { name: /Seal this note to them/i }));
    return user;
  }

  it("passes the picked note and the address through, with the stored blobs", async () => {
    await seal();
    await waitFor(() => expect(sealNoteFor).toHaveBeenCalledTimes(1));
    expect(sealNoteFor.mock.calls[0][0]).toMatchObject({
      meta: "meta-1",
      token: "SOL",
      denomination: 0.1,
      leafIndex: 11,
      recipientAddress: RECIPIENT_ADDRESS,
      encryptedNotes: ["p01enc1:stored-blob"],
    });
  });

  it("shows the sealed string with copy and QR affordances", async () => {
    const user = await seal();
    const blob = await screen.findByTestId("sealed-note");
    expect(blob).toHaveTextContent(SEALED);
    expect(screen.getByTestId("qr-code")).toHaveAttribute("data-value", SEALED);

    // Read back through userEvent's clipboard stub rather than spying on
    // `writeText`: `userEvent.setup()` installs its own `navigator.clipboard`,
    // so a spy planted beforehand would be replaced and would pass by never
    // being called.
    await user.click(screen.getByRole("button", { name: /Copy sealed note/i }));
    await expect(navigator.clipboard.readText()).resolves.toBe(SEALED);
    expect(await screen.findByRole("button", { name: /Copied/i })).toBeInTheDocument();
  });

  it("states that nothing was sent, and that the string is now the money", async () => {
    await seal();
    await screen.findByTestId("sealed-note");
    expect(screen.getByText(/Nothing was sent/i)).toBeInTheDocument();
    expect(screen.getByText(/bearer instrument/i)).toBeInTheDocument();
    // The one a user is most likely to get wrong.
    expect(screen.getByText(/You can still withdraw this note yourself/i)).toBeInTheDocument();
  });

  it("surfaces a failure instead of pretending it worked", async () => {
    sealNoteFor.mockRejectedValue(new Error("No note of yours found at leaf #11"));
    await seal();
    expect(await screen.findByText(/No note of yours found at leaf #11/)).toBeInTheDocument();
    expect(screen.queryByTestId("sealed-note")).not.toBeInTheDocument();
  });
});

describe("the disclosures say what the mechanism actually gives", () => {
  it("claims no transaction, and does NOT claim the note becomes untraceable", async () => {
    renderForm();
    await screen.findByText("0.1 SOL");
    expect(
      screen.getByText(/No transaction is sent\. That is what makes it private\./i),
    ).toBeInTheDocument();
    // The measured limit: the withdrawal republishes the deposit's commitment.
    expect(screen.getByText(/publicly matchable to your\s+deposit/i)).toBeInTheDocument();
    expect(screen.getByText(/You keep a spendable copy/i)).toBeInTheDocument();
  });
});

describe("the stealth send is parked, and parked means invisible not deleted", () => {
  it("offers no way in: no switch, no amount box, whatever the session", async () => {
    renderForm();
    expect(await screen.findByText("0.1 SOL")).toBeInTheDocument();
    // The founder parked this path on 2026-08-05: it hid the recipient and
    // nothing else, under a name that promised more, and a plain send is
    // Phantom's while stealth addressing is Umbra's. The note handoff is what
    // this product has that others do not.
    expect(screen.queryByRole("button", { name: "Stealth send" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
  });

  it("lands on the note path even with no pool keys, and says why it cannot proceed", async () => {
    renderForm({ meta: null, owner: null });
    // No session, so no scan is attempted at all.
    expect(scanPool).not.toHaveBeenCalled();
    // It used to fall back to the stealth form here. With that path parked the
    // honest answer is the reason, not a different product.
    expect(screen.getByText(/needs your derived pool keys/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
  });
});

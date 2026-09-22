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
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicKey } from "@solana/web3.js";

import SendForm from "@/components/pay/SendForm";
import { BEARER_CLIPBOARD_CLEAR_MS } from "@/lib/pay/bearerClipboard";
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
    // Async like the real one since L5: the store is encrypted and the worker
    // opens it, so the component awaits this. `staleWorker: false` = a current
    // worker; the skew states are pinned in storeEncryption.test.ts and
    // SubscriptionsPanel.test.tsx.
    knownSpentNoteKeys: async () => ({ keys: new Set<string>(), staleWorker: false }),
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

/** The note's display name (TAG-0 vector: `fixtures/noteTagVector.json`). */
const TAG = { text: "9PHT-NDYJ", color: "#b8960f" };
const OTHER_TAG = { text: "3TZZ-VRGX", color: "#4f9d4f" };

/** UI-1 canaries: a leaf and a commitment no other fixture uses. */
const CANARY_LEAF = 987654;
const CANARY_COMMITMENT = "1357913579135791357";

/** Every canary visible in `html`: the leaf, and any 6-character window of the
 *  commitment (the old rows showed `truncate(commitment, 6, 4)`). */
function canariesIn(html: string): string[] {
  const found: string[] = [];
  if (html.includes(String(CANARY_LEAF))) found.push(String(CANARY_LEAF));
  for (let i = 0; i + 6 <= CANARY_COMMITMENT.length; i++) {
    const w = CANARY_COMMITMENT.slice(i, i + 6);
    if (html.includes(w)) found.push(w);
  }
  return [...new Set(found)];
}

/**
 * A p01pq address is ~1,600 characters (an ML-KEM-768 public key). Nobody types
 * one and `user.type` would spend the whole test budget doing it a keystroke at
 * a time, so paste it — which is also the real interaction.
 */
async function pasteAddress(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByLabelText(/Recipient.s address/i));
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
  // A case that installs a fake clock and then times out never reaches its own
  // restore, and every case after it would wait forever on a timer nothing
  // advances. Restoring here contains that to the one case.
  vi.useRealTimers();
  // Sealing now records a handoff in localStorage, and an in-transit note is
  // withheld from this picker. Without this line the first test to seal would
  // hide the fixture note from every test after it, which would be a property
  // of the suite rather than of the component.
  localStorage.clear();
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

  it("says what to do when there is nothing to send", async () => {
    // The empty state was "No unspent notes. Shield one in the Pool tab first:
    // you cannot hand over 0.2 SOL…". Two things changed and both are pinned
    // here: it points at the tab by the name the tab bar actually shows
    // (PayApp's TAB_LABEL renames `pool` to Shield), and it leads with the
    // action rather than with what the user cannot do.
    scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [] });
    renderForm();
    expect(await screen.findByText(/Nothing to send yet/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Open the Shield tab/i).length).toBeGreaterThan(0);
    // The reason survives the rewrite: a note is a whole fixed size.
    expect(screen.getByText(/not an amount/i)).toBeInTheDocument();
    // And the tab it points at must not be named after a state key any more.
    expect(screen.queryByText(/Pool tab/i)).not.toBeInTheDocument();
  });
});

describe("the recipient address is checked before any work", () => {
  it("refuses to seal to something that is not a p01pq address", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    // A perfectly good Solana wallet address — and useless here.
    await pasteAddress(user, "7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU");

    expect(screen.getByText(/not one of these addresses/i)).toBeInTheDocument();
    const seal = screen.getByRole("button", { name: /Prepare the note/i });
    expect(seal).toBeDisabled();
    await user.click(seal);
    expect(sealNoteFor).not.toHaveBeenCalled();
  });

  it("accepts a real note address", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    await pasteAddress(user, RECIPIENT_ADDRESS);

    expect(screen.getByText(/Address looks right/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Prepare the note/i })).toBeEnabled();
  });

  /**
   * Sweep round 1 (logs8), fix lane 2. The recipient's reusable `p01pq:` address
   * is the one value on this tab that says who is being paid, and this was the
   * one free-text field of the pay app that did not opt out of the browser's
   * writing helpers. A cloud spellchecker (Microsoft Editor in Edge by default,
   * Chrome's Enhanced spell check when switched on) may send a spellchecked
   * field's text to the browser vendor. Nobody measured that it does for a
   * 1,630-character token; the opt-out costs nothing either way.
   */
  it("keeps the recipient's address away from the browser's writing helpers", async () => {
    const user = userEvent.setup();
    renderForm();
    const field = (await screen.findByLabelText(/Recipient.s address/i)) as HTMLInputElement;
    await pasteAddress(user, RECIPIENT_ADDRESS);
    // Positive control: this is the field that holds the address.
    expect(field.value).toBe(RECIPIENT_ADDRESS);
    expect(
      field.getAttribute("spellcheck"),
      "the address of the person being paid is left to the browser's spellchecker",
    ).toBe("false");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("autocorrect")).toBe("off");
    expect(field.getAttribute("autocapitalize")).toBe("off");
  });

  it("will not seal until a note is picked", async () => {
    const user = userEvent.setup();
    renderForm();
    await screen.findByText("0.1 SOL");
    await pasteAddress(user, RECIPIENT_ADDRESS);
    expect(screen.getByRole("button", { name: /Prepare the note/i })).toBeDisabled();
  });
});

describe("sealing", () => {
  async function seal() {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    await pasteAddress(user, RECIPIENT_ADDRESS);
    await user.click(screen.getByRole("button", { name: /Prepare the note/i }));
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
    await user.click(screen.getByRole("button", { name: /Copy the note/i }));
    await expect(navigator.clipboard.readText()).resolves.toBe(SEALED);
    expect(await screen.findByRole("button", { name: /Copied/i })).toBeInTheDocument();
  });

  /**
   * The length of the handoff, web sweep 4 round 1, item 4.
   *
   * The sealed string is not padded, so its length is a function of what is in
   * it: a pre-blinding note differs from a blinded one, a note this browser was
   * given differs from one it scanned for itself, a rebuilt Merkle path adds
   * some 600 characters, and the leaf index's digit count moves it by one.
   * Measured on the app's own encryptNote over the export's JSON shape, 400
   * draws each (`scratchpad/web-run/logs4/sweep1-screen/export-length-probe.log`).
   * Printing the exact count hands that classifier to anyone who sees the
   * screen. The page now states a bucket, so two handoffs that differ by less
   * than the bucket read identically.
   */
  it("does not print the exact length of the sealed string", async () => {
    const odd = `p01enc1:${"A".repeat(1801)}`;
    sealNoteFor.mockResolvedValue({
      sealedNote: odd,
      denomination: 0.1,
      leafIndex: 11,
      commitment: "8901821612542787864",
      merklePath: "stored",
    });
    await seal();
    await screen.findByTestId("sealed-note");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(odd.length.toLocaleString());
    expect(text).not.toContain(String(odd.length));
  });

  it("reads the same for two handoffs whose lengths differ by less than a bucket", async () => {
    /** The sentence under the QR code, for a sealed string of this length. */
    async function densityLine(length: number): Promise<string> {
      cleanup();
      // Sealing files a handoff, and an in-transit note is withheld from the
      // picker: without this the second round would find nothing to seal.
      localStorage.clear();
      sealNoteFor.mockResolvedValue({
        sealedNote: `p01enc1:${"A".repeat(length - 8)}`,
        denomination: 0.1,
        leafIndex: 11,
        commitment: "8901821612542787864",
        merklePath: "stored",
      });
      await seal();
      await screen.findByTestId("sealed-note");
      return screen.getByText(/dense code/i).textContent ?? "";
    }
    // The two shapes the probe separated: a blinded note this browser owns and
    // one it was given, 20 characters apart.
    const own = await densityLine(1948);
    const received = await densityLine(1968);
    expect(received).toBe(own);
    // Positive control: a handoff that carries a rebuilt path IS a different
    // sentence, so the bucket did not simply erase the information.
    const withPath = await densityLine(2544);
    expect(withPath).not.toBe(own);
  });

  /**
   * The clipboard, web sweep 4 round 1, item 24 (ledger row D8).
   *
   * The sealed string is the money. Windows keeps a clipboard history on disk
   * and phones sync it between devices, so a copy that is never taken back
   * outlives the tab that made it, and whoever reads that history can spend the
   * note. The page takes it back once it has read the clipboard and found its
   * own string still there (`lib/pay/bearerClipboard.ts`).
   */
  it("takes the sealed note back off the clipboard", async () => {
    await seal();
    await screen.findByTestId("sealed-note");
    // `shouldAdvanceTime` keeps real time running under the fake clock, so the
    // library's own waits still settle while the 90 s timer can be jumped.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: /Copy the note/i }));
      await expect(navigator.clipboard.readText()).resolves.toBe(SEALED);
      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      // An emptied clipboard reads back as "" in a browser; userEvent's stub
      // rejects with "text/plain is not one of the available types" instead,
      // because writing "" leaves its item with no text flavour. Both mean the
      // same thing here — the sealed string is gone — and the assertion is on
      // the string, which is what the red run printed ("expected
      // 'p01enc1:AAA…' to be ''").
      const after = await navigator.clipboard.readText().then(
        (t) => t,
        () => "",
      );
      expect(after).not.toBe(SEALED);
      expect(after).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Sweep round 1 (logs8), fix lane 2. The take-back above died with the panel:
   * the timer was cancelled on unmount, and PayApp unmounts the panels on
   * disconnect, on a wallet switch and on the identity chip's reset. The
   * compare in `clearBearerIfUnchanged` already protects a newer copy, so the
   * cancel bought nothing. The clear is NOT brought forward to the unmount: the
   * string was copied to be pasted, and the promise is a minute and a half.
   */
  it("still takes the sealed note back after the panel unmounts", async () => {
    await seal();
    await screen.findByTestId("sealed-note");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: /Copy the note/i }));
      await expect(navigator.clipboard.readText()).resolves.toBe(SEALED);
      cleanup();
      expect(document.body.textContent).not.toContain("p01enc1:");
      // Still pasteable right after: leaving the panel is not the take-back.
      await expect(navigator.clipboard.readText()).resolves.toBe(SEALED);
      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      const after = await navigator.clipboard.readText().then(
        (t) => t,
        () => "",
      );
      expect(
        after === SEALED ? "the sealed note is still on the clipboard" : after,
        "the sealed note outlived the panel on the clipboard",
      ).toBe("");
    } finally {
      vi.useRealTimers();
    }
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

describe("a note is named by its tag, never by its leaf or commitment (UI-1)", () => {
  function scanReturns(notes: PoolNoteView[]) {
    scanPool.mockResolvedValue({ notes, shieldedBalance: 1, poolSizes: [] });
  }

  async function pickerHtml(notes: PoolNoteView[]): Promise<string> {
    scanReturns(notes);
    const view = renderForm();
    // One picker button per note, and only then read the page.
    await waitFor(() =>
      expect(view.container.querySelectorAll("button[aria-pressed]").length).toBe(notes.length),
    );
    const html = view.container.innerHTML;
    view.unmount();
    return html;
  }

  it("the picker rows show the tag and no leaf or commitment", async () => {
    const html = await pickerHtml([
      noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, denomination: 1, tag: TAG }),
    ]);
    expect(canariesIn(html)).toEqual([]);
    expect(html).toContain(TAG.text);
  });

  it("the picker renders the same rows when only the leaves and commitments differ", async () => {
    // Two notes, then the same two notes with their leaves swapped and new
    // commitments. A row naming a leaf differs, and so does a list ORDERED by
    // leaf: the order must come from the tags (shieldClient.mergeScanWithLocal).
    const a = await pickerHtml([
      noteView({ leafIndex: 5, commitment: CANARY_COMMITMENT, denomination: 1, tag: TAG }),
      noteView({ leafIndex: 9, commitment: "42", denomination: 1, tag: OTHER_TAG }),
    ]);
    const b = await pickerHtml([
      noteView({ leafIndex: 9, commitment: "777777", denomination: 1, tag: TAG }),
      noteView({ leafIndex: 5, commitment: "888888", denomination: 1, tag: OTHER_TAG }),
    ]);
    expect(b).toBe(a);
    // Positive control: a different name IS a different page.
    const c = await pickerHtml([
      noteView({ leafIndex: 5, commitment: CANARY_COMMITMENT, denomination: 1, tag: TAG }),
      noteView({ leafIndex: 9, commitment: "42", denomination: 1, tag: { text: "09RX-WVVH", color: "#d4553f" } }),
    ]);
    expect(c).not.toBe(a);
  });

  it("the sealed result names the note by its tag, not by its leaf or commitment", async () => {
    scanReturns([noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: TAG })]);
    // Whatever the worker might still hand back, the page must not print it.
    sealNoteFor.mockResolvedValue({
      sealedNote: SEALED,
      denomination: 0.1,
      leafIndex: CANARY_LEAF,
      commitment: CANARY_COMMITMENT,
      tag: TAG,
      merklePath: "stored",
    });
    const user = userEvent.setup();
    const view = renderForm();
    await user.click(await screen.findByText("0.1 SOL"));
    await pasteAddress(user, RECIPIENT_ADDRESS);
    await user.click(screen.getByRole("button", { name: /Prepare the note/i }));
    await screen.findByTestId("sealed-note");
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    expect(within(view.container).getAllByText(TAG.text).length).toBeGreaterThan(0);
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
    expect(screen.getByText(/needs your keys and a connected wallet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
  });
});

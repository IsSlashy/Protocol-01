/**
 * SubscribePanel — the Subscribe tab names a note by its tag, and keeps the
 * subscription's vault and opening transaction off the success card until the
 * user asks for them (UI-1, ledger row D14; fix round 1).
 *
 * The adversary is a screenshot, a screen recording or a support ticket. The
 * vault address and the opening transaction are public on chain and are the
 * spend of the note that paid for the subscription: a card that prints either
 * hands a stranger that spend, and through it the note (while SPEND-1's root
 * and the v3 fallback's republished commitment still lead back to the leaf).
 * The picker is the other surface: a leaf number on a row names the deposit
 * that created the note.
 *
 * HOW THE STATES ARE REACHED. Only what would reach the Web Worker, the network
 * or the chain is stubbed (`@/lib/privacy/shieldClient`, the registry read, the
 * funder lookup, the handoff and subscription stores); the panel, the list
 * merge (`mergeScanWithLocal`, which orders the rows) and the registry's
 * formatting helpers are the real ones.
 *   1. the picker: `scanPool` resolves note views carrying the canaries;
 *   2. the success card: pick the vendor, pick the note, Lock, and
 *      `subscribeFromPool` resolves a vault and a transaction;
 *   3. the swap error: `subscribeFromPool` refuses a self-deposited note, and
 *      `exchangeNoteForIssued` fails after its spend landed (fix round 2: with a
 *      reason that quotes the spend, and the spend's link behind the reveal).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, PublicKey } from "@solana/web3.js";

import SubscribePanel from "@/components/pay/SubscribePanel";
import { BEARER_CLIPBOARD_CLEAR_MS } from "@/lib/pay/bearerClipboard";
import { NATIVE_SOL_SENTINEL_MINT } from "@/lib/privacy/serviceRegistry";
import type { PoolNoteView } from "@/lib/privacy/worker/poolHandlers";

// ---------------------------------------------------------------------------
// Stubs: only what would reach the Worker, the network or the chain.
// ---------------------------------------------------------------------------

const m = vi.hoisted(() => ({
  scanPool: vi.fn(),
  scanPoolLocal: vi.fn(),
  fetchIssuableNote: vi.fn(),
  subscribeFromPool: vi.fn(),
  exchangeNoteForIssued: vi.fn(),
  recordSpentNote: vi.fn(),
  recordSubscription: vi.fn(),
  loadServiceRegistry: vi.fn(),
}));

vi.mock("@/lib/privacy/shieldClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/shieldClient")>();
  return {
    // Real and pure: the list merge orders the picker's rows.
    mergeScanWithLocal: actual.mergeScanWithLocal,
    NOTES_CHANGED_EVENT: actual.NOTES_CHANGED_EVENT,
    SPENT_NOTES_CHANGED_EVENT: actual.SPENT_NOTES_CHANGED_EVENT,
    // Stubbed: every one of these posts to the Worker or reads the chain.
    loadEncryptedNotes: async () => [],
    knownSpentNoteKeys: async () => ({ keys: new Set<string>(), staleWorker: false, lostSession: false }),
    resolveSpentNotes: async () => ({ spent: [] }),
    requestIssuedNote: vi.fn(),
    exchangeNoteForIssued: (...a: unknown[]) => m.exchangeNoteForIssued(...a),
    scanPool: (...a: unknown[]) => m.scanPool(...a),
    scanPoolLocal: (...a: unknown[]) => m.scanPoolLocal(...a),
    fetchIssuableNote: (...a: unknown[]) => m.fetchIssuableNote(...a),
    recordSpentNote: (...a: unknown[]) => m.recordSpentNote(...a),
    subscribeFromPool: (...a: unknown[]) => m.subscribeFromPool(...a),
  };
});

vi.mock("@/lib/privacy/serviceRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy/serviceRegistry")>()),
  loadServiceRegistry: (...a: unknown[]) => m.loadServiceRegistry(...a),
}));

vi.mock("@/lib/privacy/pool/ephemeralFunder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy/pool/ephemeralFunder")>()),
  fetchFunderPubkey: async () => null,
  funderConfigured: () => false,
}));

vi.mock("@/lib/pay/handoffs", () => ({
  HANDOFFS_CHANGED_EVENT: "p01:handoffs-changed",
  handoffKeys: async () => ({ keys: new Set<string>(), staleWorker: false, lostSession: false }),
  recordHandoff: async () => undefined,
  forgetHandoff: async () => undefined,
}));

vi.mock("@/lib/pay/subscriptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay/subscriptions")>()),
  recordSubscription: (...a: unknown[]) => m.recordSubscription(...a),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL = "HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG";
/** Display names (TAG-0 vector `fixtures/noteTagVector.json` and its two
 *  separation cases), as in PoolPanel.test.tsx. */
const TAG = { text: "9PHT-NDYJ", color: "#b8960f" };
const OTHER_TAG = { text: "3TZZ-VRGX", color: "#4f9d4f" };
const THIRD_TAG = { text: "09RX-WVVH", color: "#d4553f" };

/** The UI-1 canaries: a leaf and a commitment no other fixture uses. */
const CANARY_LEAF = 987654;
const CANARY_COMMITMENT = "1357913579135791357";

/** The subscription's on-chain ids. Random base58, so no window of them is a
 *  word the card might say anyway. */
const OPEN_TX_SIG =
  "KoN7W7Qdw8aFPQnTdAhcZcoD5C6MsVaSgvBuqsydBVcsFiqj2xxBtqPF8KWeYCcGVUs5XVAEnpQcYd59bX6cRoQR";
const VAULT = "HiWScz4Qw9wxHd7CEHBCRhYDRRqf37ywyti5Rs4Vtmct";
const LICENSE_KEY = "P01-LICENSE-UNDER-TEST";
/** The exchange's spend, for the swap path. */
const EXCHANGE_SIG =
  "ZMjocsEKiZBmW4V1qgt7NQxxk6DbqRcC7PrcBZDPcKqUxu4crFh8nKgBnhyXfc1S4Z3y7Q8KidQrki6dRcGaCCf";

function canariesIn(html: string): string[] {
  const found: string[] = [];
  if (html.includes(String(CANARY_LEAF))) found.push(String(CANARY_LEAF));
  for (let i = 0; i + 6 <= CANARY_COMMITMENT.length; i++) {
    const w = CANARY_COMMITMENT.slice(i, i + 6);
    if (html.includes(w)) found.push(w);
  }
  return [...new Set(found)];
}

/** Every 4-character window of each id on the page, text or attribute. Four
 *  since fix round 2, as in PoolPanel.test.tsx: a `truncate(vault, 4, 4)` still
 *  picks the vault out of the program's accounts, and a 6-character window let
 *  the card regress to it unseen. No canary here shares a 4-character run with
 *  the card copy, the panel or the stylesheet (see the UI-1 report). */
function idWindowsIn(html: string, ids: string[]): string[] {
  const found: string[] = [];
  for (const id of ids) {
    for (let i = 0; i + 4 <= id.length; i++) if (html.includes(id.slice(i, i + 4))) found.push(id.slice(i, i + 4));
  }
  return [...new Set(found)];
}

const SHOW_IDS = /^Show the on-chain links$/;

const pk = (s: string) => ({ toBase58: () => s, toString: () => s }) as unknown as PublicKey;

const SERVICE = {
  slug: "vpn-under-test",
  name: "Test VPN",
  iconKey: "vpn",
  category: "Privacy",
  retailer: pk("Retai1erUnderTest1111111111111111111111111"),
  priceAtomic: 10_000_000n,
  intervalSlots: 6_480_000n,
  verified: true,
  active: true,
  pda: pk("ServicePdaUnderTest11111111111111111111111"),
  owner: pk("ServiceOwnerUnderTest1111111111111111111111"),
  tokenMint: pk(NATIVE_SOL_SENTINEL_MINT),
};

function noteView(over: Partial<PoolNoteView> = {}): PoolNoteView {
  return {
    pool: POOL,
    token: "SOL",
    denomination: 1,
    counter: 0,
    leafIndex: CANARY_LEAF,
    commitment: CANARY_COMMITMENT,
    spent: false,
    derivation: 1,
    tag: TAG,
    ...over,
  } as PoolNoteView;
}

const OWNER = {
  toBase58: () => "7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU",
  equals: () => false,
} as unknown as PublicKey;

const connection = { rpcEndpoint: "https://fake.test" } as unknown as Connection;
const signOne = vi.fn(async (tx: unknown) => tx);

function renderPanel() {
  return render(
    <SubscribePanel
      meta="meta-1"
      owner={OWNER}
      connection={connection}
      signOne={signOne as never}
      token="SOL"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // A case that installs a fake clock and then times out never reaches its own
  // restore, and every case after it would wait on a timer nothing advances.
  vi.useRealTimers();
  localStorage.clear();
  m.scanPoolLocal.mockResolvedValue({ kind: "poolScanLocal", notes: [], skipped: 0 });
  m.scanPool.mockResolvedValue({ notes: [noteView()], shieldedBalance: 1, poolSizes: [], complete: true });
  m.fetchIssuableNote.mockResolvedValue(null);
  m.recordSpentNote.mockResolvedValue(undefined);
  m.recordSubscription.mockResolvedValue(undefined);
  m.loadServiceRegistry.mockResolvedValue({
    services: [SERVICE],
    fetchedAt: 0,
    matchedAccounts: 1,
    decodeFailures: 0,
    filteredOut: 0,
  });
  m.subscribeFromPool.mockResolvedValue({
    txSig: OPEN_TX_SIG,
    vaultPDA: VAULT,
    licenseKey: LICENSE_KEY,
    licenseScheme: "v2",
    fundedBy: "funder",
    reachableViaDeposit: false,
    reachableViaSpendFunder: false,
    noteProvenance: "received",
  });
});

// ---------------------------------------------------------------------------

describe("the note picker names a note by its tag (UI-1)", () => {
  /** The page once the picker shows one row per note. */
  async function pickerHtml(notes: PoolNoteView[]): Promise<string> {
    m.scanPool.mockResolvedValue({ notes, shieldedBalance: notes.length, poolSizes: [], complete: true });
    const view = renderPanel();
    await waitFor(() => expect(within(view.container).getAllByText(/^1 SOL note$/).length).toBe(notes.length));
    await within(view.container).findByText("Test VPN");
    const html = view.container.innerHTML;
    view.unmount();
    return html;
  }

  it("the picker rows show the tag and no leaf or commitment", async () => {
    const html = await pickerHtml([noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: TAG })]);
    expect(canariesIn(html)).toEqual([]);
    expect(html).toContain(TAG.text);
  });

  it("the picker renders the same rows when only the leaves and commitments differ", async () => {
    // Two notes, then the same two with their leaves swapped and new
    // commitments. A row naming a leaf, by any expression, differs; so does a
    // list ORDERED by leaf.
    const a = await pickerHtml([
      noteView({ leafIndex: 5, commitment: CANARY_COMMITMENT, tag: TAG }),
      noteView({ leafIndex: 9, commitment: "42", tag: OTHER_TAG }),
    ]);
    const b = await pickerHtml([
      noteView({ leafIndex: 9, commitment: "777777", tag: TAG }),
      noteView({ leafIndex: 5, commitment: "888888", tag: OTHER_TAG }),
    ]);
    expect(b).toBe(a);
    // Positive control: a different name IS a different page.
    const c = await pickerHtml([
      noteView({ leafIndex: 5, commitment: CANARY_COMMITMENT, tag: TAG }),
      noteView({ leafIndex: 9, commitment: "42", tag: THIRD_TAG }),
    ]);
    expect(c).not.toBe(a);
  });
});

describe("the success card (UI-1 fix round 1)", () => {
  it("keeps the vault and the opening transaction off the card until asked", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await screen.findByRole("button", { name: /Test VPN/ }));
    await user.click(await screen.findByRole("button", { name: /1 SOL note/ }));
    await user.click(screen.getByRole("button", { name: /^Lock 1 SOL with Test VPN$/ }));
    // Waited on by the card's own heading, not by the key: since web sweep 4
    // round 1 the key itself is behind a click too (the case below), so
    // findByText(LICENSE_KEY) would now wait for something this card does not
    // render.
    await screen.findByText(/License key/);
    expect(m.subscribeFromPool).toHaveBeenCalledTimes(1);
    expect(idWindowsIn(view.container.innerHTML, [OPEN_TX_SIG, VAULT])).toEqual([]);
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    // Positive control: one click away, the vault and the transaction's link.
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    const html = view.container.innerHTML;
    expect(html).toContain(`https://explorer.solana.com/tx/${OPEN_TX_SIG}?cluster=devnet`);
    expect(html).toContain(VAULT.slice(0, 6));
  });

  /**
   * The key itself, web sweep 4 round 1, item 1.
   *
   * The license key is a bearer credential AND it locates the vault: the vault's
   * on-chain `license_commitment` is a hash of the key's secret, so the merchant
   * SDK finds the vault from the key alone (`packages/merchant-sdk/src/
   * merchant-license.ts`, findVaultByLicenseKey). The vault's opening
   * transaction is the spend of the note that paid. So a card printing the key
   * carries, one memcmp away, exactly what the reveal above hides — and the
   * panel stays mounted, so it stayed on screen after a tab switch. It is shown
   * the way SubscriptionsPanel already shows it: after a click.
   */
  it("keeps the license key off the card until asked", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await screen.findByRole("button", { name: /Test VPN/ }));
    await user.click(await screen.findByRole("button", { name: /1 SOL note/ }));
    await user.click(screen.getByRole("button", { name: /^Lock 1 SOL with Test VPN$/ }));
    await screen.findByText(/License key/);
    // Not in the DOM at all: a copy of the page carries no window of it.
    expect(view.container.innerHTML).not.toContain(LICENSE_KEY);
    // Positive control: one click away, the key itself.
    await user.click(screen.getByRole("button", { name: /^Reveal key$/ }));
    expect(view.container.innerHTML).toContain(LICENSE_KEY);
  });

  it("copies the key without ever printing it", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await screen.findByRole("button", { name: /Test VPN/ }));
    await user.click(await screen.findByRole("button", { name: /1 SOL note/ }));
    await user.click(screen.getByRole("button", { name: /^Lock 1 SOL with Test VPN$/ }));
    await screen.findByText(/License key/);
    await user.click(screen.getByRole("button", { name: /^Copy$/ }));
    await expect(navigator.clipboard.readText()).resolves.toBe(LICENSE_KEY);
    expect(view.container.innerHTML).not.toContain(LICENSE_KEY);
  });

  /**
   * The clipboard, web sweep 4 round 1, item 24 (ledger row D8).
   *
   * The license key is a bearer credential and it locates the vault, so leaving
   * it on the clipboard leaves both in Windows' clipboard history and in every
   * device the phone syncs it to. The page takes it back once it has read the
   * clipboard and found its own string still there
   * (`lib/pay/bearerClipboard.ts`).
   */
  it("takes the license key back off the clipboard", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderPanel();
      await user.click(await screen.findByRole("button", { name: /Test VPN/ }));
      await user.click(await screen.findByRole("button", { name: /1 SOL note/ }));
      await user.click(screen.getByRole("button", { name: /^Lock 1 SOL with Test VPN$/ }));
      await screen.findByText(/License key/);
      await user.click(screen.getByRole("button", { name: /^Copy$/ }));
      await expect(navigator.clipboard.readText()).resolves.toBe(LICENSE_KEY);
      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      // An emptied clipboard reads back as "" in a browser; userEvent's stub
      // rejects instead, because writing "" leaves its item with no text
      // flavour. Both mean the key is gone.
      const after = await navigator.clipboard.readText().then(
        (t) => t,
        () => "",
      );
      expect(after).not.toBe(LICENSE_KEY);
      expect(after).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the swap that spent but did not collect says so without quoting the spend", async () => {
    // A self-deposited note is swapped through the exchange; here the exchange
    // spends it and then fails to collect. The sentence is what a user pastes
    // into a support ticket, and the spend leads back to the note it spent.
    // Since fix round 2 the deployment's reason QUOTES the spend, the way the
    // lib's retries-exhausted and no-proof sentences did before that round, so
    // the panel is held to it on its own, whatever the lib says.
    const selfDeposited = new Error("this note was deposited by this wallet");
    selfDeposited.name = "SelfDepositedNoteError";
    m.subscribeFromPool.mockRejectedValueOnce(selfDeposited);
    m.fetchIssuableNote.mockResolvedValue({ denomination: 1, token: "SOL" });
    m.exchangeNoteForIssued.mockRejectedValueOnce(
      Object.assign(new Error(`The deployment could not issue a note just now for payment ${EXCHANGE_SIG}.`), {
        spendSig: EXCHANGE_SIG,
      }),
    );
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await screen.findByRole("button", { name: /Test VPN/ }));
    await user.click(await screen.findByRole("button", { name: /1 SOL note/ }));
    await user.click(screen.getByRole("button", { name: /^Lock 1 SOL with Test VPN$/ }));
    // Positive control: the after-spend sentence, and the deployment's reason.
    await screen.findByText(/so it was exchanged/);
    expect(m.exchangeNoteForIssued).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("The deployment could not issue a note just now");
    expect(idWindowsIn(view.container.innerHTML, [EXCHANGE_SIG])).toEqual([]);
    // For support, the spend is one click away: its own link.
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(`https://explorer.solana.com/tx/${EXCHANGE_SIG}?cluster=devnet`);
  });
});

/**
 * [SWEEP round 1 of run logs8, screen lens] The success card names the circuit
 * that ran.
 *
 * The cost box on this same page promises it (`pay.subscribe.costCommitment`:
 * "the screen after the purchase names which one ran"), and `subscribeFromPool`
 * reports it (`shieldClient.ts`, `version: prep.version`, under "any screen
 * that says 'private' must read it first"). A pre-blinding note confirmed onto
 * the C1 + C3 pair republishes its commitment in the opening transaction, so
 * anyone reading the chain walks from the vault to the deposit; the card then
 * read word for word like a circuit-7 purchase, and so did a screenshot of it.
 * Round 1 gave PoolPanel the `version` branch and left this panel without one
 * (`logs8/r1-screen/probe-sub-circuit.log`).
 *
 * Read on the CARD, not on the page: the `lg:hidden` cost box under the card
 * mentions the pair and the commitment on every render, which is what made the
 * sweep's own regex answer true.
 */
describe("the success card names the circuit that ran (sweep r1, screen)", () => {
  async function cardTextFor(version: "v3" | "v4" | undefined): Promise<string> {
    m.subscribeFromPool.mockResolvedValue({
      txSig: OPEN_TX_SIG,
      vaultPDA: VAULT,
      licenseKey: LICENSE_KEY,
      licenseScheme: "v2",
      fundedBy: "funder",
      reachableViaDeposit: false,
      reachableViaSpendFunder: false,
      noteProvenance: "received",
      ...(version ? { version } : {}),
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await user.click(await screen.findByRole("button", { name: /Test VPN/ }));
    await user.click(await screen.findByRole("button", { name: /1 SOL note/ }));
    await user.click(screen.getByRole("button", { name: /^Lock 1 SOL with Test VPN$/ }));
    const heading = await screen.findByText(/License key/);
    const card = heading.closest(".card");
    if (!card) throw new Error("the success card was not found: the harness, not the panel, is broken");
    const text = card.textContent ?? "";
    view.unmount();
    return text;
  }

  it("the page promises it, so the card owes it", async () => {
    const view = renderPanel();
    await screen.findAllByText(/the screen after the purchase names which one ran/);
    view.unmount();
  });

  it("a C1 + C3 subscription does not read like a circuit-7 one, and says the commitment was republished", async () => {
    const v4 = await cardTextFor("v4");
    const v3 = await cardTextFor("v3");
    expect(v3, "the C1 + C3 card reads exactly like the circuit-7 card").not.toBe(v4);
    expect(v3).toMatch(/C1 \+ C3/);
    expect(v3).toMatch(/republish/);
    expect(v3).toMatch(/commitment/);
    expect(v4).toMatch(/[Cc]ircuit 7/);
    expect(v4).not.toMatch(/C1 \+ C3/);
  });

  it("a result that reports no circuit is never read as circuit 7", async () => {
    const v4 = await cardTextFor("v4");
    const unknown = await cardTextFor(undefined);
    expect(unknown, "an absent version earned the circuit-7 sentence").not.toBe(v4);
    expect(unknown).not.toMatch(/[Cc]ircuit 7 ran/);
    expect(unknown).toMatch(/commitment/);
  });
});

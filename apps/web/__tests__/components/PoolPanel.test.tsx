/**
 * PoolPanel — the Shield tab names a note by its tag, never by its leaf, its
 * commitment, or the leaf somebody's payment funded (UI-1, ledger row D14).
 *
 * The adversary is a screenshot, a screen recording or a support ticket. The
 * code is public, so a leaf number on screen names the deposit that created it
 * (and on the v3 path, every spend of that note); the contribution and exchange
 * cards used to print the funded leaf beside the issued one, which joins the
 * buyer's payment to the note they hold. The tag (`lib/privacy/pool/noteTag.ts`)
 * is a hash of the note's SECRETS: it names the note to its holder and to
 * nobody reading the chain.
 *
 * HOW EACH STATE IS REACHED. Only what would reach the Web Worker or the
 * network is stubbed (`@/lib/privacy/shieldClient`, `@/lib/pay/handoffs`); the
 * panel, the pool tables, `mergeScanWithLocal` and the payout-key derivation
 * are the real ones.
 *   1. the note list: `scanPool` resolves with note views carrying the canaries;
 *   2. the deposit card: Shield, with `fetchIssuableNote` → null, then the
 *      labelled own deposit the panel offers for that answer (READY-1), so
 *      `shieldToPool` resolves an outcome;
 *   3. the contribution card: Shield, with stock on offer, so
 *      `contributeToPool` reports the FUNDED leaf and `requestIssuedNote` the
 *      ISSUED one;
 *   4. the resumed contribution: `resumeContribution` resolves an issued note;
 *   5. the exchange card: Exchange on a row, `exchangeNoteForIssued` resolves
 *      (or, since fix round 2, rejects after its spend landed: the error line);
 *   6. the payout rows: Check, which signs the payout message (the real
 *      derivation) and reads `loadPayouts` plus the re-derived addresses;
 *   7. the recovery line: Recover, with a refusal naming a leaf;
 *   8. a withdrawal: Withdraw, and what `recordPayout` is asked to store.
 * Since fix round 1, the same states also check the on-chain ids each card is
 * about (the deposit, exchange, withdrawal and sweep transactions, the payout
 * addresses): none of them is on the page until the user clicks "Show the
 * on-chain links", and each is there after the click. And the resume path's
 * console line is read for the payment signature and the leaf its error quotes.
 * NOT REACHED here, left to `__tests__/lib/noteIdentifierTripwire.test.ts`: the
 * progress and error strings built in `lib/` (the scan step, a worker refusal,
 * a failed contribution's message). The treasury seed export names no note,
 * but since sweep 2 round 1 it IS reached here, for a different question: that
 * the revealed seed leaves the page ("the revealed pool seed leaves the page").
 * The relayed-withdrawal button needs a relayer URL at build time; one
 * case in state 8 stubs it, for who-paid on its card (FUND-1).
 */

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import PoolPanel from "@/components/pay/PoolPanel";
import NoteTag from "@/components/pay/NoteTag";
import en from "@/i18n/en";
import type { PoolNoteView } from "@/lib/privacy/worker/poolHandlers";

// ---------------------------------------------------------------------------
// Stubs: only what would reach the Worker or the network.
// ---------------------------------------------------------------------------

const m = vi.hoisted(() => ({
  scanPool: vi.fn(),
  scanPoolLocal: vi.fn(),
  loadPayouts: vi.fn(),
  shieldToPool: vi.fn(),
  contributeToPool: vi.fn(),
  requestIssuedNote: vi.fn(),
  fetchIssuableNote: vi.fn(),
  resumeContribution: vi.fn(),
  recoverStuckFunds: vi.fn(),
  unshieldFromPool: vi.fn(),
  exchangeNoteForIssued: vi.fn(),
  recordPayout: vi.fn(),
  recordSpentNote: vi.fn(),
  storeEncryptedNote: vi.fn(),
  sweepPayout: vi.fn(),
  exportPoolSeed: vi.fn(),
}));

vi.mock("@/lib/privacy/shieldClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/shieldClient")>();
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const { bytesToHex, utf8ToBytes } = await import("@noble/hashes/utils.js");
  return {
    // Real and pure: the event names, the list merge (it orders the rows) and
    // the payout message and root.
    NOTES_CHANGED_EVENT: actual.NOTES_CHANGED_EVENT,
    SPENT_NOTES_CHANGED_EVENT: actual.SPENT_NOTES_CHANGED_EVENT,
    mergeScanWithLocal: actual.mergeScanWithLocal,
    buildPoolPayoutMessage: actual.buildPoolPayoutMessage,
    derivePoolPayoutRoot: actual.derivePoolPayoutRoot,
    // The real derivation reads `pool.toBytes()`, which the jsdom PublicKey
    // stub (`__tests__/setup.tsx`) lacks. Same keying (pool, leaf), through a
    // hash, so no digit of the leaf can reach the address the row renders.
    derivePoolPayoutKeypair: (_root: Uint8Array, pool: string, leafIndex: number) => {
      const h = bytesToHex(sha256(utf8ToBytes(`${pool}:${leafIndex}`)));
      return { publicKey: { toBase58: () => `Pay${h.slice(0, 40)}` } };
    },
    // Stubbed: every one of these posts to the Worker or reads the chain.
    loadEncryptedNotes: async () => [],
    knownSpentNoteKeys: async () => ({ keys: new Set<string>(), staleWorker: false, lostSession: false }),
    resolveSpentNotes: async () => ({ spent: [] }),
    scanPool: (...a: unknown[]) => m.scanPool(...a),
    scanPoolLocal: (...a: unknown[]) => m.scanPoolLocal(...a),
    loadPayouts: (...a: unknown[]) => m.loadPayouts(...a),
    shieldToPool: (...a: unknown[]) => m.shieldToPool(...a),
    contributeToPool: (...a: unknown[]) => m.contributeToPool(...a),
    requestIssuedNote: (...a: unknown[]) => m.requestIssuedNote(...a),
    fetchIssuableNote: (...a: unknown[]) => m.fetchIssuableNote(...a),
    resumeContribution: (...a: unknown[]) => m.resumeContribution(...a),
    recoverStuckFunds: (...a: unknown[]) => m.recoverStuckFunds(...a),
    unshieldFromPool: (...a: unknown[]) => m.unshieldFromPool(...a),
    exchangeNoteForIssued: (...a: unknown[]) => m.exchangeNoteForIssued(...a),
    recordPayout: (...a: unknown[]) => m.recordPayout(...a),
    recordSpentNote: (...a: unknown[]) => m.recordSpentNote(...a),
    storeEncryptedNote: (...a: unknown[]) => m.storeEncryptedNote(...a),
    sweepPayout: (...a: unknown[]) => m.sweepPayout(...a),
    exportPoolSeed: (...a: unknown[]) => m.exportPoolSeed(...a),
  };
});

vi.mock("@/lib/pay/handoffs", () => ({
  HANDOFFS_CHANGED_EVENT: "p01:handoffs-changed",
  handoffKeys: async () => ({ keys: new Set<string>(), staleWorker: false, lostSession: false }),
  recordHandoff: async () => undefined,
  forgetHandoff: async () => undefined,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL = "HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG";
/** Display names (TAG-0 vector `fixtures/noteTagVector.json` and its two
 *  separation cases). */
const TAG = { text: "9PHT-NDYJ", color: "#b8960f" };
const OTHER_TAG = { text: "3TZZ-VRGX", color: "#4f9d4f" };
const THIRD_TAG = { text: "09RX-WVVH", color: "#d4553f" };

/** UI-1 canaries. The spec's two, plus a funded leaf and a second commitment
 *  so the contribution and exchange cards can be checked for BOTH leaves. */
const CANARY_LEAF = 987654;
const CANARY_COMMITMENT = "1357913579135791357";
const FUNDED_LEAF = 864209;
const FUNDED_COMMITMENT = "2468024680246802468";

function canariesIn(html: string): string[] {
  const found: string[] = [];
  for (const leaf of [CANARY_LEAF, FUNDED_LEAF]) if (html.includes(String(leaf))) found.push(String(leaf));
  for (const c of [CANARY_COMMITMENT, FUNDED_COMMITMENT]) {
    for (let i = 0; i + 6 <= c.length; i++) if (html.includes(c.slice(i, i + 6))) found.push(c.slice(i, i + 6));
  }
  return [...new Set(found)];
}

/**
 * On-chain ids of the transactions a card is about (UI-1 fix round 1). Random
 * base58, so no window of them is an English word the card might say anyway
 * (the round-0 fixtures, "OwnDepositSig…", share "eposit" with the copy).
 */
const OWN_DEPOSIT_SIG =
  "vwNimHgwVQtepTncg5CiyDBhnbBcLF2zofnc862mZ6fhiDcbZgziETPZNpdaQok2CWXzTePfe2M9TVdC58fHG5VW";
const SECOND_DEPOSIT_SIG =
  "beohszQLt22KUHYv3tn1HAjMfYK1KK2w86b61S8E4PrdUgN5QGQoeGPBPqJbPN8mbyKyAxRV2JExQRp7GPUJBW65";
const EXCHANGE_SIG =
  "ZMjocsEKiZBmW4V1qgt7NQxxk6DbqRcC7PrcBZDPcKqUxu4crFh8nKgBnhyXfc1S4Z3y7Q8KidQrki6dRcGaCCf";
const WITHDRAWAL_SIG =
  "Nmc4TK8MV5jecGCNA94EUJHbTakJ6fNWDjHuRVnA9Co9qgckQtZU73GJxVisXWE4SubXKrhRsAoS7YjAYEJq4S54";
const SWEEP_SIG =
  "dSK5MWRhESFmyKFk5aATQ5eF6eho31ca1aBsq2GZJJRcB8vWBi4CTe8NPz6KFHToD3YAcAmFzyFfA66fVhTjETUo";
const PAYOUT_STORED = "bP4BvGh7tLEP2ccb7trkTucTDA8GDUUYmhyubbzAKEgQ";
const RESUME_PAYMENT_SIG =
  "GxRSaLRdsevkcT7Qbc1o7RF7oCa8G6Rw4Quz4Mqm9mmzJJv1buhdJnYu6F4ECmzNg5wkA2UCWJcbv7CMHuqBYBrG";
/** The spend of an exchange that landed and then failed to collect (fix round 2). */
const SPENT_NOT_COLLECTED_SIG =
  "3bRbsSsMagzXSndAq7e5cbPKwsSFDsYUSU3zxjyRk7x5rAsncakoYSnxJgkTbuNk3dsX8Nd7uMGW36hxwD7bV452";

/**
 * Every 4-character window of each id that the page carries, as text or in an
 * attribute (an explorer href). Four since fix round 2: `truncate(x, 4, 4)` is a
 * style the app already uses for wallets, and a 4-character head plus a
 * 4-character tail still picks one id out of the pool's public transactions, so
 * a 6-character window let a card regress to it unseen. None of these canaries
 * shares a 4-character run with the card copy, the panels or the stylesheet
 * (checked when fix round 2 was written; see the UI-1 report).
 */
function idWindowsIn(html: string, ids: string[]): string[] {
  const found: string[] = [];
  for (const id of ids) {
    for (let i = 0; i + 4 <= id.length; i++) if (html.includes(id.slice(i, i + 4))) found.push(id.slice(i, i + 4));
  }
  return [...new Set(found)];
}

/** The one click that puts a card's on-chain links on screen. */
const SHOW_IDS = /^Show the on-chain links$/;

/** READY-1: the only way to an own deposit once the click has stopped on the
 *  issuance question ("READY-1" below). */
const OWN_DEPOSIT = /^Deposit my own note \(linked to my wallet\)$/;
async function chooseOwnDeposit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: OWN_DEPOSIT }));
}

/** Everything a console call was handed, as text: an Error's name, message,
 *  stack and own properties, an object's full inspection. */
function dumpConsoleArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return [a.name, a.message, a.stack ?? "", inspect(a, { depth: 6 })].join("\n");
  return inspect(a, { depth: 6 });
}

function noteView(over: Partial<PoolNoteView> & { tag?: { text: string; color: string } } = {}): PoolNoteView {
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

/**
 * One entry per RPC REQUEST, holding the addresses that request named.
 *
 * The provider is told a request, not a loop, so the SHAPE of this list is the
 * measurement: a batch names several addresses in one breath and thereby says
 * they belong together, a single read names one (sweep round 1, records 25 and
 * 31). `[...]` of length 2 is a statement about a person; two entries of
 * length 1 are two questions.
 */
type AccountRead = string[];

function connection(reads?: AccountRead[]): Connection {
  return {
    rpcEndpoint: "https://fake.test",
    getBalance: async () => 50_000_000_000,
    getAccountInfo: async (key: { toBase58(): string }) => {
      reads?.push([key.toBase58()]);
      return { lamports: 994_000_000 };
    },
    getMultipleAccountsInfo: async (keys: Array<{ toBase58(): string }>) => {
      reads?.push(keys.map((k) => k.toBase58()));
      return keys.map(() => ({ lamports: 994_000_000 }));
    },
  } as unknown as Connection;
}

const signOne = vi.fn(async (tx: unknown) => tx);
const signMessage = vi.fn(async () => new Uint8Array(64).fill(7));

function renderPanel(opts: { reads?: AccountRead[] } = {}) {
  return render(
    <PoolPanel
      token="SOL"
      meta="meta-1"
      owner={OWNER}
      connection={connection(opts.reads)}
      signOne={signOne as never}
      signMessage={signMessage}
    />,
  );
}

/** The payout address this panel derives for a note, as the stub derivation
 *  above produces it. */
function payoutFor(leafIndex: number, pool = POOL): string {
  return `Pay${bytesToHex(sha256(utf8ToBytes(`${pool}:${leafIndex}`))).slice(0, 40)}`;
}

/** Wait for the note list to hold `count` rows (one Withdraw button each). */
async function waitForRows(count: number) {
  await waitFor(() => expect(screen.queryAllByRole("button", { name: /^Withdraw$/ }).length).toBe(count));
}

function issued(note: PoolNoteView, leafIndex: number) {
  return { note, leafIndex, merklePath: "none", disclosure: "ISSUER DISCLOSURE, rendered verbatim." };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // [flow-speed X8] A deployment built WITH its funder ticket, as production
  // must be: a direct withdrawal is refused at the click without one (the
  // "X8" cases at the end of this file). Nothing else in these cases changes.
  vi.stubEnv("NEXT_PUBLIC_P01_FUNDER_TICKET", "test-ticket");
  m.scanPoolLocal.mockResolvedValue({ kind: "poolScanLocal", notes: [], skipped: 0 });
  m.scanPool.mockResolvedValue({ notes: [noteView()], shieldedBalance: 1, poolSizes: [], complete: true });
  m.loadPayouts.mockResolvedValue({ records: [], staleWorker: false, lostSession: false });
  m.resumeContribution.mockResolvedValue(null);
  m.fetchIssuableNote.mockResolvedValue(null);
  m.storeEncryptedNote.mockResolvedValue(undefined);
  m.recordPayout.mockResolvedValue(undefined);
  m.recordSpentNote.mockResolvedValue(undefined);
  m.recoverStuckFunds.mockResolvedValue({
    keys: 0,
    lamports: 0,
    repaidToFunder: 0,
    closedBuffers: 0,
    refused: [],
  });
});

// ---------------------------------------------------------------------------

describe("the NoteTag component", () => {
  it("shows a well-formed tag as its text and colour dot", () => {
    const { container } = render(<NoteTag tag={TAG} />);
    expect(container.textContent).toBe(TAG.text);
    expect(container.innerHTML).toContain("background-color: rgb(184, 150, 15)");
  });

  it("shows nothing for a value that is not a tag, such as a leaf number", () => {
    // A regression that fed a leaf into `tag.text` must not reach the screen
    // through the one component meant to replace it.
    for (const bad of [
      { text: String(CANARY_LEAF), color: TAG.color },
      { text: "9PHT-NDYJ", color: "red; background: url(x)" },
      { text: "leaf #47", color: TAG.color },
    ]) {
      const { container, unmount } = render(<NoteTag tag={bad} />);
      expect(container.innerHTML, JSON.stringify(bad)).toBe("");
      unmount();
    }
    const { container } = render(<NoteTag tag={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("state 1: the note list", () => {
  it("names each note by its tag, and shows no leaf or commitment", async () => {
    const view = renderPanel();
    await waitForRows(1);
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    expect(within(view.container).getByText(TAG.text)).toBeInTheDocument();
  });

  it("renders the same list when only the leaves and commitments differ", async () => {
    // A row that prints a leaf differs, and so does a list ORDERED by leaf.
    async function listHtml(notes: PoolNoteView[]) {
      m.scanPool.mockResolvedValue({ notes, shieldedBalance: 2, poolSizes: [], complete: true });
      const view = renderPanel();
      await waitForRows(notes.length);
      const html = view.container.innerHTML;
      view.unmount();
      return html;
    }
    const a = await listHtml([
      noteView({ leafIndex: 5, commitment: CANARY_COMMITMENT, tag: TAG }),
      noteView({ leafIndex: 9, commitment: FUNDED_COMMITMENT, tag: OTHER_TAG }),
    ]);
    const b = await listHtml([
      noteView({ leafIndex: 9, commitment: "777777777", tag: TAG }),
      noteView({ leafIndex: 5, commitment: "888888888", tag: OTHER_TAG }),
    ]);
    expect(b).toBe(a);
    // Positive control: a different name IS a different page.
    const c = await listHtml([
      noteView({ leafIndex: 5, commitment: CANARY_COMMITMENT, tag: TAG }),
      noteView({ leafIndex: 9, commitment: FUNDED_COMMITMENT, tag: THIRD_TAG }),
    ]);
    expect(c).not.toBe(a);
  });
});

describe("state 2-4: the success card after a deposit", () => {
  async function shield() {
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    await screen.findByText("Your 1 SOL note is in the pool");
    return view;
  }

  it("an own deposit: the tag, and neither the leaf nor the commitment", async () => {
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    m.shieldToPool.mockResolvedValue({
      txSig: "OwnDepositSig1111111111111111111111111111111",
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "funder",
      walletPaidLamports: 1_013_000_000,
      operatorFeeLamports: 10_000_000,
      tag: TAG,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: /^Shield 1 SOL$/ }));
    await chooseOwnDeposit(user);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    expect(within(view.container).getByText(TAG.text)).toBeInTheDocument();
  });

  it("a contribution: neither the funded leaf, nor the issued leaf, nor the funded deposit", async () => {
    m.fetchIssuableNote.mockResolvedValue({ denomination: 1, token: "SOL" });
    m.contributeToPool.mockResolvedValue({
      txSig: "FundedDepositSig11111111111111111111111111111",
      leafIndex: FUNDED_LEAF,
      commitment: FUNDED_COMMITMENT,
      claimCode: "claim-1",
      fundedBy: "funder",
      depositLanded: true,
    });
    m.requestIssuedNote.mockResolvedValue(
      issued(noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: OTHER_TAG }), CANARY_LEAF),
    );
    const view = await shield();
    const html = view.container.innerHTML;
    expect(canariesIn(html)).toEqual([]);
    // The deposit the buyer's money funded belongs to the treasury and becomes
    // somebody else's note: its transaction is not linked from the buyer's card.
    expect(html).not.toContain("FundedDepositSig");
    // Positive controls: the card is the contribution card, naming the note
    // the buyer now holds.
    expect(within(view.container).getByText(OTHER_TAG.text)).toBeInTheDocument();
    expect(view.container.textContent).toMatch(/treasury owns and you cannot spend/);
  });

  it("a resumed contribution: the tag of the note collected, no leaf", async () => {
    m.resumeContribution.mockResolvedValue(
      issued(noteView({ leafIndex: FUNDED_LEAF, commitment: FUNDED_COMMITMENT, tag: OTHER_TAG }), FUNDED_LEAF),
    );
    const view = await shield();
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    expect(within(view.container).getByText(OTHER_TAG.text)).toBeInTheDocument();
  });

  // UI-1 fix round 1. The own deposit is the path an ordinary buyer takes when
  // the inventory is empty, and its transaction publishes the leaf and the
  // commitment: a screenshot that carries the signature is one explorer lookup
  // from the same join the removed "leaf #N · commitment" line gave.
  function ownDeposit(txSig: string) {
    return {
      txSig,
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "funder",
      walletPaidLamports: 1_013_000_000,
      operatorFeeLamports: 10_000_000,
      tag: TAG,
    };
  }

  it("an own deposit: its transaction stays off the card until asked", async () => {
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    m.shieldToPool.mockResolvedValue(ownDeposit(OWN_DEPOSIT_SIG));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: /^Shield 1 SOL$/ }));
    await chooseOwnDeposit(user);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(idWindowsIn(view.container.innerHTML, [OWN_DEPOSIT_SIG])).toEqual([]);
    // Positive control: one click away, and it is the deposit's own link.
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(
      `https://explorer.solana.com/tx/${OWN_DEPOSIT_SIG}?cluster=devnet`,
    );
  });

  it("a second deposit starts with its transaction hidden again", async () => {
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    m.shieldToPool
      .mockResolvedValueOnce(ownDeposit(OWN_DEPOSIT_SIG))
      .mockResolvedValueOnce(ownDeposit(SECOND_DEPOSIT_SIG));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: /^Shield 1 SOL$/ }));
    await chooseOwnDeposit(user);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(idWindowsIn(view.container.innerHTML, [OWN_DEPOSIT_SIG])).toEqual([]);
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(OWN_DEPOSIT_SIG);
    // The reveal was for THAT deposit; the next result starts closed.
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    await chooseOwnDeposit(user);
    await waitFor(() => expect(m.shieldToPool).toHaveBeenCalledTimes(2));
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(idWindowsIn(view.container.innerHTML, [OWN_DEPOSIT_SIG, SECOND_DEPOSIT_SIG])).toEqual([]);
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(SECOND_DEPOSIT_SIG);
  });
});

describe("the resume path's console line", () => {
  it("a failed resume logs the error class, never its message (payment signature, leaf)", async () => {
    // A resume's error can quote the till payment and the leaf it was owed
    // (`shieldClient.ts`, the confirm and fallback messages). The panel catches
    // it and carries on with a fresh contribution; what it logs on the way must
    // not carry either.
    const failure = new Error(
      `The till payment ${RESUME_PAYMENT_SIG} was not confirmed for leaf ${CANARY_LEAF}.`,
    );
    m.resumeContribution.mockRejectedValueOnce(failure);
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    m.shieldToPool.mockResolvedValue({
      txSig: OWN_DEPOSIT_SIG,
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "funder",
      walletPaidLamports: 1_013_000_000,
      operatorFeeLamports: 10_000_000,
      tag: TAG,
    });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    try {
      const user = userEvent.setup();
      renderPanel();
      await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
      await user.click(await screen.findByRole("button", { name: /^Shield 1 SOL$/ }));
      // The rejection was caught and the click went on, to the issuance
      // question it stops on when the deployment gives no answer (READY-1).
      const own = await screen.findByRole("button", { name: OWN_DEPOSIT });
      expect(m.resumeContribution).toHaveBeenCalledTimes(1);
      // The fresh path ran. The choice pays, so it looks for an unfinished
      // payment first, again: a second resume, which finds none.
      await user.click(own);
      await screen.findByText("Your 1 SOL note is in the pool");
      expect(m.resumeContribution).toHaveBeenCalledTimes(2);
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .flatMap((args) => args.map(dumpConsoleArg))
        .join("\n");
      // Positive controls: the spies see the panel's own line, and the same
      // dump of the error itself carries both canaries.
      expect(logged).toMatch(/resume failed/);
      expect(dumpConsoleArg(failure)).toContain(RESUME_PAYMENT_SIG);
      expect(dumpConsoleArg(failure)).toContain(String(CANARY_LEAF));
      expect(idWindowsIn(logged, [RESUME_PAYMENT_SIG])).toEqual([]);
      expect(logged).not.toContain(String(CANARY_LEAF));
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a resume the worker cannot read stops the shield and pays nothing", async () => {
    // DEV-1: the pending-payment record is sealed, so a worker older than the
    // page cannot open it and cannot say whether a payment is owed. Carrying
    // on with a fresh contribution, as for any other resume failure, could
    // take the denomination a second time.
    const { StaleWorkerError } = await import("@/lib/privacy/sealedStore");
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
    // The mount's own ask (READY-1), before any click.
    await waitFor(() => expect(m.fetchIssuableNote).toHaveBeenCalledTimes(1));
    // Queued only now: a once-value this case never consumed would stay queued
    // (`clearAllMocks` keeps it) and answer the next case's click.
    m.resumeContribution.mockRejectedValueOnce(new StaleWorkerError());
    await user.click(await screen.findByRole("button", { name: /^Shield 1 SOL$/ }));
    await screen.findByText(/Reload the page and try again/);
    expect(m.resumeContribution).toHaveBeenCalledTimes(1);
    expect(m.fetchIssuableNote, "the click went on to the issuance question").toHaveBeenCalledTimes(1);
    expect(m.contributeToPool).not.toHaveBeenCalled();
    expect(m.shieldToPool).not.toHaveBeenCalled();
  });
});

describe("state 5: the exchange card", () => {
  it("names the note received by its tag, and neither the spent nor the issued leaf", async () => {
    m.exchangeNoteForIssued.mockResolvedValue({
      spendSig: "ExchangeSpendSig111111111111111111111111111",
      claimCode: "claim-2",
      issued: issued(
        noteView({ leafIndex: FUNDED_LEAF, commitment: FUNDED_COMMITMENT, tag: OTHER_TAG }),
        FUNDED_LEAF,
      ),
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    await screen.findByText(/Exchanged your 1 SOL note for an older one/);
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    // Positive control: the card shows the note now held, and the issuer's words.
    expect(within(view.container).getByText(OTHER_TAG.text)).toBeInTheDocument();
    expect(view.container.textContent).toContain("ISSUER DISCLOSURE, rendered verbatim.");
  });

  it("keeps the exchange's withdrawal off the card until asked", async () => {
    // The exchange spends the held note; its transaction carries the spend's
    // root and nullifier, which lead back to that note.
    m.exchangeNoteForIssued.mockResolvedValue({
      spendSig: EXCHANGE_SIG,
      claimCode: "claim-2",
      issued: issued(
        noteView({ leafIndex: FUNDED_LEAF, commitment: FUNDED_COMMITMENT, tag: OTHER_TAG }),
        FUNDED_LEAF,
      ),
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    await screen.findByText(/Exchanged your 1 SOL note for an older one/);
    expect(idWindowsIn(view.container.innerHTML, [EXCHANGE_SIG])).toEqual([]);
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(
      `https://explorer.solana.com/tx/${EXCHANGE_SIG}?cluster=devnet`,
    );
  });

  // Fix round 2. After its withdrawal lands, a failed exchange throws an error
  // that carries the spend on `.spendSig`, and the panel prints the message on
  // its error line: the sentence a user pastes into a support ticket. This
  // message quotes the signature the way the lib's retries-exhausted sentence
  // did before fix round 2, so the panel is held to it on its own, whatever the
  // lib says.
  it("an exchange that spent but did not collect keeps the spend off the error line until asked", async () => {
    m.exchangeNoteForIssued.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `The deployment could not find payment ${SPENT_NOT_COLLECTED_SIG} after 10 attempts. ` +
            "The withdrawal paid the till and its receipt is kept on this device.",
        ),
        { name: "ExchangeAfterSpendError", spendSig: SPENT_NOT_COLLECTED_SIG },
      ),
    );
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    // Positive control: the error line is up, with the rest of the sentence.
    await screen.findByText(/its receipt is kept on this device/);
    expect(idWindowsIn(view.container.innerHTML, [SPENT_NOT_COLLECTED_SIG])).toEqual([]);
    // For support, the spend is one click away: its own link.
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(
      `https://explorer.solana.com/tx/${SPENT_NOT_COLLECTED_SIG}?cluster=devnet`,
    );
  });

  it("a later error on the same line drops the earlier spend's link", async () => {
    // Recover writes the same error line and does not know about the spend;
    // the reveal is bound to the sentence it was offered with.
    m.exchangeNoteForIssued.mockRejectedValueOnce(
      Object.assign(new Error("The withdrawal paid the till and its receipt is kept on this device."), {
        name: "ExchangeAfterSpendError",
        spendSig: SPENT_NOT_COLLECTED_SIG,
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    await screen.findByText(/its receipt is kept on this device/);
    // Positive control: the link was on offer for the exchange's own error.
    expect(screen.getByRole("button", { name: SHOW_IDS })).toBeInTheDocument();
    // Queued only now: `clearAllMocks` keeps once-values, so a rejection queued
    // earlier would reach the next test's Recover if this one stopped above.
    m.recoverStuckFunds.mockRejectedValueOnce(new Error("RECOVERY FAILED, rendered verbatim."));
    await user.click(screen.getByRole("button", { name: /Recover funds from a failed attempt/ }));
    await screen.findByText(/RECOVERY FAILED, rendered verbatim\./);
    expect(screen.queryByRole("button", { name: SHOW_IDS })).toBeNull();
  });

  it("an exchange refused before its spend offers no on-chain link", async () => {
    m.exchangeNoteForIssued.mockRejectedValueOnce(
      new Error("This deployment issues no notes right now, so there is nothing to exchange yours for. Nothing was spent."),
    );
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    await screen.findByText(/Nothing was spent\./);
    expect(screen.queryByRole("button", { name: SHOW_IDS })).toBeNull();
  });
});

/**
 * Sweep round 1 (2026-09-20) moved the three worlds below off an UNSPENT note.
 *
 * They used to list one unspent note, press Check, and expect a Sweep row for
 * that note's re-derived payout address — a row for a withdrawal that never
 * happened. That row was the leak (records 25 and 31): the address is the
 * cleartext recipient of the note's FUTURE withdrawal, and Check named it to
 * the provider before the withdrawal existed. The worlds now carry the unspent
 * note (so the list still renders and the scan is still waited on) PLUS a
 * spent one, and the payout row belongs to the spent note. What each test
 * asserts — tags never leaves, addresses behind the reveal, the sweep
 * transaction behind the reveal — is unchanged.
 */
const SPENT_LEAF = 555_111;

/** A world holding one unspent note (`TAG`) and one spent note (`THIRD_TAG`). */
function oneSpentOneHeld() {
  m.scanPool.mockResolvedValue({
    notes: [
      noteView({ leafIndex: CANARY_LEAF, tag: TAG }),
      noteView({ leafIndex: SPENT_LEAF, commitment: "9911223344556677", spent: true, tag: THIRD_TAG }),
    ],
    shieldedBalance: 1,
    poolSizes: [],
    complete: true,
  });
}

describe("state 6: the payout rows", () => {
  it("names each payout by the tag of the note it came from, never by its leaf", async () => {
    oneSpentOneHeld();
    m.loadPayouts.mockResolvedValue({
      records: [
        {
          pool: POOL,
          leafIndex: FUNDED_LEAF,
          address: "PayoutAddr1111111111111111111111111111111111",
          txSig: "PayoutWithdrawalSig",
          denomination: 1,
          tag: OTHER_TAG,
        },
      ],
      staleWorker: false,
      lostSession: false,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    // Two rows: the stored record, and the address re-derived from the SPENT note.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Sweep$/ }).length).toBe(2));
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    expect(within(view.container).getByText(OTHER_TAG.text)).toBeInTheDocument();
    // The re-derived row carries the spent note's tag.
    expect(within(view.container).getByText(THIRD_TAG.text)).toBeInTheDocument();
    // And the held note is still named by its tag in the list above.
    expect(within(view.container).getByText(TAG.text)).toBeInTheDocument();
  });

  it("keeps each payout address off the rows until asked", async () => {
    // A payout address is the withdrawal's recipient, in the clear in that
    // transaction: on screen it names the withdrawal.
    oneSpentOneHeld();
    m.loadPayouts.mockResolvedValue({
      records: [
        {
          pool: POOL,
          leafIndex: FUNDED_LEAF,
          address: PAYOUT_STORED,
          txSig: "PayoutWithdrawalSig",
          denomination: 1,
          tag: OTHER_TAG,
        },
      ],
      staleWorker: false,
      lostSession: false,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Sweep$/ }).length).toBe(2));
    // The re-derived row's address, as the panel derives it for the spent note.
    const derived = payoutFor(SPENT_LEAF);
    expect(idWindowsIn(view.container.innerHTML, [PAYOUT_STORED, derived])).toEqual([]);
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    const html = view.container.innerHTML;
    expect(html).toContain(PAYOUT_STORED.slice(0, 6));
    expect(html).toContain(derived.slice(0, 6));
  });

  it("the sweep line keeps the sweep transaction off the screen until asked", async () => {
    oneSpentOneHeld();
    m.sweepPayout.mockResolvedValue({ txSig: SWEEP_SIG, lamports: 994_000_000 });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Sweep$/ }).length).toBe(1));
    await user.type(screen.getByPlaceholderText("Destination address"), "SweepDestination1111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: /^Sweep$/ }));
    await waitFor(() => expect(m.sweepPayout).toHaveBeenCalledTimes(1));
    await screen.findByText(/^Swept 0\.9940 SOL/);
    expect(idWindowsIn(view.container.innerHTML, [SWEEP_SIG])).toEqual([]);
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    expect(view.container.innerHTML).toContain(SWEEP_SIG.slice(0, 8));
  });
});

// ---------------------------------------------------------------------------
// Sweep round 1 (2026-09-20), lane pool-ui: the six records this panel owns.
// ---------------------------------------------------------------------------

/**
 * Records 25 and 31 (HIGH), two angles on one button.
 *
 * `refreshPayouts` re-derived a payout address for EVERY scanned note and sent
 * the lot in one `getMultipleAccountsInfo`. A payout address is the cleartext
 * recipient of that note's withdrawal (`unshieldFromPool({ recipient: payout
 * .publicKey })`), so for an unspent note it is the payee of a withdrawal that
 * has not happened — named to the provider from the same session that also
 * calls `getBalance(owner)`. And one batch of them is a statement that these
 * unrelated-looking addresses belong to one person, which is the join the
 * per-note payout address exists to prevent. The file's own comment above
 * `handleUnshield` says exactly this; it had only removed the AUTOMATIC call.
 */
describe("sweep 1, records 25 + 31: what Check asks the RPC", () => {
  it("names no payout address of a note that has not been spent", async () => {
    m.scanPool.mockResolvedValue({
      notes: [
        noteView({ leafIndex: CANARY_LEAF, tag: TAG }),
        noteView({ leafIndex: SPENT_LEAF, commitment: "9911223344556677", spent: true, tag: THIRD_TAG }),
      ],
      shieldedBalance: 1,
      poolSizes: [],
      complete: true,
    });
    const reads: AccountRead[] = [];
    const user = userEvent.setup();
    renderPanel({ reads });
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    await waitFor(() => expect(reads.length).toBeGreaterThan(0));
    expect(
      [...new Set(reads.flat())],
      "Check named the payee of a withdrawal that has not happened",
    ).toEqual([payoutFor(SPENT_LEAF)]);
  });

  it("asks about each payout address in its own request, never one batch that groups them", async () => {
    m.scanPool.mockResolvedValue({
      notes: [
        noteView({ leafIndex: CANARY_LEAF, tag: TAG }),
        noteView({ leafIndex: SPENT_LEAF, commitment: "9911223344556677", spent: true, tag: THIRD_TAG }),
      ],
      shieldedBalance: 1,
      poolSizes: [],
      complete: true,
    });
    m.loadPayouts.mockResolvedValue({
      records: [
        {
          pool: POOL,
          leafIndex: FUNDED_LEAF,
          address: PAYOUT_STORED,
          txSig: "PayoutWithdrawalSig",
          denomination: 1,
          tag: OTHER_TAG,
        },
      ],
      staleWorker: false,
      lostSession: false,
    });
    const reads: AccountRead[] = [];
    const user = userEvent.setup();
    renderPanel({ reads });
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    await waitFor(() => expect(reads.flat().length).toBe(2));
    expect(
      reads.map((r) => r.length),
      "one request carried several payout addresses, which says they are one person's",
    ).toEqual([1, 1]);
    expect(new Set(reads.flat())).toEqual(new Set([PAYOUT_STORED, payoutFor(SPENT_LEAF)]));
  });

  it("offers the deep check as its own labelled button, which is the only thing that reads an unspent note's address", async () => {
    const reads: AccountRead[] = [];
    const user = userEvent.setup();
    renderPanel({ reads });
    await waitForRows(1);
    const deep = screen.queryAllByRole("button", {
      name: /^Check unspent notes too \(tells the RPC which addresses are yours\)$/,
    });
    expect(deep.length, "the deep check is not on the panel as its own labelled button").toBe(1);
    await user.click(deep[0]!);
    await waitFor(() => expect(reads.flat()).toEqual([payoutFor(CANARY_LEAF)]));
  });

  it("a sweep that emptied an address does not re-read every other one", async () => {
    oneSpentOneHeld();
    m.sweepPayout.mockResolvedValue({ txSig: SWEEP_SIG, lamports: 994_000_000 });
    const reads: AccountRead[] = [];
    const user = userEvent.setup();
    renderPanel({ reads });
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Sweep$/ }).length).toBe(1));
    const afterCheck = reads.length;
    await user.type(screen.getByPlaceholderText("Destination address"), "SweepDestination1111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: /^Sweep$/ }));
    await screen.findByText(/^Swept 0\.9940 SOL/);
    expect(reads.length - afterCheck, "the sweep asked the RPC about payout addresses again").toBe(0);
  });
});

/**
 * Record 2 (medium): the withdrawal card said the spend carries no commitment
 * whatever circuit ran. `unshieldFromPool` reports `version`, and a
 * pre-blinding note reaches the C1 + C3 pair after `confirmPreBlindingSpend`'s
 * disclosure (V3-1) — that pair publishes the note commitment, the value the
 * deposit published. The card dropped `version` on the floor.
 */
describe("sweep 1, record 2: the withdrawal card names the circuit that ran", () => {
  function withdrawal(version: "v3" | "v4") {
    m.unshieldFromPool.mockResolvedValue({
      txSig: WITHDRAWAL_SIG,
      denomination: 1,
      fundedBy: "funder",
      version,
    });
  }

  async function withdraw() {
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Withdraw$/ }));
    await screen.findByText("Withdrew 1 SOL");
    return { user, view, text: view.container.textContent ?? "" };
  }

  it("a C1 + C3 spend: the card never says the withdrawal carries no commitment", async () => {
    withdrawal("v3");
    const { text } = await withdraw();
    expect(text, "the card kept the circuit-7 sentence after a C1 + C3 spend").not.toContain(
      "carries no commitment",
    );
    expect(text).toContain("publishes this note’s commitment");
  });

  it("a circuit-7 spend still says it, word for word", async () => {
    withdrawal("v4");
    const { text } = await withdraw();
    expect(text).toContain("carries no commitment");
    expect(text).not.toContain("publishes this note’s commitment");
  });
});

/**
 * Record 7 (low): after a sweep the destination stayed in the input beside
 * "Swept X SOL" and the note-tagged rows — on chain that pair IS the sweep, and
 * the sweep leads to the withdrawal, which is why UI-1 put the sweep
 * transaction behind the reveal. And a confirm that expires puts web3.js's
 * `Signature <sig> has expired` straight on the red line.
 */
describe("sweep 1, record 7: what the sweep leaves on the screen", () => {
  const SWEEP_DEST = "SweepDestination1111111111111111111111111111";

  /** Two payout rows, so the sweep form is still on screen after one of them
   *  is swept and the destination field can be read. */
  async function sweepWorld(rows = 2) {
    oneSpentOneHeld();
    if (rows > 1) {
      m.loadPayouts.mockResolvedValue({
        records: [
          {
            pool: POOL,
            leafIndex: FUNDED_LEAF,
            address: PAYOUT_STORED,
            txSig: "PayoutWithdrawalSig",
            denomination: 1,
            tag: OTHER_TAG,
          },
        ],
        staleWorker: false,
        lostSession: false,
      });
    }
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Check$/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Sweep$/ }).length).toBe(rows));
    await user.type(screen.getByPlaceholderText("Destination address"), SWEEP_DEST);
    // The LAST row: the one re-derived from the spent note, whose address the
    // panel can re-derive and therefore sign for. The stored-record row above
    // it carries a fixture address that no derivation reproduces, which
    // `handleSweep`'s own belt-and-braces check refuses.
    const sweepButtons = screen.getAllByRole("button", { name: /^Sweep$/ });
    await user.click(sweepButtons[sweepButtons.length - 1]!);
    return { user, view };
  }

  it("clears the destination once the sweep has gone through", async () => {
    m.sweepPayout.mockResolvedValue({ txSig: SWEEP_SIG, lamports: 994_000_000 });
    const { view } = await sweepWorld();
    // Positive control: the sweep did happen and the line says so.
    await screen.findByText(/^Swept 0\.9940 SOL/);
    const input = screen.getByPlaceholderText("Destination address") as HTMLInputElement;
    expect(input.value, "the destination stayed beside the swept amount").toBe("");
    expect(view.container.innerHTML).not.toContain(SWEEP_DEST);
  });

  it("a sweep whose confirmation expired says so without printing the signature", async () => {
    m.sweepPayout.mockRejectedValue(
      new Error(`Signature ${SWEEP_SIG} has expired: block height exceeded.`),
    );
    const { view } = await sweepWorld(1);
    await screen.findByText(/has expired: block height exceeded/);
    expect(idWindowsIn(view.container.innerHTML, [SWEEP_SIG])).toEqual([]);
  });
});

/**
 * Record 34 (low): `?treasury=1` turned the ordinary Deposit button into a
 * public wallet -> ephemeral -> leaf deposit with an ephemeral -> wallet sweep,
 * skipping the swap and READY-1's stock question, with no word at the button.
 * Anyone who gets a user to open a link carrying that parameter gets their next
 * deposit published and tied to their wallet.
 */
describe("sweep 1, record 34: ?treasury=1 and the Deposit button", () => {
  const SHIELD = /^Shield 1 SOL$/;
  const CONFIRM = /^Deposit in public, named as the treasury$/;

  beforeEach(() => {
    window.history.replaceState({}, "", "/pay?treasury=1");
    m.shieldToPool.mockResolvedValue({
      txSig: OWN_DEPOSIT_SIG,
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "wallet",
      walletPaidLamports: 1_013_000_000,
      tag: TAG,
    });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/pay");
  });

  it("the ordinary click publishes nothing: it stops on a labelled confirmation", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(await screen.findByRole("button", { name: SHIELD }));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: CONFIRM }).length).toBe(1));
    expect(m.shieldToPool, "the treasury deposit ran on the ordinary click").not.toHaveBeenCalled();
  });

  it("the labelled confirmation is the only thing that makes the public deposit", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(await screen.findByRole("button", { name: SHIELD }));
    const confirm = screen.queryAllByRole("button", { name: CONFIRM });
    expect(confirm.length, "no labelled confirmation to press").toBe(1);
    await user.click(confirm[0]!);
    await waitFor(() => expect(m.shieldToPool).toHaveBeenCalledTimes(1));
    expect(m.shieldToPool.mock.calls[0]![0]).toMatchObject({ depositPublicly: true });
  });

  it("without the parameter the button is the ordinary one and no confirmation appears", async () => {
    window.history.replaceState({}, "", "/pay");
    m.fetchIssuableNote.mockResolvedValue({ denomination: 1, token: "SOL", issuableNow: true });
    m.contributeToPool.mockResolvedValue({
      txSig: SECOND_DEPOSIT_SIG,
      leafIndex: FUNDED_LEAF,
      commitment: FUNDED_COMMITMENT,
      claimCode: "claim-1",
      fundedBy: "funder",
      depositLanded: true,
    });
    m.requestIssuedNote.mockResolvedValue(issued(noteView({ tag: OTHER_TAG }), CANARY_LEAF));
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(await screen.findByRole("button", { name: SHIELD }));
    await waitFor(() => expect(m.contributeToPool).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole("button", { name: CONFIRM }).length).toBe(0);
    expect(m.shieldToPool).not.toHaveBeenCalled();
  });
});

/**
 * Sweep 2 round 1 (screen lens, low): under `?treasury=1` one labelled press
 * prints the identity's pool seed, and nothing ever took it back. `setSeedHex`
 * had one call site, so the value stayed on the page for the whole session: no
 * Hide, no timeout, and PayApp keeps a visited tab mounted under
 * `class="hidden"`, so it stayed in the DOM after the operator left the tab.
 * The adversary is a later screenshot, screen share or recording (the operator
 * records demos on this URL) or a saved copy of the page.
 *
 * The one-press reveal itself is deliberate and stays: the operator has to read
 * the value to set P01_TREASURY_POOL_SEED. What these cases hold is that the
 * value LEAVES: on Hide, when the tab is hidden, when the browser tab goes to
 * the background, and on its own after a while. Each case first proves the
 * seed was on the page, so a reveal that silently stopped working cannot pass
 * for "it left".
 */
describe("sweep 2 round 1: the revealed pool seed leaves the page", () => {
  const SEED = "5eed".repeat(16);
  const REVEAL = /^Reveal pool seed/;
  const LEGACY = /legacy seed/;

  beforeEach(() => {
    window.history.replaceState({}, "", "/pay?treasury=1");
    m.exportPoolSeed.mockResolvedValue({
      kind: "poolExportSeed",
      seedHex: SEED,
      derivation: 2,
      hasLegacySeed: true,
    });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/pay");
  });

  /** Render the panel the way PayApp does: inside the div it hides. */
  function renderInTab() {
    const view = render(
      <div data-testid="pool-tab">
        <PoolPanel
          token="SOL"
          meta="meta-1"
          owner={OWNER}
          connection={connection()}
          signOne={signOne as never}
          signMessage={signMessage}
        />
      </div>,
    );
    return view;
  }

  async function reveal(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
    await user.click(await screen.findByRole("button", { name: REVEAL }));
    await waitFor(() => expect(container.innerHTML.includes(SEED), "the reveal printed nothing").toBe(true));
  }

  it("a Hide control takes the seed and its legacy warning out of the DOM, and Reveal still works after", async () => {
    const user = userEvent.setup();
    const view = renderInTab();
    await waitForRows(1);
    expect(view.container.innerHTML.includes(SEED), "the seed is on the page before any press").toBe(false);
    await reveal(user, view.container);
    expect(view.container.textContent).toMatch(LEGACY);

    const hide = screen.queryAllByRole("button", { name: /^Hide$/ });
    expect(hide.length, "the seed has no control that takes it off the screen").toBe(1);
    await user.click(hide[0]!);
    expect(view.container.innerHTML.includes(SEED), "the seed is still in the DOM after Hide").toBe(false);
    expect(view.container.textContent).not.toMatch(LEGACY);
    expect(screen.queryAllByRole("button", { name: /^Hide$/ }).length).toBe(0);

    // The operator flow survives: a second press prints it again.
    await reveal(user, view.container);
    expect(m.exportPoolSeed).toHaveBeenCalledTimes(2);
  });

  it("the seed leaves the DOM when PayApp hides the tab", async () => {
    const user = userEvent.setup();
    const view = renderInTab();
    await waitForRows(1);
    await reveal(user, view.container);

    // What PayApp's keep-alive does on a tab switch (PayApp.tsx, `show(t)`).
    screen.getByTestId("pool-tab").className = "hidden";
    await waitFor(() =>
      expect(view.container.innerHTML.includes(SEED), "the hidden tab still carries the seed").toBe(false),
    );
  });

  it("the seed leaves the DOM when the browser tab goes to the background", async () => {
    const user = userEvent.setup();
    const view = renderInTab();
    await waitForRows(1);
    await reveal(user, view.container);

    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() =>
        expect(view.container.innerHTML.includes(SEED), "a backgrounded page still carries the seed").toBe(false),
      );
    } finally {
      state.mockRestore();
    }
  });

  it("the seed clears itself within five minutes of the press, with nothing pressed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = renderInTab();
      await waitForRows(1);
      await reveal(user, view.container);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await waitFor(() =>
        expect(view.container.innerHTML.includes(SEED), "the seed is still printed five minutes later").toBe(false),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a seed that arrives after the tab was hidden is never printed", async () => {
    let release: (v: unknown) => void = () => undefined;
    m.exportPoolSeed.mockReturnValue(new Promise((r) => (release = r)));
    const user = userEvent.setup();
    const view = renderInTab();
    await waitForRows(1);
    await user.click(await screen.findByRole("button", { name: REVEAL }));
    await waitFor(() => expect(m.exportPoolSeed).toHaveBeenCalledTimes(1));

    screen.getByTestId("pool-tab").className = "hidden";
    const seen: boolean[] = [];
    const watch = new MutationObserver(() => seen.push(view.container.innerHTML.includes(SEED)));
    watch.observe(view.container, { childList: true, subtree: true, characterData: true });
    release({ kind: "poolExportSeed", seedHex: SEED, derivation: 2, hasLegacySeed: false });
    await new Promise((r) => setTimeout(r, 150));
    watch.disconnect();
    expect(seen.includes(true), "the late seed was committed to the hidden DOM").toBe(false);
    expect(view.container.innerHTML.includes(SEED)).toBe(false);
  });
});

describe("state 7: the recovery line", () => {
  it("says how much is left and why, without naming the note's leaf", async () => {
    m.recoverStuckFunds.mockResolvedValueOnce({
      keys: 1,
      lamports: 0,
      repaidToFunder: 0,
      closedBuffers: 0,
      refused: [
        {
          ephemeral: "Ephemeral111111111111111111111111111111111",
          leafIndex: CANARY_LEAF,
          lamports: 987_600_000,
          reason: "unknown-funder",
          sentence: "REFUSAL SENTENCE, rendered verbatim.",
          sources: [],
        },
      ],
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Recover funds from a failed attempt/ }));
    await screen.findByText(/REFUSAL SENTENCE, rendered verbatim\./);
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
    // Positive control: the amount and the reason are still said.
    expect(view.container.textContent).toContain("0.9876 SOL");
  });
});

describe("state 8: a withdrawal", () => {
  it("stores the note's tag with the payout record, so the row can name it later", async () => {
    m.unshieldFromPool.mockResolvedValue({
      txSig: "WithdrawalSig1111111111111111111111111111111",
      denomination: 1,
      payout: "unused",
      fundedBy: "funder",
      version: "v4",
    });
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Withdraw$/ }));
    await waitFor(() => expect(m.recordPayout).toHaveBeenCalledTimes(1));
    expect(m.recordPayout.mock.calls[0][2]).toMatchObject({ pool: POOL, tag: TAG });
  });

  it("the withdrawal card keeps its transaction and payout address off the screen until asked", async () => {
    m.unshieldFromPool.mockResolvedValue({
      txSig: WITHDRAWAL_SIG,
      denomination: 1,
      payout: "unused",
      fundedBy: "funder",
      version: "v4",
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Withdraw$/ }));
    await screen.findByText("Withdrew 1 SOL");
    const payout = (m.recordPayout.mock.calls[0][2] as { address: string }).address;
    expect(idWindowsIn(view.container.innerHTML, [WITHDRAWAL_SIG, payout])).toEqual([]);
    await user.click(screen.getByRole("button", { name: SHOW_IDS }));
    const html = view.container.innerHTML;
    expect(html).toContain(`https://explorer.solana.com/tx/${WITHDRAWAL_SIG}?cluster=devnet`);
    expect(html).toContain(payout.slice(0, 6));
  });

  // FUND-1, web sweep prep (2026-09-19). The relayed path funds nothing: the
  // relayer signs and pays. The card used to put every answer that was not
  // 'funder' in the wallet branch, "Your wallet paid for this, in public",
  // which said the opposite of what happened. The client half, that the
  // relayed path answers 'relayer', is `lib/privacy/pool/unshieldV4ClientRouting.test.ts`,
  // "a relayed withdrawal reports the relayer as its payer, and asks nobody to fund it".
  it("a relayed withdrawal's card says the relayer paid, and never that the wallet did", async () => {
    vi.stubEnv("NEXT_PUBLIC_P01_SPEND_RELAYER_URL", "https://relayer.test");
    try {
      m.unshieldFromPool.mockResolvedValue({
        txSig: WITHDRAWAL_SIG,
        denomination: 1,
        fundedBy: "relayer",
        version: "v4",
      });
      const user = userEvent.setup();
      const view = renderPanel();
      await waitForRows(1);
      await user.click(screen.getByRole("button", { name: /^Withdraw via relayer$/ }));
      await screen.findByText("Withdrew 1 SOL");
      expect(m.unshieldFromPool.mock.calls[0][0]).toMatchObject({ relayerUrl: "https://relayer.test" });
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("Your wallet paid for this");
      expect(text).toContain("The relayer paid for this, not your wallet.");
      expect(text).toContain("The relayer also saw the request and where it came from.");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("RECOVER-1: Recover reads a note's spend key only when that note is marked, unless asked", () => {
  // The default click must not name the key that will pay for a note never
  // spent (`lib/privacy/pool/recoverReads.test.ts` measures what reaches the
  // RPC). The panel still hands over every held note; the lib keeps the
  // marked ones. Checking every note is its own labelled click.
  const RECOVER = /Recover funds from a failed attempt/;
  const EVERY_NOTE = /Check every note/;

  async function clickAndSettle(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await user.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(m.recoverStuckFunds).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: RECOVER })).toBeEnabled());
  }

  it("the default click asks for no deep check; a labelled button asks for it on every pool", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await clickAndSettle(user, RECOVER);
    const pools = m.recoverStuckFunds.mock.calls.length;
    expect(pools).toBeGreaterThan(0);
    // Positive control: the held note is still handed over, to its own pool.
    expect(m.recoverStuckFunds.mock.calls.some((c) => (c[4] as number[]).includes(CANARY_LEAF))).toBe(true);
    for (const call of m.recoverStuckFunds.mock.calls) {
      expect(Boolean((call[5] as { everyNote?: unknown } | undefined)?.everyNote)).toBe(false);
    }

    m.recoverStuckFunds.mockClear();
    const deep = screen.queryByRole("button", { name: EVERY_NOTE });
    expect(deep, 'a "Check every note" button').not.toBeNull();
    // The label is the disclosure: it says what the click tells the RPC.
    expect(deep!.textContent).toMatch(/tells the RPC which keys are yours/);
    await clickAndSettle(user, EVERY_NOTE);
    expect(m.recoverStuckFunds.mock.calls.length).toBe(pools);
    for (const call of m.recoverStuckFunds.mock.calls) {
      expect((call[5] as { everyNote?: unknown } | undefined)?.everyNote).toBe(true);
    }
  });

  it("a default click that left notes unchecked says how many, and never says nothing is stranded anywhere", async () => {
    m.recoverStuckFunds.mockResolvedValueOnce({
      keys: 0,
      lamports: 0,
      repaidToFunder: 0,
      closedBuffers: 0,
      refused: [],
      skippedNotes: 2,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: RECOVER }));
    await waitFor(() => expect(view.container.textContent).toContain("2 note(s) with no withdrawal"));
    expect(view.container.textContent).not.toContain("Nothing stranded in any pool");
    // Positive control: with nothing left unchecked, the all-clear is still said.
    await clickAndSettle(user, RECOVER);
    await waitFor(() => expect(view.container.textContent).toContain("Nothing stranded in any pool"));
    expect(view.container.textContent).not.toContain("note(s) with no withdrawal");
  });
});

// ---------------------------------------------------------------------------
// READY-1: the Shield click never becomes an own deposit without a choice.
// ---------------------------------------------------------------------------

/**
 * READY-1 (map-A defect 6). The readiness GET now says whether a note can be
 * handed over NOW (`issuableNow`: one sample per 10-minute bucket, pinned by
 * `__tests__/api/issue-note.test.ts` "READY-1"; the client carries it as said,
 * `lib/privacy/pool/contributeFallback.test.ts` "READY-1"). The panel read
 * "configured" and nothing else:
 *   - a deployment that could not answer made the click deposit the buyer's
 *     own note, the one their payment creates, without a word;
 *   - stock that was all too young was paid for regardless.
 * Now:
 *   - `issuableNow` false: nothing is paid until the buyer picks Continue
 *     (today's path) or a labelled own deposit;
 *   - no answer: nothing is paid, and the labelled own deposit is the only
 *     choice, because there is no issuer to continue to;
 *   - true, not sampled yet (null), or a server from before READY-1: today's
 *     path at once, as before.
 * No wait time is shown: the GET carries none.
 */
describe("READY-1: the Shield click never becomes an own deposit without a choice", () => {
  const NOT_YET = { denomination: 1, token: "SOL", issuableNow: false };
  const OWN = /^Deposit my own note \(linked to my wallet\)$/;
  const CONTINUE = /^Continue$/;
  const SHIELD = /^Shield 1 SOL$/;

  function ownDepositOutcome() {
    return {
      txSig: OWN_DEPOSIT_SIG,
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "funder",
      walletPaidLamports: 1_013_000_000,
      operatorFeeLamports: 10_000_000,
      tag: TAG,
    };
  }

  /** Both paths answer, so a test sees which one the click took. */
  async function setup() {
    m.contributeToPool.mockResolvedValue({
      txSig: "FundedDepositSig11111111111111111111111111111",
      leafIndex: FUNDED_LEAF,
      commitment: FUNDED_COMMITMENT,
      claimCode: "claim-ready",
      fundedBy: "funder",
      depositLanded: true,
    });
    m.requestIssuedNote.mockResolvedValue(
      issued(noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: OTHER_TAG }), CANARY_LEAF),
    );
    m.shieldToPool.mockResolvedValue(ownDepositOutcome());
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
    await screen.findByRole("button", { name: SHIELD });
    return { user, view };
  }

  /** Click Shield and wait for the click to run to its end. */
  async function clickShield(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: SHIELD }));
    await waitFor(() => expect(m.resumeContribution).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: SHIELD })).toBeEnabled());
  }

  it("issuableNow false with no choice: nothing is paid, and a notice offers Continue or a labelled own deposit, with no wait time", async () => {
    m.fetchIssuableNote.mockResolvedValue(NOT_YET);
    const { user } = await setup();
    await clickShield(user);
    expect(m.contributeToPool, "the till was paid before the buyer chose").not.toHaveBeenCalled();
    expect(m.shieldToPool, "an own deposit ran before the buyer chose").not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: CONTINUE }), "a Continue button").not.toBeNull();
    expect(screen.queryByRole("button", { name: OWN }), "a labelled own-deposit button").not.toBeNull();
    const notice = screen.getByText(/^No older note can be handed over right now\.$/).closest("p");
    expect(notice?.textContent).toMatch(/pressing Shield again collects it/);
    expect(notice?.textContent, "the notice shows a wait").not.toMatch(/\d|minute|hour|slot|wait/i);
  });

  it("no answer from the deployment: no own deposit without a choice, and it is the only choice offered", async () => {
    m.fetchIssuableNote.mockResolvedValue(null);
    const { user } = await setup();
    await clickShield(user);
    expect(m.shieldToPool, "no answer went straight to an own deposit").not.toHaveBeenCalled();
    expect(m.contributeToPool).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: OWN }), "a labelled own-deposit button").not.toBeNull();
    expect(screen.queryByRole("button", { name: CONTINUE }), "Continue, with no issuer to continue to").toBeNull();
  });

  it("Continue is today's path: the till is paid and the older note collected, never an own deposit", async () => {
    m.fetchIssuableNote.mockResolvedValue(NOT_YET);
    const { user, view } = await setup();
    await clickShield(user);
    const cont = screen.queryByRole("button", { name: CONTINUE });
    expect(cont, "a Continue button").not.toBeNull();
    await user.click(cont!);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(m.contributeToPool).toHaveBeenCalledTimes(1);
    expect(m.requestIssuedNote).toHaveBeenCalledTimes(1);
    expect(m.shieldToPool).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/treasury owns and you cannot spend/);
    expect(screen.queryByRole("button", { name: OWN }), "the choice stayed on screen after it was made").toBeNull();
  });

  it.each([
    ["no answer from the deployment", null],
    ["no note issuable now", NOT_YET],
  ])("the labelled own deposit is the only way to one (%s), and it goes through the relay", async (_label, answer) => {
    m.fetchIssuableNote.mockResolvedValue(answer);
    const { user } = await setup();
    await clickShield(user);
    const own = screen.queryByRole("button", { name: OWN });
    expect(own, "a labelled own-deposit button").not.toBeNull();
    await user.click(own!);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(m.shieldToPool).toHaveBeenCalledTimes(1);
    // The relayed shape: `depositPublicly` is treasury mode only.
    expect((m.shieldToPool.mock.calls[0]![0] as { depositPublicly?: boolean }).depositPublicly).toBe(false);
    expect(m.contributeToPool).not.toHaveBeenCalled();
  });

  it("🚨 [close-v1 F56] the own deposit hands shieldToPool the wallet's message signer, so the relay can prove the payer", async () => {
    // `shieldToPool` refuses a relayed deposit with no `signMessage` BEFORE the
    // wallet pays (`/api/relay-to-buyer` wants the payer's proof over the claim
    // challenge). The panel used to leave it out, so "Deposit my own note"
    // refused on every click, before any payment.
    m.fetchIssuableNote.mockResolvedValue(null);
    const { user } = await setup();
    await clickShield(user);
    await user.click(screen.getByRole("button", { name: OWN }));
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(m.shieldToPool).toHaveBeenCalledTimes(1);
    const params = m.shieldToPool.mock.calls[0]![0] as {
      depositPublicly?: boolean;
      signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    };
    expect(params.depositPublicly).toBe(false);
    expect(typeof params.signMessage, "the relayed own deposit was sent without a message signer").toBe("function");
    // And it is THIS wallet's signer, not a stand-in.
    signMessage.mockClear();
    const probe = new TextEncoder().encode("probe");
    await params.signMessage!(probe);
    expect(signMessage).toHaveBeenCalledWith(probe);
  });

  it.each([
    ["a note issuable now", { denomination: 1, token: "SOL", issuableNow: true }],
    ["a bucket not sampled yet", { denomination: 1, token: "SOL", issuableNow: null }],
    ["a server from before READY-1", { denomination: 1, token: "SOL" }],
  ])("%s: the click takes today's path at once, with no notice", async (_label, answer) => {
    m.fetchIssuableNote.mockResolvedValue(answer);
    const { user } = await setup();
    await clickShield(user);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(m.contributeToPool).toHaveBeenCalledTimes(1);
    expect(m.shieldToPool).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: OWN })).toBeNull();
    expect(screen.queryByRole("button", { name: CONTINUE })).toBeNull();
  });

  it("asks the deployment on mount, so the bucket is sampled before the click, and the click asks again", async () => {
    // The route samples in after() on the first GET of a bucket, so a click that
    // is the bucket's first ask gets null. The mount asks first; the click
    // still asks for itself, because the answer can change in between.
    m.fetchIssuableNote
      .mockResolvedValueOnce({ denomination: 1, token: "SOL", issuableNow: true })
      .mockResolvedValue(NOT_YET);
    const { user } = await setup();
    await waitFor(() => expect(m.fetchIssuableNote, "the panel did not ask on mount").toHaveBeenCalledTimes(1));
    expect(m.fetchIssuableNote.mock.calls[0]).toEqual([]);
    expect(m.contributeToPool).not.toHaveBeenCalled();
    expect(m.shieldToPool).not.toHaveBeenCalled();
    await clickShield(user);
    expect(m.fetchIssuableNote).toHaveBeenCalledTimes(2);
    expect(m.contributeToPool, "the click went on the mount's answer").not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: CONTINUE })).not.toBeNull();
  });
});

/**
 * AUDIT v1 round 1 (fix lane 2): an ISSUED note is held on this device only.
 *
 * The contribution (the default Shield click when stock is issuable) and the
 * exchange both leave the buyer an issued note. Its secrets come from the
 * treasury seed, so the buyer's seed scan never finds it; the claim code that
 * could fetch the issuer's kept reply again (issue-note/route.ts, "A RETRY IS
 * NOT A SECOND SALE") was deleted by `clearContribution` and never shown. A
 * wiped site store, a private window or a new device then lost the 1 SOL note
 * with no warning, and the issuer's custody disclosure was dropped on the
 * contribution card. Red log: scratchpad audit-v1-opus/r1-fix2/red-poolpanel.log.
 */
describe("audit r1: an issued note is held on this device only", () => {
  const CODE_A = "claimCodeAAAA0001";
  const CODE_B = "claimCodeBBBB0002";
  const SHOW_CODE = /^Show recovery code$/;
  const ONLY_COPY = /This device holds the only copy of this note/;

  function stockContribution(code: string) {
    m.fetchIssuableNote.mockResolvedValue({ denomination: 1, token: "SOL", issuableNow: true });
    m.contributeToPool.mockResolvedValue({
      txSig: "FundedDepositSig11111111111111111111111111111",
      leafIndex: FUNDED_LEAF,
      commitment: FUNDED_COMMITMENT,
      claimCode: code,
      fundedBy: "funder",
      depositLanded: true,
    });
    m.requestIssuedNote.mockResolvedValue(
      issued(noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: OTHER_TAG }), CANARY_LEAF),
    );
  }

  async function shieldOnce() {
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    await screen.findByText("Your 1 SOL note is in the pool");
    return { user, view };
  }

  it("a contribution: the card renders the issuer's custody disclosure", async () => {
    stockContribution(CODE_A);
    const { view } = await shieldOnce();
    expect(m.contributeToPool).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("ISSUER DISCLOSURE, rendered verbatim.");
  });

  it("a contribution: the card says this device holds the only copy, and hands over the recovery code on request", async () => {
    stockContribution(CODE_A);
    const { user, view } = await shieldOnce();
    expect(view.container.textContent).toMatch(ONLY_COPY);
    expect(view.container.textContent).toMatch(/your wallet seed cannot rebuild it/i);
    // Off the screen until asked, like every other id on these cards.
    expect(view.container.innerHTML).not.toContain(CODE_A);
    await user.click(screen.getByRole("button", { name: SHOW_CODE }));
    expect(view.container.textContent).toContain(CODE_A);
  });

  it("an own deposit carries no only-copy warning: the seed rebuilds it", async () => {
    m.scanPool.mockResolvedValue({ notes: [], shieldedBalance: 0, poolSizes: [], complete: true });
    m.shieldToPool.mockResolvedValue({
      txSig: OWN_DEPOSIT_SIG,
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "funder",
      walletPaidLamports: 1_013_000_000,
      operatorFeeLamports: 10_000_000,
      tag: TAG,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitFor(() => expect(m.scanPool).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: /^Shield 1 SOL$/ }));
    await chooseOwnDeposit(user);
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(view.container.textContent).not.toMatch(ONLY_COPY);
    expect(screen.queryByRole("button", { name: SHOW_CODE })).toBeNull();
  });

  it("an exchange: the same warning, and its recovery code on request", async () => {
    m.exchangeNoteForIssued.mockResolvedValue({
      spendSig: EXCHANGE_SIG,
      claimCode: CODE_B,
      issued: issued(
        noteView({ leafIndex: FUNDED_LEAF, commitment: FUNDED_COMMITMENT, tag: OTHER_TAG }),
        FUNDED_LEAF,
      ),
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    await screen.findByText(/Exchanged your 1 SOL note for an older one/);
    expect(view.container.textContent).toMatch(ONLY_COPY);
    expect(view.container.innerHTML).not.toContain(CODE_B);
    await user.click(screen.getByRole("button", { name: SHOW_CODE }));
    expect(view.container.textContent).toContain(CODE_B);
  });

  it("a recovery code brings the note back: the issuer is asked again with that code", async () => {
    m.requestIssuedNote.mockResolvedValue(
      issued(noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: THIRD_TAG }), CANARY_LEAF),
    );
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.type(screen.getByLabelText(/^Recovery code$/), `  ${CODE_A}  `);
    await user.click(screen.getByRole("button", { name: /^Restore the note$/ }));
    await waitFor(() => expect(m.requestIssuedNote).toHaveBeenCalledTimes(1));
    expect(m.requestIssuedNote.mock.calls[0][0]).toMatchObject({
      meta: "meta-1",
      walletPubkey: OWNER.toBase58(),
      token: "SOL",
      denomination: 1,
      claimCode: CODE_A,
    });
    // Nothing is paid to restore.
    expect(m.contributeToPool).not.toHaveBeenCalled();
    expect(m.shieldToPool).not.toHaveBeenCalled();
    await waitFor(() => expect(within(view.container).getByText(THIRD_TAG.text)).toBeInTheDocument());
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
  });

  it("a malformed recovery code asks nobody", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.type(screen.getByLabelText(/^Recovery code$/), "short");
    await user.click(screen.getByRole("button", { name: /^Restore the note$/ }));
    expect(m.requestIssuedNote).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/not a recovery code/i);
  });
});

/**
 * close-v1, lane L4.
 *
 * F07 (resume part). A resumed contribution is an issued note too, held on
 * this device only. The resume path now returns the claim code it redeemed
 * (contract C1: `resumeContribution` outcome gains `claimCode`), so the card
 * hands it over like the contribution card does, and renders the issuer's
 * disclosure the resume returns (`IssuedNoteOutcome.disclosure`: "Render it").
 *
 * F05 and the pre-flights. The builders refuse before anything is paid, with a
 * message that starts with a code (contract C2); the panel shows the sentence
 * for that code, not the code.
 */
describe("close-v1: the resumed card and the refusal codes", () => {
  const CODE_R = "claimCodeRRRR0003";
  const SHOW_CODE = /^Show recovery code$/;
  const ONLY_COPY = /This device holds the only copy of this note/;

  it("a resumed contribution: the only-copy warning, its recovery code on request, and the issuer's disclosure", async () => {
    m.resumeContribution.mockResolvedValue({
      ...issued(noteView({ leafIndex: FUNDED_LEAF, commitment: FUNDED_COMMITMENT, tag: OTHER_TAG }), FUNDED_LEAF),
      claimCode: CODE_R,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    await screen.findByText("Your 1 SOL note is in the pool");
    expect(m.contributeToPool).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(ONLY_COPY);
    expect(view.container.textContent).toContain("ISSUER DISCLOSURE, rendered verbatim.");
    expect(view.container.innerHTML).not.toContain(CODE_R);
    await user.click(screen.getByRole("button", { name: SHOW_CODE }));
    expect(view.container.textContent).toContain(CODE_R);
    expect(canariesIn(view.container.innerHTML)).toEqual([]);
  });

  it("a deposit refused by a pre-flight shows the sentence for its code, not the code", async () => {
    m.fetchIssuableNote.mockResolvedValue({ denomination: 1, token: "SOL", issuableNow: true });
    m.contributeToPool.mockRejectedValue(new Error("POOL_DEPOSITS_BRICKED: non-canonical value at slot 7"));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    expect((await screen.findAllByText(/stops new deposits/)).length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("POOL_DEPOSITS_BRICKED");
  });

  it("a withdrawal refused because only the C1 + C3 pair could spend the note says it cannot be spent here until v2", async () => {
    m.unshieldFromPool.mockRejectedValue(new Error("C1C3_SPEND_DISABLED: v3 unshield refused by the builder"));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Withdraw$/ }));
    expect((await screen.findAllByText(/cannot be spent from this web app until v2/)).length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("C1C3_SPEND_DISABLED");
  });

  it("an exchange the deployment switched off says so, with nothing spent", async () => {
    m.exchangeNoteForIssued.mockRejectedValue(new Error("EXCHANGE_DISABLED: the issuer does not take pool withdrawals"));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Exchange for an older note/ }));
    expect((await screen.findAllByText(/switched off on this deployment/)).length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("EXCHANGE_DISABLED");
  });

  // Verifier round 2: the three error paths no test reached. Each rejects with
  // a coded message and must show the dictionary sentence under its own line.
  it("a restore refused with a code shows the sentence under the form, not the code", async () => {
    m.requestIssuedNote.mockRejectedValueOnce(new Error("POOL_TREE_DIVERGED: root 12 != 34"));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.type(screen.getByLabelText(/^Recovery code$/), CODE_R);
    await user.click(screen.getByRole("button", { name: /^Restore the note$/ }));
    await waitFor(() => expect(m.requestIssuedNote).toHaveBeenCalledTimes(1));
    const form = screen.getByRole("button", { name: /^Restore the note$/ }).closest("form") as HTMLElement;
    await waitFor(() => expect(form.textContent).toContain(en.pay.errors.poolTreeDiverged));
    expect(view.container.textContent).not.toContain("POOL_TREE_DIVERGED");
  });

  it("a recovery refused with a code shows the sentence, not the code", async () => {
    m.recoverStuckFunds.mockRejectedValue(new Error("POOL_TREE_DIVERGED: root 56 != 78"));
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /Recover funds from a failed attempt/ }));
    await waitFor(() => expect(m.recoverStuckFunds).toHaveBeenCalled());
    expect((await screen.findAllByText(en.pay.errors.poolTreeDiverged)).length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("POOL_TREE_DIVERGED");
  });

  // Verifier round 2: an own deposit made after a contribution is the buyer's
  // own note, which the seed rebuilds. The contribution's only-copy warning and
  // its recovery code belong to the earlier card and must not carry over.
  it("an own deposit after a contribution drops the earlier only-copy warning and its code", async () => {
    const CODE_E = "claimCodeEEEE0007";
    m.fetchIssuableNote.mockResolvedValue({ denomination: 1, token: "SOL", issuableNow: true });
    m.contributeToPool.mockResolvedValue({
      txSig: "FundedDepositSig11111111111111111111111111111",
      leafIndex: FUNDED_LEAF,
      commitment: FUNDED_COMMITMENT,
      claimCode: CODE_E,
      fundedBy: "funder",
      depositLanded: true,
    });
    m.requestIssuedNote.mockResolvedValue(
      issued(noteView({ leafIndex: CANARY_LEAF, commitment: CANARY_COMMITMENT, tag: OTHER_TAG }), CANARY_LEAF),
    );
    m.shieldToPool.mockResolvedValue({
      txSig: OWN_DEPOSIT_SIG,
      commitment: CANARY_COMMITMENT,
      leafIndex: CANARY_LEAF,
      denomination: 1,
      encryptedNote: "p01enc1:blob",
      fundedLamports: 0,
      fundedBy: "funder",
      walletPaidLamports: 1_013_000_000,
      operatorFeeLamports: 10_000_000,
      tag: TAG,
    });
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    await screen.findByText("Your 1 SOL note is in the pool");
    // Positive control: the contribution card carries the warning.
    expect(view.container.textContent).toMatch(ONLY_COPY);
    expect(m.contributeToPool).toHaveBeenCalledTimes(1);

    // The deployment stops answering: the next click is an own deposit.
    m.fetchIssuableNote.mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: /^Shield 1 SOL$/ }));
    await chooseOwnDeposit(user);
    await waitFor(() => expect(m.shieldToPool).toHaveBeenCalledTimes(1));
    await screen.findByText("Your 1 SOL note is in the pool");
    await waitFor(() => expect(view.container.textContent).not.toMatch(ONLY_COPY));
    expect(screen.queryByRole("button", { name: SHOW_CODE })).toBeNull();
    expect(view.container.innerHTML).not.toContain(CODE_E);
    expect(m.contributeToPool).toHaveBeenCalledTimes(1);
  });
});

describe("[flow-speed X8] a build with no funder ticket refuses a direct withdrawal at the click", () => {
  it("T1: Withdraw sends nothing, asks for no signature, and says the FUND-1 refusal", async () => {
    // RED at HEAD: the click walked the history, proved and only then refused.
    vi.stubEnv("NEXT_PUBLIC_P01_FUNDER_TICKET", "");
    const user = userEvent.setup();
    const view = renderPanel();
    await waitForRows(1);
    signMessage.mockClear();
    await user.click(screen.getByRole("button", { name: /^Withdraw$/ }));
    await waitFor(() =>
      expect(view.container.textContent).toMatch(/Stopped before spending anything/),
    );
    expect(view.container.textContent).toMatch(/this deployment has no funder configured/);
    expect(view.container.textContent).toMatch(/Trying again will not change this/);
    expect(m.unshieldFromPool).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(m.recordPayout).not.toHaveBeenCalled();
    expect(m.recordSpentNote).not.toHaveBeenCalled();
  });

  it("T2: the relayed withdrawal funds nothing and stays open without a ticket", async () => {
    vi.stubEnv("NEXT_PUBLIC_P01_FUNDER_TICKET", "");
    vi.stubEnv("NEXT_PUBLIC_P01_SPEND_RELAYER_URL", "https://relayer.test");
    try {
      m.unshieldFromPool.mockResolvedValue({
        txSig: WITHDRAWAL_SIG,
        denomination: 1,
        fundedBy: "relayer",
        version: "v4",
      });
      const user = userEvent.setup();
      renderPanel();
      await waitForRows(1);
      await user.click(screen.getByRole("button", { name: /^Withdraw via relayer$/ }));
      await screen.findByText("Withdrew 1 SOL");
      expect(m.unshieldFromPool.mock.calls[0][0]).toMatchObject({ relayerUrl: "https://relayer.test" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("control: with the ticket, the same click reaches the withdrawal", async () => {
    m.unshieldFromPool.mockResolvedValue({ txSig: WITHDRAWAL_SIG, denomination: 1, fundedBy: "funder", version: "v4" });
    const user = userEvent.setup();
    renderPanel();
    await waitForRows(1);
    await user.click(screen.getByRole("button", { name: /^Withdraw$/ }));
    await screen.findByText("Withdrew 1 SOL");
    expect(m.unshieldFromPool).toHaveBeenCalledTimes(1);
  });
});

/**
 * SubscriptionsPanel: the read side of subscriptions on /pay.
 *
 * What matters here, in order:
 *
 *   1. The standing line speaks the user's language and tells the truth: a
 *      vault read against a live slot says "N of M periods left, about ...",
 *      a missing account says CLOSED and explains that everything went to the
 *      merchant, and an unfetchable clock says "Checking", never "Active".
 *   2. The detail page carries the irreversibility disclosure (no cancel, no
 *      refund, final claim closes the vault) and the two license-key facts
 *      (re-derivable from the note secret, bearer credential). Both are
 *      product-honesty requirements, not decoration.
 *   3. Track-a-vault validates before it records: a non-address is refused at
 *      the form, and only accounts owned by the program that decode as a
 *      SubscriptionVault are remembered.
 *
 * The vault bytes are the REAL devnet vault 7WaBm7Kq... (361 bytes), the same
 * fixture the decoder unit tests pin, so what renders here is what the chain
 * actually serves. The registry module is stubbed: it walks getProgramAccounts
 * and is not what this panel is about.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, PublicKey } from "@solana/web3.js";

import SubscriptionsPanel from "@/components/pay/SubscriptionsPanel";
import {
  ZK_SHIELDED_PROGRAM_ID_BASE58,
  bytesToHex,
  decodeSubscriptionVault,
  recordSubscription,
  loadSubscriptions,
} from "@/lib/pay/subscriptions";
import { loadServiceRegistry, type ServiceEntry } from "@/lib/privacy/serviceRegistry";
import { BEARER_CLIPBOARD_CLEAR_MS } from "@/lib/pay/bearerClipboard";

// ---------------------------------------------------------------------------
// Stub: the vendor roster (network) and its formatter.
// ---------------------------------------------------------------------------

vi.mock("@/lib/privacy/serviceRegistry", () => ({
  NATIVE_SOL_SENTINEL_MINT: "11111111111111111111111111111111",
  loadServiceRegistry: vi.fn(() => Promise.resolve({ services: [] })),
  formatInterval: (slots: bigint) => `every ${Math.round(Number(slots) * 0.4)} s`,
}));

// The reveal path posts to the Worker; here it answers with a canned key.
// `loadEncryptedNotes` feeds the recovery scan; an empty store is fine here.
vi.mock("@/lib/privacy/shieldClient", () => ({
  deriveSubscriptionLicenseKey: vi.fn(),
  loadEncryptedNotes: vi.fn(async () => []),
}));

// No Worker exists in jsdom. In the default "dead" mode every worker round
// trip rejects with a stable message, so the store functions fall back to
// their v1 paths exactly as before and the recovery test below can assert the
// surfaced error. "skew" mode instead plays a LIVE worker that is OLDER than
// this page (tab open across a deploy): it answers the session handlers but
// its `poolOpenRecords` predates the subscription record kind, so the
// response carries no `subscriptions` array — the exact wire shape task #12
// is about. The seed derivation matches the pattern of paySubscriptions.test.ts.
const worker = vi.hoisted(() => ({ mode: "dead" as "dead" | "skew" | "restarted" }));

vi.mock("@/lib/privacy/workerClient", async () => {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const { bytesToHex, utf8ToBytes } = await import("@noble/hashes/utils.js");
  const { createNoteEncryptionAddress } = await import("@/lib/privacy/pool/noteCrypto");
  return {
    poolRequest: vi.fn(async (req: { kind: string; meta: string; blobs?: string[] }) => {
      if (worker.mode === "dead") {
        throw new Error("The private-payment worker is unavailable in this test.");
      }
      if (worker.mode === "restarted") {
        // The REAL `requireSeeds` refusal (worker/poolHandlers.ts): a worker
        // rebooted after a crash holds no seeds for ANY meta. The page still
        // reaches the open call because its cached storeSession survives —
        // the exact task #16 shape.
        throw new Error("No pool keys for this identity. Reconnect and sign to derive.");
      }
      const seed = sha256(utf8ToBytes(`test-seed:${req.meta}`));
      if (req.kind === "poolStoreLabel") {
        return {
          kind: "poolStoreLabel",
          label: bytesToHex(sha256(seed)).slice(0, 32),
          legacyAddress: createNoteEncryptionAddress(seed),
        };
      }
      if (req.kind === "poolNoteAddress") {
        return { kind: "poolNoteAddress", address: createNoteEncryptionAddress(seed) };
      }
      if (req.kind === "poolOpenRecords") {
        // The old worker's whitelist does not know `subscription` records, so
        // the blobs land in `skipped` and the field never existed.
        return { kind: "poolOpenRecords", payouts: [], spentKeys: [], skipped: (req.blobs ?? []).length };
      }
      throw new Error(`unexpected pool request: ${req.kind}`);
    }),
  };
});

import { deriveSubscriptionLicenseKey } from "@/lib/privacy/shieldClient";
const mockDeriveKey = vi.mocked(deriveSubscriptionLicenseKey);
const mockRegistry = vi.mocked(loadServiceRegistry);

// ---------------------------------------------------------------------------
// Fixtures: the real devnet vault, byte for byte.
// ---------------------------------------------------------------------------

const VAULT_ADDR = "7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw";

const DEVNET_VAULT_HEX =
  "605af7ca9d1056be00018da14f2b2000127200000000000000000000000000000000000000000000" +
  "00000c5443225caa0f33a5be0e6780e34ba1b46e4b357ce12ef7292752ae73b21635000000000000" +
  "000000000000000000000000000000000000000000000000000000ca9a3b0000000080f0fa020000" +
  "0000dc050000000000003e22af1c0000000000000000000000000100000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000014fcaa629d8f20041a2f9" +
  "a3765c47b3e810a5f8e4d15d4488bdb759c1cf323461ff0001b301dbbf29305e8c442e4b2764afda" +
  "20c8ac9bdd616fc29e44957d172e7796260000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000000000000000000000000000" +
  "00";

const START_SLOT = 481_239_614; // start_slot of the fixture, pinned in the lib test

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const RETAILER = "q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr";
const SOL_MINT = "11111111111111111111111111111111";
/** The fixture vault's on-chain license fingerprint, read through the real
 *  decoder: the value the Reveal path must hand the Worker to check against. */
const FIXTURE_LICENSE_HEX = bytesToHex(
  decodeSubscriptionVault(hexToBytes(DEVNET_VAULT_HEX)).licenseCommitment!,
);

/** A registry listing as the panel reads it; only the joined fields matter. */
function listing(slug: string, name: string): ServiceEntry {
  return {
    slug,
    name,
    retailer: { toBase58: () => RETAILER },
    tokenMint: { toBase58: () => SOL_MINT },
  } as unknown as ServiceEntry;
}

const OWNER = { toBase58: () => "wallet1" } as unknown as PublicKey;

/** A connection that serves canned accounts. setup.tsx mocks PublicKey to a
 *  `{ toBase58 }` stub, so lookups key on the base58 string. */
function fakeConnection(opts: {
  slot?: number | null;
  accounts?: Record<string, Uint8Array>;
  ownerOverride?: string;
  /**
   * Every account read this panel makes, in order, by what it named:
   * a vault address for a per-PDA `getAccountInfo`, the literal
   * "getProgramAccounts" for the program-wide enumeration. The list side must
   * never name a vault PDA (sweep round 1, record 33): a vault PDA is seeded
   * on the note secret that opened it, so naming one hands the provider a
   * secret-derived identifier.
   */
  reads?: string[];
}): Connection {
  return {
    rpcEndpoint: "https://fake.test",
    getSlot: async () => {
      if (opts.slot == null) throw new Error("no slot");
      return opts.slot;
    },
    // The discriminator-filtered enumeration: one question, the same for every
    // user. Scoped to the program, so an account another program owns is not
    // in the answer at all.
    getProgramAccounts: async () => {
      opts.reads?.push("getProgramAccounts");
      if (opts.ownerOverride) return [];
      return Object.entries(opts.accounts ?? {}).map(([address, data]) => ({
        pubkey: { toBase58: () => address },
        account: { owner: { toBase58: () => ZK_SHIELDED_PROGRAM_ID_BASE58 }, data },
      }));
    },
    getAccountInfo: async (pk: { toBase58(): string }) => {
      opts.reads?.push(pk.toBase58());
      const data = opts.accounts?.[pk.toBase58()];
      if (!data) return null;
      return {
        owner: { toBase58: () => opts.ownerOverride ?? ZK_SHIELDED_PROGRAM_ID_BASE58 },
        data,
      };
    },
  } as unknown as Connection;
}

/** Seeds a record through the real store. There is no Worker in jsdom, so the
 *  sealed write lands in the v1 fallback, which is exactly the interop the
 *  panel must keep serving (records made before L5b, or with no session). The
 *  sealed path itself is pinned in lib/privacy/pool/storeEncryption.test.ts. */
async function seedRecord(over: Partial<Parameters<typeof recordSubscription>[2]> = {}) {
  await recordSubscription("meta-test", "wallet1", {
    vaultPDA: VAULT_ADDR,
    retailer: "q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr",
    serviceTag: "bitwarden-test",
    serviceName: "Bitwarden Test",
    token: "SOL",
    denomination: 1,
    rate: "50000000",
    intervalSlots: "1500",
    openTxSig: "4PfrkFakeSignatureForTests",
    openedAt: Date.now(),
    ...over,
  });
}

beforeEach(() => {
  localStorage.clear();
  mockDeriveKey.mockReset();
  mockRegistry.mockImplementation(() => Promise.resolve({ services: [] } as never));
  worker.mode = "dead";
});

// ---------------------------------------------------------------------------

describe("empty state", () => {
  it("says nothing is tracked and offers both ways in", async () => {
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={fakeConnection({ slot: 1 })} />);
    expect(
      await screen.findByText(/No subscriptions tracked in this browser yet/i),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Vault address")).toBeInTheDocument();
  });
});

describe("list standing", () => {
  it("reads the vault and says periods left in plain words", async () => {
    await seedRecord();
    // One interval past start: 19 of 20 periods left, 28,500 slots of
    // entitlement, nominally 11,400 s, "about 3 hours".
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(
      await screen.findByText("19 of 20 periods left, about 3 hours"),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Bitwarden Test")).toBeInTheDocument();
  });

  it("a missing account renders CLOSED with the merchant-gets-everything truth", async () => {
    await seedRecord();
    const conn = fakeConnection({ slot: START_SLOT + 1_500, accounts: {} });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(
      await screen.findByText(/Closed, fully paid out to the merchant/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("an unfetchable clock says Checking, never Active", async () => {
    await seedRecord();
    const conn = fakeConnection({
      slot: null,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(await screen.findByText("Checking")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });
});

describe("detail page", () => {
  async function openDetail() {
    await seedRecord();
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.click(await screen.findByText("Bitwarden Test"));
  }

  it("carries the irreversibility disclosure, not only the purchase flow", async () => {
    await openDetail();
    expect(await screen.findByText("No cancel, no refund")).toBeInTheDocument();
    expect(
      screen.getByText(/remaining balance, any dust and the vault.s own rent all go to the merchant/i),
    ).toBeInTheDocument();
  });

  it("states both license-key facts and the scope tag, and never a key", async () => {
    await openDetail();
    expect(await screen.findByText(/re-derives from the secret of the note/i)).toBeInTheDocument();
    expect(screen.getByText(/bearer credential/i)).toBeInTheDocument();
    expect(screen.getByText(/scoped to: bitwarden-test/i)).toBeInTheDocument();
    // The key must not appear: it is not stored and this page cannot derive it.
    expect(document.body.textContent).not.toMatch(/P01-[0-9A-Z]{4}-/);
  });

  it("links the vault and the opening transaction to the explorer", async () => {
    await openDetail();
    // Behind one click since UI-1: see "keeps the vault address and opening
    // transaction off the screen until asked" below.
    await userEvent.click(await screen.findByRole("button", { name: /Show the on-chain addresses/i }));
    const links = (await screen.findAllByRole("link")) as HTMLAnchorElement[];
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain(`https://explorer.solana.com/address/${VAULT_ADDR}?cluster=devnet`);
    expect(hrefs).toContain(
      "https://explorer.solana.com/tx/4PfrkFakeSignatureForTests?cluster=devnet",
    );
  });

  /**
   * UI-1 (ledger row D14). The technical block printed the vault's
   * `subscriber_commitment`, the value the vault PDA is seeded on, and the
   * links card put the vault address and the opening transaction on screen by
   * default. All three point a screenshot straight at this subscription on
   * chain. The commitment is gone; the addresses wait behind a click.
   */
  const SUBSCRIBER_HEX = bytesToHex(
    decodeSubscriptionVault(hexToBytes(DEVNET_VAULT_HEX)).subscriberCommitment!,
  );
  /** Any `size`-character window of `hex` found in `html` (8 unless given). */
  function windowsOf(hex: string, html: string, size = 8): string[] {
    const found: string[] = [];
    for (let i = 0; i + size <= hex.length; i++) if (html.includes(hex.slice(i, i + size))) found.push(hex.slice(i, i + size));
    return found;
  }

  it("renders no subscriber commitment, in any state of the detail page", async () => {
    // Anti-vacuity: the fixture really carries one, and the detector finds it.
    expect(SUBSCRIBER_HEX).toMatch(/^[0-9a-f]{64}$/);
    expect(windowsOf(SUBSCRIBER_HEX, `x${SUBSCRIBER_HEX.slice(10, 20)}x`).length).toBeGreaterThan(0);
    await openDetail();
    await screen.findByText("No cancel, no refund");
    expect(windowsOf(SUBSCRIBER_HEX, document.body.innerHTML)).toEqual([]);
    const reveal = screen.queryByRole("button", { name: /Show the on-chain addresses/i });
    if (reveal) {
      await userEvent.click(reveal);
      expect(windowsOf(SUBSCRIBER_HEX, document.body.innerHTML)).toEqual([]);
    }
  });

  it("keeps the vault address and opening transaction off the screen until asked", async () => {
    await openDetail();
    await screen.findByText("No cancel, no refund");
    const html = document.body.innerHTML;
    expect(html.includes(VAULT_ADDR.slice(0, 8)), "the vault address is on screen").toBe(false);
    expect(html.includes("4PfrkFake"), "the opening transaction is on screen").toBe(false);

    const reveal = screen.queryByRole("button", { name: /Show the on-chain addresses/i });
    expect(reveal, "no way to ask for the addresses").not.toBeNull();
    await userEvent.click(reveal!);
    const hrefs = ((await screen.findAllByRole("link")) as HTMLAnchorElement[]).map((l) => l.href);
    expect(hrefs).toContain(`https://explorer.solana.com/address/${VAULT_ADDR}?cluster=devnet`);
  });

  /**
   * UI-1 fix round 2. The technical block's start slot and license fingerprint
   * are read off the vault account and single it out as surely as its address:
   * the start slot is the slot the opening transaction landed in, and the
   * fingerprint is stored in the vault. Both wait behind the same click.
   */
  it("keeps the start slot and the license fingerprint off the screen until asked", async () => {
    // Anti-vacuity: the fixture carries a fingerprint, and the detector finds
    // the truncation the page would print.
    expect(FIXTURE_LICENSE_HEX).toMatch(/^[0-9a-f]{64}$/);
    const truncated = `x${FIXTURE_LICENSE_HEX.slice(0, 10)}…${FIXTURE_LICENSE_HEX.slice(-6)}x`;
    expect(windowsOf(FIXTURE_LICENSE_HEX, truncated, 6).length).toBeGreaterThan(0);
    await openDetail();
    await screen.findByText("No cancel, no refund");
    let html = document.body.innerHTML;
    expect(html.includes(String(START_SLOT)), "the start slot is on screen").toBe(false);
    expect(windowsOf(FIXTURE_LICENSE_HEX, html, 6)).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: /Show the on-chain addresses/i }));
    html = document.body.innerHTML;
    // Positive control: both are one click away.
    expect(html).toContain(String(START_SLOT));
    expect(html).toContain(FIXTURE_LICENSE_HEX.slice(0, 10));
  });

  it("does not suggest the subscription is unlinkable", async () => {
    // The sentence was reworded on 2026-09-09 when it moved into the
    // dictionary: Rule 4 of __tests__/lib/claims-lexicon.test.ts is per
    // SENTENCE, and "unlinkable to your wallet only to the extent the pool is"
    // put the qualification in the next one, so the guard read it as an
    // unqualified claim and went red. The denial is now in the same breath as
    // the term. What this test pins is unchanged: the screen must say the link
    // is NOT broken, and must say why.
    await openDetail();
    expect(
      await screen.findByText(/not unlinkable to your wallet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/published the note commitment in the clear/i),
    ).toBeInTheDocument();
  });
});

describe("track a vault", () => {
  it("refuses a non-address before touching the network", async () => {
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={fakeConnection({ slot: 1 })} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), "not-an-address");
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));
    expect(await screen.findByText("That is not a Solana address.")).toBeInTheDocument();
    expect((await loadSubscriptions(null, "wallet1")).records).toHaveLength(0);
  });

  it("refuses an account the program does not own", async () => {
    const conn = fakeConnection({
      slot: 1,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      ownerOverride: "SomeOtherProgram1111111111111111111111111111",
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));
    // The sentence changed with the read (sweep round 1 of logs8, fix lane 2).
    // Track no longer names the pasted address to the RPC: it looks it up in
    // the program-wide enumeration, which cannot tell "another program owns
    // it" from "no account" from "closed by the final claim". So the three old
    // messages are one, the sentence true of all three. The refusal itself,
    // and the empty store, are asserted exactly as before.
    expect(await screen.findByText("This account is not a subscription vault.")).toBeInTheDocument();
    expect((await loadSubscriptions(null, "wallet1")).records).toHaveLength(0);
  });

  it("records a real vault from its address alone, from chain data", async () => {
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));

    await waitFor(async () =>
      expect((await loadSubscriptions(null, "wallet1")).records).toHaveLength(1),
    );
    const rec = (await loadSubscriptions(null, "wallet1")).records[0]!;
    expect(rec.vaultPDA).toBe(VAULT_ADDR);
    expect(rec.retailer).toBe("q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr");
    // No registry entry in this test, so the tag falls back to the retailer.
    expect(rec.serviceTag).toBe("q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr");
    expect(rec.token).toBe("SOL");
    expect(rec.denomination).toBe(1);
    // Tracking lands on the detail page for the vault just added.
    expect(await screen.findByText("No cancel, no refund")).toBeInTheDocument();
  });

  it("tracking an already-tracked vault keeps the richer record: paying note and tag", async () => {
    // Written at purchase: knows the note and the slug the key is scoped to.
    await seedRecord({
      serviceTag: "acme-pro",
      pool: "PoolPda11111111111111111111111111111111111",
      leafIndex: 19,
    });
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await screen.findByText("Bitwarden Test");
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));

    // Lands on the detail page without rewriting the record from chain data
    // alone, which would have dropped the note and replaced the tag by a guess.
    expect(await screen.findByText("No cancel, no refund")).toBeInTheDocument();
    const recs = (await loadSubscriptions(null, "wallet1")).records;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      serviceTag: "acme-pro",
      serviceName: "Bitwarden Test",
      pool: "PoolPda11111111111111111111111111111111111",
      leafIndex: 19,
      openTxSig: "4PfrkFakeSignatureForTests",
    });
    expect(screen.getByRole("button", { name: /Reveal key/ })).toBeInTheDocument();
  });
});

describe("license key reveal", () => {
  async function openDetailWithNote() {
    // The record knows which note paid (pool + leafIndex), as the subscribe
    // flow writes it, so the key is re-derivable in this browser.
    await seedRecord({ pool: "PoolPda11111111111111111111111111111111111", leafIndex: 19 });
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.click(await screen.findByText("Bitwarden Test"));
  }

  it("re-derives the key in the Worker on demand and shows it with a copy button", async () => {
    mockDeriveKey.mockResolvedValue({
      licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      serviceTag: "bitwarden-test",
    });
    await openDetailWithNote();

    // Nothing shows a key before the user asks.
    expect(document.body.textContent).not.toMatch(/P01-[0-9A-Z]{4}-/);

    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    expect(await screen.findByText("P01-000G-40R4-0M30-E209-185G-R38E-1W")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy key/ })).toBeInTheDocument();

    // The exact identity of the derivation call: this browser's session, the
    // paying note, the stored tag first, then the candidates the chain check
    // may fall through to (no roster here, so only the retailer address), and
    // the vault's on-chain fingerprint the key must hash to.
    expect(mockDeriveKey).toHaveBeenCalledWith({
      meta: "meta-test",
      walletPubkey: "wallet1",
      pool: "PoolPda11111111111111111111111111111111111",
      leafIndex: 19,
      serviceTag: "bitwarden-test",
      candidateTags: ["bitwarden-test", RETAILER],
      licenseCommitment: FIXTURE_LICENSE_HEX,
    });
    // The record is untouched when the stored tag is the one that verified.
    expect((await loadSubscriptions(null, "wallet1")).records[0]!.serviceTag).toBe(
      "bitwarden-test",
    );

    // Hide takes it back off the screen.
    await userEvent.click(screen.getByRole("button", { name: /^Hide$/ }));
    expect(screen.queryByText("P01-000G-40R4-0M30-E209-185G-R38E-1W")).not.toBeInTheDocument();
  });

  /**
   * The clipboard, web sweep 4 round 1, item 24 (ledger row D8) — THE THIRD
   * SINK.
   *
   * `SendForm` and `SubscribePanel` were closed in round 1; this screen's
   * `CopyButton` still did a bare `navigator.clipboard.writeText(text)` and it
   * is handed `revealedKey` — the SAME license key. A license key is a bearer
   * credential AND it locates the vault: the vault's on-chain
   * `license_commitment` is a hash of the key's secret, which is how the
   * merchant SDK finds the vault from the key alone, and from the vault its
   * opening transaction is the spend of the note that paid. Windows keeps a
   * clipboard history on disk and phones sync it between devices, so a key
   * copied and never taken back outlives the tab.
   *
   * The page takes it back only after reading the clipboard and finding its own
   * string still there (`lib/pay/bearerClipboard.ts`): a blind overwrite would
   * delete whatever the person copied from another application in between.
   */
  it("takes the license key back off the clipboard", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mockDeriveKey.mockResolvedValue({
        licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
        serviceTag: "bitwarden-test",
      });
      await openDetailWithNote();
      await user.click(await screen.findByRole("button", { name: /Reveal key/ }));
      await user.click(await screen.findByRole("button", { name: /Copy key/ }));

      // Positive control: the key really did reach the clipboard, so the
      // absence below is the clear and not a copy that never happened.
      await expect(navigator.clipboard.readText()).resolves.toBe(
        "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      );

      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      // An emptied clipboard reads back as "" in a browser; userEvent's stub
      // rejects instead, because writing "" leaves its item with no text
      // flavour. Both mean the key is gone.
      const after = await navigator.clipboard.readText().then(
        (t) => t,
        () => "",
      );
      expect(after, "the license key is still on the clipboard").toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The version that needs no permission. Firefox never grants `clipboard-read`
   * to a page and Chrome grants it only on a gesture, so the scheduled clear
   * above reports `unreadable` and does nothing. The button is the person
   * asking, and a click is also what makes the write permitted everywhere.
   */
  it("offers a Clear the clipboard button beside Copy key", async () => {
    mockDeriveKey.mockResolvedValue({
      licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      serviceTag: "bitwarden-test",
    });
    await openDetailWithNote();
    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Copy key/ }));
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "P01-000G-40R4-0M30-E209-185G-R38E-1W",
    );

    await userEvent.click(screen.getByRole("button", { name: /Clear the clipboard/ }));
    const after = await navigator.clipboard.readText().then(
      (t) => t,
      () => "",
    );
    expect(after, "Clear the clipboard left the key on it").toBe("");
  });

  /**
   * Sweep round 1 (logs8), fix lane 2: THE TAKE-BACK DIED WITH THE BUTTON.
   *
   * The 90 s timer lived inside `CopyButton` and was cancelled when that button
   * unmounted — and the button is rendered only while the key is on screen. So
   * the most careful sequence there is, Reveal, Copy, then HIDE, was the one
   * that left the key on the clipboard for good; "All subscriptions" and
   * picking another row did the same. The compare in `clearBearerIfUnchanged`
   * already protects a newer copy, so nothing needed that cancel.
   *
   * Hide does NOT clear at once, on purpose: the key was copied to be pasted
   * somewhere, and the person hides it before switching to the merchant's page.
   * The promise is "gone after a minute and a half", and that is what is pinned.
   */
  type User = ReturnType<typeof userEvent.setup>;
  const fakeTimerUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  async function copyThen(user: User, leave: (user: User) => Promise<void>) {
    mockDeriveKey.mockResolvedValue({
      licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      serviceTag: "bitwarden-test",
    });
    await openDetailWithNote();
    await user.click(await screen.findByRole("button", { name: /Reveal key/ }));
    await user.click(await screen.findByRole("button", { name: /Copy key/ }));
    // Positive control: the key really is on the clipboard before leaving.
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "P01-000G-40R4-0M30-E209-185G-R38E-1W",
    );
    await leave(user);
    expect(screen.queryByText("P01-000G-40R4-0M30-E209-185G-R38E-1W")).not.toBeInTheDocument();
  }

  async function clipboardNow(): Promise<string> {
    return navigator.clipboard.readText().then(
      (t) => t,
      () => "",
    );
  }

  it("still takes the key back after Hide", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await copyThen(fakeTimerUser(), (user) =>
        user.click(screen.getByRole("button", { name: /^Hide$/ })),
      );
      // Still pasteable right after Hide: hiding is not a reason to lose the copy.
      expect(await clipboardNow()).toBe("P01-000G-40R4-0M30-E209-185G-R38E-1W");
      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      expect(await clipboardNow(), "the license key is still on the clipboard after Hide").toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still takes the key back after going back to the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await copyThen(fakeTimerUser(), (user) =>
        user.click(screen.getByRole("button", { name: /All subscriptions/ })),
      );
      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      expect(
        await clipboardNow(),
        "the license key is still on the clipboard after leaving the detail",
      ).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still takes the key back after the whole panel unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { cleanup } = await import("@testing-library/react");
      await copyThen(fakeTimerUser(), async () => cleanup());
      await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
      expect(
        await clipboardNow(),
        "the license key is still on the clipboard after the panel unmounted",
      ).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The half no timer covers. Firefox never lets a page read the clipboard, so
   * the scheduled clear ends `unreadable` there and the button is the only
   * take-back — and it used to leave the screen with the key. It stays for as
   * long as the copy may still be out, on the detail page and on the list.
   */
  it("keeps Clear the clipboard within reach after Hide, and it works", async () => {
    await copyThen(userEvent.setup(), (user) =>
      user.click(screen.getByRole("button", { name: /^Hide$/ })),
    );
    const clear = screen.queryByRole("button", { name: /Clear the clipboard/ });
    expect(clear === null ? "no Clear button after Hide" : "Clear button after Hide").toBe(
      "Clear button after Hide",
    );
    await userEvent.click(clear!);
    expect(await clipboardNow(), "Clear the clipboard left the key on it").toBe("");
    // Once cleared there is nothing left to offer.
    expect(screen.queryByRole("button", { name: /Clear the clipboard/ })).not.toBeInTheDocument();
  });

  it("keeps Clear the clipboard within reach on the list too", async () => {
    await copyThen(userEvent.setup(), (user) =>
      user.click(screen.getByRole("button", { name: /All subscriptions/ })),
    );
    const clear = screen.queryByRole("button", { name: /Clear the clipboard/ });
    expect(clear === null ? "no Clear button on the list" : "Clear button on the list").toBe(
      "Clear button on the list",
    );
    await userEvent.click(clear!);
    expect(await clipboardNow(), "Clear the clipboard left the key on it").toBe("");
  });

  it("does not offer Clear the clipboard before anything was copied", async () => {
    mockDeriveKey.mockResolvedValue({
      licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      serviceTag: "bitwarden-test",
    });
    await openDetailWithNote();
    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    await screen.findByText("P01-000G-40R4-0M30-E209-185G-R38E-1W");
    await userEvent.click(screen.getByRole("button", { name: /^Hide$/ }));
    expect(screen.queryByRole("button", { name: /Clear the clipboard/ })).not.toBeInTheDocument();
  });

  it("two registry slugs on one (retailer, mint): every slug is a candidate, and the tag the chain confirmed replaces a wrong stored one", async () => {
    // The record was rebuilt by a join that picked acme-basic; the vault was
    // bought under acme-pro. The Worker answers with the tag that verified.
    mockRegistry.mockResolvedValue({
      services: [listing("acme-basic", "Acme Basic"), listing("acme-pro", "Acme Pro")],
    } as never);
    mockDeriveKey.mockResolvedValue({
      licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      serviceTag: "acme-pro",
    });
    await seedRecord({
      serviceTag: "acme-basic",
      serviceName: undefined,
      pool: "PoolPda11111111111111111111111111111111111",
      leafIndex: 19,
    });
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    // Named by the join while the tag is a guess...
    await userEvent.click(await screen.findByText("Acme Basic"));
    expect(screen.getByText(/scoped to: acme-basic/i)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    expect(await screen.findByText("P01-000G-40R4-0M30-E209-185G-R38E-1W")).toBeInTheDocument();

    expect(mockDeriveKey).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceTag: "acme-basic",
        candidateTags: ["acme-basic", "acme-pro", RETAILER],
        licenseCommitment: FIXTURE_LICENSE_HEX,
      }),
    );

    // ...and relabelled by the chain: the record now carries the verified tag
    // and keeps everything else it knew.
    expect(await screen.findByText(/scoped to: acme-pro/i)).toBeInTheDocument();
    await waitFor(async () =>
      expect((await loadSubscriptions(null, "wallet1")).records[0]).toMatchObject({
        serviceTag: "acme-pro",
        pool: "PoolPda11111111111111111111111111111111111",
        leafIndex: 19,
        openTxSig: "4PfrkFakeSignatureForTests",
      }),
    );
    expect(await screen.findAllByText("Acme Pro")).not.toHaveLength(0);
  });

  it("a key none of the candidates reproduces is not shown: the panel says so", async () => {
    mockDeriveKey.mockRejectedValue(
      new Error(
        "key not recoverable for this subscription: none of the 2 service tags tried derives " +
          "the key the vault's license fingerprint was computed from.",
      ),
    );
    await openDetailWithNote();
    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    expect(
      await screen.findByText(/key not recoverable for this subscription/i),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/P01-[0-9A-Z]{4}-/);
    expect(screen.queryByRole("button", { name: /Copy key/ })).not.toBeInTheDocument();
  });

  it("a closed vault has no fingerprint left to check against: no Worker call, no key", async () => {
    await seedRecord({ pool: "PoolPda11111111111111111111111111111111111", leafIndex: 19 });
    render(
      <SubscriptionsPanel
        meta="meta-test"
        owner={OWNER}
        connection={fakeConnection({ slot: START_SLOT + 1_500, accounts: {} })}
      />,
    );
    await userEvent.click(await screen.findByText("Bitwarden Test"));
    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    expect(
      await screen.findByText(/key not recoverable for this subscription/i),
    ).toBeInTheDocument();
    expect(mockDeriveKey).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/P01-[0-9A-Z]{4}-/);
  });

  it("a failed re-derivation shows the reason, not a key", async () => {
    mockDeriveKey.mockRejectedValue(
      new Error("This browser does not hold the note that paid for this subscription."),
    );
    await openDetailWithNote();
    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    expect(
      await screen.findByText(/does not hold the note that paid/i),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/P01-[0-9A-Z]{4}-/);
  });

  it("a vault tracked by address alone says the key lives elsewhere, no Reveal", async () => {
    await seedRecord(); // no pool, no leafIndex: exactly what track-by-address writes
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.click(await screen.findByText("Bitwarden Test"));

    expect(
      await screen.findByText(/cannot re-derive the key here/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reveal key/ })).not.toBeInTheDocument();
    expect(mockDeriveKey).not.toHaveBeenCalled();
  });
});

describe("master-detail", () => {
  it("keeps the list mounted beside the open detail (columns from lg)", async () => {
    await seedRecord();
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.click(await screen.findByText("Bitwarden Test"));

    // Both panes exist at once: the detail is open AND the list (with its
    // Track form) is still mounted. Below lg the list pane is hidden by CSS
    // only, which is what lets the selection survive a viewport resize.
    expect(await screen.findByText("No cancel, no refund")).toBeInTheDocument();
    expect(screen.getByText("Track a vault")).toBeInTheDocument();
    // The back button exists for the narrow layout.
    expect(screen.getByRole("button", { name: /All subscriptions/ })).toBeInTheDocument();
  });

  it("shows a placeholder in the detail pane until something is selected", async () => {
    await seedRecord();
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(
      await screen.findByText(/Pick a subscription to see its status/i),
    ).toBeInTheDocument();
  });
});

describe("recover from the chain (#11)", () => {
  // The scan itself (enumeration shape, matching, the leak-regression
  // contract) is pinned in lib/privacy/pool/subscriptionRecovery.test.ts; the
  // record-merging half in __tests__/lib/paySubscriptionsRecovery.test.ts.
  // Here: the panel offers it, states the privacy shape honestly, and surfaces
  // a failure as an error rather than as "you own nothing".
  it("offers the recovery and says what does and does not leave the device", async () => {
    render(
      <SubscriptionsPanel meta="meta-test" owner={OWNER} connection={fakeConnection({ slot: 1 })} />,
    );
    expect(await screen.findByText("Recover from the chain")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recover subscriptions/i })).toBeInTheDocument();
    expect(screen.getByText(/one pool-wide question/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing derived from your notes leaves this device/i)).toBeInTheDocument();
  });

  it("a dead worker surfaces as an error, never as an empty recovery", async () => {
    render(
      <SubscriptionsPanel meta="meta-test" owner={OWNER} connection={fakeConnection({ slot: 1 })} />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Recover subscriptions/i }),
    );
    expect(
      await screen.findByText(/The private-payment worker is unavailable in this test\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No open subscription vault/i)).not.toBeInTheDocument();
  });
});

describe("stale worker — version skew, task #12", () => {
  // The three states the panel must keep apart. Same records, three worlds:
  //   populated + readable → the list;
  //   genuinely empty      → the ordinary empty state, no banner;
  //   sealed + SKEWED      → the reload line, and NEVER the empty state —
  // painting "No subscriptions tracked yet" over records that exist is
  // indistinguishable, to the user, from their subscriptions being gone.

  it("genuinely empty under an old worker: ordinary empty state, no banner", async () => {
    worker.mode = "skew";
    render(
      <SubscriptionsPanel
        meta="meta-skew-empty"
        owner={OWNER}
        connection={fakeConnection({ slot: 1 })}
      />,
    );
    // Nothing is sealed anywhere, so the loader never even asks the worker:
    // an old worker over an empty store is indistinguishable from a current
    // one, and must render exactly the same.
    expect(
      await screen.findByText(/No subscriptions tracked in this browser yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/older version of the app/i)).not.toBeInTheDocument();
  });

  it("sealed records under an old worker: says 'reload this tab', not the empty state", async () => {
    worker.mode = "skew";
    // Seed ONE record through the real store against the old worker. The
    // first record finds an empty bucket, needs no openRecords round trip,
    // and seals fine — exactly the store a real user has when the page
    // updates under their open tab.
    await recordSubscription("meta-skew", "wallet1", {
      vaultPDA: VAULT_ADDR,
      retailer: "q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr",
      serviceTag: "bitwarden-test",
      token: "SOL",
      denomination: 1,
      rate: "50000000",
      intervalSlots: "1500",
      openedAt: Date.now(),
    });
    // Really sealed (v2), not the v1 fallback — otherwise this test would
    // pass through the cleartext union and prove nothing about skew.
    expect(localStorage.getItem("p01_pay_subscriptions_v1")).toBeNull();
    expect(localStorage.getItem("p01_pay_subscriptions_v2")).not.toBeNull();

    render(
      <SubscriptionsPanel meta="meta-skew" owner={OWNER} connection={fakeConnection({ slot: 1 })} />,
    );
    expect(await screen.findByText(/reload this tab/i)).toBeInTheDocument();
    // The false alarm this exists to prevent:
    expect(
      screen.queryByText(/No subscriptions tracked in this browser yet/i),
    ).not.toBeInTheDocument();
  });

  it("a DEAD worker is not skew: the v1 view serves in full and no banner shows", async () => {
    // worker.mode stays "dead" (beforeEach): the sealed write falls back to
    // v1 and the list paints completely — a banner over a complete list would
    // be the false alarm in the other direction.
    await seedRecord();
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(await screen.findByText("Bitwarden Test")).toBeInTheDocument();
    expect(screen.queryByText(/reload this tab/i)).not.toBeInTheDocument();
  });
});

describe("restarted worker — lost session, task #16", () => {
  // The SECOND cause of the same empty symptom, with a DIFFERENT cure. The
  // worker crashed under the open tab and was rebooted with every seed wiped;
  // the main thread's cached storeSession still carries the page to the open
  // call, which the rebooted worker refuses. Re-SIGNING heals it; a reload
  // alone does not — so showing the reload line here would send the user to
  // a step that does not fix it, which is worse than no banner.

  it("sealed records under a restarted worker: says 'sign again', never 'reload', never the empty state", async () => {
    // Seed ONE sealed record while the worker session is live ("skew" mode
    // answers the session handlers, and the first record needs no openRecords
    // round trip, so it seals fine). This also caches the main-thread
    // storeSession — the exact state a real tab is in at the crash.
    worker.mode = "skew";
    await recordSubscription("meta-restart", "wallet1", {
      vaultPDA: VAULT_ADDR,
      retailer: "q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr",
      serviceTag: "bitwarden-test",
      token: "SOL",
      denomination: 1,
      rate: "50000000",
      intervalSlots: "1500",
      openedAt: Date.now(),
    });
    expect(localStorage.getItem("p01_pay_subscriptions_v1")).toBeNull();
    expect(localStorage.getItem("p01_pay_subscriptions_v2")).not.toBeNull();

    worker.mode = "restarted";
    render(
      <SubscriptionsPanel
        meta="meta-restart"
        owner={OWNER}
        connection={fakeConnection({ slot: 1 })}
      />,
    );

    expect(await screen.findByText(/sign to derive your keys again/i)).toBeInTheDocument();
    // The wrong instruction for this cause — the user would try it, nothing
    // would change, and the records would read as gone:
    expect(screen.queryByText(/reload this tab/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/older version of the app/i)).not.toBeInTheDocument();
    // And the false alarm both banners exist to prevent:
    expect(
      screen.queryByText(/No subscriptions tracked in this browser yet/i),
    ).not.toBeInTheDocument();
  });

  it("genuinely empty under a restarted worker: ordinary empty state, no banner", async () => {
    // A session existed (cached), but nothing was ever stored: the loader
    // must short-circuit before the worker is asked, so an empty wallet is
    // never told to re-sign over an empty list.
    worker.mode = "skew";
    await loadSubscriptions("meta-restart-empty", "wallet1");
    worker.mode = "restarted";
    render(
      <SubscriptionsPanel
        meta="meta-restart-empty"
        owner={OWNER}
        connection={fakeConnection({ slot: 1 })}
      />,
    );
    expect(
      await screen.findByText(/No subscriptions tracked in this browser yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sign to derive your keys again/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reload this tab/i)).not.toBeInTheDocument();
  });
});

/**
 * Sweep round 1 (2026-09-20), record 33.
 *
 * The list used to read every recorded vault PDA one by one, on mount, on
 * every `storage` event in any tab, and again right after the recovery that
 * exists to avoid exactly that. A private vault's PDA is seeded on
 * `subscriber_commitment`, the circuit-0 commitment over the paying note's
 * secret, so the set of PDAs is this identity's subscriptions — merchant, rate
 * and interval — named together from one IP. `subscriptionRecovery.ts` says it
 * in its own header: "derive each note's vault PDA and probe it ... is leak L4
 * in a new costume", and it answers ONE question whose answer is identical for
 * every user, a discriminator-filtered `getProgramAccounts`. The list now asks
 * that same question.
 */
describe("sweep 1, record 33: how the list reads vault state", () => {
  it("names no vault PDA to the RPC: it takes the state from the program-wide enumeration", async () => {
    await seedRecord();
    const reads: string[] = [];
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      reads,
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    // The row is standing, so the read that feeds it has happened.
    expect(await screen.findByText("19 of 20 periods left, about 3 hours")).toBeInTheDocument();
    expect(reads.filter((r) => r !== "getProgramAccounts"), "the list named a vault PDA").toEqual([]);
    expect(reads).toContain("getProgramAccounts");
  });

  /**
   * 🚨 GATE r1, RED 7d. A FIRST-TIME USER MUST ASK THE RPC NOTHING.
   *
   * The list read moved from one `getAccountInfo(vaultPDA)` per row to one
   * program-wide `getProgramAccounts` — right, and the reason is in the panel.
   * But the old shape made ZERO requests when there were zero rows, and the new
   * one fires the enumeration unconditionally: on mount, and again on every
   * coalesced storage burst. This tab is the one a first-time user opens.
   *
   * It is not a private read — the enumeration is identical for every user — but
   * it is a REQUEST FROM THIS IP, to this deployment's provider, for the
   * subscription program, made by somebody who has no subscriptions. It says
   * this browser opened the subscriptions tab, and it costs a round trip on
   * every burst for an answer that cannot change what is rendered.
   */
  it("asks the RPC nothing at all when this browser tracks no subscription", async () => {
    const reads: string[] = [];
    const conn = fakeConnection({ slot: START_SLOT + 1_500, accounts: {}, reads });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);

    // The empty state is on screen, so the panel really did finish its work.
    expect(await screen.findByText(/Track a vault/i)).toBeInTheDocument();
    await waitFor(() => expect(reads).toEqual([]));

    // And a burst of storage events changes nothing: still no rows, still no
    // requests.
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("storage"));
    await waitFor(() => expect(reads).toEqual([]));
  });

  it("still asks once as soon as there IS a row, so the empty case is not a dead panel", async () => {
    // The anti-vacuity sibling: the case above must be about the EMPTY list and
    // not about a harness that never reaches the read.
    await seedRecord();
    const reads: string[] = [];
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      reads,
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(await screen.findByText("19 of 20 periods left, about 3 hours")).toBeInTheDocument();
    expect(reads).toEqual(["getProgramAccounts"]);
  });

  it("a burst of storage events does not become a burst of reads", async () => {
    await seedRecord();
    const reads: string[] = [];
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      reads,
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    expect(await screen.findByText("19 of 20 periods left, about 3 hours")).toBeInTheDocument();
    const afterMount = reads.length;
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("storage"));
    await waitFor(() => expect(reads.length).toBeGreaterThan(afterMount));
    // One catch-up for the burst, not one per event.
    await waitFor(() => expect(reads.length - afterMount).toBeLessThanOrEqual(1));
    expect(reads.filter((r) => r !== "getProgramAccounts")).toEqual([]);
  });
});

/**
 * Sweep round 1 (logs8), fix lane 2: THE TWO PRESSES RECORD 33 LEFT POINTED.
 *
 * The list stopped naming vault PDAs; Reveal key and Track still made one
 * `getAccountInfo(vault)` each. A vault PDA is seeded on the paying note's
 * secret, so from Reveal that read says "this IP holds the key to vault V" —
 * a new link for a vault recovered from another device or revealed from another
 * network — and from Track it says "this IP is interested in vault V", about a
 * vault that by construction was opened elsewhere. A fresh enumeration serves
 * the same bytes, read now and not from the list's snapshot, and names nothing.
 */
describe("sweep round 1, fix lane 2: Reveal and Track name no vault to the RPC", () => {
  it("Reveal key reads the vault from a fresh enumeration, never by its address", async () => {
    mockDeriveKey.mockResolvedValue({
      licenseKey: "P01-000G-40R4-0M30-E209-185G-R38E-1W",
      serviceTag: "bitwarden-test",
    });
    await seedRecord({ pool: "PoolPda11111111111111111111111111111111111", leafIndex: 19 });
    const reads: string[] = [];
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      reads,
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.click(await screen.findByText("Bitwarden Test"));
    const before = reads.length;

    await userEvent.click(await screen.findByRole("button", { name: /Reveal key/ }));
    // Positive control: the press really ran, to the end.
    expect(await screen.findByText("P01-000G-40R4-0M30-E209-185G-R38E-1W")).toBeInTheDocument();

    const byReveal = reads.slice(before);
    expect(byReveal.filter((r) => r !== "getProgramAccounts"), "Reveal named a vault PDA").toEqual(
      [],
    );
    // "Read the account now rather than trust the list's snapshot" still holds:
    // the press asks again, it just asks the uniform question.
    expect(byReveal).toContain("getProgramAccounts");
    // And the bytes are the same ones: the Worker still gets the on-chain
    // fingerprint to check the key against.
    expect(mockDeriveKey).toHaveBeenCalledWith(
      expect.objectContaining({ licenseCommitment: FIXTURE_LICENSE_HEX }),
    );
  });

  it("Track looks the pasted address up in the enumeration, never by its address", async () => {
    const reads: string[] = [];
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      reads,
    });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));

    // Positive control: the press really recorded the vault.
    await waitFor(async () =>
      expect((await loadSubscriptions(null, "wallet1")).records).toHaveLength(1),
    );
    expect(await screen.findByText("No cancel, no refund")).toBeInTheDocument();
    expect(reads.filter((r) => r !== "getProgramAccounts"), "Track named the pasted address").toEqual(
      [],
    );
    expect(reads).toContain("getProgramAccounts");
  });

  it("Track refuses an address that is not among the program's live vaults, without naming it", async () => {
    const reads: string[] = [];
    const conn = fakeConnection({ slot: START_SLOT + 1_500, accounts: {}, reads });
    render(<SubscriptionsPanel meta="meta-test" owner={OWNER} connection={conn} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Track/ })).not.toBeDisabled());
    await waitFor(() => expect(reads.length).toBeGreaterThan(0));
    expect(reads.filter((r) => r !== "getProgramAccounts"), "Track named the pasted address").toEqual(
      [],
    );
    expect((await loadSubscriptions(null, "wallet1")).records).toHaveLength(0);
  });
});

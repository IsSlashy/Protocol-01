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
}): Connection {
  return {
    rpcEndpoint: "https://fake.test",
    getSlot: async () => {
      if (opts.slot == null) throw new Error("no slot");
      return opts.slot;
    },
    getAccountInfo: async (pk: { toBase58(): string }) => {
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
      screen.getByText(/remaining balance, any dust and the vault's own rent all go to the merchant/i),
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
    const links = (await screen.findAllByRole("link")) as HTMLAnchorElement[];
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain(`https://explorer.solana.com/address/${VAULT_ADDR}?cluster=devnet`);
    expect(hrefs).toContain(
      "https://explorer.solana.com/tx/4PfrkFakeSignatureForTests?cluster=devnet",
    );
  });

  it("does not suggest the subscription is unlinkable", async () => {
    await openDetail();
    expect(
      await screen.findByText(/unlinkable to your wallet only to the extent the pool is/i),
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
    expect(
      await screen.findByText(/not owned by the subscription program/i),
    ).toBeInTheDocument();
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
      await screen.findByText(/Select a subscription to see its standing/i),
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

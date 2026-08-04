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
  recordSubscription,
  loadSubscriptions,
} from "@/lib/pay/subscriptions";

// ---------------------------------------------------------------------------
// Stub: the vendor roster (network) and its formatter.
// ---------------------------------------------------------------------------

vi.mock("@/lib/privacy/serviceRegistry", () => ({
  NATIVE_SOL_SENTINEL_MINT: "11111111111111111111111111111111",
  loadServiceRegistry: vi.fn(() => Promise.resolve({ services: [] })),
  formatInterval: (slots: bigint) => `every ${Math.round(Number(slots) * 0.4)} s`,
}));

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

function seedRecord(over: Partial<Parameters<typeof recordSubscription>[1]> = {}) {
  recordSubscription("wallet1", {
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
});

// ---------------------------------------------------------------------------

describe("empty state", () => {
  it("says nothing is tracked and offers both ways in", async () => {
    render(<SubscriptionsPanel owner={OWNER} connection={fakeConnection({ slot: 1 })} />);
    expect(
      await screen.findByText(/No subscriptions tracked in this browser yet/i),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Vault address")).toBeInTheDocument();
  });
});

describe("list standing", () => {
  it("reads the vault and says periods left in plain words", async () => {
    seedRecord();
    // One interval past start: 19 of 20 periods left, 28,500 slots of
    // entitlement, nominally 11,400 s, "about 3 hours".
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel owner={OWNER} connection={conn} />);
    expect(
      await screen.findByText("19 of 20 periods left, about 3 hours"),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Bitwarden Test")).toBeInTheDocument();
  });

  it("a missing account renders CLOSED with the merchant-gets-everything truth", async () => {
    seedRecord();
    const conn = fakeConnection({ slot: START_SLOT + 1_500, accounts: {} });
    render(<SubscriptionsPanel owner={OWNER} connection={conn} />);
    expect(
      await screen.findByText(/Closed, fully paid out to the merchant/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("an unfetchable clock says Checking, never Active", async () => {
    seedRecord();
    const conn = fakeConnection({
      slot: null,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel owner={OWNER} connection={conn} />);
    expect(await screen.findByText("Checking")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });
});

describe("detail page", () => {
  async function openDetail() {
    seedRecord();
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel owner={OWNER} connection={conn} />);
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
    render(<SubscriptionsPanel owner={OWNER} connection={fakeConnection({ slot: 1 })} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), "not-an-address");
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));
    expect(await screen.findByText("That is not a Solana address.")).toBeInTheDocument();
    expect(loadSubscriptions("wallet1")).toHaveLength(0);
  });

  it("refuses an account the program does not own", async () => {
    const conn = fakeConnection({
      slot: 1,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
      ownerOverride: "SomeOtherProgram1111111111111111111111111111",
    });
    render(<SubscriptionsPanel owner={OWNER} connection={conn} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));
    expect(
      await screen.findByText(/not owned by the subscription program/i),
    ).toBeInTheDocument();
    expect(loadSubscriptions("wallet1")).toHaveLength(0);
  });

  it("records a real vault from its address alone, from chain data", async () => {
    const conn = fakeConnection({
      slot: START_SLOT + 1_500,
      accounts: { [VAULT_ADDR]: hexToBytes(DEVNET_VAULT_HEX) },
    });
    render(<SubscriptionsPanel owner={OWNER} connection={conn} />);
    await userEvent.type(screen.getByPlaceholderText("Vault address"), VAULT_ADDR);
    await userEvent.click(screen.getByRole("button", { name: /Track/ }));

    await waitFor(() => expect(loadSubscriptions("wallet1")).toHaveLength(1));
    const rec = loadSubscriptions("wallet1")[0]!;
    expect(rec.vaultPDA).toBe(VAULT_ADDR);
    expect(rec.retailer).toBe("q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr");
    // No registry entry in this test, so the tag falls back to the retailer.
    expect(rec.serviceTag).toBe("q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr");
    expect(rec.token).toBe("SOL");
    expect(rec.denomination).toBe(1);
    // Tracking lands on the detail page for the vault just added.
    expect(await screen.findByText("No cancel, no refund")).toBeInTheDocument();
  });
});

/**
 * PayApp — what the determinism check leaves behind in this browser's storage.
 *
 * Web sweep 4, round 1, item 17.
 *
 * A wallet that is not one of ours is asked to sign the derivation message
 * TWICE, and the two signatures are compared: a signer that adds entropy would
 * derive keys nobody can rebuild next session. The answer is a property of the
 * wallet, so a PASS is remembered and the second prompt is skipped afterwards —
 * the prompt people get stuck on.
 *
 * What was remembered was the wallet's own address, in clear, in a list that is
 * never pruned. A storage dump therefore NAMED every Phantom or Solflare that
 * ever derived here, and with it the wallet behind the opaque store label, the
 * pending index and the history rows beside it — the property `sealedStore.ts`
 * states ("possession of a storage dump no longer names the wallet") undone by
 * a cache.
 *
 * So the assertions are about what a dump contains, not about which spelling is
 * used: the wallet's address must not be reachable from anything this app wrote,
 * and the second prompt must still be skipped on the next visit, or the fix
 * would have paid for privacy with the popup it was written to avoid.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** A third-party wallet: not the P01 extension, not the in-page keypair. */
const WALLET = "7gTQmHpHc3Cvt1BSTrTeYxvYxDrUqoSVW1uMJSQi2Hcu";

/** Deterministic, like a wallet that passes the check. */
const SIGNATURE = new Uint8Array(64).map((_, i) => (i * 7 + 11) & 0xff);
const signMessage = vi.fn(async (_message: Uint8Array) => Uint8Array.from(SIGNATURE));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: { toBase58: () => WALLET, toString: () => WALLET },
    connected: true,
    connecting: false,
    disconnect: vi.fn(),
    connect: vi.fn(),
    select: vi.fn(),
    wallet: { adapter: { name: "Phantom", connected: true } },
    wallets: [{ adapter: { name: "Phantom", connected: true }, readyState: "Installed" }],
    signMessage: (m: Uint8Array) => signMessage(m),
    signTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  }),
  useConnection: () => ({ connection: { rpcEndpoint: "http://localhost:8899" } }),
}));

// Everything that would pull a Worker or a pool scan into jsdom. The identity
// derivation itself is stubbed too: what this file measures is what the CHECK
// writes down, and the real derivation is covered by its own suites.
const deriveMeta = vi.fn(async (_sig: Uint8Array) => ({
  meta: "p01pq:meta-under-test",
  spendPub: "spend",
  viewPub: "view",
}));
vi.mock("@/lib/privacy/chains", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/chains")>();
  return {
    ...actual,
    getAdapter: () => ({ deriveMeta: (sig: Uint8Array) => deriveMeta(sig) }),
    setSolanaSignerRuntime: vi.fn(),
    clearStealthSessions: vi.fn(),
  };
});
vi.mock("@/lib/privacy/workerClient", () => ({ initStealthWorker: vi.fn() }));
vi.mock("@/components/pay/SendForm", () => ({ default: () => null }));
vi.mock("@/components/pay/ReceivePanel", () => ({ default: () => null }));
vi.mock("@/components/pay/PoolPanel", () => ({ default: () => null }));
vi.mock("@/components/pay/SubscribePanel", () => ({ default: () => null }));
vi.mock("@/components/pay/SubscriptionsPanel", () => ({ default: () => null }));
vi.mock("@/components/pay/P01ConnectModal", () => ({ default: () => null }));

import PayApp from "@/components/pay/PayApp";

/** Everything this origin's localStorage holds, keys and values, as one string. */
function storageDump(): string {
  const parts: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k === null) continue;
    parts.push(k, window.localStorage.getItem(k) ?? "");
  }
  return parts.join("\u0000");
}

async function derive(): Promise<void> {
  const user = userEvent.setup();
  render(<PayApp />);
  await user.click(await screen.findByRole("button", { name: /Sign to create your keys/i }));
  await waitFor(() => expect(deriveMeta).toHaveBeenCalled());
}

beforeEach(() => {
  window.localStorage.clear();
  signMessage.mockClear();
  deriveMeta.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("the determinism pass is remembered without naming the wallet", () => {
  it("leaves no window of the wallet address in this browser's storage", async () => {
    await derive();
    const dump = storageDump();
    // Positive control first: the check DID run and DID record something, so a
    // clean dump cannot be a test that simply never reached the cache.
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(dump.length).toBeGreaterThan(0);
    // Windows, not the whole address: a prefix is as good as the address to
    // anyone holding the public repository of wallets.
    const windows: string[] = [];
    for (let i = 0; i + 8 <= WALLET.length; i++) {
      const w = WALLET.slice(i, i + 8);
      if (dump.includes(w)) windows.push(w);
    }
    expect(windows).toEqual([]);
  });

  it("still skips the second prompt on the next visit", async () => {
    await derive();
    expect(signMessage).toHaveBeenCalledTimes(2);
    cleanup();
    signMessage.mockClear();
    deriveMeta.mockClear();
    await derive();
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("removes a list an older version of this app left behind", async () => {
    window.localStorage.setItem(
      "p01_deterministic_signer_v1",
      JSON.stringify([WALLET, "SoLfLaRe1111111111111111111111111111111111"]),
    );
    await derive();
    expect(window.localStorage.getItem("p01_deterministic_signer_v1")).toBeNull();
    expect(storageDump()).not.toContain("SoLfLaRe");
  });
});

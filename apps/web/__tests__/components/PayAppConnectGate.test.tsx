/**
 * PayApp — gate 1, the connect screen, and the doors it offers.
 *
 * THIS FILE EXISTS BECAUSE THE GATE WAS ONCE CLOSED BY A CORRECT ARGUMENT.
 *
 * On 2026-08-17 every door but the P01 extension was removed here, reasoning
 * that a buyer who connects an external wallet is a buyer whose deposit can
 * name them. The reasoning is right and is unchanged. What it did in practice
 * was different: a browser without the extension got a screen that said so and
 * stopped, so shield, subscribe and the whole /pay app were unreachable rather
 * than public. Nothing was made private by it — the walk it avoids is still two
 * RPC calls — and the honest disclosure that would have described the linkage
 * never rendered, because nothing ever completed.
 *
 * So the assertions below are about REACHABILITY, not preference:
 *
 *   1. A browser that has Phantom can connect it. That is the regression that
 *      cost the product its entire entry path, and it is the first test.
 *   2. The P01 extension still LEADS. Order is the argument, and a fallback
 *      that quietly becomes the default would undo the point of the fold.
 *   3. The cost is stated on the screen, next to the button, not in a doc.
 *   4. A wallet the browser does not actually have is never offered — a button
 *      that opens a download page reads as a broken connect.
 *
 * `useWallet` is stubbed because the gate is a pure function of what the
 * adapter reports; the heavy panels are stubbed because they only mount after
 * the gate and would pull a Web Worker into jsdom.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const select = vi.fn();
let walletState: {
  wallets: Array<{ adapter: { name: string; icon?: string; connected?: boolean }; readyState: string }>;
  connected: boolean;
};

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: null,
    connected: walletState.connected,
    signMessage: undefined,
    signTransaction: undefined,
    signAllTransactions: undefined,
    disconnect: vi.fn(),
    wallets: walletState.wallets,
    select,
  }),
  useConnection: () => ({ connection: { rpcEndpoint: "http://localhost:8899" } }),
}));

// Everything behind the gate. None of it mounts while disconnected; stubbing it
// keeps a Worker and a pool scan out of this test rather than out of the app.
vi.mock("@/lib/privacy/workerClient", () => ({ initStealthWorker: vi.fn() }));
vi.mock("@/components/pay/SendForm", () => ({ default: () => null }));
vi.mock("@/components/pay/ReceivePanel", () => ({ default: () => null }));
vi.mock("@/components/pay/PoolPanel", () => ({ default: () => null }));
vi.mock("@/components/pay/SubscribePanel", () => ({ default: () => null }));
vi.mock("@/components/pay/SubscriptionsPanel", () => ({ default: () => null }));
vi.mock("@/components/pay/P01ConnectModal", () => ({ default: () => null }));

import PayApp from "@/components/pay/PayApp";

const phantom = {
  adapter: { name: "Phantom", icon: "data:image/svg+xml,<svg/>", connected: false },
  readyState: "Installed",
};
const p01 = {
  adapter: { name: "Protocol 01", connected: false },
  readyState: "Installed",
};

beforeEach(() => {
  select.mockClear();
  walletState = { wallets: [], connected: false };
});

describe("the connect gate offers every door the browser actually has", () => {
  it("offers Phantom when Phantom is installed, and selecting it connects", async () => {
    walletState.wallets = [phantom];
    render(<PayApp />);

    const button = screen.getByRole("button", { name: /connect phantom/i });
    await userEvent.click(button);

    // `select()` alone is the whole connect — the adapter connects on selection,
    // which is why there is no second step and no modal to assert.
    expect(select).toHaveBeenCalledWith("Phantom");
  });

  it("still leads with the P01 extension when both are installed", () => {
    walletState.wallets = [phantom, p01];
    render(<PayApp />);

    const p01Button = screen.getByRole("button", { name: /connect the p01 extension/i });
    const phantomButton = screen.getByRole("button", { name: /connect phantom/i });

    // Order is the argument: the product's own wallet is first in the document,
    // the external one is under a fold that names what it costs.
    expect(p01Button.compareDocumentPosition(phantomButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("states the cost of an external wallet next to the button, not elsewhere", () => {
    walletState.wallets = [phantom];
    render(<PayApp />);

    // The claim has to survive a copy edit, so match the mechanism rather than
    // the sentence: a deposit an external wallet pays for is walkable back.
    expect(screen.getByText(/walked back/i)).toBeInTheDocument();
  });

  it("never offers a wallet the browser does not have", () => {
    walletState.wallets = [{ adapter: { name: "Solflare" }, readyState: "NotDetected" }];
    render(<PayApp />);

    expect(screen.queryByRole("button", { name: /connect solflare/i })).toBeNull();
  });

  it("does not leave a buyer with no extension at a dead end", () => {
    walletState.wallets = [phantom];
    render(<PayApp />);

    // The "extension is not installed" notice is still there and still tells the
    // truth, but it may no longer be the last word on the screen.
    expect(screen.getByText(/the p01 extension is not installed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect phantom/i })).toBeInTheDocument();
  });

  it("says so honestly when there is genuinely nothing to connect", () => {
    walletState.wallets = [];
    render(<PayApp />);

    expect(screen.getByText(/the p01 extension is not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/no other wallet announced itself/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^connect /i })).toBeNull();
  });
});

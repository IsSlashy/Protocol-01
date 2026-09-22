/**
 * /sdk-demo: what the page sends, to whom, and on whose press.
 *
 * Sweep round 1 (logs8), fix lane 2. The page reconnects the P01 extension
 * silently when this ORIGIN was approved before (`connect({ onlyIfTrusted:
 * true })`), which is what restores the "already subscribed" button state on a
 * reload and sends nothing off the device by itself. But the Devnet section then
 * read the balance as soon as it saw a wallet, and again every 10 s: a
 * `getBalance` naming the wallet, from the visitor's IP, to the public devnet
 * RPC — a provider other than the deployment's own — with no click at all and
 * for as long as the tab stayed open (probe: logs8/r1-network/
 * probes-run2-sdkdemo.log, requests at t = 1, 11, 21, 31 s).
 *
 * What is pinned here: the silent reconnect stays, and the wallet is named to
 * that RPC only on a press — Connect, the balance's Refresh, the airdrop — once
 * per press, never on a timer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import SDKDemoPage from '@/app/sdk-demo/page';

const WALLET = 'Wa11etOfThePayAppUser1111111111111111111111';

interface Sent {
  t: number;
  url: string;
  body: { method?: string; params?: unknown[] } | null;
}

function stubFetch(): Sent[] {
  const sent: Sent[] = [];
  const t0 = Date.now();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      sent.push({
        t: Math.round((Date.now() - t0) / 1000),
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ approved: false, result: { value: 1_500_000_000 } }),
      } as unknown as Response;
    }),
  );
  return sent;
}

/** The extension, stubbed. `trusted` = this origin was approved before, so a
 *  trusted-only connect answers silently; otherwise it throws, as the real one
 *  does, and only a plain connect (a press) answers. */
function stubExtension(opts: { trusted: boolean }): Array<{ onlyIfTrusted?: boolean } | undefined> {
  const connectCalls: Array<{ onlyIfTrusted?: boolean } | undefined> = [];
  (window as unknown as Record<string, unknown>).protocol01 = {
    isProtocol01: true,
    isConnected: false,
    publicKey: null,
    connect: async (o?: { onlyIfTrusted?: boolean }) => {
      connectCalls.push(o);
      if (o?.onlyIfTrusted && !opts.trusted) throw new Error('not trusted');
      return { publicKey: { toBase58: () => WALLET } };
    },
    disconnect: async () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
  return connectCalls;
}

async function letTimePass(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  }
}

const namingWallet = (sent: Sent[]) => sent.filter((s) => JSON.stringify(s).includes(WALLET));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).protocol01;
});

describe('/sdk-demo opened by a visitor whose extension already trusts this origin', () => {
  it('reconnects silently, shows the wallet, and names it to nobody without a press', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent = stubFetch();
    const connectCalls = stubExtension({ trusted: true });

    render(<SDKDemoPage />);
    await letTimePass(35);

    // Positive controls: the silent reconnect ran and the page IS connected, so
    // the silence below is not a page that never saw a wallet.
    expect(connectCalls).toEqual([{ onlyIfTrusted: true }]);
    expect(screen.getByText(WALLET)).toBeInTheDocument();

    expect(
      namingWallet(sent).map((s) => `${s.t}s ${s.url} ${s.body?.method ?? ''}`),
      'the wallet was named with no press',
    ).toEqual([]);
  });

  it('reads the balance once when Refresh is pressed, and never again on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent = stubFetch();
    stubExtension({ trusted: true });

    render(<SDKDemoPage />);
    await letTimePass(3);
    expect(screen.getByText(WALLET)).toBeInTheDocument();
    const before = namingWallet(sent).length;

    const refresh = screen.queryByRole('button', { name: /Devnet Balance/ });
    expect(refresh === null ? 'no balance Refresh button' : 'balance Refresh button').toBe(
      'balance Refresh button',
    );
    await act(async () => {
      fireEvent.click(refresh!);
    });
    await letTimePass(35);

    const reads = namingWallet(sent).slice(before);
    expect(reads.map((s) => `${s.url} ${s.body?.method}`)).toEqual([
      'https://api.devnet.solana.com getBalance',
    ]);
    // And the press did its job: the answer is on screen.
    expect(screen.getByText('1.5000 SOL')).toBeInTheDocument();
  });
});

describe('/sdk-demo, a visitor who presses Connect', () => {
  it('reads the balance once for that press, and not again every 10 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent = stubFetch();
    const connectCalls = stubExtension({ trusted: false });

    render(<SDKDemoPage />);
    await letTimePass(3);
    expect(namingWallet(sent)).toEqual([]);

    // The Devnet section's own Connect button; the other tabs are not mounted.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Styx' }));
    });
    await letTimePass(35);

    // Positive controls: the press connected, and its one read was answered.
    expect(connectCalls.filter((c) => !c?.onlyIfTrusted)).toHaveLength(1);
    expect(screen.getByText(WALLET)).toBeInTheDocument();
    expect(screen.getByText('1.5000 SOL')).toBeInTheDocument();

    expect(
      namingWallet(sent).map((s) => `${s.url} ${s.body?.method}`),
      'one press, one read',
    ).toEqual(['https://api.devnet.solana.com getBalance']);
  });
});

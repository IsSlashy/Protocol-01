import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthDemoPage from '@/app/demo/auth/page';

/**
 * Rewritten 2026-08-11.
 *
 * What this replaces: a suite written in French against a pre-Styx copy of the
 * page ("Configuration Service", "Generer QR Code", "LOGS", "Comment ca
 * marche?"), parked behind `describe.skip` because every string it looked for
 * had been rewritten. Parked meant the route had zero coverage, so the port
 * could have broken the payload, the deep link or the expiry clock without a
 * single test noticing.
 *
 * Nothing here is skipped. The assertions read the current page, the deep link
 * payload is decoded rather than pattern matched, and the two frozen wire
 * constants are pinned by value: `p01://auth` (the scheme the mobile app
 * registers) and `p01-auth` (the protocol id `parseAuthQR` compares against in
 * apps/mobile/services/auth/p01Auth.ts). Renaming either one breaks scanning
 * with no error on this side, so a test says so.
 *
 * The honesty assertions are deliberate too. This screen is a mock, and the
 * suite fails if the copy starts claiming an audit, a mainnet deployment or
 * anonymity, or if the log announces a success nothing verified.
 */

const DEMO_WALLET = '7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm';
const PLACEHOLDER_MINT = 'StyxDemoSubscriptionMint1111111111111111';

/** The QR mock in __tests__/setup.tsx exposes the encoded value it was given. */
function deepLink(): string {
  return screen.getByTestId('qr-code').getAttribute('data-value') ?? '';
}

function decodePayload(link: string): Record<string, unknown> {
  const url = new URL(link.replace('p01://', 'https://styx.invalid/'));
  const encoded = url.searchParams.get('payload');
  expect(encoded).toBeTruthy();
  let base64 = (encoded as string).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return JSON.parse(atob(base64)) as Record<string, unknown>;
}

function generate(): void {
  fireEvent.click(screen.getByText('Generate QR code'));
}

function completeLocally(): void {
  fireEvent.click(screen.getByText('Fake a completed session'));
}

/** Everything the visible console has printed, as one string. */
function eventLogText(): string {
  return screen.getByText('Event log').closest('.styx-panel')?.textContent ?? '';
}

/** The page body only, so header and footer copy cannot mask a page defect. */
function pageText(): string {
  return document.getElementById('styx-content')?.textContent ?? '';
}

function sectionOf(heading: string): HTMLElement {
  const el = screen.getByText(heading).closest('.styx-section');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('AuthDemoPage: QR sign-in demo', () => {
  beforeEach(() => {
    sessionStorage.clear();
    render(<AuthDemoPage />);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Hero', () => {
    it('labels itself a demo of QR sign-in', () => {
      expect(
        screen.getByText('Styx Protocol · Demo · QR sign-in'),
      ).toBeInTheDocument();
    });

    it('titles the page "Sign in with Styx."', () => {
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1.textContent?.replace(/\s+/g, ' ').trim()).toBe('Sign in with Styx.');
    });

    it('names the three states it can reach without a phone', () => {
      expect(
        screen.getByText(/pending, completed, expired/),
      ).toBeInTheDocument();
    });

    it('links to the docs and back to the site', () => {
      expect(screen.getByText('Read the docs').closest('a')).toHaveAttribute(
        'href',
        '/docs',
      );
      expect(screen.getByText('Back to the site').closest('a')).toHaveAttribute(
        'href',
        '/',
      );
    });

    it('admits, above the fold, that this is a mock with no chain behind it', () => {
      expect(screen.getByText('What this screen is')).toBeInTheDocument();
      const admission = screen.getByText(/A mock\./).textContent ?? '';
      expect(admission).toMatch(/No signature is verified/);
      expect(admission).toMatch(/nothing reaches a chain/);
      expect(admission).toMatch(/Solana devnet/);
      expect(admission).toMatch(/has not been audited/);
      expect(admission).toMatch(/no mainnet deployment/);
    });

    it('never claims anonymity, untraceability, an audit or a mainnet deployment', () => {
      const text = pageText();
      expect(text).not.toMatch(/untraceable|zero traces|unlinkable|anonym/i);
      expect(text).not.toMatch(/sender is hidden|hides the sender/i);
      expect(text).not.toMatch(/\baudited by\b|independently audited|fully audited/i);
      expect(text).not.toMatch(/live on mainnet|mainnet launch/i);
    });
  });

  describe('Section 01, the request', () => {
    it('numbers and titles the section', () => {
      expect(screen.getByText('Session')).toBeInTheDocument();
      expect(screen.getByText('Configure the request.')).toBeInTheDocument();
    });

    it('offers a labelled service name that defaults to a brandless demo', () => {
      expect(screen.getByText('Service configuration')).toBeInTheDocument();
      const input = screen.getByLabelText('Service name');
      expect(input).toHaveValue('Demo Service');
    });

    it('carries the typed service name into the payload', async () => {
      const user = userEvent.setup();
      const input = screen.getByLabelText('Service name');
      await user.clear(input);
      await user.type(input, 'Acme Reader');
      expect(input).toHaveValue('Acme Reader');

      generate();
      expect(decodePayload(deepLink()).name).toBe('Acme Reader');
    });

    it('describes the subscription toggle as a payload field, not an on-chain check', () => {
      expect(screen.getByText('Verify subscription')).toBeInTheDocument();
      expect(
        screen.getByText(/A real integration would require an active SPL token/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/only adds a placeholder mint to the payload/),
      ).toBeInTheDocument();
    });

    it('exposes the toggle as a pressable switch to assistive tech', () => {
      const toggle = screen.getByRole('button', {
        name: 'Enable subscription requirement',
      });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(toggle);
      const pressed = screen.getByRole('button', {
        name: 'Disable subscription requirement',
      });
      expect(pressed).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('The deep link payload', () => {
    it('uses the frozen scheme and protocol id the mobile scanner matches on', () => {
      generate();
      const link = deepLink();
      expect(link.startsWith('p01://auth?payload=')).toBe(true);

      const payload = decodePayload(link);
      expect(payload.protocol).toBe('p01-auth');
      expect(payload.v).toBe(1);
    });

    it('points the callback at the demo route in this repository', () => {
      generate();
      expect(String(decodePayload(deepLink()).callback)).toMatch(
        /\/api\/demo\/auth\/callback$/,
      );
    });

    it('stamps a five-minute expiry and a fresh session id', () => {
      generate();
      const first = decodePayload(deepLink());
      expect(Number(first.exp)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
      expect(Number(first.exp)).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
      expect(String(first.session)).toMatch(/^[0-9a-f]{32}$/);
      expect(String(first.challenge)).toMatch(/^[0-9a-f]{64}$/);

      generate();
      const second = decodePayload(deepLink());
      expect(second.session).not.toBe(first.session);
      expect(second.challenge).not.toBe(first.challenge);
    });

    it('omits the mint until the toggle asks for one', () => {
      generate();
      expect(decodePayload(deepLink()).mint).toBeUndefined();
    });

    it('adds a placeholder mint, and names no third-party brand anywhere', () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Enable subscription requirement' }),
      );
      generate();

      const payload = decodePayload(deepLink());
      expect(payload.mint).toBe(PLACEHOLDER_MINT);
      expect(payload.service).toBe('styx-demo');
      expect(JSON.stringify(payload)).not.toMatch(/netflix|nflx/i);
      expect(pageText()).not.toMatch(/netflix|nflx/i);
    });

    it('keeps the session in this tab only, under its own storage key', () => {
      generate();
      const sessionId = String(decodePayload(deepLink()).session);
      const stored = sessionStorage.getItem(`auth_session_${sessionId}`);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored as string).status).toBe('pending');
    });
  });

  describe('The QR panel', () => {
    it('shows a prompt and no code before anything is generated', () => {
      expect(screen.getByText('Generate a code to begin.')).toBeInTheDocument();
      expect(screen.getByText('Scan to connect')).toBeInTheDocument();
      expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
    });

    it('draws the code and marks the session pending', () => {
      generate();
      expect(screen.getByTestId('qr-code')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('says out loud that no server is being polled', () => {
      generate();
      expect(
        screen.getByText(/Nothing is being polled on a server/),
      ).toBeInTheDocument();
    });

    it('gives up on the session once its five-minute window passes', async () => {
      vi.useFakeTimers();
      generate();

      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000 + 2000);
      });

      expect(screen.getByText('Session expired')).toBeInTheDocument();
      expect(
        screen.getByText('This session passed its five-minute window.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Generate a new code')).toBeInTheDocument();
      expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
      expect(eventLogText()).toContain('Session expired');
    });
  });

  describe('Section 02, the evidence', () => {
    it('titles the section as what the page actually did', () => {
      expect(screen.getByText('Evidence')).toBeInTheDocument();
      expect(screen.getByText('What the page actually did.')).toBeInTheDocument();
    });

    it('hides the deep link panel and the simulator until a session exists', () => {
      expect(screen.queryByText('Deep link')).not.toBeInTheDocument();
      expect(screen.queryByText('Local simulation')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Fake a completed session'),
      ).not.toBeInTheDocument();
    });

    it('prints the generated deep link verbatim', () => {
      generate();
      // Scoped to the panel: the hero lede also names the p01://auth scheme.
      const panel = screen
        .getByText('Deep link')
        .closest('.styx-code-panel') as HTMLElement;
      expect(panel).not.toBeNull();
      expect(within(panel).getByText('p01://auth')).toBeInTheDocument();
      expect(within(panel).getByText(deepLink())).toBeInTheDocument();
    });

    it('copies the link to the clipboard and records that in the log', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      generate();
      const link = deepLink();
      fireEvent.click(screen.getByText('Copy'));

      expect(writeText).toHaveBeenCalledWith(link);
      expect(eventLogText()).toContain('Deep link copied');
    });

    it('says the simulator does not reach the callback route', () => {
      generate();
      expect(screen.getByText('Local simulation')).toBeInTheDocument();
      expect(screen.getByText('/api/demo/auth/callback')).toBeInTheDocument();
      expect(
        screen.getByText(/No signature is produced and none is checked/),
      ).toBeInTheDocument();
    });
  });

  describe('The simulated completion', () => {
    it('switches the panel to an authenticated state that says it is simulated', () => {
      generate();
      completeLocally();

      expect(screen.getByText('Authenticated (simulated)')).toBeInTheDocument();
      expect(screen.getByText('Authenticated')).toBeInTheDocument();
      expect(
        screen.getByText(
          `${DEMO_WALLET.slice(0, 8)}...${DEMO_WALLET.slice(-8)}`,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Simulated in this tab. Nothing was signed.'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
    });

    it('logs a local write, never a received callback or a verified success', () => {
      generate();
      completeLocally();

      const log = eventLogText();
      expect(log).toContain('Completed session written locally');
      expect(log).toContain('Nothing was signed and nothing was verified');
      expect(log).not.toMatch(/AUTH SUCCESS/i);
      expect(log).not.toMatch(/callback received/i);
    });

    it('stops offering the simulator once the session is complete', () => {
      generate();
      completeLocally();
      expect(
        screen.queryByText('Fake a completed session'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Deep link')).not.toBeInTheDocument();
    });
  });

  describe('The event log', () => {
    it('waits for a session before printing anything', () => {
      expect(screen.getByText('Waiting for a session.')).toBeInTheDocument();
    });

    it('records the session, the challenge and the expiry', () => {
      generate();
      const log = eventLogText();
      expect(log).toContain('Session created:');
      expect(log).toContain('Challenge:');
      expect(log).toContain('Expires in 5 minutes');
      expect(screen.queryByText('Waiting for a session.')).not.toBeInTheDocument();
    });
  });

  describe('Section 03, how it works', () => {
    it('says up front that the four moves happen elsewhere', () => {
      expect(screen.getByText('How it works')).toBeInTheDocument();
      expect(
        screen.getByText('Four moves, all of them elsewhere.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/none of it can be\s+observed from a browser tab/),
      ).toBeInTheDocument();
    });

    it('lists the four moves in order', () => {
      const section = sectionOf('Four moves, all of them elsewhere.');
      const titles = within(section)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent);
      expect(titles).toEqual(['Read', 'Check the entitlement', 'Confirm', 'Hand back']);
    });

    it('keeps the signature claim classical', () => {
      expect(
        screen.getByText(/Signatures on Solana are Ed25519 and stay classical/),
      ).toBeInTheDocument();
    });

    it('states the callback allow-list runs only after the challenge is signed', () => {
      const handBack = screen.getByText(/allow-list only here/).textContent ?? '';
      expect(handBack).toMatch(/after the challenge has already been signed/);
      expect(handBack).toMatch(/never the signature/);
      expect(handBack).toMatch(/in-memory map/);
    });
  });

  describe('Section 04, the SDK', () => {
    it('titles the section from the merchant side', () => {
      expect(screen.getByText('SDK', { selector: 'p.styx-index' })).toBeInTheDocument();
      expect(
        screen.getByText("The same flow from a merchant's side."),
      ).toBeInTheDocument();
    });

    it('shows the client, its two calls and the licence, and nothing about npm', () => {
      // Exact, because the import line inside the sample names the package too.
      const head = screen.getByText('@protocol-01/auth-sdk · MIT');
      expect(head.textContent).toMatch(/MIT/);

      const panel = head.closest('.styx-code-panel') as HTMLElement;
      expect(within(panel).getAllByText('P01AuthClient')).toHaveLength(2);
      expect(within(panel).getByText('createSession')).toBeInTheDocument();
      expect(within(panel).getByText('waitForCompletion')).toBeInTheDocument();
    });

    it('points at the file in this repository that backs the sample', () => {
      expect(
        screen.getByText('packages/auth-sdk/src/client.ts'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/is not something this page claims/),
      ).toBeInTheDocument();
    });
  });
});

/**
 * Where the waitlist admin page keeps the operator's key.
 *
 * Run: cd apps/web && pnpm test -- --run __tests__/pages/WaitlistAdminKeyStorage.test.tsx
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * The key unlocks `/api/waitlist/export`: every subscriber's email, country,
 * locale, interest and dates. It was written to `localStorage` in clear, on the
 * SAME ORIGIN as the pay app, where it outlives the tab, the session and the
 * reboot — so a device or storage dump of the operator's browser, or any script
 * that can read the origin's storage, reads a live credential rather than a
 * page the operator once opened.
 *
 * `sessionStorage` is still same-origin, so this is a lifetime fix, not an
 * isolation one: the key dies with the tab, and a dump taken later finds
 * nothing. The page stays usable — a reload inside the tab still reconnects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WaitlistAdminPage from '@/app/admin/waitlist/page';

const SECRET = 'correct-horse-battery-staple';
const LEGACY_KEY = 'p01-wl-admin-key';

const STATS = {
  generatedAt: '2026-09-20T00:00:00.000Z',
  config: { kv: true, resend: true, emailFrom: 'hi@example.com', siteUrl: 'https://example.com' },
  totals: { signups: 3, confirmed: 2, pending: 1, unsubscribed: 0, mailFailures: 0 },
  rates: { confirmationRate: 0.66 },
  last7d: { signups: 1, confirmed: 1 },
  daily: [{ date: '2026-09-19', signups: 1, confirmed: 1 }],
  breakdown: { interest: {}, locale: {}, source: {}, country: {} },
};

function answerOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/export') ? { records: [] } : STATS;
      return {
        ok: true,
        status: 200,
        json: async () => body,
        blob: async () => new Blob(['']),
      } as unknown as Response;
    }),
  );
}

/** Every value in a storage area, as one string. */
function dump(area: Storage): string {
  const out: string[] = [];
  for (let i = 0; i < area.length; i += 1) {
    const k = area.key(i);
    if (k === null) continue;
    out.push(`${k}=${area.getItem(k) ?? ''}`);
  }
  return out.join('\n');
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  answerOk();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the waitlist admin key', () => {
  it('is never written to localStorage when the operator connects', async () => {
    render(<WaitlistAdminPage />);

    fireEvent.change(screen.getByLabelText(/stats token or admin password/i), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    // Anti-vacuity: the connection really happened, so this is not a test of a
    // page that never got past the gate.
    await waitFor(() => expect(screen.getByText(/generated/i)).toBeTruthy());

    expect(dump(localStorage), 'the key was persisted in localStorage').not.toContain(SECRET);
    expect(
      dump(sessionStorage),
      'the key was not kept for the tab, so a reload logs the operator out',
    ).toContain(SECRET);
  });

  it('drops a key an older build left in localStorage, without using it', async () => {
    localStorage.setItem(LEGACY_KEY, SECRET);

    render(<WaitlistAdminPage />);

    await waitFor(() =>
      expect(
        localStorage.getItem(LEGACY_KEY),
        'the old clear-text key is still on disk',
      ).toBeNull(),
    );
    // It is not silently reused either: a credential that may already have been
    // dumped is not what the page reconnects with.
    expect(screen.getByLabelText(/stats token or admin password/i)).toBeTruthy();
    expect(dump(sessionStorage), 'the legacy key was moved, not dropped').not.toContain(SECRET);
  });

  it('forgets the key on disconnect', async () => {
    render(<WaitlistAdminPage />);
    fireEvent.change(screen.getByLabelText(/stats token or admin password/i), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/generated/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /exit/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/stats token or admin password/i)).toBeTruthy(),
    );
    expect(dump(sessionStorage), 'the key survived the log out').not.toContain(SECRET);
    expect(dump(localStorage), 'the key survived the log out').not.toContain(SECRET);
  });
});

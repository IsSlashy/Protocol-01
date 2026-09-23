import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WaitlistJoin from '@/app/waitlist/WaitlistJoin';

/**
 * The client contract of the live /waitlist form (app/waitlist/WaitlistJoin.tsx).
 *
 * Ported on 2026-09-23 from __tests__/components/WaitlistForm.test.tsx, which
 * was deleted together with components/WaitlistForm.tsx. WaitlistJoin was
 * cloned from that component line for line (same POST, same body shape, same
 * client pre-check, same error mapping, same honeypot), so the same contract
 * is asserted here against the form visitors actually use. Copy resolves
 * through i18n/en.ts via the @/i18n mock in __tests__/setup.tsx.
 */

function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function submitWithEmail(email: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), {
    target: { value: email },
  });
  const form = screen.getByRole('button', { name: 'Join the waitlist' }).closest('form');
  fireEvent.submit(form!);
}

describe('WaitlistJoin, the /waitlist form', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Honeypot', () => {
    it('renders a hidden honeypot input named "website" that is off-screen and hidden from a11y', () => {
      render(<WaitlistJoin />);
      const honeypot = document.querySelector('input[name="website"]') as HTMLInputElement | null;
      expect(honeypot).toBeTruthy();
      expect(honeypot).toHaveAttribute('aria-hidden', 'true');
      expect(honeypot).toHaveAttribute('tabindex', '-1');
      expect(honeypot?.style.position).toBe('absolute');
    });
  });

  describe('Success path', () => {
    it('POSTs to /api/waitlist with email, empty website, source and locale; then shows the success panel', async () => {
      const fetchFn = mockFetch({ ok: true, status: 200, body: { ok: true } });
      render(<WaitlistJoin />);

      submitWithEmail('user@example.com');

      // Success panel replaces the form.
      expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Join the waitlist' })).not.toBeInTheDocument();

      expect(fetchFn).toHaveBeenCalledWith('/api/waitlist', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.email).toBe('user@example.com');
      expect(body.website).toBe('');
      expect(body.source).toBe('waitlist-page');
      expect(body.locale).toBe('en');
      // No interest selected -> key omitted.
      expect(body).not.toHaveProperty('interest');
    });

    it('sends the source it is given', async () => {
      const fetchFn = mockFetch({ ok: true, status: 200, body: { ok: true } });
      render(<WaitlistJoin source="founder-page" />);

      submitWithEmail('user@example.com');

      expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).source).toBe('founder-page');
    });
  });

  describe('Error paths', () => {
    it('shows the invalid-email message when the server returns 400 invalid_email', async () => {
      mockFetch({ ok: false, status: 400, body: { ok: false, error: 'invalid_email' } });
      render(<WaitlistJoin />);

      submitWithEmail('user@example.com');

      expect(await screen.findByText('That email does not look right.')).toBeInTheDocument();
    });

    it('shows the rate-limit message when the server returns 429 rate_limited', async () => {
      mockFetch({ ok: false, status: 429, body: { ok: false, error: 'rate_limited' } });
      render(<WaitlistJoin />);

      submitWithEmail('user@example.com');

      expect(
        await screen.findByText('Too many tries from this connection. Come back in a bit.'),
      ).toBeInTheDocument();
    });

    it('rejects a malformed email client-side without calling fetch', () => {
      const fetchFn = mockFetch({ ok: true, status: 200, body: { ok: true } });
      render(<WaitlistJoin />);

      submitWithEmail('not-an-email');

      expect(screen.getByText('That email does not look right.')).toBeInTheDocument();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import WaitlistForm from '@/components/WaitlistForm';

function renderForm(source: 'hero' | 'cta' | 'extension-page' = 'cta') {
  return render(
    <I18nProvider>
      <WaitlistForm source={source} />
    </I18nProvider>,
  );
}

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

describe('WaitlistForm', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Honeypot', () => {
    it('renders a hidden honeypot input named "website" that is off-screen and hidden from a11y', () => {
      renderForm();
      const honeypot = document.querySelector('input[name="website"]') as HTMLInputElement | null;
      expect(honeypot).toBeTruthy();
      expect(honeypot).toHaveAttribute('aria-hidden', 'true');
      expect(honeypot).toHaveAttribute('tabindex', '-1');
      expect(honeypot?.style.position).toBe('absolute');
    });
  });

  describe('Success path', () => {
    it('POSTs to /api/waitlist with email, empty website, and source; then shows the success panel', async () => {
      const fetchFn = mockFetch({ ok: true, status: 200, body: { ok: true } });
      renderForm('cta');

      submitWithEmail('user@example.com');

      // Success panel replaces the form.
      expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Join the waitlist' })).not.toBeInTheDocument();

      expect(fetchFn).toHaveBeenCalledWith('/api/waitlist', expect.objectContaining({ method: 'POST' }));
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.email).toBe('user@example.com');
      expect(body.website).toBe('');
      expect(body.source).toBe('cta');
      expect(body.locale).toBe('en');
      // No interest selected -> key omitted.
      expect(body).not.toHaveProperty('interest');
    });
  });

  describe('Error paths', () => {
    it('shows the invalid-email message when the server returns 400 invalid_email', async () => {
      mockFetch({ ok: false, status: 400, body: { ok: false, error: 'invalid_email' } });
      renderForm();

      submitWithEmail('user@example.com');

      expect(await screen.findByText('That email does not look right.')).toBeInTheDocument();
    });

    it('shows the rate-limit message when the server returns 429 rate_limited', async () => {
      mockFetch({ ok: false, status: 429, body: { ok: false, error: 'rate_limited' } });
      renderForm();

      submitWithEmail('user@example.com');

      expect(
        await screen.findByText('Too many tries from this connection. Come back in a bit.'),
      ).toBeInTheDocument();
    });

    it('rejects a malformed email client-side without calling fetch', () => {
      const fetchFn = mockFetch({ ok: true, status: 200, body: { ok: true } });
      renderForm();

      submitWithEmail('not-an-email');

      expect(screen.getByText('That email does not look right.')).toBeInTheDocument();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});

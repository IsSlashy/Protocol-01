import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import CTA from '@/components/CTA';

// Renders inside the i18n provider so t() resolves real (English) copy instead
// of raw keys. Default locale is 'en'.
function renderCTA() {
  return render(
    <I18nProvider>
      <CTA />
    </I18nProvider>,
  );
}

describe('CTA -- Waitlist conversion funnel', () => {
  beforeEach(() => {
    renderCTA();
  });

  describe('Early-access badge and messaging', () => {
    it('shows the early-access badge', () => {
      expect(screen.getByText('Early access')).toBeInTheDocument();
    });

    it('renders the "Ready to become invisible?" heading', () => {
      expect(screen.getByText(/Ready to become/)).toBeInTheDocument();
      expect(screen.getByText('invisible')).toBeInTheDocument();
    });

    it('uses the waitlist subtitles about opening in waves', () => {
      expect(screen.getByText(/Protocol 01 opens in waves/)).toBeInTheDocument();
    });
  });

  describe('Waitlist form', () => {
    it('renders the email input', () => {
      expect(screen.getByRole('textbox', { name: 'Email address' })).toBeInTheDocument();
    });

    it('renders the "Join the waitlist" submit button', () => {
      expect(screen.getByRole('button', { name: 'Join the waitlist' })).toBeInTheDocument();
    });

    it('renders the interest select', () => {
      expect(screen.getByRole('combobox', { name: 'What do you want first?' })).toBeInTheDocument();
    });
  });

  describe('Download CTAs are disabled (waitlist mode)', () => {
    it('does not render the Android APK card', () => {
      expect(screen.queryByText('Android')).not.toBeInTheDocument();
      expect(screen.queryByText(/Instant Download APK/)).not.toBeInTheDocument();
    });

    it('does not render a direct APK download link', () => {
      const apkLink = document.querySelector('a[download]');
      expect(apkLink).toBeNull();
    });
  });

  describe('Secondary actions still present', () => {
    // WAITLIST MODE: the GitHub CTA is hidden while access runs through the waitlist
    it('does not render the GitHub repository link', () => {
      expect(screen.queryByText('View on GitHub')).toBeNull();
    });

    it('renders a link to the Discord community', () => {
      const discordLink = screen.getByText('Join Discord');
      expect(discordLink.closest('a')).toHaveAttribute('href', 'https://discord.gg/fShgQ5j6pE');
    });
  });
});

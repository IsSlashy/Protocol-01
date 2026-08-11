import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import Hero from '@/components/Hero';

/**
 * Assertions here are pinned to the copy Hero.tsx actually renders today,
 * resolved through i18n/en.ts by the @/i18n mock in __tests__/setup.tsx.
 * Keep them exact: the job of a copy assertion is to fail when copy changes.
 */

// The stat row renders <div.text-left><div>{value}</div><div>{label}</div></div>,
// so the label's parent is the stat cell. Scoping the value lookup to that cell
// asserts the value/label PAIRING, not just that both strings exist somewhere.
const statCell = (label: string) => {
  const cell = screen.getByText(label).parentElement;
  if (!cell) throw new Error(`Stat label "${label}" has no parent cell`);
  return cell;
};

describe('Hero -- Privacy-first landing section', () => {
  beforeEach(() => {
    render(<Hero />);
  });

  describe('Branding and Identity', () => {
    it('displays the "Protocol Active" badge to indicate live system status', () => {
      expect(screen.getByText('Protocol Active')).toBeInTheDocument();
    });

    it('presents the "AMOUNTS THEY CANNOT READ." headline as the core value proposition', () => {
      // Rendered three times on purpose: cyan ghost, pink ghost, and the main
      // white layer that together produce the chromatic-aberration glitch.
      const headlines = screen.getAllByText('AMOUNTS THEY CANNOT READ.');
      expect(headlines).toHaveLength(3);
    });

    it('shows the kicker line that sets up the headline', () => {
      expect(
        screen.getByText('WHO YOU PAY. WHAT YOU BUY. HOW MUCH.')
      ).toBeInTheDocument();
    });

    it('displays "READY" status indicator confirming the protocol is operational', () => {
      expect(screen.getByText('READY')).toBeInTheDocument();
    });
  });

  describe('Description copy', () => {
    it('states what the protocol lets you do on Solana', () => {
      expect(
        screen.getByText('Pay merchants, subscribe, send and swap on Solana.')
      ).toBeInTheDocument();
    });

    it('scopes the privacy claim to the three things kept hidden', () => {
      expect(
        screen.getByText(
          'Without revealing who you are, what you bought, or how much.'
        )
      ).toBeInTheDocument();
    });

    it('names the primitives and qualifies the deployment stage as devnet', () => {
      expect(
        screen.getByText(
          'Post-quantum proofs, stealth addresses, shielded pools. Live on devnet.'
        )
      ).toBeInTheDocument();
    });

    it('closes on the three verifiable properties: self-custody, open source, no KYC', () => {
      expect(
        screen.getByText('Self-custody. Open source. No KYC.')
      ).toBeInTheDocument();
    });
  });

  describe('Call-to-Action Buttons', () => {
    it('renders the "Launch App" button as the primary CTA', () => {
      expect(screen.getByText('Launch App')).toBeInTheDocument();
    });

    it('links "Launch App" to the live app at /app', () => {
      const cta = screen.getByText('Launch App');
      expect(cta.closest('a')).toHaveAttribute('href', '/app');
    });

    it('renders "Join the waitlist" as the secondary CTA, scrolling to #download', () => {
      const cta = screen.getByRole('button', { name: 'Join the waitlist' });
      expect(cta).toBeInTheDocument();

      const downloadSection = document.createElement('div');
      downloadSection.id = 'download';
      const scrollIntoView = vi.fn();
      downloadSection.scrollIntoView = scrollIntoView;
      document.body.appendChild(downloadSection);

      try {
        fireEvent.click(cta);
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });
      } finally {
        downloadSection.remove();
      }
    });
  });

  describe('Statistics Dashboard', () => {
    it('pairs the infinity symbol with "Private subscriptions"', () => {
      expect(
        within(statCell('Private subscriptions')).getByText('∞')
      ).toBeInTheDocument();
    });

    it('pairs "100%" with "Self-custody"', () => {
      expect(
        within(statCell('Self-custody')).getByText('100%')
      ).toBeInTheDocument();
    });

    it('pairs "0" with "Traces left on-chain"', () => {
      expect(
        within(statCell('Traces left on-chain')).getByText('0')
      ).toBeInTheDocument();
    });
  });

  describe('Visual Effects and Background', () => {
    it('renders the Miku background image with privacy-respecting empty alt text', () => {
      // Image has alt="" (decorative), so it does not appear in getByRole('img')
      // Use container query instead
      const { container } = render(<Hero />);
      const mikuImg = container.querySelector('img[src="/Miku.png"]');
      expect(mikuImg).toBeTruthy();
      expect(mikuImg?.getAttribute('alt')).toBe('');
    });

    it('renders the scroll indicator at the bottom for navigation guidance', () => {
      expect(screen.getByText('Scroll')).toBeInTheDocument();
    });

    it('renders binary data streams for cyberpunk atmosphere', () => {
      expect(screen.getByText(/00110101 01010011/)).toBeInTheDocument();
    });

    it('renders terminal protocol status overlay', () => {
      expect(screen.getByText(/PROTOCOL::01/)).toBeInTheDocument();
      expect(screen.getByText(/STATUS::ACTIVE/)).toBeInTheDocument();
      expect(screen.getByText(/TRACE::NULL/)).toBeInTheDocument();
    });
  });
});

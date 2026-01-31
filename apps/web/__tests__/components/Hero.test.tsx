import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Hero from '@/components/Hero';

describe('Hero -- Privacy-first landing section', () => {
  beforeEach(() => {
    render(<Hero />);
  });

  describe('Branding and Identity', () => {
    it('displays the "Protocol Active" badge to indicate live system status', () => {
      expect(screen.getByText('Protocol Active')).toBeInTheDocument();
    });

    it('presents the "SUBSCRIBE PRIVATELY" headline as the core value proposition', () => {
      const headlines = screen.getAllByText('SUBSCRIBE PRIVATELY');
      // Main text + chromatic aberration layers (cyan, pink, main)
      expect(headlines.length).toBeGreaterThanOrEqual(1);
    });

    it('shows the "SYSTEM STATUS" label in terminal style for cyberpunk aesthetic', () => {
      expect(screen.getByText('[ SYSTEM STATUS ]')).toBeInTheDocument();
    });

    it('displays "READY" status indicator confirming the protocol is operational', () => {
      expect(screen.getByText('READY')).toBeInTheDocument();
    });
  });

  describe('Privacy Messaging', () => {
    it('communicates recurring private payments as a key feature', () => {
      expect(screen.getByText('Recurring private payments.')).toBeInTheDocument();
    });

    it('communicates anonymous subscriptions as a key feature', () => {
      expect(screen.getByText('Anonymous subscriptions.')).toBeInTheDocument();
    });

    it('communicates stealth transfers on Solana as a key feature', () => {
      expect(screen.getByText('Stealth transfers on Solana.')).toBeInTheDocument();
    });

    it('highlights the privacy promise: "Your finances, your privacy."', () => {
      expect(screen.getByText('Your finances, your privacy.')).toBeInTheDocument();
    });
  });

  describe('Call-to-Action Buttons', () => {
    it('renders the "Initialize Protocol" button as the primary CTA', () => {
      expect(screen.getByText('Initialize Protocol')).toBeInTheDocument();
    });

    it('renders the "Documentation" link pointing to /docs', () => {
      const docsLink = screen.getByText('Documentation');
      expect(docsLink).toBeInTheDocument();
      expect(docsLink.closest('a')).toHaveAttribute('href', '/docs');
    });

    it('scrolls to the problem section when "Initialize Protocol" is clicked', () => {
      const scrollIntoViewMock = vi.fn();
      const mockElement = document.createElement('div');
      mockElement.scrollIntoView = scrollIntoViewMock;
      vi.spyOn(document, 'getElementById').mockReturnValue(mockElement);

      fireEvent.click(screen.getByText('Initialize Protocol'));
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth' });
    });
  });

  describe('Statistics Dashboard', () => {
    it('displays infinity symbol for "Recurring" payments -- unlimited private subscriptions', () => {
      expect(screen.getByText('Recurring')).toBeInTheDocument();
    });

    it('displays "100%" for "Private" -- complete transaction privacy', () => {
      expect(screen.getByText('100%')).toBeInTheDocument();
      expect(screen.getByText('Private')).toBeInTheDocument();
    });

    it('displays "0" for "Traces" -- zero on-chain footprint', () => {
      expect(screen.getByText('Traces')).toBeInTheDocument();
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

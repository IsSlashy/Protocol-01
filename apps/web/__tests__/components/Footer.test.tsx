import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Footer from '@/components/Footer';

describe('Footer -- Site navigation and community links', () => {
  beforeEach(() => {
    render(<Footer />);
  });

  describe('Brand Identity', () => {
    it('displays the P01 logo badge', () => {
      expect(screen.getByText('P01')).toBeInTheDocument();
    });

    it('displays the "PROTOCOL 01" brand name', () => {
      expect(screen.getByText('PROTOCOL 01')).toBeInTheDocument();
    });

    it('presents the privacy manifesto tagline', () => {
      expect(screen.getByText(/Anonymous Solana wallet with stealth addresses/)).toBeInTheDocument();
    });

    it('displays the iconic terminal-style message', () => {
      expect(screen.getByText(/The system cannot see you/)).toBeInTheDocument();
    });
  });

  describe('Product Links Section', () => {
    it('has a "Product" section header', () => {
      expect(screen.getByText('Product')).toBeInTheDocument();
    });

    it('links to Mobile App download', () => {
      const link = screen.getByRole('link', { name: 'Mobile App' });
      expect(link).toHaveAttribute('href', '#download');
    });

    it('links to Chrome Extension download', () => {
      const link = screen.getByRole('link', { name: 'Chrome Extension' });
      expect(link).toHaveAttribute('href', '#download');
    });

    it('links to Features section', () => {
      const link = screen.getByRole('link', { name: 'Features' });
      expect(link).toHaveAttribute('href', '#features');
    });

    it('links to the SDK Demo page', () => {
      const links = screen.getAllByRole('link', { name: 'SDK Demo' });
      expect(links.some(l => l.getAttribute('href') === '/sdk-demo')).toBe(true);
    });

    it('links to the Roadmap page', () => {
      const link = screen.getByRole('link', { name: 'Roadmap' });
      expect(link).toHaveAttribute('href', '/roadmap');
    });
  });

  describe('Developers Links Section', () => {
    it('has a "Developers" section header', () => {
      expect(screen.getByText('Developers')).toBeInTheDocument();
    });

    it('links to Documentation page', () => {
      const link = screen.getByRole('link', { name: 'Documentation' });
      expect(link).toHaveAttribute('href', '/docs');
    });
  });

  describe('Community Links Section', () => {
    it('has a "Community" section header', () => {
      expect(screen.getByText('Community')).toBeInTheDocument();
    });

    it('links to Discord community (external)', () => {
      const links = screen.getAllByRole('link', { name: /Discord/ });
      const externalDiscord = links.find(
        l => l.getAttribute('href') === 'https://discord.gg/KfmhPFAHNH'
      );
      expect(externalDiscord).toBeDefined();
      expect(externalDiscord).toHaveAttribute('target', '_blank');
      expect(externalDiscord).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('links to Twitter/X (external)', () => {
      const links = screen.getAllByRole('link', { name: /Twitter/ });
      const twitterLink = links.find(
        l => l.getAttribute('href') === 'https://x.com/Protocol01_'
      );
      expect(twitterLink).toBeDefined();
      expect(twitterLink).toHaveAttribute('target', '_blank');
    });
  });

  describe('Social Media Icons', () => {
    it('renders the Twitter/X social icon with aria-label', () => {
      expect(screen.getByLabelText('Twitter/X')).toBeInTheDocument();
    });

    it('renders the GitHub social icon with aria-label', () => {
      expect(screen.getByLabelText('GitHub')).toBeInTheDocument();
    });

    it('renders the Discord social icon with aria-label', () => {
      expect(screen.getByLabelText('Discord')).toBeInTheDocument();
    });
  });

  describe('Bottom Bar', () => {
    it('displays the copyright notice with current year', () => {
      const currentYear = new Date().getFullYear().toString();
      expect(screen.getByText(new RegExp(`${currentYear} PROTOCOL 01`))).toBeInTheDocument();
    });

    it('has a bottom bar link to Twitter/X', () => {
      const bottomLinks = screen.getAllByText('Twitter / X');
      expect(bottomLinks.length).toBeGreaterThanOrEqual(1);
    });

    it('has a bottom bar link to GitHub', () => {
      const allGithub = screen.getAllByText('GitHub');
      expect(allGithub.length).toBeGreaterThanOrEqual(1);
    });

    it('has a bottom bar link to Discord', () => {
      const allDiscord = screen.getAllByText('Discord');
      expect(allDiscord.length).toBeGreaterThanOrEqual(1);
    });
  });
});

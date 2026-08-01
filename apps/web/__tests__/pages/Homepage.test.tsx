import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';

describe('Homepage -- Protocol 01 main landing page', () => {
  beforeEach(() => {
    render(<Home />);
  });

  describe('Navigation Bar', () => {
    it('renders the fixed site header at the top, wrapping the nav', () => {
      // Commit 97339ea6 unified the three per-page headers into SiteHeader.
      // `fixed top-0` now lives on the wrapping <header>; the <nav> is just
      // the link row inside it.
      const nav = screen.getByRole('navigation');
      expect(nav).toBeInTheDocument();
      const header = nav.closest('header');
      expect(header).not.toBeNull();
      expect(header!.className).toContain('fixed');
      expect(header!.className).toContain('top-0');
    });

    it('displays the app-icon logo linking home in the site header', () => {
      // Commit 6fb9d6b8 ("replace P01 text badge with app icon across all
      // headers") swapped the "P01" text badge for /icon.png. The header logo
      // is now an <img alt="Protocol 01"> inside the home link.
      const header = screen.getByRole('navigation').closest('header')!;
      const logo = within(header).getByAltText('Protocol 01');
      expect(logo).toHaveAttribute('src', '/icon.png');
      expect(logo.closest('a')).toHaveAttribute('href', '/');
    });

    it('displays the "PROTOCOL 01" brand name in the navigation', () => {
      // Multiple PROTOCOL 01 texts (nav + footer), get the first one
      const brandTexts = screen.getAllByText('PROTOCOL 01');
      expect(brandTexts.length).toBeGreaterThanOrEqual(1);
    });

    it('has a "Features" navigation link pointing to #features', () => {
      const navLinks = screen.getAllByText('Features');
      const featureNavLink = navLinks.find(
        el => el.closest('a')?.getAttribute('href') === '#features'
      );
      expect(featureNavLink).toBeDefined();
    });

    it('has a "Waitlist" navigation link pointing to /#download', () => {
      const navLinks = screen.getAllByText('Waitlist');
      const waitlistNavLink = navLinks.find(
        el => el.closest('a')?.getAttribute('href') === '/#download'
      );
      expect(waitlistNavLink).toBeDefined();
    });

    it('has an "SDK Demo" navigation link pointing to /sdk-demo', () => {
      const sdkLinks = screen.getAllByText('SDK Demo');
      const sdkNavLink = sdkLinks.find(
        el => el.closest('a')?.getAttribute('href') === '/sdk-demo'
      );
      expect(sdkNavLink).toBeDefined();
    });

    it('has a "Docs" navigation link pointing to /docs', () => {
      const link = screen.getByRole('link', { name: 'Docs' });
      expect(link).toHaveAttribute('href', '/docs');
    });

    it('has a "Roadmap" navigation link pointing to /roadmap', () => {
      const links = screen.getAllByRole('link', { name: 'Roadmap' });
      const roadmapLink = links.find(l => l.getAttribute('href') === '/roadmap');
      expect(roadmapLink).toBeDefined();
    });
  });

  describe('Social Links in Navigation', () => {
    it('has a Twitter/X link in the navigation', () => {
      const twitterLinks = screen.getAllByLabelText('Twitter/X');
      const navLink = twitterLinks.find(l => l.getAttribute('href') === 'https://x.com/Protocol01_');
      expect(navLink).toBeDefined();
      expect(navLink).toHaveAttribute('target', '_blank');
    });

    it('exposes exactly Twitter/X and Discord as social links -- GitHub stays hidden in waitlist mode', () => {
      // WAITLIST MODE (Footer.tsx): the GitHub entry is commented out behind
      // "GitHub de-emphasized while access runs through the waitlist, restore
      // at launch". There is no GitHub link anywhere on the homepage today.
      // When that comment is un-commented, add 'GitHub' back to this list.
      const twitter = screen
        .getAllByLabelText('Twitter/X')
        .find(l => l.getAttribute('href') === 'https://x.com/Protocol01_')!;
      const socialRow = twitter.parentElement!;
      const labels = Array.from(socialRow.querySelectorAll('a[aria-label]')).map(a =>
        a.getAttribute('aria-label')
      );
      expect(labels).toEqual(['Twitter/X', 'Discord']);
    });

    it('has a Discord link in the navigation', () => {
      const discordLinks = screen.getAllByLabelText('Discord');
      const navLink = discordLinks.find(l => l.getAttribute('href') === 'https://discord.gg/EfqnVmb2dV');
      expect(navLink).toBeDefined();
      expect(navLink).toHaveAttribute('target', '_blank');
    });
  });

  describe('Page Sections', () => {
    it('renders the Hero section', () => {
      expect(screen.getByText('Protocol Active')).toBeInTheDocument();
    });

    it('renders the Problem section with id="problem"', () => {
      const problemSection = document.getElementById('problem');
      expect(problemSection).toBeTruthy();
    });

    it('renders the Features section with id="features"', () => {
      const featuresSection = document.getElementById('features');
      expect(featuresSection).toBeTruthy();
    });

    it('renders the Ecosystem tech marquee in place of the removed id="tech" section', () => {
      // Commit a91974cd ("streamline landing page -- remove tech sections")
      // dropped the TechStack/Showcase sections from the landing page; the
      // technology list moved to /docs and to the Ecosystem marquee. Nothing
      // links to #tech any more, so the anchor is gone on purpose.
      expect(document.getElementById('tech')).toBeNull();
      expect(screen.getByText('Ecosystem & Technologies')).toBeInTheDocument();
      expect(screen.getByText('BEST IN CLASS')).toBeInTheDocument();
      // Marquee rows are duplicated for the seamless loop, hence getAllByText.
      expect(screen.getAllByText('Winterfell').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Quantum-Safe Field').length).toBeGreaterThan(0);
    });

    it('renders the CTA/Download section with id="download"', () => {
      const downloadSection = document.getElementById('download');
      expect(downloadSection).toBeTruthy();
    });

    it('renders the Footer', () => {
      expect(screen.getByText(/The system cannot see you/)).toBeInTheDocument();
    });
  });

  describe('Waitlist Button in Navigation', () => {
    it('has a prominent "Waitlist" CTA button in the nav', () => {
      const waitlistButtons = screen.getAllByRole('link', { name: 'Waitlist' });
      const ctaButton = waitlistButtons.find(
        el => el.getAttribute('href') === '/#download' && el.className.includes('btn-primary')
      );
      expect(ctaButton).toBeDefined();
    });
  });
});

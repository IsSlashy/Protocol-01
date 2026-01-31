import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Home from '@/app/page';

describe('Homepage -- Protocol 01 main landing page', () => {
  beforeEach(() => {
    render(<Home />);
  });

  describe('Navigation Bar', () => {
    it('renders the fixed navigation bar at the top', () => {
      const nav = screen.getByRole('navigation');
      expect(nav).toBeInTheDocument();
      expect(nav.className).toContain('fixed');
      expect(nav.className).toContain('top-0');
    });

    it('displays the P01 logo badge in the navigation', () => {
      // P01 appears in both nav and footer
      const badges = screen.getAllByText('P01');
      expect(badges.length).toBeGreaterThanOrEqual(1);
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

    it('has a "Download" navigation link pointing to #download', () => {
      const navLinks = screen.getAllByText('Download');
      const downloadNavLink = navLinks.find(
        el => el.closest('a')?.getAttribute('href') === '#download'
      );
      expect(downloadNavLink).toBeDefined();
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

    it('has a GitHub link in the navigation', () => {
      const githubLinks = screen.getAllByLabelText('GitHub');
      const navLink = githubLinks.find(l => l.getAttribute('href') === 'https://github.com/IsSlashy/Protocol-01');
      expect(navLink).toBeDefined();
      expect(navLink).toHaveAttribute('target', '_blank');
    });

    it('has a Discord link in the navigation', () => {
      const discordLinks = screen.getAllByLabelText('Discord');
      const navLink = discordLinks.find(l => l.getAttribute('href') === 'https://discord.gg/KfmhPFAHNH');
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

    it('renders the TechStack section with id="tech"', () => {
      const techSection = document.getElementById('tech');
      expect(techSection).toBeTruthy();
    });

    it('renders the CTA/Download section with id="download"', () => {
      const downloadSection = document.getElementById('download');
      expect(downloadSection).toBeTruthy();
    });

    it('renders the Footer', () => {
      expect(screen.getByText(/The system cannot see you/)).toBeInTheDocument();
    });
  });

  describe('Download Button in Navigation', () => {
    it('has a prominent "Download" CTA button in the nav', () => {
      const downloadButtons = screen.getAllByRole('link', { name: 'Download' });
      const ctaButton = downloadButtons.find(
        el => el.getAttribute('href') === '#download' && el.className.includes('btn-primary')
      );
      expect(ctaButton).toBeDefined();
    });
  });
});

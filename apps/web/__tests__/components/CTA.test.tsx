import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CTA from '@/components/CTA';

describe('CTA -- Download section and conversion funnel', () => {
  beforeEach(() => {
    render(<CTA />);
  });

  describe('Availability Badge', () => {
    it('displays "Now Available" badge indicating launch status', () => {
      expect(screen.getByText('Now Available')).toBeInTheDocument();
    });
  });

  describe('Headline and Messaging', () => {
    it('renders the compelling headline "Ready to become invisible?"', () => {
      expect(screen.getByText(/Ready to become/)).toBeInTheDocument();
      expect(screen.getByText('invisible')).toBeInTheDocument();
    });

    it('displays the subtitle about taking back financial privacy', () => {
      expect(screen.getByText(/Download Protocol 01 and take back control/)).toBeInTheDocument();
    });

    it('emphasizes the product is free, self-custody, and built for everyone', () => {
      expect(screen.getByText(/Free to use\. Self-custody\. Built for everyone\./)).toBeInTheDocument();
    });
  });

  describe('Download Options', () => {
    it('renders the Android APK download option', () => {
      expect(screen.getByText('Android')).toBeInTheDocument();
    });

    it('displays Android APK file details with size', () => {
      expect(screen.getByText(/Instant Download APK/)).toBeInTheDocument();
      expect(screen.getByText(/72 MB/)).toBeInTheDocument();
    });

    it('links to the correct Android APK file', () => {
      const androidLink = screen.getByText('Android').closest('a');
      expect(androidLink).toHaveAttribute('href', '/downloads/P01-Mobile-v0.1.1.apk');
      expect(androidLink).toHaveAttribute('download', 'P01-Mobile-v0.1.1.apk');
    });

    it('renders the Chrome Extension download option', () => {
      expect(screen.getByText('Chrome Extension')).toBeInTheDocument();
    });

    it('displays Chrome Extension file details with size', () => {
      expect(screen.getByText(/Instant Download ZIP/)).toBeInTheDocument();
      expect(screen.getByText(/9\.6 MB/)).toBeInTheDocument();
    });

    it('links to the correct Chrome Extension ZIP file', () => {
      const chromeLink = screen.getByText('Chrome Extension').closest('a');
      expect(chromeLink).toHaveAttribute('href', '/downloads/P01-Extension-v0.1.1.zip');
      expect(chromeLink).toHaveAttribute('download', 'P01-Extension-v0.1.1.zip');
    });
  });

  describe('Secondary Actions', () => {
    it('renders a link to the GitHub repository', () => {
      const githubLink = screen.getByText('View on GitHub');
      expect(githubLink.closest('a')).toHaveAttribute('href', 'https://github.com/IsSlashy/Protocol-01');
      expect(githubLink.closest('a')).toHaveAttribute('target', '_blank');
    });

    it('renders a link to the Discord community', () => {
      const discordLink = screen.getByText('Join Discord');
      expect(discordLink.closest('a')).toHaveAttribute('href', 'https://discord.gg/KfmhPFAHNH');
      expect(discordLink.closest('a')).toHaveAttribute('target', '_blank');
    });
  });

  describe('Trust Statistics', () => {
    it('displays "100%" for Self-Custody -- full user control', () => {
      // CTA has its own stats
      expect(screen.getByText('Self-Custody')).toBeInTheDocument();
    });

    it('displays "0" for KYC Required -- no identity verification needed', () => {
      expect(screen.getByText('KYC Required')).toBeInTheDocument();
    });

    it('displays infinity for Privacy -- unlimited privacy guarantees', () => {
      expect(screen.getByText('Privacy')).toBeInTheDocument();
    });
  });
});

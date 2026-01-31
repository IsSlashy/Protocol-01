import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoadmapPage from '@/app/roadmap/page';

describe('RoadmapPage -- Protocol 01 development roadmap', () => {
  beforeEach(() => {
    render(<RoadmapPage />);
  });

  describe('Page Header', () => {
    it('displays the P01 logo badge', () => {
      expect(screen.getByText('P01')).toBeInTheDocument();
    });

    it('displays "ROADMAP" as the page title', () => {
      expect(screen.getByText('ROADMAP')).toBeInTheDocument();
    });

    it('has a "Back" link to the homepage', () => {
      const backLink = screen.getByText('Back');
      expect(backLink.closest('a')).toHaveAttribute('href', '/');
    });

    it('has a "Docs" link in the header', () => {
      const docsLink = screen.getByText('Docs');
      expect(docsLink.closest('a')).toHaveAttribute('href', '/docs');
    });
  });

  describe('Hero Section', () => {
    it('displays the protocol identifier string', () => {
      expect(screen.getByText(/PROTOCOL 01 \/\/ DEVELOPMENT ROADMAP/)).toBeInTheDocument();
    });

    it('shows "Building Private Finance" as the main heading', () => {
      expect(screen.getByText('Building Private Finance')).toBeInTheDocument();
    });

    it('describes the path from stealth addresses to on-chain privacy', () => {
      expect(screen.getByText(/stealth addresses and ZK proofs to fully on-chain/)).toBeInTheDocument();
    });
  });

  describe('Shipped Phase -- Live in production', () => {
    it('shows the "SHIPPED" status badge', () => {
      expect(screen.getByText('SHIPPED')).toBeInTheDocument();
    });

    it('shows the "Current" phase title', () => {
      expect(screen.getByText('Current')).toBeInTheDocument();
    });

    it('shows "Live in production" subtitle', () => {
      expect(screen.getByText('Live in production')).toBeInTheDocument();
    });

    it('lists Stealth Addresses (ECDH) as shipped', () => {
      expect(screen.getByText('Stealth Addresses (ECDH)')).toBeInTheDocument();
    });

    it('lists ZK Shielded Pool as shipped', () => {
      expect(screen.getByText('ZK Shielded Pool')).toBeInTheDocument();
    });

    it('lists Backend Relayer as shipped', () => {
      expect(screen.getByText('Backend Relayer')).toBeInTheDocument();
    });

    it('lists Payment Streams as shipped', () => {
      expect(screen.getByText('Payment Streams')).toBeInTheDocument();
    });

    it('lists Jupiter Swap Integration as shipped', () => {
      expect(screen.getByText('Jupiter Swap Integration')).toBeInTheDocument();
    });

    it('lists Fiat On-Ramp (Buy Crypto) as shipped', () => {
      expect(screen.getByText('Fiat On-Ramp (Buy Crypto)')).toBeInTheDocument();
    });

    it('lists Mobile App + Browser Extension as shipped', () => {
      expect(screen.getByText('Mobile App + Browser Extension')).toBeInTheDocument();
    });
  });

  describe('In Progress Phase -- Actively building', () => {
    it('shows the "IN PROGRESS" status badge', () => {
      expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    });

    it('shows the "Next" phase title', () => {
      expect(screen.getByText('Next')).toBeInTheDocument();
    });

    it('shows "Actively building" subtitle', () => {
      expect(screen.getByText('Actively building')).toBeInTheDocument();
    });

    it('lists On-Chain Smart Contracts as in progress', () => {
      expect(screen.getByText('On-Chain Smart Contracts')).toBeInTheDocument();
    });

    it('describes replacing backend with trustless on-chain programs', () => {
      expect(screen.getByText(/Trustless, permissionless privacy/)).toBeInTheDocument();
    });

    it('lists Advanced Privacy (Decoy Transactions + Noise) as in progress', () => {
      expect(screen.getByText('Advanced Privacy (Decoy Transactions + Noise)')).toBeInTheDocument();
    });
  });

  describe('Future Phase -- On the horizon', () => {
    it('shows the "PLANNED" status badge', () => {
      expect(screen.getByText('PLANNED')).toBeInTheDocument();
    });

    it('shows the "Future" phase title', () => {
      expect(screen.getByText('Future')).toBeInTheDocument();
    });

    it('shows "On the horizon" subtitle', () => {
      expect(screen.getByText('On the horizon')).toBeInTheDocument();
    });

    it('lists AI Agent Integration as a future feature', () => {
      expect(screen.getByText('AI Agent Integration')).toBeInTheDocument();
    });

    it('describes autonomous AI agent for transaction management', () => {
      expect(screen.getByText(/Autonomous AI agent that can execute transactions/)).toBeInTheDocument();
    });

    it('lists Desktop App as a future feature', () => {
      expect(screen.getByText('Desktop App')).toBeInTheDocument();
    });

    it('lists CLI Tool as a future feature', () => {
      expect(screen.getByText('CLI Tool')).toBeInTheDocument();
    });
  });

  describe('CTA Section', () => {
    it('displays "BUILD WITH US" call-to-action', () => {
      expect(screen.getByText(/BUILD WITH US/)).toBeInTheDocument();
    });

    it('displays "Shape the Future of Privacy" heading', () => {
      expect(screen.getByText('Shape the Future of Privacy')).toBeInTheDocument();
    });

    it('mentions the project is open source', () => {
      expect(screen.getByText(/P-01 is open source/)).toBeInTheDocument();
    });

    it('has a GitHub CTA button', () => {
      const links = screen.getAllByRole('link', { name: 'GitHub' });
      const ghLink = links.find(l => l.getAttribute('href') === 'https://github.com/IsSlashy/Protocol-01');
      expect(ghLink).toBeDefined();
    });

    it('has a Discord CTA button', () => {
      const links = screen.getAllByRole('link', { name: 'Discord' });
      const discordLink = links.find(l => l.getAttribute('href') === 'https://discord.gg/KfmhPFAHNH');
      expect(discordLink).toBeDefined();
    });
  });
});

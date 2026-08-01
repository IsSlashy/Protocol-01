import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import RoadmapPage from '@/app/roadmap/page';

/**
 * The roadmap page was rebuilt as a dashboard: the three phases are now TABS
 * (the stat tiles double as the tab bar) and only the ACTIVE phase renders its
 * items. "Next" is the tab selected on mount, so shipped/future copy is only in
 * the DOM after the corresponding tile is clicked.
 *
 * Shipped items are additionally grouped into collapsible categories; only
 * "Privacy Core" is expanded on mount (see `openCats` in app/roadmap/page.tsx).
 */
const showPhase = (tab: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: tab }));
};

const COLLAPSED_SHIPPED_CATEGORIES = [
  /^Pools & Notes/,
  /^Payments/,
  /^Infrastructure/,
  /^Apps & SDK/,
  /^Ecosystem/,
];

const expandAllShippedCategories = () => {
  COLLAPSED_SHIPPED_CATEGORIES.forEach((name) => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

describe('RoadmapPage -- Protocol 01 development roadmap', () => {
  beforeEach(() => {
    render(<RoadmapPage />);
  });

  describe('Page Header', () => {
    // The page-local header (P01 badge + "ROADMAP" + Back) was replaced by the
    // shared <SiteHeader/> in 97339ea6, which shows the icon + wordmark instead.
    it('displays the Protocol 01 logo and wordmark', () => {
      const header = within(screen.getByRole('banner'));
      expect(header.getByAltText('Protocol 01')).toBeInTheDocument();
      expect(header.getByText('PROTOCOL 01')).toBeInTheDocument();
    });

    it('has a "Roadmap" nav link pointing at this page', () => {
      const header = within(screen.getByRole('banner'));
      expect(header.getByText('Roadmap').closest('a')).toHaveAttribute('href', '/roadmap');
    });

    it('links back to the homepage from the logo', () => {
      const header = within(screen.getByRole('banner'));
      expect(header.getByText('PROTOCOL 01').closest('a')).toHaveAttribute('href', '/');
    });

    it('has a "Docs" link in the header', () => {
      const header = within(screen.getByRole('banner'));
      expect(header.getByText('Docs').closest('a')).toHaveAttribute('href', '/docs');
    });

    // SUSPECTED REGRESSION -- deliberately left red.
    // Before 97339ea6 the page rendered `<h1>{t('roadmap.title')}</h1>` ("ROADMAP").
    // Folding the per-page header into the shared SiteHeader dropped the h1
    // entirely: the document now starts at <h2> and `roadmap.title` is a dead key
    // in i18n/en.ts. The visible "ROADMAP" string is gone by design, so this does
    // NOT assert that copy back -- it only asserts the page still has a top-level
    // heading for screen readers and search engines.
    it('exposes exactly one top-level heading (h1)', () => {
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });
  });

  describe('Hero Section', () => {
    it('displays the protocol identifier string', () => {
      expect(screen.getByText('> PROTOCOL 01 // DEVELOPMENT ROADMAP')).toBeInTheDocument();
    });

    it('shows "Building Private Finance" as the main heading', () => {
      expect(screen.getByText('Building Private Finance')).toBeInTheDocument();
    });

    it('describes the path from stealth addresses to on-chain privacy', () => {
      expect(
        screen.getByText(
          'Our path from stealth addresses and ZK proofs to fully on-chain privacy with no backend required.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Shipped Phase -- Live in production', () => {
    beforeEach(() => {
      showPhase(/SHIPPED/);
    });

    it('shows the "SHIPPED" status badge', () => {
      expect(screen.getByText('SHIPPED')).toBeInTheDocument();
    });

    it('shows the "Current" phase title', () => {
      expect(screen.getByText('Current')).toBeInTheDocument();
    });

    it('shows "Live in production" subtitle', () => {
      expect(screen.getByText('Live in production')).toBeInTheDocument();
    });

    it('groups shipped work under the six category headers', () => {
      ['Privacy Core', 'Pools & Notes', 'Payments', 'Infrastructure', 'Apps & SDK', 'Ecosystem'].forEach(
        (category) => {
          expect(screen.getByText(category)).toBeInTheDocument();
        },
      );
    });

    it('lists Stealth Addresses (ECDH) as shipped', () => {
      // Privacy Core is the one category expanded on mount.
      expect(screen.getByText('Stealth Addresses (ECDH)')).toBeInTheDocument();
    });

    it('lists ZK Shielded Pool (STARK) as shipped', () => {
      expect(screen.getByText('ZK Shielded Pool (STARK)')).toBeInTheDocument();
    });

    it('lists On-Chain Relayer + Quantum Vault as shipped', () => {
      expandAllShippedCategories();
      expect(screen.getByText('On-Chain Relayer + Quantum Vault')).toBeInTheDocument();
    });

    it('lists Payment Streams as shipped', () => {
      expandAllShippedCategories();
      expect(screen.getByText('Payment Streams')).toBeInTheDocument();
    });

    it('lists Jupiter Swap Integration as shipped', () => {
      expandAllShippedCategories();
      expect(screen.getByText('Jupiter Swap Integration')).toBeInTheDocument();
    });

    it('lists Fiat On-Ramp (Cards + MoonPay) as shipped', () => {
      expandAllShippedCategories();
      expect(screen.getByText('Fiat On-Ramp (Cards + MoonPay)')).toBeInTheDocument();
    });

    it('lists Mobile App + Browser Extension as shipped', () => {
      expandAllShippedCategories();
      expect(screen.getByText('Mobile App + Browser Extension')).toBeInTheDocument();
    });

    it('lists On-Chain Smart Contracts as shipped', () => {
      expandAllShippedCategories();
      expect(screen.getByText('On-Chain Smart Contracts')).toBeInTheDocument();
    });

    it('describes the on-chain programs as trustless and permissionless', () => {
      expandAllShippedCategories();
      expect(screen.getByText(/Trustless, permissionless privacy/)).toBeInTheDocument();
    });

    it('lists Advanced Privacy (Decoy Transactions + Noise) as shipped', () => {
      expect(screen.getByText('Advanced Privacy (Decoy Transactions + Noise)')).toBeInTheDocument();
    });
  });

  describe('In Progress Phase -- Actively building', () => {
    // "Next" is the tab selected on mount, so no click is needed here.
    it('shows the "IN PROGRESS" status badge', () => {
      expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    });

    it('shows the "Next" phase title', () => {
      expect(screen.getByText('Next')).toBeInTheDocument();
    });

    it('shows "Actively building" subtitle', () => {
      expect(screen.getByText('Actively building')).toBeInTheDocument();
    });

    it('surfaces the first in-progress item as the current focus', () => {
      // The title also appears as a card below, so scope to the dashboard row.
      const focusRow = screen.getByText('Current focus').parentElement!;
      expect(within(focusRow).getByText('P-01 Internal Network Mapping')).toBeInTheDocument();
    });

    it('lists External Security Audit as in progress', () => {
      expect(screen.getByText('External Security Audit')).toBeInTheDocument();
    });

    it('names the auditors and the scope of the pre-mainnet audit', () => {
      expect(
        screen.getByText(
          'Comprehensive audit of all 12 programs, 6 STARK AIRs, custom on-chain FRI verifier, and 10 SDKs by OtterSec, Neodyme, or Trail of Bits before mainnet deployment.',
        ),
      ).toBeInTheDocument();
    });

    it('lists Mainnet Launch as in progress', () => {
      expect(screen.getByText('Mainnet Launch')).toBeInTheDocument();
    });
  });

  describe('Future Phase -- On the horizon', () => {
    beforeEach(() => {
      showPhase(/PLANNED/);
    });

    it('shows the "PLANNED" status badge', () => {
      expect(screen.getByText('PLANNED')).toBeInTheDocument();
    });

    it('shows the "Future" phase title', () => {
      expect(screen.getByText('Future')).toBeInTheDocument();
    });

    it('shows "On the horizon" subtitle', () => {
      expect(screen.getByText('On the horizon')).toBeInTheDocument();
    });

    it('lists Quantum Wallet (p01_quantum_wallet) as a future feature', () => {
      expect(screen.getByText('Quantum Wallet (p01_quantum_wallet)')).toBeInTheDocument();
    });

    it('describes the quantum wallet as STARK-authorized custody', () => {
      expect(
        screen.getByText(/STARK-authorized smart-contract wallet replacing Ed25519 fund custody/),
      ).toBeInTheDocument();
    });

    it('lists Cover Traffic (Self-Loop Dummies) as a future feature', () => {
      expect(screen.getByText('Cover Traffic (Self-Loop Dummies)')).toBeInTheDocument();
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
      expect(screen.getByText('> BUILD WITH US')).toBeInTheDocument();
    });

    it('displays "Shape the Future of Privacy" heading', () => {
      expect(screen.getByText('Shape the Future of Privacy')).toBeInTheDocument();
    });

    it('invites people to test and follow progress', () => {
      // Was "P-01 is open source ..." -- retracted; the source repo is not public
      // and the CTA link now points at the releases-only mirror.
      expect(
        screen.getByText('Join the community. Test, suggest features, or follow our progress.'),
      ).toBeInTheDocument();
    });

    // NOTE for whoever finishes WAITLIST MODE: commit b4ec9968 ("hide GitHub links during
    // waitlist phase") commented the GitHub entries out of components/CTA.tsx and
    // components/Footer.tsx and claims "the site no longer advertises it" — but it missed
    // this one, a full-size primary GitHub button at app/roadmap/page.tsx:757. The
    // assertion below describes what actually renders today; DELETE it (do not "fix" it)
    // when the roadmap CTA is hidden too.
    it('has a GitHub CTA button pointing at the releases repo', () => {
      const links = screen.getAllByRole('link', { name: 'GitHub' });
      const ghLink = links.find(
        (l) => l.getAttribute('href') === 'https://github.com/IsSlashy/Protocol-01-releases',
      );
      expect(ghLink).toBeDefined();
    });

    it('has a Discord CTA button', () => {
      const links = screen.getAllByRole('link', { name: 'Discord' });
      const discordLink = links.find((l) => l.getAttribute('href') === 'https://discord.gg/EfqnVmb2dV');
      expect(discordLink).toBeDefined();
    });
  });
});

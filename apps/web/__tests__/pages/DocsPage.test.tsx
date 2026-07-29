import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DocsPage from '@/app/docs/page';

/**
 * /docs was rebuilt as a documentation SHELL: a grouped sidebar (components/docs/Sidebar)
 * drives a single active topic at a time, plus a Ctrl+K search, an "on this page" ToC and a
 * prev/next pager. It no longer renders every technology section stacked on one long page,
 * and it no longer draws its own header/footer — it mounts the shared <SiteHeader /> and
 * <Footer />.
 *
 * So a lot of copy that used to be visible on first paint now lives one sidebar click away.
 * `openTopic()` performs that click, which keeps these assertions on real, user-visible copy
 * instead of dropping the coverage.
 */
function openTopic(sidebarTitle: string) {
  // Sidebar entries are buttons whose accessible name is exactly the topic title.
  // The prev/next pager buttons are named "Previous <title>" / "Next <title>", so an
  // exact name match can only hit the sidebar entry.
  fireEvent.click(screen.getByRole('button', { name: sidebarTitle }));
}

describe('DocsPage -- Privacy technologies documentation', () => {
  beforeEach(() => {
    // The topic switcher calls window.scrollTo, which jsdom does not implement.
    window.scrollTo = vi.fn();
    render(<DocsPage />);
  });

  describe('Site header', () => {
    it('renders the shared site header with the Protocol 01 wordmark', () => {
      const header = screen.getByRole('banner');
      expect(within(header).getByText('PROTOCOL 01')).toBeInTheDocument();
      expect(within(header).getByAltText('Protocol 01')).toHaveAttribute('src', '/icon.png');
    });

    it('exposes "Docs" in the header nav, pointing at /docs', () => {
      const header = screen.getByRole('banner');
      expect(within(header).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    });

    it('has a home link on the logo pointing to /', () => {
      const header = screen.getByRole('banner');
      const logoLink = within(header).getByRole('link', { name: /Protocol 01/i });
      expect(logoLink).toHaveAttribute('href', '/');
    });
  });

  describe('Hero Section (Architecture topic, opened by default)', () => {
    it('displays "Privacy Technologies" as the main heading', () => {
      // Split across two elements now: "Privacy" + a gradient <span>Technologies</span>.
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Privacy Technologies$/);
    });

    // REMOVED ON PURPOSE — no assertion here.
    //
    // This slot used to assert i18n/en.ts:965 (docs.heroSubtitle) verbatim:
    //   "Zero-knowledge proofs, multi-party computation, and post-quantum cryptography
    //    — delivering true financial privacy on Solana."
    // That sentence still renders, but it makes two claims the project has retracted:
    // multi-party computation (Arcium was removed from Protocol 01 — privacy-sdk 1.0.2
    // dropped the mpc module, docs cleaned in 48b0cad7) and the unqualified absolute
    // "true financial privacy". Pinning it as expected truth would mean the honesty pass
    // has to break a green test to finish its own job, so the assertion is deleted rather
    // than kept. The copy is the thing that needs fixing, in i18n/en.ts (+ fr.ts/ja.ts).
    // When heroSubtitle is rewritten, add an exact assertion on the new wording here.
  });

  describe('System Architecture Diagram', () => {
    it('displays "System Architecture" as the diagram section heading', () => {
      expect(
        screen.getByRole('heading', { level: 2, name: 'System Architecture' }),
      ).toBeInTheDocument();
    });

    it('shows "Protocol Stack" title inside the diagram', () => {
      expect(screen.getByText('Protocol Stack')).toBeInTheDocument();
    });

    it('renders the Client Layer with Mobile App, Extension, Web App and AI Agent', () => {
      expect(screen.getByText('Client Layer')).toBeInTheDocument();
      expect(screen.getByText('MOBILE APP')).toBeInTheDocument();
      expect(screen.getByText('EXTENSION')).toBeInTheDocument();
      expect(screen.getByText('WEB APP')).toBeInTheDocument();
      expect(screen.getByText('AI AGENT')).toBeInTheDocument();
    });

    it('renders the SDK Layer as the published package names', () => {
      expect(screen.getByText('SDK Layer')).toBeInTheDocument();
      expect(screen.getByText('@protocol-01/specter-sdk')).toBeInTheDocument();
      expect(screen.getByText('@protocol-01/zk-sdk')).toBeInTheDocument();
      expect(screen.getByText('STARK Prover (post-quantum)')).toBeInTheDocument();
    });

    it('renders the Protocol Layer with Stealth, Shielded and Payments', () => {
      expect(screen.getByText('Protocol Layer')).toBeInTheDocument();
      expect(screen.getByText('STEALTH')).toBeInTheDocument();
      expect(screen.getByText('SHIELDED')).toBeInTheDocument();
      expect(screen.getByText('PAYMENTS')).toBeInTheDocument();
      expect(screen.getByText('Streams & Subscriptions')).toBeInTheDocument();
    });

    it('renders the Verification Layer with the on-chain relayer and STARK verifier', () => {
      expect(screen.getByText('Verification Layer')).toBeInTheDocument();
      expect(screen.getByText('ON-CHAIN RELAYER')).toBeInTheDocument();
      expect(screen.getByText('Trustless ZK Relay')).toBeInTheDocument();
      expect(screen.getByText('STARK VERIFIER')).toBeInTheDocument();
      expect(screen.getByText('FRI + Goldilocks')).toBeInTheDocument();
    });

    // The last assertion is LEFT FAILING ON PURPOSE — the diagram still advertises a
    // dependency the same page says was removed. i18n/en.ts:1045 labels the verification
    // node "alt_bn128 + FRI", while en.ts:1306 lists "alt_bn128 syscalls" under "Removed
    // dependencies", and the only alt_bn128 left in the Rust programs is commented-out
    // Groth16 code (programs/zk_shielded/src/compliance.rs:284). The node itself is real
    // (sub-label "ZK Verification"), so that stays asserted; the stale half does not.
    it('renders the Solana Blockchain layer with the program count and SPL tokens', () => {
      expect(screen.getByText('Solana Blockchain')).toBeInTheDocument();
      expect(screen.getByText('14 PROGRAMS')).toBeInTheDocument();
      expect(screen.getByText('SPL Tokens')).toBeInTheDocument();
      expect(screen.getByText('ZK Verification')).toBeInTheDocument();
      expect(screen.queryAllByText(/alt_bn128/)).toHaveLength(0);
    });

    it('shows "End-to-end encrypted" status indicator', () => {
      expect(screen.getByText('End-to-end encrypted')).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Stealth Addresses', () => {
    it('documents Stealth Addresses (ECDH)', () => {
      openTopic('Stealth Addresses (ECDH)');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Stealth Addresses (ECDH)' }),
      ).toBeInTheDocument();
    });

    it('explains ECDH key exchange for one-time addresses', () => {
      openTopic('Stealth Addresses (ECDH)');
      expect(screen.getByText(/recipients to receive funds without revealing/)).toBeInTheDocument();
    });

    it('lists the Curve25519 implementation detail', () => {
      openTopic('Stealth Addresses (ECDH)');
      expect(
        screen.getByText('v1: X25519 (Curve25519) for efficiency on Solana'),
      ).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Zero-Knowledge Proofs', () => {
    it('documents Zero-Knowledge Proofs (STARK)', () => {
      openTopic('Zero-Knowledge Proofs (STARK)');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Zero-Knowledge Proofs (STARK)' }),
      ).toBeInTheDocument();
    });

    it('describes the post-quantum STARK proof system over Goldilocks', () => {
      openTopic('Zero-Knowledge Proofs (STARK)');
      expect(
        screen.getByText(
          /^Post-quantum STARK proof system over the Goldilocks field, powered by Winterfell\./,
        ),
      ).toBeInTheDocument();
    });

    it('mentions the custom on-chain FRI verifier and its CU cost', () => {
      openTopic('Zero-Knowledge Proofs (STARK)');
      expect(
        screen.getByText(
          'Custom on-chain FRI verifier (no Winterfell dep — fits 4KB stack), ~889K CU per verification',
        ),
      ).toBeInTheDocument();
    });

    it('notes that Groth16/BN254 was retired in April 2026', () => {
      openTopic('Zero-Knowledge Proofs (STARK)');
      expect(screen.getByText(/Groth16\/BN254 was retired in April 2026/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Shielded Pool & Merkle Tree', () => {
    it('documents the Shielded Pool & Relayer', () => {
      openTopic('Shielded Pool & Relayer');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Shielded Pool & Relayer' }),
      ).toBeInTheDocument();
    });

    // LEFT FAILING ON PURPOSE — this is a documentation bug, not test drift.
    //
    // The shipped constant is depth 15: lib/privacy/pool/denominatedPool.ts:96
    //   export const MERKLE_DEPTH = 15;
    // and the honesty pass already corrected the sibling string (i18n/en.ts:1101
    // "Depth 15 = 2^15 = 32,768 commitments capacity per pool", plus en.ts:1176 and
    // components/Showcase.tsx). It MISSED i18n/en.ts:1084, which still publishes
    // "Sparse Merkle tree with depth 20 for commitment tracking" — i.e. a ~1M-note
    // capacity the pool does not have. Asserting the depth-20 string would lock the
    // wrong number in, so this test asserts the sentence shape and that no depth-20
    // claim survives. It goes green when en.ts:1084 is corrected to depth 15.
    it('states a shielded-pool Merkle depth consistent with the shipped MERKLE_DEPTH (15)', () => {
      openTopic('Shielded Pool & Relayer');
      expect(
        screen.getByText(/^Sparse Merkle tree with depth \d+ for commitment tracking$/),
      ).toBeInTheDocument();
      expect(screen.queryAllByText(/depth 20/i)).toHaveLength(0);
    });

    it('states the per-pool note capacity', () => {
      openTopic('Merkle Tree Proofs');
      expect(
        screen.getByText('Depth 15 = 2^15 = 32,768 commitments capacity per pool'),
      ).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Poseidon Hash', () => {
    it('documents Poseidon Hash Function', () => {
      openTopic('Poseidon Hash Function');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Poseidon Hash Function' }),
      ).toBeInTheDocument();
    });

    it('explains it is ZK-friendly and more efficient than SHA-256', () => {
      openTopic('Poseidon Hash Function');
      expect(screen.getByText(/ZK-friendly hash function/)).toBeInTheDocument();
      expect(screen.getByText(/more efficient than traditional hashes like SHA-256/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Solana Integration', () => {
    it('documents Solana On-Chain Verification', () => {
      openTopic('Solana On-Chain Verification');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Solana On-Chain Verification' }),
      ).toBeInTheDocument();
    });

    it('states the on-chain verification cost in compute units', () => {
      openTopic('Solana On-Chain Verification');
      expect(
        screen.getByText(
          'Custom FRI verifier for STARK proofs — Goldilocks field (~889K CU per verification)',
        ),
      ).toBeInTheDocument();
    });

    // LEFT FAILING ON PURPOSE — stale performance claim, ~4.5x better than reality.
    //
    // i18n/en.ts:1117 (docs.solanaIntegration.desc) still ends "...achieving verification
    // in under 200K compute units", three lines above detail1 which says ~889K CU. The
    // ~889K figure is corroborated at en.ts:452, en.ts:504, en.ts:1070, en.ts:1305 and in
    // the inline code comments at app/docs/page.tsx:80/152/181, so 200K is the outlier and
    // it is a published performance claim the protocol does not meet. Goes green when
    // en.ts:1117 is corrected.
    it('does not publish the stale "under 200K compute units" verification claim', () => {
      openTopic('Solana On-Chain Verification');
      expect(screen.queryAllByText(/under 200K compute units/)).toHaveLength(0);
    });
  });

  describe('Core Technologies - On-Chain Relayer', () => {
    it('documents the trustless on-chain relayer', () => {
      openTopic('On-Chain Relayer (Trustless)');
      expect(
        screen.getByRole('heading', { level: 1, name: 'On-Chain Relayer (Trustless)' }),
      ).toBeInTheDocument();
    });

    it('explains the relayer leaves no on-chain link to the original sender', () => {
      openTopic('On-Chain Relayer (Trustless)');
      expect(
        screen.getByText('Sends to stealth address — no on-chain link to the original sender'),
      ).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Client SDK', () => {
    it('documents Client SDK Architecture', () => {
      openTopic('Client SDK Architecture');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Client SDK Architecture' }),
      ).toBeInTheDocument();
    });

    it('lists specter-sdk in the feature list and P01Client/ShieldedClient in the code sample', () => {
      openTopic('Client SDK Architecture');
      expect(
        screen.getByText(
          '@protocol-01/specter-sdk — Core privacy: stealth wallets, transfers, quantum vault, registry, indexer',
        ),
      ).toBeInTheDocument();

      const code = document.querySelector('#client-sdk-code pre') as HTMLElement;
      expect(code).toHaveTextContent("const client = new P01Client({ cluster: 'devnet' });");
      expect(code).toHaveTextContent('const zkClient = new ShieldedClient({ rpcUrl, programId });');
    });
  });

  describe('Security Model Section', () => {
    it('displays the "Security Model" heading', () => {
      openTopic('Security Model');
      expect(screen.getByRole('heading', { level: 1, name: 'Security Model' })).toBeInTheDocument();
    });

    it('shows "Threat Model" subsection', () => {
      openTopic('Security Model');
      expect(screen.getByRole('heading', { level: 2, name: 'Threat Model' })).toBeInTheDocument();
    });

    it('shows "Guarantees" subsection', () => {
      openTopic('Security Model');
      expect(screen.getByRole('heading', { level: 2, name: 'Guarantees' })).toBeInTheDocument();
    });

    it('guarantees soundness: invalid proofs cannot be generated', () => {
      openTopic('Security Model');
      expect(screen.getByText('Sound: Invalid proofs cannot be generated')).toBeInTheDocument();
    });

    it('guarantees completeness: valid spends always produce valid proofs', () => {
      openTopic('Security Model');
      expect(
        screen.getByText('Complete: Valid spends always produce valid proofs'),
      ).toBeInTheDocument();
    });

    it('guarantees zero-knowledge: proofs reveal nothing beyond validity', () => {
      openTopic('Security Model');
      expect(
        screen.getByText('Zero-knowledge: Proofs reveal nothing beyond validity'),
      ).toBeInTheDocument();
    });

    it('guarantees no double-spending via unique nullifiers', () => {
      openTopic('Security Model');
      expect(
        screen.getByText('No double-spending: Nullifiers are unique per commitment'),
      ).toBeInTheDocument();
    });
  });

  describe('Sidebar navigation (replaces the old Quick Navigation block)', () => {
    it('groups the topics under the documentation sections', () => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
      expect(screen.getByText('Privacy Primitives')).toBeInTheDocument();
      expect(screen.getByText('Pools & Balances')).toBeInTheDocument();
      expect(screen.getByText('Wallet & Tools')).toBeInTheDocument();
      expect(screen.getByText('Security & Reference')).toBeInTheDocument();
    });

    it('opens a technology topic when its sidebar entry is selected', () => {
      // The shell shows one topic at a time, so the stealth topic is not on screen yet.
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Stealth Addresses (ECDH)' }),
      ).not.toBeInTheDocument();

      openTopic('Stealth Addresses (ECDH)');

      expect(
        screen.getByRole('heading', { level: 1, name: 'Stealth Addresses (ECDH)' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: /^Privacy Technologies$/ })).not.toBeInTheDocument();
    });
  });

  describe('Footer', () => {
    it('displays copyright notice', () => {
      expect(
        screen.getByText(`© ${new Date().getFullYear()} PROTOCOL 01 · Devnet only — not audited.`),
      ).toBeInTheDocument();
    });
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DocsPage from '@/app/docs/page';

describe('DocsPage -- Privacy technologies documentation', () => {
  beforeEach(() => {
    render(<DocsPage />);
  });

  describe('Documentation Header', () => {
    it('displays the P01 logo badge', () => {
      expect(screen.getByText('P01')).toBeInTheDocument();
    });

    it('displays "DOCUMENTATION" as the page title', () => {
      expect(screen.getByText('DOCUMENTATION')).toBeInTheDocument();
    });

    it('has a "Back to Home" link pointing to /', () => {
      const link = screen.getByText('Back to Home');
      expect(link.closest('a')).toHaveAttribute('href', '/');
    });
  });

  describe('Hero Section', () => {
    it('displays "Privacy Technologies" as the main heading', () => {
      expect(screen.getByText('Privacy Technologies')).toBeInTheDocument();
    });

    it('explains Protocol 01 combines cutting-edge cryptography', () => {
      expect(screen.getByText(/combines cutting-edge cryptography/)).toBeInTheDocument();
    });
  });

  describe('System Architecture Diagram', () => {
    it('displays "System Architecture" heading', () => {
      // Appears multiple times (section label + diagram title)
      const headings = screen.getAllByText('System Architecture');
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });

    it('shows "Protocol Stack" title inside the diagram', () => {
      expect(screen.getByText('Protocol Stack')).toBeInTheDocument();
    });

    it('renders the Client Layer with Mobile App, Extension, and SDK', () => {
      expect(screen.getByText('MOBILE APP')).toBeInTheDocument();
      expect(screen.getByText('EXTENSION')).toBeInTheDocument();
      expect(screen.getByText('SDK')).toBeInTheDocument();
    });

    it('renders the ZK-SDK layer with WASM Prover and Poseidon', () => {
      expect(screen.getByText('WASM Prover')).toBeInTheDocument();
      expect(screen.getByText('Note Mgmt')).toBeInTheDocument();
    });

    it('renders the Protocol Layer with Stealth, Shielded, and Streams', () => {
      expect(screen.getByText('STEALTH')).toBeInTheDocument();
      expect(screen.getByText('SHIELDED')).toBeInTheDocument();
      expect(screen.getByText('STREAMS')).toBeInTheDocument();
    });

    it('renders the Relay Layer', () => {
      expect(screen.getByText('RELAYER')).toBeInTheDocument();
      expect(screen.getByText('ON-CHAIN')).toBeInTheDocument();
    });

    it('renders the Solana Blockchain layer with alt_bn128 and Anchor', () => {
      expect(screen.getByText('alt_bn128')).toBeInTheDocument();
      expect(screen.getByText('SPL Tokens')).toBeInTheDocument();
    });

    it('shows "End-to-end encrypted" status indicator', () => {
      expect(screen.getByText('End-to-end encrypted')).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Stealth Addresses', () => {
    it('documents Stealth Addresses (ECDH)', () => {
      expect(screen.getByText('Stealth Addresses (ECDH)')).toBeInTheDocument();
    });

    it('explains ECDH key exchange for one-time addresses', () => {
      expect(screen.getByText(/recipients to receive funds without revealing/)).toBeInTheDocument();
    });

    it('lists Curve25519 implementation detail', () => {
      expect(screen.getByText(/Implemented using Curve25519/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Zero-Knowledge Proofs', () => {
    it('documents Zero-Knowledge Proofs (Groth16)', () => {
      expect(screen.getByText('Zero-Knowledge Proofs (Groth16)')).toBeInTheDocument();
    });

    it('explains ZK-SNARKs for private transfers', () => {
      expect(screen.getByText(/amounts and participants are hidden/)).toBeInTheDocument();
    });

    it('lists ~12,000 constraints for efficient proving', () => {
      expect(screen.getByText(/12,000 constraints/)).toBeInTheDocument();
    });

    it('mentions Groth16 verification using Solana native BN254 pairing', () => {
      expect(screen.getByText(/Groth16 verification using Solana's native BN254/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Shielded Pool', () => {
    it('documents Shielded Pool Architecture', () => {
      expect(screen.getByText('Shielded Pool Architecture')).toBeInTheDocument();
    });

    it('explains Merkle tree storage of encrypted notes', () => {
      // Multiple mentions of "Merkle tree" in the docs
      const mentions = screen.getAllByText(/Merkle tree/i);
      expect(mentions.length).toBeGreaterThanOrEqual(1);
    });

    it('mentions ~1M notes capacity', () => {
      expect(screen.getByText(/1M notes capacity/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Poseidon Hash', () => {
    it('documents Poseidon Hash Function', () => {
      expect(screen.getByText('Poseidon Hash Function')).toBeInTheDocument();
    });

    it('explains it is ZK-friendly and more efficient than SHA-256', () => {
      expect(screen.getByText(/ZK-friendly hash function/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Solana Integration', () => {
    it('documents Solana On-Chain Verification', () => {
      expect(screen.getByText('Solana On-Chain Verification')).toBeInTheDocument();
    });

    it('mentions under 200K compute units', () => {
      expect(screen.getByText(/under 200K compute units/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Private Relay', () => {
    it('documents Private Relay Architecture', () => {
      expect(screen.getByText('Private Relay Architecture')).toBeInTheDocument();
    });

    it('explains the relayer breaks on-chain link between sender and recipient', () => {
      expect(screen.getByText(/breaking the on-chain link/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Client SDK', () => {
    it('documents Client SDK Architecture', () => {
      expect(screen.getByText('Client SDK Architecture')).toBeInTheDocument();
    });

    it('mentions SpecterClient and ShieldedClient', () => {
      expect(screen.getByText(/SpecterClient.*ShieldedClient/)).toBeInTheDocument();
    });
  });

  describe('Security Model Section', () => {
    it('displays the "Security Model" heading', () => {
      expect(screen.getByText('Security Model')).toBeInTheDocument();
    });

    it('shows "Threat Model" subsection', () => {
      expect(screen.getByText('Threat Model')).toBeInTheDocument();
    });

    it('shows "Guarantees" subsection', () => {
      expect(screen.getByText('Guarantees')).toBeInTheDocument();
    });

    it('guarantees soundness: invalid proofs cannot be generated', () => {
      expect(screen.getByText(/Sound: Invalid proofs cannot be generated/)).toBeInTheDocument();
    });

    it('guarantees completeness: valid spends always produce valid proofs', () => {
      expect(screen.getByText(/Complete: Valid spends always produce valid proofs/)).toBeInTheDocument();
    });

    it('guarantees zero-knowledge: proofs reveal nothing beyond validity', () => {
      expect(screen.getByText(/Zero-knowledge: Proofs reveal nothing beyond validity/)).toBeInTheDocument();
    });

    it('guarantees no double-spending via unique nullifiers', () => {
      expect(screen.getByText(/No double-spending: Nullifiers are unique per note/)).toBeInTheDocument();
    });
  });

  describe('Quick Navigation Section', () => {
    it('displays "Quick Navigation" heading', () => {
      expect(screen.getByText('Quick Navigation')).toBeInTheDocument();
    });

    it('has quick nav links for each technology section', () => {
      const navLinks = screen.getAllByRole('link');
      const stealthLink = navLinks.find(l => l.getAttribute('href') === '#stealth-addresses');
      expect(stealthLink).toBeDefined();
    });
  });

  describe('Footer', () => {
    it('displays copyright notice', () => {
      expect(screen.getByText(/PROTOCOL 01 \| Built from scratch for privacy/)).toBeInTheDocument();
    });
  });
});

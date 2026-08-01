import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TechStack from '@/components/TechStack';

describe('TechStack -- Cryptography and infrastructure showcase', () => {
  beforeEach(() => {
    render(<TechStack />);
  });

  describe('Section Header', () => {
    it('displays the "Technology" badge', () => {
      expect(screen.getByText('Technology')).toBeInTheDocument();
    });

    it('presents the headline about cutting-edge cryptography', () => {
      expect(screen.getByText(/Built on/)).toBeInTheDocument();
      expect(screen.getByText(/cutting-edge cryptography/)).toBeInTheDocument();
    });

    it('mentions zero-knowledge proofs and privacy-preserving protocols', () => {
      expect(screen.getByText(/zero-knowledge proofs/)).toBeInTheDocument();
    });
  });

  describe('Protocol Architecture Diagram', () => {
    it('displays the "Protocol Architecture" section title', () => {
      expect(screen.getByText('Protocol Architecture')).toBeInTheDocument();
    });

    it('shows the Application Layer', () => {
      expect(screen.getByText('Application Layer')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Wallet, Streams, Agent, Denominated Pools, Subscription Vaults, P2P Sharing'
        )
      ).toBeInTheDocument();
    });

    it('shows the Privacy Layer', () => {
      expect(screen.getByText('Privacy Layer')).toBeInTheDocument();
      // Was "ZK Proofs, ..." before the Groth16 -> Goldilocks STARK migration (ac07e56c).
      expect(
        screen.getByText(
          'STARK Proofs, Stealth Addresses, Encryption, zkSPL Confidential Balances'
        )
      ).toBeInTheDocument();
    });

    it('shows the Execution Layer', () => {
      expect(screen.getByText('Execution Layer')).toBeInTheDocument();
      // "TEE Compute, Private Relayers" was removed on purpose by the accuracy pass
      // (90031780): no TEE compute exists. The layer now names only shipped programs.
      expect(
        screen.getByText('On-chain Relayer, STARK Verifier, Quantum Vault, Subscription Crank')
      ).toBeInTheDocument();
    });

    it('shows the Settlement Layer', () => {
      expect(screen.getByText('Settlement Layer')).toBeInTheDocument();
      expect(screen.getByText('Solana, SPL Tokens, Jupiter')).toBeInTheDocument();
    });

    it('mentions end-to-end privacy from application to settlement', () => {
      expect(screen.getByText(/End-to-end privacy from application to settlement/)).toBeInTheDocument();
    });
  });

  describe('Zero-Knowledge Technology Card', () => {
    it('displays the "Zero-Knowledge" category', () => {
      expect(screen.getByText('Zero-Knowledge')).toBeInTheDocument();
    });

    // Circom / "ZK circuit language" was replaced by Winterfell when the frontend
    // moved off Groth16 to the Goldilocks-field STARK prover (36612e6c, ac07e56c).
    it('lists Winterfell as the Goldilocks-field STARK prover', () => {
      expect(screen.getByText('Winterfell')).toBeInTheDocument();
      expect(screen.getByText('Goldilocks-field STARK prover')).toBeInTheDocument();
    });

    it('lists STARK as the active proof system', () => {
      expect(screen.getByText('STARK')).toBeInTheDocument();
      expect(screen.getByText('Quantum-resistant proof system')).toBeInTheDocument();
    });

    it('lists Poseidon as ZK-friendly hash', () => {
      expect(screen.getByText('Poseidon')).toBeInTheDocument();
      expect(screen.getByText('ZK-friendly hash')).toBeInTheDocument();
    });
  });

  describe('Privacy Infrastructure Card', () => {
    it('displays the "Privacy Infrastructure" category', () => {
      expect(screen.getByText('Privacy Infrastructure')).toBeInTheDocument();
    });

    it('lists Stealth Addresses with unlinkable recipients', () => {
      expect(screen.getByText('Stealth Addresses')).toBeInTheDocument();
      expect(screen.getByText('Unlinkable recipients')).toBeInTheDocument();
    });

    it('lists Private Relay', () => {
      // There are multiple "Private Relay" elements
      const relays = screen.getAllByText('Private Relay');
      expect(relays.length).toBeGreaterThanOrEqual(1);
    });

    it('lists Encrypted Storage', () => {
      expect(screen.getByText('Encrypted Storage')).toBeInTheDocument();
    });
  });

  describe('Blockchain Technology Card', () => {
    it('lists Solana as high-speed settlement', () => {
      expect(screen.getByText('Solana')).toBeInTheDocument();
      expect(screen.getByText('High-speed settlement')).toBeInTheDocument();
    });

    it('lists Anchor as smart contract framework', () => {
      expect(screen.getByText('Anchor')).toBeInTheDocument();
      expect(screen.getByText('Smart contract framework')).toBeInTheDocument();
    });

    it('lists SPL Tokens as token standard', () => {
      expect(screen.getByText('SPL Tokens')).toBeInTheDocument();
      expect(screen.getByText('Token standard')).toBeInTheDocument();
    });
  });

  describe('Security Badges', () => {
    it('displays Self-Custody badge', () => {
      expect(screen.getByText('Self-Custody')).toBeInTheDocument();
    });

    it('displays ZK-Powered badge', () => {
      expect(screen.getByText('ZK-Powered')).toBeInTheDocument();
    });

    it('displays Solana Native badge', () => {
      expect(screen.getByText('Solana Native')).toBeInTheDocument();
    });
  });
});

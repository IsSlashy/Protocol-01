import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Features from '@/components/Features';

/**
 * The Features section was rebuilt (a91974cd "streamline landing page — compact
 * features grid", d8afea09 "liquid glass features grid") from five long-form
 * modules — each with a tagline, a bullet list, a code preview and its own docs
 * deep-link — into a flat grid of fourteen cards, each a name plus one sentence.
 *
 * Assertions below are the exact strings the component renders today, sourced
 * from `i18n/en.ts` under `features.*`. They are meant to break when the copy
 * changes: keep them exact.
 */

// The fourteen modules, in the order `components/Features.tsx` declares them.
const MODULES: ReadonlyArray<readonly [name: string, description: string]> = [
  ['Auto-Shield', 'Funds move into the private pool automatically, so your balance never sits exposed on the public ledger.'],
  // Reworded 2026-08-17. The old text — "an address that nobody can link back to
  // the receiver's real wallet" — promised an impossibility this repo cannot
  // demonstrate, and Rule 4 of the claims lexicon now refuses it. The
  // replacement states the mechanism and names what defeats it.
  [
    'Stealth Transfers',
    "Send to a one-time address derived for that payment alone. It is not the receiver's wallet, and reaching them from it needs their viewing key.",
  ],
  ['Privacy Pools', 'Deposit into a shared pool of identical notes, so the amount you move is not distinctive.'],
  ['Private Subscriptions', 'Pay recurring bills from a vault addressed by a commitment to a note secret, so the vault does not name your wallet. The price and the interval sit in public in the merchant\'s registry entry.'],
  ['Token Swap', 'Trade one token for another in-app through the Jupiter aggregator. The swap itself is a public Solana transaction.'],
  ['AI Agent', 'An on-device assistant that runs your privacy actions (shield, pay, rebalance) on command.'],
  // The old text said the proof bytes did not yet hide the note values and the
  // masking was 'in development'. It shipped: the four production circuits took
  // a blinding mask and a lift column, and their committed values were measured
  // exactly uniform. C0 and C5 did not, and C0's witness recovery still works,
  // which is why the sentence keeps a second half.
  ['ZK Proofs', 'A STARK proof checked on-chain shows a spend is valid. The four circuits production uses carry a blinding mask and a lift column, and every committed value was measured exactly uniform. Two older circuits carry neither, and a private witness has been recovered from one of them.'],
  ['Confidential Balances', 'Token balances sit behind Poseidon commitments instead of clear numbers. The zkspl program is not deployed on devnet today.'],
  ['Stealth Meta-Addresses', 'One shareable address spawns a fresh one-time address for every payment you receive. The receiving address is new each time; the sender is not hidden.'],
  ['Subscription Vaults', 'An on-chain account that pays a merchant a fixed amount over time. The vault is addressed by a commitment to a note secret, not by your wallet, so nobody can rederive its address to ask whether you subscribe. A merchant\'s vaults themselves are enumerable on-chain.'],
  ['Multi-Hop Routing', 'Payments route through several shield and unshield hops with timing jitter. A hop republishes its deposit commitment wherever the old spend still runs — the phone, and any pre-blinding note — so a patient observer can rebuild the path there.'],
  ['Note Splitting', 'Split a private balance into smaller notes, so one withdrawal moves one denomination rather than your whole balance.'],
  ['Privacy Router', 'Automatically picks the best private path (relayer, hops, pool) for each transaction.'],
  ['Service Registry', 'Merchants register on-chain, so you can subscribe to real services with no account.'],
] as const;

describe('Features -- Protocol 01 privacy module grid', () => {
  beforeEach(() => {
    render(<Features />);
  });

  describe('Section Header', () => {
    it('badges the section as "14 Privacy Modules"', () => {
      expect(screen.getByText('14 Privacy Modules')).toBeInTheDocument();
    });

    it('headlines the module count and the single-stack framing', () => {
      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent('Fourteen modules.');
      expect(screen.getByText('One privacy stack.')).toBeInTheDocument();
    });
  });

  describe('Module grid', () => {
    it('renders exactly one card per module and nothing else', () => {
      const cardTitles = screen.getAllByRole('heading', { level: 3 });
      expect(cardTitles.map((h) => h.textContent)).toEqual(MODULES.map(([name]) => name));
    });

    it('renders as many cards as the badge advertises', () => {
      // Guards the badge/headline against silently outliving the grid: if a
      // module is dropped, "14 Privacy Modules" / "Fourteen modules." becomes a
      // false count and this fails.
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(14);
      expect(screen.getByText('14 Privacy Modules')).toBeInTheDocument();
    });

    it.each(MODULES)('describes the "%s" module', (name, description) => {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
    });
  });

  describe('Network Status Indicator', () => {
    it('displays DEVNET as the live network, with a pulsing indicator', () => {
      const devnet = screen.getByText('DEVNET');
      expect(devnet).toBeInTheDocument();
      // The live dot is the sibling immediately before the label.
      expect(devnet.previousElementSibling).toHaveClass('animate-pulse');
    });

    it('displays MAINNET as not yet live: dimmed, with a static indicator', () => {
      // Protocol 01 is devnet-only. The pill must not imply mainnet is running,
      // so MAINNET is rendered in the muted colour with no pulse. If mainnet
      // ever does go live, this assertion is the one to update deliberately.
      const mainnet = screen.getByText('MAINNET');
      expect(mainnet).toBeInTheDocument();
      expect(mainnet).toHaveClass('text-[#555560]');
      expect(mainnet.previousElementSibling).not.toHaveClass('animate-pulse');
    });
  });

  describe('Documentation link', () => {
    it('points to the docs with a single "EXPLORE DOCUMENTATION" call to action', () => {
      const link = screen.getByText('EXPLORE DOCUMENTATION →');
      expect(link.closest('a')).toHaveAttribute('href', '/docs');
    });
  });
});

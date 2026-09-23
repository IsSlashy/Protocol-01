import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DocsPage from '@/app/docs/page';
import { TOPIC_ORDER } from '@/components/docs/nav';
import en from '@/i18n/en';

/**
 * /docs was rebuilt as a documentation SHELL: a grouped sidebar (app/docs/_components/DocsRail)
 * drives a single active topic at a time, plus a Ctrl+K search, an "on this page" ToC and a
 * prev/next pager. It no longer renders every technology section stacked on one long page,
 * and it no longer draws its own header/footer — it mounts the shared Styx chrome
 * (StyxShell: StyxHeader and StyxFooter).
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

  /**
   * The chrome is the Styx one now: app/_styx/StyxHeader.tsx and StyxFooter.tsx,
   * mounted by StyxShell. The wordmark is set in type ("Styx" + "Protocol"), so
   * the raster logo and its alt text ("Protocol 01", /icon.png) are gone rather
   * than moved, and the banner's home link is named "Styx Protocol, home".
   * These three assertions were pinned to the retired identity; they now pin the
   * new one, at the same strength.
   */
  describe('Site header', () => {
    it('renders the shared site header with the Styx Protocol wordmark', () => {
      const header = screen.getByRole('banner');
      expect(within(header).getByText('Styx')).toBeInTheDocument();
      expect(within(header).getByText('Protocol')).toBeInTheDocument();
    });

    it('exposes "Docs" in the header nav, pointing at /docs', () => {
      const header = screen.getByRole('banner');
      expect(within(header).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    });

    it('has a home link on the logo pointing to /', () => {
      const header = screen.getByRole('banner');
      const logoLink = within(header).getByRole('link', { name: /Styx Protocol/i });
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
      expect(screen.getByText('@protocol-01/stark-prover')).toBeInTheDocument();
      // merchant-sdk is the package a merchant actually installs, and the
      // diagram omitted it entirely while labelling p01-js "Merchant SDK".
      expect(screen.getByText('@protocol-01/merchant-sdk')).toBeInTheDocument();
    });

    // arcium-sdk is still published on npm, but Arcium left the protocol on
    // 2026-07-17. The architecture diagram is a claim about what runs, so a
    // package nothing calls must not appear in it.
    it('does not show the retired Arcium SDK in the stack', () => {
      expect(screen.queryByText('@protocol-01/arcium-sdk')).toBeNull();
      expect(screen.queryByText('MPC Compute')).toBeNull();
    });

    // Same rule for zk-sdk, zkspl-sdk and privacy-toolkit: still on npm, but
    // their source was deleted on 2026-09-23 and no Styx client imports them.
    it('does not show the three deleted SDK packages in the stack', () => {
      expect(screen.queryByText('@protocol-01/zk-sdk')).toBeNull();
      expect(screen.queryByText('@protocol-01/zkspl-sdk')).toBeNull();
      expect(screen.queryByText('@protocol-01/privacy-toolkit')).toBeNull();
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
      expect(screen.getByText('On-Chain Relay Program')).toBeInTheDocument();
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

  // The topic was titled "Zero-Knowledge Proofs (STARK)". The prover is not
  // zero-knowledge: four witnesses of circuit 1, the spend secret among them,
  // were recovered from published proof bytes by Lagrange interpolation in
  // 5 ms, so the title now names the proof system instead of the property it
  // does not hold. The measurement is carried by probe P3b of
  // verify/p01-verify.mjs, pinned FAIL on every committed fixture.
  // (It used to cite stark/tests/zk_feasibility.rs, deleted in dc9dd515 --
  // calibrated to a superseded two-row wire, and nothing executable replaced
  // it, so there is no test anyone can run today to flip this.)
  describe('Core Technologies - STARK Proofs', () => {
    it('documents STARK Proofs (Goldilocks) without titling them zero-knowledge', () => {
      openTopic('STARK Proofs (Goldilocks)');
      expect(
        screen.getByRole('heading', { level: 1, name: 'STARK Proofs (Goldilocks)' }),
      ).toBeInTheDocument();
    });

    it('describes the post-quantum STARK proof system over Goldilocks', () => {
      openTopic('STARK Proofs (Goldilocks)');
      expect(
        screen.getByText(
          /^Post-quantum STARK proof system over the Goldilocks field, powered by Winterfell\./,
        ),
      ).toBeInTheDocument();
    });

    // Audit v1 round 1 (axis 8): the description said only the spend circuit
    // was masked, "unlike the other seven", which understated the code (masks
    // on all eight since the 2026-09-12 redeploy). It still must deny the
    // property, and still must name the witness recovery it replaced.
    it('states in the description that the proofs are not zero-knowledge, and that all eight circuits are masked', () => {
      openTopic('STARK Proofs (Goldilocks)');
      expect(
        screen.getByText(/not zero-knowledge as a proven property\. Until 31 August 2026 a private witness was recovered/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Masks now ship on all eight circuits/)).toBeInTheDocument();
      expect(screen.queryAllByText(/unlike the other seven/)).toHaveLength(0);
    });

    // This assertion is what kept the stale number alive. It pinned "809,812 CU
    // against the 1.4M budget", measured against the verifier deployed
    // 2026-08-04, and it went on passing after the verifier was REDEPLOYED on
    // 2026-09-02 (slot 491,973,056) because a green pin reads as a checked
    // figure. It is not: a pin only proves the string did not move. The
    // replacements below come from docs/BENCHMARK-2026-09-02.md, which reads
    // the compute units back off the transactions.
    //
    // The same thing happened again (audit v1 round 1, axis 8): the verifier
    // was redeployed on 2026-09-12 at slot 497,235,406, and the line kept the
    // 2026-09-02 slot and its CU figures. The figure now is the circuit-7 proof
    // from the shipped blob accepted on 2026-09-20, read back off that
    // transaction (packages/stark-prover/deployed-verifier.json,
    // accepts_client_blob_sha256_evidence_2026_09_20). 889,691 CU is phase 1
    // only (VerifyStarkProofV2); the transaction, both phases, used 1,082,158 CU
    // (getTransaction 5Kp9dMnU..., slot 501,407,541), so the line must say both.
    it('mentions the custom on-chain FRI verifier and its measured CU cost', () => {
      openTopic('STARK Proofs (Goldilocks)');
      expect(
        screen.getByText(/both phases in one transaction at 1,082,158 CU \(phase 1 889,691 CU, phase 2 192,317 CU/),
      ).toBeInTheDocument();
      expect(screen.queryAllByText(/both phases in one transaction at 889,691 CU/)).toHaveLength(0);
      expect(screen.getByText(/redeployed on devnet 2026-09-12 in slot 497,235,406/)).toBeInTheDocument();
      expect(screen.queryAllByText(/809,812 CU/)).toHaveLength(0);
      expect(screen.queryAllByText(/slot 491,973,056/)).toHaveLength(0);
    });

    // The page published "124-bit soundness with DEEP-ALI" in three places. The
    // number came from queries x log2(blowup) + grinding, which assumes the FRI
    // rate the config declares rather than the one the prover reaches, so it
    // overstated the bound. DEEP-ALI itself is real (verify_deep_ali_circuit_0..6);
    // only the bit-count is gone, and detail10 says so out loud.
    it('publishes no bit-level soundness figure', () => {
      openTopic('STARK Proofs (Goldilocks)');
      expect(screen.queryAllByText(/124-bit soundness/)).toHaveLength(0);
      expect(screen.getByText(/No bit-level security number is published here/)).toBeInTheDocument();
    });

    it('notes that Groth16/BN254 was retired in April 2026', () => {
      openTopic('STARK Proofs (Goldilocks)');
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

    /**
     * i18n/en.ts:1083 published "On-chain, only the relayer-to-stealth-address
     * link is visible, the original sender is completely hidden", detail1 added
     * "(sender never revealed)" and detail4 "On-chain visibility: Relayer to
     * Stealth Address only". All three are refuted by detail2 of the same card,
     * two lines up: the user funds the relayer, in the clear, before any of this
     * happens. The sender is not hidden on any leg.
     */
    it('does not claim the relayer hides the original sender', () => {
      openTopic('Shielded Pool & Relayer');
      expect(screen.queryAllByText(/original sender is completely hidden/i)).toHaveLength(0);
      expect(screen.queryAllByText(/sender never revealed/i)).toHaveLength(0);
      expect(screen.queryAllByText(/Stealth Address only/i)).toHaveLength(0);
      expect(screen.getByText(/The sender is not hidden/)).toBeInTheDocument();
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

    // Same trap as the pin in the STARK topic above: this assertion pinned the
    // 2026-08-04 figure verbatim and kept passing after the verifier was
    // redeployed on 2026-09-02, and then the 2026-09-02 figure after the
    // 2026-09-12 redeploy, which is exactly how stale numbers survive in public
    // copy. The pin now requires the date of the deployment the figure was
    // measured against, so a redeploy without a re-measure fails here.
    // Source: docs/BENCHMARK-2026-09-13.md §6 (C7, both phases in one tx).
    it('states the measured on-chain verification cost in compute units', () => {
      openTopic('Solana On-Chain Verification');
      expect(
        screen.getByText(
          'Custom FRI verifier for STARK proofs. Goldilocks field; an accepted spend proof measured 890,643 CU with both phases in one transaction on devnet, 2026-09-12 (docs/BENCHMARK-2026-09-13.md §6)',
        ),
      ).toBeInTheDocument();
    });

    // Was left failing on purpose while en.ts advertised "verification in under
    // 200K compute units" — 4.5x better than the protocol achieves. The English
    // desc was corrected first; fr.ts and ja.ts carried the same claim until
    // 2026-08-06 and now match.
    it('does not publish the stale "under 200K compute units" verification claim', () => {
      openTopic('Solana On-Chain Verification');
      expect(screen.queryAllByText(/under 200K compute units/)).toHaveLength(0);
    });

    // The line used to enumerate 13 Cargo members as if all were deployed. Since
    // 2026-09-14 it states four groups: live on devnet (checked by getAccountInfo
    // on 2026-09-14), deployed off the product path, in the repo but not
    // deployed, and closed on devnet on 2026-09-13. The live group is the one a
    // reader can verify on the explorer, so that is the one counted here.
    it('lists the four programs live on devnet and names the closed ones as closed', () => {
      openTopic('Solana On-Chain Verification');
      const line = screen.getByText(/^4 programs live on devnet:/);
      expect(line).toBeInTheDocument();
      expect(line.textContent).not.toMatch(/trustless/);
      const live = line.textContent!.replace(/^4 programs live on devnet:\s*/, '').split('.')[0].split(',');
      expect(live).toHaveLength(4);
      expect(live.map((s) => s.trim())).toEqual(['p01_stark_verifier', 'zk_shielded', 'p01_registry', 'p01_relayer']);
      expect(line.textContent).toMatch(/Closed on devnet 2026-09-13: specter/);
    });
  });

  describe('Core Technologies - On-Chain Relayer', () => {
    it('documents the on-chain relayer nobody operates', () => {
      openTopic('On-Chain Relayer (deployed, not operated)');
      expect(
        screen.getByRole('heading', { level: 1, name: 'On-Chain Relayer (deployed, not operated)' }),
      ).toBeInTheDocument();
    });

    /**
     * WAS: an exact assertion on i18n/en.ts:1136, "Sends to stealth address, no
     * on-chain link to the original sender", pinned as expected truth. That made
     * the suite REQUIRE a claim this same page refutes thirty lines away, in the
     * private-relay code sample: the inner transaction is signed with the user's
     * key BEFORE it is encrypted to the relayer, so that key is in the
     * transaction that lands on chain, and what the relayer hides is the IP
     * address and the outer fee payer.
     *
     * Measured in the program, not inferred: programs/p01_relayer/src contains no
     * proof handling at all (`grep -rl proof` returns nothing), and submit_job.rs
     * declares the user as `submitter: Signer<'info>` while complete_job.rs and
     * expire_job.rs both name that same submitter again, so the payer's key is on
     * chain in the relay bookkeeping too. Hence the second negative here: the
     * relayer program does not verify proofs and does not eliminate the third
     * party, it escrows a fee for a node that decrypts the transaction and can
     * decline to submit it.
     *
     * The negatives are the point. They fail while the retired claim is still
     * rendered, which is the exact opposite of what this slot used to do.
     */
    it('does not claim the relayer removes the on-chain link to the sender', () => {
      openTopic('On-Chain Relayer (deployed, not operated)');
      expect(
        screen.queryAllByText(/no on-chain link to the original sender/i),
      ).toHaveLength(0);
      expect(screen.queryAllByText(/eliminating trust in any third party/i)).toHaveLength(0);
      expect(screen.queryAllByText(/verifies ZK proofs and executes/i)).toHaveLength(0);
      expect(screen.getByText(/The sender is not hidden/)).toBeInTheDocument();
    });
  });

  describe('Core Technologies - Client SDK', () => {
    it('documents Client SDK Architecture', () => {
      openTopic('Client SDK Architecture');
      expect(
        screen.getByRole('heading', { level: 1, name: 'Client SDK Architecture' }),
      ).toBeInTheDocument();
    });

    it('lists specter-sdk in the feature list and P01Client, not a deleted package, in the code sample', () => {
      openTopic('Client SDK Architecture');
      expect(
        screen.getByText(
          '@protocol-01/specter-sdk. Registry, subscription and relay clients, off-chain stealth-address math (0.5.0 in this repository has no prover)',
        ),
      ).toBeInTheDocument();

      const code = document.querySelector('#client-sdk-code pre') as HTMLElement;
      expect(code).toHaveTextContent("const client = new P01Client({ cluster: 'devnet' });");
      expect(code).not.toHaveTextContent('ShieldedClient');
      expect(code).not.toHaveTextContent('ZkSplClient');
      // The three deleted packages are named only in the comment that says
      // why the sample does not import them.
      expect(code.textContent ?? '').not.toMatch(/from '@protocol-01\/(zk-sdk|zkspl-sdk|privacy-toolkit)'/);
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

    /**
     * The three unlinkability absolutes were dropped from the rendered threat
     * model on 2026-08-04 (app/docs/page.tsx, `threats`). Each is contradicted by
     * a measured fact, not by a matter of taste: a pool withdrawal republishes the
     * commitment its deposit published (devnet leaf 16, commitment
     * 8901821612542787864, in both transactions), so senders and recipients ARE
     * linkable, spending patterns ARE analysable and a third party CAN track a
     * balance. The strings still exist in i18n/en.ts:1316-1319, so a one-word
     * edit to the array puts them straight back on the page — this test is what
     * makes that show up as a failure instead of as a shipped claim.
     */
    it('does not publish the retracted unlinkability absolutes', () => {
      openTopic('Security Model');
      expect(
        screen.queryAllByText(/observers cannot link senders and recipients/i),
      ).toHaveLength(0);
      expect(screen.queryAllByText(/Spending patterns cannot be analyzed/i)).toHaveLength(0);
      expect(screen.queryAllByText(/Balance tracking is impossible/i)).toHaveLength(0);
    });

    /**
     * WAS: an exact assertion on "Sound: Invalid proofs cannot be generated".
     * The same page, on the STARK topic, refuses to publish any soundness figure
     * at all (docs.sections.zkProofs.detail10: the 124-bit claim came from
     * queries x log2(blowup), the real FRI rate was measured lower, and no
     * measured figure has replaced it). A page that will not state a soundness
     * error cannot also guarantee the error is zero, and this card sits under an
     * amber note saying the verifier is unaudited. So the absolute goes and the
     * qualified statement is asserted in its place.
     */
    it('states soundness without claiming invalid proofs are impossible', () => {
      openTopic('Security Model');
      expect(screen.queryAllByText(/Invalid proofs cannot be generated/i)).toHaveLength(0);
      expect(screen.getByText(/not as an absolute/i)).toBeInTheDocument();
    });

    it('guarantees completeness: valid spends always produce valid proofs', () => {
      openTopic('Security Model');
      expect(
        screen.getByText('Complete: Valid spends always produce valid proofs'),
      ).toBeInTheDocument();
    });

    /**
     * WAS: an exact assertion on "Zero-knowledge: Proofs reveal nothing beyond
     * validity". That claim is refuted by a measurement this repository owns:
     * four witnesses of circuit 1, the spend secret among them, recovered from
     * the published proof bytes by Lagrange interpolation in 5 ms. The
     * guarantee line now states the limitation and names the measurement.
     *
     * ⚠️ It used to say it "flips back when that recovery stops working", and
     * pointed at stark/tests/zk_feasibility.rs. That file was deleted in
     * dc9dd515 and NOTHING executable replaced it, so that trigger cannot be
     * pulled by anyone today. The claim's live statement is probe P3b of
     * verify/p01-verify.mjs, which is pinned FAIL by construction. Flipping
     * this back requires a positive control that runs and fails -- building
     * one is the work, not finding one.
     *
     * 2026-09-02: that positive control exists and it FAILS TO RECOVER. The
     * trace mask landed on C1 on 2026-08-31; air_aware_recovery_c1.rs now
     * reads under-determined and keeps the pre-mask model beside it, still
     * solving. The line changed exactly as its own rule said it would, and it
     * did NOT flip to a positive claim: five channels measured uniform on one
     * witness and one query set is a measurement, not a simulation argument.
     */
    it('states the proofs are not zero-knowledge, naming the witness recovery', () => {
      openTopic('Security Model');
      expect(screen.queryAllByText(/Proofs reveal nothing beyond validity/i)).toHaveLength(0);
      expect(
        screen.getByText(/Not zero-knowledge, and not claimed to be\. Until 31 August 2026 a private witness could be recovered/),
      ).toBeInTheDocument();
    });

    // Audit v1 round 1 (axis 8): "Nullifiers are unique per commitment" is false
    // in v1. The commitment is one 64-bit Goldilocks element, so two openings of
    // one commitment carry two nullifiers (docs/SECURITY-LEVELS.md, finding F2).
    it('does not guarantee against double spending in v1, and names finding F2', () => {
      openTopic('Security Model');
      expect(screen.queryAllByText(/Nullifiers are unique per commitment/)).toHaveLength(0);
      expect(
        screen.getByText(/^Double spending, not guaranteed in v1: .*Open as finding F2 in docs\/SECURITY-LEVELS\.md/),
      ).toBeInTheDocument();
    });
  });

  /**
   * The code samples on /docs are raw English that lives in app/docs/page.tsx,
   * not in i18n — which made them the one place on the page an honesty pass over
   * the locale files could not reach, and they had drifted furthest. Each
   * assertion below pins one retired claim against one measured fact:
   *
   *   · "never the user's wallet" / "Wallet NEVER appears" — the wallet publicly
   *     funds the ephemeral one hop before the shield and the unshield, so it is
   *     one hop away, not absent.
   *   · "Both sender + receiver hidden on-chain" — the stealth transfer is
   *     signed and fee-paid by the sender's own wallet
   *     (packages/pay-core/src/worker/workerCore.ts:352, 363).
   *   · "for decorrelation" on the mobile auto-sweep — the delay is a few
   *     seconds and was deliberately left that short; it is convenience, not a
   *     privacy mechanism.
   *   · "124-bit soundness" — the arithmetic that produced it was measured wrong
   *     for this FRI configuration and no measured figure replaced it.
   *
   * These are substring assertions on purpose. The wording of the honest
   * replacement is free to change; the retired claims are not free to come back.
   */
  describe('Code samples — retired privacy claims stay retired', () => {
    function codeOf(topicTitle: string, sectionId: string): string {
      openTopic(topicTitle);
      const pre = document.querySelector(`#${sectionId}-code pre`);
      expect(pre).not.toBeNull();
      return pre!.textContent ?? '';
    }

    it('does not claim the shielded-pool observer never sees the wallet', () => {
      const code = codeOf('Shielded Pool & Relayer', 'shielded-pool');
      expect(code).not.toMatch(/never the user's wallet/i);
      expect(code).toMatch(/pre-funds the ephemeral signer/i);
    });

    it('does not claim the wallet never appears in the denominated-pool flow', () => {
      const code = codeOf('Denominated Privacy Pools', 'denominated-pools');
      expect(code).not.toMatch(/Wallet NEVER appears/i);
      expect(code).not.toMatch(/for decorrelation/i);
      expect(code).toMatch(/NOT unlinkable/);
    });

    it('does not claim the sender is hidden on the stealth meta-address path', () => {
      const code = codeOf('Stealth Meta-Addresses (P01-to-P01)', 'stealth-meta-addresses');
      expect(code).not.toMatch(/Both sender \+ receiver hidden/i);
      expect(code).toMatch(/The SENDER is not/);
    });

    it('does not claim the main wallet is never visible on the auto-shield path', () => {
      const code = codeOf('Auto-Shield Receive', 'auto-shield');
      expect(code).not.toMatch(/Main wallet never visible on-chain/i);
    });

    it('publishes no STARK soundness bit-count', () => {
      const code = codeOf('STARK Proofs (Goldilocks)', 'zk-proofs');
      expect(code).not.toMatch(/124-bit/);
      expect(code).toMatch(/DEEP-ALI/);
    });

    it('says which ONE leg the web client relays, and that the rest is self-submitted', () => {
      /**
       * ⚠️ THIS TEST CHANGED SIDE ON 2026-08-21, DELIBERATELY. It used to pin
       * `The web app does not` relay — a correct control over a fact that has
       * since stopped being true: a deposit now funds its ephemeral through
       * this deployment. Leaving the old assertion would have pinned the docs
       * to a claim the code contradicts, which is the failure this whole suite
       * exists to prevent, arriving from the other direction.
       *
       * So it still pins the honest half — the IP is not hidden, ~280 chunks
       * are self-submitted — and now also pins that the one relayed leg is
       * named rather than glossed.
       */
      const code = codeOf('On-Chain Relayer (deployed, not operated)', 'private-relay');
      expect(code).toMatch(/relays exactly/i);
      expect(code).toMatch(/ONE leg/);
      expect(code).toMatch(/self-submitted/);
      expect(code).toMatch(/IP still reaches the RPC/);
      // And it must NOT go back to denying the relay outright.
      expect(code).not.toMatch(/The web app does not:/);
      expect(code).toMatch(/The IP address and the outer/);
      expect(code).toMatch(/Not the signer/);
    });

    it('says the multi-hop router does not produce an unlinkable path today', () => {
      const code = codeOf('Multi-Hop Privacy Router', 'privacy-router');
      expect(code).toMatch(/NOT an unlinkable/);
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

  /**
   * StyxFooter splits what the old footer said in one line: the copyright names
   * Styx Protocol, and the devnet/unaudited admission is its own span, in
   * stronger words than before ("Use funds you can afford to lose"). Both halves
   * are asserted, so the rename cannot quietly take the disclaimer with it.
   */
  describe('Footer', () => {
    it('displays copyright notice', () => {
      expect(
        screen.getByText(`© ${new Date().getFullYear()} Styx Protocol`),
      ).toBeInTheDocument();
    });

    it('still admits, in the footer, that this is unaudited devnet software', () => {
      expect(
        screen.getByText('Devnet software. Not audited. Use funds you can afford to lose.'),
      ).toBeInTheDocument();
    });
  });
});

/**
 * close-v1, lane L4: what the internal v1 audit left open on /docs.
 *
 *  F27  the shielded-pool sample advertised `liquidity.prefund(...)`, the
 *       deployed p01_liquidity path a judge drained in litesvm with the
 *       deployed ELF. The path is disabled in the SDK (lane L6); the sample
 *       must not teach it.
 *  F24  the page's own samples still named 7 AIRs, the 2026-09-02 phase CU
 *       figures and a Blake3 verifier (Blake3 was dropped: sol_blake3 is gated
 *       off, the verifier hashes with SHA-256).
 *  F68  the client-SDK sample presented privacy-toolkit as the Merkle and
 *       Poseidon of the stack; it is BN254 Poseidon (poseidon-lite), not the
 *       Goldilocks Poseidon of the pool, and it exports neither
 *       `IncrementalMerkleTree` nor `poseidon2`.
 *  F21  detail10 said the achieved FRI rate was "measured lower"; the verifier
 *       enforces 1/16 on every v1 circuit.
 *  F46  zkSPL: threshold and conservation are not enforced.
 *  F53  Poseidon width t=5 announced with an MDS matrix; live paths use t=3.
 */
describe('DocsPage -- close-v1 (audit v1 residuals)', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    render(<DocsPage />);
  });

  function codeOf(topicTitle: string, sectionId: string): string {
    openTopic(topicTitle);
    const pre = document.querySelector(`#${sectionId}-code pre`);
    expect(pre).not.toBeNull();
    return pre!.textContent ?? '';
  }

  it('F27: the shielded-pool sample does not call liquidity.prefund, and says the instant path is disabled', () => {
    const code = codeOf('Shielded Pool & Relayer', 'shielded-pool');
    expect(code).not.toMatch(/liquidity\.prefund/);
    expect(code).toMatch(/instant path[\s\S]{0,80}disabled/i);
  });

  it('F24: the STARK sample names 8 AIRs and the current accepted-proof figure', () => {
    const code = codeOf('STARK Proofs (Goldilocks)', 'zk-proofs');
    expect(code).not.toMatch(/\b7 AIRs\b/);
    expect(code).toMatch(/\b8 AIRs\b/);
    expect(code).not.toMatch(/878,756/);
    // 889,691 CU is phase 1 alone (getTransaction 5Kp9dMnU..., slot
    // 501,407,541); the transaction, both phases, used 1,082,158 CU.
    expect(code).toMatch(/1,082,158 CU/);
    expect(code).toMatch(/phase 1 889,691 CU/);
    expect(code).not.toMatch(/889,691 CU,? both phases/);
    // The "measured to be wrong" story is F21's false claim in comment form.
    expect(code).not.toMatch(/measured\s+(\/\/\s*)?to be wrong/);
    expect(code).toMatch(/docs\/SECURITY-LEVELS\.md/);
  });

  it('F24: no sample presents Blake3 as the verifier hash', () => {
    for (const [title, id] of [
      ['Solana On-Chain Verification', 'solana-integration'],
      ['On-Chain Relayer (deployed, not operated)', 'private-relay'],
    ] as const) {
      const code = codeOf(title, id);
      expect(code, id).not.toMatch(/Goldilocks \+[\s/]*Blake3/);
      expect(code, id).not.toMatch(/878,756/);
    }
  });

  // Verifier round 1: the check above covered two samples, and the
  // migration-history sample kept "Hash-based (Blake3 + Poseidon)" while its
  // own detail3 says Blake3 was tried and dropped. Walk every topic instead.
  it('F24: no sample on any topic presents Blake3 as a hash in use', () => {
    const sections = en.docs.sections as unknown as Record<string, { title?: string }>;
    const checked: string[] = [];
    for (const id of TOPIC_ORDER) {
      const key = id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      const title = sections[key]?.title;
      if (!title) continue; // special topics (architecture, security, quantum-wallet) carry no sample
      openTopic(title);
      const pre = document.querySelector(`#${id}-code pre`);
      if (!pre) continue;
      const code = pre.textContent ?? '';
      checked.push(id);
      expect(code, id).not.toMatch(/Goldilocks \+[\s/]*Blake3/);
      expect(code, id).not.toMatch(/Blake3 \+ Poseidon/);
      for (const line of code.split('\n').filter((l) => /blake3/i.test(l))) {
        // Blake3 may only be named as what was dropped.
        expect(line, id).toMatch(/dropped|not used|removed|gated off/i);
      }
    }
    // Anti-vacuity: the walk reached the samples that matter here.
    expect(checked).toEqual(expect.arrayContaining(['solana-integration', 'private-relay', 'migration-history']));
    expect(checked.length).toBeGreaterThanOrEqual(20);
  });

  it('F24: the migration-history sample names the hashes the verifier and circuits use', () => {
    const code = codeOf(en.docs.sections.migrationHistory.title, 'migration-history');
    expect(code).toMatch(/SHA-256/);
    expect(code).toMatch(/Poseidon/);
  });

  // privacy-toolkit's source was deleted on 2026-09-23, so the sample no
  // longer imports it; the comment that replaces the import still says what
  // it was (BN254 Poseidon, not the pool hash).
  it('F68: the client-SDK sample no longer imports privacy-toolkit, and still says it is BN254, not the pool hash', () => {
    const code = codeOf('Client SDK Architecture', 'client-sdk');
    expect(code).not.toMatch(/IncrementalMerkleTree|poseidon2/);
    expect(code).not.toMatch(/from '@protocol-01\/privacy-toolkit'/);
    expect(code).toMatch(/privacy-toolkit was BN254/);
    expect(code).toMatch(/not the pool hash/i);
  });

  it('F21: detail10 gives the FRI configuration the verifier enforces', () => {
    openTopic('STARK Proofs (Goldilocks)');
    const line = screen.getByText(/No bit-level security number is published here/);
    expect(line.textContent).toMatch(/1\/16/);
    expect(line.textContent).not.toMatch(/measured lower/);
  });

  it('F46: the zkSPL topic says threshold and conservation are not enforced', () => {
    openTopic('Confidential Balances (zkSPL)');
    expect(screen.getAllByText(/not enforced/).length).toBeGreaterThanOrEqual(2);
  });

  it('F53: the Poseidon topic names t=3 and does not announce t=5 with an MDS matrix', () => {
    openTopic('Poseidon Hash Function');
    expect(screen.queryAllByText(/t=3 and t=5 widths, circulant MDS matrix/)).toHaveLength(0);
    expect(screen.getByText(/t=3/)).toBeInTheDocument();
  });
});

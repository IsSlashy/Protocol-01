import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DocsPage from '@/app/docs/page';
import en from '@/i18n/en';

/**
 * [close-v1 F24/F53, gate r1 open item 3] The Poseidon topic of /docs shows
 * the hash v1 RUNS, not a retired one.
 *
 * Its code sample was a Circom `template Commitment` calling `Poseidon(4)`:
 * a BN254 circuit, width t = 5, four inputs (amount, owner, randomness, mint),
 * none of which exists on a live path. v1 hashes over Goldilocks with width
 * t = 3 (rate 2, capacity 1), x^7 S-box, 30 full rounds, output state[0]
 * (`stark/src/poseidon/mod.rs` `hash2`, mirrored by
 * `lib/privacy/pool/goldilocks-poseidon.ts` `goldilocksHash2to1`), and the
 * note commitment is three such 2-to-1 hashes
 * (`lib/privacy/pool/denominatedPool.ts` `createCommitmentV3`). The t = 5
 * permutation is in the source, unused by any circuit, and its matrix is not
 * MDS (F53; `docs/SECURITY-LEVELS.md`, `stark/src/poseidon/constants.rs`).
 */
describe('/docs Poseidon topic: the sample is the v1 hash', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    render(<DocsPage />);
    fireEvent.click(
      screen.getByRole('button', { name: en.docs.sections.poseidonHash.title }),
    );
  });

  const sample = () => {
    const blocks = [...document.querySelectorAll('pre, code')].map((n) => n.textContent ?? '');
    const hit = blocks.find((t) => /permutation_t3|Poseidon\(4\)|template Commitment/.test(t));
    expect(hit, 'no code sample on the Poseidon topic').toBeDefined();
    return hit!;
  };

  it('shows the Goldilocks t = 3 two-to-one hash the stark crate runs', () => {
    const s = sample();
    expect(s).toMatch(/Goldilocks/);
    expect(s).toMatch(/2\^64 - 2\^32 \+ 1/);
    expect(s).toMatch(/t = 3/);
    expect(s).toMatch(/x\^7/);
    expect(s).toMatch(/30 full rounds/);
    expect(s).toMatch(/let mut state = \[a, b, BaseElement::ZERO\];/);
    expect(s).toMatch(/permutation_t3\(&mut state\);/);
    expect(s).toMatch(/state\[0\]/);
  });

  it('gives the note commitment as the client builds it, three 2-to-1 hashes', () => {
    const s = sample();
    expect(s).toMatch(/createCommitmentV3/);
    expect(s).toMatch(/nullifier\s+= hash2\(nullifier_preimage, secret\)/);
    expect(s).toMatch(/epoch_hash\s+= hash2\(deposit_epoch, token_mint\)/);
    expect(s).toMatch(/commitment\s+= hash2\(nullifier, epoch_hash\)/);
    expect(s).toMatch(/64-bit digest/);
  });

  it('shows nothing retired as current: no Circom template, no Poseidon(4), no BN254', () => {
    const s = sample();
    expect(s).not.toMatch(/template Commitment/);
    expect(s).not.toMatch(/signal (input|output)/);
    expect(s).not.toMatch(/Poseidon\(4\)/);
    expect(s).not.toMatch(/BN254/);
    expect(s).not.toMatch(/ownerPubkey|amount;/);
    // The t = 5 permutation is named only as unused and not MDS (F53).
    if (/t = 5/.test(s)) expect(s).toMatch(/t = 5[^\n]*unused[^\n]*not MDS|not MDS[^\n]*t = 5/);
  });
});

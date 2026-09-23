/**
 * Public claims the internal v1 audit (round 1, axis 8) found contradicted by
 * the code, the security-levels calculator or the repository's own records.
 * Each case reads the English dictionary the site renders and asserts on the
 * specific false sentence, so it cannot quietly come back.
 *
 * Where a fact can be read from the repository instead of copied, it is: the
 * shipped prover blob is hashed here, and the verifier's deployment slot is
 * read from `packages/stark-prover/deployed-verifier.json`, so the /docs line
 * about them goes red the day either moves without the copy.
 *
 * Scope: `en` only. `fr` carries the same keys (i18n-parity.test.ts) and the
 * same stale sentences; it is owned by another lane of this audit round.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import en from '@/i18n/en';

const REPO = path.resolve(__dirname, '../../../..');
const docs = en.docs;
const s = docs.sections;

describe('double spending: the v1 digest is one 64-bit element (SECURITY-LEVELS.md, finding F2)', () => {
  it('the guarantees card does not promise nullifiers unique per commitment', () => {
    expect(docs.guaranteeNoDouble).not.toMatch(/unique per commitment/i);
    // The limit has to be stated, not just the promise removed.
    expect(docs.guaranteeNoDouble).toMatch(/64-bit/);
    expect(docs.guaranteeNoDouble).toMatch(/F2/);
  });

  it('the nullifier section does not say each note has exactly one valid nullifier', () => {
    expect(s.nullifiers.desc).not.toMatch(/exactly one valid nullifier/i);
    expect(s.nullifiers.desc).toMatch(/64-bit/);
  });

  it('the pool section does not present the nullifier PDA as double-spend prevention without the limit', () => {
    expect(s.denominatedPools.detail3).toMatch(/F2|64-bit/);
  });
});

describe('quantum: digest size is the weak line in v1, not the mitigation', () => {
  it('zkProofs.detail7 no longer says Grover is mitigated by digest size', () => {
    expect(s.zkProofs.detail7).not.toMatch(/mitigated by digest size/i);
    expect(s.zkProofs.detail7).toMatch(/21\.33/);
  });

  it('poseidonHash.detail5 states the one-element output and its collision bounds', () => {
    expect(s.poseidonHash.detail5).toMatch(/64-bit|one Goldilocks element/i);
    expect(s.poseidonHash.detail5).toMatch(/32\.00/);
    expect(s.poseidonHash.detail5).toMatch(/21\.33/);
  });
});

describe('the prover blob and the verifier the /docs page names are the ones that ship', () => {
  const blob = readFileSync(path.join(REPO, 'packages/stark-prover/wasm/p01_stark_bg.wasm'));
  const digest = createHash('sha256').update(blob).digest('hex');
  const record = JSON.parse(
    readFileSync(path.join(REPO, 'packages/stark-prover/deployed-verifier.json'), 'utf8'),
  ) as { deployed: { last_deployed_slot: number; accepts_client_blob_sha256: string } };

  it('the blob this line names is the shipped one, and the one the verifier accepts', () => {
    expect(record.deployed.accepts_client_blob_sha256).toBe(digest);
    expect(s.zkProofs.detail5).toContain(digest.slice(0, 8));
    expect(s.zkProofs.detail5).toContain(blob.length.toLocaleString('en-US'));
    expect(s.zkProofs.detail5).not.toMatch(/36c1fd4e|274,224/);
  });

  it('the verifier line names the current deployment slot, not a superseded one', () => {
    expect(s.zkProofs.detail4).toContain(record.deployed.last_deployed_slot.toLocaleString('en-US'));
    expect(s.zkProofs.detail4).not.toMatch(/491,973,056/);
  });

  it('the proof-parameter line matches the verifier: 27 queries on C1 and C2 only, 22 bits of grinding', () => {
    expect(s.zkProofs.detail3).not.toMatch(/16 bits of grinding/);
    expect(s.zkProofs.detail3).toMatch(/22 bits of grinding/);
    expect(s.zkProofs.detail3).not.toMatch(/27 on the other four/);
  });
});

describe('note maturity: no path enforces a note-age delay', () => {
  it('denominatedPools.detail4 does not say transfer, split and subscribe enforce it', () => {
    expect(s.denominatedPools.detail4).not.toMatch(/all enforce it/i);
    expect(s.denominatedPools.detail4).toMatch(/subscribe v4/i);
    expect(s.denominatedPools.detail4).toMatch(/caller/i);
  });
});

describe('/docs does not present removed or superseded parts as current', () => {
  it('no ~3 s shield/unshield figure; the measured times are quoted', () => {
    expect(s.shieldedPool.detail6).not.toMatch(/~3s|Instant/);
    expect(s.shieldedPool.detail6).toMatch(/18\.6 s/);
    expect(s.shieldedPool.detail6).toMatch(/20\.8 s/);
  });

  it('the relayer is not presented as a path transfers can take today', () => {
    expect(s.shieldedPool.desc).not.toMatch(/^Private transfers can go through the relayer/);
    expect(s.shieldedPool.desc).toMatch(/no relayer node/i);
  });

  it('the AI agent is presented as removed', () => {
    expect(s.aiAgent.title).toMatch(/removed/i);
    expect(s.aiAgent.desc).toMatch(/removed on 2026-09-13/i);
  });

  it('no Circom circuit is named as current', () => {
    expect(s.noteSplitting.detail2).not.toMatch(/^Circuit: note_split\.circom/);
  });

  it('the migration history names what the verifier runs: SHA-256 + Poseidon, 8 AIRs', () => {
    expect(s.migrationHistory.detail3).not.toMatch(/Blake3 \+ Poseidon/);
    expect(s.migrationHistory.detail4).not.toMatch(/\b7 AIRs\b/);
    expect(s.migrationHistory.detail4).toMatch(/\b8 AIRs\b/);
    expect(s.migrationHistory.detail1).not.toMatch(/all 7 circuits/);
  });

  it('the masking statement does not say only the spend circuit is masked', () => {
    expect(s.zkProofs.desc).not.toMatch(/unlike the other seven/);
    expect(s.zkProofs.desc).toMatch(/all eight circuits/i);
  });
});

describe('custody: the landing tagline and the contribution card say who can spend an issued note', () => {
  it('the hero line does not claim self-custody unqualified', () => {
    // Rendered on the landing page by app/_home/HomeSimple.tsx.
    expect(en.hero.desc4).not.toMatch(/^Self-custody\./);
    expect(en.hero.desc4).toMatch(/can spend/i);
  });

  it('the contribution card states the deployment can spend the note it handed over', () => {
    // PoolPanel renders this under a contribution; the server's own disclosure
    // is not rendered on that path, so the dictionary line has to carry it.
    expect(en.pay.pool.contributedNote).toMatch(/can spend it/i);
  });
});

// ---------------------------------------------------------------------------
// close-v1, lane L4 (findings F21, F46, F53). Red on the tree the audit left.
// ---------------------------------------------------------------------------

describe('F21: detail10 states the FRI rate the verifier enforces, not a "measured lower" rate', () => {
  it('no longer says the achieved rate was measured lower than the configured one', () => {
    // The verifier enforces rate 1/16 on every v1 circuit
    // (fri_final_poly_degree_bound / fri_final_poly_size in compact_proof.rs;
    // SECURITY-LEVELS.md assumption A4). "Measured lower" (read as 1/2) was false.
    expect(s.zkProofs.detail10).not.toMatch(/measured lower|measured 1\/2/i);
    expect(s.zkProofs.detail10).toMatch(/1\/16/);
    expect(s.zkProofs.detail10).toMatch(/22 bits of grinding/);
    expect(s.zkProofs.detail10).toMatch(/22 (FRI )?queries/);
    expect(s.zkProofs.detail10).toMatch(/27/);
  });

  it('points at the file that carries the regime of every figure, and still quotes no bit count of its own', () => {
    expect(s.zkProofs.detail10).toMatch(/docs\/SECURITY-LEVELS\.md/);
    expect(s.zkProofs.detail10).not.toMatch(/\b(1[0-9]{2}|[4-9][0-9])-bit|\b(1[0-9]{2}|[4-9][0-9]) bits of (security|soundness)/);
  });
});

describe('F46: zkSPL copy does not announce a threshold or a conservation law the code does not enforce', () => {
  // programs/p01_zkspl/src/instructions/prove_balance.rs: "(balance >= threshold)
  // is NOT enforced by the AIR"; withdraw.rs binds amount_hash = Poseidon(0, 0),
  // so the new commitment is not tied to the public amount withdrawn.
  const lines: Array<[string, string]> = [
    ['docs.sections.zkspl.desc', s.zkspl.desc],
    ['docs.sections.zkspl.detail4', s.zkspl.detail4],
    ['docs.sections.zkspl.detail5', s.zkspl.detail5],
    ['roadmap.items.confidentialBalances.desc', en.roadmap.items.confidentialBalances.desc],
  ];

  it('the balance-proof line does not say it proves balance >= threshold', () => {
    expect(s.zkspl.detail5).not.toMatch(/^Balance proof: proves balance >= threshold/);
    expect(s.zkspl.detail5).toMatch(/not enforced|does not enforce/i);
  });

  it('the conservation line does not state it as a law the program keeps', () => {
    expect(s.zkspl.detail4).not.toMatch(/^Conservation law: old_balance \+ credits === new_balance \+ debits$/);
    expect(s.zkspl.detail4).toMatch(/not enforced|does not enforce|any amount/i);
  });

  for (const [key, text] of lines) {
    it(`${key} says the program is not deployed`, () => {
      expect(text, key).toMatch(/not deployed/);
    });
  }

  it('the roadmap card does not sell "privacy with balance proofs" as a property', () => {
    expect(en.roadmap.items.confidentialBalances.desc).not.toMatch(/Quantum-resistant privacy with balance proofs/);
  });
});

describe('F53: the Poseidon width /docs announces is the one the live paths use', () => {
  it('names t=3 and does not present t=5 as a width with an MDS matrix in use', () => {
    // stark/src/poseidon/constants.rs: the t=5 matrix is not MDS, and no live
    // path (circuits, verifier, web client) uses width 5.
    expect(s.poseidonHash.detail3).toMatch(/t=3/);
    expect(s.poseidonHash.detail3).not.toMatch(/t=3 and t=5 widths, circulant MDS matrix/);
    if (/t=5/.test(s.poseidonHash.detail3)) {
      expect(s.poseidonHash.detail3).toMatch(/t=5[^.]*(unused|not used|not MDS)/);
    }
  });
});

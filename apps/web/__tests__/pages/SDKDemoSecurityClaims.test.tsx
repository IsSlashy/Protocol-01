import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SDKDemoPage from '@/app/sdk-demo/page';

// Audit round 3, lane 3. The Stream SDK tab of /sdk-demo closes on a panel,
// "What the program does and does not allow", that promised two things the
// deployed zk_shielded program does not deliver:
//
//   - "Nobody can modify without your permission" (sdkDemo.noModifyWithoutPermission)
//   - "Pause or end your subscription without you", listed under
//     "What developers CANNOT do" (sdkDemo.cancelWithoutYou)
//
// pause_private_stark and resume_private_stark accept any payer. Their only
// binding is a verified C0 buffer whose public-input hash is
// sha256(commitment), and the C0 proof is bound to [commitment] alone, so a
// published pause or resume proof can be replayed under any key (litesvm:
// programs/zk_shielded/tests/c0_replay.rs,
// finding_a_replayed_c0_proof_pauses_and_resumes_a_vault_under_an_unrelated_key).
// On top of that, one CLI key with no multisig can upgrade the program
// (docs/zk-simulation-argument.md). The code samples on the same tab said the
// same thing in comments ("Only the SUBSCRIBER can pause and resume",
// "Developer CANNOT pause, resume or modify!"). This suite pins that none of
// those guarantees is printed any more.

describe('SDKDemoPage -- Stream SDK tab makes no pause/modify guarantee the program breaks', () => {
  beforeEach(async () => {
    delete (window as unknown as Record<string, unknown>).protocol01;
    render(<SDKDemoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Stream SDK' }));
    // The panel under test is on this tab; make sure we are on it.
    expect(screen.getByText('What the program does and does not allow')).toBeInTheDocument();
  });

  it('does not promise that nobody can modify a subscription without the subscriber', () => {
    expect(screen.queryByText('Nobody can modify without your permission')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/nobody can modify/i);
  });

  it('does not list pausing a subscription without the subscriber as something developers cannot do', () => {
    expect(screen.queryByText('Pause or end your subscription without you')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/pause or end your subscription without you/i);
  });

  it('code samples do not claim that only the subscriber can pause or resume', () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/only the subscriber can pause/i);
    expect(text).not.toMatch(/developer cannot pause/i);
    expect(text).not.toMatch(/subscriber's wallet only/i);
  });

  it('still shows the parts of the panel that stay true', () => {
    // Not a weakening: the panel and its disclaimer must survive the fix.
    expect(screen.getByText('What YOU can do')).toBeInTheDocument();
    expect(screen.getByText('What developers CANNOT do')).toBeInTheDocument();
    expect(screen.getByText('Raise your price after you subscribe')).toBeInTheDocument();
  });
});

// close-v1, lane L4, finding F68. The Privacy SDKs tab showed privacy-toolkit
// with `poseidonHash`, `MerkleTree` and `WOTSKeypair`, none of which the
// package exports, under a caption of "Poseidon hashing, Merkle trees, WOTS+
// signatures, encrypted note storage". The package is BN254 Poseidon
// (poseidon-lite) from the earlier Groth16 design; the Styx pool, its STARK
// circuits and the verifier use Poseidon over Goldilocks, and a value built
// with the toolkit is not accepted there (packages/privacy-toolkit/README.md).
describe('SDKDemoPage -- Privacy SDKs tab does not present privacy-toolkit as the pool hash', () => {
  beforeEach(async () => {
    delete (window as unknown as Record<string, unknown>).protocol01;
    render(<SDKDemoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Privacy SDKs' }));
  });

  it('the snippet imports only what the package exports', () => {
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/@protocol-01\/privacy-toolkit/);
    expect(text).not.toMatch(/WOTSKeypair|poseidonHash, MerkleTree/);
  });

  it('the caption and the snippet say BN254 and that it is not the pool hash', () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/WOTS\+ signatures, encrypted note storage/);
    expect(text).toMatch(/BN254/);
    expect(text).toMatch(/not the (Styx )?pool/i);
  });
});

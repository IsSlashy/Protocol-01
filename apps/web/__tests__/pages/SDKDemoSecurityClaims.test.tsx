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

// close-v1, lane L4, finding F68, then 2026-09-23. The Privacy SDKs tab showed
// privacy-toolkit (BN254 Poseidon from the earlier Groth16 design, not the pool
// hash), zk-sdk and zkspl-sdk. Their source was deleted on 2026-09-23, so the
// tab no longer lists them, shows their snippets or tells anyone to install them.
describe('SDKDemoPage -- Privacy SDKs tab lists no package whose source was deleted', () => {
  beforeEach(async () => {
    delete (window as unknown as Record<string, unknown>).protocol01;
    render(<SDKDemoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Privacy SDKs' }));
  });

  it('names none of zk-sdk, zkspl-sdk or privacy-toolkit', () => {
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/@protocol-01\/specter-sdk/);
    expect(text).not.toMatch(/@protocol-01\/(zk-sdk|zkspl-sdk|privacy-toolkit)/);
    expect(text).not.toMatch(/WOTSKeypair|poseidonHash, MerkleTree/);
  });
});

/**
 * What a BUYER is told when the issuer hands nothing over.
 *
 * Runs under `vitest.pool.config.mts` (node), whose glob is `lib/**\/*.test.ts`.
 *
 * 🚨 GATE r1, RED 7e. Every exhaustion of `/api/issue-note` now answers a buyer
 * the SAME sentence, whatever the inventory is doing — that is the fix for
 * confirmed item 30, and it is right: a claim code that comes back could
 * otherwise be re-polled into a reading of the deployment's inventory.
 *
 * But it costs the buyer the reason. Where they used to see "every note in
 * stock is already issued" they now see one flat line, and they have ALREADY
 * PAID. So the route sends the guidance separately, in `hint`: the claim code
 * was not used up, the same code still works, and there is a limit on how often
 * to ask. This client read `body.error` and nothing else, so that guidance
 * reached nobody — the fix was written and delivered to no one.
 *
 * What is pinned here: the hint reaches the person, and the refusal still says
 * what went wrong. Nothing about which exhaustion it was, because the route is
 * what decides that and `issue-note.node.test.ts` proves it does not move.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/** The worker answers the one request this path makes before the fetch. */
vi.mock('./workerClient', () => ({
  poolRequest: async (req: { kind: string }) => {
    if (req.kind === 'poolIssueAddress') return { kind: req.kind, address: 'p01pq:FAKEADDRESS' };
    throw new Error(`unexpected worker request: ${req.kind}`);
  },
}));

const { requestIssuedNote } = await import('./shieldClient');

const CLAIM = 'CODE-ONE-AAAAAAAA';

/** The refusal the route really sends: one flat sentence, plus the guidance. */
const EXHAUSTED_ERROR = 'no note could be handed over for this claim';
const HINT =
  'Your claim code was NOT used up: it is still worth a note and the same code succeeds once ' +
  'the deployment has one to give. Leave a few minutes between attempts — this deployment ' +
  'limits how often one network may ask.';

function answerWith(status: number, body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function refusalText(): Promise<string> {
  try {
    await requestIssuedNote({
      meta: 'meta-test',
      walletPubkey: 'Wallet1111111111111111111111111111111111111',
      token: 'SOL',
      denomination: 1,
      claimCode: CLAIM,
    });
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('the issuer refusal did not reach the caller at all');
}

describe('the buyer is told what to do next, not only that it failed', () => {
  it('carries the hint through to the person who paid', async () => {
    answerWith(503, { ok: false, error: EXHAUSTED_ERROR, hint: HINT });

    const message = await refusalText();

    // Positive control: the reason is still there, so the hint is an addition
    // and not a replacement.
    expect(message, 'the reason went missing').toContain(EXHAUSTED_ERROR);
    expect(message, 'the guidance the buyer needs never reached them').toContain(
      'still worth a note',
    );
    expect(message, 'the limit that decides the retry never reached them').toContain(
      'limits how often one network may ask',
    );
  });

  it('says only the reason when the route sends no hint', async () => {
    // Every other refusal on this route — a bad ticket, a wrong denomination —
    // carries no hint, and must not grow a dangling one.
    answerWith(400, { ok: false, error: 'this deployment issues 1 SOL notes' });
    const message = await refusalText();
    expect(message).toContain('this deployment issues 1 SOL notes');
    expect(message.trim().endsWith('this deployment issues 1 SOL notes')).toBe(true);
  });

  it('still says something when the route sends neither', async () => {
    answerWith(502, { ok: false });
    expect(await refusalText()).toMatch(/502/);
  });
});

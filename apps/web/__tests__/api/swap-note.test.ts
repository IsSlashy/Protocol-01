/**
 * `/api/swap-note` is RETIRED, and this suite exists to keep it that way.
 *
 * The route used to queue a note handed in, for a conversion worker that never
 * existed, and mint a ticket that nothing ever filled. Its replacement is the
 * note-in exchange: the holder withdraws the note to the till by circuit 7,
 * claims the payment at `/api/claim-for-payment` (kind `pool-withdrawal`) and
 * redeems at `/api/issue-note`. No opening is ever sent to a server.
 *
 * Two things are pinned. Both methods answer 410 and name the replacement, so
 * an old client learns where to go rather than reading a silent 404. And the
 * queue keys the old route wrote (`p01:note:pending*`, `p01:note:swap:*`)
 * appear NOWHERE under `apps/web/app`: a key with a writer and no reader is
 * note material at rest that nothing will ever drain.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GET, POST } from '@/app/api/swap-note/route';

const RETIRED_KEYS = ['p01:note:pending', 'p01:note:swap'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('swap-note answers 410 on every method', () => {
  it('GET is gone and names the replacement', async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(410);
    expect(body.ok).toBe(false);
    expect(body.replacement).toBe('/api/claim-for-payment (pool-withdrawal) then /api/issue-note');
  });

  it('POST is gone and names the replacement, whatever it is sent', async () => {
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(410);
    expect(body.ok).toBe(false);
    expect(body.replacement).toMatch(/claim-for-payment/);
    // Nothing about a ticket, a queue or a note comes back.
    expect(body.ticket).toBeUndefined();
    expect(body.status).toBeUndefined();
    expect(body.sealedNote).toBeUndefined();
  });
});

describe('the retired queue keys have no writer and no reader left', () => {
  const appDir = join(__dirname, '../../app');
  const files = sourceFiles(appDir);

  it('scans something, or the assertion below is vacuous', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.replace(/\\/g, '/').endsWith('app/api/swap-note/route.ts'))).toBe(true);
  });

  for (const key of RETIRED_KEYS) {
    it(`"${key}" appears nowhere under apps/web/app`, () => {
      const offenders = files.filter((f) => readFileSync(f, 'utf8').includes(key));
      expect(offenders, `retired key "${key}" is still referenced`).toEqual([]);
    });
  }
});

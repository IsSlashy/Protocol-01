/**
 * The queue keys of the retired `/api/swap-note` route stay dead.
 *
 * That route used to queue a note handed in, for a conversion worker that
 * never existed, and mint a ticket that nothing ever filled. It answered 410
 * from 2026-09-02 and was deleted outright on 2026-09-23. Its replacement is
 * the note-in exchange: the holder withdraws the note to the till by circuit
 * 7, claims the payment at `/api/claim-for-payment` (kind `pool-withdrawal`)
 * and redeems at `/api/issue-note`. No opening is ever sent to a server.
 *
 * Moved here from the route's own suite when the route was deleted, because
 * this half guards the rest of the app, not the route: the queue keys the old
 * route wrote (`p01:note:pending*`, `p01:note:swap:*`) must appear NOWHERE
 * under `apps/web/app`. A key with a writer and no reader is note material at
 * rest that nothing will ever drain.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

describe('the retired swap-note queue keys have no writer and no reader left', () => {
  const appDir = join(__dirname, '../../app');
  const files = sourceFiles(appDir);

  it('scans the API routes, or the assertion below is vacuous', () => {
    expect(files.length).toBeGreaterThan(10);
    // The two routes that replaced swap-note are in the scanned set.
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm.some((f) => f.endsWith('app/api/claim-for-payment/route.ts'))).toBe(true);
    expect(norm.some((f) => f.endsWith('app/api/issue-note/route.ts'))).toBe(true);
  });

  it('the retired route itself is gone', () => {
    expect(existsSync(join(appDir, 'api/swap-note/route.ts'))).toBe(false);
  });

  for (const key of RETIRED_KEYS) {
    it(`"${key}" appears nowhere under apps/web/app`, () => {
      const offenders = files.filter((f) => readFileSync(f, 'utf8').includes(key));
      expect(offenders, `retired key "${key}" is still referenced`).toEqual([]);
    });
  }
});

/**
 * CAN THE NOTE INVENTORY GROW WITHOUT A HUMAN? — measured as text, not behaviour.
 *
 * BE HONEST ABOUT WHAT THIS IS: it reads one file. It cannot prove a leaf added
 * to KV is issued; the swap endpoint that writes one will prove that end to end
 * when it exists. What this pins is the SHAPE, and the shape is what regressed
 * for months.
 *
 * 🚨 THE FACT IT PINS. The inventory was a synchronous read of one environment
 * variable, `P01_TREASURY_NOTE_LEAVES`. A route cannot write its own env, so an
 * incoming note had nowhere to be recorded, and the documented procedure was a
 * human copying leaf indices into TWO places — a Vercel variable and a GitHub
 * secret — and redeploying. Until a leaf could enter that list without a person,
 * "the stock refills itself" was false BY CONSTRUCTION, and so was any exchange
 * that takes one note in and hands another out.
 *
 * ⛔ ADDITIVE, NEVER AUTHORITATIVE, and this file asserts that too. The seeded
 * list still decides the starting stock; an empty KV must change nothing. This
 * is the money path, and a new store must not be able to make notes appear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '../..');
const ROUTE = 'app/api/issue-note/route.ts';

function codeOf(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the note inventory can grow at runtime', () => {
  const code = codeOf(ROUTE);

  it('still reads the configured leaves, and under an honest name', () => {
    // Anti-vacuity. If the seeded reader vanished, every assertion below could
    // pass while the route served nothing at all.
    expect(code, 'the configured-leaf reader is gone').toMatch(
      /function\s+seededInventoryLeaves\s*\(\s*\)/,
    );
    expect(code, 'it stopped reading P01_TREASURY_NOTE_LEAVES').toContain(
      'P01_TREASURY_NOTE_LEAVES',
    );
  });

  it('unions the configured leaves with a set this process can write', () => {
    expect(code, 'the acquired-leaf reader is gone').toMatch(
      /async\s+function\s+acquiredInventoryLeaves\s*\(/,
    );
    expect(code, 'the union is gone — the inventory is env-only again').toMatch(
      /function\s+inventoryLeaves\s*\([\s\S]{0,80}?\)[\s\S]{0,400}?seededInventoryLeaves\s*\(\s*\)/,
    );
    expect(code, 'the union no longer reads the acquired set').toMatch(
      /inventoryLeaves[\s\S]{0,400}?acquiredInventoryLeaves\s*\(/,
    );
  });

  it('has a writer, and it goes through the KV set', () => {
    expect(code, 'nothing can record an acquired leaf').toMatch(
      /export\s+async\s+function\s+recordInventoryLeaf\s*\(/,
    );
    expect(code, 'the writer no longer writes to the KV set').toMatch(/\.sadd\s*\(/);
    expect(code, 'the reader no longer reads the KV set').toMatch(/\.smembers\s*\(/);
  });

  it('keeps the configured list authoritative for readiness', () => {
    // The GET is a CONFIGURATION question: a deployment with an empty seeded
    // list has nothing to start from, whatever it may take in later. If this
    // ever starts scoping the readiness check to a pool, the check stops
    // answering the question it exists to answer.
    expect(code, 'the readiness check now depends on runtime state').toMatch(
      /const\s+leaves\s*=\s*await\s+inventoryLeaves\s*\(\s*\)/,
    );
  });

  it('scopes the acquired set to a pool, because leaf indices are per-pool', () => {
    // The second argument is the CHAIN-DISCOVERED set: the treasury asks the
    // tree which leaves its own seed can open, because a hand-maintained list
    // drifts. Measured 2026-08-31: it owned six leaves and named one.
    expect(code, 'the issuance path no longer scopes the inventory to its pool').toMatch(
      /await\s+inventoryLeaves\s*\(\s*pool\.poolPDA\.toBase58\(\)\s*,\s*discovered\s*\)/,
    );
    expect(code, 'the treasury no longer discovers what it owns').toMatch(
      /function\s+discoverOwnedLeaves\s*\(/,
    );
    expect(code, 'the KV key is no longer pool-scoped').toMatch(
      /KV_INVENTORY_PREFIX\s*\+\s*poolKey/,
    );
  });
});

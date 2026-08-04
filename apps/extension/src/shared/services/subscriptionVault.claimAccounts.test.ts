import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `__dirname` is not guaranteed under vitest's ESM transform; derive it.
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * B1 REGRESSION GUARD — the claim instruction's account list.
 *
 * This app shipped a `buildClaimPeriodIx` that emitted 3 accounts while
 * `ClaimPeriod<'info>` declared 6, so every claim it produced died with
 * AccountNotEnoughKeys (3005) inside Anchor's resolver, before the handler ran.
 * MEASURED against the deployed program on devnet 2026-08-04: the 3-account form
 * returns 3005 ("caused by account: token_program", 3,635 CU) and the 6-account
 * form reaches the handler (7,343 CU, settles). Mirrors the mobile guard.
 *
 * The suite was 143/143 green throughout, because nothing here executes an
 * instruction builder. This test exists so the defect cannot come back quietly.
 *
 * It deliberately does NOT pin the literal 6. It counts the accounts declared by
 * the Rust struct and requires the TypeScript builder to match, so the two move
 * together or the test says which one moved. Adding a 7th account to
 * `ClaimPeriod` turns this red on purpose — that is the point.
 */

function repoRoot(): string {
  let d = HERE;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
    d = path.dirname(d);
  }
  throw new Error('could not locate the repo root (no pnpm-workspace.yaml walking up)');
}

const ROOT = repoRoot();
const RUST = path.join(ROOT, 'programs/zk_shielded/src/instructions/claim_period.rs');
const BUILDER = path.join(HERE, 'subscriptionVault.ts');

/** Accounts declared by `#[derive(Accounts)] pub struct ClaimPeriod<'info>`. */
function declaredAccounts(): string[] {
  const src = fs.readFileSync(RUST, 'utf8');
  const at = src.indexOf("pub struct ClaimPeriod<'info>");
  expect(at, `ClaimPeriod<'info> not found in ${RUST} — the gate is broken, not the builder`).toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf('\n}', at));
  return [...body.matchAll(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

/** Accounts emitted by this app's `buildClaimPeriodIx`. */
function emittedKeys(): string[] {
  const src = fs.readFileSync(BUILDER, 'utf8');
  const at = src.indexOf('function buildClaimPeriodIx');
  expect(at, 'buildClaimPeriodIx not found — the gate is broken, not the builder').toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf('\n}', at));
  const from = body.indexOf('const keys = [');
  const keys = body.slice(from, body.indexOf('];', from));
  return [...keys.matchAll(/\{\s*pubkey:\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
}

describe('claim_period: the account list the app emits matches the one the program declares', () => {
  it('emits exactly as many accounts as the ClaimPeriod struct declares', () => {
    const declared = declaredAccounts();
    const emitted = emittedKeys();
    expect(
      emitted.length,
      `claim_period account-count drift.\n` +
        `  program declares ${declared.length}: ${declared.join(', ')}\n` +
        `  this app emits   ${emitted.length}: ${emitted.join(', ')}\n` +
        `Anchor 0.32 rejects a short account list with AccountNotEnoughKeys (3005) BEFORE the\n` +
        `handler runs, so the failure names neither the vault nor the money. If the program grew\n` +
        `an account, add it here; an absent Option<..> is passed as the program's own id.`,
    ).toBe(declared.length);
  });

  it('passes the program id as the sentinel for every trailing Option account', () => {
    const declared = declaredAccounts();
    const emitted = emittedKeys();
    // The optional accounts are the trailing ones; the program's own id is how
    // Anchor 0.32 expresses `None` without the allow-missing-optionals feature.
    const optionalCount = (fs.readFileSync(RUST, 'utf8').match(/pub\s+[a-z_]+\s*:\s*Option</g) ?? []).length;
    expect(optionalCount, 'expected claim_period to declare optional accounts').toBeGreaterThan(0);
    // Slice from the END of what is actually emitted, and require a FULL slice.
    // Slicing at `declared.length - optionalCount` against a short builder yields
    // an empty array, and `[].every(...)` is vacuously true: this assertion sailed
    // through green when the 3-account defect was reintroduced to mutation-test it.
    // An empty trailing slice must fail, not pass.
    const trailing = emitted.slice(-optionalCount);
    expect(
      trailing.length,
      `expected ${optionalCount} trailing Option accounts, the builder emits ${emitted.length} in total`,
    ).toBe(optionalCount);
    expect(
      trailing.every((k) => k === 'ZK_SHIELDED_PROGRAM_ID'),
      `the ${optionalCount} trailing Option accounts must be the ZK_SHIELDED_PROGRAM_ID sentinel, got: ${trailing.join(', ')}`,
    ).toBe(true);
  });

  it('sends no instruction arguments — the program derives the amount from the clock', () => {
    // claim_period.rs:51 `pub fn handler(ctx: Context<ClaimPeriod>)` takes no args,
    // so the payout is not caller-controlled. A builder that started appending
    // data would be describing an instruction the program does not have.
    const src = fs.readFileSync(BUILDER, 'utf8');
    const at = src.indexOf('function buildClaimPeriodIx');
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).toContain('Buffer.alloc(8)');
    expect(body).not.toMatch(/data\.write|writeBigUInt64|Buffer\.concat/);
  });
});

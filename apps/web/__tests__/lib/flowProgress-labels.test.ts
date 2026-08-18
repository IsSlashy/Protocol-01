import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHIELD_PHASES,
  WITHDRAW_PHASES,
  SUBSCRIBE_PHASES,
  SEAL_PHASES,
  RECEIVE_NOTE_PHASES,
  progressFor,
} from '@/lib/pay/flowProgress';

/**
 * The progress bar is wired across a seam nobody looks at twice.
 *
 * lib/privacy/pool/stark.ts emits free-text steps through onProgress. lib/pay/
 * flowProgress.ts maps them to phases with regexes. Nothing connects the two:
 * add a step on one side and the other silently stops recognising it, because
 * mapStep returns { index: -1, current: null } for an unknown string and the
 * bar just sits at its floor.
 *
 * That is exactly what happened when per-chunk resume shipped. Four of its new
 * steps -- the resend round, the lost-chunk notice, the readback and the repair
 * -- matched no phase, so during a resume the interface would have gone quiet
 * and shown nothing for the 90 to 360 seconds the repair takes. The single
 * moment the user most needs to be told something is happening.
 *
 * So this test reads the labels out of stark.ts itself rather than restating
 * them. A label added there without a phase to receive it fails here.
 */

const STARK_SRC = readFileSync(join(__dirname, '../../lib/privacy/pool/stark.ts'), 'utf8');

/** Every onProgress?.('...') and onProgress?.(`...`) argument in stark.ts. */
function emittedSteps(): string[] {
  const out: string[] = [];
  for (const m of STARK_SRC.matchAll(/onProgress\?\.\(\s*(['"`])([\s\S]*?)\1\s*\)/g)) {
    // Template placeholders become a plausible value: the phase regexes must
    // match on the words, never on the numbers.
    out.push(m[2]!.replace(/\$\{[^}]*\}/g, '7'));
  }
  return out;
}

/**
 * The resend label is built from a variable, so the literal above only yields
 * "7 7/7...". These are the two values that variable takes, spelled out.
 */
const COMPOSED_LABELS = ['Uploading proof chunk 5/148...', 'Resending chunk (round 1/3) 5/12...'];

const FLOWS = [
  { name: 'shield', phases: SHIELD_PHASES },
  { name: 'withdraw', phases: WITHDRAW_PHASES },
  { name: 'subscribe', phases: SUBSCRIBE_PHASES },
];

describe('flowProgress recognises every step stark.ts actually emits', () => {
  const steps = [...emittedSteps(), ...COMPOSED_LABELS].filter(
    // Purely composed steps carry no words to match on; the two spellings above
    // stand in for them.
    (s) => s.trim() !== '7 7/7...',
  );

  it('finds steps to check at all, so an empty sweep cannot pass silently', () => {
    expect(steps.length).toBeGreaterThan(8);
  });

  for (const { name, phases } of FLOWS) {
    for (const step of steps) {
      it(`${name}: "${step.slice(0, 52)}" lands in a phase`, () => {
        const state = progressFor(phases, step);
        expect(state.current, `no phase matches "${step}" in the ${name} flow`).not.toBeNull();
        expect(state.index).toBeGreaterThanOrEqual(0);
      });
    }
  }
});

describe('the resume steps specifically, since they are why this file exists', () => {
  const RESUME_STEPS = [
    'Resending chunk (round 1/3) 3/12...',
    '4 chunk(s) lost, resending with a fresh blockhash...',
    'Checking uploaded proof against the local bytes...',
    'Readback found 2 torn chunk(s), repairing...',
  ];

  for (const step of RESUME_STEPS) {
    it(`"${step.slice(0, 46)}" reports the upload phase`, () => {
      const state = progressFor(WITHDRAW_PHASES, step);
      expect(state.current?.id).toBe('upload');
    });
  }

  // Control on the control. If the phase regexes were widened into something
  // that matches anything, every assertion above would pass and prove nothing.
  it('still refuses a step that belongs to no phase', () => {
    const state = progressFor(WITHDRAW_PHASES, 'Reticulating splines...');
    expect(state.current).toBeNull();
    expect(state.index).toBe(-1);
  });
});

/**
 * The same seam, on the OTHER file that talks to the bar.
 *
 * The sweep above reads `stark.ts` only, and every step on the subscribe path
 * before a proof exists is emitted from `poolHandlers.ts` — locating the note,
 * rebuilding its history, resolving the deposit, computing the commitment. So
 * the file whose sentences most often reach a waiting user was the one file not
 * checked, and it showed: `still looking` and `checking notes you already hold`
 * both shipped without a phase, and a run that was working fine sat on
 * "Starting · 5%" for minutes because an unmatched sentence leaves the previous
 * label standing — and before any phase matches, the previous label is nothing.
 *
 * A step here may belong to any flow (shield, withdraw, subscribe, seal,
 * receive), so the assertion is the honest one: SOME table must recognise it.
 * A sentence no table knows is a sentence the user will never see.
 */
const HANDLERS_SRC = readFileSync(
  join(__dirname, '../../lib/privacy/worker/poolHandlers.ts'),
  'utf8',
);

const ALL_TABLES = [
  SHIELD_PHASES,
  WITHDRAW_PHASES,
  SUBSCRIBE_PHASES,
  SEAL_PHASES,
  RECEIVE_NOTE_PHASES,
];

describe('flowProgress recognises the steps poolHandlers.ts emits', () => {
  const steps = [...HANDLERS_SRC.matchAll(/onProgress\?\.\(\s*(['"`])([\s\S]*?)\1\s*\)/g)]
    .map((m) => m[2]!.replace(/\$\{[^}]*\}/g, '7'))
    .filter((s) => /[a-z]{4}/i.test(s));

  it('finds steps to check at all, so an empty sweep cannot pass silently', () => {
    expect(steps.length).toBeGreaterThan(8);
  });

  for (const step of steps) {
    it(`"${step.slice(0, 52)}" lands in some flow`, () => {
      const matched = ALL_TABLES.some((t) => progressFor(t, step).index >= 0);
      expect(matched, `no phase table matches: ${step}`).toBe(true);
    });
  }
});

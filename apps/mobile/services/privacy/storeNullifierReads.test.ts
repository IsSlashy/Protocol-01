/**
 * The five call sites in `stores/denominatedPoolStore.ts` that used to name ONE
 * note's nullifier PDA to the RPC.
 *
 * BE HONEST ABOUT WHAT THIS IS: it reads the store as text, exactly like its
 * sibling `storeWiring.test.ts`, and for the same reason — the store cannot be
 * imported in this environment (its graph reached `services/zkspl/index.ts:81`,
 * which called `SystemProgram.programId.toBase58()` at module scope, and the
 * shared web3.js mock has no `programId`; services/zkspl was deleted on
 * 2026-09-23 and the import has not been re-measured since). A green here does not prove the
 * store behaves; `spentSet.test.ts` measures the behaviour of what these bodies
 * now call, and this file measures that they call it AND use its answer.
 *
 * WHAT THE CHANNEL WAS. A nullifier PDA does not exist until the note is spent.
 * Reading it before the spend hands the provider an address that will be
 * created later, from this phone's IP, with no spend following:
 *   - `findSafeShieldCounter` read [g16Pda, starkPda] per candidate counter,
 *     up to 1,024 pairs, before any money moved;
 *   - `refreshNoteStatuses` read two PDAs per held note on every mount of the
 *     notes screen, the unshield screen and the streams subscribe screen;
 *   - three spend pre-flights each read the PDA the spend was about to create.
 * The replacement asks one pool-wide question whose answer is the same for
 * every user (`services/privacy/spentSet.ts`).
 *
 * WHY EACH BODY IS HELD TO ONE EXACT DELEGATE CALL (fix round 1). The first
 * version only checked that a body mentioned `fetchPoolSpentSet(`. A store that
 * fetched the set inside a swallowing try, or fetched it and never used the
 * verdict, stayed green (wp-logs/verify/MOB-RPC-r1-mutants.log: counter_ignored
 * and ignored, 6/6). The composition now lives in tested functions
 * (`findFirstUnspentCounter`, `fetchSpentNoteIds`, `isNullifierSpentPoolWide`),
 * and this file pins the exact statement that consumes each answer. The last
 * test applies those verifier mutants to the REAL bodies and requires a finding
 * for each, so a green here can go red.
 *
 * The bodies are read with comments stripped, so the history above may stay
 * written in the store next to the fix without failing this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STORE_PATH = resolve(__dirname, '../../stores/denominatedPoolStore.ts');
const STORE = readFileSync(STORE_PATH, 'utf8');

/** Comments gone: a line recording what the code USED to do is not a match. */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const CODE = strip(STORE);

/**
 * Layout-free form of a code fragment, so a formatter reflowing arguments or
 * adding a trailing comma does not break a match. Idempotent.
 */
const norm = (src: string): string =>
  src
    .replace(/\s+/g, ' ')
    .replace(/([([{]) /g, '$1')
    .replace(/ ([)\]}])/g, '$1')
    .replace(/,([)\]}])/g, '$1')
    .trim();

/**
 * The reads that name ONE account. `getProgramAccounts` is deliberately absent:
 * it names a program and a filter, never a note.
 */
const POINTED_READ = /\bget(?:AccountInfo|MultipleAccountsInfo)\s*\(/;
/** Deriving the PDA at a call site is the same channel one step earlier. */
const PDA_DERIVATION = /\bderiveNullifierPDA\s*\(/;
/** A condition forced to one side, which keeps a call and discards its answer. */
const SHORT_CIRCUIT =
  /\bfalse\s*&&|&&\s*false\b|\btrue\s*\|\||\|\|\s*true\b|\bif\s*\(\s*(?:false|true|0|1)\s*\)/;

/** A console call that names a nullifier or a PDA. */
const NOISY_LOG = /console\.\w+\((?:[^()]|\([^()]*\))*\)/g;

/** The pure rules. A body that calls them has composed the answer by hand again. */
const HAND_COMPOSED = /\bfetchPoolSpentSet\(|\bfirstUnspentCounter\(|\bisNoteSpentInSet\(|\bisGoldilocksNullifierSpentInSet\(/;

interface Body {
  /** What this site is, in the report. */
  name: string;
  start: string;
  end: string;
  /** The tested function in services/privacy/spentSet.ts this body must call. */
  delegate: string;
}

/**
 * The five sites, each delimited by code markers (`async (` keeps the store's
 * interface declarations out of the match).
 */
const BODIES: readonly Body[] = [
  {
    name: 'findSafeShieldCounter',
    start: 'export async function findSafeShieldCounter(',
    end: 'import { scheduleLocalNotification }',
    delegate: 'findFirstUnspentCounter(',
  },
  {
    name: 'refreshNoteStatuses',
    start: 'refreshNoteStatuses: async () => {',
    end: 'lockNote: (noteId: string) => {',
    delegate: 'fetchSpentNoteIds(',
  },
  {
    name: 'unshieldNoteStark pre-flight',
    start: 'unshieldNoteStark: async (',
    end: 'unshieldNoteStarkV3: async (',
    delegate: 'isNullifierSpentPoolWide(',
  },
  {
    name: 'unshieldNoteStarkV3 pre-flight',
    start: 'unshieldNoteStarkV3: async (',
    end: 'prepareUnshieldNoteV4: async (',
    delegate: 'isNullifierSpentPoolWide(',
  },
  {
    name: 'unshieldNoteStarkV4 pre-flight',
    start: 'unshieldNoteStarkV4: async (',
    end: 'transferNoteStark: async (',
    delegate: 'isNullifierSpentPoolWide(',
  },
];

const [COUNTER, REFRESH, ...PREFLIGHTS] = BODIES;

function bodyOf(code: string, b: Pick<Body, 'name' | 'start' | 'end'>): string {
  const from = code.indexOf(b.start);
  const to = code.indexOf(b.end, from + 1);
  expect(from, `${b.name}: marker "${b.start}" not found`).toBeGreaterThan(-1);
  expect(to, `${b.name}: marker "${b.end}" not found after the start`).toBeGreaterThan(from);
  return code.slice(from, to);
}

/** Every reason this body would still hand the RPC a note-specific address. */
function findings(body: string): string[] {
  const out: string[] = [];
  if (POINTED_READ.test(body)) out.push('pointed-read');
  if (PDA_DERIVATION.test(body)) out.push('pda-derivation');
  if (SHORT_CIRCUIT.test(body)) out.push('short-circuit');
  for (const call of body.match(NOISY_LOG) ?? []) {
    if (/pda|nullifier/i.test(call)) out.push('logged-pda');
  }
  return [...new Set(out)];
}

/**
 * The counter guard protects funds: a swallowed read means "counter 0 is
 * free", and a re-used counter makes a note no withdrawal can spend. The
 * fail-closed behaviour is measured on `findFirstUnspentCounter` in
 * spentSet.test.ts; here, that the guard hands its answer straight back.
 */
function counterFindings(body: string): string[] {
  const b = norm(body);
  const out: string[] = [];
  const call = norm(
    'const counter = await findFirstUnspentCounter(connection, walletSeed, poolPDA, startCounter, maxAttempts);',
  );
  if (!b.includes(call)) out.push('no-delegate');
  if (/\btry\b|\bcatch\b|\.catch\(|\.then\(|\.finally\(/.test(b)) out.push('swallow');
  const returns = b.match(/\breturn\b[^;]*;/g) ?? [];
  if (returns.length !== 1 || returns[0] !== 'return counter;') out.push('returns-other');
  if ((b.match(/\bcounter\s*=(?!=)/g) ?? []).length !== 1) out.push('counter-reassigned');
  if (HAND_COMPOSED.test(b)) out.push('hand-composed');
  if (SHORT_CIRCUIT.test(b)) out.push('short-circuit');
  // Counters are per-wallet note indices: how many shields this wallet made.
  for (const log of b.match(NOISY_LOG) ?? []) {
    if (log.includes('${')) out.push('logged-value');
  }
  if (/console\.\w+\(/.test(b) && !b.includes('if (__DEV__')) out.push('ungated-log');
  return [...new Set(out)];
}

/** The refresh must mark spent exactly the ids the tested helper returns. */
function refreshFindings(body: string): string[] {
  const b = norm(body);
  const out: string[] = [];
  if (!b.includes(norm('const spentNoteIds = await fetchSpentNoteIds(connection, candidates);'))) {
    out.push('no-delegate');
  }
  if ((b.match(/\bspentNoteIds\s*=(?!=)/g) ?? []).length !== 1) out.push('verdict-reassigned');
  if (/\bspentNoteIds\.(?:add|delete|clear)\(/.test(b)) out.push('verdict-edited');
  if (
    !b.includes(
      norm(
        `candidates.push({ id: note.id, poolPDA: new PublicKey(note.poolPDA), nullifierPreimage: receipt.nullifierPreimage, secret: receipt.secret });`,
      ),
    )
  ) {
    out.push('candidates-not-from-receipts');
  }
  if (!b.includes(norm('for (const note of activeNotes) {'))) out.push('not-every-active-note');
  if (
    !b.includes(
      norm(`if (spentNoteIds.has(note.id)) { return { ...note, status: 'spent' as NoteStatus }; }`),
    )
  ) {
    out.push('verdict-unused');
  }
  if (HAND_COMPOSED.test(b)) out.push('hand-composed');
  if (SHORT_CIRCUIT.test(b)) out.push('short-circuit');
  return [...new Set(out)];
}

/** Each pre-flight must refuse the spend, and mark the note, on a spent verdict. */
function preflightFindings(body: string): string[] {
  const b = norm(body);
  const out: string[] = [];
  const refusal = norm(
    `if (await isNullifierSpentPoolWide(getConnection(), pool.poolPDA, preStarkNull)) {
       set(state => ({ notes: state.notes.map(n => n.id === noteId ? { ...n, status: 'spent' as NoteStatus } : n) }));
       throw new Error('Note already spent on-chain');
     }`,
  );
  if (!b.includes(refusal)) out.push('verdict-unused');
  if (!b.includes(norm(`if ((e as Error).message === 'Note already spent on-chain') throw e;`))) {
    out.push('refusal-swallowed');
  }
  if (HAND_COMPOSED.test(b)) out.push('hand-composed');
  if (SHORT_CIRCUIT.test(b)) out.push('short-circuit');
  return [...new Set(out)];
}

/**
 * File-wide, not per body: a pointed nullifier read moved into a helper
 * elsewhere in the store needs the derivation or its byte encoders, and the
 * store needs neither since MOB-RPC.
 */
function fileFindings(code: string): string[] {
  const out: string[] = [];
  for (const name of ['deriveNullifierPDA', 'goldilocksNullifierToBytes', 'computeGoldilocksPoolNullifier']) {
    if (new RegExp(`\\b${name}\\b`).test(code)) out.push(name);
  }
  return out;
}

describe('mobile store: no call site names a nullifier PDA', () => {
  it('each of the five bodies is found exactly once', () => {
    for (const b of BODIES) {
      expect(CODE.split(b.start).length - 1, `${b.name}: start marker is ambiguous`).toBe(1);
      expect(bodyOf(CODE, b).length, `${b.name}: empty body`).toBeGreaterThan(40);
    }
  });

  it('the detector fires on the old shape and stays quiet on the new one', () => {
    // The positive control this file needs: the rules above are a text scan, so
    // they are only worth their green if they can go red. The old and the new
    // shape of the same site, side by side.
    const old = [
      'const [g16Pda] = deriveNullifierPDA(poolKey, bigintToLeBytes32(g16Null));',
      'const accs = await connection.getMultipleAccountsInfo([g16Pda, starkPda]);',
      'const preAcct = await preConn.getAccountInfo(prePda);',
      'console.log(`SPENT pda=${meta.pda}`);',
      'if (false && isGoldilocksNullifierSpentInSet(preSpent, pool.poolPDA, preStarkNull)) {',
    ].join('\n');
    expect(findings(old).sort()).toEqual([
      'logged-pda',
      'pda-derivation',
      'pointed-read',
      'short-circuit',
    ]);

    const now = [
      'const spentNoteIds = await fetchSpentNoteIds(connection, candidates);',
      'if (spentNoteIds.has(note.id)) {',
      'console.log(`[refreshNoteStatuses] ${activeNotes.length} active notes`);',
    ].join('\n');
    expect(findings(now)).toEqual([]);

    // A comment carrying the old words is not a finding.
    expect(findings(strip('// reads getAccountInfo(pda) — removed\nconst x = 1;'))).toEqual([]);
    // Normalisation is idempotent, so a mutated normalised body reads the same way.
    const sample = bodyOf(CODE, REFRESH);
    expect(norm(norm(sample))).toBe(norm(sample));
  });

  it('no body reads one account, derives a nullifier PDA, or logs one', () => {
    const bad: string[] = [];
    for (const b of BODIES) {
      const f = findings(bodyOf(CODE, b));
      if (f.length > 0) bad.push(`${b.name}: ${f.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('every body asks the pool-wide question instead', () => {
    // Through its tested delegate, and not by composing the set and the pure
    // rule by hand: that composition is where a swallowed read or an ignored
    // verdict hid (wp-logs/verify/MOB-RPC-r1-mutants.log).
    const missing: string[] = [];
    for (const b of BODIES) {
      const body = bodyOf(CODE, b);
      if (!body.includes(b.delegate)) missing.push(`${b.name}: no ${b.delegate}`);
      if (HAND_COMPOSED.test(body)) missing.push(`${b.name}: hand-composed`);
    }
    expect(missing).toEqual([]);
  });

  it('the store imports the set from services/privacy/spentSet', () => {
    const imports = [
      ...CODE.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:\.\.\/)+services\/privacy\/spentSet'/g),
    ];
    expect(imports.length).toBe(1);
    const names = imports[0][1]
      .split(',')
      .map((s) => s.trim())
      // `type SpentCandidate` is a type: it carries no call.
      .filter((s) => s !== '' && !s.startsWith('type '))
      .sort();
    expect(names).toEqual(['fetchSpentNoteIds', 'findFirstUnspentCounter', 'isNullifierSpentPoolWide']);
  });

  it('the store derives no nullifier PDA anywhere, not only in the five bodies', () => {
    expect(fileFindings(CODE)).toEqual([]);
  });

  it('the counter guard hands back the fail-closed search answer and swallows nothing', () => {
    expect(counterFindings(bodyOf(CODE, COUNTER))).toEqual([]);
  });

  it('the refresh marks spent exactly the ids the tested helper returns', () => {
    expect(refreshFindings(bodyOf(CODE, REFRESH))).toEqual([]);
  });

  it('each pre-flight refuses the spend when the pool-wide verdict says spent', () => {
    const bad: string[] = [];
    for (const b of PREFLIGHTS) {
      const f = preflightFindings(bodyOf(CODE, b));
      if (f.length > 0) bad.push(`${b.name}: ${f.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('the delegate checks go red on the verifier mutants of the real bodies', () => {
    // Each mutant is applied to the REAL body text. `applied` guards against a
    // replacement that silently matched nothing and left the body unchanged.
    const mutate = (body: string, from: string, to: string): string => {
      const src = norm(body);
      const out = src.replace(norm(from), norm(to));
      expect(out, `mutation did not apply: ${from}`).not.toBe(src);
      return out;
    };
    const counter = bodyOf(CODE, COUNTER);
    const refresh = bodyOf(CODE, REFRESH);
    const delegateLine =
      'const counter = await findFirstUnspentCounter(connection, walletSeed, poolPDA, startCounter, maxAttempts);';
    const counterMutants = {
      // wp-logs/verify/MOB-RPC-r1-mut/store_counter_ignored.ts, in today's shape
      failOpen: mutate(
        counter,
        delegateLine,
        'let counter = startCounter; try { counter = await findFirstUnspentCounter(connection, walletSeed, poolPDA, startCounter, maxAttempts); } catch {}',
      ),
      promiseCatch: mutate(
        counter,
        delegateLine,
        'const counter = await findFirstUnspentCounter(connection, walletSeed, poolPDA, startCounter, maxAttempts).catch(() => startCounter);',
      ),
      answerIgnored: mutate(counter, 'return counter;', 'return startCounter;'),
      handComposed: mutate(
        counter,
        delegateLine,
        'await fetchPoolSpentSet(connection, poolPDA); const counter = startCounter;',
      ),
    };
    for (const [name, m] of Object.entries(counterMutants)) {
      expect(counterFindings(m), `counter mutant ${name}`).not.toEqual([]);
    }

    const refreshMutants = {
      // wp-logs/verify/MOB-RPC-r1-mut/store_ignored.ts, in today's shape
      verdictShortCircuited: mutate(refresh, 'if (spentNoteIds.has(note.id))', 'if (false && spentNoteIds.has(note.id))'),
      verdictReplaced: mutate(
        refresh,
        'const spentNoteIds = await fetchSpentNoteIds(connection, candidates);',
        'await fetchSpentNoteIds(connection, candidates); const spentNoteIds = new Set<string>();',
      ),
      verdictNeverRead: mutate(
        refresh,
        `if (spentNoteIds.has(note.id)) { return { ...note, status: 'spent' as NoteStatus }; }`,
        '',
      ),
    };
    for (const [name, m] of Object.entries(refreshMutants)) {
      expect(refreshFindings(m), `refresh mutant ${name}`).not.toEqual([]);
    }

    const refusalHead = 'if (await isNullifierSpentPoolWide(getConnection(), pool.poolPDA, preStarkNull)) {';
    for (const b of PREFLIGHTS) {
      const body = bodyOf(CODE, b);
      const pfMutants = {
        shortCircuited: mutate(body, refusalHead, 'if (false && await isNullifierSpentPoolWide(getConnection(), pool.poolPDA, preStarkNull)) {'),
        verdictDropped: mutate(
          body,
          refusalHead,
          'await isNullifierSpentPoolWide(getConnection(), pool.poolPDA, preStarkNull); if (preStarkNull === -1n) {',
        ),
        refusalSwallowed: mutate(body, `if ((e as Error).message === 'Note already spent on-chain') throw e;`, ''),
      };
      for (const [name, m] of Object.entries(pfMutants)) {
        expect(preflightFindings(m), `${b.name} mutant ${name}`).not.toEqual([]);
      }
    }

    // wp-logs/verify/MOB-RPC-r1-mut/store_helper_outside.ts: a pointed read
    // parked in a helper outside the five bodies.
    const helperOutside = `${CODE}\nasync function probe(c, p, n) { const [pda] = deriveNullifierPDA(p, n); return c.getAccountInfo(pda); }`;
    expect(fileFindings(helperOutside)).toEqual(['deriveNullifierPDA']);
  });

  it('the counter search still runs before anything is funded', () => {
    // The guard protects funds, not privacy: a re-used counter produces a note
    // with a fresh commitment and a colliding nullifier, which no withdrawal
    // can ever spend. Both shield paths must settle the counter before the
    // stealth address that receives the full denomination is derived.
    const shield = bodyOf(CODE, {
      name: 'shieldNote',
      start: 'shieldNote: async (pool) => {',
      end: 'shieldNoteV3: async (',
    });
    const searches = [...shield.matchAll(/firstUnspentCounter\(|findSafeShieldCounter\(/g)].map(
      (m) => m.index ?? -1,
    );
    const labels = [...shield.matchAll(/stealth_shield_v1_/g)].map((m) => m.index ?? -1);
    expect(searches.length, 'both the fresh and the recovery path pick a counter').toBe(2);
    expect(labels.length, 'both paths derive the address that receives the money').toBe(2);
    // Pair by position. Measured against the first label only, the recovery
    // path's search (at 7337) sits after the fresh path's label (2636) and the
    // rule could never hold — the check was vacuous in the direction that
    // matters.
    for (let i = 0; i < searches.length; i++) {
      expect(searches[i], 'counter settled before this path derives its address').toBeLessThan(
        labels[i],
      );
    }
    // And before the only lamport transfer in the body.
    const transferAt = shield.indexOf('SystemProgram.transfer(');
    expect(transferAt).toBeGreaterThan(-1);
    expect(searches[0]).toBeLessThan(transferAt);
  });
});

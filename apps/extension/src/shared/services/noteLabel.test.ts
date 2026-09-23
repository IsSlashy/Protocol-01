/**
 * The name a note is shown by, in the extension.
 *
 * WHAT THIS MEASURES, and what it does not. `noteTag.test.ts` already pins the
 * scheme against the vector shared with the other two clients. This file pins
 * the ADAPTER the screens call: which notes get a name, which do not, and that
 * the name moves with the note's secrets and with nothing else a chain reader
 * can see.
 *
 * ⛔ The invariance case is worthless on its own — four notes that are secretly
 * the same note also "have the same tag". So it carries its own positive
 * control: the same four notes, named by their public commitment instead, must
 * SEPARATE. If the fixtures stop varying the public fields, that control fails
 * and the case goes red (the shape is TAG-0's, `noteTag.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { noteLabel } from './noteLabel';
import { noteTag } from './noteTag';
import { useDenominatedPoolStore } from '../store/denominatedPool';

/**
 * The vector TAG-0 pinned, whose expected tag was computed by a second
 * implementation (node:crypto), not recorded from the module under test.
 * vitest runs with cwd = apps/extension.
 */
const VECTOR = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../apps/web/lib/privacy/pool/fixtures/noteTagVector.json'),
    'utf8',
  ),
) as { pool: string; secret: string; nullifierPreimage: string; tag: string; color: string };

/** A denominated note as the store hands it to a screen, minus the bits varied per case. */
function receipt(over: Record<string, unknown> = {}) {
  return {
    secret: BigInt(VECTOR.secret),
    nullifierPreimage: BigInt(VECTOR.nullifierPreimage),
    depositEpoch: 7_284_991_002_338_477_113n,
    tokenMint: 0n,
    commitment: 15_172_894_697_579_388_633n,
    leafIndex: 211,
    denomination: 1_000_000_000n,
    pool: VECTOR.pool,
    token: 'SOL' as const,
    denominationHuman: 1,
    shieldedAt: 1_700_000_000_000,
    ...over,
  };
}

describe('noteLabel — a denominated note is named by its secrets', () => {
  it('gives the vector its pinned tag and colour', () => {
    const label = noteLabel(receipt());
    expect(label?.text).toBe(VECTOR.tag);
    expect(label?.color).toBe(VECTOR.color);
  });

  it('is the same name for notes that differ only in leaf, commitment or shield time', () => {
    const worlds = [
      receipt(),
      receipt({ leafIndex: 58 }),
      receipt({ commitment: 10_743_605_027_982_166_358n }),
      receipt({ shieldedAt: 1_500_000_000_000 }),
      receipt({ depositEpoch: 67_838n }),
    ];

    const names = worlds.map((n) => noteLabel(n)?.text);
    expect(names[0]).toBe(VECTOR.tag);
    expect(new Set(names).size).toBe(1);

    // Positive control: the same five worlds, named by a PUBLIC field, must
    // separate. Without it, five identical fixtures would pass the case above.
    const publicNames = worlds.map(
      (n) => noteTag({ pool: n.pool, secret: n.commitment, nullifierPreimage: n.leafIndex }).text,
    );
    expect(new Set(publicNames).size).toBeGreaterThan(1);
  });

  it('moves when the note does: another secret, another pool, another name', () => {
    const base = noteLabel(receipt())?.text;
    const otherSecret = noteLabel(receipt({ secret: BigInt(VECTOR.secret) + 1n }))?.text;
    const otherPool = noteLabel(
      receipt({ pool: 'GbVM5yveFMPHQZMLzq5xmMmqNnRjBJLvbQC1t7uUfoTz' }),
    )?.text;

    expect(base).toBe(VECTOR.tag);
    expect(otherSecret).not.toBe(base);
    expect(otherPool).not.toBe(base);
  });

  it('reads the receipt the STORE produces, not a shape invented here', () => {
    // The screens call `getNotes()`. If a field is renamed in the store, or the
    // deserializer stops producing one, this goes red rather than the screens
    // quietly losing their names.
    useDenominatedPoolStore.setState({
      serializedNotes: [
        {
          secret: VECTOR.secret,
          nullifierPreimage: VECTOR.nullifierPreimage,
          depositEpoch: '7284991002338477113',
          tokenMint: '0',
          commitment: '15172894697579388633',
          leafIndex: 211,
          denomination: '1000000000',
          pool: VECTOR.pool,
          token: 'SOL',
          denominationHuman: 1,
          shieldedAt: 1_700_000_000_000,
        },
      ],
      loading: false,
      error: null,
    });

    const fromStore = useDenominatedPoolStore.getState().getNotes()[0];
    expect(noteLabel(fromStore)?.text).toBe(VECTOR.tag);
  });
});

describe('noteLabel — a note it cannot name is not a crash', () => {
  it('a legacy zk note has no nullifier preimage, so it has no name', () => {
    // The retired V1 `store/shielded.ts` ShieldedNote (deleted 2026-09-23):
    // amount, commitment, leafIndex, createdAt. Old profiles may still hold one.
    // Its commitment is on chain; naming a note by it is the leak this replaces.
    const legacy = { amount: '1500000000', commitment: 'commitment_hash_1', leafIndex: 0 };
    expect(noteLabel(legacy as never)).toBeNull();
  });

  it('a malformed field returns null instead of throwing into a render', () => {
    expect(noteLabel(receipt({ secret: '12a' }) as never)).toBeNull();
    expect(noteLabel(receipt({ nullifierPreimage: '' }) as never)).toBeNull();
    expect(noteLabel(receipt({ pool: '' }) as never)).toBeNull();
    expect(noteLabel(receipt({ pool: undefined }) as never)).toBeNull();
    expect(noteLabel(null)).toBeNull();
    expect(noteLabel(undefined)).toBeNull();
  });

  it('a negative field is refused, not coerced', () => {
    expect(noteLabel(receipt({ secret: -1n }) as never)).toBeNull();
  });
});

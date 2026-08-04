/**
 * mergeScanWithLocal — the rule that keeps received money visible.
 *
 * Every note panel paints from the local blobs first and then reconciles with
 * the chain scan. The chain scan re-derives from the pool seed, so a RECEIVED
 * note (secrets from the sender's seed) is structurally invisible to it, and
 * the old wholesale replacement made such a note vanish from the lists the
 * moment the slow scan landed. The merge rule under test:
 *
 *   - the chain scan wins every leaf it has a row for (its `spent` is a
 *     reading; the local one is a default), and
 *   - a local note the scan has NO row for is kept, because for received and
 *     RPC-pruned notes the local store is the only witness.
 */

import { describe, expect, it } from "vitest";

import { mergeScanWithLocal } from "@/lib/privacy/shieldClient";
import type { PoolNoteView } from "@/lib/privacy/worker/poolHandlers";

function note(over: Partial<PoolNoteView> = {}): PoolNoteView {
  return {
    pool: "HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG",
    token: "SOL",
    denomination: 0.1,
    counter: 0,
    leafIndex: 11,
    commitment: "111",
    spent: false,
    derivation: 1,
    ...over,
  };
}

describe("mergeScanWithLocal", () => {
  it("keeps a local-only note: the chain scan cannot see a received one", () => {
    const chain = [note({ leafIndex: 11 })];
    const local = [note({ leafIndex: 11, spentKnown: false }), note({ leafIndex: 47, commitment: "474747", spentKnown: false })];

    const merged = mergeScanWithLocal(chain, local);
    expect(merged.map((n) => n.leafIndex)).toEqual([11, 47]);
  });

  it("lets the chain row win for a leaf both sides know: its spent is a reading", () => {
    // The local default says unspent; the chain read says spent. Keeping the
    // local row would offer money that is gone.
    const chain = [note({ leafIndex: 11, spent: true })];
    const local = [note({ leafIndex: 11, spent: false, spentKnown: false })];

    const merged = mergeScanWithLocal(chain, local);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.spent).toBe(true);
  });

  it("treats the same leaf in different pools as different notes", () => {
    const chain = [note({ pool: "PoolA11111111111111111111111111111111111111" })];
    const local = [note({ pool: "PoolB11111111111111111111111111111111111111", spentKnown: false })];
    expect(mergeScanWithLocal(chain, local)).toHaveLength(2);
  });

  it("sorts by denomination then leaf index, like the lists render", () => {
    const chain = [note({ denomination: 1, leafIndex: 3 })];
    const local = [
      note({ denomination: 0.1, leafIndex: 9, spentKnown: false }),
      note({ denomination: 1, leafIndex: 1, spentKnown: false }),
    ];
    expect(mergeScanWithLocal(chain, local).map((n) => `${n.denomination}:${n.leafIndex}`)).toEqual([
      "0.1:9",
      "1:1",
      "1:3",
    ]);
  });

  it("passes an empty side through unchanged", () => {
    const only = [note()];
    expect(mergeScanWithLocal(only, [])).toEqual(only);
    expect(mergeScanWithLocal([], only)).toEqual(only);
  });
});

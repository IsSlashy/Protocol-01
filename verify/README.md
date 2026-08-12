# p01-verify

An independent check of the pool's unlinkability claim. No keys, no SOL, no
account, no `npm install` — Node 18+ and a public RPC. Or no RPC at all: the
committed fixtures replay offline.

```bash
# offline, deterministic, ~1 s each — what CI runs on every push
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v3-subscribe
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-synthetic
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-synthetic-errored

# live against devnet
node verify/p01-verify.mjs --self-test                    # negative control on live data
node verify/p01-verify.mjs --spend <signature>
node verify/p01-verify.mjs --pool <poolPDA> --limit 3
node verify/p01-verify.mjs --spend <sig> --rpc https://your-endpoint --max-chunk-tx 400
node verify/p01-verify.mjs --spend <sig> --record verify/fixtures/<name>   # freeze a fixture
```

Exit code `0` means every probe passed (under `--self-test`: every control
held), `1` means a linkage survived (or a control broke), `2` means the tool
itself failed — config error, unknown pool, replay miss, network dead.

## Run the self-tests before believing any green

Every leak probe must **fail** on a v3-era spend, because v3 publishes the note
commitment as a public instruction argument by design. A v3 run that comes back
clean means the tool is broken, not that the pool is private. And the converse
must hold too: the tool must be *able* to report a clean spend, or a future
green is unfalsifiable. Three fixtures are committed — that control pair,
plus a regression pin:

| fixture | provenance | pins |
|---|---|---|
| `fixtures/v3-subscribe` | **recorded** from a real devnet `subscribe_private_stark` spend | P1/P2/P4 FAIL (the leak stays detected) |
| `fixtures/v4-synthetic` | **hand-built**, never touched a chain — see its README | P1/P2/P4 PASS (clean stays reportable) |
| `fixtures/v4-synthetic-errored` | **hand-built** — v4-synthetic with two errored payer signatures | P3 PASS (errored history must not break completeness) |

The third fixture pins a regression rather than a control direction: errored
signatures are skipped, not scanned, and P3's completeness test must count
them (`scanned + errored >= sigs.length`). The pre-fix arithmetic compared
`scanned` alone against the history length, so one failed transaction
anywhere in a payer's history — ordinary, since chunks go out with
skipPreflight — forced P3 INCONCLUSIVE with advice (`--max-chunk-tx`) that
could never help. Both control fixtures have zero errored entries, so only
this one goes red if that bug returns.

All three pin P3b FAIL: the interpolation channel stays inconclusive until
trace blinding ships, and the pin means a premature "fix" turns CI red first.
`.github/workflows/ci.yml` runs all three replays as hard gates on every push.

## The probes

| probe | what it reads |
|---|---|
| **P1** | the spend instruction's commitment argument |
| **P2** | every 8-byte window of the spend instruction |
| **P3** | every `write_proof_chunk` byte the spend's payer uploaded |
| **P3b** | the limit of P3, always inconclusive — see below |
| **P4** | the deposit, found by matching `LeafInserted` against the published commitment |
| **P5** | context: the pool's real anonymity set and the deposit→spend gap |

**P3 is the probe most checkers omit, and it is why this file exists.** A STARK
proof reaches the chain as ordinary instruction data across ~74–148
`write_proof_chunk` transactions, archived forever, all reachable from the spend
through its payer — the pool requires `c1_authority == payer`
(`unshield_denominated_stark_v3.rs:222`), so one address holds the whole upload.
A checker that reads only the spend instruction would report green on a system
whose proof bytes hand over the note. The payer itself is taken from `keys[0]`
only after the message header confirms `numRequiredSignatures ≥ 1`; without the
header the probe says INCONCLUSIVE rather than scanning a guessed wallet.

**P3b is inconclusive on purpose and must never be made to pass.** P3 detects a
value present *verbatim*. `stark/src/compact.rs:3460-3484` interpolates the trace
and evaluates it on the LDE domain with no coset offset, no blinding polynomial
and no random rows; the published openings therefore determine the trace
polynomial, and the witness is recoverable by interpolation rather than by
copying. A byte scan is structurally blind to that. P3b stays red until trace
blinding ships and this tool grows a real interpolation attempt with its own
positive control.

**P4 refuses to run half-blind.** Every pool in the `POOLS` table carries its
merkle-tree PDA, because P4 walks the *tree's* history for the matching
`LeafInserted` (checked against the real Anchor event discriminator and the
144-byte layout of `merkle_tree_v3.rs:211-217`, so no other event can be
misread as a leaf). A spend touching a pool the table does not know is a hard
error, not a skipped probe — add the pool to `POOLS`, or pass
`--pools <json>` shaped `{ "<poolPDA>": { "label": "...", "tree": "<treePDA>" } }`.

## Fixtures: `--record` / `--replay`

`--record <dir>` runs live and freezes every RPC response the probes read into
`<dir>/rpc.json` (trimmed to the fields the tool uses), plus a `manifest.json`
pinning the flags and the measured outcome of every probe. `--replay <dir>`
answers every RPC call from disk and never touches the network; a call the
fixture cannot answer is a hard error, never a skip. `--self-test --replay`
then asserts every probe matches its pin — including that a *new* probe with no
pin fails the run, so extending the tool forces extending the controls.

Re-record when the probes change what they read (a replay miss tells you,
loudly, with the exact request). Review the auto-pinned `expect` map against
the run that produced it before committing.

## Measured on devnet, 2026-08-12

Against `subscribe_private_stark` `4v6RLndU…` in the 1 SOL pool — this is the
run frozen in `fixtures/v3-subscribe`:

```
FAIL  P1   publishes 7031290397188312164 at instruction byte offset 160
FAIL  P2   found at byte offset 160 of 201
PASS  P3   absent from 148 chunks / 147,038 bytes (172/172 tx scanned)
FAIL  P3b  inconclusive by construction
FAIL  P4   deposit 2PVnaQXD… inserted the same commitment at leaf 23
INFO       pool 1 SOL: 6 unspent of 25 ever deposited; gap 355,268 slots
```

Two things worth stating plainly, because both cut against expectations:

1. **P3 passes today.** The commitment is not copied into the C1+C3 proof bytes.
   That refines a design concern rather than confirming it — the present-day
   witness leak is the interpolation one (P3b), not a byte copy. Whether a future
   C7 `commit_hold` column would put the commitment in the proof verbatim is a
   property of a circuit that does not exist yet, and it must be measured with
   this tool when it does.
2. **The linkage is real and complete without any of that.** P1, P2 and P4 alone
   take a stranger from a spend to its deposit using public data and a public
   RPC, in one command.

## Notes

- Public devnet throttles. The tool backs off and retries, and reports how much
  of the payer's history it actually walked. A capped scan is reported
  INCONCLUSIVE, never PASS — that distinction is the whole discipline here.
- Add `unshield_denominated_stark_v4` pools to `POOLS` (with their tree PDAs)
  when v4 ships, then record a **real** v4 spend with `--record` and check its
  probes; `fixtures/v4-synthetic` only proves the tool can say "clean", never
  that anything real is.

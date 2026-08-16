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
| `fixtures/v3-subscribe` | **recorded** from a real devnet `subscribe_private_stark` spend | P1/P2/P4/P6/P7/P8 FAIL (the leak stays detected) |
| `fixtures/v4-synthetic` | **hand-built**, never touched a chain — see its README | P1/P2/P4 PASS, **P6 PASS** (clean stays reportable) |
| `fixtures/v4-synthetic-errored` | **hand-built** — v4-synthetic with two errored payer signatures | P3 PASS (errored history must not break completeness) |

Both synthetic fixtures pin **P8 FAIL**, and it is an INCONCLUSIVE rather than a
detection: they publish no commitment, so P4 finds no deposit and there is no
deposit side to compare. P8's green is exercised offline instead — see below.

⚠️ `v4-synthetic` is also the standing demonstration that **a v4 spend is not a
private one**. It is what the world looks like after the commitment leaves the
spend instruction: P1, P2 and P4 all turn green. Its payer happens to carry no
funding edge, so P6 is green there too — but on a *real* v4 built the way the
client works today, P6 would stay red and P7 would still find the verifier's four
publications. Do not read this fixture's green column as a roadmap outcome.

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
| **P6** | the fee payer's two funding edges — where its lamports came from, where they went |
| **P7** | the commitment in instruction *arguments* outside the proof payload |
| **P8** | the same walk on the *deposit's* payer, and whether one wallet stands behind both ends |

**P6 is the cheapest attack in this file, and it is not cryptographic.** P1–P4
chase a commitment; an analyst would not. The spend is signed by an ephemeral
key, which is good — but an ephemeral key cannot pay a fee from nothing, so a
public `SystemProgram::transfer` funded it, and the client sweeps the residue
back when the job ends. The ephemeral is bracketed by two ordinary transfers and
both name the wallet. Measured on `fixtures/v3-subscribe`: **3 RPC calls**, one
more than a block explorer already makes. P6 prints its own call count, so the
cost of the attack is part of the result.

**Finding the leak is cheap; proving its absence is not, and since 2026-08-16 P6
pays for both.** It reads the two ends of the payer's life first — that is the
attack, and when they name someone the probe stops there and reports three calls.
When they come back clean it reads **every** transaction in the history before
passing, and it reads inner instructions as well as top-level ones.

Neither widening changes the committed fixture's verdict, and the honest version
of why they were made is narrower than "it was broken":

- **the two ends were right by coincidence, not by construction.** MEASURED on
  the deposit payer `HDudHd6Y…`: 96 transactions, pre-fund at index 95, sweep at
  index 0, both top-level, both naming `BRop3akx…`. That is the shape today's
  client happens to produce. A funder that tops up mid-life breaks it, and two
  samples out of ninety-six would then have read as absence.
- **a CPI transfer was invisible.** MEASURED on the deposit `2PVnaQXD…`: three
  top-level instructions, none of them a System transfer, and both lamport
  movements inside `meta.innerInstructions`. Those two go to the pool and the fee
  escrow rather than to a wallet, so no verdict moved — but nothing stops a
  funder paying an ephemeral the same way, and fixtures did not even retain the
  field, so no recorded fixture could have shown it.

A PASS still means the *one-hop* edge is closed, never that the payer is
anonymous: a funder one hop further out, or a relayer that logged the request, is
outside this probe.

**P7 exists so that closing P1 cannot be mistaken for a win.** The verifier takes
`public_inputs: Vec<u64>` as an *instruction argument*, and C1's public inputs are
`[nullifier, commitment]` — the pair that *is* the linkage, published in the clear
before the spend lands. P3 cannot see it: P3 filters strictly on the
`write_proof_chunk` discriminator, correctly for its own question and blindly for
this one. Remove the commitment from the spend instruction and P1, P2 and P4 all
turn green while the leak survives in the verify instructions. Measured on
`fixtures/v3-subscribe`: **5 instructions**, one from `zk_shielded` and four from
the verifier. That number is a **floor** — publications on the deposit side belong
to a different payer and are outside this walk, as is any occurrence in an event
log rather than an instruction.

**P8 measures the sentence this file used to attribute to P4.** The header of
`p01-verify.mjs` described P4 as *"the wallet that funded the deposit is not a
party to the spend"* until 2026-08-16. P4 never checked that: `findDeposit`
returned a signature and a leaf index and never looked at who paid, so the
deposit half of the claim was documented and unmeasured for the whole life of the
file. P8 is the symmetric twin of P6 — the same three-call walk pointed at the
deposit's fee payer — plus the intersection of the two counterparty sets.

**A PASS requires both sides to resolve something.** Two sides that resolve
nothing also intersect in nothing, and calling that clean would convert *"we
could not see"* into *"there is nothing there"*. So P8 passes only when both
walks return a non-empty funder set **and** those sets are disjoint; anything
else is INCONCLUSIVE, and INCONCLUSIVE is FAIL. A PASS says the deposit and the
spend do not share a one-hop financial parent — not that they are unrelated. A
parent one hop further out, two withdrawals from the same exchange, or an
off-chain hand-over of the note all survive it untouched.

**And P8 will go red on a shared treasury, correctly.** The moment one funder
covers both the shield and the subscribe legs for everyone, this probe fails —
because one party did finance both ends, whatever its intent. That is the probe
working, not a bug to relax.

**P8 cannot get its green from any fixture, so it gets it offline.** The
synthetic fixtures publish no commitment, so P4 finds no deposit and P8 is
INCONCLUSIVE there; the recorded one is a v3 spend where the buyer funded both
ends. Its rule is therefore split into two pure functions and driven through every
branch in `selfTestChannelDecoders()`, each case asserting the REASON the rule
gives rather than merely that it refused. Four of those cases are greens no
fixture can produce: disjoint counterparties (the shape an E3 spend makes), one
treasury behind both ends, and the two directions of a direct payer-to-payer
edge.

**P7's green state lives in an offline control, not in a fixture.** The synthetic
fixtures publish no commitment, so P7 has nothing to count and reports
INCONCLUSIVE there. A probe only ever observed failing is a hollow guard, so
`selfTestChannelDecoders()` builds four hand-made cases — a bracketed payer, an
unfunded one, a published argument, and the same value inside a
`write_proof_chunk` that must be *ignored*. That last case is the boundary
between P3 and P7, and it is the one worth breaking on purpose to check the
control still catches it.

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

## Measured on devnet, 2026-08-12 (P8 added 2026-08-16)

Against `subscribe_private_stark` `4v6RLndU…` in the 1 SOL pool — this is the
run frozen in `fixtures/v3-subscribe`:

```
FAIL  P1   publishes 7031290397188312164 at instruction byte offset 160
FAIL  P2   found at byte offset 160 of 201
PASS  P3   absent from 148 chunks / 147,038 bytes (172/172 tx scanned)
FAIL  P3b  inconclusive by construction
FAIL  P4   deposit 2PVnaQXD… inserted the same commitment at leaf 23
FAIL  P6   bracketed by 2 System transfers naming BRop3akx… — in 3 RPC calls
FAIL  P7   5 instructions publish it in the clear (zk_shielded ×1, verifier ×4)
FAIL  P8   1 wallet funds BOTH ends: BRop3akx… — in 6 RPC calls
INFO       pool 1 SOL: 6 unspent of 25 ever deposited; gap 355,268 slots
```

The 2026-08-16 re-record was needed because P8 reads a history no earlier
fixture held — the deposit payer's. Every other probe reproduced its 2026-08-12
numbers byte for byte, so the re-record changed what is read, not what is true.

Four things worth stating plainly, because all four cut against expectations:

1. **P3 passes today.** The commitment is not copied into the C1+C3 proof bytes.
   That refines a design concern rather than confirming it — the present-day
   witness leak is the interpolation one (P3b), not a byte copy. Whether a future
   C7 `commit_hold` column would put the commitment in the proof verbatim is a
   property of a circuit that does not exist yet, and it must be measured with
   this tool when it does.
2. **The linkage is real and complete without any of that.** P1, P2 and P4 alone
   take a stranger from a spend to its deposit using public data and a public
   RPC, in one command.
3. **P6 needs none of it either, and costs three RPC calls.** The pre-fund arrives
   74 seconds before the spend and the sweep leaves 6 seconds after, both naming
   the same wallet, and the pre-fund amount is a deterministic constant that
   `memcmp` alone can enumerate. No proof is read, no commitment is matched, no
   interpolation is attempted. Any privacy work that does not close this channel
   first is optimising the second-cheapest attack.
4. **P8 costs six RPC calls and names the buyer as their own depositor.** The
   deposit's ephemeral and the spend's ephemeral are different keys, and both are
   funded by `BRop3akx…`. So the two legs are not merely correlatable through the
   commitment — they are financed by one wallet, which an analyst reaches without
   reading a single proof byte. This is the probe that would turn green on a note
   that was *received* rather than deposited, and it is the only probe in this
   file that can.

## Notes

- Public devnet throttles. The tool backs off and retries, and reports how much
  of the payer's history it actually walked. A capped scan is reported
  INCONCLUSIVE, never PASS — that distinction is the whole discipline here.
- Add `unshield_denominated_stark_v4` pools to `POOLS` (with their tree PDAs)
  when v4 ships, then record a **real** v4 spend with `--record` and check its
  probes; `fixtures/v4-synthetic` only proves the tool can say "clean", never
  that anything real is.

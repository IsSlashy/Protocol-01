//! The whole wire, counted off real bytes — not derived from the configs.
//!
//! # Why this file exists
//!
//! Every recovery harness in this tree (`air_aware_recovery_c{1,3,5,6,7}.rs`,
//! `witness_recovery_positive_control.rs`) reads exactly ONE channel: the four
//! trace rows per query plus the two OOD frames. Each says so in its own header.
//! Nothing anywhere reads the quotient openings, the FRI layer values or the
//! terminal polynomial, and `air/spend.rs:262-268` names those as precisely the
//! channels with no simulation argument.
//!
//! So the repository could state what the trace channel does, and could only
//! ARGUE about the rest. This file closes that: it parses the ENTIRE proof and
//! counts, on real bytes, what each channel publishes against what the prover
//! draws.
//!
//! # What is measured, and what is merely counted
//!
//! ✅ MEASURED here: the number of field elements each channel publishes, read
//!    out of a proof this file generates. The parse is required to consume the
//!    byte string EXACTLY — a miscount lands as a panic, not as a wrong number.
//!
//! ✅ MEASURED here: how many of the FRI values are genuinely new, and how many
//!    layer-0 positions each new one depends on. That is the number which
//!    decides whether a linear attack can reach the FRI channel at all.
//!
//! ⚠️ NOT measured, and deliberately not claimed: whether the witness is
//!    RECOVERABLE from the full wire. The quotient and FRI values are degree-≤7
//!    in the unknowns (the Poseidon S-box), so the linear solver every other
//!    harness uses cannot be pointed at them.
//!
//! 🚨 WHAT THIS FILE DOES NOT DECIDE, and an earlier version of this header said
//!    it did: SIMULATOR EXISTENCE. The sentence "more published elements than the
//!    prover has randomness, therefore no simulator can exist" is a non-sequitur.
//!    A random-oracle simulator does not hide the transcript with the prover's
//!    randomness at all — it programs the oracle, fixes the query positions
//!    first, and only has to be consistent where it will be opened. The counting
//!    here says nothing about it, in either direction.
//!
//!    What the counting DOES say is narrower and worth having: the prover's own
//!    randomness cannot make the published transcript independent of the witness,
//!    so no INFORMATION-THEORETIC hiding argument runs off the mask alone.
//!
//! ⛔ And it is NOT the statement "an adversary extracts the witness". This file
//!    must never be cited for that either.
//!
//! # The control
//!
//! A parser that quietly reads the wrong offsets would produce a tidy, wrong
//! ledger. So `the_parser_feeds_a_working_solver` takes the trace channel this
//! file extracted and runs the SAME under-determination measurement the C7
//! harness runs, including its collapse counterfactual. If the parse were
//! misaligned, the counterfactual would stop closing.
//!
//! Run: `cargo test -p p01-stark --release --test full_wire_ledger -- --nocapture`

const P: u128 = 0xFFFF_FFFF_0000_0001;

#[inline]
fn fadd(a: u64, b: u64) -> u64 {
    (((a as u128) + (b as u128)) % P) as u64
}
#[inline]
fn fsub(a: u64, b: u64) -> u64 {
    (((a as u128) + P - (b as u128)) % P) as u64
}
#[inline]
fn fmul(a: u64, b: u64) -> u64 {
    (((a as u128) * (b as u128)) % P) as u64
}
fn fpow(mut a: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = fmul(r, a);
        }
        a = fmul(a, a);
        e >>= 1;
    }
    r
}
fn finv(a: u64) -> u64 {
    assert!(a != 0, "no inverse for 0");
    fpow(a, (P - 2) as u64)
}

// ---------------------------------------------------------------------------
// Geometry — every field the wire layout depends on, per circuit.
//
// ⛔ These are NOT free parameters. `lde_size == trace_length * blowup`,
// `merkle_depth == log2(lde_size)` and `fri_layers == log2(lde/ffps) - 1` are
// derived, and `assert_geometry_is_self_consistent` refuses a row that breaks
// any of them. That is what stops this file from silently measuring a geometry
// the chain does not run.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Geometry {
    name: &'static str,
    trace_width: usize,
    trace_length: usize,
    lde_size: usize,
    merkle_depth: usize,
    quotient_segments: usize,
    num_queries: usize,
    fri_final_poly_size: usize,
    /// Rows the prover fills with fresh randomness, from the circuit's AIR.
    mask_rows: usize,
    /// Field elements the prover draws per proof — READ FROM THE CIRCUIT, not
    /// recomputed here.
    ///
    /// ⚠️ IT USED TO BE `mask_rows * trace_width`, AND THAT WENT WRONG SILENTLY.
    /// Since the randomizer column the mask is two regions of different shapes:
    /// the row mask over the CONSTRAINED columns, then one full column. The
    /// product form under-counted C3 by 384 and would have reported a deficit
    /// that does not exist.
    mask_len: usize,
    /// Columns the AIR constrains. The committed width is one more.
    constrained_width: usize,
}

impl Geometry {
    fn fri_layers(&self) -> usize {
        ((self.lde_size / self.fri_final_poly_size).trailing_zeros() as usize).saturating_sub(1)
    }
    /// Field elements the prover draws fresh for every proof. The ONLY
    /// randomness anywhere in the prover — see `stark/src/lib.rs::draw_blinding_mask`.
    fn mask_dim(&self) -> usize {
        self.mask_len
    }
    fn fri_layer_pair_path_bytes(&self, layer: usize) -> usize {
        self.merkle_depth.saturating_sub(layer + 2) * 32
    }
    /// Byte length of one proof, re-derived from the geometry alone. The twin of
    /// `wire_parity.rs::expected_wire_size`, written out again rather than
    /// imported so the two files cannot drift into agreeing by construction.
    fn wire_size(&self) -> usize {
        let tw = self.trace_width;
        let md = self.merkle_depth;
        let k = self.quotient_segments;
        let header = 32 + 32 + tw * 8 + tw * 8 + 8 + k * 8 + 1
            + self.fri_layers() * 32
            + 2 + self.fri_final_poly_size * 8 + 8 + 2;
        let fri_block: usize =
            (0..self.fri_layers()).map(|i| 16 + self.fri_layer_pair_path_bytes(i)).sum();
        let per_query =
            4 + 4 * tw * 8 + (md - 1) * 32 + (md - 1) * 32 + k * 8 + (md - 1) * 32 + fri_block;
        header + self.num_queries * per_query + self.num_queries * k * 8
    }
}

fn geometries() -> Vec<Geometry> {
    vec![
        Geometry {
            name: "C1 pool_commitment",
            trace_width: p01_stark::air::denominated_pool::TRACE_WIDTH,
            // [ZK-RANDOMIZER 2026-08-30] 256 -> 512, so lde 4096 -> 8192 and
            // merkle_depth 12 -> 13. `geometry_rows_are_derived_not_typed`
            // refuses a row where those three disagree.
            trace_length: 512,
            lde_size: 8192,
            merkle_depth: 13,
            quotient_segments: 8,
            num_queries: 27,
            fri_final_poly_size: 16,
            mask_rows: p01_stark::air::denominated_pool::MASK_ROWS,
            constrained_width: p01_stark::air::denominated_pool::CONSTRAINED_TRACE_WIDTH,
            mask_len: p01_stark::air::denominated_pool::MASK_LEN,
        },
        Geometry {
            name: "C3 merkle_path",
            trace_width: p01_stark::air::merkle_path::TRACE_WIDTH,
            trace_length: 512,
            lde_size: 8192,
            merkle_depth: 13,
            quotient_segments: 8,
            num_queries: 22,
            fri_final_poly_size: 16,
            mask_rows: p01_stark::air::merkle_path::MASK_ROWS,
            constrained_width: p01_stark::air::merkle_path::CONSTRAINED_TRACE_WIDTH,
            mask_len: p01_stark::air::merkle_path::mask_len_for_depth(p01_stark::air::merkle_path::CANONICAL_DEPTH),
        },
        Geometry {
            name: "C6 merkle_update",
            trace_width: p01_stark::air::merkle_update::TRACE_WIDTH,
            trace_length: 512,
            lde_size: 8192,
            merkle_depth: 13,
            quotient_segments: 8,
            num_queries: 22,
            fri_final_poly_size: 16,
            mask_rows: p01_stark::air::merkle_update::MASK_ROWS,
            constrained_width: p01_stark::air::merkle_update::CONSTRAINED_TRACE_WIDTH,
            mask_len: p01_stark::air::merkle_update::mask_len_for_depth(p01_stark::air::merkle_update::CANONICAL_DEPTH),
        },
        Geometry {
            name: "C7 spend",
            trace_width: p01_stark::air::spend::TRACE_WIDTH,
            trace_length: 512,
            lde_size: 8192,
            merkle_depth: 13,
            quotient_segments: 8,
            num_queries: 22,
            fri_final_poly_size: 32,
            mask_rows: p01_stark::air::spend::MASK_ROWS,
            constrained_width: p01_stark::air::spend::CONSTRAINED_TRACE_WIDTH,
            mask_len: p01_stark::air::spend::MASK_LEN,
        },
        Geometry {
            name: "C5 transfer",
            trace_width: p01_stark::air::transfer::TRACE_WIDTH,
            trace_length: 1024,
            lde_size: 16384,
            merkle_depth: 14,
            quotient_segments: 8,
            num_queries: 22,
            fri_final_poly_size: 16,
            mask_rows: p01_stark::air::transfer::MASK_ROWS,
            // C5 has no randomizer column: its committed width IS its
            // constrained width.
            constrained_width: p01_stark::air::transfer::TRACE_WIDTH,
            mask_len: p01_stark::air::transfer::MASK_LEN,
        },
    ]
}

// ---------------------------------------------------------------------------
// The full-wire parser.
//
// Field order is `serialize_generic_proof` (stark/src/compact.rs) read forward.
// The parse is required to land EXACTLY on `bytes.len()`: an off-by-one in any
// channel shows up as a panic here rather than as a plausible wrong count.
// ---------------------------------------------------------------------------

fn rd_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}
fn rd_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
}
fn rd_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(b[off..off + 2].try_into().unwrap())
}

#[derive(Debug)]
struct QueryBlock {
    position: u64,
    /// row | mirror | next | next-mirror — [ROUTE C], four rows of `trace_width`.
    trace: [Vec<u64>; 4],
    /// [B2/B4] the k segment values at the mirror position.
    quotient_mirror: Vec<u64>,
    /// Per committed FRI layer, the pair leaf's two halves.
    fri_lo: Vec<u64>,
    fri_hi: Vec<u64>,
}

#[derive(Debug)]
struct FullWire {
    ood_current: Vec<u64>,
    ood_next: Vec<u64>,
    ood_z: u64,
    ood_quotient: Vec<u64>,
    final_poly: Vec<u64>,
    queries: Vec<QueryBlock>,
    /// The segment-major tail: `num_queries * k` values at the query positions.
    quotient_tail: Vec<u64>,
}

fn parse_full_wire(bytes: &[u8], g: &Geometry) -> FullWire {
    let tw = g.trace_width;
    let k = g.quotient_segments;
    let mut off = 0usize;

    off += 32; // trace_root
    off += 32; // quotient_root
    let ood_current: Vec<u64> = (0..tw).map(|c| rd_u64(bytes, off + c * 8)).collect();
    off += tw * 8;
    let ood_next: Vec<u64> = (0..tw).map(|c| rd_u64(bytes, off + c * 8)).collect();
    off += tw * 8;
    let ood_z = rd_u64(bytes, off);
    off += 8;
    let ood_quotient: Vec<u64> = (0..k).map(|j| rd_u64(bytes, off + j * 8)).collect();
    off += k * 8;

    let num_fri_layers = bytes[off] as usize;
    off += 1;
    assert_eq!(
        num_fri_layers,
        g.fri_layers(),
        "{}: wire declares {num_fri_layers} FRI layers, geometry derives {}",
        g.name,
        g.fri_layers(),
    );
    off += 32 * num_fri_layers; // layer roots

    let ffps = rd_u16(bytes, off) as usize;
    off += 2;
    assert_eq!(ffps, g.fri_final_poly_size, "{}: fri_final_poly_size drift", g.name);
    let final_poly: Vec<u64> = (0..ffps).map(|i| rd_u64(bytes, off + i * 8)).collect();
    off += ffps * 8;

    off += 8; // grinding_nonce
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2;
    assert_eq!(num_queries, g.num_queries, "{}: num_queries drift", g.name);

    let mut queries = Vec::with_capacity(num_queries);
    for _ in 0..num_queries {
        let position = rd_u32(bytes, off) as u64;
        off += 4;
        let mut trace: [Vec<u64>; 4] = [vec![], vec![], vec![], vec![]];
        for slot in trace.iter_mut() {
            *slot = (0..tw).map(|c| rd_u64(bytes, off + c * 8)).collect();
            off += tw * 8;
        }
        off += (g.merkle_depth - 1) * 32; // trace pair path
        off += (g.merkle_depth - 1) * 32; // next-row trace pair path
        let quotient_mirror: Vec<u64> = (0..k).map(|j| rd_u64(bytes, off + j * 8)).collect();
        off += k * 8;
        off += (g.merkle_depth - 1) * 32; // quotient pair path

        let mut fri_lo = Vec::with_capacity(num_fri_layers);
        let mut fri_hi = Vec::with_capacity(num_fri_layers);
        for layer in 0..num_fri_layers {
            fri_lo.push(rd_u64(bytes, off));
            fri_hi.push(rd_u64(bytes, off + 8));
            off += 16;
            off += g.fri_layer_pair_path_bytes(layer);
        }
        queries.push(QueryBlock { position, trace, quotient_mirror, fri_lo, fri_hi });
    }

    let quotient_tail: Vec<u64> =
        (0..num_queries * k).map(|i| rd_u64(bytes, off + i * 8)).collect();
    off += num_queries * k * 8;

    assert_eq!(
        off,
        bytes.len(),
        "{}: the parse consumed {off} of {} bytes — a channel is mis-sized, and every \
         count below would have been wrong in a way that reads as plausible",
        g.name,
        bytes.len(),
    );

    FullWire { ood_current, ood_next, ood_z, ood_quotient, final_poly, queries, quotient_tail }
}

// ---------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Ledger {
    trace: usize,
    quotient: usize,
    /// Every FRI felt on the wire — both halves of every pair leaf.
    fri_all: usize,
    /// The half of each pair the fold does NOT pin: the genuinely new element.
    ///
    /// The verifier fold-checks ONE of `lo`/`hi` per layer per query
    /// (`verify.rs`, `let v = if j < half_next { lo } else { hi }`) and carries
    /// BOTH into the next fold. So one of the two is determined by the previous
    /// layer and the other is new information about `D` on a coset that is never
    /// opened.
    fri_new: usize,
    /// Terminal coefficients the prover is ALLOWED to make non-zero.
    terminal_live: usize,
    /// Terminal coefficients the verifier requires to be zero — pure padding.
    terminal_padding: usize,
    misc: usize,
}

impl Ledger {
    fn published(&self) -> usize {
        self.trace + self.quotient + self.fri_new + self.terminal_live + self.misc
    }
    fn published_counting_every_felt(&self) -> usize {
        self.trace + self.quotient + self.fri_all + self.terminal_live + self.misc
    }
}

fn ledger(w: &FullWire, g: &Geometry) -> Ledger {
    let trace = w.queries.iter().map(|q| q.trace.iter().map(|r| r.len()).sum::<usize>()).sum::<usize>()
        + w.ood_current.len()
        + w.ood_next.len();
    let quotient = w.queries.iter().map(|q| q.quotient_mirror.len()).sum::<usize>()
        + w.quotient_tail.len()
        + w.ood_quotient.len();
    let fri_all = w.queries.iter().map(|q| q.fri_lo.len() + q.fri_hi.len()).sum::<usize>();
    let fri_new = w.queries.iter().map(|q| q.fri_lo.len()).sum::<usize>();
    let terminal_live = w.final_poly.iter().filter(|&&c| c != 0).count();
    let terminal_padding = w.final_poly.len() - terminal_live;
    assert!(
        terminal_live <= g.fri_final_poly_size,
        "{}: terminal has more live coefficients than it has slots",
        g.name
    );
    Ledger { trace, quotient, fri_all, fri_new, terminal_live, terminal_padding, misc: 1 }
}

// ---------------------------------------------------------------------------
// Proof fixtures — one real proof per live circuit, over a DETERMINISTIC mask.
//
// ⚠️ A deterministic mask is adequate here and inadequate for secrecy, for the
// reason `air_aware_recovery_c7.rs` already records: a COUNT does not care how
// the mask was drawn, only that the prover drew `mask_dim` of them. The shipped
// prover rejection-samples from `getrandom` and refuses to build without it
// (`stark/src/lib.rs::draw_blinding_mask`).
// ---------------------------------------------------------------------------

fn xorshift_mask(seed: u64, len: usize) -> Vec<u64> {
    let mut z = seed | 1;
    (0..len)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % (P as u64)
        })
        .collect()
}

fn proof_for(g: &Geometry) -> Vec<u8> {
    use p01_stark::compact as c;
    // ⛔ The masks are drawn HERE rather than via `c*_deterministic_probe_mask`,
    // which sit behind `#[cfg(any(test, feature = "test-probes"))]`. An
    // integration test is external to the crate, so reaching them would mean
    // switching `test-probes` on for `p01-stark` -- and that feature must stay
    // off, because `wasmProbeScan.test.ts` scans the shipped blob for exactly
    // these symbols. A ledger of COUNTS does not care which mask was drawn.
    let mask = xorshift_mask(0x5EED_0000 ^ (g.mask_rows as u64), g.mask_len);
    match g.name {
        "C1 pool_commitment" => {
            c::generate_pool_commitment_proof(42, 17, 7, 11, &mask).proof_bytes
        }
        "C3 merkle_path" => {
            let d = p01_stark::air::merkle_path::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            assert_eq!(
                mask.len(),
                p01_stark::air::merkle_path::mask_len_for_depth(d),
                "C3 mask length must be what the circuit asks for at its canonical depth"
            );
            c::generate_merkle_path_compact_proof(777, &pe, &pi, &mask).proof_bytes
        }
        "C6 merkle_update" => {
            let d = p01_stark::air::merkle_update::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            assert_eq!(
                mask.len(),
                p01_stark::air::merkle_update::mask_len_for_depth(d),
                "C6 mask length must be what the circuit asks for at its canonical depth"
            );
            c::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &mask).proof_bytes
        }
        "C7 spend" => {
            let d = p01_stark::air::spend::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            c::generate_spend_compact_proof(42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &mask)
                .proof_bytes
        }
        "C5 transfer" => c::generate_transfer_compact_proof(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50, &mask,
        )
        .proof_bytes,
        other => panic!("no fixture for {other}"),
    }
}

// ---------------------------------------------------------------------------
// 1. The geometry rows are self-consistent, before any proof is built.
// ---------------------------------------------------------------------------

#[test]
fn geometry_rows_are_derived_not_typed() {
    for g in geometries() {
        assert_eq!(
            g.lde_size,
            g.trace_length * 16,
            "{}: lde_size must be trace_length * blowup(16)",
            g.name
        );
        assert_eq!(
            1usize << g.merkle_depth,
            g.lde_size,
            "{}: merkle_depth must be log2(lde_size)",
            g.name
        );
        assert!(g.mask_rows < g.trace_length, "{}: mask cannot exceed the trace", g.name);
    }
}

// ---------------------------------------------------------------------------
// 2. THE MEASUREMENT. Parse every live circuit's whole wire and count.
// ---------------------------------------------------------------------------

#[test]
fn the_whole_wire_counted_off_real_bytes() {
    println!();
    println!(
        "{:<20} {:>7} {:>8} {:>9} {:>8} {:>8} {:>9} {:>8}",
        "circuit", "bytes", "maskdim", "trace", "quot", "fri_new", "published", "verdict"
    );
    println!("{}", "-".repeat(84));

    for g in geometries() {
        let bytes = proof_for(&g);
        assert_eq!(
            bytes.len(),
            g.wire_size(),
            "{}: the proof is {} B, the geometry derives {} B",
            g.name,
            bytes.len(),
            g.wire_size(),
        );
        let w = parse_full_wire(&bytes, &g);
        let l = ledger(&w, &g);
        let dim = g.mask_dim();
        let verdict = if l.published() < dim { "UNDER" } else { "OVER" };
        println!(
            "{:<20} {:>7} {:>8} {:>9} {:>8} {:>8} {:>9} {:>8}",
            g.name,
            bytes.len(),
            dim,
            l.trace,
            l.quotient,
            l.fri_new,
            l.published(),
            verdict
        );
        // Two figures the headline row hides, both worth having on the record:
        //
        //  * `fri_all` counts BOTH halves of every pair leaf. Only half of them
        //    are new information (the fold pins the other), so quoting the raw
        //    wire count would overstate the leak by a factor of two.
        //  * `terminal_padding` is the number of final-poly coefficients the
        //    verifier REQUIRES to be zero. They are pure wire padding, and they
        //    are the reason "the terminal publishes 16 (or 32) values" is wrong.
        println!(
            "{:<20}   fri felts on the wire {:>4} (of which new {:>4}) | terminal live {} / padding {} = {} wasted bytes",
            "",
            l.fri_all,
            l.fri_new,
            l.terminal_live,
            l.terminal_padding,
            l.terminal_padding * 8,
        );
        assert!(
            l.published() < l.published_counting_every_felt(),
            "{}: every pair leaf publishes two halves, so the naive count must be the              larger one; if these ever agree the fold accounting has changed",
            g.name
        );
    }

    println!();
    println!("maskdim   = MASK_ROWS x trace_width, read from the circuit's own AIR constants.");
    println!("            The ONLY randomness in the prover (stark/src/lib.rs::draw_blinding_mask).");
    println!("trace     = 4 rows/query x width, plus the two OOD frames.");
    println!("quot      = k mirror felts/query + the segment-major tail + ood_quotient.");
    println!("fri_new   = one felt per committed layer per query: the half the fold does NOT pin.");
    println!("published = trace + quot + fri_new + live terminal coefficients + ood_z.");
    println!();
    println!("⛔ THE POOLED VERDICT ABOVE IS NOT SUFFICIENT ON ITS OWN — see the per-channel
split, which is the number that decides. Pooling puts the row mask and the
randomizer column on one side and everything published on the other, and those
two sources do NOT cover the same values: the randomizer column enters no
constraint, so it never reaches the quotient. A circuit can read UNDER pooled and
still be SHORT on channel A.

UNDER means the prover injects more randomness than the wire publishes. OVER means it does not.");
    println!();
    println!("🚨 AN EARLIER VERSION OF THIS LINE READ \"OVER means no simulator can exist\". THAT");
    println!("WAS WRONG, in the direction that matters: it presented a COUNTING statement as a");
    println!("ZERO-KNOWLEDGE result. A random-oracle simulator does not hide the transcript with");
    println!("the prover's randomness — it programs the oracle, fixes the query positions, and");
    println!("only has to be consistent where it will be opened. This ledger decides NOTHING");
    println!("about simulator existence, in either direction.");
    println!();
    println!("What OVER does mean is narrower and still worth having: the prover's own randomness");
    println!("cannot make the published transcript independent of the witness, so no INFORMATION-");
    println!("THEORETIC hiding argument runs off the mask alone. That is the only claim this file");
    println!("supports. ⛔ OVER also does NOT mean the witness is recoverable — see the header and");
    println!("`the_fri_channel_is_out_of_reach_of_a_linear_solver` below.");
}

// ---------------------------------------------------------------------------
// 3. WHY A LINEAR SOLVER CANNOT REACH THE FRI CHANNEL - measured, not argued.
//
// Each committed layer contributes ONE new field element per query. That element
// is an alpha-weighted combination of the DEEP composition `D` over a coset of
// layer-0 positions, and `D` at a position is linear in the trace values there
// (known basis) and in the QUOTIENT value there (unknown, unless that position
// happens to be opened).
//
// So the honest ledger for a linear attacker is not "equations vs mask" - it is
// "equations vs mask + one fresh unknown per unopened position touched". This
// test counts both.
// ---------------------------------------------------------------------------

#[test]
fn the_fri_channel_is_out_of_reach_of_a_linear_solver() {
    println!();
    for g in geometries() {
        let bytes = proof_for(&g);
        let w = parse_full_wire(&bytes, &g);

        // Positions whose quotient value the wire actually publishes: each query
        // position and its mirror.
        let half = (g.lde_size / 2) as u64;
        let mut known: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
        for q in &w.queries {
            known.insert(q.position);
            known.insert(q.position ^ half);
        }

        let mut equations = 0usize;
        let mut touched: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
        for q in &w.queries {
            for layer in 0..g.fri_layers() {
                equations += 1; // the one new felt this layer publishes
                // A layer-(layer+1) index collects the layer-0 positions
                // congruent to it modulo that layer domain size.
                let layer_size = (g.lde_size >> (layer + 1)) as u64;
                let j = q.position % layer_size;
                let mut p = j;
                while p < g.lde_size as u64 {
                    touched.insert(p);
                    p += layer_size;
                }
            }
        }
        let unopened = touched.iter().copied().filter(|p| !known.contains(p)).count();

        println!(
            "{:<20} fri equations {:>5} | layer-0 positions touched {:>6} | of those UNOPENED {:>6}",
            g.name, equations, touched.len(), unopened,
        );

        // The measurement that matters: the FRI channel introduces strictly more
        // unknowns than it contributes equations. A linear model of it is
        // vacuous, and "the solve did not close" over it would mean nothing -
        // exactly the shape of green this repository refuses.
        assert!(
            unopened > equations,
            "{}: FRI contributed {} equations against {} fresh unknowns - if this ever \
             reverses, a linear attack on the FRI channel becomes worth writing, and this \
             assertion is the thing that would tell you",
            g.name, equations, unopened,
        );
    }
    println!();
    println!("Read this as: the quotient value at every UNOPENED position is a fresh unknown, and");
    println!("the FRI folds reach far more positions than they publish equations. So the linear");
    println!("solver in air_aware_recovery_c*.rs cannot be pointed at this channel, and the");
    println!("counting result in the ledger above is a statement about SIMULATORS, not attacks.");
}

// ---------------------------------------------------------------------------
// 4. THE CONTROL - the parse feeds a solver that is known to work.
//
// A parser reading the wrong offsets would still produce a tidy ledger. So the
// trace channel this file extracts is handed to the SAME under-determination
// measurement `air_aware_recovery_c7.rs` runs, with its counterfactual: model
// the mask rows as copies of one another and the system must close; model them
// honestly and it must not. If the offsets were wrong, the counterfactual would
// stop closing and this test would fail.
// ---------------------------------------------------------------------------

const C7_GEN_512: u64 = 0x1905_D02A_5C41_1F4E;
const C7_GEN_8192: u64 = 0x1544_EF23_35D1_7997;
const C7_COSET_SHIFT: u64 = 7;
const C7_HASH_CYCLE_LEN: usize = 32;
const C7_HOLD_CONSTANT_LAST: usize = 3 * C7_HASH_CYCLE_LEN - 1; // 95
const C7_HOLD_COL: usize = 9;

fn lagrange_basis_at(i: usize, x: u64, n: usize, g: u64) -> u64 {
    let gi = fpow(g, i as u64);
    let num = fmul(gi, fsub(fpow(x, n as u64), 1));
    let den = fmul(n as u64, fsub(x, gi));
    fmul(num, finv(den))
}

fn c7_segments(collapse_mask: bool) -> Vec<Vec<usize>> {
    let first_free_row = p01_stark::air::spend::FIRST_FREE_ROW;
    let trace_len = 512usize;
    let first_free_cycle = first_free_row / C7_HASH_CYCLE_LEN;
    let mut segs: Vec<Vec<usize>> = vec![(0..=C7_HOLD_CONSTANT_LAST).collect()];
    for cycle in 3..first_free_cycle {
        segs.push((cycle * C7_HASH_CYCLE_LEN..(cycle + 1) * C7_HASH_CYCLE_LEN).collect());
    }
    if collapse_mask {
        segs.push((first_free_row..trace_len).collect());
    } else {
        for row in first_free_row..trace_len {
            segs.push(vec![row]);
        }
    }
    segs
}

fn push_node(x: u64, y: u64, nodes: &mut Vec<(u64, u64)>) {
    if !nodes.iter().any(|&(nx, _)| nx == x) {
        nodes.push((x, y));
    }
}

fn c7_nodes(w: &FullWire, g: &Geometry, col: usize) -> Vec<(u64, u64)> {
    let mut nodes: Vec<(u64, u64)> = Vec::new();
    let at = |pos: u64| fmul(C7_COSET_SHIFT, fpow(C7_GEN_8192, pos));
    let half = (g.lde_size / 2) as u64;

    push_node(w.ood_z, w.ood_current[col], &mut nodes);
    push_node(fmul(w.ood_z, C7_GEN_512), w.ood_next[col], &mut nodes);
    for q in &w.queries {
        let next_pos = (q.position + 16) % g.lde_size as u64;
        push_node(at(q.position), q.trace[0][col], &mut nodes);
        push_node(at(q.position ^ half), q.trace[1][col], &mut nodes);
        push_node(at(next_pos), q.trace[2][col], &mut nodes);
        push_node(at(next_pos ^ half), q.trace[3][col], &mut nodes);
    }
    nodes
}

fn build_system(nodes: &[(u64, u64)], segs: &[Vec<usize>], gen: u64, n: usize) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = segs
                .iter()
                .map(|seg| {
                    seg.iter().fold(0u64, |acc, &i| fadd(acc, lagrange_basis_at(i, x, n, gen)))
                })
                .collect();
            row.push(y);
            row
        })
        .collect()
}

fn solve(mut rows: Vec<Vec<u64>>, n: usize) -> Option<Vec<u64>> {
    let mut pivot_row = 0usize;
    let mut where_pivot = vec![usize::MAX; n];
    for col in 0..n {
        let Some(sel) = (pivot_row..rows.len()).find(|&r| rows[r][col] != 0) else {
            continue;
        };
        rows.swap(pivot_row, sel);
        let inv = finv(rows[pivot_row][col]);
        for c in col..=n {
            rows[pivot_row][c] = fmul(rows[pivot_row][c], inv);
        }
        for r in 0..rows.len() {
            if r != pivot_row && rows[r][col] != 0 {
                let f = rows[r][col];
                for c in col..=n {
                    rows[r][c] = fsub(rows[r][c], fmul(f, rows[pivot_row][c]));
                }
            }
        }
        where_pivot[col] = pivot_row;
        pivot_row += 1;
        if pivot_row == rows.len() {
            break;
        }
    }
    if where_pivot.iter().any(|&p| p == usize::MAX) {
        return None;
    }
    Some((0..n).map(|c| rows[where_pivot[c]][n]).collect())
}

#[test]
fn the_parser_feeds_a_working_solver() {
    let g = *geometries().iter().find(|g| g.name == "C7 spend").unwrap();
    let bytes = proof_for(&g);
    let w = parse_full_wire(&bytes, &g);

    let nodes = c7_nodes(&w, &g, C7_HOLD_COL);
    let r = 4 * g.num_queries + 2;
    // R = 4Q + 2 counts the openings PUBLISHED, not the DISTINCT abscissae.
    // `next_pos = pos + blowup` and the two mirrors are all derived from the
    // query positions, so two queries can land on the same point and the
    // de-duplication above drops it. On this fixture 86 of the 90 survive.
    // Asserting equality here is what a first draft of this control did, and it
    // failed for a reason that had nothing to do with the parse.
    println!("C7 trace channel: {} distinct abscissae out of R = {} published", nodes.len(), r);
    assert!(
        nodes.len() <= r,
        "de-duplication cannot INCREASE the node count past R = {}; {} means the parse invented abscissae",
        r,
        nodes.len()
    );
    assert!(
        nodes.len() > 3 * g.num_queries,
        "only {} distinct abscissae out of {} — that many collisions means the parse is reading one offset repeatedly",
        nodes.len(),
        r
    );

    // Honest model: every mask row is its own unknown. Must NOT close.
    let honest = c7_segments(false);
    let n_h = honest.len();
    assert!(
        solve(build_system(&nodes, &honest, C7_GEN_512, 512), n_h).is_none(),
        "the C7 trace system closed against an honest mask model - that would contradict \
         air_aware_recovery_c7.rs, so either the mask stopped working or this parse is wrong"
    );

    // The counterfactual: pretend the mask rows repeat. Must close.
    let collapsed = c7_segments(true);
    let n_c = collapsed.len();
    let sol = solve(build_system(&nodes, &collapsed, C7_GEN_512, 512), n_c).expect(
        "the collapse counterfactual did not close - the instrument is broken, and the \
         is_none() above therefore means nothing",
    );
    assert!(
        sol[0] != 0,
        "the recovered hold segment is zero; the counterfactual closed on a degenerate system"
    );
}

// ---------------------------------------------------------------------------
// 2b. THE SPLIT THAT DECIDES — per channel, because the two randomness sources
//     do not cover the same published values.
//
//   Channel A : the CONSTRAINED columns' openings, plus every quotient opening.
//               Covered ONLY by the row mask. The randomizer column enters no
//               constraint, so it never reaches `Q` and cannot help here.
//
//   Channel B : the randomizer column's own openings, plus the FRI layers, the
//               terminal and `ood_z` — everything that is a functional of the
//               DEEP composition `D`. Covered by the randomizer column, which
//               enters `D` through the gamma-RLC over all committed columns.
//
// ⛔ A POOLED LEDGER HIDES A DEFICIT HERE, and that is not hypothetical: on
// 2026-08-30 the pooled row read UNDER for all five circuits while C3 was still
// SHORT by 132 on channel A. Pooling is the false green this split exists to
// refuse.
// ---------------------------------------------------------------------------

#[test]
fn the_split_that_decides_per_channel() {
    println!();
    println!(
        "{:<20} {:>26}   {:>26}",
        "circuit", "CHANNEL A (mask)", "CHANNEL B (randomizer)"
    );
    println!("{}", "-".repeat(78));

    let mut short_on_a: Vec<&str> = Vec::new();
    for g in geometries() {
        let bytes = proof_for(&g);
        let w = parse_full_wire(&bytes, &g);
        let l = ledger(&w, &g);
        let r = 4 * g.num_queries + 2;

        let has_randomizer = g.trace_width > g.constrained_width;

        // Channel A
        let pub_a = g.constrained_width * r + l.quotient;
        let rand_a = g.mask_rows * g.constrained_width;

        // Channel B
        let pub_b = if has_randomizer { r } else { 0 } + l.fri_new + l.terminal_live + l.misc;
        let rand_b = if has_randomizer { g.trace_length } else { 0 };

        let mark = |p: usize, r: usize| if r > p { "OK " } else { "SHORT" };
        println!(
            "{:<20} {:>6} pub /{:>6} rnd {}   {:>6} pub /{:>6} rnd {}",
            g.name,
            pub_a,
            rand_a,
            mark(pub_a, rand_a),
            pub_b,
            rand_b,
            // ⛔ NOT " -- ". A circuit with no randomizer column publishes its FRI
            // layers and its terminal against ZERO randomness, which is SHORT, not
            // "not applicable". C5 is in that state and printing a dash for it is
            // how the gap stops being counted.
            mark(pub_b, rand_b),
        );

        // Channel A must hold on every circuit. It is the one the row mask owns,
        // and the one the recovery harnesses actually attack.
        if rand_a <= pub_a {
            short_on_a.push(g.name);
        }

        if has_randomizer {
            assert!(
                rand_b > pub_b,
                "{}: channel B is SHORT — the randomizer column publishes {} functionals \
                 of D against {} random coefficients. A column that does not cover its own \
                 openings blinds nothing, which is the state C1 was in at n = 256.",
                g.name,
                pub_b,
                rand_b,
            );
        }
    }

    println!();
    println!("Channel A = constrained-column openings + every quotient opening, against the");
    println!("            ROW MASK. The randomizer column cannot help: it enters no");
    println!("            constraint, so it never reaches Q.");
    println!("Channel B = the randomizer's own openings + FRI + terminal + ood_z, against the");
    println!("            randomizer column's TRACE_LENGTH coefficients.");
    println!();
    println!("⚠️ A POSITIVE MARGIN IS NECESSARY, NOT SUFFICIENT. It removes the counting");
    println!("   impossibility; it does not exhibit a simulator, and it does not measure");
    println!("   whether the available randomness has full RANK against what is published.");

    // C5 is deliberately NOT asserted on channel B: it has no randomizer column
    // and no on-chain consumer (`zk_shielded/src/lib.rs` has transfer and
    // unshield commented out). It is printed SHORT so the gap stays visible, and
    // it must be closed before C5 is ever put back in service.
    assert!(
        short_on_a.is_empty(),
        "channel A is SHORT on: {:?}. The row mask does not cover the constrained \
         openings plus the quotient, so no simulator exists for those circuits whatever \
         the pooled ledger says. The fix is more MASK ROWS (a depth cut, or a longer \
         trace) -- not another randomizer column, which never reaches Q.",
        short_on_a,
    );
}

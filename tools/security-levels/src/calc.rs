//! The soundness calculator.
//!
//! Every regime lists the error terms of the protocol the verifier runs
//! (DEEP-ALI over a batched, arity-2 FRI, Fiat-Shamir with SHA-256, grinding
//! before the queries), each as a probability, and combines them by a union
//! bound: the figure is `-log2(sum of the terms)`. A term is a count of "bad"
//! challenge values times the largest probability the sampler gives one value
//! (`challenge_prob`), except the query term, which is a power.
//!
//! Notation: n trace length, w width, k quotient segments, |D0| LDE size,
//! rho the FRI rate (`fri_final_poly_degree_bound / fri_final_poly_size`),
//! rho+ = (n + 2) / |D0|, L = w + k batched functions, r folding rounds of
//! arity a = 2, q queries, g grinding bits, C constraints, |F| = p^e.

use crate::params::{Sampler, StarkParams};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Regime {
    /// Theorem. BCHKS25 Thm 4.1 for the batching step (on |D0|, just inside
    /// the unique-decoding radius), BCIKS20 Thm 4.1 for every fold.
    UniqueDecoding,
    /// Sensitivity line: the same, with BCIKS20's `n / q` for the batching
    /// step too and the full radius (1 - rho) / 2. Printed by `--terms` and in
    /// the reproduction table, not a headline column.
    UniqueDecodingBciks20,
    /// Theorem. BCIKS20 Thm 8.3 in the batched form of Haböck 2022/1216
    /// Thm 2 / eq. (7), with Haböck's Thm 8 for DEEP-ALI. The headline.
    JohnsonBciks20,
    /// Theorem (2025). BCHKS25 Thm 4.2 correlated agreement for curves,
    /// composed over the FRI rounds as the EF `soundcalc` does. Informational.
    JohnsonBchks25,
    /// The repository's conjectured formula (`b1_deep_binding.rs`), a
    /// proximity-gaps-to-capacity assumption. Strong forms of that assumption
    /// were given counterexamples in 2025.
    Conjectured,
}

impl Regime {
    pub const HEADLINE: [Regime; 4] =
        [Regime::UniqueDecoding, Regime::JohnsonBciks20, Regime::JohnsonBchks25, Regime::Conjectured];
    pub const ALL: [Regime; 5] = [
        Regime::UniqueDecoding,
        Regime::UniqueDecodingBciks20,
        Regime::JohnsonBciks20,
        Regime::JohnsonBchks25,
        Regime::Conjectured,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Regime::UniqueDecoding => "unique-decoding",
            Regime::UniqueDecodingBciks20 => "unique-decoding-bciks20",
            Regime::JohnsonBciks20 => "johnson-bciks20",
            Regime::JohnsonBchks25 => "johnson-bchks25",
            Regime::Conjectured => "conjectured",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Regime::UniqueDecoding => "Unique decoding (theorem)",
            Regime::UniqueDecodingBciks20 => "Unique decoding, BCIKS20 bounds only (theorem)",
            Regime::JohnsonBciks20 => "Johnson, BCIKS20 (theorem, headline)",
            Regime::JohnsonBchks25 => "Johnson, BCHKS25 (theorem, 2025, informational)",
            Regime::Conjectured => "Conjectured (repository formula)",
        }
    }

    pub fn is_johnson(self) -> bool {
        matches!(self, Regime::JohnsonBciks20 | Regime::JohnsonBchks25)
    }
}

/// One error term: the probability that a cheating prover gets through it.
#[derive(Clone, Debug)]
pub struct Term {
    /// Row of the summary tables: "ALI", "DEEP", "FRI batching", "FRI folds",
    /// "FRI queries + grinding", "Field floor".
    pub group: &'static str,
    pub label: String,
    pub source: &'static str,
    pub prob: f64,
}

impl Term {
    pub fn bits(&self) -> f64 {
        -self.prob.log2()
    }
}

#[derive(Clone, Debug)]
pub struct RegimeResult {
    pub regime: Regime,
    pub sampler: Sampler,
    /// The Johnson multiplicity parameter m the figure was optimised over.
    pub m: Option<u32>,
    pub terms: Vec<Term>,
    /// `-log2(sum of terms)`: the union bound, interactive-oracle-proof terms
    /// only (the hash lines are applied on top, see `with_hash_cap`).
    pub bits: f64,
}

impl RegimeResult {
    /// Summed probability of one group of terms, as bits.
    pub fn group_bits(&self, group: &str) -> Option<f64> {
        let p: f64 = self.terms.iter().filter(|t| t.group == group).map(|t| t.prob).sum();
        if self.terms.iter().any(|t| t.group == group) {
            Some(-p.log2())
        } else {
            None
        }
    }
}

/// Smallest m the Johnson theorems allow (BCIKS20 Thm 5.1 / 8.3).
pub const M_MIN: u32 = 3;
/// Exclusive upper end of the exhaustive search over m.
pub const M_MAX: u32 = 65_536;

pub const SRC_ALI: &str = "Haböck 2022/1216 Thm 8, first term: L+ * C / |F|";
pub const SRC_DEEP: &str = "Haböck 2022/1216 Thm 8, second term: L+ * (k(n+1) + n - 1) / (|F| - |D0| - n)";
pub const SRC_UD_BATCH: &str = "BCHKS25 (eprint 2025/2055) Thm 4.1, curve of degree L-1 on D0: (L-1)(theta |D0| + 1), plus gamma = 0";
pub const SRC_UD_BATCH_BCIKS20: &str = "BCIKS20 (eprint 2020/654) Thm 1.5 with Thm 4.1: (L-1) |D0|, plus gamma = 0";
pub const SRC_UD_FOLD: &str = "BCIKS20 Thm 4.1 (unique decoding, lines): |D_(i+1)| per fold";
pub const SRC_UD_QUERY: &str = "(1 - theta)^q * 2^-g, theta = (1 - rho)/2 - 3/((1 - rho)|D0|)";
pub const SRC_UD_QUERY_BCIKS20: &str = "(1 - theta)^q * 2^-g, theta = (1 - rho)/2";
pub const SRC_J_BATCH: &str = "Haböck 2022/1216 eq. (7) = BCIKS20 Thm 8.3 batched: (L - 1/2)(m + 1/2)^7 |D0|^2 / (3 rho^(3/2) |F|)";
pub const SRC_J_FOLD: &str = "Haböck 2022/1216 eq. (7) = BCIKS20 Thm 8.3: (2m + 1)(|D0| + 1) sum(a_i) / (sqrt(rho) |F|)";
pub const SRC_J_QUERY: &str = "(sqrt(rho+) (1 + 1/2m))^q * 2^-g, Haböck 2022/1216 Thm 8";
pub const SRC_J25_BATCH: &str = "BCHKS25 Thm 4.2, curve of degree L-1 on D0, plus gamma = 0";
pub const SRC_J25_FOLD: &str =
    "BCHKS25 Thm 4.2, one line per fold on D_(i+1) (BCIKS20 Thm 5.1 where the folded code has dimension 1)";
pub const SRC_CONJ_FLOOR: &str = "b1_deep_binding.rs: (8n + (w + k + 1) + r |D0|) / |F|";
pub const SRC_CONJ_QUERY: &str = "b1_deep_binding.rs: 2^-(q log2(1/rho) + g)";

/// Probability that one of `draws` challenges lands in its bad set, the bad
/// sets holding `count` values in total. `excluded` is the size of the set a
/// uniform sampler rejects (the DEEP point avoids D0 and H).
///
/// For `U64ModP` the largest mass a value can carry is 2 / 2^64, and 4 / 2^64
/// for the value 1 (0 is mapped to 1), so `count` values carry at most
/// `(2 count + 2) / 2^64` per draw. That also covers the renormalisation of
/// the DEEP point's rejection (a factor below 1 + 2^-49) for any count under
/// 2^48.
fn challenge_prob(p: &StarkParams, sampler: Sampler, count: f64, draws: f64, excluded: f64) -> f64 {
    match sampler {
        Sampler::Uniform => count / (p.log2_field().exp2() - excluded),
        Sampler::U64ModP => {
            assert_eq!(p.ext_degree, 1, "the u64-mod-p sampler draws base-field elements");
            (2.0 * count + 2.0 * draws) / 64f64.exp2()
        }
    }
}

/// Everything a regime needs, precomputed once.
struct Shape {
    n: f64,
    w_k: f64,
    k: f64,
    d0: f64,
    rho: f64,
    rho_plus: f64,
    arity: f64,
    folds: u32,
    q: f64,
    g: f64,
    c: f64,
}

impl Shape {
    fn of(p: &StarkParams) -> Shape {
        Shape {
            n: p.trace_length as f64,
            w_k: p.batched_functions() as f64,
            k: p.quotient_segments as f64,
            d0: p.lde_size as f64,
            rho: p.rho(),
            rho_plus: p.rho_plus(),
            arity: p.fri_folding_arity as f64,
            folds: p.folds(),
            q: p.num_queries as f64,
            g: p.grinding_bits as f64,
            c: p.constraint_bound as f64,
        }
    }

    /// k (n + 1) + (n - 1): the degree the DEEP identity can have in z.
    fn deep_degree(&self) -> f64 {
        self.k * (self.n + 1.0) + (self.n - 1.0)
    }

    /// |D_(i+1)|, the domain fold i's correlated agreement lives on.
    fn folded_domain(&self, i: u32) -> f64 {
        self.d0 / self.arity.powi(i as i32 + 1)
    }
}

fn term(group: &'static str, label: impl Into<String>, source: &'static str, prob: f64) -> Term {
    Term { group, label: label.into(), source, prob }
}

fn finish(regime: Regime, sampler: Sampler, m: Option<u32>, terms: Vec<Term>) -> RegimeResult {
    let total: f64 = terms.iter().map(|t| t.prob).sum();
    RegimeResult { regime, sampler, m, terms, bits: -total.log2() }
}

// ── unique decoding ──────────────────────────────────────────────────────────

fn unique_decoding(p: &StarkParams, sampler: Sampler, bchks25_batching: bool) -> RegimeResult {
    let s = Shape::of(p);
    let delta = 1.0 - s.rho;
    // BCHKS25 Cor. 1.4 / Thm 4.1 hold for theta <= delta/2 - 3/(delta n); on
    // |D0| that costs a hair of radius. BCIKS20 Thm 4.1 holds up to delta/2.
    let theta = if bchks25_batching { delta / 2.0 - 3.0 / (delta * s.d0) } else { delta / 2.0 };
    let mut terms = vec![
        term("ALI", "ALI (constraint powers alpha, alpha_bnd)", SRC_ALI, challenge_prob(p, sampler, s.c, 2.0, 0.0)),
        term("DEEP", "DEEP point z", SRC_DEEP, challenge_prob(p, sampler, s.deep_degree(), 1.0, s.d0 + s.n)),
    ];
    let (batch_count, batch_src) = if bchks25_batching {
        ((s.w_k - 1.0) * (theta * s.d0 + 1.0) + 1.0, SRC_UD_BATCH)
    } else {
        ((s.w_k - 1.0) * s.d0 + 1.0, SRC_UD_BATCH_BCIKS20)
    };
    terms.push(term("FRI batching", "FRI batching (gamma powers)", batch_src, challenge_prob(p, sampler, batch_count, 1.0, 0.0)));
    for i in 0..s.folds {
        let count = (s.arity - 1.0) * s.folded_domain(i);
        terms.push(term("FRI folds", format!("FRI fold {}", i + 1), SRC_UD_FOLD, challenge_prob(p, sampler, count, 1.0, 0.0)));
    }
    let query_bits = -s.q * (1.0 - theta).log2() + s.g;
    let qsrc = if bchks25_batching { SRC_UD_QUERY } else { SRC_UD_QUERY_BCIKS20 };
    terms.push(term("FRI queries + grinding", "FRI queries + grinding", qsrc, (-query_bits).exp2()));
    let regime = if bchks25_batching { Regime::UniqueDecoding } else { Regime::UniqueDecodingBciks20 };
    finish(regime, sampler, None, terms)
}

// ── Johnson ──────────────────────────────────────────────────────────────────

// Each formula below exists once. The published figures (`johnson_emit`), the
// search over m and `tests/literature.rs` all call these functions; round 1 of
// WP1 found the published figures computed from inline copies of eq. (7) that
// the literature tests never reached.

/// Haböck 2022/1216 eq. (7), batching term, times |F|: the batching challenges
/// that break BCIKS20 Thm 8.3 for `l_functions` functions batched with the
/// powers of one challenge.
pub fn eq7_batching_count(l_functions: f64, m: u32, rho: f64, d0: f64) -> f64 {
    let mh = m as f64 + 0.5;
    (l_functions - 0.5) * mh.powi(7) / (3.0 * rho.powf(1.5)) * d0 * d0
}

/// Haböck 2022/1216 eq. (7), second term, times |F|: the folding challenges
/// that break a fold, summed over the rounds (`sum_arities` is the sum of a_i).
pub fn eq7_folds_count(m: u32, rho: f64, d0: f64, sum_arities: f64) -> f64 {
    (2.0 * m as f64 + 1.0) * (d0 + 1.0) * sum_arities / rho.sqrt()
}

/// log2 of eq. (7)'s commit-phase error, eps_C, of Haböck 2022/1216 (BCIKS20
/// Thm 8.3 for `l_functions` functions batched with powers of one challenge).
pub fn log2_batched_fri_commit_error(
    l_functions: f64,
    m: u32,
    rho: f64,
    d0: f64,
    sum_arities: f64,
    log2_field: f64,
) -> f64 {
    let field = log2_field.exp2();
    ((eq7_batching_count(l_functions, m, rho, d0) + eq7_folds_count(m, rho, d0, sum_arities)) / field).log2()
}

/// The Johnson list size L+ = (m + 1/2)/sqrt(rate), Haböck 2022/1216 Thm 8.
pub fn johnson_list_size(rate: f64, m: u32) -> f64 {
    (m as f64 + 0.5) / rate.sqrt()
}

/// sqrt(rate)(1 + 1/2m): the agreement a word outside the Johnson radius can
/// keep, which each query tests once.
pub fn johnson_agreement(rate: f64, m: u32) -> f64 {
    rate.sqrt() * (1.0 + 1.0 / (2.0 * m as f64))
}

/// log2 of the Johnson query error `(sqrt(rate) (1 + 1/2m))^queries`.
pub fn log2_johnson_query_error(rate: f64, m: u32, queries: u32) -> f64 {
    queries as f64 * johnson_agreement(rate, m).log2()
}

/// BCHKS25 Thm 4.2: bad challenges for a curve of degree `curve_degree` on a
/// domain of `nn` points, at distance `gamma`, multiplicity m. The theorem's
/// rho is the slightly reduced rate `rho - 1/nn`, which is 0 for a code of
/// dimension 1 (the last fold when the final polynomial is a constant): the
/// bound is void there, and that fold falls back to BCIKS20 Thm 5.1 (lines),
/// whose rate is the unreduced one.
fn bchks25_count(s: &Shape, m: u32, nn: f64, curve_degree: f64, gamma: f64) -> f64 {
    let mh = m as f64 + 0.5;
    if s.rho * nn < 2.0 {
        return curve_degree * mh.powi(7) * nn * nn / (3.0 * s.rho.powf(1.5));
    }
    let rho = s.rho - 1.0 / nn;
    curve_degree * ((2.0 * mh.powi(5) + 3.0 * mh * gamma * rho) / (3.0 * rho.powf(1.5)) * nn + mh / rho.sqrt())
}

/// A Johnson term's label, rendered only when a term list is built: the
/// search over m sums the same terms without allocating.
#[derive(Clone, Copy)]
enum JohnsonLabel {
    Ali,
    Deep,
    Batching,
    Fold(u32),
    Folds(u32),
    Queries,
}

impl JohnsonLabel {
    fn text(self) -> String {
        match self {
            JohnsonLabel::Ali => "ALI (constraint powers alpha, alpha_bnd)".to_string(),
            JohnsonLabel::Deep => "DEEP point z".to_string(),
            JohnsonLabel::Batching => "FRI batching (gamma powers)".to_string(),
            JohnsonLabel::Fold(i) => format!("FRI fold {i}"),
            JohnsonLabel::Folds(r) => format!("FRI folds ({r} rounds)"),
            JohnsonLabel::Queries => "FRI queries + grinding".to_string(),
        }
    }
}

/// Every term of a Johnson regime at multiplicity m, handed to `emit` as
/// (group, label, source, probability). The one implementation behind both
/// the published term lists (`johnson_terms`) and the search over m
/// (`johnson_bits_fast`).
fn johnson_emit(
    p: &StarkParams,
    s: &Shape,
    sampler: Sampler,
    m: u32,
    bchks25: bool,
    mut emit: impl FnMut(&'static str, JohnsonLabel, &'static str, f64),
) {
    let list = johnson_list_size(s.rho_plus, m);
    emit("ALI", JohnsonLabel::Ali, SRC_ALI, challenge_prob(p, sampler, list * s.c, 2.0, 0.0));
    emit("DEEP", JohnsonLabel::Deep, SRC_DEEP, challenge_prob(p, sampler, list * s.deep_degree(), 1.0, s.d0 + s.n));
    if bchks25 {
        let gamma = 1.0 - johnson_agreement(s.rho_plus, m);
        let batch = bchks25_count(s, m, s.d0, s.w_k - 1.0, gamma) + 1.0;
        emit("FRI batching", JohnsonLabel::Batching, SRC_J25_BATCH, challenge_prob(p, sampler, batch, 1.0, 0.0));
        for i in 0..s.folds {
            let count = bchks25_count(s, m, s.folded_domain(i), s.arity - 1.0, gamma);
            emit("FRI folds", JohnsonLabel::Fold(i + 1), SRC_J25_FOLD, challenge_prob(p, sampler, count, 1.0, 0.0));
        }
    } else {
        let batch = eq7_batching_count(s.w_k, m, s.rho, s.d0) + 1.0;
        emit("FRI batching", JohnsonLabel::Batching, SRC_J_BATCH, challenge_prob(p, sampler, batch, 1.0, 0.0));
        let folds = eq7_folds_count(m, s.rho, s.d0, s.arity * s.folds as f64);
        emit("FRI folds", JohnsonLabel::Folds(s.folds), SRC_J_FOLD, challenge_prob(p, sampler, folds, s.folds as f64, 0.0));
    }
    let query_bits = -log2_johnson_query_error(s.rho_plus, m, p.num_queries as u32) + s.g;
    emit("FRI queries + grinding", JohnsonLabel::Queries, SRC_J_QUERY, (-query_bits).exp2());
}

fn johnson_terms(p: &StarkParams, sampler: Sampler, m: u32, bchks25: bool) -> Vec<Term> {
    let s = Shape::of(p);
    let mut terms = Vec::new();
    johnson_emit(p, &s, sampler, m, bchks25, |group, label, source, prob| terms.push(term(group, label.text(), source, prob)));
    terms
}

fn johnson_at(p: &StarkParams, sampler: Sampler, m: u32, bchks25: bool) -> RegimeResult {
    let regime = if bchks25 { Regime::JohnsonBchks25 } else { Regime::JohnsonBciks20 };
    finish(regime, sampler, Some(m), johnson_terms(p, sampler, m, bchks25))
}

/// The same union bound as `johnson_at`, from the same terms, without
/// building the term list.
fn johnson_bits_fast(p: &StarkParams, s: &Shape, sampler: Sampler, m: u32, bchks25: bool) -> f64 {
    let mut total = 0.0;
    johnson_emit(p, s, sampler, m, bchks25, |_, _, _, prob| total += prob);
    -total.log2()
}

fn johnson_best(p: &StarkParams, sampler: Sampler, bchks25: bool) -> RegimeResult {
    let s = Shape::of(p);
    let mut best_m = M_MIN;
    let mut best = johnson_bits_fast(p, &s, sampler, M_MIN, bchks25);
    for m in (M_MIN + 1)..M_MAX {
        let bits = johnson_bits_fast(p, &s, sampler, m, bchks25);
        if bits > best + 1e-12 {
            best = bits;
            best_m = m;
        }
    }
    johnson_at(p, sampler, best_m, bchks25)
}

// ── conjectured ──────────────────────────────────────────────────────────────

fn conjectured(p: &StarkParams, sampler: Sampler) -> RegimeResult {
    let s = Shape::of(p);
    let count = 8.0 * s.n + (s.w_k + 1.0) + s.folds as f64 * s.d0;
    // z, gamma and one alpha per fold
    let draws = 2.0 + s.folds as f64;
    let query_bits = s.q * (1.0 / s.rho).log2() + s.g;
    let terms = vec![
        term("Field floor", "Fiat-Shamir field floor", SRC_CONJ_FLOOR, challenge_prob(p, sampler, count, draws, 0.0)),
        term("FRI queries + grinding", "FRI queries + grinding", SRC_CONJ_QUERY, (-query_bits).exp2()),
    ];
    finish(Regime::Conjectured, sampler, None, terms)
}

// ── entry points ─────────────────────────────────────────────────────────────

/// The figure of `p` in `regime` under `sampler`. Johnson regimes return the
/// best m in `M_MIN..M_MAX`.
pub fn evaluate(p: &StarkParams, regime: Regime, sampler: Sampler) -> RegimeResult {
    match regime {
        Regime::UniqueDecoding => unique_decoding(p, sampler, true),
        Regime::UniqueDecodingBciks20 => unique_decoding(p, sampler, false),
        Regime::JohnsonBciks20 => johnson_best(p, sampler, false),
        Regime::JohnsonBchks25 => johnson_best(p, sampler, true),
        Regime::Conjectured => conjectured(p, sampler),
    }
}

/// `evaluate` at a fixed m (Johnson regimes; the other regimes ignore m).
pub fn evaluate_at_m(p: &StarkParams, regime: Regime, sampler: Sampler, m: u32) -> RegimeResult {
    match regime {
        Regime::JohnsonBciks20 => johnson_at(p, sampler, m, false),
        Regime::JohnsonBchks25 => johnson_at(p, sampler, m, true),
        other => evaluate(p, other, sampler),
    }
}

/// The two figures exactly as `b1_deep_binding.rs` derives them:
/// `min(query term, 64 - log2(8n + w + k + 1 + r |D0|))` with the query term
/// `q log2(2/(1+rho)) + g` (unconditional) or `q log2(1/rho) + g`
/// (conjectured). A minimum, not a union bound, and uniform challenges.
#[derive(Clone, Copy, Debug)]
pub struct RepoFigures {
    pub unconditional: f64,
    pub conjectured: f64,
}

pub fn repo_convention(p: &StarkParams) -> RepoFigures {
    let s = Shape::of(p);
    let field_terms = 8.0 * s.n + (s.w_k + 1.0) + s.folds as f64 * s.d0;
    let field_floor = 64.0 * p.ext_degree as f64 - field_terms.log2();
    RepoFigures {
        unconditional: (s.q * (2.0 / (1.0 + s.rho)).log2() + s.g).min(field_floor),
        conjectured: (s.q * (1.0 / s.rho).log2() + s.g).min(field_floor),
    }
}

/// Quantum line: Chiesa-Manohar-Spooner (TCC 2019) put the BCS transform in
/// the quantum random-oracle model with error O(t^2 eps + t^3 / 2^h) for t
/// queries, so the interactive bits are halved and the hash contributes h/3.
pub fn quantum_bits(iop_bits: f64, hash_bits: u32) -> f64 {
    (iop_bits / 2.0).min(hash_bits as f64 / 3.0)
}

/// Classical line with the Merkle and transcript hash: the BCS transform in
/// the random-oracle model adds O(t^2 / 2^h), so the figure is capped at h/2.
pub fn with_hash_cap(iop_bits: f64, hash_bits: u32) -> f64 {
    iop_bits.min(hash_bits as f64 / 2.0)
}

/// A hash-collision line: the generic birthday bound (classical) and the
/// Brassard-Høyer-Tapp bound (quantum, which needs about as much quantum
/// memory as it makes queries), on the NOMINAL output size.
#[derive(Clone, Debug)]
pub struct HashLine {
    pub slug: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    pub output_bits: f64,
    pub collision: f64,
    pub collision_quantum: f64,
}

fn hash_line(slug: &'static str, name: &'static str, role: &'static str, output_bits: f64) -> HashLine {
    HashLine { slug, name, role, output_bits, collision: output_bits / 2.0, collision_quantum: output_bits / 3.0 }
}

pub fn hash_lines() -> Vec<HashLine> {
    vec![
        hash_line(
            "sha256",
            "SHA-256",
            "Merkle trees and the Fiat-Shamir transcript, v1 and v2",
            crate::params::SHA256_BITS as f64,
        ),
        hash_line(
            "v1-digest",
            "Poseidon t=3, one Goldilocks element (v1)",
            "leaf commitments and pool Merkle nodes (finding F2: deposit once, spend twice)",
            64.0,
        ),
        hash_line(
            "v2-digest",
            "Poseidon2 width 12, four Goldilocks elements (v2 design)",
            "leaf commitments, nullifiers and Merkle nodes",
            64.0 * crate::params::V2_DIGEST_FELTS as f64,
        ),
    ]
}

/// The integer a document may quote: nothing larger than the value.
pub fn floor_bits(x: f64) -> u32 {
    if x <= 0.0 {
        0
    } else {
        x.floor() as u32
    }
}

/// Two decimals, truncated, so a printed figure never exceeds the value.
pub fn trunc2(x: f64) -> f64 {
    (x * 100.0).floor() / 100.0
}

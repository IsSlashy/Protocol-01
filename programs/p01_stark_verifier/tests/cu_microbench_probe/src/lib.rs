//! Compute-unit micro-benchmark probe (WP0f, protocol v2 groundwork, 2026-09-19).
//!
//! DESIGN-V2 §2.2 fits the verifier's phase-1 cost as
//! `F + q·(a + b·w + c_node·N_nodes + c_L·L + h·ffps)` over the eight
//! `cu_budget` pins, and prices profile R from that fit plus three primitives
//! nobody had measured on SBF: a Goldilocks multiply, a cubic-extension
//! multiply and a SHA-256 Merkle node. The only per-multiply figure in the tree,
//! the "~216 CU/mul" in `verify.rs`'s inv_gen comment, had no measurement
//! behind it. This program runs each primitive n times on operands read from
//! instruction data, so `tests/cu_microbench.rs` can read the cost of one
//! operation off the slope of `compute_units_consumed` against n.
//!
//! It is not a verifier, it checks nothing, and it is never deployed.
//!
//! # Faithfulness
//!
//! * `Felt` and the Merkle helpers are the verifier's own `src/goldilocks.rs`
//!   and `src/merkle.rs`, included with `#[path]`, not copied.
//! * `merkle.rs` imports `solana_sha256_hasher::hashv`. This crate has no
//!   dependencies, so `extern crate self as solana_sha256_hasher` makes that
//!   import resolve to [`hashv`] below, a transcription of the SBF branch of
//!   solana-sha256-hasher 2.3.0 (`src/lib.rs:41-51`): one `sol_sha256` syscall
//!   over the caller's slice list. The harness checks every hash this program
//!   returns against the host `sha2` implementation, so a wrong transcription
//!   fails there, not silently.
//! * The cubic extension F_p[x]/(x^3 - x - 1) does not exist in the verifier
//!   yet (WP3 writes it). The two multiplies below are the textbook ones, built
//!   only from the real `Felt` operations, and the harness checks both against
//!   an independent u128 reference. They price the straightforward
//!   implementation; a lazy-reduction one would do fewer reductions.
//! * The release profile in `Cargo.toml` mirrors the workspace's, overflow
//!   checks included.
//!
//! # Against measuring nothing
//!
//! * every operand comes from instruction data, so nothing folds at compile
//!   time;
//! * every result goes back through `sol_set_return_data`, which the compiler
//!   cannot see through, and the harness compares it with its own reference;
//! * the chain length n is read at run time, and the harness requires the cost
//!   to be linear in n.
//!
//! # Instruction data
//!
//! `[0]` variant, `[1..5]` n (u32 LE), `[5..]` the variant's operands (u64 LE
//! unless stated otherwise at the variant). Accounts: none; the entry point
//! refuses any, because an account would shift the data offset.

#![allow(dead_code)]
#![allow(unexpected_cfgs)]

// `merkle.rs` says `use solana_sha256_hasher::hashv;`. An `extern crate` at the
// crate root enters the extern prelude, so that path now names this crate.
extern crate self as solana_sha256_hasher;

// ---------------------------------------------------------------------------
// The real verifier sources. No copies, no drift.
// ---------------------------------------------------------------------------

#[path = "../../../src/goldilocks.rs"]
pub mod goldilocks;

#[path = "../../../src/merkle.rs"]
pub mod merkle;

use goldilocks::Felt;

// ---------------------------------------------------------------------------
// Syscalls, declared by hand so the crate has no cargo dependency at all.
// ---------------------------------------------------------------------------

extern "C" {
    /// `sol_sha256`. No trailing underscore (see `../c7_probe/src/lib.rs`).
    /// `vals` points at `(ptr, len)` pairs, the memory layout of `&[&[u8]]`.
    fn sol_sha256(vals: *const u8, val_len: u64, hash_result: *mut u8) -> u64;

    /// `sol_set_return_data`: 100 CU + len / 250, the same for every run of a
    /// variant because the returned length is fixed per variant.
    fn sol_set_return_data(data: *const u8, length: u64);
}

/// Stand-in for `solana_hash::Hash`: `merkle.rs` only calls `.to_bytes()`.
pub struct Hash([u8; 32]);

impl Hash {
    pub fn to_bytes(self) -> [u8; 32] {
        self.0
    }
}

/// solana-sha256-hasher 2.3.0 `hashv`, SBF branch (`src/lib.rs:41-51`),
/// transcribed: one syscall over the slice list, result returned by value.
pub fn hashv(vals: &[&[u8]]) -> Hash {
    let mut hash_result = [0u8; 32];
    unsafe {
        sol_sha256(
            vals as *const _ as *const u8,
            vals.len() as u64,
            &mut hash_result as *mut _ as *mut u8,
        );
    }
    Hash(hash_result)
}

// ---------------------------------------------------------------------------
// Variants. `tests/cu_microbench.rs` mirrors these numbers; a mismatch fails
// its reference check, because the program then computes something else.
// ---------------------------------------------------------------------------

/// Parse + return data. Operands: none. Returns n as u64.
pub const V_BASELINE: u8 = 0;
/// n × `Felt::mul`, `acc = acc · b`, 8 per loop iteration. Operands: a, b.
pub const V_MUL: u8 = 1;
/// n × `Felt::add`, `acc = acc + b`, 8 per loop iteration. Operands: a, b.
pub const V_ADD: u8 = 2;
/// n × `acc = (acc + b)^-1` with `Felt::inv` (Fermat). Operands: a, b.
pub const V_INV: u8 = 3;
/// n × cubic-extension multiply, Karatsuba (6 base muls), 8 per iteration.
/// Operands: a0, a1, a2, b0, b1, b2. Returns 3 × u64.
pub const V_E3_MUL_KARATSUBA: u8 = 4;
/// n × cubic-extension multiply, schoolbook (9 base muls), 8 per iteration.
/// Operands as `V_E3_MUL_KARATSUBA`.
pub const V_E3_MUL_SCHOOLBOOK: u8 = 5;
/// n × (cubic-extension element · base-field scalar), 3 base muls, 8 per
/// iteration. Operands: a0, a1, a2, s. Returns 3 × u64.
pub const V_E3_MUL_BASE: u8 = 6;
/// n × `merkle::hash_pair(&cur, &sib)`, the verifier's tagged node hash
/// `H(0x01 ‖ l ‖ r)`. Operands: cur (32 B), sib (32 B). Returns 32 B.
pub const V_SHA_NODE: u8 = 7;
/// One `merkle::verify_merkle_path` of depth n, the walk the verifier runs per
/// query per tree. Operands: root (32 B), index (u32 LE), leaf_len (u32 LE),
/// leaf (leaf_len B), path (n × 32 B). Returns 1 byte: 1 accepted, 0 refused.
pub const V_MERKLE_PATH: u8 = 8;

pub const ERR_ACCOUNTS: u64 = 1;
pub const ERR_SHORT_DATA: u64 = 2;
pub const ERR_UNKNOWN_VARIANT: u64 = 3;
pub const ERR_N_NOT_MULTIPLE_OF_8: u64 = 4;
pub const ERR_SHORT_OPERANDS: u64 = 5;

// ---------------------------------------------------------------------------
// Cubic extension F_p[x]/(x^3 - x - 1), built from the real Felt operations.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct E3(pub Felt, pub Felt, pub Felt);

/// Fold a degree-4 product with x^3 = x + 1 and x^4 = x^2 + x.
#[inline]
fn e3_reduce(c0: Felt, c1: Felt, c2: Felt, c3: Felt, c4: Felt) -> E3 {
    E3(c0.add(c3), c1.add(c3).add(c4), c2.add(c4))
}

/// 6 base multiplies, 13 base additions or subtractions, then the fold.
#[inline]
pub fn e3_mul_karatsuba(a: E3, b: E3) -> E3 {
    let v0 = a.0.mul(b.0);
    let v1 = a.1.mul(b.1);
    let v2 = a.2.mul(b.2);
    let c1 = a.0.add(a.1).mul(b.0.add(b.1)).sub(v0).sub(v1);
    let c2 = a.0.add(a.2).mul(b.0.add(b.2)).sub(v0).sub(v2).add(v1);
    let c3 = a.1.add(a.2).mul(b.1.add(b.2)).sub(v1).sub(v2);
    e3_reduce(v0, c1, c2, c3, v2)
}

/// 9 base multiplies, 4 base additions, then the fold.
#[inline]
pub fn e3_mul_schoolbook(a: E3, b: E3) -> E3 {
    let c0 = a.0.mul(b.0);
    let c1 = a.0.mul(b.1).add(a.1.mul(b.0));
    let c2 = a.0.mul(b.2).add(a.1.mul(b.1)).add(a.2.mul(b.0));
    let c3 = a.1.mul(b.2).add(a.2.mul(b.1));
    let c4 = a.2.mul(b.2);
    e3_reduce(c0, c1, c2, c3, c4)
}

/// An extension element times a base-field scalar: 3 base multiplies.
#[inline]
pub fn e3_mul_base(a: E3, s: Felt) -> E3 {
    E3(a.0.mul(s), a.1.mul(s), a.2.mul(s))
}

// ---------------------------------------------------------------------------
// The chains. `#[inline(never)]` keeps each one a separate function, so its
// entry cost sits in the intercept and only the loop body sits in the slope.
// ---------------------------------------------------------------------------

/// Eight copies of one statement: the loop's own compare-and-branch is then
/// paid once per eight operations.
macro_rules! x8 {
    ($s:expr) => {
        $s;
        $s;
        $s;
        $s;
        $s;
        $s;
        $s;
        $s;
    };
}

#[inline(never)]
fn mul_chain(mut acc: Felt, b: Felt, iters: u32) -> Felt {
    for _ in 0..iters {
        x8!(acc = acc.mul(b));
    }
    acc
}

#[inline(never)]
fn add_chain(mut acc: Felt, b: Felt, iters: u32) -> Felt {
    for _ in 0..iters {
        x8!(acc = acc.add(b));
    }
    acc
}

#[inline(never)]
fn inv_chain(mut acc: Felt, b: Felt, n: u32) -> Felt {
    for _ in 0..n {
        acc = acc.add(b).inv();
    }
    acc
}

#[inline(never)]
fn e3_karatsuba_chain(mut acc: E3, b: E3, iters: u32) -> E3 {
    for _ in 0..iters {
        x8!(acc = e3_mul_karatsuba(acc, b));
    }
    acc
}

#[inline(never)]
fn e3_schoolbook_chain(mut acc: E3, b: E3, iters: u32) -> E3 {
    for _ in 0..iters {
        x8!(acc = e3_mul_schoolbook(acc, b));
    }
    acc
}

#[inline(never)]
fn e3_base_chain(mut acc: E3, s: Felt, iters: u32) -> E3 {
    for _ in 0..iters {
        x8!(acc = e3_mul_base(acc, s));
    }
    acc
}

#[inline(never)]
fn sha_node_chain(mut cur: [u8; 32], sib: &[u8; 32], n: u32) -> [u8; 32] {
    for _ in 0..n {
        cur = merkle::hash_pair(&cur, sib);
    }
    cur
}

#[inline(never)]
fn merkle_path(root: &[u8; 32], leaf: &[u8], index: usize, path: &[u8]) -> bool {
    merkle::verify_merkle_path(root, leaf, index, path)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[inline(always)]
fn u64_at(d: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[off..off + 8]);
    u64::from_le_bytes(b)
}

#[inline(always)]
fn u32_at(d: &[u8], off: usize) -> u32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&d[off..off + 4]);
    u32::from_le_bytes(b)
}

#[inline(always)]
fn felt_at(d: &[u8], off: usize) -> Felt {
    Felt::new(u64_at(d, off))
}

#[inline(always)]
fn e3_at(d: &[u8], off: usize) -> E3 {
    E3(felt_at(d, off), felt_at(d, off + 8), felt_at(d, off + 16))
}

#[inline(always)]
fn bytes32_at(d: &[u8], off: usize) -> [u8; 32] {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[off..off + 32]);
    b
}

#[inline(always)]
fn e3_bytes(e: E3) -> [u8; 24] {
    let mut out = [0u8; 24];
    out[..8].copy_from_slice(&e.0.as_u64().to_le_bytes());
    out[8..16].copy_from_slice(&e.1.as_u64().to_le_bytes());
    out[16..].copy_from_slice(&e.2.as_u64().to_le_bytes());
    out
}

fn set_return(bytes: &[u8]) {
    unsafe { sol_set_return_data(bytes.as_ptr(), bytes.len() as u64) }
}

/// Run one variant. Returns 0 on success, or an `ERR_*` code.
fn run(data: &[u8]) -> u64 {
    if data.len() < 5 {
        return ERR_SHORT_DATA;
    }
    let variant = data[0];
    let n = u32_at(data, 1);
    let ops = &data[5..];
    let need = |len: usize| ops.len() >= len;
    let unrolled = matches!(
        variant,
        V_MUL | V_ADD | V_E3_MUL_KARATSUBA | V_E3_MUL_SCHOOLBOOK | V_E3_MUL_BASE
    );
    if unrolled && n % 8 != 0 {
        return ERR_N_NOT_MULTIPLE_OF_8;
    }
    let iters = n / 8;

    match variant {
        V_BASELINE => set_return(&(n as u64).to_le_bytes()),
        V_MUL | V_ADD | V_INV => {
            if !need(16) {
                return ERR_SHORT_OPERANDS;
            }
            let (a, b) = (felt_at(ops, 0), felt_at(ops, 8));
            let r = match variant {
                V_MUL => mul_chain(a, b, iters),
                V_ADD => add_chain(a, b, iters),
                _ => inv_chain(a, b, n),
            };
            set_return(&r.as_u64().to_le_bytes());
        }
        V_E3_MUL_KARATSUBA | V_E3_MUL_SCHOOLBOOK => {
            if !need(48) {
                return ERR_SHORT_OPERANDS;
            }
            let (a, b) = (e3_at(ops, 0), e3_at(ops, 24));
            let r = if variant == V_E3_MUL_KARATSUBA {
                e3_karatsuba_chain(a, b, iters)
            } else {
                e3_schoolbook_chain(a, b, iters)
            };
            set_return(&e3_bytes(r));
        }
        V_E3_MUL_BASE => {
            if !need(32) {
                return ERR_SHORT_OPERANDS;
            }
            let r = e3_base_chain(e3_at(ops, 0), felt_at(ops, 24), iters);
            set_return(&e3_bytes(r));
        }
        V_SHA_NODE => {
            if !need(64) {
                return ERR_SHORT_OPERANDS;
            }
            let sib = bytes32_at(ops, 32);
            let r = sha_node_chain(bytes32_at(ops, 0), &sib, n);
            set_return(&r);
        }
        V_MERKLE_PATH => {
            if !need(40) {
                return ERR_SHORT_OPERANDS;
            }
            let root = bytes32_at(ops, 0);
            let index = u32_at(ops, 32) as usize;
            let leaf_len = u32_at(ops, 36) as usize;
            let path_len = n as usize * 32;
            if !need(40 + leaf_len + path_len) {
                return ERR_SHORT_OPERANDS;
            }
            let leaf = &ops[40..40 + leaf_len];
            let path = &ops[40 + leaf_len..40 + leaf_len + path_len];
            let ok = merkle_path(&root, leaf, index, path);
            set_return(&[ok as u8]);
        }
        _ => return ERR_UNKNOWN_VARIANT,
    }
    0
}

/// Raw SBF entry point; `cargo-build-sbf` links with `--entry=entrypoint`.
///
/// With zero accounts the serialised input is `[0..8]` num_accounts = 0,
/// `[8..16]` instruction-data length, `[16..]` the data (same parse as
/// `../c7_probe`).
///
/// # Safety
/// `input` is the runtime's buffer; the reads stay inside the 16-byte header
/// and the declared instruction data.
#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    let num_accounts = core::ptr::read_unaligned(input as *const u64);
    if num_accounts != 0 {
        return ERR_ACCOUNTS;
    }
    let data_len = core::ptr::read_unaligned(input.add(8) as *const u64) as usize;
    let data = core::slice::from_raw_parts(input.add(16), data_len);
    run(data)
}

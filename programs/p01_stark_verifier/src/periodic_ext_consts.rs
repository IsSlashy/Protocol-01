//! [A4] Periodic-extension constants for circuits 3 (merkle_path) and 6
//! (merkle_update).
//!
//! # Why these exist
//! Both AIRs gate every periodic column on `active_rows = depth * 32 = 480`, so
//! trace cycle 15 (rows 480..=511) is zero-filled. That single truncation
//! destroys 32-periodicity: the interpolants in `periodic_consts` are 512/512
//! dense with coefficient-index gcd 1, and a dense Horner (512 muls per column,
//! 7 columns per circuit) is the dominant cost of DEEP-ALI phase 2.
//!
//! The 32-periodic *extension* — the column continued through cycle 15 instead
//! of truncated — is stride-16 sparse (32 non-zero coefficients, gcd 16), and
//! the two differ on exactly the 32 rows 480..=511. So
//!
//! ```text
//! P_actual(z) = P_periodic(z) − Σ_{j=0}^{31} TAIL[j] · L_{480+j}(z)
//! L_r(z)      = g^r · (z^N − 1) / (N · (z − g^r)),  N = 512, g = GENERATOR_512
//! ```
//!
//! This is an algebraic identity on the *same* polynomial: no AIR change, no
//! trace change, no wire-format change, zero soundness cost.
//!
//! # Provenance
//! Generated from the dense `C3_*_COEFFS` / `C6_*_COEFFS` tables in
//! `periodic_consts.rs` by `tests/a4_probe.rs::a4_emit_consts` (run with
//! `--ignored`). Regenerate whenever those tables are rebaked.
//!
//! # Pinning
//! `tests/periodic_stride.rs` re-derives every value here from the dense tables
//! and checks the identity at random `z` against a dense Horner, in **release**
//! mode. A rebake of `periodic_consts.rs` that is not mirrored here fails that
//! test rather than silently changing the polynomial the verifier evaluates.

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_RC0_COEFFS`.
/// `P_periodic(x) = Σ_k C3_RC0_PERIODIC16[k] · x^(16k)`.
pub const C3_RC0_PERIODIC16: [u64; 32] = [
    0xC1A9FC17AFE6859A, 0x65833EB5F3C607E9, 0x0DF26A7702AA0648, 0x0BDEA367441EFF57,
    0x515C0CB4406B7AC4, 0x61EC0DF33B3EBDA4, 0x994DAB312212C207, 0xBFBDF089BDC19A6C,
    0xE4D9FEA22DFF38BB, 0xB45DCF767A9CC884, 0xE356FA411CEFF256, 0x2D03440A62F809A1,
    0x51333C383B548D6B, 0x0025044F25B1C869, 0x357A7516BA7D5551, 0xA41F6DD81DD48187,
    0xA19AC598CEE9652B, 0x47B62BCBAD121AD3, 0x6126223F16237B29, 0x458ADDE28A2D1013,
    0x9122DFD12AA9C82D, 0xD72D8A708C2E2B1B, 0xD9CD23CD7AA23973, 0x9401AF7432009394,
    0x002EE07F3E5EDCAB, 0x9888EF879E2F8B75, 0x6E030D3B0C2EDD9A, 0xB9C8EA8187E1812C,
    0xDC77CE7B4B8680DD, 0xDBFF18CEDF6FF201, 0x31BAD2AC7EB0B146, 0x76E166B8B72665A8,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_RC0_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_RC1_COEFFS`.
/// `P_periodic(x) = Σ_k C3_RC1_PERIODIC16[k] · x^(16k)`.
pub const C3_RC1_PERIODIC16: [u64; 32] = [
    0x8ADEDD292D895B59, 0xEB6D662D5330F9BB, 0x5EB081128D22CFD4, 0xA97913A1E294B840,
    0x7C76DC04BB53264B, 0x83761A41D704BA38, 0xE5CB86C974A6E8DC, 0x77925180191CAED9,
    0xDD2E27178787AFB2, 0x2F3FC6D7A3B34EFF, 0x2364535CC343F3AA, 0xED8301154B32DB7F,
    0x5AE332D931D37DDB, 0x53152152B1931985, 0x139C2B11AAFE6DBA, 0xC41EC8866E52FC6C,
    0x6D329C0C0D75117A, 0xEEF3E64E44995FDD, 0xA1E1DA466A87F52A, 0xC7AB3C652A94E33A,
    0x2450E345595F15A2, 0x3EF0513CF7D93F42, 0xF2F8E5977E8BCBA6, 0x51E0643D69C398F7,
    0x2D070DBF17883C2A, 0xDA8CE14EE5E29EFA, 0x2C67842560B95F7C, 0xF2020B59A77E5288,
    0xB242D33ECBAE0B61, 0xDBF685498BE2B9A7, 0x1CF3B9E0DFF806A5, 0x7FF2CB644350426A,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_RC1_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_RC2_COEFFS`.
/// `P_periodic(x) = Σ_k C3_RC2_PERIODIC16[k] · x^(16k)`.
pub const C3_RC2_PERIODIC16: [u64; 32] = [
    0xAC5D8A4EEAC6C386, 0x3C00C29D47E085A2, 0x9910D969BCCE093D, 0xD0386165861F0538,
    0xBDC2AF89D05D40B4, 0x76AD21EC7CDF0FA0, 0x81449C194B7E276F, 0x04E7E945DFDE5DDB,
    0x2CD2159E6DEF5010, 0x20C398EFD920DDA0, 0x23F8EFFCB2BB0543, 0x2EFA27E4E7222776,
    0x204DB53584C0DE52, 0x9558CC0874BA6E67, 0xFE011678CBE205D0, 0x25942B14F6BA86CB,
    0xA804F22443584D28, 0x32BABB24DF61066A, 0x13C299FA5915B7F4, 0xD6616EB81343CB87,
    0xD88FCDE8A901E9F1, 0xB8660290813DC458, 0x32B8B000E1CD5646, 0x27908A4BDFDBD4A4,
    0x5D1A43AE82216BE9, 0x6623563E3ED28A5E, 0x13711EC19AF44AE4, 0x5235CEA8DD651235,
    0xD706211070BF1A45, 0x2BF3A4672E8E25A4, 0x65E4525A492CA711, 0x98F09D79E6DEF29B,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_RC2_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_ROUND_ACTIVE_COEFFS`.
/// `P_periodic(x) = Σ_k C3_ROUND_ACTIVE_PERIODIC16[k] · x^(16k)`.
pub const C3_ROUND_ACTIVE_PERIODIC16: [u64; 32] = [
    0x0FFFFFFFF0000001, 0x007FFE0000000200, 0x0080000000080000, 0xFFFF7FDF00008001,
    0xFFFFF7FF00080001, 0xFFFFFFFEFFFFFF7F, 0xFFFF800700007FF9, 0x2000000080000000,
    0xF7FFF7FF08000001, 0xFF7FFFFF02000001, 0xFFFFFFFEFFF7FF81, 0xFFE07FFF001F8001,
    0x00000807FFFFFFF8, 0xFFFDFFFF00000081, 0xFFFFFFF780000009, 0xFFFFFFFE7FFFE001,
    0x0000000000000000, 0x008001FFFFFFFE00, 0xFF7FFFFF00080001, 0xFFFF801F00008001,
    0xFFFFF7FEFFF80001, 0xFFFFFFFEFFFFFF83, 0x00008007FFFF7FF8, 0xDFFFFFFF80000001,
    0xF80007FF08000001, 0xFF7FFFFEFE000001, 0xFFFFFFFEFFF80081, 0x00207FFFFFDF8000,
    0x000007F800000008, 0x0002000000000080, 0xFFFFFFF680000009, 0xFFFFFFFE80002001,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_ROUND_ACTIVE_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_HASH_START_COEFFS`.
/// `P_periodic(x) = Σ_k C3_HASH_START_PERIODIC16[k] · x^(16k)`.
pub const C3_HASH_START_PERIODIC16: [u64; 32] = [
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_HASH_START_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_IS_BOUNDARY_COEFFS`.
/// `P_periodic(x) = Σ_k C3_IS_BOUNDARY_PERIODIC16[k] · x^(16k)`.
pub const C3_IS_BOUNDARY_PERIODIC16: [u64; 32] = [
    0xF7FFFFFF08000001, 0x000001FFFFFFFE00, 0xFF7FFFFF00000001, 0x0000002000000000,
    0xFFFFFFFEFFF80001, 0x0000000000000002, 0x00007FFFFFFF8000, 0xDFFFFFFF00000001,
    0x0000080000000000, 0xFFFFFFFEFE000001, 0x0000000000000080, 0x001FFFFFFFE00000,
    0xFFFFFFF700000009, 0x0002000000000000, 0xFFFFFFFE80000001, 0x0000000000002000,
    0x07FFFFFFF8000000, 0xFFFFFDFF00000201, 0x0080000000000000, 0xFFFFFFDF00000001,
    0x0000000000080000, 0xFFFFFFFEFFFFFFFF, 0xFFFF7FFF00008001, 0x2000000000000000,
    0xFFFFF7FF00000001, 0x0000000002000000, 0xFFFFFFFEFFFFFF81, 0xFFDFFFFF00200001,
    0x00000007FFFFFFF8, 0xFFFDFFFF00000001, 0x0000000080000000, 0xFFFFFFFEFFFFE001,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_IS_BOUNDARY_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C3_IS_INTERIOR_COEFFS`.
/// `P_periodic(x) = Σ_k C3_IS_INTERIOR_PERIODIC16[k] · x^(16k)`.
pub const C3_IS_INTERIOR_PERIODIC16: [u64; 32] = [
    0x0FFFFFFFF0000001, 0x07FFFDFFF8000200, 0x087FFFFFF8000000, 0x07FFFFDFF8000000,
    0x07FFFFFFF8080000, 0x07FFFFFFF7FFFFFE, 0x07FF7FFFF8008000, 0x27FFFFFFF8000000,
    0x07FFF7FFF8000000, 0x07FFFFFFFA000000, 0x07FFFFFFF7FFFF80, 0x07DFFFFFF8200000,
    0x08000007F7FFFFF8, 0x07FDFFFFF8000000, 0x0800000078000000, 0x07FFFFFFF7FFE000,
    0x0000000000000000, 0x080001FFF7FFFE00, 0x077FFFFFF8000000, 0x0800001FF8000000,
    0x07FFFFFFF7F80000, 0x07FFFFFFF8000002, 0x08007FFFF7FF8000, 0xE7FFFFFEF8000001,
    0x080007FFF8000000, 0x07FFFFFFF6000000, 0x07FFFFFFF8000080, 0x081FFFFFF7E00000,
    0x07FFFFF7F8000008, 0x0801FFFFF8000000, 0x07FFFFFF78000000, 0x07FFFFFFF8002000,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C3_IS_INTERIOR_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_RC0_COEFFS`.
/// `P_periodic(x) = Σ_k C6_RC0_PERIODIC16[k] · x^(16k)`.
pub const C6_RC0_PERIODIC16: [u64; 32] = [
    0xC1A9FC17AFE6859A, 0x65833EB5F3C607E9, 0x0DF26A7702AA0648, 0x0BDEA367441EFF57,
    0x515C0CB4406B7AC4, 0x61EC0DF33B3EBDA4, 0x994DAB312212C207, 0xBFBDF089BDC19A6C,
    0xE4D9FEA22DFF38BB, 0xB45DCF767A9CC884, 0xE356FA411CEFF256, 0x2D03440A62F809A1,
    0x51333C383B548D6B, 0x0025044F25B1C869, 0x357A7516BA7D5551, 0xA41F6DD81DD48187,
    0xA19AC598CEE9652B, 0x47B62BCBAD121AD3, 0x6126223F16237B29, 0x458ADDE28A2D1013,
    0x9122DFD12AA9C82D, 0xD72D8A708C2E2B1B, 0xD9CD23CD7AA23973, 0x9401AF7432009394,
    0x002EE07F3E5EDCAB, 0x9888EF879E2F8B75, 0x6E030D3B0C2EDD9A, 0xB9C8EA8187E1812C,
    0xDC77CE7B4B8680DD, 0xDBFF18CEDF6FF201, 0x31BAD2AC7EB0B146, 0x76E166B8B72665A8,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_RC0_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_RC1_COEFFS`.
/// `P_periodic(x) = Σ_k C6_RC1_PERIODIC16[k] · x^(16k)`.
pub const C6_RC1_PERIODIC16: [u64; 32] = [
    0x8ADEDD292D895B59, 0xEB6D662D5330F9BB, 0x5EB081128D22CFD4, 0xA97913A1E294B840,
    0x7C76DC04BB53264B, 0x83761A41D704BA38, 0xE5CB86C974A6E8DC, 0x77925180191CAED9,
    0xDD2E27178787AFB2, 0x2F3FC6D7A3B34EFF, 0x2364535CC343F3AA, 0xED8301154B32DB7F,
    0x5AE332D931D37DDB, 0x53152152B1931985, 0x139C2B11AAFE6DBA, 0xC41EC8866E52FC6C,
    0x6D329C0C0D75117A, 0xEEF3E64E44995FDD, 0xA1E1DA466A87F52A, 0xC7AB3C652A94E33A,
    0x2450E345595F15A2, 0x3EF0513CF7D93F42, 0xF2F8E5977E8BCBA6, 0x51E0643D69C398F7,
    0x2D070DBF17883C2A, 0xDA8CE14EE5E29EFA, 0x2C67842560B95F7C, 0xF2020B59A77E5288,
    0xB242D33ECBAE0B61, 0xDBF685498BE2B9A7, 0x1CF3B9E0DFF806A5, 0x7FF2CB644350426A,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_RC1_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_RC2_COEFFS`.
/// `P_periodic(x) = Σ_k C6_RC2_PERIODIC16[k] · x^(16k)`.
pub const C6_RC2_PERIODIC16: [u64; 32] = [
    0xAC5D8A4EEAC6C386, 0x3C00C29D47E085A2, 0x9910D969BCCE093D, 0xD0386165861F0538,
    0xBDC2AF89D05D40B4, 0x76AD21EC7CDF0FA0, 0x81449C194B7E276F, 0x04E7E945DFDE5DDB,
    0x2CD2159E6DEF5010, 0x20C398EFD920DDA0, 0x23F8EFFCB2BB0543, 0x2EFA27E4E7222776,
    0x204DB53584C0DE52, 0x9558CC0874BA6E67, 0xFE011678CBE205D0, 0x25942B14F6BA86CB,
    0xA804F22443584D28, 0x32BABB24DF61066A, 0x13C299FA5915B7F4, 0xD6616EB81343CB87,
    0xD88FCDE8A901E9F1, 0xB8660290813DC458, 0x32B8B000E1CD5646, 0x27908A4BDFDBD4A4,
    0x5D1A43AE82216BE9, 0x6623563E3ED28A5E, 0x13711EC19AF44AE4, 0x5235CEA8DD651235,
    0xD706211070BF1A45, 0x2BF3A4672E8E25A4, 0x65E4525A492CA711, 0x98F09D79E6DEF29B,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_RC2_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_ROUND_ACTIVE_COEFFS`.
/// `P_periodic(x) = Σ_k C6_ROUND_ACTIVE_PERIODIC16[k] · x^(16k)`.
pub const C6_ROUND_ACTIVE_PERIODIC16: [u64; 32] = [
    0x0FFFFFFFF0000001, 0x007FFE0000000200, 0x0080000000080000, 0xFFFF7FDF00008001,
    0xFFFFF7FF00080001, 0xFFFFFFFEFFFFFF7F, 0xFFFF800700007FF9, 0x2000000080000000,
    0xF7FFF7FF08000001, 0xFF7FFFFF02000001, 0xFFFFFFFEFFF7FF81, 0xFFE07FFF001F8001,
    0x00000807FFFFFFF8, 0xFFFDFFFF00000081, 0xFFFFFFF780000009, 0xFFFFFFFE7FFFE001,
    0x0000000000000000, 0x008001FFFFFFFE00, 0xFF7FFFFF00080001, 0xFFFF801F00008001,
    0xFFFFF7FEFFF80001, 0xFFFFFFFEFFFFFF83, 0x00008007FFFF7FF8, 0xDFFFFFFF80000001,
    0xF80007FF08000001, 0xFF7FFFFEFE000001, 0xFFFFFFFEFFF80081, 0x00207FFFFFDF8000,
    0x000007F800000008, 0x0002000000000080, 0xFFFFFFF680000009, 0xFFFFFFFE80002001,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_ROUND_ACTIVE_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_HASH_START_COEFFS`.
/// `P_periodic(x) = Σ_k C6_HASH_START_PERIODIC16[k] · x^(16k)`.
pub const C6_HASH_START_PERIODIC16: [u64; 32] = [
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
    0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001, 0xF7FFFFFF08000001,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_HASH_START_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_IS_BOUNDARY_COEFFS`.
/// `P_periodic(x) = Σ_k C6_IS_BOUNDARY_PERIODIC16[k] · x^(16k)`.
pub const C6_IS_BOUNDARY_PERIODIC16: [u64; 32] = [
    0xF7FFFFFF08000001, 0x000001FFFFFFFE00, 0xFF7FFFFF00000001, 0x0000002000000000,
    0xFFFFFFFEFFF80001, 0x0000000000000002, 0x00007FFFFFFF8000, 0xDFFFFFFF00000001,
    0x0000080000000000, 0xFFFFFFFEFE000001, 0x0000000000000080, 0x001FFFFFFFE00000,
    0xFFFFFFF700000009, 0x0002000000000000, 0xFFFFFFFE80000001, 0x0000000000002000,
    0x07FFFFFFF8000000, 0xFFFFFDFF00000201, 0x0080000000000000, 0xFFFFFFDF00000001,
    0x0000000000080000, 0xFFFFFFFEFFFFFFFF, 0xFFFF7FFF00008001, 0x2000000000000000,
    0xFFFFF7FF00000001, 0x0000000002000000, 0xFFFFFFFEFFFFFF81, 0xFFDFFFFF00200001,
    0x00000007FFFFFFF8, 0xFFFDFFFF00000001, 0x0000000080000000, 0xFFFFFFFEFFFFE001,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_IS_BOUNDARY_TAIL: [u64; 32] = [0; 32];

/// Stride-16 compressed coefficients of the 32-periodic extension of `C6_IS_INTERIOR_COEFFS`.
/// `P_periodic(x) = Σ_k C6_IS_INTERIOR_PERIODIC16[k] · x^(16k)`.
pub const C6_IS_INTERIOR_PERIODIC16: [u64; 32] = [
    0x0FFFFFFFF0000001, 0x07FFFDFFF8000200, 0x087FFFFFF8000000, 0x07FFFFDFF8000000,
    0x07FFFFFFF8080000, 0x07FFFFFFF7FFFFFE, 0x07FF7FFFF8008000, 0x27FFFFFFF8000000,
    0x07FFF7FFF8000000, 0x07FFFFFFFA000000, 0x07FFFFFFF7FFFF80, 0x07DFFFFFF8200000,
    0x08000007F7FFFFF8, 0x07FDFFFFF8000000, 0x0800000078000000, 0x07FFFFFFF7FFE000,
    0x0000000000000000, 0x080001FFF7FFFE00, 0x077FFFFFF8000000, 0x0800001FF8000000,
    0x07FFFFFFF7F80000, 0x07FFFFFFF8000002, 0x08007FFFF7FF8000, 0xE7FFFFFEF8000001,
    0x080007FFF8000000, 0x07FFFFFFF6000000, 0x07FFFFFFF8000080, 0x081FFFFFF7E00000,
    0x07FFFFF7F8000008, 0x0801FFFFF8000000, 0x07FFFFFF78000000, 0x07FFFFFFF8002000,
];

/// Values the 32-periodic extension takes on trace rows 480..=511, where the
/// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row
/// `480 + j`. These are subtracted back out via the Lagrange correction.
/// [ZK-MASK 2026-08-30] IDENTICALLY ZERO, and that is the measurement.
///
/// This table held the DEVIATION between the 32-periodic extension of the
/// column and the column itself on rows 480..511, back when the walk
/// truncated there. Under the depth-11 layout C3 and C6 build these seven
/// columns 32-periodic on ALL 512 rows, so the extension IS the column and
/// the deviation is zero everywhere. `verify.rs` stopped reading them on
/// 2026-08-24 (see the "the seven C3_*_TAIL tables are dead" note); they
/// stay, zeroed, because `periodic_stride` asserts the zero. A NON-ZERO
/// value reappearing here means the AIR truncates its periodic columns
/// again -- which re-imposes the Poseidon rounds across the blinding rows
/// and turns the masked rows back into constrained ones. That is a PRIVACY
/// regression, not a bookkeeping change, and the zero is what catches it.
pub const C6_IS_INTERIOR_TAIL: [u64; 32] = [0; 32];


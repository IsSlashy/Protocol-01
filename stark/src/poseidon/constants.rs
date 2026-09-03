//! Poseidon round constants and MDS matrices for Goldilocks field.
//!
//! Field: p = 2^64 - 2^32 + 1 (Goldilocks)
//! S-box: x^7 (alpha = 7)
//!
//! The "Security level: 128 bits" this header used to assert is removed, not
//! lowered: nothing in this repository measures a security level for this
//! permutation, and the figure came attached to the provenance below.
//!
//! THE PROVENANCE OF THESE CONSTANTS IS UNVERIFIED. Measured 2026-09-03.
//!
//! This header used to say the round constants came from a Grain LFSR seeded
//! with (p, t, R_f, R_p, alpha), that the MDS matrices were verified, and that
//! both matched Polygon Miden / Plonky2. Nothing in this repository reproduces
//! that generator, and the values carry structure a Grain LFSR would not
//! produce. Measured in the field (differences mod p, not mod 2^64):
//!
//!   ROUND_CONSTANTS_T3   10 of 89 successive differences fall in a family of
//!                        three values within 0x4400 of each other, at
//!                        positions 44..71, which is rounds 14 to 24
//!   ROUND_CONSTANTS_T5   4 of 149, all one value, rounds 15 to 19
//!
//! For random constants the chance that any two successive differences even
//! coincide is about one in 10^16. Whatever produced these had an additive
//! step in it. The values themselves are distinct and all inside the field.
//!
//! What that means, exactly: an arithmetic relation between round constants is
//! the structure invariant-subspace attacks on Poseidon-like permutations look
//! for, and their usual target is the PARTIAL-round block. This permutation
//! has no partial rounds (see the note on ROUND_CONSTANTS_T3), so the standard
//! attack shape does not apply as written. That is not a security argument,
//! and nobody here has made one.
//!
//! DO NOT CHANGE A VALUE IN THIS FILE. Every commitment, nullifier and Merkle
//! node in the deployed pools runs through these constants; a new value
//! orphans every note that exists. Regenerating them is a migration, not an
//! edit. `poseidon_provenance.rs` pins the measurement above so a silent
//! regeneration is visible.
//! Reference: https://eprint.iacr.org/2019/458

use winterfell::math::fields::f64::BaseElement;

// ============================================================================
// t = 3 (width 3, rate 2, capacity 1) — for Poseidon(1) and Poseidon(2)
// ============================================================================

/// 90 constants: 30 rounds x 3 lanes.
///
/// THE ROUND LABELS BELOW ARE THE LAYOUT THIS FILE WAS WRITTEN FOR, NOT WHAT
/// THE CODE DOES. They say R_f=8 (4+4 full) + R_p=22 partial, while
/// `poseidon/mod.rs::permutation_t3` applies a FULL S-box to every lane on all
/// 30 rounds. Full rounds throughout is strictly more work than the split
/// these labels describe, so the divergence is conservative: the labels are
/// wrong, not the permutation. They stay because they index the array.
pub const ROUND_CONSTANTS_T3: [BaseElement; 90] = [
    // Round 0 (full)
    BaseElement::new(0xa98e4673f9036e0b), BaseElement::new(0x3db4a488e825c32a), BaseElement::new(0x60de653e0ed43e20),
    // Round 1 (full)
    BaseElement::new(0x8b4f0d2b6ea19313), BaseElement::new(0x2f97e83e60e2c4dd), BaseElement::new(0xacea6e9af6c2c725),
    // Round 2 (full)
    BaseElement::new(0xd5604eef12e3cabc), BaseElement::new(0x1eb9db12a1e71b79), BaseElement::new(0x7ad5966d3a790d0d),
    // Round 3 (full)
    BaseElement::new(0xbfae604e2c72e1d9), BaseElement::new(0x5fa21f2143c2f72a), BaseElement::new(0xc3ae00cf4d83d5b8),
    // Rounds 4..25 (22 partial rounds)
    BaseElement::new(0x9e8d1423cd728e2f), BaseElement::new(0x45d8e40e789c13ab), BaseElement::new(0x6b9e0d183d0b0e71),
    BaseElement::new(0x8a15b14c28d50c0a), BaseElement::new(0xd1eef5afe2c45c82), BaseElement::new(0x3c914bfff61cc9d3),
    BaseElement::new(0xf7d2a1f9ab51e8c4), BaseElement::new(0x2e4d3b16c89f0a55), BaseElement::new(0xb8f0e1d7a3c24b96),
    BaseElement::new(0x5169e0d4f3812c47), BaseElement::new(0x0af31e8bc2d57698), BaseElement::new(0x94b6e123d8f40c49),
    BaseElement::new(0xe2c9f5670ab18d3a), BaseElement::new(0x7b30e894f1d26c0b), BaseElement::new(0x14a3d7c6e810fb5c),
    BaseElement::new(0xad76e0b1f934ca0d), BaseElement::new(0x46d9e3825c01a9be), BaseElement::new(0xe01c67da3f24586f),
    BaseElement::new(0x799fe120d347b680), BaseElement::new(0x12028bcda6f0e531), BaseElement::new(0xab45c7feb9132482),
    BaseElement::new(0x4468e041dc360373), BaseElement::new(0xdd8bf16e0f590264), BaseElement::new(0x76aee291325c0155),
    BaseElement::new(0x0fd1d3b465bf0046), BaseElement::new(0xa804e4c798020f37), BaseElement::new(0x4127f5ea0b256e28),
    BaseElement::new(0xda4ae60d3e480d19), BaseElement::new(0x736dd73071bb4c0a), BaseElement::new(0x0c90c8439ede8afb),
    BaseElement::new(0xa5c3d966d2019bec), BaseElement::new(0x3ef6ea89050490dd), BaseElement::new(0xd829fb0c382b5fce),
    BaseElement::new(0x715d0c2f6b4e7ebf), BaseElement::new(0x0a801d528a719db0), BaseElement::new(0xa3b32e75bdb4bca1),
    BaseElement::new(0x3ce63f98f0d7db92), BaseElement::new(0xd6194abd2400fa83), BaseElement::new(0x6f4c5be057241974),
    BaseElement::new(0x087f6ce38a473865), BaseElement::new(0xa1a27e06bd6a5756), BaseElement::new(0x3ad58f29f08d7647),
    BaseElement::new(0xd408a04d239067b8), BaseElement::new(0x6d3bb170568340a9), BaseElement::new(0x066ed293899c5f9a),
    BaseElement::new(0x9fa1e3b6bcbf7e8b), BaseElement::new(0x38d4f4d9efe29d7c), BaseElement::new(0xd20805fd13057c6d),
    BaseElement::new(0x6b3b17202a282b5e), BaseElement::new(0x046e2843540b4a4f), BaseElement::new(0x9da13966872e6940),
    BaseElement::new(0x36d44a89ba516831), BaseElement::new(0xcf075bacfd745722), BaseElement::new(0x683a6cd020574613),
    BaseElement::new(0x016d7df353ba3504), BaseElement::new(0x9aa08f1686dd13f5), BaseElement::new(0x33d3a039b90032e6),
    // Round 26 (full)
    BaseElement::new(0xcd06b15cec6351d7), BaseElement::new(0x6639c28019a670c8), BaseElement::new(0xff6cd3a34cc94fb9),
    // Round 27 (full)
    BaseElement::new(0x989fe4c67fec6eaa), BaseElement::new(0x31d2f5e9b30f4d9b), BaseElement::new(0xcb060d0ce6326c8c),
    // Round 28 (full)
    BaseElement::new(0x6439180fe231ab7d), BaseElement::new(0xfd6c29261546ca6e), BaseElement::new(0x969f3a84487be95f),
    // Round 29 (full)
    BaseElement::new(0x2fd24ac7b8c50850), BaseElement::new(0xc90555eaeb981741), BaseElement::new(0x62386b17de5c3632),
    // Padding rounds (identity, not used — ensures trace fills power-of-2)
    BaseElement::new(0xfb5b7448e86c4523), BaseElement::new(0x94ae8524217f3414), BaseElement::new(0x2dd19647549a2305),
    BaseElement::new(0xc6f4a76a879d01f6), BaseElement::new(0x5f17b18dbac0e0e7), BaseElement::new(0xf83acbb0ede3bfd8),
    BaseElement::new(0x915ddc43210c9ec9), BaseElement::new(0x2a80ed66544fbdba), BaseElement::new(0xc3a3fe8987b2bcab),
];

/// MDS matrix for t=3 (circulant construction).
pub const MDS_MATRIX_T3: [[BaseElement; 3]; 3] = [
    [BaseElement::new(3), BaseElement::new(1), BaseElement::new(1)],
    [BaseElement::new(1), BaseElement::new(3), BaseElement::new(1)],
    [BaseElement::new(1), BaseElement::new(1), BaseElement::new(3)],
];

// ============================================================================
// t = 5 (width 5, rate 4, capacity 1) — for Poseidon(4)
// ============================================================================

/// Total rounds for t=5: R_f=8 + R_p=22 = 30 rounds
/// Each round needs 5 constants -> 30 * 5 = 150 constants
pub const ROUND_CONSTANTS_T5: [BaseElement; 150] = [
    // Round 0 (full)
    BaseElement::new(0xb7e151628aed2a6a), BaseElement::new(0xbf7158809cf4f3c7), BaseElement::new(0x62e7160f38b4da56),
    BaseElement::new(0xa784d9045190cfef), BaseElement::new(0x324e7738926cfbe5),
    // Round 1 (full)
    BaseElement::new(0xf4bf8d8d8c31d763), BaseElement::new(0xda06c80abb1185eb), BaseElement::new(0x4f7c7b5757f59584),
    BaseElement::new(0x90cfb3cd64e4e3a3), BaseElement::new(0x2dbfeb4d9c0fcde5),
    // Round 2 (full)
    BaseElement::new(0xc9a4f775d2a2e2f0), BaseElement::new(0x5b8e3f48db1fda22), BaseElement::new(0x1c62e34b64a057a5),
    BaseElement::new(0xab59e0bcc5c40e5c), BaseElement::new(0x6de2fa50f6b2ca19),
    // Round 3 (full)
    BaseElement::new(0x8c3a7b40e72a9bf7), BaseElement::new(0x3e0c6df83c1b85dc), BaseElement::new(0xf1d5e88bf6e8e56c),
    BaseElement::new(0x72be5d74f27b896a), BaseElement::new(0x0a0761de51c31ebe),
    // Rounds 4..25 (22 partial rounds) — 22*5 = 110 values
    BaseElement::new(0xd0e15823a72bed58), BaseElement::new(0x6234c0f42a3e7af1), BaseElement::new(0x0b879cf7e16a8c90),
    BaseElement::new(0xa1bd72c0f43e5132), BaseElement::new(0x338d1c12a5f04ad1),
    BaseElement::new(0xc57db38fe26b5a70), BaseElement::new(0x67a97831c14d410f), BaseElement::new(0x09c53c8af26291ae),
    BaseElement::new(0xabe7fa032b24584d), BaseElement::new(0x3e0ab45c0cd5feec),
    BaseElement::new(0xd02d6e84ef08a58b), BaseElement::new(0x624f187718db4c2a), BaseElement::new(0x0471c2a94fae12c9),
    BaseElement::new(0xa6946cf28120d968), BaseElement::new(0x38b71e5bb243a007),
    BaseElement::new(0xcad9c88ce366e6a6), BaseElement::new(0x5cfc7215f489cd45), BaseElement::new(0xef1f1b9e25ac93e4),
    BaseElement::new(0x81424067570f5a83), BaseElement::new(0x1364ea90885f2122),
    BaseElement::new(0xa5879439b9821fc1), BaseElement::new(0x37aa3de2eaa50660), BaseElement::new(0xc9ccf78c1bc7ccff),
    BaseElement::new(0x5bef6105455e939e), BaseElement::new(0xee11fabe7795ba3d),
    BaseElement::new(0x8034a367a8d860dc), BaseElement::new(0x12574d00da1b277b), BaseElement::new(0xa479f6d90c3dee1a),
    BaseElement::new(0x369cb0721f6094b9), BaseElement::new(0xc8bed50b50835b58),
    BaseElement::new(0x5ae17ea481a621f7), BaseElement::new(0xed048eddced8e896), BaseElement::new(0x7f27390e000f6f35),
    BaseElement::new(0x1149e2970632f5d4), BaseElement::new(0xa36c8c2037561c73),
    BaseElement::new(0x358f3549689d4312), BaseElement::new(0xc7b1dec29abfe9b1), BaseElement::new(0x59d488dccce2b050),
    BaseElement::new(0xebf7321c0005b6ef), BaseElement::new(0x7e19db5533289d8e),
    BaseElement::new(0x103c84ae6644642d), BaseElement::new(0xa25f2e0799674acc), BaseElement::new(0x3481d7c0cc8a116b),
    BaseElement::new(0xc6a4817affad180a), BaseElement::new(0x58c72af43300bea9),
    BaseElement::new(0xeae9d42d6623c548), BaseElement::new(0x7d0c7e66994694e7), BaseElement::new(0x0f2f289fcc696b86),
    BaseElement::new(0xa151d2d8ff8c3225), BaseElement::new(0x33747c11329eacc4),
    BaseElement::new(0xc597260e65b17363), BaseElement::new(0x57b9cfa798c43a02), BaseElement::new(0xe9dc78e0cbf700a1),
    BaseElement::new(0x7bff228ffeea0740), BaseElement::new(0x0e21cc09325d0ddf),
    BaseElement::new(0xa04475825b90147e), BaseElement::new(0x32671efb8ec31b1d), BaseElement::new(0xc489c894c1f621bc),
    BaseElement::new(0x56ac722df509285b), BaseElement::new(0xe8cf1b672e1c2efa),
    BaseElement::new(0x7af1c4a06152f599), BaseElement::new(0x0d146ed994859c38), BaseElement::new(0x9f371902c7b862d7),
    BaseElement::new(0x3159c33bfaeb2976), BaseElement::new(0xc37c6d752e1ef015),
    BaseElement::new(0x559f170061521ab4), BaseElement::new(0xe7c1c09994852153), BaseElement::new(0x79e46a32c7b827f2),
    BaseElement::new(0x0c0714cbd3eb2e91), BaseElement::new(0x9e29be04070e3530),
    BaseElement::new(0x304c683c3a5113cf), BaseElement::new(0xc26f1275639f3a6e), BaseElement::new(0x5491bc0e9cd2410d),
    BaseElement::new(0xe6b465a7d00547ac), BaseElement::new(0x78d70f410338ce4b),
    BaseElement::new(0x0af9b8da367be4ea), BaseElement::new(0x9d1c6213699ed389), BaseElement::new(0x2f3f0c4c9cd1da28),
    BaseElement::new(0xc161b5e5d004e0c7), BaseElement::new(0x53845f1f0337e766),
    BaseElement::new(0xe5a70858366af605), BaseElement::new(0x77c9b1916a0e0ca4), BaseElement::new(0x09ec5acabd513343),
    BaseElement::new(0x9c0f0403f09459e2), BaseElement::new(0x2e31ad3d23c77081),
    BaseElement::new(0xc054564643ea5620), BaseElement::new(0x5276ff7d760b2cbf), BaseElement::new(0xe499a8b6a93e135e),
    BaseElement::new(0x76bc5230dc70f9fd), BaseElement::new(0x08defbc90fa3c09c),
    BaseElement::new(0x9b01a5824fc6873b), BaseElement::new(0x2d244ebb82e94dda), BaseElement::new(0xbf46f894b60c3479),
    BaseElement::new(0x5169a20de92f1b18), BaseElement::new(0xe38c4b671c520ab7),
    // Round 26 (full)
    BaseElement::new(0x75af05a03e752856), BaseElement::new(0x07d19e3f715a0ef5), BaseElement::new(0x99f438789f3cd594),
    BaseElement::new(0x2c16e2b1c2ffbc33), BaseElement::new(0xbe398c0af62282d2),
    // Round 27 (full)
    BaseElement::new(0x505c5e441b3e6971), BaseElement::new(0xe27f38f44e4e2910), BaseElement::new(0x7462e21f77a149af),
    BaseElement::new(0x0685cb58aa3e064e), BaseElement::new(0x98a874f1dd610bed),
    // Round 28 (full)
    BaseElement::new(0x2acb1e862016d08c), BaseElement::new(0xbcedc8214339f72b), BaseElement::new(0x4f0f718476bcbdca),
    BaseElement::new(0xe1321b4da9bfa469), BaseElement::new(0x7354c4e6dc628b08),
    // Round 29 (full)
    BaseElement::new(0x05776e7f094971a7), BaseElement::new(0x979a38186f4c3846), BaseElement::new(0x299ce1a1a25afee5),
    BaseElement::new(0xbbbeab5ac67d8584), BaseElement::new(0x4de1551ffa3e0c23),
    // Padding rounds (identity, not used — ensures trace fills power-of-2)
    BaseElement::new(0xe003fe932d804cc2), BaseElement::new(0x7226a82c60a37361), BaseElement::new(0x0449525574c63a00),
    BaseElement::new(0x966bfbee079e019f), BaseElement::new(0x288ea577a7c1c83e),
    BaseElement::new(0xbab14f10dae49edd), BaseElement::new(0x4cd3f85a0e07657c), BaseElement::new(0xdef6a1933f2a3c1b),
    BaseElement::new(0x71197f6c72ad02ba), BaseElement::new(0x033c289ba5cfc959),
    BaseElement::new(0x955ed2de01f2b0f8), BaseElement::new(0x27817c013225a897), BaseElement::new(0xb9a4264465480036),
    BaseElement::new(0x4bc6cfe798eaf7d5), BaseElement::new(0xdde978eacb8def74),
];

/// MDS matrix for t=5 (circulant construction).
pub const MDS_MATRIX_T5: [[BaseElement; 5]; 5] = [
    [BaseElement::new(5), BaseElement::new(1), BaseElement::new(1), BaseElement::new(1), BaseElement::new(1)],
    [BaseElement::new(1), BaseElement::new(5), BaseElement::new(1), BaseElement::new(1), BaseElement::new(1)],
    [BaseElement::new(1), BaseElement::new(1), BaseElement::new(5), BaseElement::new(1), BaseElement::new(1)],
    [BaseElement::new(1), BaseElement::new(1), BaseElement::new(1), BaseElement::new(5), BaseElement::new(1)],
    [BaseElement::new(1), BaseElement::new(1), BaseElement::new(1), BaseElement::new(1), BaseElement::new(5)],
];

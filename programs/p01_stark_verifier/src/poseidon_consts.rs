/// Poseidon round constants for Goldilocks field, t=3 (width 3).
use crate::goldilocks::Felt;

/// Get the 3 round constants for a given round index (0..29).
pub fn round_constants(round: usize) -> [Felt; 3] {
    let base = round * 3;
    [
        Felt::new(RC_T3[base]),
        Felt::new(RC_T3[base + 1]),
        Felt::new(RC_T3[base + 2]),
    ]
}

const RC_T3: [u64; 90] = [
    0xa98e4673f9036e0b, 0x3db4a488e825c32a, 0x60de653e0ed43e20,
    0x8b4f0d2b6ea19313, 0x2f97e83e60e2c4dd, 0xacea6e9af6c2c725,
    0xd5604eef12e3cabc, 0x1eb9db12a1e71b79, 0x7ad5966d3a790d0d,
    0xbfae604e2c72e1d9, 0x5fa21f2143c2f72a, 0xc3ae00cf4d83d5b8,
    0x9e8d1423cd728e2f, 0x45d8e40e789c13ab, 0x6b9e0d183d0b0e71,
    0x8a15b14c28d50c0a, 0xd1eef5afe2c45c82, 0x3c914bfff61cc9d3,
    0xf7d2a1f9ab51e8c4, 0x2e4d3b16c89f0a55, 0xb8f0e1d7a3c24b96,
    0x5169e0d4f3812c47, 0x0af31e8bc2d57698, 0x94b6e123d8f40c49,
    0xe2c9f5670ab18d3a, 0x7b30e894f1d26c0b, 0x14a3d7c6e810fb5c,
    0xad76e0b1f934ca0d, 0x46d9e3825c01a9be, 0xe01c67da3f24586f,
    0x799fe120d347b680, 0x12028bcda6f0e531, 0xab45c7feb9132482,
    0x4468e041dc360373, 0xdd8bf16e0f590264, 0x76aee291325c0155,
    0x0fd1d3b465bf0046, 0xa804e4c798020f37, 0x4127f5ea0b256e28,
    0xda4ae60d3e480d19, 0x736dd73071bb4c0a, 0x0c90c8439ede8afb,
    0xa5c3d966d2019bec, 0x3ef6ea89050490dd, 0xd829fb0c382b5fce,
    0x715d0c2f6b4e7ebf, 0x0a801d528a719db0, 0xa3b32e75bdb4bca1,
    0x3ce63f98f0d7db92, 0xd6194abd2400fa83, 0x6f4c5be057241974,
    0x087f6ce38a473865, 0xa1a27e06bd6a5756, 0x3ad58f29f08d7647,
    0xd408a04d239067b8, 0x6d3bb170568340a9, 0x066ed293899c5f9a,
    0x9fa1e3b6bcbf7e8b, 0x38d4f4d9efe29d7c, 0xd20805fd13057c6d,
    0x6b3b17202a282b5e, 0x046e2843540b4a4f, 0x9da13966872e6940,
    0x36d44a89ba516831, 0xcf075bacfd745722, 0x683a6cd020574613,
    0x016d7df353ba3504, 0x9aa08f1686dd13f5, 0x33d3a039b90032e6,
    0xcd06b15cec6351d7, 0x6639c28019a670c8, 0xff6cd3a34cc94fb9,
    0x989fe4c67fec6eaa, 0x31d2f5e9b30f4d9b, 0xcb060d0ce6326c8c,
    0x6439180fe231ab7d, 0xfd6c29261546ca6e, 0x969f3a84487be95f,
    0x2fd24ac7b8c50850, 0xc90555eaeb981741, 0x62386b17de5c3632,
    0xfb5b7448e86c4523, 0x94ae8524217f3414, 0x2dd19647549a2305,
    0xc6f4a76a879d01f6, 0x5f17b18dbac0e0e7, 0xf83acbb0ede3bfd8,
    0x915ddc43210c9ec9, 0x2a80ed66544fbdba, 0xc3a3fe8987b2bcab,
];

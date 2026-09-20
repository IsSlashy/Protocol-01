// ⛔ LEAK-LEDGER A8, the other half: the compact entry points took `&[u64]`,
// so the raw-bytes path existed one level above the trace builders too.
use p01_stark::air::spend::{CANONICAL_DEPTH, MASK_LEN};
use p01_stark::compact::generate_spend_compact_proof;

fn main() {
    let mask = vec![0u64; MASK_LEN];
    let _ = generate_spend_compact_proof(
        1,
        2,
        3,
        4,
        &vec![0u64; CANONICAL_DEPTH],
        &vec![0u8; CANONICAL_DEPTH],
        &[1, 2, 3, 4],
        &mask,
    );
}

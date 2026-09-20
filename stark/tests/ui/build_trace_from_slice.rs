// ⛔ LEAK-LEDGER A8. An outside caller must NOT be able to hand a raw slice of
// field elements to a trace builder. Before the `BlindingMask` newtype this
// file COMPILED, and the zero mask below produced a C7 proof that verifies and
// hides nothing.
use p01_stark::air::spend::{build_spend_trace, CANONICAL_DEPTH, MASK_LEN};
use p01_stark::BaseElement;

fn main() {
    let z = BaseElement::new(0);
    let path_elements = vec![z; CANONICAL_DEPTH];
    let path_indices = vec![0u8; CANONICAL_DEPTH];
    let mask = vec![z; MASK_LEN];
    let _ = build_spend_trace(z, z, z, z, &path_elements, &path_indices, &mask);
}

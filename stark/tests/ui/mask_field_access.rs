// ⛔ ... and the PRIVATE FIELD stays private: no caller moves the Vec out of a mask. That is all
// this pins -- `m.as_slice().to_vec()` copies the values and `&m` can serve two proofs; both compile.
use p01_stark::BlindingMask;

fn main() {
    let m = BlindingMask::draw(4).unwrap();
    let _stolen = m.0;
}

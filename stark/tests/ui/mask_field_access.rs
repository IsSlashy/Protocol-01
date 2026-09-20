// ⛔ ... and no caller can read the drawn mask back out as an owned Vec to
// re-use it on a second proof.
use p01_stark::BlindingMask;

fn main() {
    let m = BlindingMask::draw(4).unwrap();
    let _stolen = m.0;
}

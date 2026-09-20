// ⛔ There is no `From<Vec<BaseElement>>` and no `Default`, so neither the
// conversion nor the all-zero mask has a path.
use p01_stark::{BaseElement, BlindingMask};

fn main() {
    let v: Vec<BaseElement> = vec![BaseElement::new(0); 4];
    let _converted: BlindingMask = v.into();
    let _empty = BlindingMask::default();
}

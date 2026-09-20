// ⛔ The newtype's field is private: no caller can wrap bytes it chose itself.
use p01_stark::{BaseElement, BlindingMask};

fn main() {
    let _ = BlindingMask(vec![BaseElement::new(0); 4]);
}

pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Simple circuit: prove knowledge of a Poseidon hash preimage
// Public input: hash
// Private input: preimage
template HashPreimage() {
    signal input preimage;
    signal input hash;

    component hasher = Poseidon(1);
    hasher.inputs[0] <== preimage;
    hash === hasher.out;
}

component main {public [hash]} = HashPreimage();

//! Example: Verify a Groth16 proof with 3 public inputs.
//!
//! This example shows how to use the verifier off-chain for testing.
//! On-chain, the same API works within a Solana program instruction.

fn main() {
    use p01_solana_verifier::endianness::u64_to_field_le;

    println!("p01-solana-verifier example");
    println!("================================");
    println!();
    println!("In a real program, you would:");
    println!("  1. Upload your VK data to a Solana account");
    println!("  2. Receive a proof as instruction data (256 bytes)");
    println!("  3. Call verify_proof(vk_data, proof, public_inputs)");
    println!();
    println!("Compute budget guide:");
    println!("  1-3 inputs: 200,000 CU");
    println!("  4-5 inputs: 500,000 CU");
    println!("  6-8 inputs: 700,000 CU");
    println!("  9+  inputs: 1,000,000+ CU");
    println!();

    // Demonstrate field element conversion
    let value = u64_to_field_le(42);
    println!("Field element for 42 (LE): {:02x}{:02x}{:02x}{:02x}...", value[0], value[1], value[2], value[3]);

    let neg = p01_solana_verifier::endianness::i64_to_field_le(-1);
    println!("Field element for -1 (LE): {:02x}{:02x}...{:02x}{:02x}", neg[0], neg[1], neg[30], neg[31]);
    println!();

    // Demonstrate VK hashing
    let fake_vk = vec![0u8; 512];
    let hash = p01_solana_verifier::compute_vk_hash(&fake_vk);
    println!("VK hash (first 8 bytes): {:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]);
    println!();

    // Demonstrate proof format conversion from snarkjs
    let proof = p01_solana_verifier::proof_from_snarkjs(
        &["1", "2"],
        &[["3", "4"], ["5", "6"]],
        &["7", "8"],
    );
    println!("Proof from snarkjs (256 bytes):");
    println!("  pi_a size: {} bytes", proof.pi_a.len());
    println!("  pi_b size: {} bytes (G2 with swapped real/imag)", proof.pi_b.len());
    println!("  pi_c size: {} bytes", proof.pi_c.len());
    println!("  total:     {} bytes", proof.pi_a.len() + proof.pi_b.len() + proof.pi_c.len());
}

// Quick probe: regenerate proof for secret=42, then compute derive_ood_point
// locally (native cargo) with the same inputs. Compare against the values
// captured from the on-chain SBF execution to localize the bug.

use sha2::{Digest, Sha256};

const GOLDILOCKS_PRIME: u64 = 0xFFFFFFFF00000001;

fn derive_ood_point(trace_root: &[u8; 32], quotient_root: &[u8; 32], commitment_bytes: &[u8]) -> u64 {
    let mut data = Vec::with_capacity(64 + commitment_bytes.len());
    data.extend_from_slice(trace_root);
    data.extend_from_slice(quotient_root);
    data.extend_from_slice(commitment_bytes);
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let hash = hasher.finalize();
    let mut ood_z = u64::from_le_bytes(hash[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if ood_z == 0 { ood_z = 1; }
    ood_z
}

fn main() {
    // Regenerate the proof for secret=42.
    let proof = p01_stark::compact::generate_compact_proof(42);

    println!("Generated proof for secret=42");
    println!("  commitment = {}", proof.commitment);
    let commitment_bytes = proof.commitment.to_le_bytes();
    println!("  commitment_bytes (LE) = {:?}", commitment_bytes);

    // Parse trace_root and quotient_root from the proof bytes.
    // Wire layout: trace_root (32) || quotient_root (32) || ood_current (24) || ood_next (24) || ood_z (8) || ood_quotient (8) || ...
    let bytes = &proof.proof_bytes;
    let trace_root: [u8; 32] = bytes[0..32].try_into().unwrap();
    let quotient_root: [u8; 32] = bytes[32..64].try_into().unwrap();
    let ood_z_from_proof = u64::from_le_bytes(bytes[64 + 24 + 24..64 + 24 + 24 + 8].try_into().unwrap());

    println!("  trace_root[0..8]    = {:?}", &trace_root[..8]);
    println!("  quotient_root[0..8] = {:?}", &quotient_root[..8]);
    println!("  proof.ood_z         = {}", ood_z_from_proof);

    let local_expected = derive_ood_point(&trace_root, &quotient_root, &commitment_bytes);
    println!("\nLOCAL derive_ood_point (sha2::Sha256 single-buffer):");
    println!("  expected_ood_z = {}", local_expected);

    println!("\nOn-chain SBF values (from debug msg!):");
    println!("  expected      = 17049515411378191695");
    println!("  got           = 1193700969703459767");

    if local_expected == 17049515411378191695 {
        println!("\n>>> SBF and native AGREE on expected_ood_z.");
        println!(">>> Prover's claimed ood_z = {} does not match either.", ood_z_from_proof);
        if ood_z_from_proof == 1193700969703459767 {
            println!(">>> The proof's ood_z field matches the 'got' value reported on-chain.");
        }
        println!(">>> Conclusion: BUG IN PROVER (it computes a wrong ood_z) OR proof.ood_z is being mis-parsed.");
    } else if local_expected == 1193700969703459767 {
        println!("\n>>> SBF and native DISAGREE. SBF computed a different sha256 result than native.");
        println!(">>> Conclusion: BUG IN SOL_SHA256 SYSCALL (or how hashv slice-of-slices is fed to it).");
    } else {
        println!("\n>>> Local expected differs from BOTH on-chain values. Mystery deepens.");
        println!(">>> Native sha2 on these exact bytes = {}", local_expected);
    }
}

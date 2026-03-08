/// Generate compact STARK proofs for all circuit types.
///
/// Usage:
///   cargo run --bin gen_proof -p p01-stark -- <secret>
///   cargo run --bin gen_proof -p p01-stark -- pool <np> <secret> <epoch> <mint>
///   cargo run --bin gen_proof -p p01-stark -- balance <sk> <balance> <salt> <mint>
///   cargo run --bin gen_proof -p p01-stark -- merkle <leaf> <elem1,elem2,...> <idx1,idx2,...>

fn main() {
    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(|s| s.as_str()) {
        Some("pool") => {
            let np: u64 = args[2].parse().expect("Invalid np");
            let secret: u64 = args[3].parse().expect("Invalid secret");
            let epoch: u64 = args[4].parse().expect("Invalid epoch");
            let mint: u64 = args[5].parse().expect("Invalid mint");

            let proof = p01_stark::compact::generate_pool_commitment_proof(np, secret, epoch, mint);
            println!("{{");
            println!("  \"circuit_id\": {},", proof.circuit_id);
            println!("  \"public_inputs\": [{}, {}],", proof.public_inputs[0], proof.public_inputs[1]);
            println!("  \"proof_size\": {},", proof.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof.proof_bytes));
            println!("}}");
        }
        Some("balance") => {
            let sk: u64 = args[2].parse().expect("Invalid sk");
            let balance: u64 = args[3].parse().expect("Invalid balance");
            let salt: u64 = args[4].parse().expect("Invalid salt");
            let mint: u64 = args[5].parse().expect("Invalid mint");

            let proof = p01_stark::compact::generate_balance_compact_proof(sk, balance, salt, mint);
            println!("{{");
            println!("  \"circuit_id\": {},", proof.circuit_id);
            println!("  \"public_inputs\": [{}, {}],", proof.public_inputs[0], proof.public_inputs[1]);
            println!("  \"proof_size\": {},", proof.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof.proof_bytes));
            println!("}}");
        }
        Some("merkle") => {
            let leaf: u64 = args[2].parse().expect("Invalid leaf");
            let elements: Vec<u64> = args[3].split(',').map(|s| s.trim().parse().unwrap()).collect();
            let indices: Vec<u8> = args[4].split(',').map(|s| s.trim().parse().unwrap()).collect();

            let proof = p01_stark::compact::generate_merkle_path_compact_proof(leaf, &elements, &indices);
            println!("{{");
            println!("  \"circuit_id\": {},", proof.circuit_id);
            println!("  \"public_inputs\": [{}, {}],", proof.public_inputs[0], proof.public_inputs[1]);
            println!("  \"proof_size\": {},", proof.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof.proof_bytes));
            println!("}}");
        }
        _ => {
            // Default: subscriber_ownership
            let secret: u64 = args.get(1)
                .unwrap_or(&"42".to_string())
                .parse()
                .expect("Invalid secret number");

            let proof_data = p01_stark::compact::generate_compact_proof(secret);
            println!("{{");
            println!("  \"secret\": {},", secret);
            println!("  \"commitment\": {},", proof_data.commitment);
            println!("  \"proof_size\": {},", proof_data.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof_data.proof_bytes));
            println!("}}");
        }
    }
}

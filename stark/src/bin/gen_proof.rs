//! Generate compact STARK proofs for all circuit types.
//!
//! Usage:
//!   cargo run --bin gen_proof -p p01-stark -- <secret>
//!   cargo run --bin gen_proof -p p01-stark -- pool <np> <secret> <epoch> <mint>
//!   cargo run --bin gen_proof -p p01-stark -- balance <sk> <balance> <salt> <mint>
//!   cargo run --bin gen_proof -p p01-stark -- merkle <leaf> <elem1,elem2,...> <idx1,idx2,...>
//!   cargo run --bin gen_proof -p p01-stark -- merkle-update <old_leaf> <new_leaf> <elem1,elem2,...> <idx1,idx2,...>
//!   cargo run --bin gen_proof -p p01-stark -- confidential <sk> <old_bal> <old_salt> <new_bal> <new_salt> <amount> <amt_salt> <mint>
//!   cargo run --bin gen_proof -p p01-stark -- transfer <sk> <mint> <in1_amt> <in1_rand> <in2_amt> <in2_rand> <out1_amt> <out1_rcpt> <out1_rand> <out2_amt> <out2_rcpt> <out2_rand> <pub_amt>

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
            println!(
                "  \"public_inputs\": [{}, {}, {}],",
                proof.public_inputs[0], proof.public_inputs[1], proof.public_inputs[2],
            );
            println!("  \"proof_size\": {},", proof.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof.proof_bytes));
            println!("}}");
        }
        Some("merkle-update") => {
            let old_leaf: u64 = args[2].parse().expect("Invalid old_leaf");
            let new_leaf: u64 = args[3].parse().expect("Invalid new_leaf");
            let elements: Vec<u64> = args[4].split(',').map(|s| s.trim().parse().unwrap()).collect();
            let indices: Vec<u8> = args[5].split(',').map(|s| s.trim().parse().unwrap()).collect();

            let proof = p01_stark::compact::generate_merkle_update_compact_proof(
                old_leaf, new_leaf, &elements, &indices,
            );
            println!("{{");
            println!("  \"circuit_id\": {},", proof.circuit_id);
            println!(
                "  \"public_inputs\": [{}, {}, {}, {}, {}],",
                proof.public_inputs[0], proof.public_inputs[1], proof.public_inputs[2],
                proof.public_inputs[3], proof.public_inputs[4],
            );
            println!("  \"proof_size\": {},", proof.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof.proof_bytes));
            println!("}}");
        }
        Some("confidential") => {
            let sk: u64 = args[2].parse().expect("Invalid sk");
            let old_bal: u64 = args[3].parse().expect("Invalid old_bal");
            let old_salt: u64 = args[4].parse().expect("Invalid old_salt");
            let new_bal: u64 = args[5].parse().expect("Invalid new_bal");
            let new_salt: u64 = args[6].parse().expect("Invalid new_salt");
            let amount: u64 = args[7].parse().expect("Invalid amount");
            let amt_salt: u64 = args[8].parse().expect("Invalid amt_salt");
            let mint: u64 = args[9].parse().expect("Invalid mint");

            let proof = p01_stark::compact::generate_confidential_balance_compact_proof(
                sk, old_bal, old_salt, new_bal, new_salt, amount, amt_salt, mint,
            );
            println!("{{");
            println!("  \"circuit_id\": {},", proof.circuit_id);
            println!(
                "  \"public_inputs\": [{}, {}, {}, {}],",
                proof.public_inputs[0], proof.public_inputs[1],
                proof.public_inputs[2], proof.public_inputs[3],
            );
            println!("  \"proof_size\": {},", proof.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof.proof_bytes));
            println!("}}");
        }
        Some("transfer") => {
            let sk: u64 = args[2].parse().expect("Invalid sk");
            let mint: u64 = args[3].parse().expect("Invalid mint");
            let in1_amt: u64 = args[4].parse().expect("Invalid in1_amt");
            let in1_rand: u64 = args[5].parse().expect("Invalid in1_rand");
            let in2_amt: u64 = args[6].parse().expect("Invalid in2_amt");
            let in2_rand: u64 = args[7].parse().expect("Invalid in2_rand");
            let out1_amt: u64 = args[8].parse().expect("Invalid out1_amt");
            let out1_rcpt: u64 = args[9].parse().expect("Invalid out1_rcpt");
            let out1_rand: u64 = args[10].parse().expect("Invalid out1_rand");
            let out2_amt: u64 = args[11].parse().expect("Invalid out2_amt");
            let out2_rcpt: u64 = args[12].parse().expect("Invalid out2_rcpt");
            let out2_rand: u64 = args[13].parse().expect("Invalid out2_rand");
            let pub_amt: u64 = args[14].parse().expect("Invalid pub_amt");

            let proof = p01_stark::compact::generate_transfer_compact_proof(
                sk, mint, in1_amt, in1_rand, in2_amt, in2_rand,
                out1_amt, out1_rcpt, out1_rand, out2_amt, out2_rcpt, out2_rand, pub_amt,
            );
            println!("{{");
            println!("  \"circuit_id\": {},", proof.circuit_id);
            println!(
                "  \"public_inputs\": [{}, {}, {}, {}, {}, {}],",
                proof.public_inputs[0], proof.public_inputs[1], proof.public_inputs[2],
                proof.public_inputs[3], proof.public_inputs[4], proof.public_inputs[5],
            );
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
            println!("  \"secret\": \"{}\",", secret);
            println!("  \"commitment\": \"{}\",", proof_data.commitment);
            println!("  \"proof_size\": {},", proof_data.proof_bytes.len());
            println!("  \"proof_hex\": \"{}\"", hex::encode(&proof_data.proof_bytes));
            println!("}}");
        }
    }
}

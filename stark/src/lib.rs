//! Protocol 01 STARK Proof System
//!
//! Quantum-resistant zero-knowledge proofs using Winterfell STARKs.
//! No trusted setup required — security based on hash functions (collision-resistant),
//! not elliptic curve pairings (vulnerable to Shor's algorithm).
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────┐
//! │ Client (browser WASM / mobile WebView)                  │
//! │                                                         │
//! │  ┌─────────┐    ┌───────────┐    ┌──────────────────┐  │
//! │  │ Witness  │───>│ Prover    │───>│ STARK Proof      │  │
//! │  │ (secret) │    │ (winter)  │    │ (~50KB, PQ-safe) │  │
//! │  └─────────┘    └───────────┘    └──────────────────┘  │
//! └──────────────────────────────────┬──────────────────────┘
//!                                    │ submit proof on-chain
//!                                    ▼
//! ┌─────────────────────────────────────────────────────────┐
//! │ Solana Program (p01_stark_verifier)                     │
//! │                                                         │
//! │  ┌──────────────────┐    ┌───────────────────────────┐  │
//! │  │ STARK Proof      │───>│ FRI Verifier (no_std)     │  │
//! │  │ (from account)   │    │ ~1.1M CU, hash-based     │  │
//! │  └──────────────────┘    └───────────────────────────┘  │
//! └─────────────────────────────────────────────────────────┘
//! ```
//!
//! # Circuits (AIR definitions)
//!
//! | Circuit                 | Circom Equivalent          | Status |
//! |-------------------------|----------------------------|--------|
//! | subscriber_ownership    | subscriber_ownership.circom| POC    |
//! | balance_proof           | balance_proof.circom       | TODO   |
//! | confidential_balance    | confidential_balance.circom| TODO   |
//! | denominated_pool        | denominated_pool.circom    | TODO   |
//! | denominated_transfer    | denominated_transfer.circom| TODO   |
//! | transfer                | transfer.circom            | TODO   |
//!
//! # Field
//!
//! Uses Goldilocks field (p = 2^64 - 2^32 + 1) for fast arithmetic.
//! This is a different field than BN254 used by Groth16 — existing commitments
//! are NOT compatible and require migration.

pub mod air;
pub mod poseidon;
pub mod prover;

#[cfg(feature = "std")]
pub mod verifier;

pub mod compact;

// Re-exports for convenience
pub use air::subscriber_ownership::{
    build_trace, compute_commitment, SubscriberOwnershipAir, SubscriberOwnershipPublicInputs,
};
pub use air::merkle_path::{
    build_merkle_trace, compute_merkle_root, MerklePathAir, MerklePathPublicInputs,
};
pub use air::merkle_update::{
    build_merkle_update_trace, compute_update_roots, MerkleUpdateAir,
    MerkleUpdatePublicInputs,
};
pub use air::denominated_pool::{
    build_pool_commitment_trace, compute_pool_values, DenominatedPoolAir,
    DenominatedPoolPublicInputs,
};
pub use air::balance_proof::{
    build_balance_proof_trace, compute_balance_commitment, BalanceProofAir,
    BalanceProofPublicInputs,
};
pub use air::confidential_balance::{
    build_confidential_balance_trace, compute_confidential_balance, ConfidentialBalanceAir,
    ConfidentialBalancePublicInputs,
};
pub use air::transfer::{
    build_transfer_trace, compute_transfer, TransferAir, TransferPublicInputs,
    TransferInput, TransferOutput,
};
pub use prover::{prove_subscriber_ownership, StarkProofBytes};
pub use compact::{
    generate_pool_commitment_proof, generate_balance_compact_proof,
    generate_merkle_path_compact_proof, generate_merkle_update_compact_proof,
    generate_confidential_balance_compact_proof,
    generate_transfer_compact_proof, GenericCompactProofData,
    CIRCUIT_SUBSCRIBER_OWNERSHIP, CIRCUIT_POOL_COMMITMENT,
    CIRCUIT_BALANCE_PROOF, CIRCUIT_MERKLE_PATH,
    CIRCUIT_CONFIDENTIAL_BALANCE, CIRCUIT_TRANSFER,
    CIRCUIT_MERKLE_UPDATE,
};
pub use winterfell::math::fields::f64::BaseElement;
/// [C7 drift pins] `winterfell` is not a dependency of the verifier crate, so
/// the traits that give `BaseElement` its `ZERO`, `ONE`, `exp` and `as_int`
/// are not in scope there -- `tests/common/mod.rs` works around it with a
/// hand-rolled `fn ZERO()`. Re-exported so a cross-crate pin can do field
/// arithmetic without the verifier taking a winterfell dependency of its own.
pub use winterfell::math::{FieldElement, StarkField};

#[cfg(feature = "std")]
pub use verifier::verify_subscriber_ownership;

/// Draw `n` uniform Goldilocks elements from the OS CSPRNG, by rejection.
///
/// ⛔ MOVED OUT OF `mod wasm_api` ON 2026-08-30, and the move is the point. While
/// it lived behind `#[cfg(feature = "wasm")]` every other caller wrote its own
/// mask, and every one of them wrote a deterministic xorshift. A mask that is
/// deterministic hides nothing -- it is the one input where "close enough"
/// silently voids the whole blinding argument.
#[cfg(feature = "csprng")]

/// Draw a blinding mask from the platform CSPRNG.
///
/// 🚨 SHARED BY C7 AND C6 SINCE 2026-08-29, and it was renamed off
/// `draw_spend_mask` for exactly that reason: a C7-shaped name on the only
/// CSPRNG path in the crate is how a second circuit ends up quietly reusing
/// something else, or nothing.
///
/// Rejection-samples into the Goldilocks field instead of reducing a u64.
/// Reducing biases the low ~2^32 of the field by a factor of two, and this
/// mask is the only thing standing between an observer and the rows the
/// counting argument in `air/spend.rs` assumes are uniform. The bias is
/// small; the cost of not having it is one extra draw per ~2^32 samples.
///
/// Returns `Err` rather than falling back to anything. A weak mask is worse
/// than no proof: no proof fails loudly, a weak mask succeeds and leaks.
pub fn draw_blinding_mask(n: usize) -> Result<Vec<u64>, getrandom::Error> {
    const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;
    let mut out = Vec::with_capacity(n);
    let mut buf = [0u8; 8];
    while out.len() < n {
        getrandom::getrandom(&mut buf)?;
        let v = u64::from_le_bytes(buf);
        if v < GOLDILOCKS {
            out.push(v);
        }
    }
    Ok(out)
}

// WASM bindings for browser/WebView proof generation
#[cfg(feature = "wasm")]
mod wasm_api {
    use wasm_bindgen::prelude::*;

    // 🚨 THIS `use` IS LOAD-BEARING AND ITS ABSENCE DID NOT FAIL ANYWHERE THAT
    // RUNS. `draw_blinding_mask` was defined INSIDE this module until 2026-08-30,
    // when it was hoisted to the crate root so every non-wasm caller could reach
    // the real CSPRNG instead of writing its own deterministic xorshift. The five
    // callers below kept their unqualified names and stopped resolving.
    //
    // Nothing noticed for a day, because `mod wasm_api` is behind
    // `#[cfg(feature = "wasm")]`: `cargo build` does not compile it, `cargo test`
    // does not compile it, and no CI job passes `--features wasm`. The only thing
    // that compiles this module is `wasm-pack`, and the only thing that runs
    // `wasm-pack` is a human about to reship the blob.
    //
    // ⛔ So the shipped-prover path was uncompilable and the tree was green. If
    // this line is ever removed again, add the build to CI in the same commit.
    use crate::draw_blinding_mask;

    use crate::compact::{
        generate_compact_proof, generate_pool_commitment_proof,
        generate_balance_compact_proof, generate_merkle_path_compact_proof,
        generate_merkle_update_compact_proof,
        generate_confidential_balance_compact_proof, generate_transfer_compact_proof,
        generate_spend_compact_proof,
    };

    /// Generate a compact STARK proof for subscriber_ownership.
    /// Returns JSON: { commitment: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_stark_proof(subscriber_secret: u64) -> String {
        let proof_data = generate_compact_proof(subscriber_secret);
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"commitment":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.commitment,
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Compute the Poseidon commitment for a secret (without generating a proof).
    #[wasm_bindgen]
    pub fn compute_stark_commitment(subscriber_secret: u64) -> String {
        let commitment = crate::air::subscriber_ownership::compute_commitment(
            crate::BaseElement::new(subscriber_secret)
        );
        commitment.as_int().to_string()
    }

    /// Generate a compact STARK proof for denominated pool commitment.
    /// Returns JSON: { circuit_id: 1, nullifier: string, commitment: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_pool_commitment_stark_proof(
        nullifier_preimage: u64,
        secret: u64,
        deposit_epoch: u64,
        token_mint: u64,
    ) -> String {
        // [C1-N256] The blinding region, drawn fresh for THIS proof.
        //
        // ⛔ REFUSES RATHER THAN FALLING BACK, for the reason C7 states and C3
        // and C6 repeat: no proof fails loudly, a weak mask succeeds and leaks.
        // A zero-filled or witness-derived default would leave rows 96..255
        // predictable and `air_aware_recovery_c1.rs` would go back to recovering
        // all four private inputs from the published bytes.
        let mask = match draw_blinding_mask(crate::air::denominated_pool::MASK_LEN) {
            Ok(m) => m,
            Err(e) => {
                return format!(
                    r#"{{"error":"no CSPRNG available, refusing to build a C1 proof: {}"}}"#,
                    e,
                );
            }
        };

        let proof_data = generate_pool_commitment_proof(
            nullifier_preimage, secret, deposit_epoch, token_mint, &mask,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"nullifier":"{}","commitment":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for balance commitment.
    /// Returns JSON: { circuit_id: 2, commitment: string, token_mint: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_balance_stark_proof(
        spending_key: u64,
        balance: u64,
        salt: u64,
        token_mint: u64,
    ) -> String {
        let proof_data = generate_balance_compact_proof(
            spending_key, balance, salt, token_mint,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"commitment":"{}","token_mint":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for confidential balance update.
    /// Returns JSON: { circuit_id: 4, old_commitment, new_commitment, amount_hash, token_mint, proof_hex, proof_size }
    #[wasm_bindgen]
    pub fn generate_confidential_balance_stark_proof(
        spending_key: u64,
        old_balance: u64,
        old_salt: u64,
        new_balance: u64,
        new_salt: u64,
        amount: u64,
        amount_salt: u64,
        token_mint: u64,
    ) -> String {
        let proof_data = generate_confidential_balance_compact_proof(
            spending_key, old_balance, old_salt, new_balance, new_salt,
            amount, amount_salt, token_mint,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"old_commitment":"{}","new_commitment":"{}","amount_hash":"{}","token_mint":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_data.public_inputs[2],
            proof_data.public_inputs[3],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for Merkle path inclusion.
    /// path_elements and path_indices are comma-separated strings.
    /// Returns JSON: { circuit_id: 3, leaf: string, root: string, proof_hex: string, proof_size: number }
    #[wasm_bindgen]
    pub fn generate_merkle_path_stark_proof(
        leaf: u64,
        path_elements_csv: &str,
        path_indices_csv: &str,
    ) -> String {
        let path_elements: Vec<u64> = path_elements_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let path_indices: Vec<u8> = path_indices_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        // [C3-D12] The blinding region, drawn fresh for THIS proof.
        //
        // ⛔ REFUSES RATHER THAN FALLING BACK, for the reason C7 states and C6
        // repeats: no proof fails loudly, a weak mask succeeds and leaks. A
        // zero-filled or witness-derived default would leave rows 384..511
        // predictable and `air_aware_recovery_c3.rs` would go back to recovering
        // the path and the leaf index from the published bytes.
        let mask = match draw_blinding_mask(
            crate::air::merkle_path::mask_len_for_depth(path_elements.len()),
        ) {
            Ok(m) => m,
            Err(e) => {
                return format!(
                    r#"{{"error":"no CSPRNG available, refusing to build a C3 proof: {}"}}"#,
                    e,
                );
            }
        };

        let proof_data = generate_merkle_path_compact_proof(
            leaf, &path_elements, &path_indices, &mask,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"leaf":"{}","root":"{}","depth":{},"proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_data.public_inputs[2],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for a Merkle leaf update.
    /// path_elements and path_indices are comma-separated strings.
    /// Returns JSON: { circuit_id: 6, old_leaf, new_leaf, old_root, new_root, depth, proof_hex, proof_size }
    #[wasm_bindgen]
    pub fn generate_merkle_update_stark_proof(
        old_leaf: u64,
        new_leaf: u64,
        path_elements_csv: &str,
        path_indices_csv: &str,
    ) -> String {
        let path_elements: Vec<u64> = path_elements_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let path_indices: Vec<u8> = path_indices_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        // [C6-D12] The blinding region, drawn fresh for THIS proof.
        //
        // ⛔ REFUSES RATHER THAN FALLING BACK, and the reason is the same one
        // C7 states: no proof fails loudly and a weak mask succeeds and leaks.
        // A zero-filled or witness-derived default here would leave rows
        // 384..511 predictable, and `air_aware_recovery_c6.rs` would go back to
        // recovering four of the ten columns from published openings alone.
        //
        // 🚨 IT MUST BE REDRAWN EVERY PROOF. Two C6 proofs over the same
        // insertion with the same mask publish the same bytes, which re-links
        // exactly what the mask exists to unlink.
        let mask = match draw_blinding_mask(
            p01_stark_mask_len_c6(path_elements.len()),
        ) {
            Ok(m) => m,
            Err(e) => {
                return format!(
                    r#"{{"error":"no CSPRNG available, refusing to build a C6 proof: {}"}}"#,
                    e,
                );
            }
        };

        let proof_data = generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices, &mask,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"old_leaf":"{}","new_leaf":"{}","old_root":"{}","new_root":"{}","depth":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_data.public_inputs[2],
            proof_data.public_inputs[3],
            proof_data.public_inputs[4],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// Generate a compact STARK proof for a 2-in-2-out shielded transfer.
    /// Returns JSON: { circuit_id: 5, nullifier_1, nullifier_2, output_commitment_1, output_commitment_2,
    ///                  public_amount, token_mint, proof_hex, proof_size }
    #[wasm_bindgen]
    pub fn generate_transfer_stark_proof(
        spending_key: u64,
        token_mint: u64,
        in_amount_1: u64,
        in_rand_1: u64,
        in_amount_2: u64,
        in_rand_2: u64,
        out_amount_1: u64,
        out_recipient_1: u64,
        out_rand_1: u64,
        out_amount_2: u64,
        out_recipient_2: u64,
        out_rand_2: u64,
        public_amount: u64,
    ) -> String {
                // [C5-N1024] The blinding region, drawn fresh for THIS proof.
        //
        // ⛔ REFUSES RATHER THAN FALLING BACK. Until 2026-08-29 this entry drew
        // NOTHING — it was the only shipping circuit with no mask at all, which
        // is why `air_aware_recovery_c5.rs` recovered all four note amounts and
        // `owner` from one honest proof.
        let mask = match draw_blinding_mask(crate::air::transfer::MASK_LEN) {
            Ok(m) => m,
            Err(e) => {
                return format!(
                    r#"{{"error":"no CSPRNG available, refusing to build a C5 proof: {}"}}"#,
                    e,
                );
            }
        };

let proof_data = generate_transfer_compact_proof(
            spending_key, token_mint,
            in_amount_1, in_rand_1, in_amount_2, in_rand_2,
            out_amount_1, out_recipient_1, out_rand_1,
            out_amount_2, out_recipient_2, out_rand_2,
            public_amount,
            &mask
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"nullifier_1":"{}","nullifier_2":"{}","output_commitment_1":"{}","output_commitment_2":"{}","public_amount":"{}","token_mint":"{}","proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_data.public_inputs[2],
            proof_data.public_inputs[3],
            proof_data.public_inputs[4],
            proof_data.public_inputs[5],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }

    /// C6's mask arity for a given depth, from the AIR rather than a literal.
    ///
    /// `build_merkle_update_trace` asserts on this exact number, so a literal
    /// here would turn a depth change into a runtime panic on the deposit path
    /// of three surfaces instead of a compile-time-stable derivation.
    fn p01_stark_mask_len_c6(depth: usize) -> usize {
        crate::air::merkle_update::mask_len_for_depth(depth)
    }

    /// [C7] Generate a compact STARK proof for an unlinkable denominated spend.
    ///
    /// Returns JSON: { circuit_id: 7, nullifier, root, recipient_hash[4],
    ///                 proof_hex, proof_size }
    ///
    /// 🚨 THE COMMITMENT IS NOT IN THAT LIST, AND MUST NEVER BE ADDED. C7 exists
    /// so the withdrawal stops publishing it; a caller that wants it back has
    /// misunderstood the circuit, and every other field here is safe to log.
    ///
    /// ⛔ DO NOT SHIP A BLOB BUILT FROM THIS UNTIL THE VERIFIER THAT ACCEPTS
    /// CIRCUIT 7 IS DEPLOYED. Adding this export changes the wasm the three
    /// surfaces carry, and a prover the deployed verifier does not recognise
    /// fails at the END of a ~150 transaction upload, never early. See
    /// `stark/src/air/mod.rs`.
    #[wasm_bindgen]
    pub fn generate_spend_stark_proof(
        nullifier_preimage: u64,
        secret: u64,
        blinding: u64,
        token_mint: u64,
        path_elements_csv: &str,
        path_indices_csv: &str,
        recipient_hash_csv: &str,
    ) -> String {
        use crate::air::spend::CANONICAL_DEPTH;

        let path_elements: Vec<u64> = path_elements_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let path_indices: Vec<u8> = path_indices_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let rh: Vec<u64> = recipient_hash_csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        // `filter_map(.. .ok())` SILENTLY DROPS anything unparseable, which is
        // how a 12-element path arrives as 11 and a truncated Merkle path
        // becomes a proof of the wrong tree. Check the arity here rather than
        // letting the assertion inside the generator report it as a panic with
        // no JSON around it.
        if path_elements.len() != CANONICAL_DEPTH || path_indices.len() != CANONICAL_DEPTH {
            return format!(
                r#"{{"error":"C7 needs exactly {} path elements and {} indices; parsed {} and {}"}}"#,
                CANONICAL_DEPTH, CANONICAL_DEPTH, path_elements.len(), path_indices.len(),
            );
        }
        if rh.len() != 4 {
            return format!(
                r#"{{"error":"recipient_hash must be 4 u64 limbs, parsed {}"}}"#,
                rh.len(),
            );
        }

        // [ZK-RANDOMIZER] MASK_LEN, not MASK_LEN. The second
        // form was right until column 10 existed; it is now SHORT by
        // TRACE_LENGTH and `build_spend_trace` refuses it, which is the whole
        // reason the mask is one slice with one length constant.
        let mask = match draw_blinding_mask(crate::air::spend::MASK_LEN) {
            Ok(m) => m,
            Err(e) => {
                return format!(
                    r#"{{"error":"no CSPRNG available, refusing to build a C7 proof: {}"}}"#,
                    e,
                );
            }
        };

        let recipient_hash = [rh[0], rh[1], rh[2], rh[3]];
        let proof_data = generate_spend_compact_proof(
            nullifier_preimage, secret, blinding, token_mint,
            &path_elements, &path_indices, &recipient_hash, &mask,
        );
        let proof_hex = proof_data.proof_bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        format!(
            r#"{{"circuit_id":{},"nullifier":"{}","root":"{}","recipient_hash":["{}","{}","{}","{}"],"proof_hex":"{}","proof_size":{}}}"#,
            proof_data.circuit_id,
            proof_data.public_inputs[0],
            proof_data.public_inputs[1],
            proof_data.public_inputs[2],
            proof_data.public_inputs[3],
            proof_data.public_inputs[4],
            proof_data.public_inputs[5],
            proof_hex,
            proof_data.proof_bytes.len()
        )
    }
}

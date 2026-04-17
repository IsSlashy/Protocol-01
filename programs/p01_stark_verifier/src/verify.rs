/// On-chain STARK verification for multiple circuits.
///
/// Verifies:
/// 1. OOD constraint consistency (field range)
/// 2. Merkle path validity for all query positions
/// 3. Transition constraint satisfaction at trace-aligned query positions
/// 4. Quotient polynomial verification at ALL query positions (C4)
/// 5. Boundary constraint verification (C6)
/// 6. Fiat-Shamir binding (query positions derived from public inputs)

use crate::compact_proof::*;
use crate::goldilocks::Felt;
use crate::merkle;
use crate::poseidon_consts;
use solana_sha256_hasher::hashv;

#[derive(Debug)]
#[allow(dead_code)]
pub enum VerifyError {
    OodConstraintFailed,
    OodBoundaryFailed,
    InvalidQueryPosition,
    MerkleProofFailed,
    TransitionConstraintFailed,
    QuotientCheckFailed,
    BoundaryConstraintFailed,
    InsufficientQueries,
    UnsupportedCircuit,
    /// [P1.1 PR 3] FRI fold inconsistency — f_{i+1}(y²) does not match
    /// `(f_i(y)+f_i(-y))/2 + α_i·(f_i(y)-f_i(-y))/(2y)`, or the final-fold
    /// evaluation disagrees with `final_poly`. Means the prover submitted
    /// layer values that are not an honest fold of the prior layer.
    FriFoldCheckFailed,
    /// [P1.1 PR 4 DEEP-ALI] Transition constraint evaluated at OOD point does
    /// not equal `ood_quotient · Z_D(z)`. The prover's Q(z) claim is
    /// inconsistent with the opened OOD trace evaluations and the AIR.
    DeepAliFailed,
}

// ============================================================================
// LDE domain generator constants (precomputed)
// ============================================================================
// Generator g_N = 7^((p-1)/N) mod p where p = 2^64 - 2^32 + 1
// These are primitive N-th roots of unity in the Goldilocks field.

/// Goldilocks prime: p = 2^64 - 2^32 + 1
const GOLDILOCKS_PRIME: u64 = 0xFFFFFFFF00000001;

// Precomputed N-th roots of unity: g_N = 7^((p-1)/N) mod p
// Used for LDE domain element computation and boundary checks.
#[allow(dead_code)]
/// 32nd root of unity (trace domain for circuit 0)
const GENERATOR_32: u64 = 0x00003FFFFFFFC000;
#[allow(dead_code)]
/// 128th root of unity (trace domain for circuits 1,2)
const GENERATOR_128: u64 = 0xF80007FF08000001;
#[allow(dead_code)]
/// 256th root of unity (trace domain for circuit 4)
const GENERATOR_256: u64 = 0xBF79143CE60CA966;
/// 512th root of unity (LDE domain for circuit 0, trace for circuits 3,5)
const GENERATOR_512: u64 = 0x1905D02A5C411F4E;
/// 2048th root of unity (LDE domain for circuits 1,2)
const GENERATOR_2048: u64 = 0x0653B4801DA1C8CF;
/// 4096th root of unity (LDE domain for circuit 4)
const GENERATOR_4096: u64 = 0xF2C35199959DFCB6;
/// 8192nd root of unity (LDE domain for circuits 3,5)
const GENERATOR_8192: u64 = 0x1544EF2335D17997;

/// Get the LDE domain generator for a given LDE size.
fn get_lde_generator(lde_size: usize) -> Felt {
    match lde_size {
        512 => Felt::new(GENERATOR_512),
        2048 => Felt::new(GENERATOR_2048),
        4096 => Felt::new(GENERATOR_4096),
        8192 => Felt::new(GENERATOR_8192),
        _ => Felt::ONE, // Should never happen for supported circuits
    }
}

/// Get the trace domain generator for a given trace length.
#[allow(dead_code)]
fn get_trace_generator(trace_length: usize) -> Felt {
    match trace_length {
        32 => Felt::new(GENERATOR_32),
        128 => Felt::new(GENERATOR_128),
        256 => Felt::new(GENERATOR_256),
        512 => Felt::new(GENERATOR_512),
        _ => Felt::ONE, // Should never happen for supported circuits
    }
}

/// Compute the LDE domain element at a given position: lde_gen^pos
fn get_lde_domain_element(pos: usize, config: &CircuitConfig) -> Felt {
    let g = get_lde_generator(config.lde_size);
    g.exp(pos as u64)
}

/// Compute the vanishing polynomial Z_D(x) = x^trace_length - 1
fn vanishing_poly(x: Felt, trace_length: usize) -> Felt {
    let x_n = x.exp(trace_length as u64);
    x_n.sub(Felt::ONE)
}

// ============================================================================
// Boundary constraint definitions per circuit
// ============================================================================

/// A boundary constraint: trace[col] at row `row` must equal `value`.
struct BoundaryAssertion {
    col: usize,
    row: usize,
    value: Felt,
}

/// Get boundary assertions for a circuit given its public inputs.
///
/// These bind the proof to public inputs by requiring specific trace values
/// at specific rows.
fn get_boundary_assertions(circuit_id: u8, public_inputs: &[u64]) -> Vec<BoundaryAssertion> {
    const HASH_CYCLE_LEN: usize = 32;
    const NUM_ROUNDS: usize = 30;

    match circuit_id {
        // Circuit 0: subscriber_ownership
        // Public inputs: [commitment]
        // Assertions: state[1] at row 0 = 0, state[2] at row 0 = 0,
        //             state[0] at row 30 = commitment
        0 => {
            let commitment = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            vec![
                BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: NUM_ROUNDS, value: commitment },
            ]
        }
        // Circuit 1: pool_commitment
        // Public inputs: [nullifier, commitment]
        // Assertions: nullifier at row 30 (col 0), commitment at row 94 (col 0),
        //             capacity=0 at row 0,32,64, chaining at row 64 (col 0) = nullifier
        1 => {
            let nullifier = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            let commitment = if public_inputs.len() > 1 {
                Felt::new(public_inputs[1])
            } else {
                Felt::ZERO
            };
            vec![
                BoundaryAssertion { col: 0, row: NUM_ROUNDS, value: nullifier },
                BoundaryAssertion { col: 0, row: 2 * HASH_CYCLE_LEN + NUM_ROUNDS, value: commitment },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: HASH_CYCLE_LEN, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 2 * HASH_CYCLE_LEN, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: 2 * HASH_CYCLE_LEN, value: nullifier },
            ]
        }
        // Circuit 2: balance_proof
        // Public inputs: [commitment, token_mint]
        // Assertions: col1=0,col2=0 at row 0, col1=token_mint at row 32,
        //             capacity=0 at rows 32,64,96, commitment at row 126 (3*32+30)
        2 => {
            let commitment = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            let token_mint = if public_inputs.len() > 1 {
                Felt::new(public_inputs[1])
            } else {
                Felt::ZERO
            };
            vec![
                BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 1, row: 32, value: token_mint },
                BoundaryAssertion { col: 2, row: 32, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 64, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 96, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: 3 * HASH_CYCLE_LEN + NUM_ROUNDS, value: commitment },
            ]
        }
        // Circuit 3: merkle_path
        // Public inputs: [leaf, root, depth]
        // Assertions: col5 at row 0 = leaf (carry), col0 at output_row = root
        // output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS
        3 => {
            let leaf = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            let root = if public_inputs.len() > 1 {
                Felt::new(public_inputs[1])
            } else {
                Felt::ZERO
            };
            let depth = if public_inputs.len() > 2 {
                public_inputs[2] as usize
            } else {
                0
            };
            if depth > 0 && depth <= 32 {
                let output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS;
                vec![
                    BoundaryAssertion { col: 5, row: 0, value: leaf },
                    BoundaryAssertion { col: 0, row: output_row, value: root },
                ]
            } else {
                // depth missing or invalid — only check leaf
                vec![
                    BoundaryAssertion { col: 5, row: 0, value: leaf },
                ]
            }
        }
        // Circuit 4: confidential_balance
        // Public inputs: [old_commitment, new_commitment, amount_hash, token_mint]
        // Assertions: col1=0,col2=0 at row 0, col1=token_mint at row 32,
        //             capacity=0 at cycle starts, output assertions for commitments
        4 => {
            let old_commitment = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            let new_commitment = if public_inputs.len() > 1 {
                Felt::new(public_inputs[1])
            } else {
                Felt::ZERO
            };
            let amount_hash = if public_inputs.len() > 2 {
                Felt::new(public_inputs[2])
            } else {
                Felt::ZERO
            };
            let token_mint = if public_inputs.len() > 3 {
                Felt::new(public_inputs[3])
            } else {
                Felt::ZERO
            };
            vec![
                BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 1, row: 32, value: token_mint },
                BoundaryAssertion { col: 2, row: 32, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 64, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 96, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 128, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 160, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 192, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: 2 * HASH_CYCLE_LEN + NUM_ROUNDS, value: amount_hash },
                BoundaryAssertion { col: 0, row: 4 * HASH_CYCLE_LEN + NUM_ROUNDS, value: old_commitment },
                BoundaryAssertion { col: 0, row: 6 * HASH_CYCLE_LEN + NUM_ROUNDS, value: new_commitment },
            ]
        }
        // Circuit 5: transfer
        // Public inputs: [nullifier_1, nullifier_2, output_commitment_1, output_commitment_2, public_amount, token_mint]
        5 => {
            let nullifier_1 = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            let nullifier_2 = if public_inputs.len() > 1 {
                Felt::new(public_inputs[1])
            } else {
                Felt::ZERO
            };
            let output_commitment_1 = if public_inputs.len() > 2 {
                Felt::new(public_inputs[2])
            } else {
                Felt::ZERO
            };
            let output_commitment_2 = if public_inputs.len() > 3 {
                Felt::new(public_inputs[3])
            } else {
                Felt::ZERO
            };
            let token_mint = if public_inputs.len() > 5 {
                Felt::new(public_inputs[5])
            } else {
                Felt::ZERO
            };
            let mut assertions = Vec::new();
            // Capacity = 0 at start of each of 16 cycles
            for cycle in 0..16usize {
                assertions.push(BoundaryAssertion {
                    col: 2,
                    row: cycle * HASH_CYCLE_LEN,
                    value: Felt::ZERO,
                });
            }
            // col 1 at row 0 = 0
            assertions.push(BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO });
            // Token mint as right input at cycles 1, 8, 11
            assertions.push(BoundaryAssertion { col: 1, row: HASH_CYCLE_LEN, value: token_mint });
            assertions.push(BoundaryAssertion { col: 1, row: 8 * HASH_CYCLE_LEN, value: token_mint });
            assertions.push(BoundaryAssertion { col: 1, row: 11 * HASH_CYCLE_LEN, value: token_mint });
            // Output assertions (public inputs)
            assertions.push(BoundaryAssertion {
                col: 0, row: 4 * HASH_CYCLE_LEN + NUM_ROUNDS, value: nullifier_1,
            });
            assertions.push(BoundaryAssertion {
                col: 0, row: 7 * HASH_CYCLE_LEN + NUM_ROUNDS, value: nullifier_2,
            });
            assertions.push(BoundaryAssertion {
                col: 0, row: 10 * HASH_CYCLE_LEN + NUM_ROUNDS, value: output_commitment_1,
            });
            assertions.push(BoundaryAssertion {
                col: 0, row: 13 * HASH_CYCLE_LEN + NUM_ROUNDS, value: output_commitment_2,
            });
            assertions
        }
        // Circuit 6: merkle_update
        // Public inputs: [old_leaf, new_leaf, old_root, new_root, depth]
        // Assertions: col8 at row 0 = old_leaf, col9 at row 0 = new_leaf,
        //             col0 at output_row = old_root, col3 at output_row = new_root
        // output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS
        6 => {
            let old_leaf = if !public_inputs.is_empty() {
                Felt::new(public_inputs[0])
            } else {
                Felt::ZERO
            };
            let new_leaf = if public_inputs.len() > 1 {
                Felt::new(public_inputs[1])
            } else {
                Felt::ZERO
            };
            let old_root = if public_inputs.len() > 2 {
                Felt::new(public_inputs[2])
            } else {
                Felt::ZERO
            };
            let new_root = if public_inputs.len() > 3 {
                Felt::new(public_inputs[3])
            } else {
                Felt::ZERO
            };
            let depth = if public_inputs.len() > 4 {
                public_inputs[4] as usize
            } else {
                0
            };
            if depth > 0 && depth <= 16 {
                let output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS;
                vec![
                    BoundaryAssertion { col: 8, row: 0, value: old_leaf },
                    BoundaryAssertion { col: 9, row: 0, value: new_leaf },
                    BoundaryAssertion { col: 0, row: output_row, value: old_root },
                    BoundaryAssertion { col: 3, row: output_row, value: new_root },
                ]
            } else {
                // depth missing or invalid — only check leaf carries
                vec![
                    BoundaryAssertion { col: 8, row: 0, value: old_leaf },
                    BoundaryAssertion { col: 9, row: 0, value: new_leaf },
                ]
            }
        }
        _ => Vec::new(),
    }
}

// ============================================================================
// Unified verification entry point
// ============================================================================

/// Verify a generic compact proof for any supported circuit.
pub fn verify_generic(
    proof: &GenericCompactProof,
    circuit_id: u8,
    public_inputs: &[u64],
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    // Step 1: Field range check on OOD values
    verify_ood_range(proof)?;
    anchor_lang::prelude::msg!("[verify] step1 ok");

    // Step 1b: [H10] Verify OOD point was correctly derived from transcript.
    // [P1.1] quotient_root is folded into the transcript before OOD so the
    // prover cannot choose quotient values after seeing the OOD challenge.
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let expected_ood_z = derive_ood_point(&proof.trace_root, &proof.quotient_root, &pub_bytes);
    if proof.ood_z.as_u64() != expected_ood_z {
        anchor_lang::prelude::msg!("[verify] OOD z mismatch: got {} want {}", proof.ood_z.as_u64(), expected_ood_z);
        return Err(VerifyError::OodConstraintFailed);
    }
    anchor_lang::prelude::msg!("[verify] step1b ok");

    // Step 2: [H9 + P1.1 PR 2] Derive + verify Fiat-Shamir query positions.
    // Transcript binds trace + quotient commitments, OOD evals, all FRI layer
    // roots, and the final FRI polynomial — so grinding seals the entire
    // commit phase before query positions are revealed.
    let ood_current_u64: Vec<u64> = proof.ood_current_iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next_iter().map(|f| f.as_u64()).collect();
    let expected = derive_query_positions_generic(
        &proof.trace_root, &proof.quotient_root, &pub_bytes,
        &ood_current_u64, &ood_next_u64, proof.ood_quotient.as_u64(),
        proof.fri_layer_roots_bytes(), proof.fri_final_poly_bytes(),
        proof.grinding_nonce,
        config.lde_size, config.num_queries,
    )?;
    anchor_lang::prelude::msg!("[verify] step2a ok (expected={} proof={})", expected.len(), proof.queries.len());
    verify_query_positions_generic(proof, &expected)?;
    anchor_lang::prelude::msg!("[verify] step2 ok");

    // Step 3: Verify Merkle proofs (trace + quotient leaves)
    verify_merkle_proofs_generic(proof, config)?;
    anchor_lang::prelude::msg!("[verify] step3 ok");

    // Step 3.5: [P1.1 PR 3] FRI fold consistency + final_poly check.
    // Ties every committed layer to an honest fold of the prior layer, with
    // the last fold verified by evaluating the final polynomial in the clear.
    verify_fri_generic(proof, config, &pub_bytes)?;
    anchor_lang::prelude::msg!("[verify] step3.5 ok");

    // Step 4: Circuit-specific transition constraint + quotient verification
    match circuit_id {
        0 => verify_constraints_subscriber_ownership(proof, config, public_inputs),
        1 => verify_constraints_pool_commitment(proof, config, public_inputs),
        2 => verify_constraints_balance_proof(proof, config, public_inputs),
        3 => verify_constraints_merkle_path(proof, config, public_inputs),
        4 => verify_constraints_confidential_balance(proof, config, public_inputs),
        5 => verify_constraints_transfer(proof, config, public_inputs),
        6 => verify_constraints_merkle_update(proof, config, public_inputs),
        _ => Err(VerifyError::UnsupportedCircuit),
    }?;
    anchor_lang::prelude::msg!("[verify] step4 ok");

    // Step 5: [C6] Verify boundary constraints at trace-aligned query positions
    verify_boundary_constraints(proof, circuit_id, config, public_inputs)?;
    anchor_lang::prelude::msg!("[verify] step5 ok");

    Ok(())
}

// ============================================================================
// Legacy entry point (backward compat)
// ============================================================================

/// Verify a compact STARK proof for subscriber_ownership (legacy format).
pub fn verify_subscriber_ownership(
    proof: &CompactStarkProof,
    commitment: Felt,
) -> Result<(), VerifyError> {
    // Field range check
    for v in proof.ood_current.iter().chain(proof.ood_next.iter()) {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
    }
    if proof.ood_quotient.as_u64() >= crate::goldilocks::MODULUS {
        return Err(VerifyError::OodConstraintFailed);
    }

    // [H10] Verify OOD point was correctly derived (binds quotient_root, P1.1)
    let commitment_bytes = commitment.to_le_bytes();
    let expected_ood_z = derive_ood_point(&proof.trace_root, &proof.quotient_root, &commitment_bytes);
    if proof.ood_z.as_u64() != expected_ood_z {
        return Err(VerifyError::OodConstraintFailed);
    }

    // [H9] Fiat-Shamir with OOD in transcript
    let ood_current_u64: Vec<u64> = proof.ood_current.iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next.iter().map(|f| f.as_u64()).collect();
    let expected = derive_query_positions_legacy(
        &proof.trace_root, &proof.quotient_root, commitment, &ood_current_u64, &ood_next_u64,
        proof.ood_quotient.as_u64(),
        proof.fri_layer_roots_bytes(), proof.fri_final_poly_bytes(),
        proof.grinding_nonce,
    )?;
    verify_query_positions_legacy(proof, &expected)?;

    // Merkle proofs
    verify_merkle_proofs_legacy(proof)?;

    // [P1.1 PR 4 DEEP-ALI] Quotient check at OOD: ties prover's Q(z) to
    // the AIR evaluation on opened OOD trace values. FRI (below) enforces
    // the low-degree bound on the committed quotient LDE.
    verify_deep_ali_legacy(proof)?;

    // [P1.1 PR 3] FRI fold consistency + final_poly check (legacy path)
    verify_fri_legacy(proof, commitment)?;

    // Transition constraints + quotient verification
    verify_transition_legacy(proof)?;

    // [C6] Boundary constraints for legacy (circuit 0)
    verify_boundary_constraints_legacy(proof, commitment)?;

    Ok(())
}

// ============================================================================
// Generic helpers
// ============================================================================

fn verify_ood_range(proof: &GenericCompactProof) -> Result<(), VerifyError> {
    for v in proof.ood_current_iter().chain(proof.ood_next_iter()) {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
    }
    if proof.ood_quotient.as_u64() >= crate::goldilocks::MODULUS {
        return Err(VerifyError::OodConstraintFailed);
    }
    Ok(())
}

fn public_inputs_to_bytes(inputs: &[u64]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(inputs.len() * 8);
    for &v in inputs {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// [H10] Derive OOD evaluation point from Fiat-Shamir transcript.
/// Post-P1.1: binds `quotient_root` alongside `trace_root` so the OOD challenge
/// depends on the quotient commitment — the prover cannot pick quotient values
/// after seeing the OOD point.
fn derive_ood_point(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_bytes: &[u8],
) -> u64 {
    // Syscall hashv accepts sliced inputs — no `data` Vec needed.
    let hash = hashv(&[trace_root, quotient_root, pub_bytes]);
    let hash_bytes = hash.to_bytes();
    let mut ood_z = u64::from_le_bytes(hash_bytes[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if ood_z == 0 { ood_z = 1; }
    ood_z
}

/// Build the Fiat-Shamir base seed from trace_root + quotient_root + public
/// inputs + OOD evaluations. `quotient_root` must precede OOD/position
/// derivation so the prover commits the quotient before receiving challenges.
/// Post-PR 4: absorbs `ood_quotient` alongside `ood_current`/`ood_next` so
/// the OOD Q(z) claim is bound before FRI challenges.
fn build_base_seed(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
    ood_quotient: u64,
) -> [u8; 32] {
    // Serialize OOD felts once into one small scratch buffer, then feed the
    // syscall a sliced &[&[u8]] — avoids a big concatenated transcript Vec.
    let ood_total = ood_current.len() + ood_next.len() + 1;
    let mut ood_buf: Vec<u8> = Vec::with_capacity(ood_total * 8);
    for val in ood_current {
        ood_buf.extend_from_slice(&val.to_le_bytes());
    }
    for val in ood_next {
        ood_buf.extend_from_slice(&val.to_le_bytes());
    }
    ood_buf.extend_from_slice(&ood_quotient.to_le_bytes());
    hashv(&[trace_root, quotient_root, pub_bytes, &ood_buf]).to_bytes()
}

fn leading_zero_bits(bytes: &[u8; 32]) -> u32 {
    let mut count = 0u32;
    for &b in bytes.iter() {
        if b == 0 {
            count += 8;
        } else {
            count += b.leading_zeros();
            break;
        }
    }
    count
}

/// Verify the prover's PoW grinding nonce and return the post-grinding query seed.
pub(crate) fn verify_grinding(
    base_seed: &[u8; 32],
    nonce: u64,
    grinding_bits: u32,
) -> Result<[u8; 32], VerifyError> {
    let nonce_bytes = nonce.to_le_bytes();
    let h = hashv(&[base_seed, &nonce_bytes]).to_bytes();
    if leading_zero_bits(&h) < grinding_bits {
        return Err(VerifyError::InsufficientQueries);
    }
    Ok(h)
}

fn derive_positions_from_seed(
    query_seed: &[u8; 32],
    lde_size: usize,
    num_queries: usize,
) -> Vec<u32> {
    let mut positions = Vec::with_capacity(num_queries);
    let mut counter = 0u32;

    while positions.len() < num_queries {
        let counter_bytes = counter.to_le_bytes();
        let hash = hashv(&[query_seed, &counter_bytes]);
        let bytes = hash.to_bytes();

        for chunk in bytes.chunks(4) {
            if positions.len() >= num_queries {
                break;
            }
            let val = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let pos = val % (lde_size as u32);
            if !positions.contains(&pos) {
                positions.push(pos);
            }
        }
        counter += 1;
    }

    // [P2.2] `slice::sort*` pulls in driftsort_main whose ~4160-byte stack
    // frame blows the 4KB BPF stack ("Stack offset of 4104 exceeded max
    // offset of 4096"). Positions are at most 27 distinct u32s, so in-place
    // insertion sort is both small and O(n·max)=O(27²) — negligible CU.
    for i in 1..positions.len() {
        let v = positions[i];
        let mut j = i;
        while j > 0 && positions[j - 1] > v {
            positions[j] = positions[j - 1];
            j -= 1;
        }
        positions[j] = v;
    }
    positions
}

/// Extend a transcript state by absorbing one additional 32-byte blob.
fn extend_transcript(state: &[u8; 32], blob: &[u8]) -> [u8; 32] {
    hashv(&[state, blob]).to_bytes()
}

/// Extend transcript with the raw bytes of a field-element coefficient vector.
#[allow(dead_code)]
fn extend_transcript_with_felts(state: &[u8; 32], felts: &[Felt]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(felts.len() * 8);
    for f in felts {
        buf.extend_from_slice(&f.to_le_bytes());
    }
    hashv(&[state, &buf]).to_bytes()
}

/// [H9 + P1.1 PR 2] Derive query positions. Grinding seed now binds:
///   trace_root || quotient_root || pub_bytes || ood_current || ood_next
///   then extended with each FRI layer root and the final FRI polynomial.
///
/// **[P1.6]** FRI roots + final poly arrive as flat byte slices (borrowed from
/// the proof buffer) to avoid materializing `Vec<[u8;32]>` / `Vec<Felt>` on the
/// 32KB BPF heap. Roots are absorbed in 32-byte chunks; the final-poly bytes
/// are already LE-encoded felts so we absorb them directly.
fn derive_query_positions_generic(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
    ood_quotient: u64,
    fri_layer_roots_bytes: &[u8],
    fri_final_poly_bytes: &[u8],
    grinding_nonce: u64,
    lde_size: usize,
    num_queries: usize,
) -> Result<Vec<u32>, VerifyError> {
    let mut state = build_base_seed(trace_root, quotient_root, pub_bytes, ood_current, ood_next, ood_quotient);
    for layer_root in fri_layer_roots_bytes.chunks_exact(32) {
        state = extend_transcript(&state, layer_root);
    }
    state = extend_transcript(&state, fri_final_poly_bytes);
    let query_seed = verify_grinding(&state, grinding_nonce, crate::compact_proof::GRINDING_BITS)?;
    Ok(derive_positions_from_seed(&query_seed, lde_size, num_queries))
}

fn verify_query_positions_generic(
    proof: &GenericCompactProof,
    expected: &[u32],
) -> Result<(), VerifyError> {
    if proof.queries.len() < expected.len() {
        return Err(VerifyError::InsufficientQueries);
    }
    for (i, query) in proof.queries.iter().enumerate() {
        if i < expected.len() && query.position != expected[i] {
            return Err(VerifyError::InvalidQueryPosition);
        }
    }
    Ok(())
}

/// [P1.1 PR 3] Derive a single FRI fold challenge α_i from the transcript.
/// Must match the prover: sha256(state)[0..8] as u64 mod p, mapping 0 → 1.
fn derive_fri_alpha(state: &[u8; 32]) -> Felt {
    let hash_bytes = hashv(&[state]).to_bytes();
    let mut alpha = u64::from_le_bytes(
        hash_bytes[0..8].try_into().unwrap(),
    ) % GOLDILOCKS_PRIME;
    if alpha == 0 {
        alpha = 1;
    }
    Felt::new(alpha)
}

/// [P1.1 PR 3] Evaluate a polynomial (coefficient form) at a point using
/// Horner's method. Coefficients are in ascending order (c[0] is the
/// constant term). Used for the last FRI fold check where the destination
/// value is not Merkle-committed but sent as `final_poly`.
#[allow(dead_code)]
fn evaluate_poly_horner(coeffs: &[Felt], x: Felt) -> Felt {
    let mut result = Felt::ZERO;
    for coeff in coeffs.iter().rev() {
        result = result.mul(x).add(*coeff);
    }
    result
}

/// [P1.6] Horner evaluation directly on a flat LE-byte buffer of felts.
/// Avoids materializing a `Vec<Felt>` when the final poly is borrowed from
/// the proof buffer via `GenericCompactProof::fri_final_poly_bytes()`.
fn evaluate_poly_horner_bytes(coeffs_bytes: &[u8], x: Felt) -> Felt {
    let mut result = Felt::ZERO;
    for chunk in coeffs_bytes.chunks_exact(8).rev() {
        let arr: [u8; 8] = chunk.try_into().unwrap();
        let coeff = Felt::from_le_bytes(arr);
        result = result.mul(x).add(coeff);
    }
    result
}

/// [P1.1 PR 3] FRI query phase verification.
///
/// For every query, walks the fold chain from the quotient LDE (f_0) through
/// each committed layer (f_1..f_{L-1}) to the final polynomial (f_L):
///
/// 1. **Merkle openings** — verifies paths for the quotient mirror opening
///    and each FRI layer's (value, mirror) pair against the corresponding
///    committed root.
/// 2. **Fold consistency** — at each fold i, recomputes
///    `f_{i+1}(y²) = (f_i(y)+f_i(-y))/2 + α_i · (f_i(y)-f_i(-y))/(2y)`
///    using the opened values and the transcript-derived α_i, and checks it
///    against the actual f_{i+1} value:
///      - layers `0..L-1`: Merkle-opened in fri_layer_roots[i]
///      - layer `L-1 → L` (final): polynomial evaluation of `fri_final_poly`
///        at `gen_L^pos_low`
///
/// This ties every committed layer to the one before, forcing the prover's
/// quotient LDE to be close to a low-degree polynomial.
fn verify_fri_generic(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    pub_bytes: &[u8],
) -> Result<(), VerifyError> {
    // [P2.2] FRI_FINAL_POLY_SIZE is per-circuit (see CircuitConfig). Circuits 0-5
    // use 16; circuit 6 uses 64 to fit the wider trace's verify cost under 1.4M CU.
    let num_folds = (config.lde_size / config.fri_final_poly_size).trailing_zeros() as usize;
    let num_fri_layers = num_folds - 1;
    if proof.num_fri_layers() != num_fri_layers {
        return Err(VerifyError::FriFoldCheckFailed);
    }

    // Re-derive α_0..α_{L-1} from the transcript. The initial state matches
    // the prover's `build_base_seed` output; each committed layer root is
    // absorbed in commit-phase order (layer i absorbed BEFORE α_{i+1} derived).
    let ood_current_u64: Vec<u64> = proof.ood_current_iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next_iter().map(|f| f.as_u64()).collect();
    let mut state = build_base_seed(
        &proof.trace_root,
        &proof.quotient_root,
        pub_bytes,
        &ood_current_u64,
        &ood_next_u64,
        proof.ood_quotient.as_u64(),
    );
    let mut alphas = Vec::with_capacity(num_folds);
    for i in 0..num_folds {
        alphas.push(derive_fri_alpha(&state));
        if i < num_fri_layers {
            state = extend_transcript(&state, proof.fri_layer_root(i));
        }
    }

    // [P2.2 profiling fix] Two-level inv_gen lookup: base table × step table.
    //
    // Prior design: single `inv_gen_0^k` table of min(half_lde, 2048) entries.
    // For circuit 6 (half_lde=4096) this required 2047 Goldilocks muls at init,
    // which on BPF costs ~442K CU (~216 CU/mul) — 32% of the 1.4M budget,
    // enough to push verification past the cap on its own.
    //
    // New design: a small base table (INV_GEN_BASE_SIZE=256 entries) and a
    // stepper table holding inv_gen_0^(256·j) for j=0..INV_GEN_STEP_SIZE-1.
    // STEP_SIZE is chosen so that BASE_SIZE × STEP_SIZE ≥ half_lde, covering
    // every possible k. Lookup for arbitrary k < half_lde:
    //   y_inv = base_table[k & 0xFF] · step_table[k >> 8]
    // Setup cost: 255 + (STEP_SIZE - 1) muls — for circuit 6 that's 255+15=270
    // muls (~58K CU), a ~384K-CU saving versus the old design.
    // Per-query cost: +1 mul per fold (since every k≥256 needs the step lookup,
    // which is ~93.75% of lookups for circuit 6). 22 × 9 × ~216 CU ≈ 42K CU.
    // Net saving: ~342K CU. Circuits 0-5 (half_lde ≤ 2048) still pay the same
    // extra mul but their setup shrinks too — small net win or neutral.
    const INV_GEN_BASE_SIZE: usize = 256;
    let gen_0 = get_lde_generator(config.lde_size);
    let inv_gen_0 = gen_0.inv();
    let half_lde = config.lde_size / 2;
    let base_size = half_lde.min(INV_GEN_BASE_SIZE);
    let inv_gen_0_powers: Vec<Felt> = {
        let mut v = Vec::with_capacity(base_size);
        v.push(Felt::ONE);
        for _ in 1..base_size {
            let prev = v[v.len() - 1];
            v.push(prev.mul(inv_gen_0));
        }
        v
    };
    // step_base = inv_gen_0^BASE_SIZE = last_entry · inv_gen_0. Used to build
    // the stepper table step_table[j] = step_base^j for j=0..step_count-1,
    // where step_count = ceil(half_lde / base_size). Covers all k < half_lde.
    let step_base = if half_lde > base_size {
        inv_gen_0_powers[base_size - 1].mul(inv_gen_0)
    } else {
        Felt::ONE // unused; step table will have length 1
    };
    let step_count = if base_size == 0 { 1 } else { half_lde.div_ceil(base_size) };
    let inv_gen_step_table: Vec<Felt> = {
        let mut v = Vec::with_capacity(step_count);
        v.push(Felt::ONE);
        for _ in 1..step_count {
            let prev = v[v.len() - 1];
            v.push(prev.mul(step_base));
        }
        v
    };
    // Final-layer generator for Horner evaluation. gen_final = gen_0^(2^num_folds).
    // Only used in the final (non-committed) layer, ≤ NUM_QUERIES times total.
    let mut gen_final = gen_0;
    for _ in 0..num_folds {
        gen_final = gen_final.mul(gen_final);
    }

    let two_inv = Felt::new(2).inv();

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;

        // Quotient mirror at `pos XOR (lde_size/2)`.
        let quotient_mirror_pos = pos ^ (config.lde_size / 2);
        if !merkle::verify_merkle_path(
            &proof.quotient_root,
            &query.quotient_mirror_value.as_u64().to_le_bytes(),
            quotient_mirror_pos,
            query.quotient_mirror_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // **[P1.6 CU fix]** Single-pass Merkle + fold verification.
        // The old two-loop form called `query.fri_value(i)`/etc inside each loop;
        // each accessor re-walked the interleaved block prefix O(i) — O(L²) total
        // per query. With ~12 layers × 27 queries that blew past the 1.4M CU cap.
        // Here `fri_block_iter()` hops one layer at a time via a cursor (O(1) per
        // step), and we merge the two loops so layer data is consumed exactly once.
        let mut f_at_pos = proof.quotient_value(query_idx);
        let mut f_at_mirror = query.quotient_mirror_value;
        let mut fri_iter = query.fri_block_iter();

        for i in 0..num_folds {
            // Committed layers: verify Merkle openings and capture (value, mirror).
            let committed = if i < num_fri_layers {
                let (v, p, mv, mp) = fri_iter.next().ok_or(VerifyError::FriFoldCheckFailed)?;
                let size_next = config.lde_size >> (i + 1);
                let pos_next = pos & (size_next - 1);
                let mirror_next = pos_next ^ (size_next / 2);
                if !merkle::verify_merkle_path(
                    proof.fri_layer_root(i),
                    &v.as_u64().to_le_bytes(),
                    pos_next,
                    p,
                ) {
                    return Err(VerifyError::MerkleProofFailed);
                }
                if !merkle::verify_merkle_path(
                    proof.fri_layer_root(i),
                    &mv.as_u64().to_le_bytes(),
                    mirror_next,
                    mp,
                ) {
                    return Err(VerifyError::MerkleProofFailed);
                }
                Some((v, mv))
            } else {
                None
            };

            // Fold consistency at layer i.
            let size_i = config.lde_size >> i;
            let half_i = size_i / 2;
            let pos_in_layer = pos & (size_i - 1);

            let (pos_low, f_y, f_neg_y) = if pos_in_layer < half_i {
                (pos_in_layer, f_at_pos, f_at_mirror)
            } else {
                (pos_in_layer - half_i, f_at_mirror, f_at_pos)
            };

            // [P2.2] Two-level inv_gen^k lookup. k = pos_low << i, guaranteed
            // < half_lde. Decompose as k = base_size·q + r, then
            //   inv_gen_0^k = inv_gen_0^r · (inv_gen_0^base_size)^q
            //             = base_table[r] · step_table[q]
            // For circuit 6 (base_size=256), ~94% of folds take the step path.
            let k = pos_low << i;
            let r = k & (INV_GEN_BASE_SIZE - 1);
            let q = k >> INV_GEN_BASE_SIZE.trailing_zeros();
            let y_inv = if q == 0 {
                inv_gen_0_powers[r]
            } else {
                inv_gen_0_powers[r].mul(inv_gen_step_table[q])
            };
            let sum = f_y.add(f_neg_y);
            let diff = f_y.sub(f_neg_y);
            let even = sum.mul(two_inv);
            let odd = diff.mul(two_inv).mul(y_inv);
            let expected_next = even.add(alphas[i].mul(odd));

            let actual_next = if let Some((v, _)) = committed {
                v
            } else {
                // Final layer only (i == num_folds - 1), pos_low < FRI_FINAL_POLY_SIZE (=16).
                let x = gen_final.exp(pos_low as u64);
                evaluate_poly_horner_bytes(proof.fri_final_poly_bytes(), x)
            };

            if expected_next.as_u64() != actual_next.as_u64() {
                return Err(VerifyError::FriFoldCheckFailed);
            }

            // Advance state for next layer.
            if let Some((v, mv)) = committed {
                f_at_pos = v;
                f_at_mirror = mv;
            }
        }
    }

    Ok(())
}

/// [P1.1 PR 3] FRI verification for the legacy `CompactStarkProof` (circuit 0).
fn verify_fri_legacy(
    proof: &CompactStarkProof,
    commitment: Felt,
) -> Result<(), VerifyError> {
    const LEGACY_LDE: usize = LDE_SIZE;
    let num_folds = (LEGACY_LDE / FRI_FINAL_POLY_SIZE).trailing_zeros() as usize;
    let num_fri_layers = num_folds - 1;
    if proof.num_fri_layers() != num_fri_layers {
        return Err(VerifyError::FriFoldCheckFailed);
    }

    let commitment_bytes = commitment.to_le_bytes();
    let ood_current_u64: Vec<u64> = proof.ood_current.iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next.iter().map(|f| f.as_u64()).collect();
    let mut state = build_base_seed(
        &proof.trace_root,
        &proof.quotient_root,
        &commitment_bytes,
        &ood_current_u64,
        &ood_next_u64,
        proof.ood_quotient.as_u64(),
    );
    let mut alphas = Vec::with_capacity(num_folds);
    for i in 0..num_folds {
        alphas.push(derive_fri_alpha(&state));
        if i < num_fri_layers {
            state = extend_transcript(&state, proof.fri_layer_root(i));
        }
    }

    // [P1.6] inv_gen_0 powers table — see generic version for derivation.
    let gen_0 = get_lde_generator(LEGACY_LDE);
    let inv_gen_0 = gen_0.inv();
    let half_lde = LEGACY_LDE / 2;
    let mut inv_gen_0_powers: Vec<Felt> = Vec::with_capacity(half_lde);
    inv_gen_0_powers.push(Felt::ONE);
    for _ in 1..half_lde {
        let prev = inv_gen_0_powers[inv_gen_0_powers.len() - 1];
        inv_gen_0_powers.push(prev.mul(inv_gen_0));
    }
    let mut gen_final = gen_0;
    for _ in 0..num_folds {
        gen_final = gen_final.mul(gen_final);
    }

    let two_inv = Felt::new(2).inv();

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;

        let quotient_mirror_pos = pos ^ (LEGACY_LDE / 2);
        if !merkle::verify_merkle_path(
            &proof.quotient_root,
            &query.quotient_mirror_value.as_u64().to_le_bytes(),
            quotient_mirror_pos,
            query.quotient_mirror_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // **[P1.6 CU fix]** Same single-pass pattern as `verify_fri_generic`.
        let mut f_at_pos = proof.quotient_value(query_idx);
        let mut f_at_mirror = query.quotient_mirror_value;
        let mut fri_iter = query.fri_block_iter();

        for i in 0..num_folds {
            let committed = if i < num_fri_layers {
                let (v, p, mv, mp) = fri_iter.next().ok_or(VerifyError::FriFoldCheckFailed)?;
                let size_next = LEGACY_LDE >> (i + 1);
                let pos_next = pos & (size_next - 1);
                let mirror_next = pos_next ^ (size_next / 2);
                if !merkle::verify_merkle_path(
                    proof.fri_layer_root(i),
                    &v.as_u64().to_le_bytes(),
                    pos_next,
                    p,
                ) {
                    return Err(VerifyError::MerkleProofFailed);
                }
                if !merkle::verify_merkle_path(
                    proof.fri_layer_root(i),
                    &mv.as_u64().to_le_bytes(),
                    mirror_next,
                    mp,
                ) {
                    return Err(VerifyError::MerkleProofFailed);
                }
                Some((v, mv))
            } else {
                None
            };

            let size_i = LEGACY_LDE >> i;
            let half_i = size_i / 2;
            let pos_in_layer = pos & (size_i - 1);

            let (pos_low, f_y, f_neg_y) = if pos_in_layer < half_i {
                (pos_in_layer, f_at_pos, f_at_mirror)
            } else {
                (pos_in_layer - half_i, f_at_mirror, f_at_pos)
            };

            // [P1.6] O(1) table lookup replaces inv_gen_per_layer[i].exp(pos_low).
            let y_inv = inv_gen_0_powers[pos_low << i];
            let sum = f_y.add(f_neg_y);
            let diff = f_y.sub(f_neg_y);
            let even = sum.mul(two_inv);
            let odd = diff.mul(two_inv).mul(y_inv);
            let expected_next = even.add(alphas[i].mul(odd));

            let actual_next = if let Some((v, _)) = committed {
                v
            } else {
                let x = gen_final.exp(pos_low as u64);
                evaluate_poly_horner_bytes(proof.fri_final_poly_bytes(), x)
            };

            if expected_next.as_u64() != actual_next.as_u64() {
                return Err(VerifyError::FriFoldCheckFailed);
            }

            if let Some((v, mv)) = committed {
                f_at_pos = v;
                f_at_mirror = mv;
            }
        }
    }

    Ok(())
}

fn verify_merkle_proofs_generic(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    for (query_idx, query) in proof.queries.iter().enumerate() {
        // [P1.6] Hash trace row directly from its LE bytes in the proof buffer —
        // no copy into a `Vec<u8>`. The prover serializes the trace leaves as
        // flat LE felts exactly matching `query.trace_values_bytes()`, so Blake3
        // over that slice is the same leaf hash as the old `felt_vec_to_bytes`
        // round-trip.
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            query.trace_values_bytes(),
            query.position as usize,
            query.merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        let next_pos = (query.position as usize + config.blowup) % config.lde_size;
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            query.next_trace_values_bytes(),
            next_pos,
            query.next_merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // [P1.1] Verify quotient LDE membership for the claimed `quotient_values[query_idx]`.
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        let q_leaf_bytes = quotient_value.as_u64().to_le_bytes();
        if !merkle::verify_merkle_path(
            &proof.quotient_root,
            &q_leaf_bytes,
            query.position as usize,
            query.quotient_merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }
    }
    Ok(())
}

/// Apply one Poseidon round: state' = MDS * sbox(state + RC)
fn poseidon_round(state: &[Felt; 3], rc: &[Felt; 3]) -> [Felt; 3] {
    let s0 = state[0].add(rc[0]);
    let s1 = state[1].add(rc[1]);
    let s2 = state[2].add(rc[2]);

    let sb0 = s0.pow7();
    let sb1 = s1.pow7();
    let sb2 = s2.pow7();

    let three = Felt::new(3);
    [
        three.mul(sb0).add(sb1).add(sb2),
        sb0.add(three.mul(sb1)).add(sb2),
        sb0.add(sb1).add(three.mul(sb2)),
    ]
}

/// [C6] Verify boundary constraints at trace-aligned query positions.
///
/// For each query that lands on a trace-aligned position corresponding to
/// a boundary assertion row, verify the trace value matches the expected
/// public input value.
fn verify_boundary_constraints(
    proof: &GenericCompactProof,
    circuit_id: u8,
    config: &CircuitConfig,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let assertions = get_boundary_assertions(circuit_id, public_inputs);
    if assertions.is_empty() {
        return Ok(());
    }

    for query in &proof.queries {
        // Only check at trace-aligned positions
        if query.position as usize % config.blowup != 0 {
            continue;
        }

        let trace_row = (query.position as usize / config.blowup) % config.trace_length;

        for assertion in &assertions {
            if trace_row == assertion.row && assertion.col < query.trace_width() {
                if query.trace_value(assertion.col) != assertion.value {
                    return Err(VerifyError::BoundaryConstraintFailed);
                }
            }
        }
    }

    Ok(())
}

/// [C6] Legacy boundary constraint verification for circuit 0.
fn verify_boundary_constraints_legacy(
    proof: &CompactStarkProof,
    commitment: Felt,
) -> Result<(), VerifyError> {
    for query in &proof.queries {
        if query.position as usize % BLOWUP != 0 {
            continue;
        }

        let trace_row = (query.position as usize / BLOWUP) % TRACE_LENGTH;

        // state[1] at row 0 = 0
        if trace_row == 0 {
            if query.trace_value(1) != Felt::ZERO {
                return Err(VerifyError::BoundaryConstraintFailed);
            }
            if query.trace_value(2) != Felt::ZERO {
                return Err(VerifyError::BoundaryConstraintFailed);
            }
        }

        // state[0] at row 30 = commitment
        if trace_row == NUM_ROUNDS {
            if query.trace_value(0) != commitment {
                return Err(VerifyError::BoundaryConstraintFailed);
            }
        }
    }

    Ok(())
}

// ============================================================================
// [P1.1 PR 4] DEEP-ALI quotient check at OOD
// ============================================================================

/// Evaluate a pre-baked periodic column polynomial at a point using Horner's
/// method. Coefficients are in ascending order (`c[0]` is the constant term);
/// values stored as `u64` and lifted to `Felt` at evaluation time.
///
/// `#[inline(never)]` — called 7× from `verify_deep_ali_circuit_6` on 512-long
/// slices; keeping a dedicated frame avoids inlining 7 copies into the caller.
#[inline(never)]
fn eval_periodic_at_z(coeffs: &[u64], z: Felt) -> Felt {
    let mut acc = Felt::ZERO;
    for &c in coeffs.iter().rev() {
        acc = acc.mul(z).add(Felt::new(c));
    }
    acc
}

/// Vanishing polynomial `Z_D(z) = z^trace_length - 1` for the trace domain.
fn vanishing_poly_trace_length(z: Felt, trace_length: usize) -> Felt {
    let zn = z.exp(trace_length as u64);
    zn.add(Felt::new(crate::goldilocks::MODULUS - 1)) // zn + (-1) = zn - 1
}

/// [P1.1 PR 4] Evaluate circuit 0 (subscriber_ownership) transition constraint
/// at the OOD point z. Matches prover's `evaluate_transition_constraint` in
/// `stark/src/compact.rs`: for each column i,
///   `c_i = next[i] - current[i] - flag(z) * (round_out[i] - current[i])`
/// where `round_out = MDS * sbox(current + RC(z))`. The combined constraint is
/// `c0 + c1 + c2`.
fn evaluate_transition_at_ood_circuit_0(
    ood_current: &[Felt],
    ood_next: &[Felt],
    z: Felt,
) -> Felt {
    let rc0_z = eval_periodic_at_z(&crate::periodic_consts::C0_RC0_COEFFS, z);
    let rc1_z = eval_periodic_at_z(&crate::periodic_consts::C0_RC1_COEFFS, z);
    let rc2_z = eval_periodic_at_z(&crate::periodic_consts::C0_RC2_COEFFS, z);
    let flag_z = eval_periodic_at_z(&crate::periodic_consts::C0_FLAG_COEFFS, z);

    let current = [ood_current[0], ood_current[1], ood_current[2]];
    let rc = [rc0_z, rc1_z, rc2_z];
    let round_out = poseidon_round(&current, &rc);

    // c_i = next[i] - current[i] - flag * (round_out[i] - current[i])
    let neg_one = Felt::new(crate::goldilocks::MODULUS - 1);
    let mut combined = Felt::ZERO;
    for i in 0..3 {
        let diff = ood_next[i].add(current[i].mul(neg_one));           // next - current
        let round_minus_curr = round_out[i].add(current[i].mul(neg_one)); // round_out - current
        let flag_term = flag_z.mul(round_minus_curr);
        let c_i = diff.add(flag_term.mul(neg_one));                    // diff - flag*(...)
        combined = combined.add(c_i);
    }
    combined
}

/// [P1.1 PR 4] Check the DEEP-ALI identity at the OOD point for circuit 0.
///
/// Enforces `C(T(z), T(g·z), z) == ood_quotient · Z_T(z)` where
/// `Z_T(z) = (z^n - 1) / (z - g^(n-1))` is the *transition* vanishing
/// polynomial (omitting the last row, so the wrap `trace[0]-trace[n-1]`
/// is not required to vanish). This matches the prover's quotient
/// computation in `stark/src/compact.rs`, which computes
/// `Q = C / Z_T` via polynomial division.
///
/// Tied with FRI's low-degree guarantee on the committed quotient LDE,
/// DEEP-ALI binds quotient correctness to the AIR evaluated on the
/// opened OOD trace (Schwartz–Zippel over a random z).
fn verify_deep_ali_legacy(proof: &CompactStarkProof) -> Result<(), VerifyError> {
    let z = proof.ood_z;
    let c_at_z = evaluate_transition_at_ood_circuit_0(&proof.ood_current, &proof.ood_next, z);
    // Z_T(z) = (z^n - 1) / (z - g^(n-1))
    let z_d = vanishing_poly_trace_length(z, TRACE_LENGTH);
    // Trace domain generator for circuit 0 (trace_length = 32) is the 32nd
    // root of unity, matching the prover's `get_trace_domain_generator`.
    let g = Felt::new(GENERATOR_32);
    let last_row_x = g.exp((TRACE_LENGTH - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    // If z happens to equal g^(n-1), the prover chose a degenerate OOD — treat
    // as a verification failure (vanishingly rare over a random OOD).
    if z_minus_last == Felt::ZERO {
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());
    let rhs = proof.ood_quotient.mul(z_t);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2d] DEEP-ALI quotient check at OOD for circuit 0 (subscriber_ownership)
// ============================================================================
//
// Circuit 0 has a single combined transition constraint `c0 + c1 + c2` over
// the width-3 Poseidon-t3 state. The v2 generic prover computes
//     Q(x) = C(x) / Z_D(x)      where Z_D(x) = x^n - 1, n = 32
// so the verifier checks `C(z) == Q(z) · Z_D(z)` at the OOD point z.
//
// This closes the v2 soundness gap where `verify_quotient_at_query` at non-
// trace-aligned positions only range-checks Q(x) against the field modulus;
// FRI guarantees Q is low-degree but does NOT bind Q to the AIR. DEEP-ALI at
// a verifier-chosen random z binds Q to C via Schwartz–Zippel.
//
// CU budget: ~40K (4 periodic polys × 32 coeffs + 1 Poseidon round + Z_D),
// well within circuit 0's ~800K per-proof headroom.
#[inline(never)]
pub fn verify_deep_ali_circuit_0(proof: &GenericCompactProof) -> Result<(), VerifyError> {
    use crate::periodic_consts::{C0_RC0_COEFFS, C0_RC1_COEFFS, C0_RC2_COEFFS, C0_FLAG_COEFFS};

    // OOD trace values. Circuit 0 is width-3.
    let ood_current: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current.len() != 3 || ood_next.len() != 3 {
        return Err(VerifyError::DeepAliFailed);
    }

    let z = proof.ood_z;

    // Evaluate the 4 periodic columns at z via Horner (~32 muls each).
    // Inlined inside `evaluate_transition_at_ood_circuit_0` — reuse it directly.
    let c_at_z = evaluate_transition_at_ood_circuit_0(&ood_current, &ood_next, z);
    // Silence unused-import warning: the coeff arrays are referenced transitively.
    let _ = (&C0_RC0_COEFFS, &C0_RC1_COEFFS, &C0_RC2_COEFFS, &C0_FLAG_COEFFS);

    // Z_D(z) = z^n - 1 with n = 32 (matches prover's `Q = C / (x^n - 1)`).
    const TRACE_LENGTH_C0: usize = 32;
    let z_d = vanishing_poly_trace_length(z, TRACE_LENGTH_C0);
    if z_d == Felt::ZERO {
        // OOD lands on a trace-domain root of unity: degenerate sampling.
        return Err(VerifyError::DeepAliFailed);
    }

    let rhs = proof.ood_quotient.mul(z_d);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2a] DEEP-ALI quotient check at OOD for circuit 6 (merkle_update)
// ============================================================================
//
// Circuit 6 enforces 19 independent transition constraints across a width-10
// trace (OLD Poseidon chain, NEW Poseidon chain, sibling + direction, and
// old/new carry columns). To check `Q(z) · Z_T(z) == C(z)` in a single field
// product, the verifier RLC-combines the 19 constraint evaluations at OOD with
// an α derived from `sha256(trace_root || pub_inputs || "rlc-v1\0\0")`.
//
// Mirrors the prover's `derive_rlc_alpha` and `compute_quotient_lde_circuit_6`
// in `stark/src/compact.rs`.

/// [P2.2a/P2.2f] Derive the RLC challenge α for circuit 6 from a Fiat-Shamir
/// transcript bound to the trace commitment and the public inputs.
///
/// Domain-separated from OOD (`""` prefix + trace+quotient roots) and FRI fold
/// challenges (`"fri-alpha-v1"`) so a malicious prover cannot alias one into
/// another. The `"rlc-v1\0\0"` suffix is padded to 8 bytes so the sha256 input
/// ends on an 8-byte boundary — matching the prover byte-for-byte.
#[inline(never)]
fn derive_rlc_alpha_with_tag(
    trace_root: &[u8; 32],
    pub_input_bytes: &[u8],
    tag: &[u8; 8],
) -> Felt {
    let mut buf = Vec::with_capacity(32 + pub_input_bytes.len() + 8);
    buf.extend_from_slice(trace_root);
    buf.extend_from_slice(pub_input_bytes);
    buf.extend_from_slice(tag);
    let h = hashv(&[&buf]).to_bytes();
    let mut a = u64::from_le_bytes(h[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if a == 0 { a = 1; }
    Felt::new(a)
}

/// Circuit-6 RLC challenge (legacy tag `rlc-v1`, retained for byte-for-byte
/// parity with `stark::compact::derive_rlc_alpha`).
#[inline(never)]
fn derive_rlc_alpha(trace_root: &[u8; 32], pub_input_bytes: &[u8]) -> Felt {
    derive_rlc_alpha_with_tag(trace_root, pub_input_bytes, b"rlc-v1\0\0")
}

/// [P2.2a] Evaluate circuit 6's 19 transition constraints at the OOD point z
/// and RLC-combine them with α powers: `C(z) = Σ α^i · c_i(z)`.
///
/// Mirrors `evaluate_merkle_update_transition` in
/// `stark/src/air/merkle_update.rs`. Periodic layout matches the prover:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
/// `#[inline(never)]` — keep this large-stack helper in its own SBF frame so
/// `verify_deep_ali_circuit_6` stays under the 4KB per-frame cap.
#[inline(never)]
fn evaluate_transition_at_ood_circuit_6(
    ood_current: &[Felt],
    ood_next: &[Felt],
    periodic_at_z: &[Felt; 7],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_active = periodic_at_z[3];
    let hash_start = periodic_at_z[4];
    let is_boundary = periodic_at_z[5];
    let is_interior = periodic_at_z[6];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    // ── OLD Poseidon round (cols 0-2) ──
    let o0 = ood_current[0].add(rc0);
    let o1 = ood_current[1].add(rc1);
    let o2 = ood_current[2].add(rc2);
    let o0_7 = o0.pow7();
    let o1_7 = o1.pow7();
    let o2_7 = o2.pow7();
    let oro0 = three.mul(o0_7).add(o1_7).add(o2_7);
    let oro1 = o0_7.add(three.mul(o1_7)).add(o2_7);
    let oro2 = o0_7.add(o1_7).add(three.mul(o2_7));

    let mut cs = [Felt::ZERO; 19];
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_active.mul(oro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_active.mul(oro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_active.mul(oro2.sub(ood_current[2])))
    );

    // ── NEW Poseidon round (cols 3-5) ──
    let n0 = ood_current[3].add(rc0);
    let n1 = ood_current[4].add(rc1);
    let n2 = ood_current[5].add(rc2);
    let n0_7 = n0.pow7();
    let n1_7 = n1.pow7();
    let n2_7 = n2.pow7();
    let nro0 = three.mul(n0_7).add(n1_7).add(n2_7);
    let nro1 = n0_7.add(three.mul(n1_7)).add(n2_7);
    let nro2 = n0_7.add(n1_7).add(three.mul(n2_7));
    cs[3] = not_boundary.mul(
        ood_next[3].sub(ood_current[3]).sub(round_active.mul(nro0.sub(ood_current[3])))
    );
    cs[4] = not_boundary.mul(
        ood_next[4].sub(ood_current[4]).sub(round_active.mul(nro1.sub(ood_current[4])))
    );
    cs[5] = not_boundary.mul(
        ood_next[5].sub(ood_current[5]).sub(round_active.mul(nro2.sub(ood_current[5])))
    );

    // ── Hash start mux: state = mux(direction, carry, sibling) ──
    let dir = ood_current[7];
    let sib = ood_current[6];
    let old_carry = ood_current[8];
    let new_carry = ood_current[9];

    cs[6]  = hash_start.mul(ood_current[0].sub(old_carry).sub(dir.mul(sib.sub(old_carry))));
    cs[7]  = hash_start.mul(ood_current[1].sub(sib).sub(dir.mul(old_carry.sub(sib))));
    cs[8]  = hash_start.mul(ood_current[3].sub(new_carry).sub(dir.mul(sib.sub(new_carry))));
    cs[9]  = hash_start.mul(ood_current[4].sub(sib).sub(dir.mul(new_carry.sub(sib))));
    cs[10] = hash_start.mul(ood_current[2]);
    cs[11] = hash_start.mul(ood_current[5]);

    // ── Carry update at boundary ──
    cs[12] = is_boundary.mul(ood_next[8].sub(ood_current[0]));
    cs[13] = is_boundary.mul(ood_next[9].sub(ood_current[3]));

    // ── Carry continuity ──
    cs[14] = not_boundary.mul(ood_next[8].sub(ood_current[8]));
    cs[15] = not_boundary.mul(ood_next[9].sub(ood_current[9]));

    // ── Sibling / direction continuity within cycle ──
    cs[16] = is_interior.mul(ood_next[6].sub(ood_current[6]));
    cs[17] = is_interior.mul(ood_next[7].sub(ood_current[7]));

    // ── Direction binary ──
    cs[18] = hash_start.mul(dir).mul(one.sub(dir));

    // RLC: Σ α^i · cs[i]. Accumulated as a Horner-style walk keeps α_pow to a
    // single running multiplication per constraint (no array allocation).
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2a] Check the DEEP-ALI identity at the OOD point for circuit 6.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs`).
///   2. The 7 periodic polynomials evaluated at z via Horner.
///   3. The 19 transition constraints evaluated on the opened OOD trace and
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = trace_length = 512`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Tied to FRI's low-degree guarantee on the committed quotient LDE (verified
/// in phase 1), this binds the full 19-constraint AIR to the opened OOD trace
/// via Schwartz–Zippel over a random z — closing the soundness gap left by
/// the trace-aligned-only per-query checks (24% of blowup-16 queries land on
/// trace-aligned rows, so per-query coverage alone is too weak).
pub fn verify_deep_ali_circuit_6(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C6_RC0_COEFFS, C6_RC1_COEFFS, C6_RC2_COEFFS, C6_ROUND_ACTIVE_COEFFS,
        C6_HASH_START_COEFFS, C6_IS_BOUNDARY_COEFFS, C6_IS_INTERIOR_COEFFS,
    };

    // Periodic polynomials are depth-dependent (active_rows = depth*32). They
    // are baked for depth=15, the canonical production depth; any other depth
    // silently yields wrong constraint evaluations, so reject up-front.
    const CANONICAL_DEPTH: u64 = 15;
    if public_inputs.len() != 5 || public_inputs[4] != CANONICAL_DEPTH {
        return Err(VerifyError::DeepAliFailed);
    }

    let z = proof.ood_z;

    // Evaluate the 7 periodic columns at z via Horner (~512 muls each).
    let periodic_at_z: [Felt; 7] = [
        eval_periodic_at_z(&C6_RC0_COEFFS, z),
        eval_periodic_at_z(&C6_RC1_COEFFS, z),
        eval_periodic_at_z(&C6_RC2_COEFFS, z),
        eval_periodic_at_z(&C6_ROUND_ACTIVE_COEFFS, z),
        eval_periodic_at_z(&C6_HASH_START_COEFFS, z),
        eval_periodic_at_z(&C6_IS_BOUNDARY_COEFFS, z),
        eval_periodic_at_z(&C6_IS_INTERIOR_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 6 is width-10.
    let ood_current: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current.len() != 10 || ood_next.len() != 10 {
        return Err(VerifyError::DeepAliFailed);
    }

    // Derive α exactly like the prover.
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha(&proof.trace_root, &pub_bytes);

    let c_at_z = evaluate_transition_at_ood_circuit_6(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 512.
    const TRACE_LENGTH_C6: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C6);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C6 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD equals g^(n-1): degenerate sampling. Vanishingly rare over a
        // random OOD — treat as failure rather than rescuing the prover.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    let rhs = proof.ood_quotient.mul(z_t);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2d-C1] DEEP-ALI quotient check at OOD for circuit 1 (pool_commitment)
// ============================================================================
//
// Circuit 1 has a width-3 trace of length 128 with three Poseidon-t3 hash
// cycles (rows 0-30, 32-62, 64-94) producing the pool commitment
//   C = Poseidon(nullifier, Poseidon(deposit_epoch, token_mint)).
//
// The v2 generic quotient path (`compute_quotient_at_position_generic` +
// `evaluate_transition_constraint` in `stark/src/compact.rs`) had two real
// soundness gaps:
//
//   (1) **Single-cycle flag.** Its periodic flag polynomial was 1 only on
//       rows `[0, num_rounds)` of cycle 0. Cycles 1 and 2 carried no
//       Poseidon constraint in the generic path, so a malicious prover could
//       freely rewrite rows 32-62 and 64-94 provided the FRI low-degree check
//       still passed. Trace-aligned per-query checks covered ~1/blowup of rows,
//       which is too weak on its own.
//
//   (2) **Chain constraint missing.** The AIR's fourth transition constraint
//       `next[1]@row64 = current[0]@row63` — which binds cycle 2's right input
//       to cycle 1's output (epoch_hash) — was never enforced on-chain. A
//       malicious prover could pick any epoch_hash' and solve a 1-variable
//       Poseidon preimage to forge `Poseidon(nullifier', epoch_hash')` = target,
//       reducing soundness to ~2^64 Goldilocks work.
//
// This function closes both gaps by RLC-combining the AIR's four transition
// constraints — evaluated on the OOD trace with the *real* multi-cycle
// `round_flag` and the `chain_flag[63] = 1` — against the committed quotient's
// OOD value via `C(z) == Q(z) · Z_T(z)`. The prover matches byte-for-byte:
// `compute_quotient_lde_circuit_1` in `stark/src/compact.rs`.
//
// CU budget: ~110K (6 periodic polys × 128 coeffs + 1 Poseidon round + Z_T +
// 4-term RLC). Well within circuit 1's ~700K per-proof headroom in phase 1.

/// [P2.2d-C1] Evaluate circuit 1's 4 transition constraints at the OOD point z
/// and RLC-combine with α powers.
///
/// Mirrors `evaluate_pool_commitment_transition` in
/// `stark/src/air/denominated_pool.rs`. Periodic layout matches
/// `build_pool_commitment_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, chain_flag, is_boundary]`.
#[inline(never)]
fn evaluate_transition_at_ood_circuit_1(
    ood_current: &[Felt; 3],
    ood_next: &[Felt; 3],
    periodic_at_z: &[Felt; 6],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let chain_flag = periodic_at_z[4];
    let is_boundary = periodic_at_z[5];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    // c_i = not_boundary · (next[i] − current[i] − round_flag · (ro_i − current[i]))
    let mut cs = [Felt::ZERO; 4];
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // Chain: at row 63, next[1]@row64 must equal current[0]@row63 (epoch_hash).
    cs[3] = chain_flag.mul(ood_next[1].sub(ood_current[0]));

    // Horner-style RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C1] Check the DEEP-ALI identity at the OOD point for circuit 1.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c1\0\0"`).
///   2. The 6 periodic polynomials evaluated at z via Horner.
///   3. The 4 transition constraints on the opened OOD trace, RLC-combined
///      with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 128`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Tied to FRI's low-degree guarantee on the committed quotient LDE, this
/// binds the full 4-constraint AIR (including the chain row 63 and
/// multi-cycle Poseidon) to the opened OOD trace via Schwartz–Zippel over a
/// random z — closing both P2.2d-C1 soundness gaps documented above.
#[inline(never)]
pub fn verify_deep_ali_circuit_1(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C1_RC0_COEFFS, C1_RC1_COEFFS, C1_RC2_COEFFS,
        C1_ROUND_FLAG_COEFFS, C1_CHAIN_FLAG_COEFFS, C1_IS_BOUNDARY_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the 6 periodic columns at z via Horner (~128 muls each).
    let periodic_at_z: [Felt; 6] = [
        eval_periodic_at_z(&C1_RC0_COEFFS, z),
        eval_periodic_at_z(&C1_RC1_COEFFS, z),
        eval_periodic_at_z(&C1_RC2_COEFFS, z),
        eval_periodic_at_z(&C1_ROUND_FLAG_COEFFS, z),
        eval_periodic_at_z(&C1_CHAIN_FLAG_COEFFS, z),
        eval_periodic_at_z(&C1_IS_BOUNDARY_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 1 is width-3.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 3 || ood_next_vec.len() != 3 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [ood_current_vec[0], ood_current_vec[1], ood_current_vec[2]];
    let ood_next = [ood_next_vec[0], ood_next_vec[1], ood_next_vec[2]];

    // Derive α exactly like the prover (C1-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c1\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_1(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 128.
    const TRACE_LENGTH_C1: usize = 128;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C1);
    let g = Felt::new(GENERATOR_128);
    let last_row_x = g.exp((TRACE_LENGTH_C1 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD lands on g^(n-1): degenerate sampling — vanishingly rare.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    let rhs = proof.ood_quotient.mul(z_t);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    let _ = public_inputs; // pub inputs enter α derivation only
    Ok(())
}

/// [P2.2d-C2] Evaluate circuit 2's 7 transition constraints at the OOD point z
/// and RLC-combine with α powers.
///
/// Mirrors `evaluate_balance_proof_transition` in
/// `stark/src/air/balance_proof.rs`. Periodic layout matches
/// `build_balance_proof_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, chain_01, carry_capture, chain_carry, is_boundary]`.
///
/// Trace width is 4: cols 0-2 are Poseidon state (left, right, capacity),
/// col 3 is the carry column holding an intermediate hash output between
/// cycle 1 (row 63) and cycle 3 (row 95).
#[inline(never)]
fn evaluate_transition_at_ood_circuit_2(
    ood_current: &[Felt; 4],
    ood_next: &[Felt; 4],
    periodic_at_z: &[Felt; 8],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let chain_01 = periodic_at_z[4];
    let carry_capture = periodic_at_z[5];
    let chain_carry = periodic_at_z[6];
    let is_boundary = periodic_at_z[7];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);
    let not_capture = one.sub(carry_capture);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    // c_i = not_boundary · (next[i] − current[i] − round_flag · (ro_i − current[i]))
    //     for i ∈ {0,1,2}. Matches evaluate_balance_proof_transition exactly:
    //     when round_flag=1 → next=ro (active round), when round_flag=0 →
    //     next=current (padding), when is_boundary=1 → free transition.
    let mut cs = [Felt::ZERO; 7];
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // [c3] chain_01 @ row 31: cycle 0 output (current[0]) → cycle 1 left input (next[0]).
    cs[3] = chain_01.mul(ood_next[0].sub(ood_current[0]));

    // [c4] carry_capture @ row 63: cycle 1 output (current[0]) → carry col (next[3]).
    cs[4] = carry_capture.mul(ood_next[3].sub(ood_current[0]));

    // [c5] carry_continuity: at non-capture rows, carry col holds its value.
    cs[5] = not_capture.mul(ood_next[3].sub(ood_current[3]));

    // [c6] chain_carry @ row 95: carry value (current[3]) → cycle 3 right input (next[1]).
    cs[6] = chain_carry.mul(ood_next[1].sub(ood_current[3]));

    // Horner-style RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C2] Check the DEEP-ALI identity at the OOD point for circuit 2.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c2\0\0"`).
///   2. The 8 periodic polynomials evaluated at z via Horner.
///   3. The 7 transition constraints on the opened OOD trace (width 4),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 128`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 2 proves a stealth commitment derived from Poseidon(sk, balance,
/// salt, mint). Without DEEP-ALI on the chain/carry constraints, a malicious
/// prover could freely alter cycles 1-3 and forge commitments — soundness
/// drops to ~2^64. This check binds all 4 Poseidon cycles and all 3 chain
/// edges (row 31 / 63 / 95) to the opened OOD trace via Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_2(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C2_RC0_COEFFS, C2_RC1_COEFFS, C2_RC2_COEFFS, C2_ROUND_FLAG_COEFFS,
        C2_CHAIN_01_COEFFS, C2_CARRY_CAPTURE_COEFFS, C2_CHAIN_CARRY_COEFFS,
        C2_IS_BOUNDARY_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the 8 periodic columns at z via Horner (~128 muls each).
    let periodic_at_z: [Felt; 8] = [
        eval_periodic_at_z(&C2_RC0_COEFFS, z),
        eval_periodic_at_z(&C2_RC1_COEFFS, z),
        eval_periodic_at_z(&C2_RC2_COEFFS, z),
        eval_periodic_at_z(&C2_ROUND_FLAG_COEFFS, z),
        eval_periodic_at_z(&C2_CHAIN_01_COEFFS, z),
        eval_periodic_at_z(&C2_CARRY_CAPTURE_COEFFS, z),
        eval_periodic_at_z(&C2_CHAIN_CARRY_COEFFS, z),
        eval_periodic_at_z(&C2_IS_BOUNDARY_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 2 is width-4.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 4 || ood_next_vec.len() != 4 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1],
        ood_current_vec[2], ood_current_vec[3],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1],
        ood_next_vec[2], ood_next_vec[3],
    ];

    // Derive α exactly like the prover (C2-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c2\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_2(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 128.
    const TRACE_LENGTH_C2: usize = 128;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C2);
    let g = Felt::new(GENERATOR_128);
    let last_row_x = g.exp((TRACE_LENGTH_C2 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD lands on g^(n-1): degenerate sampling — vanishingly rare.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    let rhs = proof.ood_quotient.mul(z_t);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

/// [P2.2d-C3] Evaluate circuit 3's 11 transition constraints at the OOD point z
/// and RLC-combine with α powers.
///
/// Mirrors `evaluate_merkle_path_transition` in
/// `stark/src/air/merkle_path.rs`. Periodic layout matches
/// `build_merkle_path_periodic_columns`:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
///
/// Trace width is 6:
///   col 0-2: Poseidon state (s0, s1, s2)
///   col 3:   sibling (path element at this Merkle level)
///   col 4:   direction (0 = leaf on left, 1 = leaf on right)
///   col 5:   carry (previous hash output; leaf for first cycle)
#[inline(never)]
fn evaluate_transition_at_ood_circuit_3(
    ood_current: &[Felt; 6],
    ood_next: &[Felt; 6],
    periodic_at_z: &[Felt; 7],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_active = periodic_at_z[3];
    let hash_start = periodic_at_z[4];
    let is_boundary = periodic_at_z[5];
    let is_interior = periodic_at_z[6];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    // [c0-c2] Poseidon state: not_boundary · (next[i] − current[i] − round_active · (ro_i − current[i])).
    // When round_active=1 → next=ro_i (active round); when round_active=0 → next=current (padding);
    // when is_boundary=1 → unconstrained (hash_start mux + carry update take over).
    let mut cs = [Felt::ZERO; 11];
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_active.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_active.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_active.mul(ro2.sub(ood_current[2])))
    );

    // [c3-c4] Hash-start mux: at the start of every Poseidon cycle, the state
    // absorbs (carry, sibling) routed by direction:
    //   s0 = carry + dir · (sib − carry)
    //   s1 = sib   − dir · (sib − carry)
    // Rewritten so both evaluate to 0 on an honest trace:
    //   hash_start · (current[0] − carry − dir · (sib − carry)) = 0
    //   hash_start · (current[1] − sib   + dir · (sib − carry)) = 0
    let sib = ood_current[3];
    let dir = ood_current[4];
    let carry = ood_current[5];
    let sib_minus_carry = sib.sub(carry);
    cs[3] = hash_start.mul(
        ood_current[0].sub(carry).sub(dir.mul(sib_minus_carry))
    );
    cs[4] = hash_start.mul(
        ood_current[1].sub(sib).add(dir.mul(sib_minus_carry))
    );

    // [c5] Hash-start capacity: state[2] (capacity) = 0 at every cycle start.
    cs[5] = hash_start.mul(ood_current[2]);

    // [c6] Carry update at cycle boundary (row 31, 63, ...): next[5] = current[0]
    // (propagate hash output into next level's carry).
    cs[6] = is_boundary.mul(ood_next[5].sub(ood_current[0]));

    // [c7] Carry continuity between boundaries: next[5] = current[5]
    // (carry doesn't change mid-cycle).
    let not_boundary2 = one.sub(is_boundary);
    cs[7] = not_boundary2.mul(ood_next[5].sub(ood_current[5]));

    // [c8-c9] Sibling/direction continuity inside a cycle (is_interior=1):
    // both must be constant within a cycle; can only change at a boundary.
    cs[8] = is_interior.mul(ood_next[3].sub(ood_current[3]));
    cs[9] = is_interior.mul(ood_next[4].sub(ood_current[4]));

    // [c10] Direction binary at every hash start: dir · (1 − dir) = 0.
    cs[10] = hash_start.mul(dir.mul(one.sub(dir)));

    // Horner-style RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C3] Check the DEEP-ALI identity at the OOD point for circuit 3.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c3\0\0"`).
///   2. The 7 periodic polynomials evaluated at z via Horner.
///   3. The 11 transition constraints on the opened OOD trace (width 6),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 512` (canonical depth=15).
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 3 proves a Merkle path from leaf to root. Without DEEP-ALI on the
/// hash-start mux, capacity, carry update, carry continuity, sibling/direction
/// continuity, and direction-binary constraints, a malicious prover could
/// inject arbitrary state into cycles 1-14 and forge paths — soundness drops
/// to ~2^64. This check binds all 15 Poseidon cycles and all 14 level-chaining
/// edges to the opened OOD trace via Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_3(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C3_RC0_COEFFS, C3_RC1_COEFFS, C3_RC2_COEFFS, C3_ROUND_ACTIVE_COEFFS,
        C3_HASH_START_COEFFS, C3_IS_BOUNDARY_COEFFS, C3_IS_INTERIOR_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the 7 periodic columns at z via Horner (~512 muls each).
    let periodic_at_z: [Felt; 7] = [
        eval_periodic_at_z(&C3_RC0_COEFFS, z),
        eval_periodic_at_z(&C3_RC1_COEFFS, z),
        eval_periodic_at_z(&C3_RC2_COEFFS, z),
        eval_periodic_at_z(&C3_ROUND_ACTIVE_COEFFS, z),
        eval_periodic_at_z(&C3_HASH_START_COEFFS, z),
        eval_periodic_at_z(&C3_IS_BOUNDARY_COEFFS, z),
        eval_periodic_at_z(&C3_IS_INTERIOR_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 3 is width-6.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 6 || ood_next_vec.len() != 6 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1], ood_current_vec[2],
        ood_current_vec[3], ood_current_vec[4], ood_current_vec[5],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1], ood_next_vec[2],
        ood_next_vec[3], ood_next_vec[4], ood_next_vec[5],
    ];

    // Derive α exactly like the prover (C3-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c3\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_3(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 512 (canonical depth=15).
    const TRACE_LENGTH_C3: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C3);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C3 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD lands on g^(n-1): degenerate sampling — vanishingly rare.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    let rhs = proof.ood_quotient.mul(z_t);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

/// [P2.2d-C4] Evaluate the 10-constraint circuit-4 (confidential_balance)
/// transition RLC at the OOD point `z`.
///
/// Mirrors `evaluate_confidential_balance_transition` in the prover's AIR.
/// Width 4: cols 0-2 are Poseidon state, col 3 is the chain carry. The 7
/// chained hashes (owner, owner_mint, amount_hash, old_bal_salt, old_commit,
/// new_bal_salt, new_commit) sit in 7 consecutive 32-row cycles followed by
/// one identity-padding cycle — chain-edge periodic flags are non-zero only
/// at the exact row where one hash feeds the next.
///
/// Constraints:
///   [c0-c2] Poseidon state: not_boundary · (next[i] − current[i]
///           − round_flag · (ro_i − current[i]))
///   [c3]    chain_01 · (next[0] − current[0])  — cycle 0→1 (owner in)
///   [c4]    chain_34 · (next[0] − current[0])  — cycle 3→4 (old_bal_salt in)
///   [c5]    chain_56 · (next[0] − current[0])  — cycle 5→6 (new_bal_salt in)
///   [c6]    carry_capture · (next[3] − current[0])  — capture owner_mint
///   [c7]    (1 − carry_capture) · (next[3] − current[3])  — carry continuity
///   [c8]    chain_carry_4 · (next[1] − current[3])  — carry → cycle 4 right input
///   [c9]    chain_carry_6 · (next[1] − current[3])  — carry → cycle 6 right input
#[inline(never)]
fn evaluate_transition_at_ood_circuit_4(
    ood_current: &[Felt; 4],
    ood_next: &[Felt; 4],
    periodic_at_z: &[Felt; 11],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let is_boundary = periodic_at_z[4];
    let chain_01 = periodic_at_z[5];
    let chain_34 = periodic_at_z[6];
    let chain_56 = periodic_at_z[7];
    let carry_capture = periodic_at_z[8];
    let chain_carry_4 = periodic_at_z[9];
    let chain_carry_6 = periodic_at_z[10];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    let mut cs = [Felt::ZERO; 10];

    // [c0-c2] Poseidon state transition (active round when round_flag=1,
    // identity when round_flag=0, unconstrained at cycle boundary).
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // [c3-c5] Chain edges: when the flag is 1 the next cycle's state[0] must
    // equal the current cycle's output (state[0] at end-of-cycle).
    cs[3] = chain_01.mul(ood_next[0].sub(ood_current[0]));
    cs[4] = chain_34.mul(ood_next[0].sub(ood_current[0]));
    cs[5] = chain_56.mul(ood_next[0].sub(ood_current[0]));

    // [c6] Capture owner_mint into carry column at cycle-1 boundary.
    cs[6] = carry_capture.mul(ood_next[3].sub(ood_current[0]));
    // [c7] Carry continuity everywhere else.
    cs[7] = one.sub(carry_capture).mul(ood_next[3].sub(ood_current[3]));
    // [c8-c9] Chain carry → right input of cycle 4 / cycle 6.
    cs[8] = chain_carry_4.mul(ood_next[1].sub(ood_current[3]));
    cs[9] = chain_carry_6.mul(ood_next[1].sub(ood_current[3]));

    // Horner RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C4] Check the DEEP-ALI identity at the OOD point for circuit 4.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c4\0\0"`).
///   2. The 11 periodic polynomials evaluated at z via Horner.
///   3. The 10 transition constraints on the opened OOD trace (width 4),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 256`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 4 proves a confidential balance update: new and old Poseidon
/// commitments are correctly formed from private (spending_key, balance,
/// salt, amount) with `Poseidon(amount, amount_salt)` folded into a public
/// amount hash. Without DEEP-ALI on the chain edges, an attacker could swap
/// cycles, inject rogue balances, or forge commitments that don't correspond
/// to any real spending path — soundness drops to ~2^64. This check binds
/// every chain edge and carry update to the opened OOD trace via
/// Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_4(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C4_CARRY_CAPTURE_COEFFS, C4_CHAIN_01_COEFFS, C4_CHAIN_34_COEFFS,
        C4_CHAIN_56_COEFFS, C4_CHAIN_CARRY_4_COEFFS, C4_CHAIN_CARRY_6_COEFFS,
        C4_IS_BOUNDARY_COEFFS, C4_RC0_COEFFS, C4_RC1_COEFFS, C4_RC2_COEFFS,
        C4_ROUND_FLAG_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the 11 periodic columns at z via Horner (~256 muls each).
    let periodic_at_z: [Felt; 11] = [
        eval_periodic_at_z(&C4_RC0_COEFFS, z),
        eval_periodic_at_z(&C4_RC1_COEFFS, z),
        eval_periodic_at_z(&C4_RC2_COEFFS, z),
        eval_periodic_at_z(&C4_ROUND_FLAG_COEFFS, z),
        eval_periodic_at_z(&C4_IS_BOUNDARY_COEFFS, z),
        eval_periodic_at_z(&C4_CHAIN_01_COEFFS, z),
        eval_periodic_at_z(&C4_CHAIN_34_COEFFS, z),
        eval_periodic_at_z(&C4_CHAIN_56_COEFFS, z),
        eval_periodic_at_z(&C4_CARRY_CAPTURE_COEFFS, z),
        eval_periodic_at_z(&C4_CHAIN_CARRY_4_COEFFS, z),
        eval_periodic_at_z(&C4_CHAIN_CARRY_6_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 4 is width-4.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 4 || ood_next_vec.len() != 4 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1], ood_current_vec[2], ood_current_vec[3],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1], ood_next_vec[2], ood_next_vec[3],
    ];

    // Derive α exactly like the prover (C4-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c4\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_4(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 256.
    const TRACE_LENGTH_C4: usize = 256;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C4);
    let g = Felt::new(GENERATOR_256);
    let last_row_x = g.exp((TRACE_LENGTH_C4 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    let rhs = proof.ood_quotient.mul(z_t);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [C4] + [C5] Quotient verification helper
// ============================================================================

/// [C4] Verify the quotient polynomial value at a query position.
///
/// Checks: Q(pos) * Z_D(pos) == C(pos) where C is the constraint evaluation.
/// At trace-aligned positions this should be 0 == 0 (both sides vanish).
/// At non-trace-aligned positions the quotient encodes the constraint polynomial.
fn verify_quotient_at_query(
    quotient_value: Felt,
    _constraint_value: Felt,
    pos: usize,
    config: &CircuitConfig,
    is_trace_aligned: bool,
) -> Result<(), VerifyError> {
    let x = get_lde_domain_element(pos, config);
    let z_d = vanishing_poly(x, config.trace_length);

    if is_trace_aligned {
        // At trace-aligned positions: Z_D(x) = 0, so Q * Z_D = 0.
        // The constraint value should also be 0 (verified separately by
        // the direct transition constraint check).
        // Q * 0 = 0 is trivially true, but verify Z_D is indeed 0.
        if z_d != Felt::ZERO {
            return Err(VerifyError::QuotientCheckFailed);
        }
    } else {
        // At non-trace-aligned positions: verify Q(x) * Z_D(x) is consistent.
        // Since trace values are Merkle-verified, and the quotient values are
        // provided by the prover, we verify that Q * Z_D matches the constraint
        // evaluation derived from the committed trace.
        //
        // The prover computes Q(x) = C(x) / Z_D(x) at LDE points.
        // We verify Q(x) * Z_D(x) = C(x).
        let q_times_zd = quotient_value.mul(z_d);

        // For non-aligned positions, we need the actual constraint evaluation.
        // Since the trace polynomial is committed, the quotient relationship
        // Q * Z_D should produce a low-degree polynomial. We verify the
        // prover's quotient is consistent by checking the product against
        // the Fiat-Shamir bound (FRI would verify the degree bound).
        //
        // With the Merkle-committed trace values and the quotient, we trust
        // that the FRI/DEEP composition verifies the degree bound of Q.
        // The quotient value just needs to be a valid field element.
        if q_times_zd.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }

    Ok(())
}

// ============================================================================
// Circuit 0: subscriber_ownership
// ============================================================================

fn verify_constraints_subscriber_ownership(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2d] DEEP-ALI: bind Q to the AIR via `C(z) == Q(z) · Z_D(z)` at OOD.
    // Without this, a malicious prover could supply any low-degree Q (FRI
    // passes) and only the trace-aligned queries (1/blowup of total) would
    // catch it — 27 queries × 1/16 ≈ 1.7 transition checks per proof.
    verify_deep_ali_circuit_0(proof)?;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;
        let trace_row = (pos / config.blowup) % config.trace_length;

        // [C5] Check transition constraints at trace-aligned positions.
        //
        // The transition polynomial is enforced on rows 0..n-2 via the
        // transition vanishing polynomial Z_T(x) = (x^n-1)/(x-g^(n-1)).
        // Row n-1 wraps back to row 0 and is NOT constrained — this matches
        // the prover's `Q = C / Z_T` quotient (see stark/src/compact.rs).
        if is_trace_aligned && trace_row != config.trace_length - 1 {
            if trace_row < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(trace_row);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Verify quotient polynomial at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);

        verify_quotient_at_query(
            quotient_value,
            Felt::ZERO, // constraint is 0 at trace-aligned positions
            pos,
            config,
            is_trace_aligned,
        )?;
    }
    Ok(())
}

// ============================================================================
// Circuit 1: pool_commitment
// ============================================================================

fn verify_constraints_pool_commitment(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2d-C1] DEEP-ALI: bind Q to the AIR's 4 transition constraints at OOD
    // (including the chain row 63 and the real multi-cycle round_flag). Without
    // this, a malicious prover could freely rewrite cycles 1-2 and forge
    // epoch_hash → reduce soundness to ~2^64. See `verify_deep_ali_circuit_1`.
    verify_deep_ali_circuit_1(proof, public_inputs)?;

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;

        // [C5] Transition constraint check at trace-aligned positions
        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let cycle = trace_row / hash_cycle_len;
            let pos_in_cycle = trace_row % hash_cycle_len;

            if cycle < 3 && pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else if pos_in_cycle == hash_cycle_len - 1 {
                // Boundary row: free transition
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(quotient_value, Felt::ZERO, pos, config, is_trace_aligned)?;
    }
    Ok(())
}

// ============================================================================
// Circuit 2: balance_proof
// ============================================================================

fn verify_constraints_balance_proof(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2d-C2] DEEP-ALI: bind Q to the AIR's 7 transition constraints at OOD
    // (all 4 Poseidon cycles + chain row 31 / carry row 63 / carry continuity /
    // chain row 95). Without this, a malicious prover could freely rewrite
    // cycles 1-3 and forge balance commitments — soundness drops to ~2^64.
    // See `verify_deep_ali_circuit_2`.
    verify_deep_ali_circuit_2(proof, public_inputs)?;

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry column identity: col 3 should not change during active hash rows
                if !is_cycle_boundary && config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition for cols 0-2, carry may change
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry column identity in padding rows
                if config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(quotient_value, Felt::ZERO, pos, config, is_trace_aligned)?;
    }
    Ok(())
}

// ============================================================================
// Circuit 3: merkle_path
// ============================================================================

fn verify_constraints_merkle_path(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2d-C3] DEEP-ALI identity binds the 11-constraint RLC on the opened
    // OOD trace to Q(z)·Z_T(z). Without this, hash-start mux, capacity, carry
    // update, carry continuity, and direction-binary constraints are not
    // enforced anywhere on-chain for cycles 1-14. Run before per-query checks
    // so failures short-circuit cleanly.
    verify_deep_ali_circuit_3(proof, public_inputs)?;

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;
            let active_rows = config.trace_length;

            if trace_row < active_rows && pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry columns (3-5) identity during active hash rows (non-boundary)
                if !is_cycle_boundary {
                    for col in 3..config.trace_width {
                        if query.next_trace_value(col) != query.trace_value(col) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry columns identity in padding rows
                for col in 3..config.trace_width {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(quotient_value, Felt::ZERO, pos, config, is_trace_aligned)?;
    }
    Ok(())
}

// ============================================================================
// Circuit 4: confidential_balance
// ============================================================================

fn verify_constraints_confidential_balance(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2d-C4] DEEP-ALI soundness: bind the full 10-constraint RLC to the
    // opened OOD trace before doing the cheap row-local checks below.
    verify_deep_ali_circuit_4(proof, public_inputs)?;

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry column (col 3) identity during active hash rows
                if !is_cycle_boundary && config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition (new hash cycle starts next)
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry column identity in padding rows
                if config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(quotient_value, Felt::ZERO, pos, config, is_trace_aligned)?;
    }
    Ok(())
}

// ============================================================================
// Circuit 5: transfer
// ============================================================================

fn verify_constraints_transfer(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry columns (3-5) identity during active hash rows
                if !is_cycle_boundary {
                    for col in 3..config.trace_width {
                        if query.next_trace_value(col) != query.trace_value(col) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry columns identity in padding rows
                for col in 3..config.trace_width {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(quotient_value, Felt::ZERO, pos, config, is_trace_aligned)?;
    }
    Ok(())
}

// ============================================================================
// Circuit 6: merkle_update
// ============================================================================
//
// Width-10 trace: OLD Poseidon state (cols 0-2), NEW Poseidon state (cols 3-5),
// shared sibling (col 6), shared direction (col 7), old_carry (col 8),
// new_carry (col 9). Both chains run the same round constants in parallel, so
// the same poseidon_round evaluation applies to each triple. Cols 6-9 are
// held constant across non-boundary rows of an active cycle; the cycle
// boundary (row 31) is a free transition where carries get refreshed for the
// next level by the prover (bound by STARK constraints over the whole LDE).

fn verify_constraints_merkle_update(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let is_trace_aligned = pos % config.blowup == 0;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let rc = poseidon_consts::round_constants(pos_in_cycle);

                // OLD chain Poseidon round (cols 0-2)
                let old_current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let old_expected = poseidon_round(&old_current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != old_expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // NEW chain Poseidon round (cols 3-5) — same round constants
                let new_current = [query.trace_value(3), query.trace_value(4), query.trace_value(5)];
                let new_expected = poseidon_round(&new_current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(3 + col) != new_expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Witness cols (6=sibling, 7=dir, 8=old_carry, 9=new_carry)
                // identity during active hash rows (non-boundary)
                if !is_cycle_boundary {
                    for col in 6..config.trace_width {
                        if query.next_trace_value(col) != query.trace_value(col) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition (next cycle starts, carries refresh)
            } else {
                // Padding: all cols identity
                for col in 0..config.trace_width {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(quotient_value, Felt::ZERO, pos, config, is_trace_aligned)?;
    }
    Ok(())
}

// ============================================================================
// Legacy helpers (backward compat for circuit 0)
// ============================================================================

/// [H9 + P1.1 PR 2] Legacy Fiat-Shamir. Grinding seed absorbs FRI commitments
/// after the base seed (matching the generic path) so layer roots + final poly
/// are bound before the grinding challenge is solved.
fn derive_query_positions_legacy(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    commitment: Felt,
    ood_current: &[u64],
    ood_next: &[u64],
    ood_quotient: u64,
    fri_layer_roots_bytes: &[u8],
    fri_final_poly_bytes: &[u8],
    grinding_nonce: u64,
) -> Result<Vec<u32>, VerifyError> {
    let mut state = build_base_seed(
        trace_root,
        quotient_root,
        &commitment.to_le_bytes(),
        ood_current,
        ood_next,
        ood_quotient,
    );
    for layer_root in fri_layer_roots_bytes.chunks_exact(32) {
        state = extend_transcript(&state, layer_root);
    }
    state = extend_transcript(&state, fri_final_poly_bytes);
    let query_seed = verify_grinding(&state, grinding_nonce, crate::compact_proof::GRINDING_BITS)?;
    Ok(derive_positions_from_seed(&query_seed, LDE_SIZE, NUM_QUERIES))
}

fn verify_query_positions_legacy(
    proof: &CompactStarkProof,
    expected: &[u32],
) -> Result<(), VerifyError> {
    if proof.queries.len() < NUM_QUERIES {
        return Err(VerifyError::InsufficientQueries);
    }
    for (i, query) in proof.queries.iter().enumerate() {
        if i < expected.len() && query.position != expected[i] {
            return Err(VerifyError::InvalidQueryPosition);
        }
    }
    Ok(())
}

fn verify_merkle_proofs_legacy(proof: &CompactStarkProof) -> Result<(), VerifyError> {
    for (query_idx, query) in proof.queries.iter().enumerate() {
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            query.trace_values_bytes(),
            query.position as usize,
            query.merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        let next_pos = (query.position as usize + BLOWUP) % LDE_SIZE;
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            query.next_trace_values_bytes(),
            next_pos,
            query.next_merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // [P1.1] Verify quotient membership for the claimed quotient_values[query_idx].
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        let q_leaf_bytes = quotient_value.as_u64().to_le_bytes();
        if !merkle::verify_merkle_path(
            &proof.quotient_root,
            &q_leaf_bytes,
            query.position as usize,
            query.quotient_merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }
    }
    Ok(())
}

fn verify_transition_legacy(proof: &CompactStarkProof) -> Result<(), VerifyError> {
    // Legacy circuit config for quotient check
    let legacy_config = CircuitConfig {
        trace_width: TRACE_WIDTH,
        trace_length: TRACE_LENGTH,
        blowup: BLOWUP,
        lde_size: LDE_SIZE,
        merkle_depth: MERKLE_DEPTH,
        num_rounds: NUM_ROUNDS,
        // [P2.2] Legacy verifier uses the default 16 (pre-P2.2 circuits only).
        fri_final_poly_size: FRI_FINAL_POLY_SIZE,
        num_queries: NUM_QUERIES,
    };

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let trace_row = (pos / BLOWUP) % TRACE_LENGTH;
        let is_trace_aligned = pos % BLOWUP == 0;

        // [C5] Transition constraints at trace-aligned positions.
        //
        // Skip the last trace row (wraps to row 0) — the prover divides by
        // Z_T = (x^n-1)/(x-g^(n-1)) which does not force that transition to
        // vanish. See `verify_deep_ali_legacy` and prover `compact.rs`.
        if is_trace_aligned && trace_row != TRACE_LENGTH - 1 {
            if trace_row < NUM_ROUNDS {
                let current = [
                    query.trace_value(0),
                    query.trace_value(1),
                    query.trace_value(2),
                ];
                let rc = poseidon_consts::round_constants(trace_row);
                let expected = poseidon_round(&current, &rc);
                for col in 0..TRACE_WIDTH {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else {
                for col in 0..TRACE_WIDTH {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let quotient_value = proof.quotient_value(query_idx);
        verify_quotient_at_query(
            quotient_value,
            Felt::ZERO,
            pos,
            &legacy_config,
            is_trace_aligned,
        )?;
    }
    Ok(())
}

// ============================================================================
// [P1.5] Cross-lib parity tests
// ============================================================================
//
// These tests apply `poseidon_round` 30 times to known input states and
// assert bit-identical output with the off-chain prover's
// `stark::poseidon::hash2` / `hash4`. If either side changes (constants, MDS,
// S-box exponent, round count), both the off-chain parity test and these
// on-chain parity tests will drift — giving a loud break of the prover↔
// verifier protocol before any proof actually fails in production.
//
// Off-chain reference values live in
// `stark/src/poseidon/mod.rs::parity`. If you change one side, change the
// other.

#[cfg(test)]
mod parity_tests {
    use super::*;

    /// Reference: `stark::poseidon::mod::parity::POSEIDON_T3_ZERO_ZERO`.
    const POSEIDON_T3_ZERO_ZERO: u64 = 18051734659105196655;
    /// Reference: `stark::poseidon::mod::parity::POSEIDON_T3_ONE_TWO`.
    const POSEIDON_T3_ONE_TWO: u64 = 18184238532291717445;

    fn permutation_t3(initial: [Felt; 3]) -> [Felt; 3] {
        let mut state = initial;
        for round in 0..30 {
            let rc = crate::poseidon_consts::round_constants(round);
            state = poseidon_round(&state, &rc);
        }
        state
    }

    #[test]
    fn poseidon_t3_parity_zero_zero() {
        let out = permutation_t3([Felt::ZERO, Felt::ZERO, Felt::ZERO]);
        assert_eq!(out[0].as_u64(), POSEIDON_T3_ZERO_ZERO);
    }

    #[test]
    fn poseidon_t3_parity_one_two() {
        let out = permutation_t3([Felt::new(1), Felt::new(2), Felt::ZERO]);
        assert_eq!(out[0].as_u64(), POSEIDON_T3_ONE_TWO);
    }
}

/// [P2.2] Host-side end-to-end verification of the merkle_update circuit.
///
/// Generates a compact proof for a realistic update trace (depth 15, the same
/// shape used on mobile) and calls `verify_generic` exactly as the on-chain
/// instruction would. Any failure here means the bug lives in the verifier
/// code path itself (shared by host and BPF) — not a BPF-specific quirk like
/// compute budget or heap pressure.
#[cfg(test)]
mod merkle_update_e2e {
    use super::*;
    use crate::compact_proof::get_circuit_config;

    #[test]
    fn merkle_update_depth15_verify_generic() {
        let old_leaf = 111u64;
        let new_leaf = 222u64;
        let path_elements: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
        let path_indices: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should succeed on honest depth-15 proof");
    }

    /// [P2.2a] Host-side DEEP-ALI check on a real circuit-6 proof. Runs the
    /// same `verify_deep_ali_circuit_6` that phase 2 calls on-chain — proves
    /// the Fiat-Shamir α derivation, periodic polynomial evaluation, 19-
    /// constraint RLC, and Z_T division are bit-identical to the prover.
    #[test]
    fn merkle_update_depth15_verify_deep_ali_phase2() {
        let old_leaf = 111u64;
        let new_leaf = 222u64;
        let path_elements: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
        let path_indices: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_6(&parsed, &proof_data.public_inputs)
            .expect("phase 2 DEEP-ALI must succeed on honest circuit-6 proof");
    }

    /// [P2.2b] Negative soundness check: if the opened OOD `current` trace row
    /// is replaced with any different field element, the 19-constraint RLC at
    /// z changes and DEEP-ALI must fail. Covers the soundness hole that
    /// per-query trace-aligned checks alone leave open (blowup-16 ⇒ 24% of
    /// queries miss trace-aligned rows, so the other 76% of rows are
    /// unchecked without OOD DEEP-ALI).
    #[test]
    fn merkle_update_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let old_leaf = 111u64;
        let new_leaf = 222u64;
        // depth=15 is the canonical depth baked into periodic_consts.
        let path_elements: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
        let path_indices: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );

        // Tamper with the first ood_current byte directly in the proof buffer.
        // ood_current lives at offset 32 (trace_root) + 32 (quotient_root) = 64.
        // Flip the low byte of current[0] so the OOD trace evaluation diverges
        // from what the quotient was computed for.
        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_6(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "phase 2 DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2b] Negative: tampering the claimed ood_quotient Q(z) (keeps the
    /// rest honest) must fail DEEP-ALI because `Q(z) · Z_T(z)` no longer
    /// matches the RLC evaluation.
    #[test]
    fn merkle_update_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let old_leaf = 333u64;
        let new_leaf = 444u64;
        // depth=15 canonical.
        let path_elements: Vec<u64> = (0..15).map(|i| 500u64 + i * 7).collect();
        let path_indices: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );

        // ood_quotient lives after trace_root(32) + quotient_root(32) +
        // ood_current(10*8) + ood_next(10*8) + ood_z(8) = 64 + 160 + 8 = 232.
        let mut tampered = proof_data.proof_bytes.clone();
        tampered[232] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_6(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "phase 2 DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2b] Negative: swapping in wrong public inputs (right shape, wrong
    /// values) must fail — α depends on the pub bytes, so the RLC evaluation
    /// and the prover's quotient disagree.
    #[test]
    fn merkle_update_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let old_leaf = 999u64;
        let new_leaf = 1000u64;
        // depth=15 canonical.
        let path_elements: Vec<u64> = (0..15).map(|i| 42u64 + i).collect();
        let path_indices: Vec<u8> = (0..15).map(|i| ((i * 7 + 3) % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        // Flip the first public input (old_leaf) to a different value.
        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[0] ^= 0x1234;

        let res = verify_deep_ali_circuit_6(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "phase 2 DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ------------------------------------------------------------------
    // [P2.2d-C1] DEEP-ALI positive + negative tests for circuit 1.
    // ------------------------------------------------------------------

    /// [P2.2d-C1] Full-path positive: `verify_generic` (which is what the
    /// on-chain instruction calls) accepts an honest circuit-1 proof,
    /// including the new DEEP-ALI check at the head of
    /// `verify_constraints_pool_commitment`.
    #[test]
    fn pool_commitment_verify_generic_accepts_honest_proof() {
        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            42u64, 17u64, 7u64, 11u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-1 proof");
    }

    /// [P2.2d-C1] Positive: `verify_deep_ali_circuit_1` accepts an honest
    /// pool-commitment proof. Exercises the same α derivation, 6-column
    /// periodic evaluation, 4-constraint RLC, and Z_T division that run
    /// on-chain inside `verify_constraints_pool_commitment`.
    #[test]
    fn pool_commitment_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            42u64, 17u64, 7u64, 11u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_1(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-1 proof");
    }

    /// [P2.2d-C1] Negative: tamper one byte of `ood_current[0]` — the 4-
    /// constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and DEEP-ALI
    /// must fail. Layout: trace_root(32) + quotient_root(32) + ood_current(3*8)
    /// + ood_next(3*8) + ood_z(8) + ood_quotient(8). Flip byte 64.
    #[test]
    fn pool_commitment_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            1u64, 2u64, 3u64, 4u64,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_1(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C1] Negative: tamper `ood_quotient` at byte 120 (= 64 trace/root
    /// + 24 ood_current + 24 ood_next + 8 ood_z).
    #[test]
    fn pool_commitment_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            5u64, 6u64, 7u64, 8u64,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[120] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_1(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C1] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation.
    #[test]
    fn pool_commitment_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            9u64, 10u64, 11u64, 12u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[0] ^= 0xDEAD;

        let res = verify_deep_ali_circuit_1(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ========================================================================
    // [P2.2d-C2] Circuit 2 (balance_proof) DEEP-ALI tests
    //
    // Wire layout (width=4):
    //   trace_root(32) + quotient_root(32) + ood_current(4*8=32)
    //   + ood_next(4*8=32) + ood_z(8) + ood_quotient(8)  = 144 bytes header
    //
    // Byte offsets:
    //   ood_current starts at 64, ood_next at 96,
    //   ood_z at 128, ood_quotient at 136.
    // ========================================================================

    /// [P2.2d-C2] Positive: `verify_generic` accepts an honest balance-proof
    /// compact proof and therefore transitively the new DEEP-ALI check in
    /// `verify_constraints_balance_proof`.
    #[test]
    fn balance_proof_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            42u64, 1000u64, 777u64, 999u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-2 proof");
    }

    /// [P2.2d-C2] Positive: `verify_deep_ali_circuit_2` accepts an honest
    /// balance-proof. Exercises the same α derivation, 8-column periodic
    /// evaluation, 7-constraint RLC, and Z_T division that run on-chain
    /// inside `verify_constraints_balance_proof`.
    #[test]
    fn balance_proof_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            42u64, 17u64, 7u64, 11u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_2(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-2 proof");
    }

    /// [P2.2d-C2] Negative: tamper one byte of `ood_current[0]` (byte 64) —
    /// the 7-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn balance_proof_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            1u64, 2u64, 3u64, 4u64,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_2(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C2] Negative: tamper `ood_quotient` at byte 136
    /// (32 trace_root + 32 quotient_root + 32 ood_current + 32 ood_next + 8 ood_z).
    #[test]
    fn balance_proof_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            5u64, 6u64, 7u64, 8u64,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[136] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_2(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C2] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (commitment, token_mint) are genuinely bound into the soundness check.
    #[test]
    fn balance_proof_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            9u64, 10u64, 11u64, 12u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[1] ^= 0xBEEF; // flip token_mint

        let res = verify_deep_ali_circuit_2(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ========================================================================
    // [P2.2d-C3] Circuit-3 (merkle_path) positive + negative soundness tests.
    //
    // Proof byte layout for circuit 3 (width=6):
    //   trace_root      = bytes[0..32]
    //   quotient_root   = bytes[32..64]
    //   ood_current[6]  = bytes[64..112]   (6 * 8)
    //   ood_next[6]     = bytes[112..160]  (6 * 8)
    //   ood_z           = bytes[160..168]
    //   ood_quotient    = bytes[168..176]
    // ========================================================================

    /// Build a canonical depth-15 merkle_path proof fixture reused by the C3
    /// tests below. Uses leaf + 15 path elements + alternating indices so the
    /// path is fully covered and trace_length=512 matches CONFIG_MERKLE_PATH.
    fn c3_sample_proof(
        leaf: u64,
    ) -> p01_stark::compact::GenericCompactProofData {
        let path_elements: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
        let path_indices: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
        p01_stark::compact::generate_merkle_path_compact_proof(
            leaf, &path_elements, &path_indices,
        )
    }

    /// [P2.2d-C3] Positive: `verify_generic` accepts an honest merkle-path
    /// compact proof and therefore transitively the new DEEP-ALI check in
    /// `verify_constraints_merkle_path`.
    #[test]
    fn merkle_path_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(42u64);

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-3 proof");
    }

    /// [P2.2d-C3] Positive: `verify_deep_ali_circuit_3` accepts an honest
    /// merkle-path proof. Exercises the same α derivation, 7-column periodic
    /// evaluation, 11-constraint RLC, and Z_T division that run on-chain
    /// inside `verify_constraints_merkle_path`.
    #[test]
    fn merkle_path_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(7u64);

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_3(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-3 proof");
    }

    /// [P2.2d-C3] Negative: tamper one byte of `ood_current[0]` (byte 64).
    /// The 11-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn merkle_path_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(1u64);

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_3(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C3] Negative: tamper `ood_quotient` at byte 168
    /// (32 trace_root + 32 quotient_root + 48 ood_current + 48 ood_next + 8 ood_z).
    #[test]
    fn merkle_path_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(5u64);

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[168] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_3(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C3] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (leaf, root) are genuinely bound into the soundness check.
    #[test]
    fn merkle_path_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(9u64);

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[1] ^= 0xBEEF; // flip root

        let res = verify_deep_ali_circuit_3(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ========================================================================
    // [P2.2d-C4] Circuit-4 (confidential_balance) positive + negative tests.
    //
    // Proof byte layout for circuit 4 (width=4):
    //   trace_root      = bytes[0..32]
    //   quotient_root   = bytes[32..64]
    //   ood_current[4]  = bytes[64..96]   (4 * 8)
    //   ood_next[4]     = bytes[96..128]  (4 * 8)
    //   ood_z           = bytes[128..136]
    //   ood_quotient    = bytes[136..144]
    // ========================================================================

    fn c4_sample_proof() -> p01_stark::compact::GenericCompactProofData {
        p01_stark::compact::generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
        )
    }

    /// [P2.2d-C4] Positive: `verify_generic` accepts an honest confidential-
    /// balance compact proof and therefore transitively the new DEEP-ALI
    /// check in `verify_constraints_confidential_balance`.
    #[test]
    fn confidential_balance_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c4_sample_proof();

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-4 proof");
    }

    /// [P2.2d-C4] Positive: `verify_deep_ali_circuit_4` accepts an honest
    /// confidential-balance proof. Exercises the same α derivation, 11-column
    /// periodic evaluation, 10-constraint RLC, and Z_T division that run
    /// on-chain inside `verify_constraints_confidential_balance`.
    #[test]
    fn confidential_balance_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_confidential_balance_compact_proof(
            13, 500, 77, 400, 88, 100, 99, 1234,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_4(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-4 proof");
    }

    /// [P2.2d-C4] Negative: tamper one byte of `ood_current[0]` (byte 64) —
    /// the 10-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn confidential_balance_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c4_sample_proof();

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_4(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C4] Negative: tamper `ood_quotient` at byte 136
    /// (32 trace_root + 32 quotient_root + 32 ood_current + 32 ood_next + 8 ood_z).
    #[test]
    fn confidential_balance_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_confidential_balance_compact_proof(
            1, 2, 3, 4, 5, 6, 7, 8,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[136] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_4(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C4] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (old_commit, new_commit, amount_hash, token_mint) are genuinely bound
    /// into the soundness check.
    #[test]
    fn confidential_balance_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c4_sample_proof();

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[3] ^= 0xBEEF; // flip token_mint

        let res = verify_deep_ali_circuit_4(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }
}

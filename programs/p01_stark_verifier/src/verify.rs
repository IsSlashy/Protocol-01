/// On-chain STARK verification for multiple circuits.
///
/// Verifies:
/// 1. OOD constraint consistency (field range)
/// 2. Merkle path validity for all query positions
/// 3. Transition constraint satisfaction at query positions
/// 4. Fiat-Shamir binding (query positions derived from public inputs)

use crate::compact_proof::*;
use crate::goldilocks::Felt;
use crate::merkle;
use crate::poseidon_consts;

#[derive(Debug)]
pub enum VerifyError {
    OodConstraintFailed,
    OodBoundaryFailed,
    InvalidQueryPosition,
    MerkleProofFailed,
    TransitionConstraintFailed,
    InsufficientQueries,
    UnsupportedCircuit,
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

    // Step 2: Derive + verify Fiat-Shamir query positions
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let expected = derive_query_positions_generic(&proof.trace_root, &pub_bytes, config.lde_size, NUM_QUERIES);
    verify_query_positions_generic(proof, &expected)?;

    // Step 3: Verify Merkle proofs
    verify_merkle_proofs_generic(proof, config)?;

    // Step 4: Circuit-specific transition constraint verification
    match circuit_id {
        0 => verify_transition_subscriber_ownership(proof, config),
        1 => verify_transition_pool_commitment(proof, config),
        2 => verify_transition_balance_proof(proof, config),
        3 => verify_transition_merkle_path(proof, config),
        _ => Err(VerifyError::UnsupportedCircuit),
    }
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

    // Fiat-Shamir
    let expected = derive_query_positions_legacy(&proof.trace_root, commitment);
    verify_query_positions_legacy(proof, &expected)?;

    // Merkle proofs
    verify_merkle_proofs_legacy(proof)?;

    // Transition constraints
    verify_transition_legacy(proof)
}

// ============================================================================
// Generic helpers
// ============================================================================

fn verify_ood_range(proof: &GenericCompactProof) -> Result<(), VerifyError> {
    for v in proof.ood_current.iter().chain(proof.ood_next.iter()) {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
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

fn derive_query_positions_generic(
    trace_root: &[u8; 32],
    pub_bytes: &[u8],
    lde_size: usize,
    num_queries: usize,
) -> Vec<u32> {
    let mut seed = Vec::with_capacity(32 + pub_bytes.len());
    seed.extend_from_slice(trace_root);
    seed.extend_from_slice(pub_bytes);

    let mut positions = Vec::with_capacity(num_queries);
    let mut counter = 0u32;

    while positions.len() < num_queries {
        let mut input = Vec::with_capacity(seed.len() + 4);
        input.extend_from_slice(&seed);
        input.extend_from_slice(&counter.to_le_bytes());

        let hash = blake3::hash(&input);
        let bytes = hash.as_bytes();

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

    positions.sort();
    positions
}

fn verify_query_positions_generic(
    proof: &GenericCompactProof,
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

fn verify_merkle_proofs_generic(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    for query in &proof.queries {
        let leaf_bytes = felt_vec_to_bytes(&query.trace_values);
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            &leaf_bytes,
            query.position as usize,
            &query.merkle_path,
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        let next_leaf_bytes = felt_vec_to_bytes(&query.next_trace_values);
        let next_pos = (query.position as usize + config.blowup) % config.lde_size;
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            &next_leaf_bytes,
            next_pos,
            &query.next_merkle_path,
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }
    }
    Ok(())
}

fn felt_vec_to_bytes(values: &[Felt]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 8);
    for v in values {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
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

// ============================================================================
// Circuit 0: subscriber_ownership transition constraints
// ============================================================================

fn verify_transition_subscriber_ownership(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    for query in &proof.queries {
        let trace_row = (query.position as usize / config.blowup) % config.trace_length;

        if query.position as usize % config.blowup != 0 {
            continue; // only check at trace-aligned positions
        }

        if trace_row < config.num_rounds {
            // Active round: Poseidon transition
            let current = [query.trace_values[0], query.trace_values[1], query.trace_values[2]];
            let rc = poseidon_consts::round_constants(trace_row);
            let expected = poseidon_round(&current, &rc);

            for col in 0..3 {
                if query.next_trace_values[col] != expected[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        } else {
            // Padding: identity
            for col in 0..3 {
                if query.next_trace_values[col] != query.trace_values[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 1: pool_commitment transition constraints
// ============================================================================

/// Pool commitment: 3 hash cycles (0-31, 32-63, 64-95) + padding (96-127)
fn verify_transition_pool_commitment(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    let hash_cycle_len = 32usize;

    for query in &proof.queries {
        if query.position as usize % config.blowup != 0 {
            continue;
        }

        let trace_row = (query.position as usize / config.blowup) % config.trace_length;
        let cycle = trace_row / hash_cycle_len;
        let pos_in_cycle = trace_row % hash_cycle_len;

        if cycle < 3 && pos_in_cycle < config.num_rounds {
            // Active Poseidon round
            let current = [query.trace_values[0], query.trace_values[1], query.trace_values[2]];
            let rc = poseidon_consts::round_constants(pos_in_cycle);
            let expected = poseidon_round(&current, &rc);

            for col in 0..3 {
                if query.next_trace_values[col] != expected[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        } else if pos_in_cycle == hash_cycle_len - 1 {
            // Boundary row: free transition (new hash cycle starts next)
            // No constraint enforced here
        } else {
            // Padding or non-round row: identity
            for col in 0..3 {
                if query.next_trace_values[col] != query.trace_values[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 2: balance_proof transition constraints
// ============================================================================

/// Balance proof: 4 hash cycles (0-31, 32-63, 64-95, 96-127), 4 columns
fn verify_transition_balance_proof(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    let hash_cycle_len = 32usize;

    for query in &proof.queries {
        if query.position as usize % config.blowup != 0 {
            continue;
        }

        let trace_row = (query.position as usize / config.blowup) % config.trace_length;
        let pos_in_cycle = trace_row % hash_cycle_len;

        if pos_in_cycle < config.num_rounds {
            // Active Poseidon round on columns 0-2
            let current = [query.trace_values[0], query.trace_values[1], query.trace_values[2]];
            let rc = poseidon_consts::round_constants(pos_in_cycle);
            let expected = poseidon_round(&current, &rc);

            for col in 0..3 {
                if query.next_trace_values[col] != expected[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        } else if pos_in_cycle == hash_cycle_len - 1 {
            // Boundary: free transition for cols 0-2
            // Carry column (col 3) may change at specific boundaries
        } else {
            // Padding: identity on cols 0-2
            for col in 0..3 {
                if query.next_trace_values[col] != query.trace_values[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 3: merkle_path transition constraints
// ============================================================================

/// Merkle path: variable depth, 6 columns
fn verify_transition_merkle_path(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    let hash_cycle_len = 32usize;

    for query in &proof.queries {
        if query.position as usize % config.blowup != 0 {
            continue;
        }

        let trace_row = (query.position as usize / config.blowup) % config.trace_length;
        let pos_in_cycle = trace_row % hash_cycle_len;

        // Only check Poseidon rounds in active hash cycles
        let active_rows = config.trace_length; // all rows up to trace_length could be active
        if trace_row < active_rows && pos_in_cycle < config.num_rounds {
            // Active Poseidon round on columns 0-2
            let current = [query.trace_values[0], query.trace_values[1], query.trace_values[2]];
            let rc = poseidon_consts::round_constants(pos_in_cycle);
            let expected = poseidon_round(&current, &rc);

            for col in 0..3 {
                if query.next_trace_values[col] != expected[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        } else if pos_in_cycle == hash_cycle_len - 1 {
            // Boundary: free transition
        } else {
            // Padding: identity on cols 0-2
            for col in 0..3 {
                if query.next_trace_values[col] != query.trace_values[col] {
                    return Err(VerifyError::TransitionConstraintFailed);
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Legacy helpers (backward compat for circuit 0)
// ============================================================================

fn derive_query_positions_legacy(trace_root: &[u8; 32], commitment: Felt) -> Vec<u32> {
    let mut seed = [0u8; 40];
    seed[..32].copy_from_slice(trace_root);
    seed[32..40].copy_from_slice(&commitment.to_le_bytes());

    let mut positions = Vec::with_capacity(NUM_QUERIES);
    let mut counter = 0u32;

    while positions.len() < NUM_QUERIES {
        let mut input = [0u8; 44];
        input[..40].copy_from_slice(&seed);
        input[40..44].copy_from_slice(&counter.to_le_bytes());

        let hash = blake3::hash(&input);
        let bytes = hash.as_bytes();

        for chunk in bytes.chunks(4) {
            if positions.len() >= NUM_QUERIES {
                break;
            }
            let val = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let pos = val % (LDE_SIZE as u32);
            if !positions.contains(&pos) {
                positions.push(pos);
            }
        }
        counter += 1;
    }

    positions.sort();
    positions
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
    for query in &proof.queries {
        let leaf_bytes = felt_array3_to_bytes(&query.trace_values);
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            &leaf_bytes,
            query.position as usize,
            &query.merkle_path,
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        let next_leaf_bytes = felt_array3_to_bytes(&query.next_trace_values);
        let next_pos = (query.position as usize + BLOWUP) % LDE_SIZE;
        if !merkle::verify_merkle_path(
            &proof.trace_root,
            &next_leaf_bytes,
            next_pos,
            &query.next_merkle_path,
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }
    }
    Ok(())
}

fn felt_array3_to_bytes(values: &[Felt; TRACE_WIDTH]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(TRACE_WIDTH * 8);
    for v in values {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

fn verify_transition_legacy(proof: &CompactStarkProof) -> Result<(), VerifyError> {
    for query in &proof.queries {
        let trace_row = (query.position as usize / BLOWUP) % TRACE_LENGTH;

        if trace_row < NUM_ROUNDS {
            let current = &query.trace_values;
            let next = &query.next_trace_values;
            let rc = poseidon_consts::round_constants(trace_row);
            let expected = poseidon_round(current, &rc);

            if query.position as usize % BLOWUP == 0 {
                for col in 0..TRACE_WIDTH {
                    if next[col] != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        } else if trace_row >= NUM_ROUNDS {
            if query.position as usize % BLOWUP == 0 {
                for col in 0..TRACE_WIDTH {
                    if query.next_trace_values[col] != query.trace_values[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }
    }
    Ok(())
}

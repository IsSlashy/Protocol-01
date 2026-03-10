/// Compact STARK proof format for on-chain verification.
///
/// Supports multiple circuits with different trace dimensions.
/// The circuit_id (stored in ProofBuffer) determines the trace width
/// and Merkle depth used for deserialization.

use crate::goldilocks::Felt;

// ============================================================================
// Circuit configurations
// ============================================================================

/// Circuit parameters for deserialization and verification.
pub struct CircuitConfig {
    pub trace_width: usize,
    pub trace_length: usize,
    pub blowup: usize,
    pub lde_size: usize,
    pub merkle_depth: usize,
    pub num_rounds: usize,
}

/// subscriber_ownership: 3 cols, 32 rows
pub const CONFIG_SUBSCRIBER_OWNERSHIP: CircuitConfig = CircuitConfig {
    trace_width: 3,
    trace_length: 32,
    blowup: 16,
    lde_size: 512,
    merkle_depth: 9,   // log2(512) = 9
    num_rounds: 30,
};

/// pool_commitment: 3 cols, 128 rows
pub const CONFIG_POOL_COMMITMENT: CircuitConfig = CircuitConfig {
    trace_width: 3,
    trace_length: 128,
    blowup: 16,
    lde_size: 2048,
    merkle_depth: 11,  // log2(2048) = 11
    num_rounds: 30,
};

/// balance_proof: 4 cols, 128 rows
pub const CONFIG_BALANCE_PROOF: CircuitConfig = CircuitConfig {
    trace_width: 4,
    trace_length: 128,
    blowup: 16,
    lde_size: 2048,
    merkle_depth: 11,  // log2(2048) = 11
    num_rounds: 30,
};

/// merkle_path: 6 cols, variable length (512 for depth 15)
pub const CONFIG_MERKLE_PATH: CircuitConfig = CircuitConfig {
    trace_width: 6,
    trace_length: 512, // depth 15: 15 * 32 = 480, next_pow2 = 512
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
};

/// confidential_balance: 4 cols, 256 rows (7 hash cycles of 32 + 1 padding cycle)
pub const CONFIG_CONFIDENTIAL_BALANCE: CircuitConfig = CircuitConfig {
    trace_width: 4,
    trace_length: 256,
    blowup: 16,
    lde_size: 4096,
    merkle_depth: 12,  // log2(4096) = 12
    num_rounds: 30,
};

/// transfer: 6 cols, 512 rows (14 hash cycles of 32 + 2 padding cycles)
pub const CONFIG_TRANSFER: CircuitConfig = CircuitConfig {
    trace_width: 6,
    trace_length: 512,
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
};

pub fn get_circuit_config(circuit_id: u8) -> Option<&'static CircuitConfig> {
    match circuit_id {
        0 => Some(&CONFIG_SUBSCRIBER_OWNERSHIP),
        1 => Some(&CONFIG_POOL_COMMITMENT),
        2 => Some(&CONFIG_BALANCE_PROOF),
        3 => Some(&CONFIG_MERKLE_PATH),
        4 => Some(&CONFIG_CONFIDENTIAL_BALANCE),
        5 => Some(&CONFIG_TRANSFER),
        _ => None,
    }
}

// ============================================================================
// Legacy constants (backward compatibility for circuit 0)
// ============================================================================

pub const TRACE_WIDTH: usize = 3;
pub const TRACE_LENGTH: usize = 32;
pub const BLOWUP: usize = 16;
pub const LDE_SIZE: usize = TRACE_LENGTH * BLOWUP;
pub const NUM_QUERIES: usize = 128;
pub const MERKLE_DEPTH: usize = 9; // log2(512) = 9
pub const NUM_ROUNDS: usize = 30;

// ============================================================================
// Query proof (variable-size)
// ============================================================================

/// A single query proof with variable trace width and Merkle depth.
#[derive(Clone, Debug)]
pub struct QueryProof {
    pub position: u32,
    pub trace_values: Vec<Felt>,
    pub next_trace_values: Vec<Felt>,
    pub merkle_path: Vec<[u8; 32]>,
    pub next_merkle_path: Vec<[u8; 32]>,
}

// ============================================================================
// Generic compact proof
// ============================================================================

/// Compact STARK proof supporting any circuit.
#[derive(Clone, Debug)]
pub struct GenericCompactProof {
    pub trace_root: [u8; 32],
    pub ood_current: Vec<Felt>,
    pub ood_next: Vec<Felt>,
    pub ood_z: Felt,
    pub queries: Vec<QueryProof>,
    pub quotient_values: Vec<Felt>,
}

impl GenericCompactProof {
    /// Deserialize from bytes using circuit-specific dimensions.
    pub fn from_bytes(data: &[u8], config: &CircuitConfig) -> Option<Self> {
        let tw = config.trace_width;
        let md = config.merkle_depth;
        let mut cursor = 0;

        // trace_root: 32 bytes
        if data.len() < cursor + 32 { return None; }
        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&data[cursor..cursor + 32]);
        cursor += 32;

        // ood_current: tw * 8 bytes
        let mut ood_current = Vec::with_capacity(tw);
        for _ in 0..tw {
            ood_current.push(read_felt(data, &mut cursor)?);
        }

        // ood_next: tw * 8 bytes
        let mut ood_next = Vec::with_capacity(tw);
        for _ in 0..tw {
            ood_next.push(read_felt(data, &mut cursor)?);
        }

        // ood_z: 8 bytes
        let ood_z = read_felt(data, &mut cursor)?;

        // num_queries: 2 bytes
        if data.len() < cursor + 2 { return None; }
        let num_queries = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;

        if num_queries > 256 { return None; }

        let mut queries = Vec::with_capacity(num_queries);
        for _ in 0..num_queries {
            // position: 4 bytes
            if data.len() < cursor + 4 { return None; }
            let position = u32::from_le_bytes([
                data[cursor], data[cursor + 1], data[cursor + 2], data[cursor + 3],
            ]);
            cursor += 4;

            // trace_values: tw * 8 bytes
            let mut trace_values = Vec::with_capacity(tw);
            for _ in 0..tw {
                trace_values.push(read_felt(data, &mut cursor)?);
            }

            // next_trace_values: tw * 8 bytes
            let mut next_trace_values = Vec::with_capacity(tw);
            for _ in 0..tw {
                next_trace_values.push(read_felt(data, &mut cursor)?);
            }

            // merkle_path: md * 32 bytes
            let mut merkle_path = Vec::with_capacity(md);
            for _ in 0..md {
                if data.len() < cursor + 32 { return None; }
                let mut node = [0u8; 32];
                node.copy_from_slice(&data[cursor..cursor + 32]);
                cursor += 32;
                merkle_path.push(node);
            }

            // next_merkle_path: md * 32 bytes
            let mut next_merkle_path = Vec::with_capacity(md);
            for _ in 0..md {
                if data.len() < cursor + 32 { return None; }
                let mut node = [0u8; 32];
                node.copy_from_slice(&data[cursor..cursor + 32]);
                cursor += 32;
                next_merkle_path.push(node);
            }

            queries.push(QueryProof {
                position,
                trace_values,
                next_trace_values,
                merkle_path,
                next_merkle_path,
            });
        }

        // quotient_values
        let mut quotient_values = Vec::with_capacity(num_queries);
        for _ in 0..num_queries {
            quotient_values.push(read_felt(data, &mut cursor)?);
        }

        Some(GenericCompactProof {
            trace_root,
            ood_current,
            ood_next,
            ood_z,
            queries,
            quotient_values,
        })
    }
}

// ============================================================================
// Legacy CompactStarkProof (backward compat for circuit 0)
// ============================================================================

#[derive(Clone, Debug)]
pub struct CompactStarkProof {
    pub trace_root: [u8; 32],
    pub ood_current: [Felt; TRACE_WIDTH],
    pub ood_next: [Felt; TRACE_WIDTH],
    pub ood_z: Felt,
    pub queries: Vec<LegacyQueryProof>,
    pub quotient_values: Vec<Felt>,
}

#[derive(Clone, Debug)]
pub struct LegacyQueryProof {
    pub position: u32,
    pub trace_values: [Felt; TRACE_WIDTH],
    pub next_trace_values: [Felt; TRACE_WIDTH],
    pub merkle_path: [[u8; 32]; MERKLE_DEPTH],
    pub next_merkle_path: [[u8; 32]; MERKLE_DEPTH],
}

impl CompactStarkProof {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        let mut cursor = 0;

        if data.len() < cursor + 32 { return None; }
        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&data[cursor..cursor + 32]);
        cursor += 32;

        if data.len() < cursor + 24 { return None; }
        let ood_current = read_felt_array_3(data, &mut cursor)?;
        if data.len() < cursor + 24 { return None; }
        let ood_next = read_felt_array_3(data, &mut cursor)?;
        if data.len() < cursor + 8 { return None; }
        let ood_z = read_felt(data, &mut cursor)?;

        if data.len() < cursor + 2 { return None; }
        let num_queries = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;
        if num_queries > 256 { return None; }

        let mut queries = Vec::with_capacity(num_queries);
        for _ in 0..num_queries {
            if data.len() < cursor + 4 { return None; }
            let position = u32::from_le_bytes([
                data[cursor], data[cursor + 1], data[cursor + 2], data[cursor + 3],
            ]);
            cursor += 4;

            let trace_values = read_felt_array_3(data, &mut cursor)?;
            let next_trace_values = read_felt_array_3(data, &mut cursor)?;
            let merkle_path = read_hash_array(data, &mut cursor)?;
            let next_merkle_path = read_hash_array(data, &mut cursor)?;

            queries.push(LegacyQueryProof {
                position,
                trace_values,
                next_trace_values,
                merkle_path,
                next_merkle_path,
            });
        }

        let mut quotient_values = Vec::with_capacity(num_queries);
        for _ in 0..num_queries {
            quotient_values.push(read_felt(data, &mut cursor)?);
        }

        Some(CompactStarkProof {
            trace_root,
            ood_current,
            ood_next,
            ood_z,
            queries,
            quotient_values,
        })
    }
}

// ============================================================================
// Serialization helpers
// ============================================================================

fn read_felt(data: &[u8], cursor: &mut usize) -> Option<Felt> {
    if data.len() < *cursor + 8 { return None; }
    let bytes: [u8; 8] = data[*cursor..*cursor + 8].try_into().ok()?;
    *cursor += 8;
    Some(Felt::from_le_bytes(bytes))
}

fn read_felt_array_3(data: &[u8], cursor: &mut usize) -> Option<[Felt; 3]> {
    let mut arr = [Felt::ZERO; 3];
    for item in arr.iter_mut() {
        *item = read_felt(data, cursor)?;
    }
    Some(arr)
}

fn read_hash_array(data: &[u8], cursor: &mut usize) -> Option<[[u8; 32]; MERKLE_DEPTH]> {
    let mut arr = [[0u8; 32]; MERKLE_DEPTH];
    for item in arr.iter_mut() {
        if data.len() < *cursor + 32 { return None; }
        item.copy_from_slice(&data[*cursor..*cursor + 32]);
        *cursor += 32;
    }
    Some(arr)
}

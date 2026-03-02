//! Core types for the Groth16 verifier.

/// G1 point size (uncompressed): 64 bytes (32 for x, 32 for y)
pub const G1_SIZE: usize = 64;
/// G2 point size (uncompressed): 128 bytes (64 for x, 64 for y)
pub const G2_SIZE: usize = 128;
/// Scalar field element size: 32 bytes
pub const FR_SIZE: usize = 32;

/// Groth16 proof (256 bytes total)
///
/// Layout:
/// - pi_a: G1 point (64 bytes) -- [x: 32, y: 32]
/// - pi_b: G2 point (128 bytes) -- [x_imag: 32, x_real: 32, y_imag: 32, y_real: 32]
/// - pi_c: G1 point (64 bytes) -- [x: 32, y: 32]
///
/// **Important:** pi_b uses EIP-197 ordering (imaginary first, then real).
/// This differs from snarkjs output -- use `proof_from_snarkjs()` to convert.
#[derive(Clone, Debug)]
pub struct Groth16Proof {
    pub pi_a: [u8; G1_SIZE],
    pub pi_b: [u8; G2_SIZE],
    pub pi_c: [u8; G1_SIZE],
}

impl Groth16Proof {
    /// Total byte size of a serialized proof
    pub const SIZE: usize = G1_SIZE + G2_SIZE + G1_SIZE; // 256

    /// Parse from a 256-byte slice
    pub fn from_bytes(data: &[u8]) -> Result<Self, VerifierError> {
        if data.len() != Self::SIZE {
            return Err(VerifierError::InvalidProofSize);
        }
        let mut pi_a = [0u8; G1_SIZE];
        let mut pi_b = [0u8; G2_SIZE];
        let mut pi_c = [0u8; G1_SIZE];

        pi_a.copy_from_slice(&data[0..G1_SIZE]);
        pi_b.copy_from_slice(&data[G1_SIZE..G1_SIZE + G2_SIZE]);
        pi_c.copy_from_slice(&data[G1_SIZE + G2_SIZE..]);

        Ok(Self { pi_a, pi_b, pi_c })
    }

    /// Serialize to 256 bytes
    pub fn to_bytes(&self) -> [u8; 256] {
        let mut bytes = [0u8; 256];
        bytes[0..G1_SIZE].copy_from_slice(&self.pi_a);
        bytes[G1_SIZE..G1_SIZE + G2_SIZE].copy_from_slice(&self.pi_b);
        bytes[G1_SIZE + G2_SIZE..].copy_from_slice(&self.pi_c);
        bytes
    }
}

/// Parsed verification key data
#[derive(Debug)]
pub struct VerificationKey {
    pub alpha_g1: [u8; G1_SIZE],
    pub beta_g2: [u8; G2_SIZE],
    pub gamma_g2: [u8; G2_SIZE],
    pub delta_g2: [u8; G2_SIZE],
    pub ic: Vec<[u8; G1_SIZE]>,
}

/// Errors from the Groth16 verifier.
#[derive(Debug, Clone, PartialEq)]
pub enum VerifierError {
    /// Proof bytes are not 256 bytes
    InvalidProofSize,
    /// VK data is too small or malformed
    InvalidVerificationKey,
    /// Number of public inputs doesn't match IC length
    InvalidPublicInputs,
    /// alt_bn128 operation failed (addition, multiplication, or pairing)
    CurveOperationFailed,
    /// Pairing check returned false
    ProofInvalid,
    /// Too many public inputs (would exceed compute budget)
    TooManyInputs,
}

impl std::fmt::Display for VerifierError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidProofSize => write!(f, "Invalid proof size (expected 256 bytes)"),
            Self::InvalidVerificationKey => write!(f, "Invalid or malformed verification key"),
            Self::InvalidPublicInputs => write!(f, "Public input count doesn't match verification key"),
            Self::CurveOperationFailed => write!(f, "BN254 curve operation failed"),
            Self::ProofInvalid => write!(f, "Groth16 proof verification failed"),
            Self::TooManyInputs => write!(f, "Too many public inputs"),
        }
    }
}

impl std::error::Error for VerifierError {}

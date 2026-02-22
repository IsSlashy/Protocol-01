use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Request body for POST /prove
#[derive(Debug, Deserialize)]
pub struct ProveRequest {
    /// Circuit inputs as key-value pairs.
    /// Values are decimal strings or JSON-encoded arrays of decimal strings.
    pub inputs: HashMap<String, serde_json::Value>,
}

/// Response body for POST /prove — matches snarkjs format exactly.
///
/// The mobile app's `convertSnarkjsProof` (zk/index.ts:1460) expects:
///   pi_a: ["x_decimal", "y_decimal", "1"]
///   pi_b: [["x0", "x1"], ["y0", "y1"], ["1", "0"]]
///   pi_c: ["x_decimal", "y_decimal", "1"]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProveResponse {
    pub success: bool,
    pub proof: SnarkjsProof,
    pub public_signals: Vec<String>,
    pub proof_time_ms: u64,
    pub total_time_ms: u64,
    /// Self-verification result — true means proof verified locally before returning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_verified: Option<bool>,
}

/// Proof in snarkjs JSON format (decimal strings for BN254 field elements).
#[derive(Debug, Serialize)]
pub struct SnarkjsProof {
    pub pi_a: Vec<String>,
    pub pi_b: Vec<Vec<String>>,
    pub pi_c: Vec<String>,
    pub protocol: String,
    pub curve: String,
}

/// Request body for POST /verify
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub proof: SnarkjsProofInput,
    pub public_signals: Vec<String>,
}

/// Proof input for verification (deserialization side).
#[derive(Debug, Deserialize)]
pub struct SnarkjsProofInput {
    pub pi_a: Vec<String>,
    pub pi_b: Vec<Vec<String>>,
    pub pi_c: Vec<String>,
}

/// Response body for POST /verify
#[derive(Debug, Serialize)]
pub struct VerifyResponse {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Response body for GET /health
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub prover_ready: bool,
    pub circuit_loaded: bool,
    pub num_constraints: Option<usize>,
}

/// Error response
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

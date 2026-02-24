mod prover;
mod serialize;
mod types;

// Provide __rust_probestack stub for wasmer_vm compatibility on x86_64 Linux.
// Rust 1.85+ uses inline stack probing and no longer emits this symbol in
// compiler_builtins, but wasmer_vm still references it. The symbol is never
// actually called (inline probing handles it), so a simple ret suffices.
#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
core::arch::global_asm!(
    ".globl __rust_probestack",
    ".type __rust_probestack, @function",
    "__rust_probestack:",
    "ret",
);

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tokio::sync::Semaphore;
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};

use crate::prover::ProverContext;
use crate::types::*;

/// Unique identifier for each supported circuit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CircuitId {
    Transfer,
    ConfidentialBalance,
    BalanceProof,
}

impl CircuitId {
    fn name(&self) -> &'static str {
        match self {
            CircuitId::Transfer => "transfer",
            CircuitId::ConfidentialBalance => "confidential_balance",
            CircuitId::BalanceProof => "balance_proof",
        }
    }
}

/// Application state shared across handlers.
struct AppState {
    /// Loaded provers keyed by circuit identifier. A missing entry means
    /// the circuit failed to load — the corresponding endpoint will return 503.
    provers: HashMap<CircuitId, ProverContext>,
    /// Semaphore limiting concurrent proofs to 1 (all cores used per proof).
    prove_semaphore: Semaphore,
}

/// Descriptor for a circuit to load on startup.
struct CircuitDescriptor {
    id: CircuitId,
    wasm: PathBuf,
    r1cs: PathBuf,
    zkey: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "p01_prover=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PROVER_PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse()
        .expect("PROVER_PORT must be a valid port number");

    // Base directory for circuit artifacts (default: "circuits/")
    let circuits_dir = PathBuf::from(
        std::env::var("CIRCUITS_DIR").unwrap_or_else(|_| "circuits".into()),
    );

    // Define all circuits to load.
    // Each can be overridden individually via environment variables; otherwise
    // paths are resolved relative to CIRCUITS_DIR.
    let descriptors = vec![
        CircuitDescriptor {
            id: CircuitId::Transfer,
            wasm: PathBuf::from(
                std::env::var("CIRCUIT_WASM_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("transfer.wasm").to_string_lossy().into_owned()),
            ),
            r1cs: PathBuf::from(
                std::env::var("CIRCUIT_R1CS_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("transfer.r1cs").to_string_lossy().into_owned()),
            ),
            zkey: PathBuf::from(
                std::env::var("CIRCUIT_ZKEY_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("transfer_final.zkey").to_string_lossy().into_owned()),
            ),
        },
        CircuitDescriptor {
            id: CircuitId::ConfidentialBalance,
            wasm: PathBuf::from(
                std::env::var("ZKSPL_WASM_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("confidential_balance.wasm").to_string_lossy().into_owned()),
            ),
            r1cs: PathBuf::from(
                std::env::var("ZKSPL_R1CS_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("confidential_balance.r1cs").to_string_lossy().into_owned()),
            ),
            zkey: PathBuf::from(
                std::env::var("ZKSPL_ZKEY_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("confidential_balance_final.zkey").to_string_lossy().into_owned()),
            ),
        },
        CircuitDescriptor {
            id: CircuitId::BalanceProof,
            wasm: PathBuf::from(
                std::env::var("BALANCE_PROOF_WASM_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("balance_proof.wasm").to_string_lossy().into_owned()),
            ),
            r1cs: PathBuf::from(
                std::env::var("BALANCE_PROOF_R1CS_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("balance_proof.r1cs").to_string_lossy().into_owned()),
            ),
            zkey: PathBuf::from(
                std::env::var("BALANCE_PROOF_ZKEY_PATH")
                    .unwrap_or_else(|_| circuits_dir.join("balance_proof_final.zkey").to_string_lossy().into_owned()),
            ),
        },
    ];

    // Load all circuits. Failures are logged but do not prevent startup.
    let mut provers = HashMap::new();
    for desc in &descriptors {
        info!(
            "Loading circuit [{}] ...",
            desc.id.name()
        );
        info!("  WASM: {}", desc.wasm.display());
        info!("  R1CS: {}", desc.r1cs.display());
        info!("  ZKEY: {}", desc.zkey.display());

        let load_start = Instant::now();
        match ProverContext::load(&desc.wasm, &desc.r1cs, &desc.zkey) {
            Ok(ctx) => {
                info!(
                    "Circuit [{}] loaded in {:.1}s ({} constraints)",
                    desc.id.name(),
                    load_start.elapsed().as_secs_f64(),
                    ctx.num_constraints,
                );
                provers.insert(desc.id, ctx);
            }
            Err(e) => {
                error!(
                    "Failed to load circuit [{}]: {e:#}",
                    desc.id.name()
                );
                warn!(
                    "Endpoints for [{}] will return 503 until circuit is available",
                    desc.id.name()
                );
            }
        }
    }

    info!(
        "{}/{} circuits loaded successfully",
        provers.len(),
        descriptors.len()
    );

    let state = Arc::new(AppState {
        provers,
        prove_semaphore: Semaphore::new(1),
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        // Existing transfer endpoint — backward compatible
        .route("/prove", post(prove_transfer_handler))
        .route("/verify", post(verify_transfer_handler))
        // New zkSPL endpoints
        .route("/prove/zkspl", post(prove_zkspl_handler))
        .route("/verify/zkspl", post(verify_zkspl_handler))
        // New balance-proof endpoints
        .route("/prove/balance-proof", post(prove_balance_proof_handler))
        .route("/verify/balance-proof", post(verify_balance_proof_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    info!("Rust Groth16 prover listening on 0.0.0.0:{port}");

    axum::serve(listener, app).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get a reference to the ProverContext for the given circuit, or return a 503
/// error response.
fn get_prover(
    state: &AppState,
    circuit: CircuitId,
) -> Result<&ProverContext, (StatusCode, Json<ErrorResponse>)> {
    state.provers.get(&circuit).ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "Prover not ready".into(),
                message: Some(format!(
                    "Circuit [{}] artifacts not loaded",
                    circuit.name()
                )),
            }),
        )
    })
}

/// Generic proof generation for any loaded circuit.
async fn generate_proof(
    state: Arc<AppState>,
    circuit: CircuitId,
    req: ProveRequest,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let total_start = Instant::now();

    // Validate the circuit is loaded
    let _ = get_prover(&state, circuit)?;

    // Acquire proving slot (blocks if another proof is in progress)
    let _permit = state
        .prove_semaphore
        .acquire()
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "Prover unavailable".into(),
                    message: Some("Semaphore closed".into()),
                }),
            )
        })?;

    // Parse inputs
    let inputs = prover::parse_inputs(&req.inputs).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Invalid inputs".into(),
                message: Some(e.to_string()),
            }),
        )
    })?;

    info!(
        "Starting proof generation for [{}] ({} input signals)",
        circuit.name(),
        inputs.len()
    );

    // Run the CPU-bound proving in a blocking thread
    let proof_start = Instant::now();
    let state_clone = Arc::clone(&state);

    let result = tokio::task::spawn_blocking(move || {
        let prover_ref = state_clone.provers.get(&circuit).unwrap();
        prover_ref.prove(inputs)
    })
    .await
    .map_err(|e| {
        error!("Proving task panicked: {e}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Proof generation failed".into(),
                message: Some(format!("Internal error: {e}")),
            }),
        )
    })?
    .map_err(|e| {
        error!("Proving failed: {e:#}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Proof generation failed".into(),
                message: Some(e.to_string()),
            }),
        )
    })?;

    let (proof, public_inputs) = result;
    let proof_time_ms = proof_start.elapsed().as_millis() as u64;

    // Self-verify the proof before returning
    let prover = get_prover(&state, circuit)?;
    let self_verified = match prover.verify(&proof, &public_inputs) {
        Ok(valid) => {
            if valid {
                info!("Self-verification [{}]: PASS", circuit.name());
            } else {
                warn!("Self-verification [{}]: FAIL -- proof is invalid!", circuit.name());
            }
            valid
        }
        Err(e) => {
            warn!("Self-verification [{}] error: {e}", circuit.name());
            false
        }
    };

    let total_time_ms = total_start.elapsed().as_millis() as u64;

    // Convert to snarkjs format
    let snarkjs_proof = serialize::proof_to_snarkjs(&proof);
    let public_signals = serialize::public_signals_to_strings(&public_inputs);

    info!(
        "Proof [{}] generated in {}ms (total {}ms), {} public signals, verified={}",
        circuit.name(),
        proof_time_ms,
        total_time_ms,
        public_signals.len(),
        self_verified
    );

    Ok(Json(ProveResponse {
        success: true,
        proof: snarkjs_proof,
        public_signals,
        proof_time_ms,
        total_time_ms,
        self_verified: Some(self_verified),
    }))
}

/// Generic verification for any loaded circuit.
async fn verify_proof(
    state: Arc<AppState>,
    circuit: CircuitId,
    req: VerifyRequest,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let prover = get_prover(&state, circuit)?;

    // Deserialize proof from snarkjs format
    let proof = serialize::snarkjs_to_proof(&req.proof.pi_a, &req.proof.pi_b, &req.proof.pi_c)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Invalid proof format".into(),
                    message: Some(e.to_string()),
                }),
            )
        })?;

    // Parse public signals
    let public_inputs: Vec<ark_bn254::Fr> = req
        .public_signals
        .iter()
        .map(|s| {
            use ark_ff::PrimeField;
            ark_bn254::Fr::from_bigint(
                s.parse().map_err(|_| anyhow::anyhow!("invalid public signal"))?,
            )
            .ok_or_else(|| anyhow::anyhow!("public signal not in field"))
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Invalid public signals".into(),
                    message: Some(e.to_string()),
                }),
            )
        })?;

    let valid = prover.verify(&proof, &public_inputs).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Verification failed".into(),
                message: Some(e.to_string()),
            }),
        )
    })?;

    Ok(Json(VerifyResponse {
        valid,
        error: None,
    }))
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /health
async fn health_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let all_circuits = [
        CircuitId::Transfer,
        CircuitId::ConfidentialBalance,
        CircuitId::BalanceProof,
    ];

    let mut circuits = HashMap::new();
    for id in &all_circuits {
        let loaded = state.provers.contains_key(id);
        let num_constraints = state.provers.get(id).map(|p| p.num_constraints);
        circuits.insert(
            id.name().to_string(),
            CircuitStatus {
                loaded,
                num_constraints,
            },
        );
    }

    // Backward compat: prover_ready refers to at least the transfer circuit
    let transfer_loaded = state.provers.contains_key(&CircuitId::Transfer);
    let all_loaded = all_circuits.iter().all(|id| state.provers.contains_key(id));

    let status = if all_loaded {
        "ok"
    } else if state.provers.is_empty() {
        "not_ready"
    } else {
        "degraded"
    };

    Json(HealthResponse {
        status: status.into(),
        prover_ready: transfer_loaded,
        circuit_loaded: transfer_loaded,
        num_constraints: state
            .provers
            .get(&CircuitId::Transfer)
            .map(|p| p.num_constraints),
        circuits,
    })
}

/// POST /prove — Generate proof for the transfer circuit (backward compatible).
async fn prove_transfer_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProveRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    generate_proof(state, CircuitId::Transfer, req).await
}

/// POST /verify — Verify proof for the transfer circuit (backward compatible).
async fn verify_transfer_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    verify_proof(state, CircuitId::Transfer, req).await
}

/// POST /prove/zkspl — Generate proof for the confidential_balance circuit.
async fn prove_zkspl_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProveRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    generate_proof(state, CircuitId::ConfidentialBalance, req).await
}

/// POST /verify/zkspl — Verify proof for the confidential_balance circuit.
async fn verify_zkspl_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    verify_proof(state, CircuitId::ConfidentialBalance, req).await
}

/// POST /prove/balance-proof — Generate proof for the balance_proof circuit.
async fn prove_balance_proof_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProveRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    generate_proof(state, CircuitId::BalanceProof, req).await
}

/// POST /verify/balance-proof — Verify proof for the balance_proof circuit.
async fn verify_balance_proof_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    verify_proof(state, CircuitId::BalanceProof, req).await
}

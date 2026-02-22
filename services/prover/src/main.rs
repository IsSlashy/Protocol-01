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

/// Application state shared across handlers.
struct AppState {
    /// The loaded prover (None if loading failed — health returns not-ready).
    prover: Option<ProverContext>,
    /// Semaphore limiting concurrent proofs to 1 (all cores used per proof).
    prove_semaphore: Semaphore,
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

    // Circuit artifact paths (configurable via env)
    let wasm_path = PathBuf::from(
        std::env::var("CIRCUIT_WASM_PATH")
            .unwrap_or_else(|_| "circuits/transfer.wasm".into()),
    );
    let r1cs_path = PathBuf::from(
        std::env::var("CIRCUIT_R1CS_PATH")
            .unwrap_or_else(|_| "circuits/transfer.r1cs".into()),
    );
    let zkey_path = PathBuf::from(
        std::env::var("CIRCUIT_ZKEY_PATH")
            .unwrap_or_else(|_| "circuits/transfer_final.zkey".into()),
    );

    info!("Loading circuit artifacts...");
    info!("  WASM: {}", wasm_path.display());
    info!("  R1CS: {}", r1cs_path.display());
    info!("  ZKEY: {}", zkey_path.display());

    let load_start = Instant::now();
    let prover_ctx = match ProverContext::load(&wasm_path, &r1cs_path, &zkey_path) {
        Ok(ctx) => {
            info!(
                "Circuit loaded in {:.1}s ({} constraints)",
                load_start.elapsed().as_secs_f64(),
                ctx.num_constraints
            );
            Some(ctx)
        }
        Err(e) => {
            error!("Failed to load circuit: {e:#}");
            warn!("Prover will start but /prove will return 503 until circuit is available");
            None
        }
    };

    let state = Arc::new(AppState {
        prover: prover_ctx,
        prove_semaphore: Semaphore::new(1),
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/prove", post(prove_handler))
        .route("/verify", post(verify_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    info!("Rust Groth16 prover listening on 0.0.0.0:{port}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// GET /health
async fn health_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let prover_ready = state.prover.is_some();
    let num_constraints = state.prover.as_ref().map(|p| p.num_constraints);

    Json(HealthResponse {
        status: if prover_ready { "ok".into() } else { "degraded".into() },
        prover_ready,
        circuit_loaded: prover_ready,
        num_constraints,
    })
}

/// POST /prove
///
/// Generates a Groth16 proof. The CPU-bound proving runs in a blocking task
/// so it doesn't starve the tokio runtime. A semaphore limits concurrency to 1
/// so all CPU cores are available for a single proof.
async fn prove_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProveRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let total_start = Instant::now();

    let prover = state.prover.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "Prover not ready".into(),
                message: Some("Circuit artifacts not loaded".into()),
            }),
        )
    })?;

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
        "Starting proof generation ({} input signals)",
        inputs.len()
    );

    // Run the CPU-bound proving in a blocking thread
    let proof_start = Instant::now();

    let state_clone = Arc::clone(&state);
    let result = tokio::task::spawn_blocking(move || {
        let prover_ref = state_clone.prover.as_ref().unwrap();
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

    // Self-verify the proof before returning (catches circuit/witness bugs immediately)
    let self_verified = match prover.verify(&proof, &public_inputs) {
        Ok(valid) => {
            if valid {
                info!("Self-verification: PASS");
            } else {
                warn!("Self-verification: FAIL — proof is invalid!");
            }
            valid
        }
        Err(e) => {
            warn!("Self-verification error: {e}");
            false
        }
    };

    let total_time_ms = total_start.elapsed().as_millis() as u64;

    // Convert to snarkjs format
    let snarkjs_proof = serialize::proof_to_snarkjs(&proof);
    let public_signals = serialize::public_signals_to_strings(&public_inputs);

    info!(
        "Proof generated in {}ms (total {}ms), {} public signals, verified={}",
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

/// POST /verify
async fn verify_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let prover = state.prover.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "Prover not ready".into(),
                message: Some("Circuit artifacts not loaded".into()),
            }),
        )
    })?;

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

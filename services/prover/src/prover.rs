use anyhow::{Context, Result};
use ark_bn254::{Bn254, Fr};
use ark_circom::{CircomBuilder, CircomConfig, CircomReduction};
use ark_groth16::{Groth16, Proof, ProvingKey, VerifyingKey};
use ark_crypto_primitives::snark::SNARK;

/// Use CircomReduction instead of the default LibsnarkReduction.
/// Circom >= 2.0.7 uses a different R1CS-to-QAP mapping.
/// Without this, proofs are structurally valid (on-curve) but
/// mathematically wrong (fail verification).
/// See: https://github.com/arkworks-rs/circom-compat/issues/35
type GrothBn = Groth16<Bn254, CircomReduction>;
use ark_std::rand::thread_rng;
use num_bigint::BigInt;
use num_traits::Num;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Holds preloaded proving/verification keys and circuit paths.
///
/// The `ProvingKey` and `VerifyingKey` are expensive to load (~2-5s from zkey)
/// and are cached. The `CircomConfig` (WASM+R1CS) is reloaded per-proof
/// because it doesn't implement Clone and `CircomBuilder::build()` consumes it.
/// Reloading WASM+R1CS is fast (<100ms).
pub struct ProverContext {
    wasm_path: PathBuf,
    r1cs_path: PathBuf,
    params: ProvingKey<Bn254>,
    vk: VerifyingKey<Bn254>,
    pub num_constraints: usize,
}

impl ProverContext {
    /// Load circuit from disk. Caches the proving key (expensive) in memory.
    ///
    /// - `wasm_path`: circom-compiled WASM for witness generation
    /// - `r1cs_path`: R1CS constraint system
    /// - `zkey_path`: Groth16 proving key (.zkey file from snarkjs)
    pub fn load(wasm_path: &Path, r1cs_path: &Path, zkey_path: &Path) -> Result<Self> {
        // Load R1CS to get constraint count
        info!("Loading circuit config (WASM + R1CS)...");
        let cfg = CircomConfig::<Fr>::new(wasm_path, r1cs_path)
            .map_err(|e| anyhow::anyhow!("Failed to load CircomConfig (WASM + R1CS): {e:#}"))?;
        let num_constraints = cfg.r1cs.constraints.len();
        // Drop cfg — we'll reload it per-proof
        drop(cfg);

        info!("Loading proving key from zkey...");
        let (params, _) = ark_circom::read_zkey(
            &mut std::io::BufReader::new(
                std::fs::File::open(zkey_path)
                    .with_context(|| format!("Cannot open zkey: {}", zkey_path.display()))?,
            ),
        )
        .map_err(|e| anyhow::anyhow!("Failed to read zkey: {e}"))?;

        let vk = params.vk.clone();

        info!(
            "Prover context loaded: {} constraints, VK with {} IC elements",
            num_constraints,
            vk.gamma_abc_g1.len()
        );

        Ok(Self {
            wasm_path: wasm_path.to_path_buf(),
            r1cs_path: r1cs_path.to_path_buf(),
            params,
            vk,
            num_constraints,
        })
    }

    /// Generate a Groth16 proof given circuit inputs.
    ///
    /// `inputs` maps signal names to values (single BigInt or array of BigInts).
    /// This mirrors the snarkjs `fullProve(inputs, wasm, zkey)` interface.
    ///
    /// Reloads CircomConfig per call (~50-100ms) since it's not Clone.
    /// The ProvingKey (the expensive part) remains cached.
    pub fn prove(
        &self,
        inputs: HashMap<String, Vec<BigInt>>,
    ) -> Result<(Proof<Bn254>, Vec<Fr>)> {
        // Reload circuit config (WASM + R1CS) — fast
        let cfg = CircomConfig::<Fr>::new(&self.wasm_path, &self.r1cs_path)
            .map_err(|e| anyhow::anyhow!("Failed to reload CircomConfig: {e:#}"))?;

        // Build witness
        let mut builder = CircomBuilder::new(cfg);

        for (name, values) in &inputs {
            for value in values {
                builder.push_input(name, value.clone());
            }
        }

        let circuit = builder.build().map_err(|e| anyhow::anyhow!("Failed to build witness: {e:#}"))?;
        let public_inputs = circuit.get_public_inputs().unwrap_or_default();

        info!(
            "Witness built: {} public inputs",
            public_inputs.len()
        );

        // Generate proof using CircomReduction (required for circom >= 2.0.7)
        let mut rng = thread_rng();
        let proof = GrothBn::prove(&self.params, circuit, &mut rng)
            .context("Groth16::prove failed")?;

        Ok((proof, public_inputs))
    }

    /// Verify a proof against the loaded verification key.
    pub fn verify(&self, proof: &Proof<Bn254>, public_inputs: &[Fr]) -> Result<bool> {
        let valid = GrothBn::verify(&self.vk, public_inputs, proof)
            .context("Groth16::verify failed")?;
        Ok(valid)
    }
}

/// Parse JSON input values into BigInt vectors.
///
/// Supports:
/// - `"12345"` — single-element vec
/// - `["1", "2", "3"]` — multi-element vec
/// - `12345` (number) — single-element vec
pub fn parse_inputs(
    raw: &HashMap<String, serde_json::Value>,
) -> Result<HashMap<String, Vec<BigInt>>> {
    let mut result = HashMap::new();

    for (key, value) in raw {
        let values = match value {
            serde_json::Value::String(s) => {
                // Could be a plain decimal or a JSON-encoded array
                if s.starts_with('[') {
                    // Try parsing as JSON array
                    let arr: Vec<serde_json::Value> = serde_json::from_str(s)
                        .with_context(|| format!("Failed to parse JSON array for input '{key}'"))?;
                    arr.iter()
                        .map(|v| parse_single_bigint(v, key))
                        .collect::<Result<Vec<_>>>()?
                } else {
                    vec![parse_decimal_bigint(s, key)?]
                }
            }
            serde_json::Value::Array(arr) => arr
                .iter()
                .map(|v| parse_single_bigint(v, key))
                .collect::<Result<Vec<_>>>()?,
            serde_json::Value::Number(n) => {
                let s = n.to_string();
                vec![parse_decimal_bigint(&s, key)?]
            }
            _ => {
                warn!("Unexpected input type for '{key}': {value}");
                anyhow::bail!("Unsupported input type for '{key}'");
            }
        };
        result.insert(key.clone(), values);
    }

    Ok(result)
}

fn parse_single_bigint(value: &serde_json::Value, key: &str) -> Result<BigInt> {
    match value {
        serde_json::Value::String(s) => parse_decimal_bigint(s, key),
        serde_json::Value::Number(n) => parse_decimal_bigint(&n.to_string(), key),
        _ => anyhow::bail!("Expected string or number for input '{key}', got {value}"),
    }
}

fn parse_decimal_bigint(s: &str, key: &str) -> Result<BigInt> {
    // Handle hex strings
    if let Some(hex) = s.strip_prefix("0x") {
        return BigInt::from_str_radix(hex, 16)
            .with_context(|| format!("Invalid hex for input '{key}': {s}"));
    }
    // Decimal
    s.parse::<BigInt>()
        .with_context(|| format!("Invalid decimal for input '{key}': {s}"))
}

use anyhow::Result;
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::PrimeField;
use ark_groth16::Proof;

use crate::types::SnarkjsProof;

/// Convert an arkworks `Proof<Bn254>` into snarkjs-compatible JSON format.
///
/// snarkjs format uses decimal strings for BN254 field elements:
///   pi_a: ["x", "y", "1"]          — G1 affine + projective Z=1
///   pi_b: [["x_c0","x_c1"], ["y_c0","y_c1"], ["1","0"]] — G2 affine (Fq2 components)
///   pi_c: ["x", "y", "1"]          — G1 affine + projective Z=1
pub fn proof_to_snarkjs(proof: &Proof<Bn254>) -> SnarkjsProof {
    let pi_a = g1_to_strings(&proof.a);
    let pi_b = g2_to_strings(&proof.b);
    let pi_c = g1_to_strings(&proof.c);

    SnarkjsProof {
        pi_a,
        pi_b,
        pi_c,
        protocol: "groth16".to_string(),
        curve: "bn128".to_string(),
    }
}

/// Convert public signals (Vec<Fr>) to decimal strings.
pub fn public_signals_to_strings(signals: &[Fr]) -> Vec<String> {
    signals
        .iter()
        .map(|s| s.into_bigint().to_string())
        .collect()
}

/// G1Affine → ["x_decimal", "y_decimal", "1"]
fn g1_to_strings(point: &G1Affine) -> Vec<String> {
    if point.is_zero() {
        return vec!["0".into(), "1".into(), "0".into()];
    }
    let (x, y) = point.xy().unwrap();
    vec![
        x.into_bigint().to_string(),
        y.into_bigint().to_string(),
        "1".to_string(),
    ]
}

/// G2Affine → [["x_c0","x_c1"], ["y_c0","y_c1"], ["1","0"]]
///
/// Note: snarkjs stores Fq2 as [c0, c1], and arkworks Fq2 also stores (c0, c1).
fn g2_to_strings(point: &G2Affine) -> Vec<Vec<String>> {
    if point.is_zero() {
        return vec![
            vec!["1".into(), "0".into()],
            vec!["1".into(), "0".into()],
            vec!["0".into(), "0".into()],
        ];
    }
    let (x, y) = point.xy().unwrap();
    vec![
        vec![
            x.c0.into_bigint().to_string(),
            x.c1.into_bigint().to_string(),
        ],
        vec![
            y.c0.into_bigint().to_string(),
            y.c1.into_bigint().to_string(),
        ],
        vec!["1".to_string(), "0".to_string()],
    ]
}

/// Deserialize a snarkjs proof back into an arkworks Proof<Bn254> for verification.
pub fn snarkjs_to_proof(
    pi_a: &[String],
    pi_b: &[Vec<String>],
    pi_c: &[String],
) -> Result<Proof<Bn254>> {
    let a = strings_to_g1(pi_a)?;
    let b = strings_to_g2(pi_b)?;
    let c = strings_to_g1(pi_c)?;
    Ok(Proof { a, b, c })
}

/// Parse decimal strings into a G1Affine point.
fn strings_to_g1(coords: &[String]) -> Result<G1Affine> {
    anyhow::ensure!(coords.len() >= 2, "G1 point needs at least 2 coordinates");
    let x = Fq::from_bigint(coords[0].parse().map_err(|e| anyhow::anyhow!("invalid Fq x: {e}"))?)
        .ok_or_else(|| anyhow::anyhow!("Fq x not in field"))?;
    let y = Fq::from_bigint(coords[1].parse().map_err(|e| anyhow::anyhow!("invalid Fq y: {e}"))?)
        .ok_or_else(|| anyhow::anyhow!("Fq y not in field"))?;
    Ok(G1Affine::new_unchecked(x, y))
}

/// Parse decimal strings into a G2Affine point.
fn strings_to_g2(coords: &[Vec<String>]) -> Result<G2Affine> {
    anyhow::ensure!(coords.len() >= 2, "G2 point needs at least 2 coordinate pairs");
    let x = Fq2::new(
        Fq::from_bigint(coords[0][0].parse().map_err(|e| anyhow::anyhow!("invalid Fq2 x.c0: {e}"))?)
            .ok_or_else(|| anyhow::anyhow!("Fq2 x.c0 not in field"))?,
        Fq::from_bigint(coords[0][1].parse().map_err(|e| anyhow::anyhow!("invalid Fq2 x.c1: {e}"))?)
            .ok_or_else(|| anyhow::anyhow!("Fq2 x.c1 not in field"))?,
    );
    let y = Fq2::new(
        Fq::from_bigint(coords[1][0].parse().map_err(|e| anyhow::anyhow!("invalid Fq2 y.c0: {e}"))?)
            .ok_or_else(|| anyhow::anyhow!("Fq2 y.c0 not in field"))?,
        Fq::from_bigint(coords[1][1].parse().map_err(|e| anyhow::anyhow!("invalid Fq2 y.c1: {e}"))?)
            .ok_or_else(|| anyhow::anyhow!("Fq2 y.c1 not in field"))?,
    );
    Ok(G2Affine::new_unchecked(x, y))
}

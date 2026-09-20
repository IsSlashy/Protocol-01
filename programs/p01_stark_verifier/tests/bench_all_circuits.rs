//! [BENCH 2026-09-11] Prove and host-verify timings for ALL EIGHT circuits, on
//! fresh CSPRNG masks, with the wire length of each proof.
//!
//! `#[ignore]` by default: it is a measurement, not a gate, and it takes a
//! minute. Run it by hand and paste the table into the benchmark document with
//! the machine and the date:
//!
//! ```text
//! cargo test -p p01_stark_verifier --release --test bench_all_circuits -- --ignored --nocapture
//! P01_BENCH_OUT=path.json  (optional) writes the raw samples as JSON
//! ```
//!
//! What "verify" means here: `verify_generic` (phase 1: parse, OOD point, query
//! positions, Merkle paths, FRI) followed by the circuit's phase-2 DEEP-ALI
//! function, i.e. the SAME code the on-chain program runs, on the host. It is
//! not a CU figure; `cu_budget.rs` measures those in litesvm.
//!
//! Masks are drawn from the OS CSPRNG through `p01_stark::draw_blinding_mask`,
//! exactly as the wasm entries draw them, so every sample is a different proof
//! of the same witness. The spread between min and max on one machine is a
//! factor of 2-6 (measured 2026-09-02); a single run is not a number, which is
//! why `N` is 5 and all three of min / median / max are printed.

mod common;

use std::time::Instant;

use p01_stark::compact as c;
use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_0_masked, verify_deep_ali_circuit_1, verify_deep_ali_circuit_2,
    verify_deep_ali_circuit_3, verify_deep_ali_circuit_4, verify_deep_ali_circuit_5,
    verify_deep_ali_circuit_6, verify_deep_ali_circuit_7, verify_generic, VerifyError,
};

const N: usize = 5;

fn mask(len: usize) -> p01_stark::BlindingMask {
    p01_stark::BlindingMask::draw(len).expect("OS CSPRNG")
}

fn prove(cid: u8) -> c::GenericCompactProofData {
    use p01_stark::air;
    match cid {
        0 => c::generate_subscriber_ownership_proof(42, &mask(air::subscriber_ownership::MASK_LEN)),
        1 => c::generate_pool_commitment_proof(111, 222, 333, 444, &mask(air::denominated_pool::MASK_LEN)),
        2 => c::generate_balance_compact_proof(42, 1000, 777, 999, &mask(air::balance_proof::MASK_LEN)),
        3 => {
            let d = air::merkle_path::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            c::generate_merkle_path_compact_proof(777, &pe, &pi, &mask(air::merkle_path::mask_len_for_depth(d)))
        }
        4 => c::generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999, &mask(air::confidential_balance::MASK_LEN),
        ),
        5 => c::generate_transfer_compact_proof(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50, &mask(air::transfer::MASK_LEN),
        ),
        6 => {
            let d = air::merkle_update::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 100 + i * 13).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            c::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &mask(air::merkle_update::mask_len_for_depth(d)))
        }
        7 => {
            let d = air::spend::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            c::generate_spend_compact_proof(42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &mask(air::spend::MASK_LEN))
        }
        _ => unreachable!(),
    }
}

fn phase2(proof: &GenericCompactProof, cid: u8, pubs: &[u64]) -> Result<(), VerifyError> {
    match cid {
        0 => verify_deep_ali_circuit_0_masked(proof, pubs),
        1 => verify_deep_ali_circuit_1(proof, pubs),
        2 => verify_deep_ali_circuit_2(proof, pubs),
        3 => verify_deep_ali_circuit_3(proof, pubs),
        4 => verify_deep_ali_circuit_4(proof, pubs),
        5 => verify_deep_ali_circuit_5(proof, pubs),
        6 => verify_deep_ali_circuit_6(proof, pubs),
        7 => verify_deep_ali_circuit_7(proof, pubs),
        _ => unreachable!(),
    }
}

fn stats(v: &mut Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (v[0], v[v.len() / 2], v[v.len() - 1])
}

const NAMES: [&str; 8] = [
    "C0 subscriber_ownership (masked)",
    "C1 pool_commitment",
    "C2 balance_proof",
    "C3 merkle_path",
    "C4 confidential_balance",
    "C5 transfer",
    "C6 merkle_update",
    "C7 spend",
];

#[test]
#[ignore]
fn bench_prove_and_verify_all_eight_circuits() {
    println!();
    println!("prove / verify, release build, fresh CSPRNG mask per sample, N = {N}");
    println!(
        "{:<34} {:>7} {:>7} {:>7} | {:>7} {:>7} {:>7} | {:>7}",
        "circuit", "prove", "median", "max", "verify", "median", "max", "bytes"
    );
    println!("{:<34} {:>7} {:>7} {:>7} | {:>7} {:>7} {:>7} | {:>7}", "", "min ms", "ms", "ms", "min ms", "ms", "ms", "");
    println!("{}", "-".repeat(96));
    let mut json = String::from("{\n");
    for cid in 0u8..=7 {
        let cfg = get_circuit_config(cid).unwrap();
        let mut prove_ms = Vec::with_capacity(N);
        let mut verify_ms = Vec::with_capacity(N);
        let mut bytes = 0usize;
        for _ in 0..N {
            let t = Instant::now();
            let data = prove(cid);
            prove_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            bytes = data.proof_bytes.len();
            let t = Instant::now();
            let proof = GenericCompactProof::from_bytes(&data.proof_bytes, cfg).expect("parse");
            verify_generic(&proof, cid, &data.public_inputs, cfg).expect("phase 1");
            phase2(&proof, cid, &data.public_inputs).expect("phase 2");
            verify_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (pmin, pmed, pmax) = stats(&mut prove_ms);
        let (vmin, vmed, vmax) = stats(&mut verify_ms);
        println!(
            "{:<34} {:>7.0} {:>7.0} {:>7.0} | {:>7.1} {:>7.1} {:>7.1} | {:>7}",
            NAMES[cid as usize], pmin, pmed, pmax, vmin, vmed, vmax, bytes
        );
        json.push_str(&format!(
            "  \"C{cid}\": {{\"name\": \"{}\", \"prove_ms\": {:?}, \"verify_ms\": {:?}, \"bytes\": {bytes}, \"queries\": {}, \"trace_width\": {}, \"trace_length\": {}}}{}\n",
            NAMES[cid as usize], prove_ms, verify_ms, cfg.num_queries, cfg.trace_width, cfg.trace_length,
            if cid == 7 { "" } else { "," }
        ));
    }
    json.push_str("}\n");
    if let Ok(path) = std::env::var("P01_BENCH_OUT") {
        std::fs::write(&path, json).expect("write bench json");
        println!("raw samples written to {path}");
    }
}

//! [RESHIP 2026-09-12] The STAGED wasm prover blob against THIS verifier, on
//! every circuit it proves, before either is shipped. Since the 2026-09-23
//! reship (blob 241caaab, 240,172 B) that is the live set C0, C1, C3, C6 and C7
//! (`LIVE_CIRCUITS`); C2, C4 and C5 have no entry point in the blob any more.
//!
//! `#[ignore]` by default: it needs proof files that only the wasm blob can
//! write. Produce them with the Node driver (which loads a blob through its
//! own wasm-bindgen glue and calls the five entry points with the witnesses
//! `bench_all_circuits.rs` uses), then point this test at the directory:
//!
//! ```text
//! P01_WASM_PROOFS_DIR=<dir with C0.bin C1.bin C3.bin C6.bin C7.bin> \
//!   cargo test -p p01_stark_verifier --release --test wasm_blob_parity -- --ignored --nocapture
//! ```
//!
//! The public inputs are NOT read from the wasm side: the Rust prover is run on
//! the same witness and its `public_inputs` are used, so the check is "the
//! bytes the blob emits verify under the verifier's own reading of the public
//! inputs", the same pair the chain sees. A blob one generation off fails here
//! at phase 1 or 2 instead of at the end of a paid upload on devnet.

use p01_stark::compact as c;
use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::verify::{
    verify_deep_ali_circuit_0_masked, verify_deep_ali_circuit_1, verify_deep_ali_circuit_2,
    verify_deep_ali_circuit_3, verify_deep_ali_circuit_4, verify_deep_ali_circuit_5,
    verify_deep_ali_circuit_6, verify_deep_ali_circuit_7, verify_generic, VerifyError,
};

fn mask(len: usize) -> p01_stark::BlindingMask {
    p01_stark::BlindingMask::draw(len).expect("OS CSPRNG")
}

/// Same witnesses as `bench_all_circuits::prove`; only the public inputs are used.
fn public_inputs(cid: u8) -> Vec<u64> {
    use p01_stark::air;
    let data = match cid {
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
    };
    data.public_inputs
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

/// The circuits the shipped blob proves (and the clients use). C2, C4 and C5
/// stay in the verifier (the deployed program still dispatches them) but the
/// blob that would write their proofs is gone.
const LIVE_CIRCUITS: [u8; 5] = [0, 1, 3, 6, 7];

#[test]
#[ignore]
fn staged_wasm_proofs_verify_on_the_live_circuits() {
    let dir = std::env::var("P01_WASM_PROOFS_DIR").expect("P01_WASM_PROOFS_DIR=<dir with C0.bin C1.bin C3.bin C6.bin C7.bin>");
    let mut failures = Vec::new();
    for cid in LIVE_CIRCUITS {
        let path = format!("{dir}/C{cid}.bin");
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let cfg = get_circuit_config(cid).unwrap();
        let pubs = public_inputs(cid);
        let verdict = (|| -> Result<(), String> {
            let proof = GenericCompactProof::from_bytes(&bytes, cfg).ok_or_else(|| "parse: from_bytes returned None".to_string())?;
            verify_generic(&proof, cid, &pubs, cfg).map_err(|e| format!("phase 1: {e:?}"))?;
            phase2(&proof, cid, &pubs).map_err(|e| format!("phase 2: {e:?}"))?;
            Ok(())
        })();
        match &verdict {
            Ok(()) => println!("C{cid}: {} bytes, {} public inputs, phase 1 + phase 2 OK", bytes.len(), pubs.len()),
            Err(e) => println!("C{cid}: {} bytes, FAILED {e}", bytes.len()),
        }
        if let Err(e) = verdict {
            failures.push(format!("C{cid}: {e}"));
        }
    }
    assert!(failures.is_empty(), "staged blob rejected by this verifier:\n{}", failures.join("\n"));
}

// ---------------------------------------------------------------------------
// [RESHIP 2026-09-12] The same staged proofs (the live set, `LIVE_CIRCUITS`) through the REAL program:
// the staged .so on litesvm, the v3 buffer the clients allocate, 3,840-byte
// chunks (the transaction-v1 chunk size), `verify_stark_proof_v2`, then
// `verify_deep_ali_phase2` for circuits 1-7 (masked C0 runs both phases inside
// phase 1, lib.rs [ZK-MASK-C0]). A local validator would have been the next
// step up, but this machine refuses the symlink it needs without elevation.
//
//   P01_WASM_PROOFS_DIR=<dir> P01_VERIFIER_SO=<staged .so> \
//     cargo test -p p01_stark_verifier --release --test wasm_blob_parity -- --ignored --nocapture
// ---------------------------------------------------------------------------

mod svm {
    use litesvm::LiteSVM;
    use solana_address::Address;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_message::Message;
    use solana_signer::Signer;
    use solana_transaction::Transaction;
    use solana_transaction_error::TransactionError;
    use std::str::FromStr;

    pub const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";
    const COMPUTE_BUDGET_ID: &str = "ComputeBudget111111111111111111111111111111";
    const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
    const MAX_CU_PER_TX: u32 = 1_400_000;
    /// `apps/web/lib/privacy/pool/txv1.ts` V1_CHUNK_SIZE.
    pub const V1_CHUNK: usize = 3_840;
    pub const PROOF_DATA_OFFSET: usize = 83;
    const OFF_VERIFIED: usize = 49;
    const OFF_DEEP_ALI: usize = 82;

    fn anchor_disc(name: &str) -> [u8; 8] {
        let h = solana_sha256_hasher::hashv(&[format!("global:{}", name).as_bytes()]).to_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&h[..8]);
        out
    }
    pub fn program() -> Address {
        Address::from_str(VERIFIER_ID).unwrap()
    }
    fn system_program() -> Address {
        Address::from_str(SYSTEM_PROGRAM_ID).unwrap()
    }
    fn set_cu_limit_ix(limit: u32) -> Instruction {
        let mut data = vec![2u8];
        data.extend_from_slice(&limit.to_le_bytes());
        Instruction { program_id: Address::from_str(COMPUTE_BUDGET_ID).unwrap(), accounts: vec![], data }
    }
    fn ix_create_account(from: &Address, new: &Address, lamports: u64, space: u64, owner: &Address) -> Instruction {
        let mut data = 0u32.to_le_bytes().to_vec();
        data.extend_from_slice(&lamports.to_le_bytes());
        data.extend_from_slice(&space.to_le_bytes());
        data.extend_from_slice(owner.as_ref());
        Instruction {
            program_id: system_program(),
            accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*new, true)],
            data,
        }
    }
    fn ix_init_proof_buffer_v3(buffer: &Address, authority: &Address, proof_size: u32, circuit_id: u8) -> Instruction {
        let mut data = anchor_disc("init_proof_buffer_v3").to_vec();
        data.extend_from_slice(&proof_size.to_le_bytes());
        data.push(circuit_id);
        Instruction {
            program_id: program(),
            accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
            data,
        }
    }
    fn ix_write_chunk(buffer: &Address, authority: &Address, offset: u32, chunk: &[u8]) -> Instruction {
        let mut data = anchor_disc("write_proof_chunk").to_vec();
        data.extend_from_slice(&offset.to_le_bytes());
        data.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        data.extend_from_slice(chunk);
        Instruction {
            program_id: program(),
            accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
            data,
        }
    }
    pub fn ix_with_public_inputs(buffer: &Address, authority: &Address, name: &str, public_inputs: &[u64]) -> Instruction {
        let mut data = anchor_disc(name).to_vec();
        data.extend_from_slice(&(public_inputs.len() as u32).to_le_bytes());
        for v in public_inputs {
            data.extend_from_slice(&v.to_le_bytes());
        }
        Instruction {
            program_id: program(),
            accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
            data,
        }
    }
    pub fn ix_verify_stark_proof_legacy(buffer: &Address, authority: &Address, commitment: u64) -> Instruction {
        let mut data = anchor_disc("verify_stark_proof").to_vec();
        data.extend_from_slice(&commitment.to_le_bytes());
        Instruction {
            program_id: program(),
            accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
            data,
        }
    }
    pub fn ix_close_proof_buffer(buffer: &Address, authority: &Address) -> Instruction {
        Instruction {
            program_id: program(),
            accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new(*authority, true)],
            data: anchor_disc("close_proof_buffer").to_vec(),
        }
    }

    pub struct Rig {
        pub svm: LiteSVM,
        pub payer: Keypair,
    }
    pub type Sent = Result<(u64, Vec<String>), (TransactionError, Vec<String>)>;

    impl Rig {
        pub fn new(so: &std::path::Path) -> Self {
            let mut svm = LiteSVM::new().with_transaction_history(0);
            let bytes = std::fs::read(so).unwrap_or_else(|e| panic!("{}: {}", so.display(), e));
            svm.add_program(program(), &bytes).expect("load verifier");
            let payer = Keypair::new();
            svm.airdrop(&payer.pubkey(), 1_000_000_000_000).expect("airdrop");
            Rig { svm, payer }
        }
        pub fn payer_pk(&self) -> Address {
            self.payer.pubkey()
        }
        pub fn send(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair]) -> Sent {
            let mut all = vec![set_cu_limit_ix(MAX_CU_PER_TX)];
            all.extend_from_slice(ixs);
            let payer_pk = self.payer_pk();
            let msg = Message::new(&all, Some(&payer_pk));
            let mut signers: Vec<&Keypair> = vec![&self.payer];
            signers.extend_from_slice(extra_signers);
            let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
            match self.svm.send_transaction(tx) {
                Ok(meta) => Ok((meta.compute_units_consumed, meta.logs)),
                Err(f) => Err((f.err, f.meta.logs)),
            }
        }
        pub fn must(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair], what: &str) -> (u64, Vec<String>) {
            match self.send(ixs, extra_signers) {
                Ok(v) => v,
                Err((e, logs)) => {
                    let n = logs.len().saturating_sub(10);
                    panic!("{} failed: {:?}\nlogs: {:#?}", what, e, &logs[n..])
                }
            }
        }
        pub fn flags(&self, buffer: &Address) -> (bool, bool) {
            let d = self.svm.get_account(buffer).expect("buffer").data;
            (d[OFF_VERIFIED] == 1, d[OFF_DEEP_ALI] == 1)
        }
        pub fn create_v3(&mut self, proof_size: usize, circuit_id: u8) -> (Keypair, Address) {
            let kp = Keypair::new();
            let addr = kp.pubkey();
            let space = PROOF_DATA_OFFSET + proof_size;
            let lamports = self.svm.minimum_balance_for_rent_exemption(space);
            let payer = self.payer_pk();
            let ixs = [
                ix_create_account(&payer, &addr, lamports, space as u64, &program()),
                ix_init_proof_buffer_v3(&addr, &payer, proof_size as u32, circuit_id),
            ];
            self.must(&ixs, &[&kp], "create_account + init_proof_buffer_v3");
            (kp, addr)
        }
        pub fn upload(&mut self, buffer: &Address, proof: &[u8]) -> usize {
            let payer = self.payer_pk();
            let mut n = 0;
            let mut off = 0;
            while off < proof.len() {
                let end = (off + V1_CHUNK).min(proof.len());
                self.must(&[ix_write_chunk(buffer, &payer, off as u32, &proof[off..end])], &[], &format!("write_proof_chunk @{}", off));
                n += 1;
                off = end;
            }
            n
        }
    }
}

#[test]
#[ignore]
fn staged_wasm_proofs_verify_through_the_staged_program_on_litesvm() {
    let dir = std::env::var("P01_WASM_PROOFS_DIR").expect("P01_WASM_PROOFS_DIR=<dir with C0.bin C1.bin C3.bin C6.bin C7.bin>");
    let so = std::path::PathBuf::from(std::env::var("P01_VERIFIER_SO").expect("P01_VERIFIER_SO=<staged .so>"));
    let so_bytes = std::fs::read(&so).unwrap();
    println!("verifier .so {} ({} bytes, sha256 {})", so.display(), so_bytes.len(), &hex_sha256(&so_bytes)[..16]);
    let mut rig = svm::Rig::new(&so);
    let payer = rig.payer_pk();
    let mut failures = Vec::new();
    println!("{:<4} {:>8} {:>7} {:>10} {:>10} {:>9}", "cid", "bytes", "chunks", "phase1 CU", "phase2 CU", "txs");
    for cid in LIVE_CIRCUITS {
        let bytes = std::fs::read(format!("{dir}/C{cid}.bin")).unwrap();
        let pubs = public_inputs(cid);
        let (_kp, buf) = rig.create_v3(bytes.len(), cid);
        let chunks = rig.upload(&buf, &bytes);
        // C0 keeps the `verify_stark_proof(commitment)` entry point its consumers
        // (`p01_quantum_wallet`, pause / resume) call; the masked shape runs
        // both phases inside it. C1..C7 take the two-phase generic path.
        let phase1_ix = if cid == 0 {
            svm::ix_verify_stark_proof_legacy(&buf, &payer, pubs[0])
        } else {
            svm::ix_with_public_inputs(&buf, &payer, "verify_stark_proof_v2", &pubs)
        };
        let p1 = rig.send(&[phase1_ix], &[]);
        let (cu1, p1_ok) = match &p1 {
            Ok((cu, _)) => (*cu, true),
            Err((e, logs)) => {
                let n = logs.len().saturating_sub(6);
                failures.push(format!("C{cid} phase 1: {e:?} {:?}", &logs[n..]));
                (0, false)
            }
        };
        let mut cu2 = 0;
        if p1_ok && cid != 0 {
            match rig.send(&[svm::ix_with_public_inputs(&buf, &payer, "verify_deep_ali_phase2", &pubs)], &[]) {
                Ok((cu, _)) => cu2 = cu,
                Err((e, logs)) => {
                    let n = logs.len().saturating_sub(6);
                    failures.push(format!("C{cid} phase 2: {e:?} {:?}", &logs[n..]));
                }
            }
        }
        // Every circuit ends with both flags set: C1..C7 after the second
        // instruction, masked C0 after its single one (MEASURED on the staged
        // .so: `verify_stark_proof` on the masked C0 sets deep_ali too).
        let (verified, deep) = rig.flags(&buf);
        if p1_ok && (!verified || !deep) {
            failures.push(format!("C{cid} flags after both phases: verified={verified} deep_ali={deep}"));
        }
        rig.must(&[svm::ix_close_proof_buffer(&buf, &payer)], &[], "close_proof_buffer");
        let phases = if cid == 0 { 1 } else { 2 };
        let p2 = if cid == 0 { "in p1".to_string() } else { cu2.to_string() };
        println!("C{cid:<3} {:>8} {:>7} {:>10} {:>10} {:>9}", bytes.len(), chunks, cu1, p2, 1 + chunks + phases + 1);
    }
    assert!(failures.is_empty(), "staged blob rejected by the staged program:\n{}", failures.join("\n"));
}

fn hex_sha256(bytes: &[u8]) -> String {
    let h = solana_sha256_hasher::hashv(&[bytes]).to_bytes();
    h.iter().map(|b| format!("{b:02x}")).collect()
}

//! Single source of truth for reading a `p01_stark_verifier::ProofBuffer`.
//!
//! Every `*_stark` instruction in this program used to carry its OWN private
//! copy of the discriminator, the verifier program id, the six field offsets
//! and the parser — twelve copies. They had already drifted: ten spelled the
//! account 83 bytes and read `deep_ali_verified`, two spelled it 82 and could
//! not see that field at all. Two sibling crates still carry the 82-byte copy
//! (`p01_zkspl::stark_proof`, `p01_liquidity::instructions::prefund`) and,
//! unlike the two here, they consume circuits that DO need phase 2.
//!
//! A one-byte disagreement in this table is a verification bypass, so the
//! table lives in exactly one place and every offset is derived from the one
//! before it. `stark_buffer::tests` then pins the whole thing against the real
//! `p01_stark_verifier::ProofBuffer` type (a dev-dependency), so a field added,
//! removed or reordered in the verifier breaks this program's tests instead of
//! silently shifting what `verified` means.
//!
//! Layout (Anchor/Borsh, `p01_stark_verifier/src/lib.rs`):
//! ```text
//!   0..8    discriminator
//!   8..40   authority:           Pubkey
//!   40      circuit_id:          u8
//!   41..45  proof_size:          u32
//!   45..49  bytes_written:       u32
//!   49      verified:            bool
//!   50..82  public_inputs_hash:  [u8; 32]
//!   82      deep_ali_verified:   bool
//!   83      = ProofBuffer::PROOF_DATA_OFFSET
//! ```

use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;

/// Anchor account discriminator for `p01_stark_verifier::ProofBuffer`
/// (= `sha256("account:ProofBuffer")[..8]`; pinned by the tests below).
pub const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// `p01_stark_verifier` program id — DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs.
pub const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// Offsets. Each is the previous offset plus that field's serialized width, so
/// a width change moves everything downstream instead of desynchronising it.
pub const PROOF_BUF_DISCRIMINATOR: usize = 0;
pub const PROOF_BUF_AUTHORITY: usize = PROOF_BUF_DISCRIMINATOR + 8;
pub const PROOF_BUF_CIRCUIT_ID: usize = PROOF_BUF_AUTHORITY + 32;
pub const PROOF_BUF_PROOF_SIZE: usize = PROOF_BUF_CIRCUIT_ID + 1;
pub const PROOF_BUF_BYTES_WRITTEN: usize = PROOF_BUF_PROOF_SIZE + 4;
pub const PROOF_BUF_VERIFIED: usize = PROOF_BUF_BYTES_WRITTEN + 4;
pub const PROOF_BUF_INPUTS_HASH: usize = PROOF_BUF_VERIFIED + 1;
pub const PROOF_BUF_DEEP_ALI_VERIFIED: usize = PROOF_BUF_INPUTS_HASH + 32;
/// Smallest account payload that can hold the whole header (= the verifier's
/// `ProofBuffer::PROOF_DATA_OFFSET`).
pub const PROOF_BUF_MIN_LEN: usize = PROOF_BUF_DEEP_ALI_VERIFIED + 1;

/// The header fields a consumer needs. Deliberately not `Copy`-cheap tuples:
/// `verified` and `deep_ali_verified` are both `bool`, and the twelve
/// hand-written parsers this replaces did not agree on their order.
pub struct StarkProofBufferView {
    pub authority: Pubkey,
    pub circuit_id: u8,
    /// Phase 1 — FRI + trace-aligned + boundary.
    pub verified: bool,
    /// Phase 2 — DEEP-ALI. `p01_stark_verifier` applies phase 2 to circuits
    /// 1..=6; only circuit 0 runs DEEP-ALI inside phase 1 and therefore leaves
    /// this `false` on an honest, fully verified buffer.
    pub deep_ali_verified: bool,
    pub public_inputs_hash: [u8; 32],
}

/// Parse the header of a `ProofBuffer` account payload.
///
/// Does NOT check the account owner — the caller must have already required
/// `*info.owner == STARK_VERIFIER_PROGRAM_ID`, because only the caller holds
/// the `AccountInfo`.
pub fn parse_stark_proof_buffer(data: &[u8]) -> Result<StarkProofBufferView> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[PROOF_BUF_DISCRIMINATOR..PROOF_BUF_AUTHORITY] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| error!(ZkShieldedError::InvalidProof))?;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash
        .copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED]);
    Ok(StarkProofBufferView {
        authority,
        circuit_id: data[PROOF_BUF_CIRCUIT_ID],
        verified: data[PROOF_BUF_VERIFIED] == 1,
        deep_ali_verified: data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1,
        public_inputs_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;
    use p01_stark_verifier::ProofBuffer;
    use std::str::FromStr;

    /// Serialize the REAL verifier account type. `try_serialize` writes the
    /// real Anchor discriminator followed by the real Borsh field order, so
    /// nothing in this fixture is copied from the table above.
    fn encode_real_proof_buffer(b: ProofBuffer) -> Vec<u8> {
        let mut out = Vec::new();
        b.try_serialize(&mut out).expect("ProofBuffer serializes");
        out
    }

    fn distinct_fixture() -> (ProofBuffer, Pubkey, [u8; 32]) {
        // Every field gets a value that cannot be confused with any other, so
        // an offset that lands one byte early or late changes the result.
        let authority = Pubkey::new_from_array([0xA7; 32]);
        let hash = {
            let mut h = [0u8; 32];
            for (i, byte) in h.iter_mut().enumerate() {
                *byte = 0x40u8.wrapping_add(i as u8);
            }
            h
        };
        (
            ProofBuffer {
                authority,
                circuit_id: 5,
                proof_size: 0x1122_3344,
                bytes_written: 0x5566_7788,
                verified: true,
                public_inputs_hash: hash,
                deep_ali_verified: true,
            },
            authority,
            hash,
        )
    }

    #[test]
    fn the_discriminator_is_the_one_anchor_actually_writes() {
        let (buf, _, _) = distinct_fixture();
        let encoded = encode_real_proof_buffer(buf);
        assert_eq!(
            &encoded[PROOF_BUF_DISCRIMINATOR..PROOF_BUF_AUTHORITY],
            &STARK_PROOF_BUFFER_DISCRIMINATOR[..],
            "STARK_PROOF_BUFFER_DISCRIMINATOR is not what p01_stark_verifier writes"
        );
    }

    #[test]
    fn min_len_is_the_verifiers_own_proof_data_offset() {
        assert_eq!(PROOF_BUF_MIN_LEN, ProofBuffer::PROOF_DATA_OFFSET);
        let (buf, _, _) = distinct_fixture();
        assert_eq!(encode_real_proof_buffer(buf).len(), PROOF_BUF_MIN_LEN);
    }

    #[test]
    fn the_program_id_is_the_verifiers_declared_id() {
        assert_eq!(STARK_VERIFIER_PROGRAM_ID, p01_stark_verifier::ID);
        assert_eq!(
            STARK_VERIFIER_PROGRAM_ID,
            Pubkey::from_str("DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs").unwrap()
        );
    }

    #[test]
    fn every_offset_lands_on_the_field_the_verifier_serialized() {
        let (buf, authority, hash) = distinct_fixture();
        let encoded = encode_real_proof_buffer(buf);
        let view = parse_stark_proof_buffer(&encoded).expect("parses");

        assert_eq!(view.authority, authority);
        assert_eq!(view.circuit_id, 5);
        assert!(view.verified);
        assert!(view.deep_ali_verified);
        assert_eq!(view.public_inputs_hash, hash);

        // The two u32s sit between circuit_id and verified; read them back
        // directly so a shift in either width is caught here rather than by
        // `verified` quietly reading a length byte.
        assert_eq!(
            u32::from_le_bytes(
                encoded[PROOF_BUF_PROOF_SIZE..PROOF_BUF_BYTES_WRITTEN]
                    .try_into()
                    .unwrap()
            ),
            0x1122_3344
        );
        assert_eq!(
            u32::from_le_bytes(
                encoded[PROOF_BUF_BYTES_WRITTEN..PROOF_BUF_VERIFIED]
                    .try_into()
                    .unwrap()
            ),
            0x5566_7788
        );
    }

    #[test]
    fn the_two_phase_flags_are_read_independently() {
        // Phase 1 only: `verified` true, `deep_ali_verified` false. A parser
        // that read one offset for both would report them equal.
        let (mut buf, _, _) = distinct_fixture();
        buf.deep_ali_verified = false;
        let view = parse_stark_proof_buffer(&encode_real_proof_buffer(buf)).unwrap();
        assert!(view.verified);
        assert!(!view.deep_ali_verified);

        let (mut buf, _, _) = distinct_fixture();
        buf.verified = false;
        let view = parse_stark_proof_buffer(&encode_real_proof_buffer(buf)).unwrap();
        assert!(!view.verified);
        assert!(view.deep_ali_verified);
    }

    #[test]
    fn a_payload_one_byte_short_of_the_header_is_rejected() {
        let (buf, _, _) = distinct_fixture();
        let encoded = encode_real_proof_buffer(buf);
        assert!(parse_stark_proof_buffer(&encoded[..PROOF_BUF_MIN_LEN - 1]).is_err());
    }

    /// [ADVERSARY 2026-08-03] The owner check is DELEGATED and was ENFORCED BY
    /// NOTHING.
    ///
    /// `parse_stark_proof_buffer`'s own doc says it: "Does NOT check the account
    /// owner — the caller must have already required
    /// `*info.owner == STARK_VERIFIER_PROGRAM_ID`, because only the caller holds
    /// the `AccountInfo`." That is correct as a design, and it is the single
    /// most dangerous thing this module can get wrong: without it a consumer
    /// reads any account whose first 83 bytes an attacker chose, including
    /// `verified = 1` and `deep_ali_verified = 1` at bytes 49 and 82. The
    /// discriminator is public, so forging the header costs one `create_account`
    /// under a program the attacker controls.
    ///
    /// Every live consumer does check it — verified by hand at the time of
    /// writing — but "every consumer happens to" is what the twelve duplicated
    /// parsers this module replaced also had, right up until two of them
    /// diverged. The obligation is now counted rather than trusted.
    ///
    /// The rule is a counting argument, deliberately not a keyword: a file may
    /// not call `parse_stark_proof_buffer` more times than it `require!`s the
    /// owner. `split_note_stark` parses two buffers and has two owner
    /// require!s; `transfer_denominated_stark_v3` parses three and has three.
    ///
    /// What this CANNOT see, stated so it is not mistaken for more: whether the
    /// owner require! guards the same `AccountInfo` the parse reads, and whether
    /// either is on a reachable path. It is a floor, not a proof.
    #[test]
    fn every_caller_of_the_parser_requires_the_verifier_as_owner() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("programs/zk_shielded -> repo root")
            .to_path_buf();

        let mut checked = 0usize;
        let mut failures: Vec<String> = Vec::new();
        let mut stack = vec![root.join("programs")];
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        while let Some(d) = stack.pop() {
            let entries = match std::fs::read_dir(&d) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    if name == "target" || name == "node_modules" || name == ".git" {
                        continue;
                    }
                    stack.push(p);
                } else if p.extension().map(|e| e == "rs").unwrap_or(false) {
                    files.push(p);
                }
            }
        }
        files.sort();

        for path in files {
            let rel = path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if !rel.contains("/src/") {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            // The module that DEFINES the parser is not a caller of it.
            if text.contains("pub fn parse_stark_proof_buffer") {
                continue;
            }
            // Comments do not call anything. A consumer that documents the
            // owner check it does not perform must not score for it — the
            // recurring defect in this repo is a gate that reads prose.
            let code = strip_rust_comments(&text);
            let parses = code.matches("parse_stark_proof_buffer(").count();
            if parses == 0 {
                continue;
            }
            checked += 1;
            let owner_checks = code.matches("owner == STARK_VERIFIER_PROGRAM_ID").count();
            if owner_checks < parses {
                failures.push(format!(
                    "{rel}: parses {parses} proof buffer(s) but requires the verifier as owner \
                     only {owner_checks} time(s). Without it the account is attacker-supplied \
                     and `verified`/`deep_ali_verified` are whatever bytes it wrote."
                ));
            }
        }

        assert!(
            checked >= 10,
            "expected at least 10 files calling parse_stark_proof_buffer, found {checked} — \
             the scan stopped seeing the consumers and is no longer guarding anything"
        );
        assert!(failures.is_empty(), "unowned proof-buffer reads:\n{}", failures.join("\n"));
    }

    /// The scan above is worth what its parser reads, so the comment stripper is
    /// tested on the shape that would defeat it.
    #[test]
    fn the_owner_scan_does_not_count_prose() {
        let liar = r#"
            /// Requires *proof_info.owner == STARK_VERIFIER_PROGRAM_ID before parsing.
            // require!(*proof_info.owner == STARK_VERIFIER_PROGRAM_ID, E::X);
            /* require!(*p.owner == STARK_VERIFIER_PROGRAM_ID, E::X); */
            let v = parse_stark_proof_buffer(&data)?;
        "#;
        let code = strip_rust_comments(liar);
        assert_eq!(code.matches("parse_stark_proof_buffer(").count(), 1);
        assert_eq!(
            code.matches("owner == STARK_VERIFIER_PROGRAM_ID").count(),
            0,
            "the docstring was counted as the owner check"
        );

        let honest = r#"
            require!(*proof_info.owner == STARK_VERIFIER_PROGRAM_ID, E::X);
            let v = parse_stark_proof_buffer(&data)?;
        "#;
        let code = strip_rust_comments(honest);
        assert_eq!(code.matches("owner == STARK_VERIFIER_PROGRAM_ID").count(), 1);
    }

    /// Drop `//` line comments and `/* */` blocks, keeping string literals.
    fn strip_rust_comments(src: &str) -> String {
        let b: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let (mut i, mut in_str, mut block) = (0usize, false, 0usize);
        while i < b.len() {
            if block > 0 {
                if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '*' {
                    block += 1;
                    i += 2;
                    continue;
                }
                if b[i] == '*' && i + 1 < b.len() && b[i + 1] == '/' {
                    block -= 1;
                    i += 2;
                    continue;
                }
                if b[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
                continue;
            }
            if in_str {
                if b[i] == '\\' {
                    i += 2;
                    continue;
                }
                if b[i] == '"' {
                    in_str = false;
                }
                out.push(b[i]);
                i += 1;
                continue;
            }
            if b[i] == '"' {
                in_str = true;
                out.push(b[i]);
                i += 1;
                continue;
            }
            if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '/' {
                while i < b.len() && b[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '*' {
                block = 1;
                i += 2;
                continue;
            }
            out.push(b[i]);
            i += 1;
        }
        out
    }

    #[test]
    fn a_foreign_discriminator_is_rejected() {
        let (buf, _, _) = distinct_fixture();
        let mut encoded = encode_real_proof_buffer(buf);
        encoded[0] ^= 0x01;
        assert!(parse_stark_proof_buffer(&encoded).is_err());
    }
}

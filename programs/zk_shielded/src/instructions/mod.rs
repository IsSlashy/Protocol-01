pub mod initialize_pool;
pub mod shield_stark;
pub mod transfer_stark;
pub mod unshield_stark;
// P9 — REMOVED Groth16 base-pool instructions (replaced by STARK variants):
//   shield, transfer, unshield, transfer_via_relayer, store_vk_data, update_vk.
// The _stark variants read a pre-verified ProofBuffer from p01_stark_verifier
// and are the canonical base-pool entrypoints.
pub mod init_denominated_pool;
pub mod init_denominated_pool_v3;
pub mod shield_denominated;
pub mod shield_denominated_v3;
pub mod unshield_denominated_stark_v3;
// P3.7 — REMOVED Groth16 denominated-pool instructions (replaced by STARK variants):
//   unshield_denominated, emergency_unshield_denominated, transfer_denominated,
//   split_note, subscribe_private, pause_private, resume_private, cancel_private,
//   update_denominated_vk, update_transfer_vk, store_transfer_vk_data,
//   store_subscriber_vk_data.
// The _stark variants below read a pre-verified proof buffer from
// p01_stark_verifier and are the canonical denominated-pool entrypoints.
pub mod resize_denominated_pool;
pub mod subscribe_normal;
pub mod claim_period;
pub mod pause_normal;
pub mod resume_normal;
pub mod cancel_normal;
// === Deprecated v2 (circuit-1 only, no C3 membership proof = unshield-undeposited risk). Production is v3-only. ===
// pub mod unshield_denominated_stark;
pub mod subscribe_private_stark;
pub mod pause_private_stark;
pub mod resume_private_stark;
pub mod cancel_private_stark;
// === Deprecated v2 (circuit-1 only, no C3 membership proof = unshield-undeposited risk). Production is v3-only. ===
// pub mod transfer_denominated_stark;
pub mod transfer_denominated_stark_v3;
pub mod split_note_stark;
pub mod propose_authority_transfer;
pub mod accept_authority_transfer;
// === PoW & research — Groth16/SNARK path, removed from production (STARK-only flow). Re-enable requires a real ceremony + VK pinning. ===
// pub mod escrow_shield;
// pub mod escrow_release;
// pub mod write_escrow_outcome;
// === end Groth16/SNARK removed block (auction escrow modules) ===
pub mod update_escrow_vk;
pub mod store_escrow_vk_data;
pub mod sweep_fee_escrow;

#[allow(ambiguous_glob_reexports)]
pub use initialize_pool::*;
pub use shield_stark::*;
pub use transfer_stark::*;
pub use unshield_stark::*;
pub use init_denominated_pool::*;
pub use init_denominated_pool_v3::*;
pub use shield_denominated::*;
pub use shield_denominated_v3::*;
pub use unshield_denominated_stark_v3::*;
pub use resize_denominated_pool::*;
pub use subscribe_normal::*;
pub use claim_period::*;
pub use pause_normal::*;
pub use resume_normal::*;
pub use cancel_normal::*;
// === Deprecated v2 (circuit-1 only, no C3 membership proof). Production is v3-only. ===
// pub use unshield_denominated_stark::*;
pub use subscribe_private_stark::*;
pub use pause_private_stark::*;
pub use resume_private_stark::*;
pub use cancel_private_stark::*;
// === Deprecated v2 (circuit-1 only, no C3 membership proof). Production is v3-only. ===
// pub use transfer_denominated_stark::*;
pub use transfer_denominated_stark_v3::*;
pub use split_note_stark::*;
pub use propose_authority_transfer::*;
pub use accept_authority_transfer::*;
// === PoW & research — Groth16/SNARK path, removed from production (STARK-only flow). ===
// pub use escrow_shield::*;
// pub use escrow_release::*;
// pub use write_escrow_outcome::*;
// === end Groth16/SNARK removed block (auction escrow re-exports) ===
pub use update_escrow_vk::*;
pub use store_escrow_vk_data::*;
pub use sweep_fee_escrow::*;

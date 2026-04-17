pub mod initialize_pool;
pub mod shield;
pub mod store_vk_data;
pub mod transfer;
pub mod unshield;
pub mod update_vk;
// REMOVED: transfer_via_relayer — disabled due to unproven relayer fee commitment
// and panic in insert(). Relaying is handled by the on-chain p01_relayer program.
// pub mod transfer_via_relayer;
pub mod init_denominated_pool;
pub mod shield_denominated;
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
pub mod unshield_denominated_stark;
pub mod subscribe_private_stark;
pub mod pause_private_stark;
pub mod resume_private_stark;
pub mod cancel_private_stark;
pub mod transfer_denominated_stark;
pub mod emergency_unshield_denominated_stark;
pub mod split_note_stark;
pub mod propose_authority_transfer;
pub mod accept_authority_transfer;
pub mod escrow_shield;
pub mod escrow_release;
pub mod write_escrow_outcome;
pub mod update_escrow_vk;
pub mod store_escrow_vk_data;

#[allow(ambiguous_glob_reexports)]
pub use initialize_pool::*;
pub use shield::*;
pub use store_vk_data::*;
pub use transfer::*;
pub use unshield::*;
pub use update_vk::*;
// pub use transfer_via_relayer::*;
pub use init_denominated_pool::*;
pub use shield_denominated::*;
pub use resize_denominated_pool::*;
pub use subscribe_normal::*;
pub use claim_period::*;
pub use pause_normal::*;
pub use resume_normal::*;
pub use cancel_normal::*;
pub use unshield_denominated_stark::*;
pub use subscribe_private_stark::*;
pub use pause_private_stark::*;
pub use resume_private_stark::*;
pub use cancel_private_stark::*;
pub use transfer_denominated_stark::*;
pub use emergency_unshield_denominated_stark::*;
pub use split_note_stark::*;
pub use propose_authority_transfer::*;
pub use accept_authority_transfer::*;
pub use escrow_shield::*;
pub use escrow_release::*;
pub use write_escrow_outcome::*;
pub use update_escrow_vk::*;
pub use store_escrow_vk_data::*;

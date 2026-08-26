pub mod initialize_pool;
pub mod shield_stark;
pub mod transfer_stark;
// === `unshield` is DISABLED in lib.rs (circuit-5 only, no membership proof of
// any kind = unshield-undeposited, FUND LOSS). The module is left COMPILED on
// purpose, unlike the v2 deprecations below: the disablement is meant to be
// lifted once C5 publishes its input commitments, and a module that keeps
// type-checking is one the fix does not also have to un-rot. Nothing registers
// it, so nothing can reach it. See the block above `pub fn unshield` in lib.rs. ===
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
/// [C7] The single-proof spend. v3 needs C1 + C3 and PUBLISHES the note
/// commitment to tie them together, which names the deposit that funded the
/// spend. Circuit 7 proves both halves in one trace and publishes no
/// commitment at all. v3 is deliberately left registered: it is the only path
/// that works against the verifier currently deployed on devnet, and it stays
/// until the C7-aware verifier is live.
pub mod unshield_denominated_stark_v4;
// P3.7 — REMOVED Groth16 denominated-pool instructions (replaced by STARK variants):
//   unshield_denominated, emergency_unshield_denominated, transfer_denominated,
//   split_note, subscribe_private, pause_private, resume_private, cancel_private,
//   update_denominated_vk, update_transfer_vk, store_transfer_vk_data,
//   store_subscriber_vk_data.
// The _stark variants below read a pre-verified proof buffer from
// p01_stark_verifier and are the canonical denominated-pool entrypoints.
pub mod resize_denominated_pool;
// === REMOVED: subscribe_normal — its vault PDA was seeded with the subscriber's
// wallet pubkey, so anyone could answer "does wallet W subscribe to merchant M?"
// by re-deriving the address off-chain. A deterministic membership oracle with no
// enumeration cost, sitting next to a private path that seeds on
// `subscriber_commitment`. The weak path defined the privacy of the whole
// subscription feature, so it is gone rather than patched. The only way to open a
// vault is now `subscribe_private_stark`.
// Do not read that as "the oracle is closed on chain". `subscribe_private_stark`
// accepts `subscriber_commitment` as a free `[u8; 32]`, uses it only as a PDA seed
// and proves nothing about it, so a client that puts a wallet pubkey there rebuilds
// the same oracle at the same address. Removal takes away the convenient
// constructor; the client is what keeps the seed unlinkable.
// The `*_normal` lifecycle instructions below are DELIBERATELY KEPT: they are the
// only controls the normal-mode vaults that already exist on chain still have,
// and they cannot create an account, so they carry no oracle of their own.
//
// === REMOVED: cancel_normal and cancel_private_stark. A subscription is a
// one-way prepaid envelope: money that enters a vault can only ever leave it
// toward the retailer. The subscriber's controls are pause and resume, and they
// are told before they pay that there is no cancellation and no refund.
// Three reasons, in the order they matter:
//   1. The residual on a small envelope was worth less than the STARK proof,
//      the re-shield and the relayer fees needed to recover it privately, so
//      the refund was value on paper only.
//   2. The refund leg was the system's only INBOUND operation — the one place
//      the subscriber had to RECEIVE money, and therefore the place the whole
//      linkability budget was being spent. Deleting it removes the hard half
//      of the privacy surface, along with the stealth-meta routing and the
//      re-shield into the denominated pool that served it.
//   3. It deletes a live fund-loss defect instead of fixing it:
//      `claimable_periods` returns 0 while paused and both cancel instructions
//      paid the retailer exactly `claimable * rate` with no `!is_paused`
//      constraint, so pause-then-cancel drained a merchant's entire earned
//      revenue to zero. No cancel instruction, no drain.
// `claim_period` is now the only instruction that can close a
// SubscriptionVault, in either mode; it does so on the claim that spends the
// last funded period, paying the residual and the rent to the retailer. ===
pub mod claim_period;
pub mod pause_normal;
pub mod resume_normal;
// === Deprecated v2 (circuit-1 only, no C3 membership proof = unshield-undeposited risk). Production is v3-only. ===
// pub mod unshield_denominated_stark;
pub mod subscribe_private_stark;
/// [C7] The single-proof subscribe. v3 above needs C1 + C3 and PUBLISHES the
/// note commitment to tie them together, which names the deposit that funded
/// the subscription. Circuit 7 proves both halves in one trace and publishes no
/// commitment at all.
///
/// v3 is deliberately left registered and untouched: apps/mobile still spends on
/// the C1+C3 pair, and a note whose blinding is unknown can be spent NOWHERE
/// ELSE. Removing it strands those notes.
pub mod subscribe_private_stark_v4;
pub mod pause_private_stark;
pub mod resume_private_stark;
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
pub use unshield_denominated_stark_v4::*;
pub use resize_denominated_pool::*;
// === REMOVED: subscribe_normal (see the module block above). ===
// === REMOVED: cancel_normal (see the module block above). ===
pub use claim_period::*;
pub use pause_normal::*;
pub use resume_normal::*;
// === Deprecated v2 (circuit-1 only, no C3 membership proof). Production is v3-only. ===
// pub use unshield_denominated_stark::*;
// === REMOVED: cancel_private_stark (see the module block above). ===
pub use subscribe_private_stark::*;
pub use subscribe_private_stark_v4::*;
pub use pause_private_stark::*;
pub use resume_private_stark::*;
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

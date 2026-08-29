pub mod pool;
pub mod pool_v3;
pub mod merkle_tree;
pub mod merkle_tree_v3;
/// [C7] Goldilocks Poseidon. Before this module the program could not hash
/// in the field its own v3 tree is built in: `merkle_tree::hash_pair` panics
/// and its commented-out body is BN254. C7's public input is a depth-12
/// SUBTREE root, so the spending instruction must walk the remaining levels
/// itself -- and that means hashing on chain.
pub mod poseidon_gl;
/// [C7] Turning circuit 7's depth-12 SUBTREE root into the pool root. Without
/// this walk a C7 proof means 'this leaf is in SOME subtree', which anyone can
/// satisfy with a tree they built themselves.
pub mod spend_root;
/// [C6-D12] The write-side twin of `spend_root`. C6 was cut to depth 12 to make
/// room for a blinding region, so a deposit now proves a SUBTREE transition and
/// the program must fold the remaining levels itself -- against the pool
/// account's own `filled_subtrees`, never the caller's `new_subtrees`.
pub mod insert_root;
pub mod nullifier_set;
pub mod subscription_vault;
pub mod route;
pub mod auction_escrow;

pub use pool::{ShieldedPool, PoolStats, DenominatedPool, SLOTS_PER_EPOCH};
pub use pool_v3::DenominatedPoolV3;
pub use merkle_tree::*;
pub use merkle_tree_v3::{MerkleTreeStateV3, LeafInserted};
pub use nullifier_set::{NullifierSet, NullifierBatch, NullifierRecord};
pub use subscription_vault::{SubscriptionVault, VaultSettlement};
pub use route::PrivacyRoute;
pub use auction_escrow::AuctionEscrow;

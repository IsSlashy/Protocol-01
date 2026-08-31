use anchor_lang::prelude::*;

use crate::state::pool::SLOTS_PER_EPOCH;

// ---------------------------------------------------------------------------
// Denominated Pool V3 — Fully Goldilocks-based, end-to-end post-quantum.
// ---------------------------------------------------------------------------
//
// What changed from v2 (`denominated_pool_v2`):
//
// 1. Tree hash is now Goldilocks Poseidon (t=3, x^7 S-box, 30 full rounds,
//    circulant MDS [[3,1,1],[1,3,1],[1,1,3]]) — the same variant used by the
//    on-chain STARK verifier (`p01_stark_verifier`) and circuits C3
//    (merkle_path) and C6 (merkle_update). v2 used BN254 Poseidon via
//    `poseidon-lite`, which is BN254-curve based and therefore relies on
//    discrete-log hardness for soundness — **not** quantum-safe.
//
// 2. Levels 1+ of the merkle tree are NOW maintained on-chain via the C6
//    (merkle_update) STARK proof verification. In v2, only level 0
//    (`filled_subtrees[0] = leaf`) was persisted; levels 1..depth were
//    accepted on faith from the client-supplied `new_root`. That trust gap
//    led to the stale-subtrees bug fixed in mobile v0.9.10's
//    `replayMerkleProofFromEvents` (rebuild from scratch every time because
//    on-chain `filled_subtrees` could not be trusted).
//
//    In V3, the caller pre-verifies a C6 STARK proof in a separate tx and
//    passes the proof buffer's pubkey into `insert_with_root_v3`. The on-chain
//    program reads the proof buffer's public inputs to confirm:
//      - circuit_id == 6 (merkle_update)
//      - public inputs = (old_root, new_root, leaf, leaf_index, [new_subtrees..])
//      - proof.verified == true
//    Then `merkle_tree.filled_subtrees[i]` are updated for all `i in
//    0..tree_depth` from the verified subtree array. Off-chain rebuild becomes
//    a single `LeafInserted` event subscription with no stale-state risk.
//
// 3. Universal `LeafInserted` event replaces the v2 6-layout decoder
//    (`LEAF_INSERTION_EVENTS`) — emitted only from `insert_with_root_v3`.
//
// 4. SEED_PREFIX bumped to `denominated_pool_v3`. v2 PDAs stay live for the
//    30-day deprecation window. New deposits + new fresh trees in V3.
//
// ---------------------------------------------------------------------------

/// A V3 shielded pool where every note has a fixed denomination.
///
/// Layout is intentionally near-identical to `DenominatedPool` (v2) so the
/// mobile / extension layout decoders can largely be cloned with seed/version
/// bumps. The only on-chain semantic difference is the SEED_PREFIX and the
/// fact that the merkle tree state attached via the `merkle_tree` PDA is a
/// `MerkleTreeStateV3` (with on-chain subtree maintenance via C6).
#[account]
#[derive(Default)]
pub struct DenominatedPoolV3 {
    /// Authority that can update pool settings
    pub authority: Pubkey,

    /// Token mint address (system program for SOL)
    pub token_mint: Pubkey,

    /// Fixed denomination per note (in lamports / atomic units)
    pub denomination: u64,

    /// Minimum epochs that must pass between deposit and withdrawal
    pub epoch_delay: u64,

    /// Current Merkle tree root (Goldilocks Poseidon)
    pub merkle_root: [u8; 32],

    /// Depth of the Merkle tree (15 = 32K notes, bound by STARK circuit 6)
    pub tree_depth: u8,

    /// Index of the next leaf to insert
    pub next_leaf_index: u64,

    /// DEPRECATED in V3: Groth16 verification key hash. STARK circuits are
    /// pinned in p01_stark_verifier; no per-pool VK is consulted. Retained
    /// for layout symmetry with v2.
    pub vk_hash: [u8; 32],

    /// Total amount currently shielded (= note_count * denomination)
    pub total_shielded: u64,

    /// Number of notes in pool (anonymity set size)
    pub note_count: u64,

    /// Whether the pool is accepting new deposits
    pub is_active: bool,

    /// Historical roots (last `max_historical_roots` roots for flexibility)
    pub historical_roots: Vec<[u8; 32]>,

    /// Maximum size of historical roots array
    pub max_historical_roots: u8,

    /// Pool creation timestamp
    pub created_at: i64,

    /// Last transaction timestamp
    pub last_tx_at: i64,

    /// Bump seed for PDA
    pub bump: u8,

    // -- Dynamic delay fields (lazy maturity tracking) --

    /// Number of notes that have been in the pool longer than `epoch_delay`
    /// epochs. Drives `get_dynamic_delay()`.
    pub mature_note_count: u64,

    /// Last epoch at which `update_maturity()` was called.
    pub last_maturity_update_epoch: u64,

    /// Circular buffer: number of notes deposited in each epoch.
    /// Index `i` corresponds to epoch `epoch_note_start + i`.
    pub epoch_note_counts: [u64; 32],

    /// Absolute epoch number corresponding to index 0 of `epoch_note_counts`.
    pub epoch_note_start: u64,

    /// DEPRECATED in V3 (transfer circuit VK hash) — retained for layout
    /// symmetry; STARK transfer circuit is pinned in p01_stark_verifier.
    pub vk_hash_transfer: [u8; 32],

    /// Timestamp of the last VK update (24h cooldown enforcement)
    pub vk_update_slot: i64,

    /// Write index for the historical_roots circular buffer.
    pub root_write_index: u64,

    /// DEPRECATED in V3 (escrow bid circuit VK hash) — retained for layout
    /// symmetry.
    pub vk_hash_escrow: [u8; 32],
}

impl DenominatedPoolV3 {
    /// Size of the epoch_note_counts circular buffer
    pub const EPOCH_BUFFER_SIZE: usize = 32;

    /// Account size — identical layout to v2.
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // token_mint
        + 8   // denomination
        + 8   // epoch_delay
        + 32  // merkle_root
        + 1   // tree_depth
        + 8   // next_leaf_index
        + 32  // vk_hash
        + 8   // total_shielded
        + 8   // note_count
        + 1   // is_active
        + 4 + (100 * 32)  // historical_roots (Vec with max 100 items)
        + 1   // max_historical_roots
        + 8   // created_at
        + 8   // last_tx_at
        + 1   // bump
        + 8   // mature_note_count
        + 8   // last_maturity_update_epoch
        + (8 * 32) // epoch_note_counts ([u64; 32])
        + 8   // epoch_note_start
        + 32  // vk_hash_transfer
        + 8   // vk_update_slot
        + 8   // root_write_index
        + 32; // vk_hash_escrow

    /// Seeds for V3 PDA derivation: [b"denominated_pool_v4", token_mint, denomination]
    ///
    /// Bumped from `denominated_pool_v3` to `denominated_pool_v4` (2026-05-07)
    /// because the v3 pools accumulated leaves whose `LeafInserted` events
    /// are not decodable by the current 6-layout registry (pre-hardening
    /// split/escrow). Mobile cannot rebuild the merkle tree from events when
    /// any leaf is missing → InvalidMerkleRoot at unshield. v4 pools start
    /// with a guaranteed-clean event stream (V3 LeafInserted format only).
    /// Bumped from `denominated_pool_v2` originally because V3 introduces a
    /// different merkle tree hash variant (Goldilocks Poseidon) — fresh
    /// trees are required, can't co-mingle leaves with a different hash.
    pub const SEED_PREFIX: &'static [u8] = b"denominated_pool_v4";

    /// Default tree depth (2^15 = 32,768 notes per pool)
    /// 🚨 IT MUST NOT EQUAL C6's `CANONICAL_DEPTH`, AND THIS LINE SAID IT MUST.
    ///
    /// The circuit proves a SUBTREE. C6 folds `INSERT_SUBTREE_DEPTH` levels and
    /// C7 proves `SPEND_SUBTREE_DEPTH` of them -- both 11 as of 2026-08-29 --
    /// and the program walks the remaining `tree_depth - SUBTREE_DEPTH` on chain
    /// (`spend_root.rs:111`, `insert_root.rs:158`, both DERIVED, neither typed).
    /// With a 15-deep tree that is 4 walked levels.
    ///
    /// This comment predates the subtree split, when the circuit really did
    /// prove the whole tree. Following it today means setting the tree depth to
    /// 11, which leaves ZERO walked levels and a pool whose anonymity set is
    /// 2048 notes instead of 32,768.
    pub const DEFAULT_TREE_DEPTH: u8 = 15;

    /// Maximum historical roots to store (default 100)
    pub const MAX_HISTORICAL_ROOTS: u8 = 100;

    /// VK update cooldown period in seconds (24 hours)
    pub const VK_UPDATE_COOLDOWN: i64 = 86400;

    /// Check if a root is valid (current or historical)
    pub fn is_valid_root(&self, root: &[u8; 32]) -> bool {
        if self.merkle_root == *root {
            return true;
        }
        self.historical_roots.contains(root)
    }

    /// Update the Merkle root and store old root in history.
    /// Circular buffer keyed by `root_write_index` (decoupled from
    /// `next_leaf_index` to avoid corruption when paths diverge).
    pub fn update_root(&mut self, new_root: [u8; 32]) {
        let max = self.max_historical_roots as usize;
        if self.historical_roots.len() < max {
            self.historical_roots.push(self.merkle_root);
        } else if max > 0 {
            let idx = (self.root_write_index as usize) % max;
            self.historical_roots[idx] = self.merkle_root;
        }
        self.root_write_index += 1;
        self.merkle_root = new_root;
    }

    /// Compute the current epoch from a slot number.
    pub fn current_epoch(slot: u64) -> u64 {
        slot / SLOTS_PER_EPOCH
    }

    /// Lazy maturity update — graduates epoch entries older than `epoch_delay`
    /// into `mature_note_count`. Identical to v2.
    pub fn update_maturity(&mut self, current_epoch: u64) {
        if current_epoch <= self.last_maturity_update_epoch {
            self.last_maturity_update_epoch = current_epoch;
            return;
        }

        let maturity_frontier = match current_epoch.checked_sub(self.epoch_delay) {
            Some(f) => f,
            None => {
                self.last_maturity_update_epoch = current_epoch;
                return;
            }
        };

        let prev_frontier = self
            .last_maturity_update_epoch
            .checked_sub(self.epoch_delay)
            .unwrap_or(0);

        let buf_end = self.epoch_note_start + Self::EPOCH_BUFFER_SIZE as u64;

        let scan_start = if prev_frontier >= self.epoch_note_start {
            prev_frontier + 1
        } else {
            self.epoch_note_start
        };

        let scan_end = maturity_frontier
            .min(buf_end.saturating_sub(1))
            + 1;

        if scan_start < scan_end {
            for epoch in scan_start..scan_end {
                let idx =
                    ((epoch - self.epoch_note_start) as usize) % Self::EPOCH_BUFFER_SIZE;
                self.mature_note_count = self
                    .mature_note_count
                    .saturating_add(self.epoch_note_counts[idx]);
                self.epoch_note_counts[idx] = 0;
            }
        }

        let new_start = maturity_frontier.saturating_add(1);
        if new_start > self.epoch_note_start {
            let zero_end =
                new_start.min(self.epoch_note_start + Self::EPOCH_BUFFER_SIZE as u64);
            for epoch in self.epoch_note_start..zero_end {
                let idx =
                    ((epoch - self.epoch_note_start) as usize) % Self::EPOCH_BUFFER_SIZE;
                self.epoch_note_counts[idx] = 0;
            }
            self.epoch_note_start = new_start;
        }

        self.last_maturity_update_epoch = current_epoch;
    }

    /// Returns the dynamic withdrawal delay (in additional epochs) based on
    /// the anonymity set size. Identical thresholds to v2.
    pub fn get_dynamic_delay(&self) -> u64 {
        if self.mature_note_count >= 1000 {
            0
        } else if self.mature_note_count >= 100 {
            1
        } else if self.mature_note_count >= 10 {
            1
        } else {
            2
        }
    }

    /// Record a deposit in the epoch circular buffer.
    /// Must be called AFTER `update_maturity()`.
    pub fn record_deposit(&mut self, current_epoch: u64) {
        if current_epoch < self.epoch_note_start {
            return;
        }

        let offset = current_epoch - self.epoch_note_start;

        if offset >= Self::EPOCH_BUFFER_SIZE as u64 {
            self.epoch_note_counts = [0u64; 32];
            self.epoch_note_start = current_epoch;
            self.epoch_note_counts[0] = 1;
        } else {
            let idx = offset as usize;
            self.epoch_note_counts[idx] = self.epoch_note_counts[idx].saturating_add(1);
        }
    }
}

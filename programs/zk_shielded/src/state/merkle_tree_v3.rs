use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::insert_root::{INSERT_SUBTREE_DEPTH, MAX_TOP_LEVELS};
use crate::state::poseidon_gl::{hash2, MODULUS};

/// V3 Merkle tree state — Goldilocks Poseidon hash, on-chain subtree
/// maintenance via the C6 (merkle_update) STARK proof.
///
/// In v2 the program persisted only `filled_subtrees[0] = leaf` and trusted
/// the client-supplied root for everything above level 0. In V3 the caller
/// pre-verifies a C6 STARK proof in a separate transaction; this program
/// reads the proof buffer to confirm the new (root, subtrees) tuple is
/// consistent with the previous root + the new leaf.
#[account]
#[derive(Default)]
pub struct MerkleTreeStateV3 {
    /// Associated denominated pool (V3)
    pub pool: Pubkey,

    /// Current root hash (Goldilocks Poseidon)
    pub root: [u8; 32],

    /// Number of leaves inserted
    pub leaf_count: u64,

    /// Tree depth
    pub depth: u8,

    /// Filled subtrees, one per level (0..=depth).
    /// Maintained on-chain in V3 — updated from the C6 proof's public
    /// inputs on every `insert_with_root_v3` call.
    pub filled_subtrees: Vec<[u8; 32]>,

    /// Bump seed for PDA
    pub bump: u8,

    /// [ERAS 2026-09-06] Which era of its (mint, denomination) this tree
    /// belongs to. Era 0 is the pool seeded on three seeds (the pools live on
    /// devnet today); era `n >= 1` is a pool seeded on four, the fourth being
    /// `n.to_le_bytes()`. See `pool_v3::pool_pda`.
    ///
    /// TRAILING ON PURPOSE. Existing tree accounts were allocated at `LEN` with
    /// zero padding after the serialized struct, so Borsh reads this field as
    /// `0` on every tree that predates it: era 0, which is exactly what they
    /// are. It could NOT have gone on the pool account: a pool whose root ring
    /// is full serializes to exactly its old `LEN`, so a trailing field there
    /// reads past the buffer and every instruction on that pool fails until a
    /// migration lands.
    pub era: u16,
}

impl MerkleTreeStateV3 {
    /// Account size calculation. Same layout as v2 `MerkleTreeState` so the
    /// indexer code can largely be reused.
    pub const LEN: usize = 8 // discriminator
        + 32  // pool
        + 32  // root
        + 8   // leaf_count
        + 1   // depth
        + 4 + (21 * 32)  // filled_subtrees (Vec with depth + 1 items, max depth 20)
        + 1   // bump
        + 2;  // era ([ERAS 2026-09-06], trailing)

    /// The deepest tree this program walks: `INSERT_SUBTREE_DEPTH +
    /// MAX_TOP_LEVELS` = 19, so 524,288 leaves. `LEN` budgets 21 subtree
    /// entries (depth 20) but the on-chain fold walks at most `MAX_TOP_LEVELS`
    /// above the circuit, and that -- not the account -- is the ceiling.
    pub const MAX_DEPTH: u8 = INSERT_SUBTREE_DEPTH + MAX_TOP_LEVELS as u8;

    /// Seeds for PDA derivation: [b"merkle_tree_v4", pool.key()]
    /// Bumped from `merkle_tree_v3` along with `denominated_pool_v4` so
    /// fresh pools start with empty trees and a clean event stream.
    pub const SEED_PREFIX: &'static [u8] = b"merkle_tree_v4";

    /// Zero value for empty leaves under Goldilocks Poseidon t=3.
    /// V3 base zero = field zero (0u64 LE-padded to 32 bytes), unlike v2 which
    /// used the Tornado constant `keccak256("specter") % BN254_FIELD_ORDER`.
    pub const ZERO_VALUE: [u8; 32] = [0u8; 32];

    /// Precomputed zero hashes per level (up to depth 20) under Goldilocks
    /// Poseidon t=3 (30 full rounds, x^7 S-box, circulant MDS [[3,1,1],[1,3,1],[1,1,3]]).
    ///
    /// Generated 2026-05-03 from `packages/privacy-sdk/src/crypto/poseidonGl.ts`,
    /// which in turn matches `stark/src/poseidon/mod.rs` parity vectors:
    ///   `hash2(0, 0) = 18051734659105196655` (low limb)
    ///   `hash4(1,2,3,4) = 3933389460072713373` (low limb)
    ///
    /// Each entry is the low 8 bytes (LE) of `poseidonHash2(ZEROS[i-1], ZEROS[i-1])`,
    /// padded with 24 zero bytes (Goldilocks values fit in 64 bits).
    /// Verified by cross-running `verify_poseidon_temp.ts` and tagging into
    /// the on-chain Poseidon round impl during v3 deploy.
    pub const ZEROS: [[u8; 32]; 21] = [
        [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[0] = 0
        [0x6f, 0x8a, 0x92, 0xbf, 0x07, 0xa5, 0x84, 0xfa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[1] = 18051734659105196655
        [0x10, 0x3c, 0xb5, 0x92, 0x90, 0x89, 0xab, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[2] = 3579105582905637904
        [0x7b, 0x88, 0xa7, 0x1c, 0x9f, 0xcc, 0x5c, 0xc1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[3] = 13933236330930079867
        [0xb5, 0x04, 0x62, 0x80, 0x07, 0x59, 0xc8, 0x45, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[4] = 5028366872712709301
        [0x11, 0x76, 0xde, 0xea, 0xf4, 0xa3, 0x88, 0x19, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[5] = 1839900720088643089
        [0x4b, 0x83, 0xf5, 0x53, 0x9f, 0x1c, 0xda, 0x2b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[6] = 3159869559187800907
        [0xdc, 0x0a, 0x04, 0xe4, 0x7d, 0xa3, 0xb6, 0x59, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[7] = 6464534076228635356
        [0x96, 0xdb, 0x51, 0xb8, 0xbe, 0xcd, 0xff, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[8] = 1224923842687916950
        [0xff, 0xe1, 0xa0, 0xbd, 0x5a, 0x45, 0xfe, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[9] = 7421445491983966719
        [0x70, 0x35, 0xe6, 0x8c, 0x6a, 0xa8, 0xa4, 0x5f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[10] = 6891818505367598448
        [0x57, 0xd2, 0xdf, 0xb0, 0xcd, 0xbc, 0xac, 0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[11] = 1633888356450423383
        [0x67, 0xc6, 0x90, 0x14, 0xfd, 0x41, 0x5d, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[12] = 2260035143237420647
        [0x76, 0x7e, 0x5d, 0x15, 0x56, 0xf0, 0x8a, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[13] = 1264086897947147894
        [0xd5, 0xcd, 0x1e, 0x8d, 0x12, 0x3b, 0x85, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[14] = 13512271207858097621
        [0x18, 0x2d, 0xbf, 0x4c, 0x9d, 0x56, 0xba, 0x52, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[15] = 5961172290375724312
        [0x0f, 0xab, 0xa2, 0x85, 0x35, 0xb0, 0xd0, 0x88, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[16] = 9858573328235801359
        [0x3e, 0x04, 0xd9, 0x6c, 0xe6, 0x17, 0xd6, 0xc2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[17] = 14039435166810178622
        [0x30, 0xd9, 0xe2, 0xc8, 0xc1, 0x19, 0xb2, 0x8a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[18] = 9994078843178244400
        [0xfb, 0x2c, 0x2b, 0x95, 0x4a, 0x0b, 0xad, 0xb1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[19] = 12802901730642308347
        [0x7f, 0x41, 0x9a, 0xd7, 0x5f, 0xb7, 0xc6, 0xeb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],  // ZEROS[20] = 16989468266568761727
    ];

    /// Initialize the tree with precomputed zero values.
    pub fn initialize(&mut self, pool: Pubkey, depth: u8) {
        self.pool = pool;
        self.depth = depth;
        self.leaf_count = 0;

        self.filled_subtrees = Vec::with_capacity((depth + 1) as usize);
        for i in 0..=depth as usize {
            self.filled_subtrees.push(Self::ZEROS[i]);
        }

        self.root = Self::ZEROS[depth as usize];
    }

    /// Insert a new leaf with a C6-attested root.
    ///
    /// **Pre-condition: the caller MUST have verified the C6 proof buffer
    /// out-of-band before invoking this function** (see
    /// `shield_denominated_v3::handler` for the canonical pattern). The
    /// `c6_verified` flag is the caller's attestation that all of the
    /// following held when the proof buffer was inspected:
    ///   - owner == p01_stark_verifier program
    ///   - discriminator matches `ProofBuffer`
    ///   - `circuit_id == 6` (merkle_update)
    ///   - both `verified == true` AND `deep_ali_verified == true`
    ///   - `public_inputs_hash == sha256(old_leaf_le || new_leaf_le ||
    ///        old_root_le || new_root_le || depth_le)` where:
    ///       * old_leaf = ZEROS[0] (insertion ⇒ replacing an empty leaf)
    ///       * new_leaf = `leaf` (the commitment, low 8 bytes as Goldilocks u64)
    ///       * old_root = `self.root` low 8 bytes
    ///       * new_root = `new_root` low 8 bytes
    ///       * depth = `self.depth as u64`
    ///
    /// The verification was hoisted out of this function (option B per the
    /// c6-wiring scoping doc) because the proof-buffer `AccountInfo` has a
    /// lifetime that does not flow cleanly across the `&mut self` borrow on
    /// `MerkleTreeStateV3`. Keeping the parsing in the handler also lets
    /// future instructions (transfer_v3, split_v3, escrow_release_v3) reuse
    /// the same parser without dragging account types into the state struct.
    ///
    /// `new_subtrees` is the post-insertion `filled_subtrees` array (one
    /// entry per internal level, length == tree_depth). It is **not** bound
    /// by the C6 proof — the AIR's public inputs only attest the root
    /// transition, not the intermediate subtree state. We update
    /// `filled_subtrees` from this argument as a convenience for future
    /// inserts; off-chain merkle rebuild should derive the canonical state
    /// from `LeafInserted` events rather than trusting these values.
    pub fn insert_with_root_v3(
        &mut self,
        leaf: [u8; 32],
        new_root: [u8; 32],
        new_subtrees: &[[u8; 32]],
        c6_verified: bool,
    ) -> Result<u64> {
        // Hard-fail if the handler did not perform the C6 verification.
        require!(c6_verified, ZkShieldedError::InvalidProof);

        let leaf_index = self.leaf_count;

        // Tree-full guard
        let max_leaves = 1u64 << self.depth;
        require!(leaf_index < max_leaves, ZkShieldedError::MerkleTreeFull);

        // Sanity guards (mirror v2)
        require!(new_root != [0u8; 32], ZkShieldedError::InvalidMerkleRoot);
        require!(new_root != self.root, ZkShieldedError::InvalidMerkleRoot);

        // Sanity: caller must pass exactly `tree_depth` updated subtrees.
        // (The merkle_update circuit emits `tree_depth` updated subtree
        // commitments, one per internal level. Level 0 is the leaf itself.)
        require!(
            new_subtrees.len() == self.depth as usize,
            ZkShieldedError::InvalidMerkleRoot
        );

        let old_root = self.root;

        // Update the on-chain subtree state from the caller-supplied array,
        // BELOW THE CIRCUIT DEPTH ONLY.
        //
        // [DENIAL 2026-09-06] This loop used to write every level, and that
        // was a permanent denial of deposits. `fold_insertion` READS
        // `filled_subtrees[l]` for `l >= INSERT_SUBTREE_DEPTH` whenever the
        // insertion path turns RIGHT at level `l` (the stored value is the
        // completed left sibling), and it only RE-DERIVES the levels where the
        // path turns LEFT. So a depositor whose `new_subtrees` carried anything
        // but the exact running value at a right-turning level -- a stale
        // layout, a shifted array, one wrong byte, no malice needed -- left
        // that garbage in place, the handler's derived-subtree overwrite did
        // not touch it (it only covers left turns), and the NEXT deposit on the
        // same branch folded its old root through the garbage, missed the pool
        // root, and failed `InvalidMerkleRoot`. Every deposit after it did the
        // same, because the frontier at that level is only rewritten by a
        // left turn, and a left turn needs the insertions that were failing.
        // The first leaf of bucket 1 (index 2,048) is the earliest trigger:
        // bit 11 is set, `filled_subtrees[11]` is read by every later leaf in
        // the bucket, and nothing ever restores it.
        //
        // The fix is the rule the fold already lives by: from
        // `INSERT_SUBTREE_DEPTH` up, the frontier is DERIVED (the handler
        // writes `folded.updated_subtrees()`), never accepted. Below it the
        // program cannot derive the values -- C6 keeps its path private -- and
        // does not read them either; they remain the client's hint for the
        // next deposit's witness, repairable by any client that rebuilds from
        // `LeafInserted` events. Pinned by
        // `a_stale_top_level_hint_no_longer_denies_the_next_deposit`.
        self.filled_subtrees[0] = leaf;
        for (i, sub) in new_subtrees.iter().enumerate() {
            // i+1 because index 0 is the leaf itself, levels 1..=depth-1
            // come from the caller's frontier. The depth-level subtree is
            // the new root and is stored separately in `self.root`.
            let level = i + 1;
            if level < INSERT_SUBTREE_DEPTH as usize && level < self.filled_subtrees.len() {
                self.filled_subtrees[level] = *sub;
            }
        }

        self.root = new_root;
        self.leaf_count += 1;

        // Universal V3 event — replaces the v2 6-layout decoder.
        emit!(LeafInserted {
            pool: self.pool,
            leaf_index,
            leaf,
            new_root,
            old_root,
        });

        Ok(leaf_index)
    }

    /// `1 << depth` leaves are the most this tree holds; the next insert
    /// fails `MerkleTreeFull`. Deposit clients read this to decide whether to
    /// open the next era first (see `instructions::open_next_era`).
    pub fn is_full(&self) -> bool {
        self.leaf_count >= (1u64 << self.depth)
    }

    /// Read a stored 32-byte root as a canonical Goldilocks element. Same rule
    /// as `insert_root::felt_of`: the upper 24 bytes must be zero and the low
    /// limb must be below the modulus, or two byte strings could name one root.
    pub fn felt_of(bytes: &[u8; 32]) -> Result<u64> {
        require!(
            bytes[8..].iter().all(|b| *b == 0),
            ZkShieldedError::InvalidMerkleRoot
        );
        let v = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        require!(v < MODULUS, ZkShieldedError::InvalidMerkleRoot);
        Ok(v)
    }

    /// Canonical 32-byte encoding of a Goldilocks element.
    pub fn bytes_of(v: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[..8].copy_from_slice(&v.to_le_bytes());
        out
    }

    /// [DEPTH-19 2026-09-06] The root a `from_depth` tree has once it is
    /// viewed as the left-most subtree of a `to_depth` tree.
    ///
    /// Every leaf the shallow tree holds sits at an index below
    /// `1 << from_depth`, so at every level from `from_depth` up the running
    /// node is the LEFT child and its sibling is the canonical empty subtree
    /// `ZEROS[level]` -- a constant, which is what makes this a pure function
    /// of the old root rather than of any state a caller could steer. This is
    /// the same walk `fold_insertion` does at a left turn, applied to the old
    /// root and to every root in the pool's ring, so a proof prepared before
    /// the migration still names a root the pool vouches for after it.
    pub fn lift_root(root: [u8; 32], from_depth: u8, to_depth: u8) -> Result<[u8; 32]> {
        require!(from_depth <= to_depth, ZkShieldedError::InvalidTreeDepth);
        require!(to_depth <= Self::MAX_DEPTH, ZkShieldedError::InvalidTreeDepth);
        let mut cur = Self::felt_of(&root)?;
        for level in from_depth..to_depth {
            let zero = Self::felt_of(&Self::ZEROS[level as usize])?;
            cur = hash2(cur, zero);
        }
        Ok(Self::bytes_of(cur))
    }

    /// [DEPTH-19 2026-09-06] Deepen this tree in place, keeping every leaf at
    /// its index. Returns `(old_depth, old_root)` so the caller can lift the
    /// pool's ring with the same numbers.
    ///
    /// The frontier entry at the OLD depth is set to the OLD root, not to a
    /// zero hash: if the tree was full when it was deepened, the next leaf
    /// (index `1 << old_depth`) turns RIGHT at that level and the fold reads
    /// this entry as its left sibling, which is the whole old tree. If the
    /// tree was not full, the next leaf turns LEFT there and the fold
    /// overwrites the entry with the running value before reading anything,
    /// so the choice is harmless. Levels above the old depth are empty on the
    /// right and get `ZEROS`.
    pub fn migrate_depth(&mut self, new_depth: u8) -> Result<(u8, [u8; 32])> {
        let old_depth = self.depth;
        require!(new_depth > old_depth, ZkShieldedError::InvalidTreeDepth);
        require!(new_depth <= Self::MAX_DEPTH, ZkShieldedError::InvalidTreeDepth);
        require!(
            self.filled_subtrees.len() == old_depth as usize + 1,
            ZkShieldedError::InvalidMerkleRoot
        );
        let old_root = self.root;
        let new_root = Self::lift_root(old_root, old_depth, new_depth)?;

        self.filled_subtrees[old_depth as usize] = old_root;
        for level in (old_depth as usize + 1)..=(new_depth as usize) {
            self.filled_subtrees.push(Self::ZEROS[level]);
        }
        self.root = new_root;
        self.depth = new_depth;
        Ok((old_depth, old_root))
    }
}

/// Universal leaf-insertion event for V3. Emitted only by
/// `insert_with_root_v3`. This is the canonical event for off-chain merkle
/// rebuild — all V3 shield/transfer/split/escrow_release paths converge here.
///
/// Replaces the v2 zoo of `ShieldDenominatedEvent`, `MerkleRootChanged`,
/// `EscrowReleaseEvent`, `SplitNoteEvent`, `TransferDenominatedEvent`,
/// `CancelPrivateEvent` (the 6 layouts handled by the mobile
/// `LEAF_INSERTION_EVENTS` decoder).
#[event]
pub struct LeafInserted {
    pub pool: Pubkey,
    pub leaf_index: u64,
    pub leaf: [u8; 32],
    pub new_root: [u8; 32],
    pub old_root: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::insert_root::{fold_insertion, INSERT_SUBTREE_DEPTH};

    fn z(level: usize) -> u64 {
        u64::from_le_bytes(MerkleTreeStateV3::ZEROS[level][..8].try_into().unwrap())
    }
    fn leaf_value(i: u64) -> u64 {
        1_000_003 + i * 7
    }

    /// An honest incremental tree at any depth, written the plain way so it
    /// shares no code with the fold it is checking.
    struct RefTree {
        depth: u8,
        filled: Vec<u64>,
        root: u64,
        count: u64,
        leaves: Vec<u64>,
    }
    impl RefTree {
        fn new(depth: u8) -> Self {
            RefTree {
                depth,
                filled: (0..depth as usize).map(z).collect(),
                root: z(depth as usize),
                count: 0,
                leaves: vec![],
            }
        }
        fn insert(&mut self, leaf: u64) -> u64 {
            let index = self.count;
            let mut cur = leaf;
            let mut idx = index;
            for level in 0..self.depth as usize {
                if idx % 2 == 0 {
                    self.filled[level] = cur;
                    cur = hash2(cur, z(level));
                } else {
                    cur = hash2(self.filled[level], cur);
                }
                idx /= 2;
            }
            self.root = cur;
            self.count += 1;
            self.leaves.push(leaf);
            index
        }
        /// Root of the depth-11 bucket leaf `leaf_index` lives in, holding the
        /// leaves below `upto`, as C6 attests it, rebuilt from scratch. The
        /// bucket is named by the LEAF, not by `upto`: at a bucket boundary
        /// `upto` already points into the next bucket.
        fn subtree_root(&self, leaf_index: u64, upto: u64) -> u64 {
            let bucket = leaf_index >> INSERT_SUBTREE_DEPTH;
            let lo = bucket << INSERT_SUBTREE_DEPTH;
            let mut level: Vec<u64> = (0..(1u64 << INSERT_SUBTREE_DEPTH))
                .map(|i| {
                    let g = lo + i;
                    if g < upto { self.leaves[g as usize] } else { 0 }
                })
                .collect();
            for _ in 0..INSERT_SUBTREE_DEPTH {
                level = level.chunks(2).map(|c| hash2(c[0], c[1])).collect();
            }
            level[0]
        }
    }

    fn b32(v: u64) -> [u8; 32] {
        MerkleTreeStateV3::bytes_of(v)
    }
    fn felt(b: &[u8; 32]) -> u64 {
        u64::from_le_bytes(b[..8].try_into().unwrap())
    }

    /// What the on-chain deposit does around `insert_with_root_v3`: fold the
    /// two subtree roots through the pool's own frontier, require the old
    /// fold to reproduce the root, insert, then write the derived top levels.
    /// `legacy` reproduces the write the fix removed, so the SAME sequence can
    /// be run through both behaviours.
    fn deposit(
        tree: &mut MerkleTreeStateV3,
        leaf: u64,
        old_sub: u64,
        new_sub: u64,
        hint: &[[u8; 32]],
        legacy: bool,
    ) -> std::result::Result<(), String> {
        let insert_at = tree.leaf_count;
        let filled: Vec<u64> = tree.filled_subtrees.iter().map(felt).collect();
        let folded = fold_insertion(old_sub, new_sub, insert_at, &filled, tree.depth)
            .map_err(|e| format!("{e:?}"))?;
        if folded.old_pool_root != felt(&tree.root) {
            return Err("InvalidMerkleRoot: old fold missed the pool root".into());
        }
        let new_root = b32(folded.new_pool_root);
        tree.insert_with_root_v3(b32(leaf), new_root, hint, true)
            .map_err(|e| format!("{e:?}"))?;
        if legacy {
            // The removed behaviour: every level from the caller's array.
            for (i, sub) in hint.iter().enumerate() {
                if i + 1 < tree.filled_subtrees.len() {
                    tree.filled_subtrees[i + 1] = *sub;
                }
            }
        }
        for (level, value) in folded.updated_subtrees() {
            let l = *level as usize;
            if l < tree.filled_subtrees.len() {
                tree.filled_subtrees[l] = b32(*value);
            }
        }
        Ok(())
    }

    fn fresh(depth: u8) -> MerkleTreeStateV3 {
        let mut t = MerkleTreeStateV3::default();
        t.initialize(Pubkey::new_unique(), depth);
        t
    }

    /// The frontier a correct client sends: levels 1..depth-1 of the honest
    /// tree, and the root in the last slot (the level the tree stores apart).
    fn honest_hint(r: &RefTree, depth: usize) -> Vec<[u8; 32]> {
        (1..=depth)
            .map(|l| if l < r.depth as usize { b32(r.filled[l]) } else { b32(r.root) })
            .collect()
    }

    /// Drive an honest reference tree and the on-chain state together up to
    /// `n` leaves, feeding the chain an honest frontier hint, and return both.
    fn advance(tree: &mut MerkleTreeStateV3, r: &mut RefTree, n: u64, legacy: bool) {
        while r.count < n {
            let i = r.count;
            let old_sub = r.subtree_root(i, i);
            r.insert(leaf_value(i));
            let new_sub = r.subtree_root(i, i + 1);
            let hint = honest_hint(r, tree.depth as usize);
            deposit(tree, leaf_value(i), old_sub, new_sub, &hint, legacy)
                .unwrap_or_else(|e| panic!("honest deposit {i} failed: {e}"));
            assert_eq!(felt(&tree.root), r.root, "root diverged at leaf {i}");
        }
    }

    /// Fast-forward a pool to just before bucket 1 without hashing 2,048
    /// leaves through the reference: seed the state directly from the
    /// reference's frontier at count 2,048 - 1, then take the real steps.
    fn seeded_at(count: u64, depth: u8) -> (MerkleTreeStateV3, RefTree) {
        let mut r = RefTree::new(depth);
        for i in 0..count {
            r.insert(leaf_value(i));
        }
        let mut t = fresh(depth);
        t.leaf_count = count;
        t.root = b32(r.root);
        for l in 0..depth as usize {
            t.filled_subtrees[l] = b32(r.filled[l]);
        }
        (t, r)
    }

    /// [DENIAL 2026-09-06] THE FINDING, REPRODUCED, THEN CLOSED.
    ///
    /// Leaf 2,048 is the first of bucket 1: bit 11 is set, so the fold reads
    /// `filled_subtrees[11]` as its left sibling and does NOT re-derive that
    /// level. Under the old write, the depositor's `new_subtrees[10]` landed
    /// there. Give that ONE entry a stale value (the whole rest of the hint
    /// honest, the proof honest, the fold succeeding) and every deposit after
    /// it fails `InvalidMerkleRoot`. Under the fix the entry is never
    /// written from the caller, and the same sequence lands.
    #[test]
    fn a_stale_top_level_hint_no_longer_denies_the_next_deposit() {
        for legacy in [true, false] {
            let (mut t, mut r) = seeded_at(2_048, 15);
            // Leaf 2,048: honest proof, hint stale at level 11 only.
            let i = r.count;
            let old_sub = r.subtree_root(i, i);
            r.insert(leaf_value(i));
            let new_sub = r.subtree_root(i, i + 1);
            let mut hint = honest_hint(&r, 15);
            hint[10] = b32(r.filled[11] ^ 0x5EED); // level 11, one stale word
            deposit(&mut t, leaf_value(i), old_sub, new_sub, &hint, legacy)
                .expect("the deposit that plants the garbage is itself accepted");
            assert_eq!(felt(&t.root), r.root, "the planting deposit still lands on the honest root");

            // Leaf 2,049: honest in every respect.
            let i = r.count;
            let old_sub = r.subtree_root(i, i);
            r.insert(leaf_value(i));
            let new_sub = r.subtree_root(i, i + 1);
            let hint = honest_hint(&r, 15);
            let res = deposit(&mut t, leaf_value(i), old_sub, new_sub, &hint, legacy);
            if legacy {
                assert!(
                    res.is_err(),
                    "OLD CODE: the honest deposit after the stale hint must fail (the finding)"
                );
                // And it is permanent: the next one fails the same way.
                let i = r.count;
                let old_sub = r.subtree_root(i, i);
                r.insert(leaf_value(i));
                let new_sub = r.subtree_root(i, i + 1);
                let hint = honest_hint(&r, 15);
                assert!(deposit(&mut t, leaf_value(i), old_sub, new_sub, &hint, true).is_err());
            } else {
                res.expect("NEW CODE: the honest deposit after a stale hint must land");
                assert_eq!(felt(&t.root), r.root);
                assert_eq!(
                    felt(&t.filled_subtrees[11]),
                    r.filled[11],
                    "level 11 holds the completed left bucket, not the caller's word"
                );
            }
        }
    }

    /// The hint is still accepted BELOW the circuit depth and refused at it
    /// and above, whatever the caller sends.
    #[test]
    fn the_caller_hint_stops_at_the_circuit_depth() {
        let mut t = fresh(15);
        let garbage: Vec<[u8; 32]> = (0..15).map(|i| b32(0xDEAD_0000 + i)).collect();
        // Bypass the fold: this only looks at what insert_with_root_v3 writes.
        t.insert_with_root_v3(b32(7), b32(9), &garbage, true).unwrap();
        for l in 1..INSERT_SUBTREE_DEPTH as usize {
            assert_eq!(t.filled_subtrees[l], garbage[l - 1], "level {l} is the client's hint");
        }
        for l in INSERT_SUBTREE_DEPTH as usize..=15 {
            assert_eq!(
                t.filled_subtrees[l],
                MerkleTreeStateV3::ZEROS[l],
                "level {l} must never take the caller's word"
            );
        }
    }

    /// [DEPTH-19] A tree deepened in place has the root the honest deeper
    /// tree has, every existing leaf keeps its index, and the next deposits
    /// fold correctly through the new levels -- including the deposit that
    /// crosses the old capacity on a FULL tree, which reads the old root as
    /// its level-15 sibling.
    #[test]
    fn migrating_the_depth_matches_the_honest_deeper_tree_and_keeps_accepting_deposits() {
        // Small depths keep the reference cheap: 12 -> 14, INSERT depth is 11
        // so the walk is 1 then 3 levels. The arithmetic is identical at 15 -> 19.
        let (mut t, mut r12) = seeded_at((1 << 12) - 2, 12);
        advance(&mut t, &mut r12, 1 << 12, false); // fill it completely
        assert!(t.is_full());

        let leaves = r12.leaves.clone();
        let mut r14 = RefTree::new(14);
        for l in &leaves {
            r14.insert(*l);
        }
        let (old_depth, old_root) = t.migrate_depth(14).unwrap();
        assert_eq!(old_depth, 12);
        assert_eq!(felt(&old_root), r12.root);
        assert_eq!(felt(&t.root), r14.root, "the lifted root is the honest depth-14 root");
        assert_eq!(t.depth, 14);
        assert_eq!(t.filled_subtrees.len(), 15);
        assert!(!t.is_full());

        // The deposit that crosses the old capacity, then a few more.
        advance(&mut t, &mut r14, (1 << 12) + 5, false);
        assert_eq!(felt(&t.root), r14.root);

        // lift_root is the same function on any root the ring holds.
        assert_eq!(
            MerkleTreeStateV3::lift_root(old_root, 12, 14).unwrap(),
            b32(r14_root_of_first_4096(&leaves)),
        );
    }

    fn r14_root_of_first_4096(leaves: &[u64]) -> u64 {
        let mut r = RefTree::new(14);
        for l in leaves {
            r.insert(*l);
        }
        r.root
    }

    /// The same, on a tree that is NOT full: the next leaf turns left at the
    /// old depth and overwrites the entry the migration put there.
    #[test]
    fn migrating_a_partly_filled_tree_keeps_folding() {
        let (mut t, mut r) = seeded_at(5, 12);
        let leaves = r.leaves.clone();
        t.migrate_depth(13).unwrap();
        let mut r13 = RefTree::new(13);
        for l in &leaves {
            r13.insert(*l);
        }
        assert_eq!(felt(&t.root), r13.root);
        let _ = &mut r;
        advance(&mut t, &mut r13, 9, false);
        assert_eq!(felt(&t.root), r13.root);
    }

    #[test]
    fn migration_refuses_shallower_equal_and_past_the_ceiling() {
        let mut t = fresh(15);
        assert!(t.migrate_depth(15).is_err());
        assert!(t.migrate_depth(14).is_err());
        assert!(t.migrate_depth(20).is_err(), "MAX_DEPTH is 19: the fold walks at most 8 levels");
        assert_eq!(MerkleTreeStateV3::MAX_DEPTH, 19);
        assert!(t.migrate_depth(19).is_ok());
        assert_eq!(t.filled_subtrees.len(), 20);
        assert_eq!(1u64 << t.depth, 524_288);
    }

    /// `LEN` still holds a depth-19 tree with its trailing era.
    #[test]
    fn len_holds_the_deepest_tree_and_the_era() {
        let mut t = fresh(19);
        t.era = 7;
        let mut buf = Vec::new();
        t.serialize(&mut buf).unwrap();
        assert!(8 + buf.len() <= MerkleTreeStateV3::LEN, "{} > LEN", 8 + buf.len());
        // And a tree serialized WITHOUT the era (every live tree) reads era 0
        // out of its zero padding.
        let mut legacy = buf[..buf.len() - 2].to_vec();
        legacy.resize(MerkleTreeStateV3::LEN - 8, 0);
        let mut sl: &[u8] = &legacy;
        let back = MerkleTreeStateV3::deserialize(&mut sl).unwrap();
        assert_eq!(back.era, 0);
        assert_eq!(back.depth, 19);
    }
}

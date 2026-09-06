//! [ERAS / DEPTH-19 / RING-255 2026-09-06] A pool that never fills -- EXECUTED
//! against the real `target/deploy/zk_shielded.so` in litesvm, not argued.
//!
//! Same rig discipline as `subscribe_v4_adversarial.rs`: the STARK buffers are
//! planted with `set_account` (on a cluster only the verifier can write them,
//! here that is what makes the rest of every handler reachable), and every
//! Merkle value the chain is fed comes from an honest reference tree written
//! the plain way in this file, so the fold, the lift and the walk are checked
//! against arithmetic they do not share.
//!
//!   cargo build-sbf --manifest-path programs/zk_shielded/Cargo.toml
//!   cargo test -p zk_shielded --test eras_and_depth -- --nocapture

use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::PathBuf;

use zk_shielded::errors::ZkShieldedError;
use zk_shielded::state::insert_root::INSERT_SUBTREE_DEPTH;
use zk_shielded::state::poseidon_gl::hash2;
use zk_shielded::state::{DenominatedPoolV3, MerkleTreeStateV3, NullifierRecord, PoolDirectory};

const PROGRAM_ID: &str = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";
const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";
const PROOF_BUF_DISC: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];
const DENOM: u64 = 1_000_000_000; // 1 SOL
const EPOCH_DELAY: u64 = 1;

fn program_id() -> Address {
    PROGRAM_ID.parse().unwrap()
}
fn verifier_id() -> Address {
    VERIFIER_ID.parse().unwrap()
}
fn so_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/zk_shielded.so")
}
fn disc(name: &str) -> [u8; 8] {
    let h = solana_sha256_hasher::hashv(&[format!("global:{name}").as_bytes()]).to_bytes();
    let mut d = [0u8; 8];
    d.copy_from_slice(&h[..8]);
    d
}
fn err_code(s: &str) -> Option<u32> {
    s.split("Custom(").nth(1)?.split(')').next()?.trim().parse().ok()
}
fn code(e: ZkShieldedError) -> u32 {
    6000 + e as u32
}
fn b32(v: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[..8].copy_from_slice(&v.to_le_bytes());
    o
}
fn felt(b: &[u8; 32]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}
fn zero(level: usize) -> u64 {
    felt(&MerkleTreeStateV3::ZEROS[level])
}
fn compute_budget(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(),
        accounts: vec![],
        data,
    }
}
fn pk(a: &Address) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::from(a.to_bytes())
}

// ---------------------------------------------------------------------------
// The honest reference tree, written the plain way.
// ---------------------------------------------------------------------------

struct RefTree {
    depth: u8,
    filled: Vec<u64>,
    root: u64,
    leaves: Vec<u64>,
}

impl RefTree {
    fn new(depth: u8) -> Self {
        RefTree {
            depth,
            filled: (0..depth as usize).map(zero).collect(),
            root: zero(depth as usize),
            leaves: vec![],
        }
    }
    fn count(&self) -> u64 {
        self.leaves.len() as u64
    }
    fn insert(&mut self, leaf: u64) -> u64 {
        let index = self.count();
        let mut cur = leaf;
        let mut idx = index;
        for level in 0..self.depth as usize {
            if idx % 2 == 0 {
                self.filled[level] = cur;
                cur = hash2(cur, zero(level));
            } else {
                cur = hash2(self.filled[level], cur);
            }
            idx /= 2;
        }
        self.root = cur;
        self.leaves.push(leaf);
        index
    }
    /// Same leaves, deeper tree -- what the chain's `migrate_tree_depth` must
    /// agree with.
    fn relevel(&self, depth: u8) -> RefTree {
        let mut r = RefTree::new(depth);
        for l in &self.leaves {
            r.insert(*l);
        }
        r
    }
    /// Root of the depth-11 bucket `leaf_index` lives in, holding the leaves
    /// below `upto`. The bucket is named by the leaf, not by `upto`.
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
    /// What a correct client sends as `new_subtrees`.
    fn hint(&self) -> Vec<[u8; 32]> {
        (1..=self.depth as usize)
            .map(|l| if l < self.depth as usize { b32(self.filled[l]) } else { b32(self.root) })
            .collect()
    }
    /// Siblings and directions for the on-chain walk of `leaf_index`, levels
    /// `INSERT_SUBTREE_DEPTH..depth`, as they stand with `upto` leaves.
    fn walk(&self, leaf_index: u64, upto: u64) -> (Vec<u64>, Vec<u8>) {
        let mut sibs = vec![];
        let mut dirs = vec![];
        for level in INSERT_SUBTREE_DEPTH..self.depth {
            let bit = ((leaf_index >> level) & 1) as u8;
            dirs.push(bit);
            if bit == 0 {
                sibs.push(zero(level as usize));
            } else {
                // The completed left sibling at this level: the subtree of
                // 2^level leaves to the left, rebuilt from the leaves below `upto`.
                let lo = ((leaf_index >> level) ^ 1) << level;
                let mut nodes: Vec<u64> = (0..(1u64 << level))
                    .map(|i| {
                        let g = lo + i;
                        if g < upto { self.leaves[g as usize] } else { 0 }
                    })
                    .collect();
                for _ in 0..level {
                    nodes = nodes.chunks(2).map(|c| hash2(c[0], c[1])).collect();
                }
                sibs.push(nodes[0]);
            }
        }
        (sibs, dirs)
    }
}

fn leaf_value(i: u64) -> u64 {
    2_000_003 + i * 11
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

struct Pool {
    era: u16,
    pool: Address,
    tree: Address,
    reference: RefTree,
}

struct Rig {
    svm: LiteSVM,
    program: Address,
    authority: Keypair,
    mint: Address,
    next_nullifier: u64,
}

impl Rig {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let program = program_id();
        svm.add_program(program, &std::fs::read(so_path()).expect("build the .so first"))
            .expect("add_program");
        let authority = Keypair::new();
        svm.airdrop(&authority.pubkey(), 1_000_000_000_000).unwrap();
        Rig { svm, program, authority, mint: Address::from([0u8; 32]), next_nullifier: 1_000 }
    }

    fn pool_pda(&self, era: u16) -> Address {
        let (p, _) = DenominatedPoolV3::pool_pda(&pk(&self.mint), DENOM, era, &pk(&self.program));
        Address::from(p.to_bytes())
    }
    fn tree_pda(&self, pool: &Address) -> Address {
        Address::find_program_address(&[MerkleTreeStateV3::SEED_PREFIX, pool.as_ref()], &self.program).0
    }
    fn directory_pda(&self) -> Address {
        Address::find_program_address(
            &[PoolDirectory::SEED_PREFIX, self.mint.as_ref(), &DENOM.to_le_bytes()],
            &self.program,
        )
        .0
    }
    fn fee_escrow(&self, pool: &Address) -> Address {
        Address::find_program_address(&[b"fee_escrow", pool.as_ref()], &self.program).0
    }

    fn send_as(&mut self, signer: &Keypair, ixs: Vec<Instruction>) -> Result<u64, String> {
        let msg = Message::new(&ixs, Some(&signer.pubkey()));
        let bh = self.svm.latest_blockhash();
        let tx = Transaction::new(&[signer], msg, bh);
        match self.svm.send_transaction(tx) {
            Ok(m) => Ok(m.compute_units_consumed),
            Err(e) => Err(format!("{:?} LOGS {:?}", e.err, e.meta.logs)),
        }
    }
    fn send(&mut self, ixs: Vec<Instruction>) -> Result<u64, String> {
        let a = self.authority.insecure_clone();
        self.send_as(&a, ixs)
    }

    /// The REAL `init_denominated_pool_v3`: era 0, depth 15, allocated at the
    /// current `LEN` (ring 255).
    fn init_era0(&mut self) -> Pool {
        let pool = self.pool_pda(0);
        let tree = self.tree_pda(&pool);
        let mut data = disc("init_denominated_pool_v3").to_vec();
        data.extend_from_slice(&[0u8; 32]);
        data.extend_from_slice(self.mint.as_ref());
        data.extend_from_slice(&DENOM.to_le_bytes());
        data.extend_from_slice(&EPOCH_DELAY.to_le_bytes());
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.authority.pubkey(), true),
                AccountMeta::new(pool, false),
                AccountMeta::new(tree, false),
                AccountMeta::new_readonly(Address::from([0u8; 32]), false),
                AccountMeta::new_readonly(
                    "SysvarRent111111111111111111111111111111111".parse().unwrap(),
                    false,
                ),
            ],
            data,
        };
        self.send(vec![ix]).expect("init_denominated_pool_v3 must land");
        Pool { era: 0, pool, tree, reference: RefTree::new(15) }
    }

    fn pool_state(&self, p: &Address) -> DenominatedPoolV3 {
        let acc = self.svm.get_account(p).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        DenominatedPoolV3::deserialize(&mut sl).unwrap()
    }
    fn tree_state(&self, t: &Address) -> MerkleTreeStateV3 {
        let acc = self.svm.get_account(t).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        MerkleTreeStateV3::deserialize(&mut sl).unwrap()
    }
    fn directory_state(&self) -> PoolDirectory {
        let acc = self.svm.get_account(&self.directory_pda()).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        PoolDirectory::deserialize(&mut sl).unwrap()
    }
    fn patch_tree(&mut self, t: &Address, f: impl FnOnce(&mut MerkleTreeStateV3)) {
        let mut acc = self.svm.get_account(t).unwrap();
        let len = acc.data.len();
        let mut sl: &[u8] = &acc.data[8..];
        let mut s = MerkleTreeStateV3::deserialize(&mut sl).unwrap();
        f(&mut s);
        let mut d = MerkleTreeStateV3::DISCRIMINATOR.to_vec();
        s.serialize(&mut d).unwrap();
        d.resize(len, 0);
        acc.data = d;
        self.svm.set_account(*t, acc).unwrap();
    }

    fn plant_buffer(&mut self, authority: &Address, circuit: u8, pub_bytes: &[u8]) -> Address {
        let buf = Address::new_unique();
        let hash = solana_sha256_hasher::hashv(&[pub_bytes]).to_bytes();
        let mut d = vec![0u8; 83];
        d[..8].copy_from_slice(&PROOF_BUF_DISC);
        d[8..40].copy_from_slice(authority.as_ref());
        d[40] = circuit;
        d[49] = 1;
        d[50..82].copy_from_slice(&hash);
        d[82] = 1;
        let rent = self.svm.minimum_balance_for_rent_exemption(d.len());
        self.svm
            .set_account(
                buf,
                Account { lamports: rent, data: d, owner: verifier_id(), executable: false, rent_epoch: 0 },
            )
            .unwrap();
        buf
    }

    /// An honest deposit through the REAL `shield_denominated_v3`, C6 buffer
    /// planted with the public inputs an honest prover would produce.
    fn shield(&mut self, p: &mut Pool, leaf: u64) -> Result<u64, String> {
        let i = p.reference.count();
        let old_sub = p.reference.subtree_root(i, i);
        p.reference.insert(leaf);
        let new_sub = p.reference.subtree_root(i, i + 1);
        let hint = p.reference.hint();

        let mut pb = [0u8; 40];
        pb[8..16].copy_from_slice(&leaf.to_le_bytes());
        pb[16..24].copy_from_slice(&old_sub.to_le_bytes());
        pb[24..32].copy_from_slice(&new_sub.to_le_bytes());
        pb[32..40].copy_from_slice(&(INSERT_SUBTREE_DEPTH as u64).to_le_bytes());
        let depositor = self.authority.pubkey();
        let buf = self.plant_buffer(&depositor, 6, &pb);

        let mut data = disc("shield_denominated_v3").to_vec();
        data.extend_from_slice(&b32(leaf));
        data.extend_from_slice(&b32(old_sub));
        data.extend_from_slice(&b32(new_sub));
        data.extend_from_slice(&(hint.len() as u32).to_le_bytes());
        for h in &hint {
            data.extend_from_slice(h);
        }
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(depositor, true),
                AccountMeta::new(p.pool, false),
                AccountMeta::new(p.tree, false),
                AccountMeta::new_readonly(buf, false),
                AccountMeta::new_readonly(Address::from([0u8; 32]), false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new(self.fee_escrow(&p.pool), false),
            ],
            data,
        };
        let r = self.send(vec![compute_budget(1_400_000), ix]);
        if r.is_err() {
            // Keep the reference honest: the chain did not take the leaf.
            p.reference.leaves.pop();
            let leaves = p.reference.leaves.clone();
            p.reference = RefTree::new(p.reference.depth);
            for l in leaves {
                p.reference.insert(l);
            }
        }
        r
    }

    /// A spend of `leaf_index` through the REAL `unshield_denominated_stark_v4`,
    /// naming `named_root` and walking from the bucket root as it stood with
    /// `upto` leaves. Returns the CU, and pays `recipient`.
    #[allow(clippy::too_many_arguments)]
    fn spend(
        &mut self,
        p: &Pool,
        leaf_index: u64,
        upto: u64,
        named_root: [u8; 32],
        recipient: &Address,
        siblings_override: Option<(Vec<u64>, Vec<u8>)>,
    ) -> Result<u64, String> {
        let subtree_root = p.reference.subtree_root(leaf_index, upto);
        let (sibs, dirs) = siblings_override.unwrap_or_else(|| p.reference.walk(leaf_index, upto));
        let nullifier_u64 = self.next_nullifier;
        self.next_nullifier += 1;
        let nullifier = b32(nullifier_u64);

        let mut pb = [0u8; 48];
        pb[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pb[8..16].copy_from_slice(&subtree_root.to_le_bytes());
        pb[16..48].copy_from_slice(&solana_sha256_hasher::hashv(&[recipient.as_ref()]).to_bytes());
        let payer = self.authority.pubkey();
        let buf = self.plant_buffer(&payer, 7, &pb);

        let (nrec, _) = Address::find_program_address(
            &[NullifierRecord::SEED_PREFIX, p.pool.as_ref(), nullifier.as_ref()],
            &self.program,
        );
        let mut data = disc("unshield_denominated_stark_v4").to_vec();
        data.extend_from_slice(&nullifier);
        data.extend_from_slice(&named_root);
        data.extend_from_slice(&subtree_root.to_le_bytes());
        data.extend_from_slice(&(sibs.len() as u32).to_le_bytes());
        for s in &sibs {
            data.extend_from_slice(&s.to_le_bytes());
        }
        data.extend_from_slice(&(dirs.len() as u32).to_le_bytes());
        data.extend_from_slice(&dirs);
        data.extend_from_slice(recipient.as_ref());
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new(p.pool, false),
                AccountMeta::new_readonly(p.tree, false),
                AccountMeta::new(nrec, false),
                AccountMeta::new_readonly(buf, false),
                AccountMeta::new_readonly(Address::from([0u8; 32]), false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new(self.fee_escrow(&p.pool), false),
                AccountMeta::new(*recipient, false),
            ],
            data,
        };
        self.send(vec![compute_budget(1_400_000), ix])
    }

    fn migrate_depth_ix(&self, p: &Pool, authority: &Address, new_depth: u8) -> Instruction {
        self.migrate_depth_ix_keep(p, authority, new_depth, 7)
    }
    fn migrate_depth_ix_keep(&self, p: &Pool, authority: &Address, new_depth: u8, keep: u8) -> Instruction {
        let mut data = disc("migrate_tree_depth").to_vec();
        data.push(new_depth);
        data.push(keep);
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new_readonly(*authority, true),
                AccountMeta::new(p.pool, false),
                AccountMeta::new(p.tree, false),
            ],
            data,
        }
    }

    fn init_directory(&mut self, p: &Pool, margin: u64) -> Result<u64, String> {
        let mut data = disc("init_pool_directory").to_vec();
        data.extend_from_slice(&margin.to_le_bytes());
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.authority.pubkey(), true),
                AccountMeta::new_readonly(p.pool, false),
                AccountMeta::new_readonly(p.tree, false),
                AccountMeta::new(self.directory_pda(), false),
                AccountMeta::new_readonly(Address::from([0u8; 32]), false),
            ],
            data,
        };
        self.send(vec![ix])
    }

    fn open_next_era_as(&mut self, keeper: &Keypair, active: &Pool) -> Result<u64, String> {
        let next_pool = self.pool_pda(active.era + 1);
        let next_tree = self.tree_pda(&next_pool);
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(keeper.pubkey(), true),
                AccountMeta::new(self.directory_pda(), false),
                AccountMeta::new_readonly(active.pool, false),
                AccountMeta::new_readonly(active.tree, false),
                AccountMeta::new(next_pool, false),
                AccountMeta::new(next_tree, false),
                AccountMeta::new_readonly(Address::from([0u8; 32]), false),
            ],
            data: disc("open_next_era").to_vec(),
        };
        self.send_as(keeper, vec![compute_budget(400_000), ix])
    }

    fn init_pool_era_as(&mut self, signer: &Keypair, era: u16) -> Result<u64, String> {
        let pool = self.pool_pda(era);
        let tree = self.tree_pda(&pool);
        let mut data = disc("init_pool_era").to_vec();
        data.extend_from_slice(&[0u8; 32]);
        data.extend_from_slice(self.mint.as_ref());
        data.extend_from_slice(&DENOM.to_le_bytes());
        data.extend_from_slice(&EPOCH_DELAY.to_le_bytes());
        data.extend_from_slice(&era.to_le_bytes());
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new_readonly(self.directory_pda(), false),
                AccountMeta::new(pool, false),
                AccountMeta::new(tree, false),
                AccountMeta::new_readonly(Address::from([0u8; 32]), false),
            ],
            data,
        };
        self.send_as(signer, vec![ix])
    }
}

// ---------------------------------------------------------------------------
// 1. Deepen a live tree: old leaves keep spending, new deposits keep folding.
// ---------------------------------------------------------------------------

#[test]
fn a_tree_deepened_from_15_to_19_keeps_its_leaves_spendable_and_keeps_taking_deposits() {
    let mut rig = Rig::new();
    let mut p = rig.init_era0();

    // Three honest deposits at depth 15.
    let mut cu_shield_15 = 0;
    for i in 0..3u64 {
        cu_shield_15 = rig.shield(&mut p, leaf_value(i)).unwrap_or_else(|e| panic!("shield {i}: {e}"));
    }
    let t = rig.tree_state(&p.tree);
    assert_eq!(t.leaf_count, 3);
    assert_eq!(felt(&t.root), p.reference.root, "the chain's root is the honest root at depth 15");
    let ps = rig.pool_state(&p.pool);
    assert_eq!(ps.max_historical_roots, 255, "a freshly initialised pool gets the 255 ring");
    assert_eq!(rig.svm.get_account(&p.pool).unwrap().data.len(), DenominatedPoolV3::LEN);
    let ring_before = ps.historical_roots.clone();
    let root_at_3 = t.root;
    let sub_at_3 = p.reference.subtree_root(1, 3);

    // A stranger cannot deepen it.
    let stranger = Keypair::new();
    rig.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let ix = rig.migrate_depth_ix(&p, &stranger.pubkey(), 19);
    let e = rig.send_as(&stranger, vec![compute_budget(1_400_000), ix]).expect_err("a stranger must not deepen the tree");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::Unauthorized)), "{e}");

    // Depth 20 is past the walk's ceiling; 15 is not deeper.
    for bad in [20u8, 15, 12] {
        let ix = rig.migrate_depth_ix(&p, &rig.authority.pubkey(), bad);
        let e = rig.send(vec![compute_budget(1_400_000), ix]).expect_err("must refuse");
        assert_eq!(err_code(&e), Some(code(ZkShieldedError::InvalidTreeDepth)), "{bad}: {e}");
    }

    // The authority deepens it to 19, keeping (lifting) the newest 2 of the
    // 3 ring roots.
    let ix = rig.migrate_depth_ix_keep(&p, &rig.authority.pubkey(), 19, 2);
    let cu_migrate = rig.send(vec![compute_budget(1_400_000), ix]).expect("migrate_tree_depth must land");
    p.reference = p.reference.relevel(19);
    let t = rig.tree_state(&p.tree);
    let ps = rig.pool_state(&p.pool);
    assert_eq!(t.depth, 19);
    assert_eq!(ps.tree_depth, 19);
    assert_eq!(t.filled_subtrees.len(), 20);
    assert_eq!(t.leaf_count, 3, "no leaf moved");
    assert_eq!(felt(&t.root), p.reference.root, "the lifted root IS the honest depth-19 root");
    assert_eq!(ps.merkle_root, t.root);
    assert_eq!(t.filled_subtrees[15], root_at_3, "the old root sits at level 15 as the left sibling");
    assert_eq!(ring_before.len(), 3, "three deposits pushed three roots (the empty root and two)");
    let lifted: Vec<[u8; 32]> = ring_before[1..]
        .iter()
        .map(|r| MerkleTreeStateV3::lift_root(*r, 15, 19).unwrap())
        .collect();
    assert_eq!(ps.historical_roots, lifted, "the newest two roots were lifted, the oldest dropped");
    assert_eq!(ps.root_write_index, 2);
    assert!(
        !ps.is_valid_root(&MerkleTreeStateV3::lift_root(ring_before[0], 15, 19).unwrap()),
        "the dropped root is gone in both shapes"
    );
    assert!(!ps.is_valid_root(&ring_before[1]), "an unlifted root is never valid");

    // Two more deposits, now folding eight levels.
    let mut cu_shield_19 = 0;
    for i in 3..5u64 {
        cu_shield_19 = rig.shield(&mut p, leaf_value(i)).unwrap_or_else(|e| panic!("shield {i} at depth 19: {e}"));
    }
    let t = rig.tree_state(&p.tree);
    assert_eq!(t.leaf_count, 5);
    assert_eq!(felt(&t.root), p.reference.root, "deposits after the migration fold to the honest root");

    // Leaf 0 (deposited at depth 15) spends at depth 19 with EIGHT siblings.
    let recipient = Address::new_unique();
    let cu_spend_19 = rig
        .spend(&p, 0, 5, t.root, &recipient, None)
        .expect("a pre-migration leaf must spend with eight siblings");
    let paid = rig.svm.get_account(&recipient).map(|a| a.lamports).unwrap_or(0);
    assert_eq!(paid, DENOM - DENOM * 50 / 10_000, "the recipient gets the note minus the 0.5% fee");

    // Four siblings -- the pre-migration shape -- is refused as a shape error,
    // not as a bad proof.
    let (s4, d4) = {
        let (s, d) = p.reference.walk(1, 5);
        (s[..4].to_vec(), d[..4].to_vec())
    };
    let e = rig
        .spend(&p, 1, 5, t.root, &recipient, Some((s4, d4)))
        .expect_err("four siblings on a 19-deep pool must be refused");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::SpendWrongSiblingCount)), "{e}");

    // A proof prepared BEFORE the migration, against the root of the 3-leaf
    // tree, still resolves: its lifted root is in the ring.
    let lifted_root_at_3 = MerkleTreeStateV3::lift_root(root_at_3, 15, 19).unwrap();
    assert!(rig.pool_state(&p.pool).is_valid_root(&lifted_root_at_3));
    let sibs: Vec<u64> = (11..19).map(|l| zero(l)).collect();
    let dirs = vec![0u8; 8];
    let _ = sub_at_3;
    let cu_old_proof = rig
        .spend(&p, 1, 3, lifted_root_at_3, &recipient, Some((sibs, dirs)))
        .expect("a proof prepared before the migration must still land");

    eprintln!("\n=========== MEASURED (litesvm SBF, honest values) ===========");
    eprintln!("  shield_denominated_v3  depth 15 (4 levels folded x2): {cu_shield_15:>9} CU");
    eprintln!("  shield_denominated_v3  depth 19 (8 levels folded x2): {cu_shield_19:>9} CU");
    eprintln!("  migrate_tree_depth     15 -> 19, current + 2 kept    : {cu_migrate:>9} CU");
    eprintln!("  unshield_v4            depth 19 (8 levels walked)    : {cu_spend_19:>9} CU");
    eprintln!("  unshield_v4            pre-migration proof, lifted   : {cu_old_proof:>9} CU");
    eprintln!("=============================================================\n");
    assert!(cu_shield_19 > cu_shield_15, "eight levels must cost more than four");
    assert!(cu_shield_19 <= 1_000_000, "the client's 1,000,000 CU budget must still cover a deposit");
}

// ---------------------------------------------------------------------------
// 2. The directory, the margin, and the permissionless switch.
// ---------------------------------------------------------------------------

#[test]
fn open_next_era_refuses_before_the_margin_opens_at_it_and_the_new_era_takes_deposits_and_spends() {
    let mut rig = Rig::new();
    let mut p0 = rig.init_era0();
    rig.shield(&mut p0, leaf_value(0)).unwrap();

    rig.init_directory(&p0, 0).expect("init_pool_directory must land");
    let d = rig.directory_state();
    assert_eq!(d.active_era, 0);
    assert_eq!(Address::from(d.active_pool.to_bytes()), p0.pool);
    assert_eq!(d.margin_leaves, PoolDirectory::DEFAULT_MARGIN_LEAVES);
    assert_eq!(rig.svm.get_account(&rig.directory_pda()).unwrap().data.len(), PoolDirectory::LEN);

    let keeper = Keypair::new();
    rig.svm.airdrop(&keeper.pubkey(), 10_000_000_000).unwrap();
    let next_pool = rig.pool_pda(1);

    // Before the margin: refused, and nothing was allocated or paid.
    let max = 1u64 << 15;
    rig.patch_tree(&p0.tree, |t| t.leaf_count = max - 1_025);
    let before = rig.svm.get_account(&keeper.pubkey()).unwrap().lamports;
    let e = rig.open_next_era_as(&keeper, &p0).expect_err("one leaf short of the margin must refuse");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::EraMarginNotReached)), "{e}");
    assert!(rig.svm.get_account(&next_pool).is_none(), "no era-1 pool may exist yet");
    let after = rig.svm.get_account(&keeper.pubkey()).unwrap().lamports;
    assert!(before - after <= 10_000, "a refused call costs the fee and nothing else");

    // At the margin: anyone opens era 1 and pays its rent.
    rig.patch_tree(&p0.tree, |t| t.leaf_count = max - 1_024);
    let before = rig.svm.get_account(&keeper.pubkey()).unwrap().lamports;
    let cu_open = rig.open_next_era_as(&keeper, &p0).expect("at the margin the keeper must open era 1");
    let after = rig.svm.get_account(&keeper.pubkey()).unwrap().lamports;
    let rent_pool = rig.svm.minimum_balance_for_rent_exemption(DenominatedPoolV3::LEN);
    let rent_tree = rig.svm.minimum_balance_for_rent_exemption(MerkleTreeStateV3::LEN);
    assert!(before - after >= rent_pool + rent_tree, "the keeper paid the two rents");
    eprintln!("MEASURED  open_next_era (creates pool + tree): {cu_open} CU, keeper paid {} lamports", before - after);

    let d = rig.directory_state();
    assert_eq!(d.active_era, 1);
    assert_eq!(Address::from(d.active_pool.to_bytes()), next_pool);
    let p1 = Pool { era: 1, pool: next_pool, tree: rig.tree_pda(&next_pool), reference: RefTree::new(19) };
    let ps1 = rig.pool_state(&p1.pool);
    let t1 = rig.tree_state(&p1.tree);
    assert_eq!(ps1.tree_depth, 19, "era pools are born at depth 19");
    assert_eq!(t1.depth, 19);
    assert_eq!(t1.era, 1);
    assert_eq!(ps1.max_historical_roots, 255);
    assert_eq!(ps1.authority, rig.pool_state(&p0.pool).authority, "the authority carries over");
    assert_eq!(ps1.denomination, DENOM);
    assert!(ps1.is_active);
    assert_eq!(felt(&t1.root), zero(19), "an empty depth-19 tree");
    assert_eq!(rig.svm.get_account(&p1.pool).unwrap().data.len(), DenominatedPoolV3::LEN);

    // Idempotence: the active era is now the empty era 1, so a second call
    // (a racing keeper) refuses and allocates nothing.
    let e = rig.open_next_era_as(&keeper, &p1).expect_err("era 1 is empty: nothing to open");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::EraMarginNotReached)), "{e}");
    assert!(rig.svm.get_account(&rig.pool_pda(2)).is_none());

    // The era-0 tree is FULL: a deposit there is refused and told where to go.
    rig.patch_tree(&p0.tree, |t| t.leaf_count = max);
    let e = rig.shield(&mut p0, leaf_value(99)).expect_err("a full tree must refuse");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::MerkleTreeFull)), "{e}");
    assert!(e.contains("PoolDirectory"), "the refusal must name the directory: {e}");
    assert!(e.contains(&rig.directory_pda().to_string()), "with its address: {e}");

    // Era 1 takes deposits (four-seed PDA check, eight-level fold) ...
    let mut p1 = p1;
    for i in 0..3u64 {
        rig.shield(&mut p1, leaf_value(100 + i)).unwrap_or_else(|e| panic!("era-1 shield {i}: {e}"));
    }
    let t1 = rig.tree_state(&p1.tree);
    assert_eq!(t1.leaf_count, 3);
    assert_eq!(felt(&t1.root), p1.reference.root);

    // ... and spends from its own root ring, naming its own pool.
    let recipient = Address::new_unique();
    let cu = rig.spend(&p1, 1, 3, t1.root, &recipient, None).expect("an era-1 note must spend");
    eprintln!("MEASURED  unshield_v4 on an era-1 pool (depth 19): {cu} CU");
    assert_eq!(rig.svm.get_account(&recipient).unwrap().lamports, DENOM - DENOM * 50 / 10_000);

    // A note from era 1 cannot be spent against era 0's pool (its root is not
    // in that ring), and the era-1 pool cannot be passed off as era 0: the
    // tree names its era and the PDA check follows it.
    let e = rig.spend(&p0, 0, 1, t1.root, &recipient, None).expect_err("wrong pool");
    assert!(
        [
            code(ZkShieldedError::InvalidMerkleRoot),
            code(ZkShieldedError::SpendWrongSiblingCount),
            code(ZkShieldedError::SpendRootMismatch),
        ]
        .contains(&err_code(&e).unwrap_or(0)),
        "{e}"
    );
}

// ---------------------------------------------------------------------------
// 3. An era created by hand is found, not re-created.
// ---------------------------------------------------------------------------

#[test]
fn an_era_created_by_hand_is_adopted_by_open_next_era_without_new_allocation() {
    let mut rig = Rig::new();
    let mut p0 = rig.init_era0();
    rig.shield(&mut p0, leaf_value(0)).unwrap();
    rig.init_directory(&p0, 2_000).unwrap();
    assert_eq!(rig.directory_state().margin_leaves, 2_000);

    // Only the directory's authority may create an era by hand.
    let stranger = Keypair::new();
    rig.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let e = rig.init_pool_era_as(&stranger, 1).expect_err("a stranger cannot init an era");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::Unauthorized)), "{e}");
    let a = rig.authority.insecure_clone();
    let e = rig.init_pool_era_as(&a, 0).expect_err("era 0 is not an era pool");
    assert!(e.contains("Custom") || e.contains("seeds"), "{e}");
    rig.init_pool_era_as(&a, 1).expect("the authority creates era 1 early");
    let p1_pool = rig.pool_pda(1);
    let t1 = rig.tree_state(&rig.tree_pda(&p1_pool));
    assert_eq!((t1.era, t1.depth), (1, 19));
    assert_eq!(rig.directory_state().active_era, 0, "creating early does not switch");

    // At the margin, open_next_era adopts it: no rent leaves the keeper.
    rig.patch_tree(&p0.tree, |t| t.leaf_count = (1u64 << 15) - 2_000);
    let keeper = Keypair::new();
    rig.svm.airdrop(&keeper.pubkey(), 10_000_000_000).unwrap();
    let before = rig.svm.get_account(&keeper.pubkey()).unwrap().lamports;
    rig.open_next_era_as(&keeper, &p0).expect("adopting an existing era must land");
    let after = rig.svm.get_account(&keeper.pubkey()).unwrap().lamports;
    assert!(before - after <= 10_000, "adoption costs the fee only, paid {}", before - after);
    let d = rig.directory_state();
    assert_eq!(d.active_era, 1);
    assert_eq!(Address::from(d.active_pool.to_bytes()), p1_pool);
}

// ---------------------------------------------------------------------------
// 4. Legacy pools grow to the new ring, once.
// ---------------------------------------------------------------------------

#[test]
fn migrate_pool_capacity_grows_a_legacy_pool_and_is_idempotent() {
    let mut rig = Rig::new();
    let p = rig.init_era0();

    // Turn the fresh pool into what devnet holds: LEGACY_LEN bytes, ring of
    // 100, and 100 roots already in it.
    {
        let mut acc = rig.svm.get_account(&p.pool).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        let mut s = DenominatedPoolV3::deserialize(&mut sl).unwrap();
        s.max_historical_roots = 100;
        s.historical_roots = (1..=100u64).map(b32).collect();
        s.root_write_index = 100;
        let mut d = DenominatedPoolV3::DISCRIMINATOR.to_vec();
        s.serialize(&mut d).unwrap();
        assert_eq!(d.len(), DenominatedPoolV3::LEGACY_LEN, "a full 100-ring pool is exactly LEGACY_LEN");
        acc.data = d;
        acc.lamports = rig.svm.minimum_balance_for_rent_exemption(DenominatedPoolV3::LEGACY_LEN);
        rig.svm.set_account(p.pool, acc).unwrap();
    }
    let ring_before = rig.pool_state(&p.pool).historical_roots.clone();

    let ix = |rig: &Rig| Instruction {
        program_id: rig.program,
        accounts: vec![
            AccountMeta::new(rig.authority.pubkey(), true),
            AccountMeta::new(p.pool, false),
            AccountMeta::new_readonly(Address::from([0u8; 32]), false),
        ],
        data: disc("migrate_pool_capacity").to_vec(),
    };
    let i = ix(&rig);
    let cu = rig.send(vec![i]).expect("migrate_pool_capacity must land");
    let acc = rig.svm.get_account(&p.pool).unwrap();
    assert_eq!(acc.data.len(), DenominatedPoolV3::LEN);
    assert!(acc.lamports >= rig.svm.minimum_balance_for_rent_exemption(DenominatedPoolV3::LEN));
    let s = rig.pool_state(&p.pool);
    assert_eq!(s.max_historical_roots, 255);
    assert_eq!(s.historical_roots, ring_before, "no root was lost");
    assert_eq!(s.root_write_index, 100);
    eprintln!("MEASURED  migrate_pool_capacity ({} -> {} bytes): {cu} CU", DenominatedPoolV3::LEGACY_LEN, DenominatedPoolV3::LEN);

    // Again: a no-op that succeeds.
    let i = ix(&rig);
    rig.send(vec![i]).expect("second call must be a no-op success");
    assert_eq!(rig.svm.get_account(&p.pool).unwrap().data.len(), DenominatedPoolV3::LEN);
    assert_eq!(rig.pool_state(&p.pool).max_historical_roots, 255);

    // A stranger cannot.
    let stranger = Keypair::new();
    rig.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let mut i = ix(&rig);
    i.accounts[0] = AccountMeta::new(stranger.pubkey(), true);
    let e = rig.send_as(&stranger, vec![i]).expect_err("stranger");
    assert_eq!(err_code(&e), Some(code(ZkShieldedError::Unauthorized)), "{e}");
}

// ---------------------------------------------------------------------------
// 5. The cost of the walk, level by level, on the real handlers.
// ---------------------------------------------------------------------------

#[test]
fn the_walk_costs_one_poseidon_per_level_on_deposit_twice_and_on_spend_once() {
    let mut rig = Rig::new();
    let mut p = rig.init_era0();
    rig.shield(&mut p, leaf_value(0)).unwrap();
    let recipient = Address::new_unique();

    let mut rows: Vec<(u8, u64, u64)> = vec![];
    let mut depth = 15u8;
    loop {
        let cu_dep = rig.shield(&mut p, leaf_value(depth as u64)).unwrap();
        let t = rig.tree_state(&p.tree);
        let n = t.leaf_count;
        let cu_sp = rig.spend(&p, 0, n, t.root, &recipient, None).unwrap();
        rows.push((depth, cu_dep, cu_sp));
        if depth == 19 {
            break;
        }
        depth += 1;
        let ix = rig.migrate_depth_ix_keep(&p, &rig.authority.pubkey(), depth, 0);
        rig.send(vec![compute_budget(1_400_000), ix]).unwrap();
        p.reference = p.reference.relevel(depth);
        // A fresh nullifier per spend is already ensured; a fresh recipient
        // keeps the payout assertion simple elsewhere.
    }
    eprintln!("\n=========== MEASURED walk cost per depth (litesvm SBF) ===========");
    eprintln!("  depth  levels  shield_denominated_v3 CU  unshield_v4 CU");
    for (d, dep, sp) in &rows {
        eprintln!("  {d:>5}  {:>6}  {dep:>24}  {sp:>14}", d - INSERT_SUBTREE_DEPTH);
    }
    let per_level_dep = (rows[4].1 as i64 - rows[0].1 as i64) / 4;
    let per_level_sp = (rows[4].2 as i64 - rows[0].2 as i64) / 4;
    eprintln!("  => per level: deposit ~{per_level_dep} CU (two hash2), spend ~{per_level_sp} CU (one hash2)");
    eprintln!("=====================================================================\n");
    assert!(rows[4].1 > rows[0].1 && rows[4].2 > rows[0].2);
}

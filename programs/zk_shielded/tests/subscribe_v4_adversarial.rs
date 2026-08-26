//! ADVERSARIAL PROBE for `subscribe_private_stark_v4` — executed, not argued.
//!
//! Everything here runs the REAL `target/deploy/zk_shielded.so` inside litesvm,
//! the same rig `subscription_lifecycle.rs` uses. Nothing is deployed and no
//! transaction leaves this machine.
//!
//! Why a forged proof buffer is legitimate here: the instruction's trust in the
//! buffer comes from `*c7_info.owner == STARK_VERIFIER_PROGRAM_ID`, and on a
//! real cluster only that program can write accounts it owns. Inside the VM we
//! can `set_account` one, which is what makes the REST of the handler — the
//! walk, the root ring, the digest, the vault write, the payout, the vault that
//! `claim_period` then has to read — executable at all. Every assertion below is
//! about that rest.
//!
//! The digest is recomputed here INDEPENDENTLY of the handler (the handler's
//! builder is private), so a disagreement between this file and the program is a
//! red test, not a silent pass.

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

use zk_shielded::state::spend_root;
use zk_shielded::state::{DenominatedPoolV3, MerkleTreeStateV3, NullifierRecord, SubscriptionVault};

const PROGRAM_ID: &str = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";
const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";
const PROOF_BUF_DISC: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];
const DOMAIN: &[u8] = b"P01:C7:SUBSCRIBE:v1";

const E_INVALID_PROOF: u32 = 6000;
const E_INVALID_MERKLE_ROOT: u32 = 6002;
const E_SPEND_ROOT_MISMATCH: u32 = 6060;
const E_SPEND_NON_CANONICAL_FELT: u32 = 6059;

const DENOM: u64 = 100_000_000; // 0.1 SOL
const TREE_DEPTH: u8 = 15;

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

/// The subscribe digest, rebuilt from the SPEC rather than from the program's
/// private builder.
fn subscribe_digest(
    vault: &Address,
    rate: u64,
    interval: u64,
    vk: &[u8; 32],
    license: &Option<[u8; 32]>,
) -> [u8; 32] {
    let mut lic = [0u8; 33];
    if let Some(v) = license {
        lic[0] = 1;
        lic[1..].copy_from_slice(v);
    }
    solana_sha256_hasher::hashv(&[
        DOMAIN,
        vault.as_ref(),
        &rate.to_le_bytes(),
        &interval.to_le_bytes(),
        vk,
        &lic,
    ])
    .to_bytes()
}

fn pub_bytes(nullifier_u64: u64, subtree_root: u64, digest: [u8; 32]) -> [u8; 48] {
    let mut b = [0u8; 48];
    b[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
    b[8..16].copy_from_slice(&subtree_root.to_le_bytes());
    b[16..48].copy_from_slice(&digest);
    b
}

struct Rig {
    svm: LiteSVM,
    program: Address,
    payer: Keypair,
    pool: Address,
    tree: Address,
    mint: Address,
    root32: [u8; 32],
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
}

impl Rig {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let program = program_id();
        svm.add_program(program, &std::fs::read(so_path()).expect("build the .so first"))
            .expect("add_program");

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

        // Native-SOL pool: token_mint == system program id.
        let mint = Address::from([0u8; 32]);
        let (pool, pool_bump) = Address::find_program_address(
            &[DenominatedPoolV3::SEED_PREFIX, mint.as_ref(), &DENOM.to_le_bytes()],
            &program,
        );
        let (tree, tree_bump) = Address::find_program_address(
            &[MerkleTreeStateV3::SEED_PREFIX, pool.as_ref()],
            &program,
        );

        // A root the pool "published", derived through the SAME walk the handler
        // runs, so the honest path is reachable at all.
        let subtree_root: u64 = 0x0123_4567_89ab_cdef;
        let siblings: Vec<u64> = vec![11, 22, 33];
        let directions: Vec<u8> = vec![0, 1, 0];
        let derived =
            spend_root::resolve_pool_root(subtree_root, &siblings, &directions, TREE_DEPTH).unwrap();
        let mut root32 = [0u8; 32];
        root32[..8].copy_from_slice(&derived.to_le_bytes());

        let pool_state = DenominatedPoolV3 {
            authority: anchor_lang::prelude::Pubkey::from(payer.pubkey().to_bytes()),
            token_mint: anchor_lang::prelude::Pubkey::from(mint.to_bytes()),
            denomination: DENOM,
            epoch_delay: 0,
            merkle_root: root32,
            tree_depth: TREE_DEPTH,
            next_leaf_index: 4,
            vk_hash: [0u8; 32],
            total_shielded: DENOM * 4,
            note_count: 4,
            is_active: true,
            historical_roots: vec![],
            max_historical_roots: DenominatedPoolV3::MAX_HISTORICAL_ROOTS,
            created_at: 0,
            last_tx_at: 0,
            bump: pool_bump,
            mature_note_count: 4,
            last_maturity_update_epoch: 0,
            epoch_note_counts: [0u64; 32],
            epoch_note_start: 0,
            vk_hash_transfer: [0u8; 32],
            vk_update_slot: 0,
            root_write_index: 1,
            vk_hash_escrow: [0u8; 32],
        };
        let mut pd = DenominatedPoolV3::DISCRIMINATOR.to_vec();
        pool_state.serialize(&mut pd).unwrap();
        pd.resize(DenominatedPoolV3::LEN, 0);
        let pool_rent = svm.minimum_balance_for_rent_exemption(pd.len());
        svm.set_account(
            pool,
            Account {
                lamports: pool_rent + DENOM * 4,
                data: pd,
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let tree_state = MerkleTreeStateV3 {
            pool: anchor_lang::prelude::Pubkey::from(pool.to_bytes()),
            root: root32,
            leaf_count: 4,
            depth: TREE_DEPTH,
            filled_subtrees: vec![[0u8; 32]; (TREE_DEPTH as usize) + 1],
            bump: tree_bump,
        };
        let mut td = MerkleTreeStateV3::DISCRIMINATOR.to_vec();
        tree_state.serialize(&mut td).unwrap();
        td.resize(MerkleTreeStateV3::LEN, 0);
        let tree_rent = svm.minimum_balance_for_rent_exemption(td.len());
        svm.set_account(
            tree,
            Account {
                lamports: tree_rent,
                data: td,
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        Rig { svm, program, payer, pool, tree, mint, root32, subtree_root, siblings, directions }
    }

    fn vault_pda(&self, retailer: &Address, commitment: &[u8; 32]) -> Address {
        Address::find_program_address(
            &[
                SubscriptionVault::SEED_PREFIX,
                retailer.as_ref(),
                commitment.as_ref(),
                self.mint.as_ref(),
            ],
            &self.program,
        )
        .0
    }

    /// Plant a buffer whose `public_inputs_hash` commits to `digest`.
    #[allow(clippy::too_many_arguments)]
    fn plant_buffer(
        &mut self,
        authority: &Address,
        circuit: u8,
        digest: [u8; 32],
        nullifier_u64: u64,
        subtree_root: u64,
        verified: bool,
        deep: bool,
    ) -> Address {
        let buf = Address::new_unique();
        let pb = pub_bytes(nullifier_u64, subtree_root, digest);
        let hash = solana_sha256_hasher::hashv(&[&pb]).to_bytes();
        let mut d = vec![0u8; 83];
        d[..8].copy_from_slice(&PROOF_BUF_DISC);
        d[8..40].copy_from_slice(authority.as_ref());
        d[40] = circuit;
        d[49] = verified as u8;
        d[50..82].copy_from_slice(&hash);
        d[82] = deep as u8;
        let rent = self.svm.minimum_balance_for_rent_exemption(d.len());
        self.svm
            .set_account(
                buf,
                Account {
                    lamports: rent,
                    data: d,
                    owner: verifier_id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        buf
    }

    fn pool_state(&self) -> DenominatedPoolV3 {
        let acc = self.svm.get_account(&self.pool).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        <DenominatedPoolV3 as AnchorDeserialize>::deserialize(&mut sl).unwrap()
    }
}

#[allow(clippy::too_many_arguments)]
fn subscribe_ix(
    rig: &Rig,
    retailer: &Address,
    vault: &Address,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    subtree_root: u64,
    siblings: &[u64],
    directions: &[u8],
    commitment: [u8; 32],
    rate: u64,
    interval: u64,
    vk: [u8; 32],
    license: Option<[u8; 32]>,
    buffer: &Address,
) -> Instruction {
    let (nrec, _) = Address::find_program_address(
        &[NullifierRecord::SEED_PREFIX, rig.pool.as_ref(), nullifier.as_ref()],
        &rig.program,
    );
    let mut data = disc("subscribe_private_stark_v4").to_vec();
    data.extend_from_slice(&nullifier);
    data.extend_from_slice(&merkle_root);
    data.extend_from_slice(&subtree_root.to_le_bytes());
    data.extend_from_slice(&(siblings.len() as u32).to_le_bytes());
    for s in siblings {
        data.extend_from_slice(&s.to_le_bytes());
    }
    data.extend_from_slice(&(directions.len() as u32).to_le_bytes());
    data.extend_from_slice(directions);
    data.extend_from_slice(&commitment);
    data.extend_from_slice(&rate.to_le_bytes());
    data.extend_from_slice(&interval.to_le_bytes());
    data.extend_from_slice(&vk);
    match license {
        Some(v) => {
            data.push(1);
            data.extend_from_slice(&v);
        }
        None => data.push(0),
    }

    Instruction {
        program_id: rig.program,
        accounts: vec![
            AccountMeta::new(rig.payer.pubkey(), true),
            AccountMeta::new_readonly(*retailer, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(rig.pool, false),
            AccountMeta::new_readonly(rig.tree, false),
            AccountMeta::new(nrec, false),
            AccountMeta::new_readonly(*buffer, false),
            AccountMeta::new_readonly(Address::from([0u8; 32]), false),
            // three absent optionals == the program's own id
            AccountMeta::new_readonly(rig.program, false),
            AccountMeta::new_readonly(rig.program, false),
            AccountMeta::new_readonly(rig.program, false),
        ],
        data,
    }
}

fn send(rig: &mut Rig, ix: Instruction) -> Result<u64, String> {
    let msg = Message::new(&[ix], Some(&rig.payer.pubkey()));
    let bh = rig.svm.latest_blockhash();
    let tx = Transaction::new(&[&rig.payer], msg, bh);
    match rig.svm.send_transaction(tx) {
        Ok(m) => Ok(m.compute_units_consumed),
        Err(e) => Err(format!("{:?}", e)),
    }
}

fn err_code(s: &str) -> Option<u32> {
    s.split("Custom(").nth(1)?.split(')').next()?.trim().parse().ok()
}

// ---------------------------------------------------------------------------
// The honest path — and the numbers the author marked ASSUMED
// ---------------------------------------------------------------------------

#[test]
fn a_correct_v4_subscribe_lands_and_the_vault_it_mints_is_readable() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [0xABu8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);

    let rate = DENOM / 4;
    let interval = 100u64;
    let vk = [0x33u8; 32];
    let license: Option<[u8; 32]> = None;
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&7_777_777u64.to_le_bytes());

    let digest = subscribe_digest(&vault, rate, interval, &vk, &license);
    let buf =
        rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 7_777_777, rig.subtree_root, true, true);

    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, rate, interval,
        vk, license, &buf,
    );
    let ix_len = ix.data.len();
    let pool_before = rig.svm.get_account(&rig.pool).unwrap().lamports;

    let cu = send(&mut rig, ix).expect("the honest v4 subscribe must land");

    eprintln!("MEASURED  compute units (litesvm, SOL leg, license=None) = {cu}");
    eprintln!("MEASURED  instruction data length (license=None, s=3)    = {ix_len}");
    eprintln!(
        "MEASURED  rent for a {}-byte vault (litesvm rent params)  = {}",
        SubscriptionVault::LEN,
        rig.svm.minimum_balance_for_rent_exemption(SubscriptionVault::LEN)
    );

    let pool_after = rig.svm.get_account(&rig.pool).unwrap().lamports;
    assert_eq!(pool_before - pool_after, DENOM, "the pool must pay exactly the denomination");

    let acc = rig.svm.get_account(&vault).unwrap();
    assert_eq!(acc.data.len(), SubscriptionVault::LEN, "v4 must only ever mint 361-byte vaults");
    let mut sl: &[u8] = &acc.data[8..];
    let v = <SubscriptionVault as AnchorDeserialize>::deserialize(&mut sl).expect("vault decodes");

    assert_eq!(v.subscriber_pubkey, None);
    assert_eq!(v.subscriber_commitment, Some(commitment));
    assert_eq!(v.retailer.to_bytes(), retailer.to_bytes());
    assert_eq!(v.token_mint.to_bytes(), [0u8; 32]);
    assert_eq!(v.total_deposited, DENOM, "no fee may be netted out of the envelope");
    assert_eq!(v.rate, rate);
    assert_eq!(v.interval_slots, interval);
    assert!(v.is_active, "a vault born inactive can never be claimed and its rent is stranded");
    assert!(!v.is_paused);
    assert_eq!(v.pause_slot, None);
    assert_eq!(v.total_paused_slots, 0);
    assert_eq!(v.claimed_periods, 0);
    assert_eq!(v.vk_hash_subscriber, vk);
    assert_eq!(v.source_pool.map(|p| p.to_bytes()), Some(rig.pool.to_bytes()));
    assert_eq!(v.client_stealth_meta, None);
    assert_eq!(v.license_commitment, None);

    // claim_period / pause / resume re-derive with `bump = vault.bump`.
    let redrv = Address::create_program_address(
        &[
            SubscriptionVault::SEED_PREFIX,
            v.retailer.as_ref(),
            v.subscriber_id_bytes().as_ref(),
            v.token_mint.as_ref(),
            &[v.bump],
        ],
        &rig.program,
    )
    .expect("the stored bump must re-derive the vault address");
    assert_eq!(redrv, vault, "claim_period / pause / resume could not find this vault");

    let rent = rig.svm.minimum_balance_for_rent_exemption(SubscriptionVault::LEN);
    assert_eq!(acc.lamports, rent + DENOM, "the vault must hold rent + the whole denomination");

    let (nrec, _) = Address::find_program_address(
        &[NullifierRecord::SEED_PREFIX, rig.pool.as_ref(), nullifier.as_ref()],
        &rig.program,
    );
    assert!(rig.svm.get_account(&nrec).map(|a| !a.data.is_empty()).unwrap_or(false));

    let p = rig.pool_state();
    assert_eq!(p.note_count, 3);
    assert_eq!(p.total_shielded, DENOM * 3);
}

/// `claim_period` on a vault THIS instruction created pays `rate`, not the
/// envelope. The v4 vault is not merely decodable — it is spendable.
#[test]
fn claim_period_drives_a_v4_minted_vault_one_period_at_a_time() {
    let mut rig = Rig::new();
    let retailer_kp = Keypair::new();
    let retailer = retailer_kp.pubkey();
    rig.svm.airdrop(&retailer, 10_000_000_000).unwrap();
    let commitment = [0x5Cu8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);

    let rate = DENOM / 4;
    let interval = 100u64;
    let vk = [0u8; 32];
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&424_242u64.to_le_bytes());

    let digest = subscribe_digest(&vault, rate, interval, &vk, &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 424_242, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, rate, interval,
        vk, None, &buf,
    );
    send(&mut rig, ix).expect("subscribe must land");

    // The handler wrote `start_slot = clock.slot`; read it back rather than
    // guessing, then step exactly one interval.
    let start = {
        let acc = rig.svm.get_account(&vault).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        <SubscriptionVault as AnchorDeserialize>::deserialize(&mut sl).unwrap().start_slot
    };
    rig.svm.warp_to_slot(start as u64 + interval);

    let claim = Instruction {
        program_id: rig.program,
        accounts: vec![
            AccountMeta::new(retailer, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(Address::from([0u8; 32]), false),
            AccountMeta::new_readonly(rig.program, false),
            AccountMeta::new_readonly(rig.program, false),
            AccountMeta::new_readonly(rig.program, false),
        ],
        data: disc("claim_period").to_vec(),
    };
    let before = rig.svm.get_account(&retailer).unwrap().lamports;
    let msg = Message::new(&[claim], Some(&retailer));
    let bh = rig.svm.latest_blockhash();
    let tx = Transaction::new(&[&retailer_kp], msg, bh);
    let meta = rig.svm.send_transaction(tx).expect("claim_period must read a v4 vault");
    let after = rig.svm.get_account(&retailer).unwrap().lamports;

    eprintln!("MEASURED  claim_period on a v4-minted vault: {} CU", meta.compute_units_consumed);
    assert!(after > before, "the retailer was not paid at all: {before} -> {after}");
    assert!(
        after - before <= rate,
        "claim_period paid MORE than one period out of a v4 vault: {}",
        after - before
    );

    let acc = rig.svm.get_account(&vault).unwrap();
    let mut sl: &[u8] = &acc.data[8..];
    let v = <SubscriptionVault as AnchorDeserialize>::deserialize(&mut sl).unwrap();
    assert_eq!(v.claimed_periods, 1, "exactly one period must have been credited");
}

// ---------------------------------------------------------------------------
// The attacks
// ---------------------------------------------------------------------------

/// A buffer proved for vault A cannot be spent into vault B.
#[test]
fn the_buffer_cannot_be_re_pointed_at_another_retailers_vault() {
    let mut rig = Rig::new();
    let honest_retailer = Address::new_unique();
    let attacker_retailer = Address::new_unique();
    let commitment = [1u8; 32];
    let honest_vault = rig.vault_pda(&honest_retailer, &commitment);
    let attacker_vault = rig.vault_pda(&attacker_retailer, &commitment);

    let rate = DENOM / 4;
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&1u64.to_le_bytes());
    let digest = subscribe_digest(&honest_vault, rate, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 1, rig.subtree_root, true, true);

    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &attacker_retailer, &attacker_vault, nullifier, rig.root32, sr, &sib, &dir,
        commitment, rate, 100, [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("a re-pointed payout must be refused");
    assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "got {e}");
}

/// 🚨 CORRECTION 2 OF THE SPEC, EXECUTED. Whoever lands the transaction must not
/// be able to choose the schedule.
#[test]
fn the_terms_cannot_be_rewritten_after_the_proof_was_made() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [2u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&2u64.to_le_bytes());

    // proved for a 4-period schedule
    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 2, rig.subtree_root, true, true);

    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    // landed with rate = denomination, interval = 1: the whole envelope, one slot later
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM, 1,
        [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("rate = denomination must be refused");
    assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "got {e}");
}

/// The domain tag, executed: a buffer whose four binding felts carry the
/// UNSHIELD digest shape (`sha256(destination)`) must not spend here.
#[test]
fn an_unshield_shaped_buffer_is_not_a_subscribe_buffer() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [3u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&3u64.to_le_bytes());

    let unshield_digest = solana_sha256_hasher::hashv(&[vault.as_ref()]).to_bytes();
    let buf =
        rig.plant_buffer(&rig.payer.pubkey(), 7, unshield_digest, 3, rig.subtree_root, true, true);

    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4, 100,
        [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("an unshield digest must not spend here");
    assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "got {e}");
}

/// 🚨 THE FUND-LOSS CASE. A self-built twelve-level subtree over an invented
/// leaf must not pay out — the `unshield` C5 defect, rebuilt.
#[test]
fn a_self_built_subtree_that_reaches_no_published_root_pays_nothing() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [4u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&4u64.to_le_bytes());

    let forged_subtree: u64 = 0xdead_beef_0000_0001;
    let sib: Vec<u64> = vec![1, 2, 3];
    let dir: Vec<u8> = vec![0, 0, 0];
    let derived = spend_root::resolve_pool_root(forged_subtree, &sib, &dir, TREE_DEPTH).unwrap();
    let mut forged_root = [0u8; 32];
    forged_root[..8].copy_from_slice(&derived.to_le_bytes());

    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 4, forged_subtree, true, true);

    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, forged_root, forged_subtree, &sib, &dir, commitment,
        DENOM / 4, 100, [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("a self-built subtree must not drain the pool");
    assert_eq!(err_code(&e), Some(E_INVALID_MERKLE_ROOT), "got {e}");
    assert_eq!(rig.pool_state().note_count, 4, "the pool moved on a refused spend");
}

/// Naming a published root over a path that does not reach it.
#[test]
fn a_published_root_cannot_be_named_over_a_path_that_does_not_reach_it() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [5u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&5u64.to_le_bytes());

    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 5, rig.subtree_root, true, true);

    let bad_sib: Vec<u64> = vec![99, 22, 33];
    let (sr, dir) = (rig.subtree_root, rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &bad_sib, &dir, commitment, DENOM / 4,
        100, [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("a mismatched walk must be refused");
    assert_eq!(err_code(&e), Some(E_SPEND_ROOT_MISMATCH), "got {e}");
}

/// The same note cannot be spent twice, and the record sits where v3's does.
#[test]
fn the_same_nullifier_cannot_open_a_second_vault() {
    let mut rig = Rig::new();
    let commitment_a = [6u8; 32];
    let commitment_b = [7u8; 32];
    let r_a = Address::new_unique();
    let r_b = Address::new_unique();
    let va = rig.vault_pda(&r_a, &commitment_a);
    let vb = rig.vault_pda(&r_b, &commitment_b);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&6u64.to_le_bytes());

    let d_a = subscribe_digest(&va, DENOM / 4, 100, &[0u8; 32], &None);
    let b_a = rig.plant_buffer(&rig.payer.pubkey(), 7, d_a, 6, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    {
        let ix = subscribe_ix(
            &rig, &r_a, &va, nullifier, rig.root32, sr, &sib, &dir, commitment_a, DENOM / 4, 100,
            [0u8; 32], None, &b_a,
        );
        send(&mut rig, ix)
    }
    .expect("first spend lands");

    let d_b = subscribe_digest(&vb, DENOM / 4, 100, &[0u8; 32], &None);
    let b_b = rig.plant_buffer(&rig.payer.pubkey(), 7, d_b, 6, rig.subtree_root, true, true);
    let e = {
        let ix = subscribe_ix(
            &rig, &r_b, &vb, nullifier, rig.root32, sr, &sib, &dir, commitment_b, DENOM / 4, 100,
            [0u8; 32], None, &b_b,
        );
        send(&mut rig, ix)
    }
    .expect_err("a second spend of one nullifier must be refused");
    eprintln!("double spend refused with: {e}");
    assert_eq!(rig.pool_state().note_count, 3, "the second spend moved pool value");
}

/// A non-canonical nullifier would be a second PDA for one proof.
#[test]
fn a_non_canonical_nullifier_is_refused() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [8u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&8u64.to_le_bytes());
    nullifier[31] = 1;

    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 8, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let e = {
        let ix = subscribe_ix(
            &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4,
            100, [0u8; 32], None, &buf,
        );
        send(&mut rig, ix)
    }
    .expect_err("a non-canonical nullifier must be refused");
    assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "got {e}");
}

/// 🚨 THE DOUBLE SPEND THE `nullifier[8..] == 0` CHECK ABOVE DOES NOT STOP.
///
/// `n` and `n + p` are ONE Goldilocks element and TWO 8-byte strings, so they
/// name one note and two `NullifierRecord` addresses. 2^64 - p = 2^32 - 1
/// exactly, so for every `n < 2^32 - 1` the alias still fits in eight bytes and
/// still passes the high-24-zero check.
///
/// On a real cluster the second proof is HONEST: the prover re-runs on the SAME
/// witness with public input 0 set to `n + p`, the trace is byte-identical
/// because the verifier reduces it (`Felt::new(v) = Felt(v % p)`), and only the
/// Fiat-Shamir seed moves. Nothing is forged. That is exactly what this rig
/// models -- the buffer is planted, so the second spend arrives with a
/// public-inputs hash that the handler itself reconstructs and accepts.
///
/// ⛔ MEASURED 2026-08-26: delete the `< poseidon_gl::MODULUS` require from
/// `subscribe_private_stark_v4::handler` and the second spend LANDS, the pool
/// pays a second denomination for one note, and this test goes red on
/// `expect_err`. It is the only test in the tree that distinguishes the two.
#[test]
fn one_field_element_cannot_be_spent_under_two_nullifier_encodings() {
    const P: u64 = 0xFFFF_FFFF_0000_0001;
    let mut rig = Rig::new();

    // Below 2^32 - 1, so the alias does not overflow a u64.
    let n: u64 = 4_294_967_294;
    let alias = n + P;
    assert!(alias > n, "n + p must still be an eight-byte value");
    assert_eq!(alias % P, n % P, "the two encodings must be ONE field element");

    let mut null_a = [0u8; 32];
    null_a[..8].copy_from_slice(&n.to_le_bytes());
    let mut null_b = [0u8; 32];
    null_b[..8].copy_from_slice(&alias.to_le_bytes());

    let rec_a = Address::find_program_address(
        &[NullifierRecord::SEED_PREFIX, rig.pool.as_ref(), null_a.as_ref()],
        &rig.program,
    )
    .0;
    let rec_b = Address::find_program_address(
        &[NullifierRecord::SEED_PREFIX, rig.pool.as_ref(), null_b.as_ref()],
        &rig.program,
    )
    .0;
    assert_ne!(rec_a, rec_b, "the whole attack: two record addresses for one field element");

    let rate = DENOM / 4;
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());

    // Spend one. Honest, canonical, lands.
    let r_a = Address::new_unique();
    let c_a = [0x11u8; 32];
    let v_a = rig.vault_pda(&r_a, &c_a);
    let d_a = subscribe_digest(&v_a, rate, 100, &[0u8; 32], &None);
    let b_a = rig.plant_buffer(&rig.payer.pubkey(), 7, d_a, n, sr, true, true);
    let ix_a = subscribe_ix(
        &rig, &r_a, &v_a, null_a, rig.root32, sr, &sib, &dir, c_a, rate, 100, [0u8; 32], None,
        &b_a,
    );
    send(&mut rig, ix_a).expect("the canonical spend must land");
    assert_eq!(rig.pool_state().note_count, 3);

    // Spend two: same note, same subtree, same everything -- only the ENCODING
    // of the nullifier differs, and with it the record address and the digest.
    let r_b = Address::new_unique();
    let c_b = [0x22u8; 32];
    let v_b = rig.vault_pda(&r_b, &c_b);
    let d_b = subscribe_digest(&v_b, rate, 100, &[0u8; 32], &None);
    let b_b = rig.plant_buffer(&rig.payer.pubkey(), 7, d_b, alias, sr, true, true);
    let ix_b = subscribe_ix(
        &rig, &r_b, &v_b, null_b, rig.root32, sr, &sib, &dir, c_b, rate, 100, [0u8; 32], None,
        &b_b,
    );
    let e = send(&mut rig, ix_b).expect_err(
        "the alias encoding spent the same note a second time: one deposit, two payouts",
    );
    assert_eq!(err_code(&e), Some(E_SPEND_NON_CANONICAL_FELT), "got {e}");

    assert_eq!(rig.pool_state().note_count, 3, "the alias spend moved pool value");
    assert_eq!(rig.pool_state().total_shielded, DENOM * 3);
    assert!(rig.svm.get_account(&rec_b).map(|a| a.data.is_empty()).unwrap_or(true));
}

/// The buffer is not transferable between keys.
#[test]
fn a_buffer_minted_under_another_key_cannot_be_spent_by_this_payer() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [9u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&9u64.to_le_bytes());

    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let stranger = Address::new_unique();
    let buf = rig.plant_buffer(&stranger, 7, digest, 9, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let e = {
        let ix = subscribe_ix(
            &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4,
            100, [0u8; 32], None, &buf,
        );
        send(&mut rig, ix)
    }
    .expect_err("a foreign buffer must be refused");
    assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "got {e}");
}

/// Phase 1 / phase 2 flags and the circuit id, each on its own.
#[test]
fn an_unverified_or_wrong_circuit_buffer_is_refused() {
    for (circuit, verified, deep, what) in [
        (1u8, true, true, "circuit 1"),
        (7, false, true, "phase 1 unset"),
        (7, true, false, "phase 2 unset"),
    ] {
        let mut rig = Rig::new();
        let retailer = Address::new_unique();
        let commitment = [10u8; 32];
        let vault = rig.vault_pda(&retailer, &commitment);
        let mut nullifier = [0u8; 32];
        nullifier[..8].copy_from_slice(&10u64.to_le_bytes());
        let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
        let buf =
            rig.plant_buffer(&rig.payer.pubkey(), circuit, digest, 10, rig.subtree_root, verified, deep);
        let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
        let e = {
            let ix = subscribe_ix(
                &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment,
                DENOM / 4, 100, [0u8; 32], None, &buf,
            );
            send(&mut rig, ix)
        }
        .expect_err("must be refused");
        assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "{what}: got {e}");
    }
}

/// A buffer the verifier does not own is not a buffer.
#[test]
fn a_buffer_owned_by_anyone_else_is_refused() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [11u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&11u64.to_le_bytes());
    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 11, rig.subtree_root, true, true);
    let mut acc = rig.svm.get_account(&buf).unwrap();
    acc.owner = rig.program;
    rig.svm.set_account(buf, acc).unwrap();

    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let e = {
        let ix = subscribe_ix(
            &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4,
            100, [0u8; 32], None, &buf,
        );
        send(&mut rig, ix)
    }
    .expect_err("a foreign-owned buffer must be refused");
    assert_eq!(err_code(&e), Some(E_INVALID_PROOF), "got {e}");
}

/// rate = 0 and interval = 0 are both refused, and no vault is created.
#[test]
fn a_zero_schedule_is_refused_before_anything_is_created() {
    for (rate, interval) in [(0u64, 100u64), (DENOM / 4, 0u64)] {
        let mut rig = Rig::new();
        let retailer = Address::new_unique();
        let commitment = [12u8; 32];
        let vault = rig.vault_pda(&retailer, &commitment);
        let mut nullifier = [0u8; 32];
        nullifier[..8].copy_from_slice(&12u64.to_le_bytes());
        let digest = subscribe_digest(&vault, rate, interval, &[0u8; 32], &None);
        let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 12, rig.subtree_root, true, true);
        let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
        let e = {
            let ix = subscribe_ix(
                &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, rate,
                interval, [0u8; 32], None, &buf,
            );
            send(&mut rig, ix)
        }
        .expect_err("a zero schedule must be refused");
        eprintln!("rate={rate} interval={interval} -> {:?}", err_code(&e));
        assert!(rig.svm.get_account(&vault).map(|a| a.data.is_empty()).unwrap_or(true));
    }
}

/// The license slot is fixed-width, so `Some` and `None` are two lengths on the
/// wire. Read both off a built transaction rather than off the spec's table.
#[test]
fn the_wire_length_is_one_hundred_ninety_six_or_two_hundred_twenty_eight() {
    let rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [13u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let buf = Address::new_unique();

    let none = subscribe_ix(
        &rig, &retailer, &vault, [0u8; 32], rig.root32, sr, &sib, &dir, commitment, 1, 1,
        [0u8; 32], None, &buf,
    );
    let some = subscribe_ix(
        &rig, &retailer, &vault, [0u8; 32], rig.root32, sr, &sib, &dir, commitment, 1, 1,
        [0u8; 32], Some([0u8; 32]), &buf,
    );
    eprintln!("MEASURED wire length: None = {}, Some = {}", none.data.len(), some.data.len());
    assert_eq!(none.data.len(), 196);
    assert_eq!(some.data.len(), 228);
}

// ---------------------------------------------------------------------------
// The CU question, measured rather than reasoned about
// ---------------------------------------------------------------------------

const V3_STARK_COMMITMENT: u64 = 0x00AB_CDEF_1234_5678;

/// Build the v3 subscribe against the SAME pool, same VM, same slot, so the two
/// numbers are comparable. v3's two public-input hashes are trivially
/// reconstructible: C1 is `sha256(nullifier_u64 || stark_commitment)` and C3 is
/// `sha256(leaf || root_u64 || depth)`.
#[allow(clippy::too_many_arguments)]
fn v3_subscribe_ix(
    rig: &Rig,
    retailer: &Address,
    vault: &Address,
    nullifier: [u8; 32],
    commitment: [u8; 32],
    rate: u64,
    interval: u64,
    c1: &Address,
    c3: &Address,
) -> Instruction {
    let (nrec, _) = Address::find_program_address(
        &[NullifierRecord::SEED_PREFIX, rig.pool.as_ref(), nullifier.as_ref()],
        &rig.program,
    );
    let mut data = disc("subscribe_private_stark").to_vec();
    data.extend_from_slice(&nullifier);
    data.extend_from_slice(&rig.root32);
    data.extend_from_slice(&0u64.to_le_bytes()); // min_epoch: 0 on every shipped surface
    data.extend_from_slice(&commitment);
    data.extend_from_slice(&rate.to_le_bytes());
    data.extend_from_slice(&interval.to_le_bytes());
    data.extend_from_slice(&[0u8; 32]); // vk_hash_subscriber
    data.extend_from_slice(&V3_STARK_COMMITMENT.to_le_bytes());
    data.push(0); // license_commitment: None

    Instruction {
        program_id: rig.program,
        accounts: vec![
            AccountMeta::new(rig.payer.pubkey(), true),
            AccountMeta::new_readonly(*retailer, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(rig.pool, false),
            AccountMeta::new_readonly(rig.tree, false),
            AccountMeta::new(nrec, false),
            AccountMeta::new_readonly(*c1, false),
            AccountMeta::new_readonly(*c3, false),
            AccountMeta::new_readonly(Address::from([0u8; 32]), false),
            AccountMeta::new_readonly(rig.program, false),
            AccountMeta::new_readonly(rig.program, false),
            AccountMeta::new_readonly(rig.program, false),
        ],
        data,
    }
}

fn plant_raw_buffer(rig: &mut Rig, authority: &Address, circuit: u8, hash: [u8; 32]) -> Address {
    let buf = Address::new_unique();
    let mut d = vec![0u8; 83];
    d[..8].copy_from_slice(&PROOF_BUF_DISC);
    d[8..40].copy_from_slice(authority.as_ref());
    d[40] = circuit;
    d[49] = 1;
    d[50..82].copy_from_slice(&hash);
    d[82] = 1;
    let rent = rig.svm.minimum_balance_for_rent_exemption(d.len());
    rig.svm
        .set_account(
            buf,
            Account {
                lamports: rent,
                data: d,
                owner: verifier_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    buf
}

/// The number the author left UNMEASURED, measured — and against its own
/// baseline in the same VM rather than against a devnet figure from a different
/// build. Also the control the brief asked for: v3 must still land, unchanged.
#[test]
fn what_the_single_proof_subscribe_costs_against_v3_in_one_vm() {
    // --- v3, same pool, same slot ---
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [0x77u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&31_337u64.to_le_bytes());

    let mut c1_buf = [0u8; 16];
    c1_buf[..8].copy_from_slice(&31_337u64.to_le_bytes());
    c1_buf[8..].copy_from_slice(&V3_STARK_COMMITMENT.to_le_bytes());
    let c1_hash = solana_sha256_hasher::hashv(&[&c1_buf]).to_bytes();

    let mut c3_buf = [0u8; 24];
    c3_buf[..8].copy_from_slice(&V3_STARK_COMMITMENT.to_le_bytes());
    c3_buf[8..16].copy_from_slice(&rig.root32[..8]);
    c3_buf[16..24].copy_from_slice(&(TREE_DEPTH as u64).to_le_bytes());
    let c3_hash = solana_sha256_hasher::hashv(&[&c3_buf]).to_bytes();

    let pk = rig.payer.pubkey();
    let c1 = plant_raw_buffer(&mut rig, &pk, 1, c1_hash);
    let c3 = plant_raw_buffer(&mut rig, &pk, 3, c3_hash);
    let ix3 =
        v3_subscribe_ix(&rig, &retailer, &vault, nullifier, commitment, DENOM / 4, 100, &c1, &c3);
    let v3_len = ix3.data.len();
    let cu3 = send(&mut rig, ix3).expect("v3 subscribe must still land - it is production");

    // v3 still writes the vault the same way.
    let acc = rig.svm.get_account(&vault).unwrap();
    let mut sl: &[u8] = &acc.data[8..];
    let v = <SubscriptionVault as AnchorDeserialize>::deserialize(&mut sl).unwrap();
    assert_eq!(v.total_deposited, DENOM);
    assert!(v.is_active);

    // --- v4, fresh rig, identical pool ---
    let mut rig4 = Rig::new();
    let r4 = Address::new_unique();
    let c4 = [0x78u8; 32];
    let v4 = rig4.vault_pda(&r4, &c4);
    let mut n4 = [0u8; 32];
    n4[..8].copy_from_slice(&31_338u64.to_le_bytes());
    let digest = subscribe_digest(&v4, DENOM / 4, 100, &[0u8; 32], &None);
    let buf =
        rig4.plant_buffer(&rig4.payer.pubkey(), 7, digest, 31_338, rig4.subtree_root, true, true);
    let (sr, sib, dir) = (rig4.subtree_root, rig4.siblings.clone(), rig4.directions.clone());
    let ix4 = subscribe_ix(
        &rig4, &r4, &v4, n4, rig4.root32, sr, &sib, &dir, c4, DENOM / 4, 100, [0u8; 32], None, &buf,
    );
    let v4_len = ix4.data.len();
    let cu4 = send(&mut rig4, ix4).expect("v4 subscribe must land");

    eprintln!("\n================ CU, one VM, one pool ================");
    eprintln!("  subscribe_private_stark    (v3, C1+C3) : {cu3:>7} CU   {v3_len} bytes, 2 buffers");
    eprintln!("  subscribe_private_stark_v4 (C7)        : {cu4:>7} CU   {v4_len} bytes, 1 buffer");
    eprintln!("  delta                                  : {:>+7} CU", cu4 as i64 - cu3 as i64);
    eprintln!("  default per-instruction budget         :  200000 CU");
    eprintln!("======================================================\n");
    assert!(cu4 > 0 && cu3 > 0);
}

/// Where the extra units go: one more level of the walk is one more Poseidon-GL
/// `hash2`. Priced by running the SAME instruction against a depth-13, a
/// depth-14 and a depth-15 pool.
#[test]
fn the_walk_is_what_the_new_instruction_pays_for() {
    let mut costs: Vec<(u8, u64)> = Vec::new();
    for depth in [13u8, 14, 15] {
        let mut rig = Rig::new();
        let levels = (depth - 12) as usize;
        let sib: Vec<u64> = (1..=levels as u64).collect();
        let dir: Vec<u8> = vec![0; levels];
        let derived = spend_root::resolve_pool_root(rig.subtree_root, &sib, &dir, depth).unwrap();
        let mut root32 = [0u8; 32];
        root32[..8].copy_from_slice(&derived.to_le_bytes());

        {
            let mut acc = rig.svm.get_account(&rig.pool).unwrap();
            let mut sl: &[u8] = &acc.data[8..];
            let mut p = <DenominatedPoolV3 as AnchorDeserialize>::deserialize(&mut sl).unwrap();
            p.tree_depth = depth;
            p.merkle_root = root32;
            let mut d = DenominatedPoolV3::DISCRIMINATOR.to_vec();
            p.serialize(&mut d).unwrap();
            d.resize(DenominatedPoolV3::LEN, 0);
            acc.data = d;
            rig.svm.set_account(rig.pool, acc).unwrap();

            let mut tacc = rig.svm.get_account(&rig.tree).unwrap();
            let mut tsl: &[u8] = &tacc.data[8..];
            let mut t = <MerkleTreeStateV3 as AnchorDeserialize>::deserialize(&mut tsl).unwrap();
            t.depth = depth;
            t.root = root32;
            let mut td = MerkleTreeStateV3::DISCRIMINATOR.to_vec();
            t.serialize(&mut td).unwrap();
            td.resize(MerkleTreeStateV3::LEN, 0);
            tacc.data = td;
            rig.svm.set_account(rig.tree, tacc).unwrap();
        }

        let retailer = Address::new_unique();
        let commitment = [depth; 32];
        let vault = rig.vault_pda(&retailer, &commitment);
        let mut nullifier = [0u8; 32];
        nullifier[..8].copy_from_slice(&(depth as u64).to_le_bytes());
        let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
        let buf =
            rig.plant_buffer(&rig.payer.pubkey(), 7, digest, depth as u64, rig.subtree_root, true, true);
        let sr = rig.subtree_root;
        let ix = subscribe_ix(
            &rig, &retailer, &vault, nullifier, root32, sr, &sib, &dir, commitment, DENOM / 4, 100,
            [0u8; 32], None, &buf,
        );
        let cu = send(&mut rig, ix).expect("must land at every depth above 12");
        costs.push((depth, cu));
    }
    eprintln!("\n=========== cost of the depth-12 -> depth-N walk ===========");
    for (d, cu) in &costs {
        eprintln!("  tree_depth {d}  ({} Poseidon levels): {cu:>7} CU", d - 12);
    }
    let per_level = (costs[2].1 as i64 - costs[0].1 as i64) / 2;
    eprintln!("  => one Poseidon-GL hash2 on chain      : ~{per_level} CU");
    eprintln!("============================================================\n");
    assert!(costs[2].1 > costs[0].1, "a deeper walk must cost more, not less");
}

/// A pool shallower than the circuit has nothing to walk, and the walk errors
/// stay distinguishable from "the root is not in the ring".
#[test]
fn a_pool_at_or_below_the_circuit_depth_is_refused_distinctly() {
    let mut rig = Rig::new();
    {
        let mut acc = rig.svm.get_account(&rig.pool).unwrap();
        let mut sl: &[u8] = &acc.data[8..];
        let mut p = <DenominatedPoolV3 as AnchorDeserialize>::deserialize(&mut sl).unwrap();
        p.tree_depth = 12;
        let mut d = DenominatedPoolV3::DISCRIMINATOR.to_vec();
        p.serialize(&mut d).unwrap();
        d.resize(DenominatedPoolV3::LEN, 0);
        acc.data = d;
        rig.svm.set_account(rig.pool, acc).unwrap();

        let mut tacc = rig.svm.get_account(&rig.tree).unwrap();
        let mut tsl: &[u8] = &tacc.data[8..];
        let mut t = <MerkleTreeStateV3 as AnchorDeserialize>::deserialize(&mut tsl).unwrap();
        t.depth = 12;
        let mut td = MerkleTreeStateV3::DISCRIMINATOR.to_vec();
        t.serialize(&mut td).unwrap();
        td.resize(MerkleTreeStateV3::LEN, 0);
        tacc.data = td;
        rig.svm.set_account(rig.tree, tacc).unwrap();
    }
    let retailer = Address::new_unique();
    let commitment = [0x99u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&99u64.to_le_bytes());
    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 99, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4, 100,
        [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("a depth-12 pool must be refused");
    eprintln!("depth-12 pool -> {:?}  (must NOT be InvalidProof {E_INVALID_PROOF})", err_code(&e));
    assert_ne!(
        err_code(&e),
        Some(E_INVALID_PROOF),
        "a caller-fault walk error was reported as a bad PROOF"
    );
}

/// The tree/pool depth cross-check: two accounts written by different
/// instructions with nothing else comparing them.
#[test]
fn a_pool_whose_depth_disagrees_with_its_tree_is_refused() {
    let mut rig = Rig::new();
    {
        let mut tacc = rig.svm.get_account(&rig.tree).unwrap();
        let mut tsl: &[u8] = &tacc.data[8..];
        let mut t = <MerkleTreeStateV3 as AnchorDeserialize>::deserialize(&mut tsl).unwrap();
        t.depth = 14; // pool still says 15
        let mut td = MerkleTreeStateV3::DISCRIMINATOR.to_vec();
        t.serialize(&mut td).unwrap();
        td.resize(MerkleTreeStateV3::LEN, 0);
        tacc.data = td;
        rig.svm.set_account(rig.tree, tacc).unwrap();
    }
    let retailer = Address::new_unique();
    let commitment = [0x9Au8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);
    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&98u64.to_le_bytes());
    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 98, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4, 100,
        [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("disagreeing depths must be refused");
    assert_eq!(err_code(&e), Some(E_INVALID_MERKLE_ROOT), "got {e}");
}

/// A v3 vault already at the address a v4 subscribe wants blocks it — the
/// double-open guard, across versions. The interesting half is that it fails
/// WITHOUT moving pool value.
#[test]
fn a_vault_that_already_exists_cannot_be_re_opened_by_v4() {
    let mut rig = Rig::new();
    let retailer = Address::new_unique();
    let commitment = [0x42u8; 32];
    let vault = rig.vault_pda(&retailer, &commitment);

    // A LEGACY-SIZED vault, as three of the live devnet shapes are.
    let legacy = vec![0u8; 263];
    let rent = rig.svm.minimum_balance_for_rent_exemption(legacy.len());
    rig.svm
        .set_account(
            vault,
            Account { lamports: rent, data: legacy, owner: rig.program, executable: false, rent_epoch: 0 },
        )
        .unwrap();

    let mut nullifier = [0u8; 32];
    nullifier[..8].copy_from_slice(&66u64.to_le_bytes());
    let digest = subscribe_digest(&vault, DENOM / 4, 100, &[0u8; 32], &None);
    let buf = rig.plant_buffer(&rig.payer.pubkey(), 7, digest, 66, rig.subtree_root, true, true);
    let (sr, sib, dir) = (rig.subtree_root, rig.siblings.clone(), rig.directions.clone());
    let ix = subscribe_ix(
        &rig, &retailer, &vault, nullifier, rig.root32, sr, &sib, &dir, commitment, DENOM / 4, 100,
        [0u8; 32], None, &buf,
    );
    let e = send(&mut rig, ix).expect_err("an existing vault must not be re-opened");
    eprintln!("re-open of a live 263-byte vault -> {e:.200}");
    assert_eq!(rig.pool_state().note_count, 4, "pool value moved on a refused re-open");
    assert_eq!(rig.svm.get_account(&vault).unwrap().data.len(), 263, "the live vault was resized");
}

//! Protocol 01 — Quantum-Safe Smart-Contract Wallet (`p01_quantum_wallet`).
//!
//! Solves the "Ed25519 + Shor" custody problem on Solana. Funds held inside a
//! `QuantumWalletAccount` PDA are released only on presentation of a STARK
//! proof of preimage knowledge of the wallet's Poseidon commitment (over the
//! Goldilocks field — quantum-safe). The Ed25519 keypair that submitted the
//! transaction may be considered hostile without putting funds at risk.
//!
//! See `programs/p01_quantum_wallet/README.md` (TBD) for the architecture
//! brief. Until then, the in-source plain English summary lives in
//! `docs/onboarding-cryptography.html`.
//!
//! Instructions:
//!   * `init_quantum_wallet` — open: anyone inits their own PDA.
//!   * `deposit` — open: anyone can fund any wallet.
//!   * `withdraw` — STARK-gated (circuit 0, subscriber_ownership).
//!   * `transfer_to_quantum` — STARK-gated wallet → wallet move.
//!   * `rotate_secret` — STARK-gated commitment rotation.
//!   * `init_sphincs_sig_buffer` / `write_sphincs_sig_chunk` /
//!     `close_sphincs_sig_buffer` — buffer plumbing for the 17,088-byte
//!     SPHINCS+ signature.
//!   * `emergency_recover` — SPHINCS+ -gated (verify currently stubbed, see
//!     `instructions/recover.rs`).

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod stark;
pub mod state;

use instructions::*;

declare_id!("D7RBAFcMq2gGddwFvabZKuJB1eWZFvESVrcJ3i15FFtz");

#[program]
pub mod p01_quantum_wallet {
    use super::*;

    pub fn init_quantum_wallet(
        ctx: Context<InitQuantumWallet>,
        commitment_to_secret: [u8; 32],
        recovery_pubkey: Option<[u8; 32]>,
    ) -> Result<()> {
        init::handler(ctx, commitment_to_secret, recovery_pubkey)
    }

    pub fn deposit(ctx: Context<DepositQuantum>, amount: u64) -> Result<()> {
        deposit::handler(ctx, amount)
    }

    pub fn withdraw(
        ctx: Context<WithdrawQuantum>,
        amount: u64,
        expected_nonce: u64,
    ) -> Result<()> {
        withdraw::handler(ctx, amount, expected_nonce)
    }

    pub fn transfer_to_quantum(
        ctx: Context<TransferQuantum>,
        amount: u64,
        expected_nonce: u64,
    ) -> Result<()> {
        transfer::handler(ctx, amount, expected_nonce)
    }

    pub fn rotate_secret(
        ctx: Context<RotateSecret>,
        new_commitment_to_secret: [u8; 32],
        expected_nonce: u64,
    ) -> Result<()> {
        rotate::handler(ctx, new_commitment_to_secret, expected_nonce)
    }

    pub fn init_sphincs_sig_buffer(
        ctx: Context<InitSphincsSigBuffer>,
        sig_size: u32,
    ) -> Result<()> {
        recover::init_sphincs_sig_buffer_handler(ctx, sig_size)
    }

    pub fn write_sphincs_sig_chunk(
        ctx: Context<WriteSphincsSigChunk>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        recover::write_sphincs_sig_chunk_handler(ctx, offset, data)
    }

    pub fn close_sphincs_sig_buffer(ctx: Context<CloseSphincsSigBuffer>) -> Result<()> {
        recover::close_sphincs_sig_buffer_handler(ctx)
    }

    pub fn emergency_recover(
        ctx: Context<EmergencyRecover>,
        amount: u64,
        new_commitment_to_secret: [u8; 32],
        expected_nonce: u64,
    ) -> Result<()> {
        recover::emergency_recover_handler(ctx, amount, new_commitment_to_secret, expected_nonce)
    }
}

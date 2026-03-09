use anchor_lang::prelude::*;
use sha2::{Sha256, Digest};

pub mod state;

use state::*;

declare_id!("9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv");

// ============================================================================
// Program
// ============================================================================

#[program]
pub mod p01_quantum_vault {
    use super::*;

    // ── Winternitz OTS Vault ──────────────────────────────────────

    /// Initialize a Winternitz OTS vault with a WOTS+ public key hash.
    pub fn init_winternitz_vault(
        ctx: Context<InitWinternitz>,
        wots_pubkey_hash: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.wots_pubkey_hash = wots_pubkey_hash;
        vault.balance = 0;
        vault.withdrawal_count = 0;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.frozen = false;
        vault.bump = ctx.bumps.vault;
        msg!("Winternitz vault initialized for {}", vault.owner);
        Ok(())
    }

    /// Deposit SOL into a Winternitz vault.
    pub fn deposit_winternitz(ctx: Context<DepositWinternitz>, amount: u64) -> Result<()> {
        require!(amount > 0, QVaultError::ZeroAmount);
        require!(!ctx.accounts.vault.frozen, QVaultError::VaultFrozen);

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        ctx.accounts.vault.balance = ctx
            .accounts
            .vault
            .balance
            .checked_add(amount)
            .ok_or(QVaultError::Overflow)?;

        msg!("Deposited {} lamports into Winternitz vault", amount);
        Ok(())
    }

    /// Withdraw from a Winternitz vault using a WOTS+ one-time signature.
    ///
    /// Signature: 32 hash-chain values (1024 bytes). For each nibble m_i of
    /// the message hash, the signer provides hash^(15-m_i)(secret_i).
    /// Verification: hash^(m_i)(sig_i) == pubkey chain endpoint.
    ///
    /// After withdrawal, the vault's pubkey rotates to `next_wots_pubkey_hash`.
    pub fn withdraw_winternitz(
        ctx: Context<WithdrawWinternitz>,
        amount: u64,
        wots_signature: Vec<u8>,
        wots_pubkey: Vec<u8>,
        next_wots_pubkey_hash: [u8; 32],
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        require!(!vault.frozen, QVaultError::VaultFrozen);
        require!(amount > 0, QVaultError::ZeroAmount);
        require!(vault.balance >= amount, QVaultError::InsufficientBalance);
        require!(
            wots_signature.len() == WOTS_CHAINS * HASH_SIZE,
            QVaultError::InvalidWotsSignature
        );
        require!(
            wots_pubkey.len() == WOTS_CHAINS * HASH_SIZE,
            QVaultError::WotsPubkeyMismatch
        );

        // Step 1: Verify pubkey matches stored hash
        let pubkey_hash: [u8; 32] = Sha256::digest(&wots_pubkey).into();
        require!(
            pubkey_hash == vault.wots_pubkey_hash,
            QVaultError::WotsPubkeyMismatch
        );

        // Step 2: Compute message = SHA-256(amount || destination || withdrawal_count)
        let mut hasher = Sha256::new();
        hasher.update(&amount.to_le_bytes());
        hasher.update(ctx.accounts.destination.key.as_ref());
        hasher.update(&vault.withdrawal_count.to_le_bytes());
        let msg_bytes: [u8; 32] = hasher.finalize().into();

        // Step 3: Verify each WOTS+ chain
        for chain_idx in 0..WOTS_CHAINS {
            let byte_idx = chain_idx / 2;
            let nibble = if chain_idx % 2 == 0 {
                (msg_bytes[byte_idx] >> 4) & 0x0F
            } else {
                msg_bytes[byte_idx] & 0x0F
            };

            let sig_start = chain_idx * HASH_SIZE;
            let mut current = [0u8; HASH_SIZE];
            current.copy_from_slice(&wots_signature[sig_start..sig_start + HASH_SIZE]);

            for _ in 0..nibble {
                let h: [u8; 32] = Sha256::digest(&current).into();
                current = h;
            }

            let pk_start = chain_idx * HASH_SIZE;
            require!(
                current == wots_pubkey[pk_start..pk_start + HASH_SIZE],
                QVaultError::InvalidWotsSignature
            );
        }

        // Step 4: Transfer funds
        let vault_info = ctx.accounts.vault.to_account_info();
        let dest_info = ctx.accounts.destination.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **dest_info.try_borrow_mut_lamports()? += amount;

        // Step 5: Update state + rotate key
        let vault = &mut ctx.accounts.vault;
        vault.balance = vault.balance.checked_sub(amount).ok_or(QVaultError::Overflow)?;
        vault.withdrawal_count += 1;
        vault.wots_pubkey_hash = next_wots_pubkey_hash;

        msg!(
            "Winternitz withdrawal #{}: {} lamports",
            vault.withdrawal_count,
            amount
        );
        Ok(())
    }

    // ── Hash-Timelock Vault ───────────────────────────────────────

    /// Initialize a hash-timelock vault for quantum-safe cold storage.
    pub fn init_hash_vault(
        ctx: Context<InitHashVault>,
        commitment: [u8; 32],
        unlock_after: i64,
        destination: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.commitment = commitment;
        vault.balance = 0;
        vault.unlock_after = unlock_after;
        vault.destination = destination;
        vault.drained = false;
        vault.bump = ctx.bumps.vault;
        msg!("Hash vault initialized");
        Ok(())
    }

    /// Deposit SOL into a hash-timelock vault.
    pub fn deposit_hash_vault(ctx: Context<DepositHashVault>, amount: u64) -> Result<()> {
        require!(amount > 0, QVaultError::ZeroAmount);
        require!(!ctx.accounts.vault.drained, QVaultError::AlreadyDrained);

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        ctx.accounts.vault.balance = ctx
            .accounts
            .vault
            .balance
            .checked_add(amount)
            .ok_or(QVaultError::Overflow)?;

        msg!("Deposited {} lamports into hash vault", amount);
        Ok(())
    }

    /// Withdraw from a hash-timelock vault by revealing the SHA-256 preimage.
    /// Anyone with the preimage can call this — Ed25519 is NOT the security boundary.
    pub fn withdraw_hash_vault(
        ctx: Context<WithdrawHashVault>,
        preimage: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        require!(!vault.drained, QVaultError::AlreadyDrained);
        require!(amount > 0, QVaultError::ZeroAmount);
        require!(vault.balance >= amount, QVaultError::InsufficientBalance);

        // Check timelock
        if vault.unlock_after > 0 {
            let clock = Clock::get()?;
            require!(
                clock.unix_timestamp >= vault.unlock_after,
                QVaultError::TimelockActive
            );
        }

        // Verify preimage
        let hash: [u8; 32] = Sha256::digest(&preimage).into();
        require!(hash == vault.commitment, QVaultError::PreimageMismatch);

        // Verify destination
        require!(
            ctx.accounts.destination.key() == vault.destination,
            QVaultError::PreimageMismatch
        );

        // Transfer
        let vault_info = ctx.accounts.vault.to_account_info();
        let dest_info = ctx.accounts.destination.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **dest_info.try_borrow_mut_lamports()? += amount;

        let vault = &mut ctx.accounts.vault;
        vault.balance = vault.balance.checked_sub(amount).ok_or(QVaultError::Overflow)?;
        if vault.balance == 0 {
            vault.drained = true;
        }

        msg!("Hash vault withdrawal: {} lamports", amount);
        Ok(())
    }

    // ── Commit-Then-Reveal ────────────────────────────────────────

    /// Create a commitment (phase 1 of commit-then-reveal).
    pub fn create_commitment(
        ctx: Context<CreateCommit>,
        commitment: [u8; 32],
        action_type: u8,
        reveal_window: u64,
    ) -> Result<()> {
        require!(
            reveal_window >= MIN_REVEAL_DELAY && reveal_window <= MAX_REVEAL_WINDOW,
            QVaultError::InvalidRevealWindow
        );

        let clock = Clock::get()?;
        let record = &mut ctx.accounts.record;
        record.committer = ctx.accounts.committer.key();
        record.commitment = commitment;
        record.commit_slot = clock.slot;
        record.min_reveal_delay = MIN_REVEAL_DELAY;
        record.max_reveal_window = reveal_window;
        record.revealed = false;
        record.action_type = action_type;
        record.bump = ctx.bumps.record;

        msg!("Commitment created at slot {}", clock.slot);
        Ok(())
    }

    /// Reveal a previously committed action (phase 2 of commit-then-reveal).
    pub fn reveal_commitment(
        ctx: Context<RevealCommit>,
        action_data: Vec<u8>,
        nonce: [u8; 32],
    ) -> Result<()> {
        let record = &ctx.accounts.record;
        let clock = Clock::get()?;

        require!(!record.revealed, QVaultError::AlreadyRevealed);

        let elapsed = clock.slot.saturating_sub(record.commit_slot);
        require!(elapsed >= record.min_reveal_delay, QVaultError::RevealTooEarly);
        require!(elapsed <= record.max_reveal_window, QVaultError::CommitmentExpired);

        // Verify: SHA-256(action_data || nonce) == commitment
        let mut hasher = Sha256::new();
        hasher.update(&action_data);
        hasher.update(&nonce);
        let hash: [u8; 32] = hasher.finalize().into();
        require!(hash == record.commitment, QVaultError::CommitmentMismatch);

        let record = &mut ctx.accounts.record;
        record.revealed = true;

        msg!("Commitment revealed at slot {}", clock.slot);
        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct InitWinternitz<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = WinternitzVault::SIZE,
        seeds = [b"wots_vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, WinternitzVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositWinternitz<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"wots_vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, WinternitzVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawWinternitz<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"wots_vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, WinternitzVault>,
    /// CHECK: Destination receives lamports. Validated by WOTS+ signed message.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitHashVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = HashVault::SIZE,
        seeds = [b"hash_vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, HashVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositHashVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"hash_vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, HashVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawHashVault<'info> {
    /// Signer pays TX fee. NOT the security boundary — preimage is.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"hash_vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, HashVault>,
    /// CHECK: Must match vault.destination
    #[account(mut)]
    pub destination: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct CreateCommit<'info> {
    #[account(mut)]
    pub committer: Signer<'info>,
    #[account(
        init,
        payer = committer,
        space = CommitRecord::SIZE,
        seeds = [b"commit", committer.key().as_ref(), commitment.as_ref()],
        bump,
    )]
    pub record: Account<'info, CommitRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealCommit<'info> {
    #[account(mut)]
    pub committer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"commit", committer.key().as_ref(), record.commitment.as_ref()],
        bump = record.bump,
        has_one = committer,
    )]
    pub record: Account<'info, CommitRecord>,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum QVaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Vault is frozen")]
    VaultFrozen,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid WOTS+ signature")]
    InvalidWotsSignature,
    #[msg("WOTS+ public key mismatch")]
    WotsPubkeyMismatch,
    #[msg("Hash preimage does not match commitment")]
    PreimageMismatch,
    #[msg("Timelock has not expired")]
    TimelockActive,
    #[msg("Vault already drained")]
    AlreadyDrained,
    #[msg("Insufficient vault balance")]
    InsufficientBalance,
    #[msg("Commitment already revealed")]
    AlreadyRevealed,
    #[msg("Commitment expired")]
    CommitmentExpired,
    #[msg("Reveal too early")]
    RevealTooEarly,
    #[msg("Invalid reveal window")]
    InvalidRevealWindow,
    #[msg("Commitment hash mismatch")]
    CommitmentMismatch,
}

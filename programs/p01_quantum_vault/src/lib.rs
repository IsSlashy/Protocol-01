use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

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

    /// Initialize a WOTS+ signature buffer PDA.
    ///
    /// The signature (2144 bytes) is too large to fit in a single Solana
    /// transaction's instruction data (1232-byte legacy cap, 1644-byte v0 cap),
    /// so the caller uploads it in chunks via `write_wots_sig_chunk` before
    /// invoking `withdraw_winternitz`. Seeds `[b"wots_sig", vault, authority]`
    /// mean each (vault, signer) pair has at most one pending buffer.
    pub fn init_wots_sig_buffer(
        ctx: Context<InitWotsSigBuffer>,
        sig_size: u32,
    ) -> Result<()> {
        require!(
            sig_size as usize == WOTS_SIG_SIZE,
            QVaultError::InvalidWotsSignature
        );
        let buf = &mut ctx.accounts.buffer;
        buf.authority = ctx.accounts.authority.key();
        buf.vault = ctx.accounts.vault.key();
        buf.sig_size = sig_size;
        buf.bytes_written = 0;
        Ok(())
    }

    /// Write a chunk of signature bytes to the buffer at the given offset.
    /// Uses raw account-data writes (not struct reserialization) to keep
    /// per-chunk CU cost bounded independent of total signature size.
    pub fn write_wots_sig_chunk(
        ctx: Context<WriteWotsSigChunk>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        let buf = &mut ctx.accounts.buffer;
        let end = (offset as usize)
            .checked_add(data.len())
            .ok_or(QVaultError::Overflow)?;
        require!(
            end <= buf.sig_size as usize,
            QVaultError::ChunkOutOfBounds
        );

        buf.bytes_written = buf.bytes_written.max(end as u32);

        let info = buf.to_account_info();
        let mut account_data = info.data.borrow_mut();
        let start = WotsSigBuffer::SIG_DATA_OFFSET + offset as usize;
        let absolute_end = WotsSigBuffer::SIG_DATA_OFFSET + end;
        account_data[start..absolute_end].copy_from_slice(&data);
        Ok(())
    }

    /// Close the WOTS+ signature buffer and return rent to the authority.
    /// Callable regardless of whether the signature was consumed — always safe.
    pub fn close_wots_sig_buffer(_ctx: Context<CloseWotsSigBuffer>) -> Result<()> {
        Ok(())
    }

    /// Withdraw from a Winternitz vault using a WOTS+ one-time signature
    /// previously uploaded into a `WotsSigBuffer`.
    ///
    /// Flow:
    ///   1. `init_wots_sig_buffer(WOTS_SIG_SIZE)` — create PDA buffer.
    ///   2. `write_wots_sig_chunk` × N — upload 2144 bytes (typically 3 chunks).
    ///   3. `withdraw_winternitz(amount, next_wots_pubkey_hash)` — verify + transfer.
    ///   4. `close_wots_sig_buffer` — rent refund.
    ///
    /// Signature layout: 67 hash-chain values (2144 bytes) = 64 message + 3 checksum.
    /// For each nibble m_i, signer provides `hash^(15-m_i)(secret_i)`.
    /// The program walks each chain `m_i` more hash steps, which yields the
    /// pubkey chain endpoint — streaming these into SHA-256 gives the pubkey
    /// hash, which must equal the stored `vault.wots_pubkey_hash`.
    ///
    /// Checksum encoding: `sum(15 - m_i)` for i in 0..64, MSB-first as 3 nibbles.
    /// Without the checksum, an attacker can forge a signature for any message
    /// whose nibbles are all <= the legitimate message's nibbles — the checksum
    /// forces at least one checksum nibble to DECREASE when any message nibble
    /// decreases, and decreasing a chain requires knowing the secret.
    ///
    /// After withdrawal, the vault's pubkey rotates to `next_wots_pubkey_hash`.
    pub fn withdraw_winternitz(
        ctx: Context<WithdrawWinternitz>,
        amount: u64,
        next_wots_pubkey_hash: [u8; 32],
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let buffer = &ctx.accounts.sig_buffer;

        require!(!vault.frozen, QVaultError::VaultFrozen);
        require!(amount > 0, QVaultError::ZeroAmount);
        require!(vault.balance >= amount, QVaultError::InsufficientBalance);
        require!(
            buffer.sig_size as usize == WOTS_SIG_SIZE,
            QVaultError::InvalidWotsSignature
        );
        require!(
            buffer.bytes_written as usize == WOTS_SIG_SIZE,
            QVaultError::IncompleteWotsSignature
        );
        require!(
            buffer.vault == ctx.accounts.vault.key(),
            QVaultError::WotsBufferVaultMismatch
        );

        // Snapshot sig bytes out of the PDA before we do any other borrows.
        let sig_bytes: [u8; WOTS_SIG_SIZE] = {
            let info = buffer.to_account_info();
            let data = info.data.borrow();
            let start = WotsSigBuffer::SIG_DATA_OFFSET;
            let mut out = [0u8; WOTS_SIG_SIZE];
            out.copy_from_slice(&data[start..start + WOTS_SIG_SIZE]);
            out
        };

        // Step 1: Compute message = SHA-256(amount || destination || withdrawal_count).
        // Use Solana's SHA-256 syscall (~85 CU) instead of the `sha2` crate
        // (native BPF, ~2K CU/call) — critical for the 67-chain inner loop below.
        let amount_le = amount.to_le_bytes();
        let count_le = vault.withdrawal_count.to_le_bytes();
        let msg_bytes: [u8; 32] = hashv(&[
            &amount_le,
            ctx.accounts.destination.key.as_ref(),
            &count_le,
        ])
        .to_bytes();

        // Step 2: Extract 64 message nibbles (high nibble first per byte).
        let mut nibbles = [0u8; WOTS_CHAINS];
        for i in 0..WOTS_MSG_CHAINS {
            let byte_idx = i / 2;
            nibbles[i] = if i % 2 == 0 {
                (msg_bytes[byte_idx] >> 4) & 0x0F
            } else {
                msg_bytes[byte_idx] & 0x0F
            };
        }

        // Step 3: Checksum = sum(15 - m_i) over the 64 message nibbles.
        let mut checksum: u16 = 0;
        for i in 0..WOTS_MSG_CHAINS {
            checksum += (WOTS_MAX_VAL - nibbles[i]) as u16;
        }

        // Step 4: Encode checksum MSB-first into 3 trailing nibbles.
        nibbles[WOTS_MSG_CHAINS] = ((checksum >> 8) & 0x0F) as u8;
        nibbles[WOTS_MSG_CHAINS + 1] = ((checksum >> 4) & 0x0F) as u8;
        nibbles[WOTS_MSG_CHAINS + 2] = (checksum & 0x0F) as u8;

        // Step 5: Reconstruct each pubkey chain end-point from the signature
        // by applying `m_i` more hash steps to sig[i], then hash the concatenated
        // endpoints to get the pubkey commitment. Uses the SHA-256 syscall for
        // every step; previous `sha2` crate impl hit the 200K CU ceiling.
        // Endpoints accumulate on the heap (2144 bytes) so we don't blow the
        // 4KB BPF stack (sig_bytes already consumes 2144 bytes of stack).
        let mut pk_bytes: Vec<u8> = Vec::with_capacity(WOTS_PUBKEY_SIZE);
        for chain_idx in 0..WOTS_CHAINS {
            let nibble = nibbles[chain_idx];
            let sig_start = chain_idx * HASH_SIZE;
            let mut current = [0u8; HASH_SIZE];
            current.copy_from_slice(&sig_bytes[sig_start..sig_start + HASH_SIZE]);
            for _ in 0..nibble {
                current = hashv(&[&current]).to_bytes();
            }
            pk_bytes.extend_from_slice(&current);
        }
        let reconstructed_pubkey_hash: [u8; 32] = hashv(&[&pk_bytes]).to_bytes();
        require!(
            reconstructed_pubkey_hash == vault.wots_pubkey_hash,
            QVaultError::InvalidWotsSignature
        );

        // Step 6: Ensure vault remains rent-exempt after withdrawal.
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(vault_info.data_len());
        require!(
            vault_info.lamports().checked_sub(amount).unwrap_or(0) >= min_balance,
            QVaultError::InsufficientFundsForRent
        );

        // Step 7: Transfer lamports.
        let dest_info = ctx.accounts.destination.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **dest_info.try_borrow_mut_lamports()? += amount;

        // Step 8: Update state + rotate key.
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

        // Verify preimage via SHA-256 syscall.
        let hash: [u8; 32] = hashv(&[&preimage]).to_bytes();
        require!(hash == vault.commitment, QVaultError::PreimageMismatch);

        // Verify destination
        require!(
            ctx.accounts.destination.key() == vault.destination,
            QVaultError::PreimageMismatch
        );

        // Enforce full withdrawal to prevent preimage reuse.
        // Once the preimage is revealed on-chain, anyone can see it,
        // so partial withdrawals would leave remaining funds vulnerable.
        require!(
            amount == vault.balance,
            QVaultError::MustWithdrawFullBalance
        );

        // Transfer
        let vault_info = ctx.accounts.vault.to_account_info();
        let dest_info = ctx.accounts.destination.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= amount;
        **dest_info.try_borrow_mut_lamports()? += amount;

        let vault = &mut ctx.accounts.vault;
        vault.balance = 0;
        vault.drained = true;

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

        // Verify: SHA-256(action_data || nonce) == commitment, via syscall.
        let hash: [u8; 32] = hashv(&[action_data.as_slice(), nonce.as_ref()]).to_bytes();
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
    /// Buffer holding the uploaded WOTS+ signature.
    /// `has_one = authority` binds the buffer to the owner; the separate
    /// `buffer.vault == vault.key()` check inside the handler binds it to
    /// this specific vault.
    #[account(
        mut,
        seeds = [b"wots_sig", vault.key().as_ref(), owner.key().as_ref()],
        bump,
        has_one = authority,
    )]
    pub sig_buffer: Account<'info, WotsSigBuffer>,
    /// CHECK: Destination receives lamports. Bound into the signed message
    /// (SHA-256(amount || destination || withdrawal_count)), so the WOTS+
    /// signature only verifies for the destination encoded at signing time.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    /// Must equal the buffer's authority (= owner for PDA bind).
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sig_size: u32)]
pub struct InitWotsSigBuffer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// Target vault. The buffer is bound to a specific (vault, authority) pair
    /// so signatures uploaded here can only withdraw from this vault.
    #[account(
        seeds = [b"wots_vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, WinternitzVault>,
    #[account(
        init,
        payer = authority,
        space = WotsSigBuffer::SPACE,
        seeds = [b"wots_sig", vault.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub buffer: Account<'info, WotsSigBuffer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteWotsSigChunk<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"wots_sig", buffer.vault.as_ref(), authority.key().as_ref()],
        bump,
        has_one = authority,
    )]
    pub buffer: Account<'info, WotsSigBuffer>,
}

#[derive(Accounts)]
pub struct CloseWotsSigBuffer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"wots_sig", buffer.vault.as_ref(), authority.key().as_ref()],
        bump,
        has_one = authority,
        close = authority,
    )]
    pub buffer: Account<'info, WotsSigBuffer>,
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
    #[msg("Withdrawal would leave vault below rent-exempt minimum")]
    InsufficientFundsForRent,
    #[msg("Hash vault requires full withdrawal (amount must equal balance)")]
    MustWithdrawFullBalance,
    #[msg("WOTS+ signature buffer chunk exceeds declared sig_size")]
    ChunkOutOfBounds,
    #[msg("WOTS+ signature buffer has not been fully populated")]
    IncompleteWotsSignature,
    #[msg("WOTS+ signature buffer is bound to a different vault")]
    WotsBufferVaultMismatch,
}

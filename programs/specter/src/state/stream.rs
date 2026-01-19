use anchor_lang::prelude::*;

/// StreamAccount - Streaming payment account
///
/// Enables continuous payment streams where funds unlock linearly over time.
/// Supports both public and private (encrypted) streams.
#[account]
#[derive(Default)]
pub struct StreamAccount {
    /// The sender who created and funded the stream
    pub sender: Pubkey,

    /// The recipient who can withdraw unlocked funds
    pub recipient: Pubkey,

    /// Token mint address (Pubkey::default() for native SOL)
    pub token_mint: Pubkey,

    /// Total amount to be streamed
    pub total_amount: u64,

    /// Amount already withdrawn by recipient
    pub withdrawn_amount: u64,

    /// Unix timestamp when stream starts
    pub start_time: i64,

    /// Unix timestamp when stream ends
    pub end_time: i64,

    /// Whether this is a private stream (amount encrypted)
    pub is_private: bool,

    /// Whether the stream is currently paused
    pub paused: bool,

    /// Whether the stream has been cancelled
    pub cancelled: bool,

    /// PDA bump seed
    pub bump: u8,
}

impl StreamAccount {
    /// Account space calculation
    /// discriminator (8) + sender (32) + recipient (32) + token_mint (32) +
    /// total_amount (8) + withdrawn_amount (8) + start_time (8) + end_time (8) +
    /// is_private (1) + paused (1) + cancelled (1) + bump (1)
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1;

    /// Seed prefix for PDA derivation
    pub const SEED_PREFIX: &'static [u8] = b"stream";

    /// Minimum stream duration (1 minute)
    pub const MIN_DURATION: i64 = 60;

    /// Maximum stream duration (10 years)
    pub const MAX_DURATION: i64 = 10 * 365 * 24 * 60 * 60;

    /// Initialize a new stream
    pub fn initialize(
        &mut self,
        sender: Pubkey,
        recipient: Pubkey,
        token_mint: Pubkey,
        total_amount: u64,
        start_time: i64,
        end_time: i64,
        is_private: bool,
        bump: u8,
    ) {
        self.sender = sender;
        self.recipient = recipient;
        self.token_mint = token_mint;
        self.total_amount = total_amount;
        self.withdrawn_amount = 0;
        self.start_time = start_time;
        self.end_time = end_time;
        self.is_private = is_private;
        self.paused = false;
        self.cancelled = false;
        self.bump = bump;
    }

    /// Calculate the amount of tokens that have been unlocked so far
    pub fn unlocked_amount(&self, current_time: i64) -> u64 {
        if current_time <= self.start_time {
            return 0;
        }

        if current_time >= self.end_time {
            return self.total_amount;
        }

        let elapsed = (current_time - self.start_time) as u128;
        let duration = (self.end_time - self.start_time) as u128;
        let total = self.total_amount as u128;

        // Linear vesting calculation: unlocked = total * elapsed / duration
        ((total * elapsed) / duration) as u64
    }

    /// Calculate the amount available for withdrawal
    pub fn withdrawable_amount(&self, current_time: i64) -> u64 {
        if self.paused || self.cancelled {
            return 0;
        }

        let unlocked = self.unlocked_amount(current_time);
        unlocked.saturating_sub(self.withdrawn_amount)
    }

    /// Calculate remaining amount after cancellation
    pub fn remaining_amount(&self, current_time: i64) -> u64 {
        let unlocked = self.unlocked_amount(current_time);
        self.total_amount.saturating_sub(unlocked)
    }

    /// Update withdrawn amount after a withdrawal
    pub fn withdraw(&mut self, amount: u64) {
        self.withdrawn_amount = self.withdrawn_amount.saturating_add(amount);
    }

    /// Mark stream as cancelled
    pub fn cancel(&mut self) {
        self.cancelled = true;
    }

    /// Pause the stream
    pub fn pause(&mut self) {
        self.paused = true;
    }

    /// Resume the stream
    pub fn resume(&mut self) {
        self.paused = false;
    }

    /// Check if stream has ended
    pub fn has_ended(&self, current_time: i64) -> bool {
        current_time >= self.end_time || self.cancelled
    }

    /// Check if stream has started
    pub fn has_started(&self, current_time: i64) -> bool {
        current_time >= self.start_time
    }

    /// Check if the given pubkey is the sender
    pub fn is_sender(&self, pubkey: &Pubkey) -> bool {
        self.sender == *pubkey
    }

    /// Check if the given pubkey is the recipient
    pub fn is_recipient(&self, pubkey: &Pubkey) -> bool {
        self.recipient == *pubkey
    }

    /// Validate stream duration
    pub fn validate_duration(duration: i64) -> bool {
        duration >= Self::MIN_DURATION && duration <= Self::MAX_DURATION
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unlocked_amount_before_start() {
        let stream = StreamAccount {
            total_amount: 1000,
            start_time: 100,
            end_time: 200,
            ..Default::default()
        };

        assert_eq!(stream.unlocked_amount(50), 0);
        assert_eq!(stream.unlocked_amount(100), 0);
    }

    #[test]
    fn test_unlocked_amount_during_stream() {
        let stream = StreamAccount {
            total_amount: 1000,
            start_time: 100,
            end_time: 200,
            ..Default::default()
        };

        assert_eq!(stream.unlocked_amount(150), 500);
        assert_eq!(stream.unlocked_amount(125), 250);
        assert_eq!(stream.unlocked_amount(175), 750);
    }

    #[test]
    fn test_unlocked_amount_after_end() {
        let stream = StreamAccount {
            total_amount: 1000,
            start_time: 100,
            end_time: 200,
            ..Default::default()
        };

        assert_eq!(stream.unlocked_amount(200), 1000);
        assert_eq!(stream.unlocked_amount(300), 1000);
    }

    #[test]
    fn test_withdrawable_amount() {
        let mut stream = StreamAccount {
            total_amount: 1000,
            withdrawn_amount: 200,
            start_time: 100,
            end_time: 200,
            ..Default::default()
        };

        // At time 150, 500 is unlocked, 200 already withdrawn
        assert_eq!(stream.withdrawable_amount(150), 300);

        // If paused, nothing is withdrawable
        stream.paused = true;
        assert_eq!(stream.withdrawable_amount(150), 0);
    }
}

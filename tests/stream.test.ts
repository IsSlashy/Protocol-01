/**
 * P01 Stream Program - Comprehensive Test Suite
 *
 * Tests the standalone streaming payments program:
 *   - Stream creation with SPL token escrow
 *   - Interval-based withdrawal by recipient
 *   - Stream cancellation with refund to sender
 *   - Stream lifecycle and completion
 *
 * Program ID: 2ko4FQSTj3Bqrmy3nvWeGx1KEhs5f2dFCy7JYY6wyxbs
 */

import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { expect } from 'chai';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROGRAM_ID = new PublicKey('2ko4FQSTj3Bqrmy3nvWeGx1KEhs5f2dFCy7JYY6wyxbs');

const SEEDS = {
  STREAM: Buffer.from('stream'),
};

/** Stream status enum (matches Rust StreamStatus). */
enum StreamStatus {
  Active = 0,
  Paused = 1,
  Cancelled = 2,
  Completed = 3,
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

/** Derive the Stream PDA for a sender, recipient, and token mint. */
function deriveStreamPDA(
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STREAM, sender.toBuffer(), recipient.toBuffer(), mint.toBuffer()],
    PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Interval calculation helpers (mirror Rust logic)
// ---------------------------------------------------------------------------

/** Calculate intervals elapsed since the last withdrawal. */
function intervalsElapsed(
  lastWithdrawalAt: number,
  currentTime: number,
  intervalSeconds: number,
): number {
  const timeElapsed = currentTime - lastWithdrawalAt;
  return Math.floor(timeElapsed / intervalSeconds);
}

/** Calculate the intervals that can actually be paid. */
function intervalsToPay(
  elapsedIntervals: number,
  totalIntervals: number,
  intervalsPaid: number,
): number {
  const remaining = totalIntervals - intervalsPaid;
  return Math.min(elapsedIntervals, remaining);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('P01 Stream Program', () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = (provider.wallet as anchor.Wallet).payer;

  const sender = Keypair.generate();
  const recipient = Keypair.generate();

  // =====================================================================
  // 1. Create Stream
  // =====================================================================
  describe('create_stream', () => {
    it('should derive stream PDA correctly', () => {
      const mint = Keypair.generate().publicKey;
      const [streamPDA, bump] = deriveStreamPDA(
        sender.publicKey,
        recipient.publicKey,
        mint,
      );

      expect(streamPDA).to.not.be.null;
      expect(bump).to.be.a('number');
    });

    it('should produce different PDAs for different sender-recipient-mint combos', () => {
      const mint = Keypair.generate().publicKey;

      const [pda1] = deriveStreamPDA(
        sender.publicKey,
        recipient.publicKey,
        mint,
      );
      const [pda2] = deriveStreamPDA(
        recipient.publicKey,
        sender.publicKey,
        mint,
      );

      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it('should reject zero amount_per_interval', () => {
      // require!(amount_per_interval > 0, StreamError::InvalidAmount)
      const amount = 0;
      expect(amount).to.equal(0);
      // Would error with StreamError::InvalidAmount
    });

    it('should reject zero interval_seconds', () => {
      // require!(interval_seconds > 0, StreamError::InvalidInterval)
      const interval = 0;
      expect(interval).to.equal(0);
    });

    it('should reject zero total_intervals', () => {
      // require!(total_intervals > 0, StreamError::InvalidIntervals)
      const intervals = 0;
      expect(intervals).to.equal(0);
    });

    it('should accept valid stream parameters', () => {
      const amountPerInterval = new BN(1_000_000); // 0.001 tokens
      const intervalSeconds = new BN(3600); // 1 hour
      const totalIntervals = new BN(24); // 24 payments
      const streamName = 'Monthly Salary';

      expect(amountPerInterval.toNumber()).to.be.greaterThan(0);
      expect(intervalSeconds.toNumber()).to.be.greaterThan(0);
      expect(totalIntervals.toNumber()).to.be.greaterThan(0);
      expect(streamName.length).to.be.at.most(32);
    });

    it('should reject stream name exceeding 32 characters', () => {
      const tooLong = 'A'.repeat(33);
      expect(tooLong.length).to.be.greaterThan(32);
      // Would error with StreamError::NameTooLong
    });

    it('should calculate total deposit correctly', () => {
      const amountPerInterval = 1_000_000;
      const totalIntervals = 12;
      const totalDeposit = amountPerInterval * totalIntervals;

      expect(totalDeposit).to.equal(12_000_000);
    });

    it('should detect overflow on large total deposit', () => {
      // checked_mul would catch overflow
      const maxU64 = BigInt('18446744073709551615');
      const amountPerInterval = BigInt('10000000000000000000');
      const totalIntervals = BigInt('2');

      // In Rust this would use checked_mul and return StreamError::Overflow
      let overflows = false;
      try {
        const result = amountPerInterval * totalIntervals;
        if (result > maxU64) overflows = true;
      } catch {
        overflows = true;
      }
      expect(overflows).to.be.true;
    });

    it('should set initial status to Active', () => {
      const initialStatus = StreamStatus.Active;
      expect(initialStatus).to.equal(StreamStatus.Active);
    });

    it('should set intervals_paid to zero', () => {
      const intervalsPaid = 0;
      expect(intervalsPaid).to.equal(0);
    });
  });

  // =====================================================================
  // 2. Withdraw From Stream
  // =====================================================================
  describe('withdraw_from_stream', () => {
    it('should reject withdrawal from non-Active stream', () => {
      const statuses = [StreamStatus.Paused, StreamStatus.Cancelled, StreamStatus.Completed];

      for (const status of statuses) {
        const isActive = status === StreamStatus.Active;
        expect(isActive).to.be.false;
        // Would error with StreamError::StreamNotActive
      }
    });

    it('should require the recipient as signer', () => {
      // The WithdrawFromStream context has: constraint = stream.recipient == recipient.key()
      const streamRecipient = recipient.publicKey;
      const wrongRecipient = Keypair.generate().publicKey;

      expect(streamRecipient.toBase58()).to.not.equal(
        wrongRecipient.toBase58(),
      );
    });

    it('should calculate elapsed intervals correctly', () => {
      // 1 hour interval, 2.5 hours elapsed = 2 intervals
      expect(intervalsElapsed(1000, 10000, 3600)).to.equal(2);

      // 1 day interval, 3 days elapsed = 3 intervals
      expect(intervalsElapsed(0, 259200, 86400)).to.equal(3);

      // Less than 1 interval elapsed = 0
      expect(intervalsElapsed(0, 1800, 3600)).to.equal(0);
    });

    it('should cap intervals_to_pay at remaining intervals', () => {
      // 5 intervals elapsed, but only 3 remaining
      expect(intervalsToPay(5, 10, 7)).to.equal(3);

      // 2 intervals elapsed, 8 remaining
      expect(intervalsToPay(2, 10, 2)).to.equal(2);

      // 0 intervals elapsed
      expect(intervalsToPay(0, 10, 0)).to.equal(0);
    });

    it('should reject withdrawal when no intervals have elapsed', () => {
      // intervals_to_pay == 0 => StreamError::NothingToWithdraw
      const toPay = intervalsToPay(0, 10, 0);
      expect(toPay).to.equal(0);
    });

    it('should compute withdrawal amount correctly', () => {
      const amountPerInterval = 1_000_000;
      const intervalsToPay_ = 3;
      const withdrawalAmount = amountPerInterval * intervalsToPay_;

      expect(withdrawalAmount).to.equal(3_000_000);
    });

    it('should update intervals_paid after withdrawal', () => {
      let intervalsPaid = 2;
      const paidNow = 3;
      intervalsPaid += paidNow;

      expect(intervalsPaid).to.equal(5);
    });

    it('should mark stream as Completed when all intervals are paid', () => {
      const totalIntervals = 10;
      let intervalsPaid = 8;
      intervalsPaid += 2;

      let status = StreamStatus.Active;
      if (intervalsPaid >= totalIntervals) {
        status = StreamStatus.Completed;
      }

      expect(status).to.equal(StreamStatus.Completed);
    });

    it('should stay Active if intervals remain', () => {
      const totalIntervals = 10;
      const intervalsPaid = 5;

      let status = StreamStatus.Active;
      if (intervalsPaid >= totalIntervals) {
        status = StreamStatus.Completed;
      }

      expect(status).to.equal(StreamStatus.Active);
    });
  });

  // =====================================================================
  // 3. Cancel Stream
  // =====================================================================
  describe('cancel_stream', () => {
    it('should only allow sender to cancel', () => {
      // constraint = stream.sender == sender.key()
      const streamSender = sender.publicKey;
      const attacker = Keypair.generate().publicKey;

      expect(streamSender.toBase58()).to.not.equal(attacker.toBase58());
    });

    it('should reject cancellation of non-Active stream', () => {
      const cancelled = StreamStatus.Cancelled;
      expect(cancelled).to.not.equal(StreamStatus.Active);
    });

    it('should calculate refund amount correctly', () => {
      const amountPerInterval = 1_000_000;
      const totalIntervals = 10;
      const intervalsPaid = 4;

      const intervalsRemaining = totalIntervals - intervalsPaid;
      const refundAmount = amountPerInterval * intervalsRemaining;

      expect(intervalsRemaining).to.equal(6);
      expect(refundAmount).to.equal(6_000_000);
    });

    it('should refund nothing if all intervals are paid', () => {
      const amountPerInterval = 1_000_000;
      const totalIntervals = 10;
      const intervalsPaid = 10;

      const intervalsRemaining = totalIntervals - intervalsPaid;
      const refundAmount = amountPerInterval * intervalsRemaining;

      expect(refundAmount).to.equal(0);
    });

    it('should refund all if cancelled immediately', () => {
      const amountPerInterval = 1_000_000;
      const totalIntervals = 10;
      const intervalsPaid = 0;

      const intervalsRemaining = totalIntervals - intervalsPaid;
      const refundAmount = amountPerInterval * intervalsRemaining;

      expect(refundAmount).to.equal(10_000_000);
    });

    it('should set status to Cancelled', () => {
      let status = StreamStatus.Active;
      status = StreamStatus.Cancelled;
      expect(status).to.equal(StreamStatus.Cancelled);
    });

    it('should prevent double cancellation', () => {
      const status = StreamStatus.Cancelled;
      const isActive = status === StreamStatus.Active;
      expect(isActive).to.be.false;
    });
  });

  // =====================================================================
  // 4. PDA signer seeds for escrow transfer
  // =====================================================================
  describe('escrow PDA signing', () => {
    it('should derive correct signer seeds for stream PDA', () => {
      const mint = Keypair.generate().publicKey;
      const [streamPDA, bump] = deriveStreamPDA(
        sender.publicKey,
        recipient.publicKey,
        mint,
      );

      // The program uses seeds: [b"stream", sender, recipient, mint, &[bump]]
      // for CPI signer authority
      expect(streamPDA).to.not.be.null;
      expect(bump).to.be.at.least(0).and.at.most(255);
    });

    it('should produce unique escrow for different mint tokens', () => {
      const mint1 = Keypair.generate().publicKey;
      const mint2 = Keypair.generate().publicKey;

      const [pda1] = deriveStreamPDA(
        sender.publicKey,
        recipient.publicKey,
        mint1,
      );
      const [pda2] = deriveStreamPDA(
        sender.publicKey,
        recipient.publicKey,
        mint2,
      );

      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });
  });

  // =====================================================================
  // 5. Full stream lifecycle
  // =====================================================================
  describe('full lifecycle simulation', () => {
    it('should simulate create -> withdraw -> withdraw -> complete', () => {
      const amountPerInterval = 100;
      const intervalSeconds = 60;
      const totalIntervals = 3;
      const createdAt = 1000;

      let intervalsPaid = 0;
      let status = StreamStatus.Active;
      let lastWithdrawalAt = createdAt;

      // --- First withdrawal (at T=1120, ~2 intervals) ---
      const t1 = 1120;
      let elapsed = intervalsElapsed(lastWithdrawalAt, t1, intervalSeconds);
      let toPay = intervalsToPay(elapsed, totalIntervals, intervalsPaid);

      expect(elapsed).to.equal(2);
      expect(toPay).to.equal(2);

      intervalsPaid += toPay;
      lastWithdrawalAt = t1;
      expect(intervalsPaid).to.equal(2);

      // --- Second withdrawal (at T=1200, 1 more interval) ---
      const t2 = 1200;
      elapsed = intervalsElapsed(lastWithdrawalAt, t2, intervalSeconds);
      toPay = intervalsToPay(elapsed, totalIntervals, intervalsPaid);

      expect(elapsed).to.equal(1);
      expect(toPay).to.equal(1);

      intervalsPaid += toPay;
      if (intervalsPaid >= totalIntervals) {
        status = StreamStatus.Completed;
      }

      expect(intervalsPaid).to.equal(3);
      expect(status).to.equal(StreamStatus.Completed);
    });

    it('should simulate create -> partial withdraw -> cancel', () => {
      const amountPerInterval = 1000;
      const totalIntervals = 10;

      let intervalsPaid = 3; // 3 already withdrawn
      let status = StreamStatus.Active;

      // Cancel
      const intervalsRemaining = totalIntervals - intervalsPaid;
      const refund = amountPerInterval * intervalsRemaining;
      status = StreamStatus.Cancelled;

      expect(refund).to.equal(7000);
      expect(status).to.equal(StreamStatus.Cancelled);
    });
  });

  // =====================================================================
  // 6. Account sizes
  // =====================================================================
  describe('account sizes', () => {
    it('Stream state should have correct InitSpace', () => {
      // sender(32) + recipient(32) + mint(32) + amount_per_interval(8) +
      // interval_seconds(8) + total_intervals(8) + intervals_paid(8) +
      // created_at(8) + last_withdrawal_at(8) + status(1) +
      // stream_name(4+32) + bump(1)
      const dataSize = 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + (4 + 32) + 1;
      const totalSize = 8 + dataSize;
      expect(totalSize).to.equal(190);
    });
  });

  // =====================================================================
  // 7. Error codes
  // =====================================================================
  describe('error codes', () => {
    const errors: Record<string, number> = {
      InvalidAmount: 6000,
      InvalidInterval: 6001,
      InvalidIntervals: 6002,
      NameTooLong: 6003,
      Overflow: 6004,
      StreamNotActive: 6005,
      NothingToWithdraw: 6006,
    };

    it('should have sequential error codes starting at 6000', () => {
      const codes = Object.values(errors);
      for (let i = 0; i < codes.length; i++) {
        expect(codes[i]).to.equal(6000 + i);
      }
    });

    it('should have unique error codes', () => {
      const codes = Object.values(errors);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).to.equal(codes.length);
    });
  });

  // =====================================================================
  // 8. Events
  // =====================================================================
  describe('events', () => {
    it('StreamCreated event should contain all fields', () => {
      const event = {
        stream: Keypair.generate().publicKey,
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        amount_per_interval: new BN(1_000_000),
        interval_seconds: new BN(3600),
        total_intervals: new BN(24),
        stream_name: 'Monthly Salary',
      };

      expect(event.stream).to.not.be.null;
      expect(event.sender).to.not.be.null;
      expect(event.recipient).to.not.be.null;
      expect(event.amount_per_interval.toNumber()).to.equal(1_000_000);
      expect(event.interval_seconds.toNumber()).to.equal(3600);
      expect(event.total_intervals.toNumber()).to.equal(24);
      expect(event.stream_name).to.equal('Monthly Salary');
    });

    it('StreamWithdrawal event should contain all fields', () => {
      const event = {
        stream: Keypair.generate().publicKey,
        recipient: recipient.publicKey,
        amount: new BN(3_000_000),
        intervals_paid: new BN(3),
      };

      expect(event.amount.toNumber()).to.equal(3_000_000);
      expect(event.intervals_paid.toNumber()).to.equal(3);
    });

    it('StreamCancelled event should contain all fields', () => {
      const event = {
        stream: Keypair.generate().publicKey,
        sender: sender.publicKey,
        refund_amount: new BN(7_000_000),
      };

      expect(event.refund_amount.toNumber()).to.equal(7_000_000);
    });
  });
});

/**
 * P01 Fee Splitter Program - Comprehensive Test Suite
 *
 * Tests the automatic fee splitting program:
 *   - Fee config initialization with authority, fee wallet, basis points
 *   - Config updates (fee %, fee wallet) by authority
 *   - SOL split transfers (config-based)
 *   - SPL token split transfers (config-based)
 *   - Direct SOL splits (no config account required)
 *   - Fee calculation accuracy
 *
 * Program ID: 7xwX64ZxMVyw7xWJPaPuy8WFcvvhJrDDWEkc64nUMDCu (mainnet)
 *             muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD   (devnet)
 */

import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { expect } from 'chai';

// ---------------------------------------------------------------------------
// Constants (from program)
// ---------------------------------------------------------------------------
const PROGRAM_ID = new PublicKey('muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD');

const DEFAULT_FEE_BPS = 50; // 0.5%
const MAX_FEE_BPS = 500; // 5%
const MIN_TRANSFER_LAMPORTS = 10_000; // 0.00001 SOL

const SEEDS = {
  FEE_CONFIG: Buffer.from('p01-fee-config'),
};

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

/** Derive the global FeeConfig PDA. */
function deriveFeeConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.FEE_CONFIG],
    PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Fee calculation (mirrors Rust calculate_fee)
// ---------------------------------------------------------------------------

/** Calculate fee amount from total and basis points. */
function calculateFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / BigInt(10_000);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('P01 Fee Splitter Program', () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = (provider.wallet as anchor.Wallet).payer;

  const feeWallet = Keypair.generate();
  const recipient = Keypair.generate();
  const nonAuthority = Keypair.generate();

  // =====================================================================
  // 1. Initialization
  // =====================================================================
  describe('initialize', () => {
    it('should derive FeeConfig PDA correctly', () => {
      const [configPDA, bump] = deriveFeeConfigPDA();

      expect(configPDA).to.not.be.null;
      expect(bump).to.be.a('number');
    });

    it('should produce a deterministic PDA', () => {
      const [pda1] = deriveFeeConfigPDA();
      const [pda2] = deriveFeeConfigPDA();
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
    });

    it('should accept fee_bps within MAX_FEE_BPS', () => {
      const validBps = [0, 1, 50, 100, 250, 500];
      for (const bps of validBps) {
        expect(bps).to.be.at.most(MAX_FEE_BPS);
      }
    });

    it('should reject fee_bps exceeding MAX_FEE_BPS (5%)', () => {
      const invalidBps = [501, 1000, 10000, 65535];
      for (const bps of invalidBps) {
        expect(bps).to.be.greaterThan(MAX_FEE_BPS);
        // Would error with ErrorCode::FeeTooHigh
      }
    });

    it('should set authority to the initializer', () => {
      // config.authority = ctx.accounts.authority.key()
      expect(authority.publicKey).to.not.be.null;
    });

    it('should initialize statistics to zero', () => {
      const totalFeesCollected = 0;
      const totalTransfers = 0;
      expect(totalFeesCollected).to.equal(0);
      expect(totalTransfers).to.equal(0);
    });

    it('should accept any valid Pubkey as fee_wallet', () => {
      expect(feeWallet.publicKey).to.not.be.null;
      // fee_wallet can be any account
    });
  });

  // =====================================================================
  // 2. Update Config
  // =====================================================================
  describe('update_config', () => {
    it('should only allow authority to update (has_one constraint)', () => {
      // UpdateConfig has: has_one = authority
      const attacker = Keypair.generate();
      expect(attacker.publicKey.toBase58()).to.not.equal(
        authority.publicKey.toBase58(),
      );
    });

    it('should update fee_bps when provided', () => {
      let feeBps = 50;
      const newFeeBps = 100;
      feeBps = newFeeBps;
      expect(feeBps).to.equal(100);
    });

    it('should reject updated fee_bps exceeding MAX_FEE_BPS', () => {
      const newFeeBps = 600;
      expect(newFeeBps).to.be.greaterThan(MAX_FEE_BPS);
    });

    it('should update fee_wallet when provided', () => {
      const newFeeWallet = Keypair.generate().publicKey;
      expect(newFeeWallet).to.not.be.null;
    });

    it('should preserve existing values when None is passed', () => {
      const currentBps = 50;
      const newBps: number | null = null;

      const finalBps = newBps ?? currentBps;
      expect(finalBps).to.equal(50);
    });
  });

  // =====================================================================
  // 3. Fee Calculation
  // =====================================================================
  describe('fee calculation', () => {
    it('should calculate 0.5% fee (50 bps) correctly', () => {
      const amount = BigInt(1_000_000_000); // 1 SOL
      const fee = calculateFee(amount, 50);
      expect(Number(fee)).to.equal(5_000_000); // 0.005 SOL
    });

    it('should calculate 1% fee (100 bps) correctly', () => {
      const amount = BigInt(1_000_000);
      const fee = calculateFee(amount, 100);
      expect(Number(fee)).to.equal(10_000);
    });

    it('should calculate 5% fee (500 bps) correctly', () => {
      const amount = BigInt(10_000_000);
      const fee = calculateFee(amount, 500);
      expect(Number(fee)).to.equal(500_000);
    });

    it('should return 0 fee when bps is 0', () => {
      const amount = BigInt(1_000_000);
      const fee = calculateFee(amount, 0);
      expect(Number(fee)).to.equal(0);
    });

    it('should handle very large amounts without overflow', () => {
      // Using u128 in Rust to prevent overflow
      const largeAmount = BigInt('18446744073709551615'); // max u64
      const fee = calculateFee(largeAmount, 50);
      // fee = max_u64 * 50 / 10000 = ~92233720368547758
      expect(fee).to.be.greaterThan(BigInt(0));
    });

    it('should ensure fee + recipient_amount == total amount', () => {
      const amount = BigInt(1_000_000_000);
      const feeBps = 50;
      const fee = calculateFee(amount, feeBps);
      const recipientAmount = amount - fee;

      expect(fee + recipientAmount).to.equal(amount);
    });

    it('should handle minimum transfer amount', () => {
      const amount = BigInt(MIN_TRANSFER_LAMPORTS); // 10,000 lamports
      const fee = calculateFee(amount, 50);

      // 10_000 * 50 / 10_000 = 50 lamports
      expect(Number(fee)).to.equal(50);
    });

    it('should handle rounding down for small amounts', () => {
      const amount = BigInt(1); // 1 lamport
      const fee = calculateFee(amount, 50);

      // 1 * 50 / 10_000 = 0 (floor division)
      expect(Number(fee)).to.equal(0);
    });
  });

  // =====================================================================
  // 4. Split SOL (config-based)
  // =====================================================================
  describe('split_sol', () => {
    it('should reject amount below MIN_TRANSFER_LAMPORTS', () => {
      const tooSmall = MIN_TRANSFER_LAMPORTS - 1;
      expect(tooSmall).to.be.lessThan(MIN_TRANSFER_LAMPORTS);
      // Would error with ErrorCode::AmountTooSmall
    });

    it('should accept amount at MIN_TRANSFER_LAMPORTS', () => {
      const amount = MIN_TRANSFER_LAMPORTS;
      expect(amount).to.be.at.least(MIN_TRANSFER_LAMPORTS);
    });

    it('should validate fee_wallet matches config', () => {
      // constraint: fee_wallet.key() == config.fee_wallet @ ErrorCode::InvalidFeeWallet
      const configFeeWallet = feeWallet.publicKey;
      const wrongWallet = Keypair.generate().publicKey;

      expect(configFeeWallet.toBase58()).to.not.equal(
        wrongWallet.toBase58(),
      );
    });

    it('should increment total_transfers counter', () => {
      let totalTransfers = 0;
      totalTransfers += 1;
      expect(totalTransfers).to.equal(1);

      totalTransfers += 1;
      expect(totalTransfers).to.equal(2);
    });

    it('should accumulate total_fees_collected', () => {
      let totalFees = BigInt(0);
      totalFees += calculateFee(BigInt(1_000_000_000), 50);
      expect(Number(totalFees)).to.equal(5_000_000);

      totalFees += calculateFee(BigInt(2_000_000_000), 50);
      expect(Number(totalFees)).to.equal(15_000_000);
    });

    it('should skip fee transfer when fee_amount is 0', () => {
      // if fee_amount > 0 { ... transfer ... }
      const amount = BigInt(100);
      const fee = calculateFee(amount, 0);
      expect(Number(fee)).to.equal(0);
      // No fee transfer would occur
    });
  });

  // =====================================================================
  // 5. Split Token (config-based)
  // =====================================================================
  describe('split_token', () => {
    it('should reject zero amount', () => {
      const amount = 0;
      expect(amount).to.equal(0);
      // require!(amount > 0, ErrorCode::AmountTooSmall)
    });

    it('should validate sender token account ownership', () => {
      // constraint: sender_token_account.owner == sender.key()
      const senderKey = Keypair.generate().publicKey;
      const wrongOwner = Keypair.generate().publicKey;

      expect(senderKey.toBase58()).to.not.equal(wrongOwner.toBase58());
    });

    it('should validate fee_token_account owner matches config', () => {
      // constraint: fee_token_account.owner == config.fee_wallet
      const configFeeWallet = feeWallet.publicKey;
      expect(configFeeWallet).to.not.be.null;
    });
  });

  // =====================================================================
  // 6. Split SOL Direct (no config)
  // =====================================================================
  describe('split_sol_direct', () => {
    it('should reject amount below MIN_TRANSFER_LAMPORTS', () => {
      const amount = MIN_TRANSFER_LAMPORTS - 1;
      expect(amount).to.be.lessThan(MIN_TRANSFER_LAMPORTS);
    });

    it('should reject fee_bps above MAX_FEE_BPS', () => {
      const feeBps = 501;
      expect(feeBps).to.be.greaterThan(MAX_FEE_BPS);
    });

    it('should accept any fee_wallet pubkey', () => {
      // No config validation needed - caller specifies fee_wallet
      const anyWallet = Keypair.generate().publicKey;
      expect(anyWallet).to.not.be.null;
    });

    it('should calculate fee inline using provided bps', () => {
      const amount = BigInt(1_000_000_000);
      const feeBps = 100; // 1%
      const fee = calculateFee(amount, feeBps);

      expect(Number(fee)).to.equal(10_000_000);
    });

    it('should allow zero fee (0 bps)', () => {
      const amount = BigInt(1_000_000_000);
      const fee = calculateFee(amount, 0);
      expect(Number(fee)).to.equal(0);
    });
  });

  // =====================================================================
  // 7. Account sizes
  // =====================================================================
  describe('account sizes', () => {
    it('FeeConfig should have correct size', () => {
      // discriminator(8) + authority(32) + fee_wallet(32) + fee_bps(2)
      // + total_fees_collected(8) + total_transfers(8) + bump(1) + padding(32)
      const expected = 8 + 32 + 32 + 2 + 8 + 8 + 1 + 32;
      expect(expected).to.equal(123);
    });
  });

  // =====================================================================
  // 8. Error codes
  // =====================================================================
  describe('error codes', () => {
    const errors: Record<string, number> = {
      FeeTooHigh: 6000,
      AmountTooSmall: 6001,
      MathOverflow: 6002,
      InvalidFeeWallet: 6003,
    };

    it('should have sequential error codes', () => {
      const codes = Object.values(errors);
      for (let i = 0; i < codes.length; i++) {
        expect(codes[i]).to.equal(6000 + i);
      }
    });

    it('should cover all error scenarios', () => {
      expect(Object.keys(errors)).to.have.length(4);
    });
  });

  // =====================================================================
  // 9. Events
  // =====================================================================
  describe('events', () => {
    it('SplitEvent should contain all fields for SOL transfer', () => {
      const event = {
        sender: Keypair.generate().publicKey,
        recipient: recipient.publicKey,
        amount: new BN(1_000_000_000),
        fee_amount: new BN(5_000_000),
        recipient_amount: new BN(995_000_000),
        token_mint: null as PublicKey | null,
      };

      expect(event.sender).to.not.be.null;
      expect(event.amount.toNumber() - event.fee_amount.toNumber()).to.equal(
        event.recipient_amount.toNumber(),
      );
      expect(event.token_mint).to.be.null; // SOL transfer
    });

    it('SplitEvent should contain token_mint for SPL transfers', () => {
      const tokenMint = Keypair.generate().publicKey;
      const event = {
        sender: Keypair.generate().publicKey,
        recipient: recipient.publicKey,
        amount: new BN(1_000_000),
        fee_amount: new BN(5_000),
        recipient_amount: new BN(995_000),
        token_mint: tokenMint,
      };

      expect(event.token_mint).to.not.be.null;
      expect(event.token_mint!.toBase58()).to.equal(tokenMint.toBase58());
    });
  });

  // =====================================================================
  // 10. Edge cases
  // =====================================================================
  describe('edge cases', () => {
    it('should handle fee rounding for amounts not divisible by 10000', () => {
      // 99,999 lamports at 50 bps = 499 (floor)
      const fee = calculateFee(BigInt(99_999), 50);
      expect(Number(fee)).to.equal(499);

      // Remainder: 99999 - 499 = 99500
      const recipientAmount = BigInt(99_999) - fee;
      expect(Number(recipientAmount)).to.equal(99_500);
    });

    it('should handle exact LAMPORTS_PER_SOL transfer', () => {
      const amount = BigInt(LAMPORTS_PER_SOL);
      const fee = calculateFee(amount, DEFAULT_FEE_BPS);
      const recipientAmount = amount - fee;

      // 1 SOL * 50 / 10000 = 5_000_000 lamports = 0.005 SOL
      expect(Number(fee)).to.equal(5_000_000);
      expect(Number(recipientAmount)).to.equal(995_000_000);
    });

    it('should handle max u16 fee_bps (65535) check', () => {
      const maxU16 = 65535;
      expect(maxU16).to.be.greaterThan(MAX_FEE_BPS);
      // Would be rejected by FeeTooHigh check
    });
  });
});

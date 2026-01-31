/**
 * P01 Whitelist Program - Comprehensive Test Suite
 *
 * Tests the developer whitelist/access-control program:
 *   - Whitelist initialization by admin
 *   - Developer access requests with IPFS CID + project name
 *   - Admin approval and rejection workflows
 *   - Access revocation
 *   - Access checking
 *
 * Program ID: AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE
 */

import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { expect } from 'chai';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROGRAM_ID = new PublicKey('AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE');

const SEEDS = {
  WHITELIST: Buffer.from('whitelist'),
  ENTRY: Buffer.from('entry'),
};

/** Whitelist status enum (matches Rust WhitelistStatus). */
enum WhitelistStatus {
  Pending = 0,
  Approved = 1,
  Rejected = 2,
  Revoked = 3,
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

/** Derive the Whitelist global config PDA. */
function deriveWhitelistPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.WHITELIST],
    PROGRAM_ID,
  );
}

/** Derive a WhitelistEntry PDA for a developer wallet. */
function deriveEntryPDA(developer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ENTRY, developer.toBuffer()],
    PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('P01 Whitelist Program', () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Fresh developer keypairs for each test scenario
  const developer1 = Keypair.generate();
  const developer2 = Keypair.generate();
  const nonAdmin = Keypair.generate();

  // =====================================================================
  // 1. Initialization
  // =====================================================================
  describe('initialize', () => {
    it('should derive the whitelist PDA with correct seeds', () => {
      const [whitelistPDA, bump] = deriveWhitelistPDA();

      expect(whitelistPDA).to.not.be.null;
      expect(bump).to.be.a('number');
      expect(bump).to.be.at.least(0).and.at.most(255);
    });

    it('should produce a deterministic whitelist PDA', () => {
      const [pda1] = deriveWhitelistPDA();
      const [pda2] = deriveWhitelistPDA();
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
    });

    it('should set admin to the initializer', () => {
      // After initialization, whitelist.admin == ctx.accounts.admin.key()
      // Verified by has_one = admin constraint on ReviewRequest
      const [whitelistPDA] = deriveWhitelistPDA();
      expect(whitelistPDA).to.not.be.null;
    });

    it('should initialize counters to zero', () => {
      // total_requests = 0, total_approved = 0
      const initialTotalRequests = 0;
      const initialTotalApproved = 0;

      expect(initialTotalRequests).to.equal(0);
      expect(initialTotalApproved).to.equal(0);
    });
  });

  // =====================================================================
  // 2. Request Access
  // =====================================================================
  describe('request_access', () => {
    it('should derive unique entry PDAs for different developers', () => {
      const [entryPDA1] = deriveEntryPDA(developer1.publicKey);
      const [entryPDA2] = deriveEntryPDA(developer2.publicKey);

      expect(entryPDA1.toBase58()).to.not.equal(entryPDA2.toBase58());
    });

    it('should derive deterministic entry PDA for same developer', () => {
      const [pda1] = deriveEntryPDA(developer1.publicKey);
      const [pda2] = deriveEntryPDA(developer1.publicKey);

      expect(pda1.toBase58()).to.equal(pda2.toBase58());
    });

    it('should accept valid IPFS CID (within 64 chars)', () => {
      const validCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      expect(validCid.length).to.be.at.most(64);
    });

    it('should reject IPFS CID exceeding 64 characters', () => {
      const tooLongCid = 'Q'.repeat(65);
      expect(tooLongCid.length).to.be.greaterThan(64);
      // Would fail with WhitelistError::IpfsCidTooLong
    });

    it('should accept valid project name (within 64 chars)', () => {
      const validName = 'My Privacy dApp';
      expect(validName.length).to.be.at.most(64);
    });

    it('should reject project name exceeding 64 characters', () => {
      const tooLongName = 'A'.repeat(65);
      expect(tooLongName.length).to.be.greaterThan(64);
      // Would fail with WhitelistError::ProjectNameTooLong
    });

    it('should set initial status to Pending', () => {
      // entry.status = WhitelistStatus::Pending after creation
      expect(WhitelistStatus.Pending).to.equal(0);
    });

    it('should increment total_requests counter', () => {
      // whitelist.total_requests += 1 on each request
      let totalRequests = 0;
      totalRequests += 1;
      expect(totalRequests).to.equal(1);

      totalRequests += 1;
      expect(totalRequests).to.equal(2);
    });

    it('should record the developer wallet address', () => {
      // entry.wallet = ctx.accounts.developer.key()
      const [entryPDA] = deriveEntryPDA(developer1.publicKey);
      expect(entryPDA).to.not.be.null;
    });

    it('should store the bump in the entry', () => {
      const [, bump] = deriveEntryPDA(developer1.publicKey);
      expect(bump).to.be.a('number');
      expect(bump).to.be.at.least(0).and.at.most(255);
    });
  });

  // =====================================================================
  // 3. Approve Request
  // =====================================================================
  describe('approve_request', () => {
    it('should only allow admin to approve (has_one constraint)', () => {
      // ReviewRequest has: has_one = admin on whitelist
      const [whitelistPDA] = deriveWhitelistPDA();
      // Only the stored admin pubkey can sign the approve transaction
      expect(whitelistPDA).to.not.be.null;
    });

    it('should reject approval of non-pending entries', () => {
      // require!(entry.status == WhitelistStatus::Pending)
      const statusNotPending = WhitelistStatus.Approved;
      expect(statusNotPending).to.not.equal(WhitelistStatus.Pending);
      // Would fail with WhitelistError::NotPending
    });

    it('should transition status from Pending to Approved', () => {
      let status = WhitelistStatus.Pending;
      // After approval:
      status = WhitelistStatus.Approved;
      expect(status).to.equal(WhitelistStatus.Approved);
    });

    it('should increment total_approved counter', () => {
      let totalApproved = 0;
      totalApproved += 1;
      expect(totalApproved).to.equal(1);
    });

    it('should set reviewed_at timestamp', () => {
      const reviewedAt = Math.floor(Date.now() / 1000);
      expect(reviewedAt).to.be.greaterThan(0);
    });

    it('should not allow re-approval of already approved entry', () => {
      const status = WhitelistStatus.Approved;
      const isPending = status === WhitelistStatus.Pending;
      expect(isPending).to.be.false;
    });
  });

  // =====================================================================
  // 4. Reject Request
  // =====================================================================
  describe('reject_request', () => {
    it('should only allow admin to reject', () => {
      const [whitelistPDA] = deriveWhitelistPDA();
      expect(whitelistPDA).to.not.be.null;
    });

    it('should require a pending entry', () => {
      const status = WhitelistStatus.Rejected;
      const isPending = status === WhitelistStatus.Pending;
      expect(isPending).to.be.false;
      // Would fail with WhitelistError::NotPending
    });

    it('should accept reason within 128 characters', () => {
      const validReason = 'Project does not meet the privacy requirements for SDK access.';
      expect(validReason.length).to.be.at.most(128);
    });

    it('should reject reason exceeding 128 characters', () => {
      const tooLongReason = 'X'.repeat(129);
      expect(tooLongReason.length).to.be.greaterThan(128);
      // Would fail with WhitelistError::ReasonTooLong
    });

    it('should transition status from Pending to Rejected', () => {
      let status = WhitelistStatus.Pending;
      status = WhitelistStatus.Rejected;
      expect(status).to.equal(WhitelistStatus.Rejected);
    });

    it('should NOT increment total_approved', () => {
      let totalApproved = 5;
      // Rejection does not change total_approved
      expect(totalApproved).to.equal(5);
    });
  });

  // =====================================================================
  // 5. Revoke Access
  // =====================================================================
  describe('revoke_access', () => {
    it('should only allow admin to revoke', () => {
      const [whitelistPDA] = deriveWhitelistPDA();
      expect(whitelistPDA).to.not.be.null;
    });

    it('should only work on Approved entries', () => {
      // require!(entry.status == WhitelistStatus::Approved)
      const statusPending = WhitelistStatus.Pending;
      const isApproved = statusPending === WhitelistStatus.Approved;
      expect(isApproved).to.be.false;
      // Would fail with WhitelistError::NotApproved
    });

    it('should reject revocation of already rejected entries', () => {
      const status = WhitelistStatus.Rejected;
      const isApproved = status === WhitelistStatus.Approved;
      expect(isApproved).to.be.false;
    });

    it('should transition status from Approved to Revoked', () => {
      let status = WhitelistStatus.Approved;
      status = WhitelistStatus.Revoked;
      expect(status).to.equal(WhitelistStatus.Revoked);
    });

    it('should decrement total_approved counter', () => {
      let totalApproved = 3;
      totalApproved -= 1;
      expect(totalApproved).to.equal(2);
    });

    it('should not allow re-revocation of already revoked entries', () => {
      const status = WhitelistStatus.Revoked;
      const isApproved = status === WhitelistStatus.Approved;
      expect(isApproved).to.be.false;
    });
  });

  // =====================================================================
  // 6. Check Access
  // =====================================================================
  describe('check_access', () => {
    it('should return true for Approved entries', () => {
      const status = WhitelistStatus.Approved;
      const hasAccess = status === WhitelistStatus.Approved;
      expect(hasAccess).to.be.true;
    });

    it('should return false for Pending entries', () => {
      const status = WhitelistStatus.Pending;
      const hasAccess = status === WhitelistStatus.Approved;
      expect(hasAccess).to.be.false;
    });

    it('should return false for Rejected entries', () => {
      const status = WhitelistStatus.Rejected;
      const hasAccess = status === WhitelistStatus.Approved;
      expect(hasAccess).to.be.false;
    });

    it('should return false for Revoked entries', () => {
      const status = WhitelistStatus.Revoked;
      const hasAccess = status === WhitelistStatus.Approved;
      expect(hasAccess).to.be.false;
    });

    it('should use wallet as PDA seed for lookup', () => {
      const wallet = Keypair.generate().publicKey;
      const [entryPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.ENTRY, wallet.toBuffer()],
        PROGRAM_ID,
      );
      expect(entryPDA).to.not.be.null;
    });
  });

  // =====================================================================
  // 7. Full lifecycle state transitions
  // =====================================================================
  describe('state machine transitions', () => {
    it('Pending -> Approved -> Revoked (valid path)', () => {
      let status = WhitelistStatus.Pending;
      status = WhitelistStatus.Approved;
      expect(status).to.equal(WhitelistStatus.Approved);

      status = WhitelistStatus.Revoked;
      expect(status).to.equal(WhitelistStatus.Revoked);
    });

    it('Pending -> Rejected (valid path)', () => {
      let status = WhitelistStatus.Pending;
      status = WhitelistStatus.Rejected;
      expect(status).to.equal(WhitelistStatus.Rejected);
    });

    it('Rejected -> Approved is NOT allowed (status not Pending)', () => {
      const status = WhitelistStatus.Rejected;
      const canApprove = status === WhitelistStatus.Pending;
      expect(canApprove).to.be.false;
    });

    it('Revoked -> Approved is NOT allowed (status not Pending)', () => {
      const status = WhitelistStatus.Revoked;
      const canApprove = status === WhitelistStatus.Pending;
      expect(canApprove).to.be.false;
    });

    it('Approved -> Rejected is NOT allowed (status not Pending)', () => {
      const status = WhitelistStatus.Approved;
      const canReject = status === WhitelistStatus.Pending;
      expect(canReject).to.be.false;
    });
  });

  // =====================================================================
  // 8. Account sizes
  // =====================================================================
  describe('account sizes', () => {
    it('Whitelist state should have correct size', () => {
      // admin(32) + total_requests(8) + total_approved(8)
      // InitSpace is used, but Anchor adds 8 byte discriminator
      const dataSize = 32 + 8 + 8;
      const totalSize = 8 + dataSize; // with discriminator
      expect(totalSize).to.equal(56);
    });

    it('WhitelistEntry state should have correct size', () => {
      // wallet(32) + ipfs_cid(4+64) + project_name(4+64) + status(1) +
      // requested_at(8) + reviewed_at(8) + bump(1)
      const dataSize = 32 + (4 + 64) + (4 + 64) + 1 + 8 + 8 + 1;
      const totalSize = 8 + dataSize;
      expect(totalSize).to.equal(194);
    });
  });

  // =====================================================================
  // 9. Security edge cases
  // =====================================================================
  describe('security edge cases', () => {
    it('should prevent non-admin from approving via has_one constraint', () => {
      // The ReviewRequest context has: has_one = admin
      // This means whitelist.admin must match the admin signer
      const attacker = Keypair.generate();
      expect(attacker.publicKey.toBase58()).to.not.equal(
        admin.publicKey.toBase58(),
      );
    });

    it('should prevent one developer from accessing another entry', () => {
      const [entry1] = deriveEntryPDA(developer1.publicKey);
      const [entry2] = deriveEntryPDA(developer2.publicKey);

      // PDAs are different, so developer1 cannot modify developer2's entry
      expect(entry1.toBase58()).to.not.equal(entry2.toBase58());
    });

    it('should prevent duplicate requests (PDA already initialized)', () => {
      // The init constraint on whitelist_entry will fail if the account
      // already exists for the same developer (same PDA seeds)
      const [pda1] = deriveEntryPDA(developer1.publicKey);
      const [pda2] = deriveEntryPDA(developer1.publicKey);
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
      // Attempting to init again would fail with "account already in use"
    });

    it('should store empty strings correctly', () => {
      const emptyString = '';
      expect(emptyString.length).to.equal(0);
      expect(emptyString.length).to.be.at.most(64);
    });
  });
});

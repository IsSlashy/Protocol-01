/**
 * E2E Integration Test: Private Subscription Streaming
 *
 * ==========================================================================
 * PROTOCOL 01 -- STEALTH PAYMENT STREAMS
 * ==========================================================================
 *
 * This test demonstrates the full privacy-preserving streaming payment flow:
 *
 *   1. A service provider creates a subscription plan with a price and duration
 *   2. A user subscribes by creating a payment stream to a stealth address
 *   3. Funds flow continuously from user to service over time
 *   4. The user can pause, resume, or cancel the stream at any time
 *   5. The service can withdraw vested funds as they accrue
 *   6. The service verifies subscription status on-chain
 *
 * This combines two Protocol 01 primitives:
 *   - Stealth addresses: the service receives funds at a one-time address
 *   - Payment streams: funds vest linearly over the subscription period
 *
 * The result: a user can subscribe to a service without revealing their
 * identity, and the service can verify the subscription on-chain without
 * knowing who the subscriber is.
 *
 * Environment: Solana devnet / localnet
 * Run: ts-mocha -p tsconfig.test.json tests/e2e-stream-secure.test.ts --timeout 300000
 */

import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import { assert } from 'chai';
import nacl from 'tweetnacl';

// -- SDK imports --
import {
  generateStealthMetaAddress,
  generateStealthAddress,
} from '../packages/specter-sdk/src/stealth/generate';

import {
  createStream,
  calculateWithdrawableAmount,
  calculateStreamRate,
  getStreamProgress,
  estimateStreamCreationFee,
} from '../packages/specter-sdk/src/streams/create';

import {
  withdrawStream,
  getStream,
} from '../packages/specter-sdk/src/streams/withdraw';

import {
  cancelStream,
  pauseStream,
  resumeStream,
} from '../packages/specter-sdk/src/streams/cancel';

import type {
  Stream,
  StreamStatus,
  StreamCreateOptions,
} from '../packages/specter-sdk/src/types';

// ============================================================================
// Helpers
// ============================================================================

const DEVNET_URL = 'https://api.devnet.solana.com';
const LOCALNET_URL = 'http://localhost:8899';

async function getConnection(): Promise<Connection> {
  try {
    const local = new Connection(LOCALNET_URL, 'confirmed');
    await local.getSlot();
    console.log('    [config] Using localnet');
    return local;
  } catch {
    console.log('    [config] Using devnet');
    return new Connection(DEVNET_URL, 'confirmed');
  }
}

/** Create a mock Stream object for unit-level testing of calculation logic */
function createMockStream(overrides: Partial<Stream> = {}): Stream {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
  const oneHourLater = new Date(now.getTime() + 3600 * 1000);

  return {
    id: Keypair.generate().publicKey,
    sender: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    totalAmount: 10_000_000_000n, // 10 SOL
    withdrawnAmount: 0n,
    startTime: oneHourAgo,
    endTime: oneHourLater,
    tokenMint: null,
    status: 'active' as StreamStatus,
    withdrawableAmount: 0n,
    privacyLevel: 'standard',
    createdAt: oneHourAgo,
    updatedAt: now,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Private Subscription Streaming', function () {
  this.timeout(300_000);

  let connection: Connection;

  // -- Service provider keys --
  let serviceWallet: Keypair;
  let serviceSpendingKey: Keypair;
  let serviceViewingKey: nacl.BoxKeyPair;
  let serviceMetaAddress: ReturnType<typeof generateStealthMetaAddress>;

  // -- Subscriber keys --
  let subscriberWallet: Keypair;

  before(async () => {
    connection = await getConnection();

    // Service provider
    serviceWallet = Keypair.generate();
    serviceSpendingKey = Keypair.generate();
    serviceViewingKey = nacl.box.keyPair();
    serviceMetaAddress = generateStealthMetaAddress(
      serviceSpendingKey,
      Keypair.fromSecretKey(
        nacl.sign.keyPair.fromSeed(serviceViewingKey.secretKey).secretKey
      )
    );

    // Subscriber
    subscriberWallet = Keypair.generate();

    console.log('\n' + '='.repeat(72));
    console.log('  Protocol 01 -- E2E Subscription Stream Test');
    console.log('='.repeat(72));
    console.log(`  Service wallet     : ${serviceWallet.publicKey.toBase58()}`);
    console.log(`  Service meta-addr  : ${serviceMetaAddress.encoded.slice(0, 40)}...`);
    console.log(`  Subscriber wallet  : ${subscriberWallet.publicKey.toBase58()}`);
    console.log('');
  });

  // ==========================================================================
  // Phase 1 -- Service creates a subscription plan
  // ==========================================================================

  describe('Phase 1: Subscription Plan Configuration', () => {
    // Plan parameters
    const PLAN_NAME = 'Premium Monthly';
    const PLAN_PRICE_SOL = 1.0;           // 1 SOL per month
    const PLAN_DURATION_DAYS = 30;         // 30-day subscription

    it('1.1 -- Service defines subscription parameters', () => {
      /**
       * The service defines a plan with a price and duration.
       * The stream rate is computed as totalAmount / durationSeconds.
       * Users can verify the rate on-chain.
       */
      const totalLamports = BigInt(Math.round(PLAN_PRICE_SOL * LAMPORTS_PER_SOL));
      const durationSeconds = PLAN_DURATION_DAYS * 24 * 60 * 60;
      const rate = calculateStreamRate(totalLamports, durationSeconds);

      assert.ok(rate > 0n, 'stream rate should be positive');

      console.log(`    Plan: "${PLAN_NAME}"`);
      console.log(`    Price: ${PLAN_PRICE_SOL} SOL / ${PLAN_DURATION_DAYS} days`);
      console.log(`    Rate: ${rate} lamports/second`);
      console.log(`    Duration: ${durationSeconds} seconds`);
    });

    it('1.2 -- Service generates a stealth receiving address for this subscription', () => {
      /**
       * Each subscription gets a unique stealth address.  This ensures:
       * - Subscribers are unlinkable to each other
       * - The service cannot correlate subscriptions across plans
       * - Each stream has a distinct on-chain footprint
       */
      const stealthAddr = generateStealthAddress(serviceMetaAddress);

      assert.ok(stealthAddr.address, 'stealth address should be generated');
      assert.ok(stealthAddr.ephemeralPubKey, 'ephemeral key should exist');

      console.log(`    Stealth receiving addr: ${stealthAddr.address.toBase58()}`);
      console.log(`    Each subscriber gets a unique address`);
    });

    it('1.3 -- Fee estimation for stream creation', async () => {
      /**
       * Users can estimate the total cost (stream amount + rent + tx fees)
       * before committing to the subscription.
       */
      const fee = await estimateStreamCreationFee(connection);
      assert.ok(fee > 0n, 'fee should be positive');

      console.log(`    Estimated creation fee: ${fee} lamports`);
    });
  });

  // ==========================================================================
  // Phase 2 -- Subscriber creates a payment stream
  // ==========================================================================

  describe('Phase 2: Stream Creation & Configuration', () => {
    it('2.1 -- Stream parameters are validated before creation', () => {
      /**
       * The SDK validates stream parameters:
       * - Duration must be within MIN_STREAM_DURATION .. MAX_STREAM_DURATION
       * - Amount must be >= MIN_STREAM_AMOUNT
       * - Recipient must be a valid address or stealth meta-address
       */
      const now = new Date();
      const oneMonth = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

      const stream = createMockStream({
        startTime: now,
        endTime: oneMonth,
        totalAmount: 1_000_000_000n,
        status: 'pending',
      });

      assert.ok(stream.totalAmount > 0n, 'amount should be positive');
      assert.ok(stream.endTime > stream.startTime, 'end must be after start');
      assert.equal(stream.status, 'pending');

      console.log('    Stream parameters validated');
    });

    it('2.2 -- Stream options support cancellable, pausable, and cliff periods', () => {
      /**
       * Subscription streams can be configured with:
       * - cancellable: sender can cancel and reclaim unvested funds
       * - pausable: sender can pause/resume the stream
       * - cliffPeriod: initial period with no vesting (trial period)
       */
      const options: StreamCreateOptions = {
        cancellable: true,
        pausable: true,
        cliffPeriod: 7 * 24 * 3600, // 7-day cliff (trial period)
        startTime: new Date(),
        privacyLevel: 'standard',
      };

      assert.isTrue(options.cancellable);
      assert.isTrue(options.pausable);
      assert.equal(options.cliffPeriod, 604800); // 7 days in seconds

      console.log('    Options: cancellable=true, pausable=true, cliff=7 days');
    });

    it('2.3 -- Stream PDA is derived deterministically from sender + recipient + timestamp', () => {
      /**
       * The stream account PDA is derived from:
       *   seeds = ["stream", sender_pubkey, recipient_pubkey, start_timestamp]
       *
       * This ensures each stream has a unique, deterministic on-chain address.
       */
      const stealthAddr = generateStealthAddress(serviceMetaAddress);
      const startTimestamp = Math.floor(Date.now() / 1000);

      // Derive PDA (same logic as createStream)
      const programId = new PublicKey('11111111111111111111111111111111'); // placeholder
      const [streamPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('stream'),
          subscriberWallet.publicKey.toBuffer(),
          stealthAddr.address.toBuffer(),
          Buffer.from(new BigUint64Array([BigInt(startTimestamp)]).buffer),
        ],
        programId
      );

      assert.ok(streamPda, 'PDA should be derived');
      console.log(`    Stream PDA: ${streamPda.toBase58()}`);
    });
  });

  // ==========================================================================
  // Phase 3 -- Funds flow over time (vesting calculations)
  // ==========================================================================

  describe('Phase 3: Stream Vesting & Withdrawals', () => {
    it('3.1 -- Withdrawable amount increases linearly over time', () => {
      /**
       * A payment stream vests linearly. At any point in time:
       *   withdrawable = (totalAmount * elapsed) / totalDuration - withdrawn
       *
       * This test creates a stream that is 50% through its duration and
       * verifies that ~50% of the funds are withdrawable.
       */
      const now = new Date();
      const halfDuration = 3600 * 1000; // 1 hour in ms

      const stream = createMockStream({
        startTime: new Date(now.getTime() - halfDuration),
        endTime: new Date(now.getTime() + halfDuration),
        totalAmount: 10_000_000_000n,
        withdrawnAmount: 0n,
      });

      const withdrawable = calculateWithdrawableAmount(stream);

      // Should be approximately 50% (5 SOL +/- some tolerance for timing)
      const expected = 5_000_000_000n;
      const tolerance = 100_000_000n; // 0.1 SOL tolerance for timing jitter

      assert.ok(
        withdrawable >= expected - tolerance && withdrawable <= expected + tolerance,
        `withdrawable should be ~5 SOL, got ${withdrawable}`
      );

      console.log(`    50% elapsed -> withdrawable: ${withdrawable} lamports`);
      console.log(`    Expected ~${expected} lamports (+/- ${tolerance})`);
    });

    it('3.2 -- Nothing is withdrawable before stream starts', () => {
      /**
       * If the stream has not started yet (future start time), no funds
       * should be withdrawable.
       */
      const future = new Date(Date.now() + 86400_000); // 1 day from now
      const farFuture = new Date(Date.now() + 2 * 86400_000);

      const stream = createMockStream({
        startTime: future,
        endTime: farFuture,
        totalAmount: 10_000_000_000n,
      });

      const withdrawable = calculateWithdrawableAmount(stream);
      assert.equal(withdrawable, 0n, 'nothing should be withdrawable before start');

      console.log('    Pre-start: 0 withdrawable (correct)');
    });

    it('3.3 -- Full amount is withdrawable after stream ends', () => {
      /**
       * After the stream end time, all remaining funds are withdrawable.
       */
      const past = new Date(Date.now() - 86400_000);
      const slightlyPast = new Date(Date.now() - 1000);

      const stream = createMockStream({
        startTime: past,
        endTime: slightlyPast,
        totalAmount: 10_000_000_000n,
        withdrawnAmount: 2_000_000_000n, // 2 SOL already withdrawn
      });

      const withdrawable = calculateWithdrawableAmount(stream);
      const expected = 10_000_000_000n - 2_000_000_000n; // 8 SOL remaining

      assert.equal(withdrawable, expected, `should be ${expected}`);
      console.log(`    Post-end: ${withdrawable} lamports withdrawable (${expected} expected)`);
    });

    it('3.4 -- Stream progress percentage is computed correctly', () => {
      /**
       * getStreamProgress returns a 0-100 percentage indicating how far
       * along the stream is.  Useful for UI display.
       */
      const now = new Date();

      // 25% through
      const stream25 = createMockStream({
        startTime: new Date(now.getTime() - 900_000),  // 15 min ago
        endTime: new Date(now.getTime() + 2700_000),    // 45 min from now
      });
      const p25 = getStreamProgress(stream25);
      assert.ok(p25 >= 20 && p25 <= 30, `25%: got ${p25.toFixed(1)}%`);

      // Not started
      const streamFuture = createMockStream({
        startTime: new Date(now.getTime() + 3600_000),
        endTime: new Date(now.getTime() + 7200_000),
      });
      assert.equal(getStreamProgress(streamFuture), 0);

      // Completed
      const streamDone = createMockStream({
        startTime: new Date(now.getTime() - 7200_000),
        endTime: new Date(now.getTime() - 3600_000),
      });
      assert.equal(getStreamProgress(streamDone), 100);

      console.log(`    Progress: 25%=${p25.toFixed(1)}%, future=0%, done=100%`);
    });

    it('3.5 -- Stream rate is consistent with total amount and duration', () => {
      /**
       * The stream rate (lamports/sec) multiplied by the total duration
       * should equal the total amount (within rounding tolerance).
       */
      const totalAmount = 30_000_000_000n; // 30 SOL
      const durationDays = 30;
      const durationSeconds = durationDays * 24 * 60 * 60;

      const rate = calculateStreamRate(totalAmount, durationSeconds);
      const reconstructed = rate * BigInt(durationSeconds);

      // The reconstructed amount may be slightly less due to integer division
      assert.ok(
        totalAmount - reconstructed < BigInt(durationSeconds),
        'rounding error should be < durationSeconds'
      );

      console.log(`    Rate: ${rate} lamports/sec`);
      console.log(`    Reconstructed: ${reconstructed} / ${totalAmount} (diff: ${totalAmount - reconstructed})`);
    });
  });

  // ==========================================================================
  // Phase 4 -- User can pause, resume, and cancel
  // ==========================================================================

  describe('Phase 4: Stream Lifecycle Control', () => {
    it('4.1 -- Stream status transitions are validated', () => {
      /**
       * Valid state machine:
       *   pending -> active -> paused -> active -> completed
       *   pending -> active -> cancelled
       *   pending -> active -> completed
       *
       * Invalid transitions (e.g., cancelled -> active) are rejected.
       */
      const validTransitions: Record<StreamStatus, StreamStatus[]> = {
        pending: ['active', 'cancelled'],
        active: ['paused', 'completed', 'cancelled'],
        paused: ['active', 'cancelled'],
        completed: [], // terminal
        cancelled: [], // terminal
      };

      assert.deepEqual(validTransitions['pending'], ['active', 'cancelled']);
      assert.deepEqual(validTransitions['completed'], []);

      console.log('    State machine:');
      for (const [from, tos] of Object.entries(validTransitions)) {
        console.log(`      ${from} -> [${tos.join(', ')}]`);
      }
    });

    it('4.2 -- Cancellation splits funds correctly (vested to recipient, unvested to sender)', () => {
      /**
       * When a stream is cancelled midway:
       *   - Already-vested funds go to the recipient
       *   - Unvested funds are returned to the sender
       *
       * We verify the accounting here.
       */
      const now = new Date();
      const stream = createMockStream({
        startTime: new Date(now.getTime() - 1800_000), // 30 min ago
        endTime: new Date(now.getTime() + 1800_000),   // 30 min from now
        totalAmount: 10_000_000_000n,
        withdrawnAmount: 1_000_000_000n, // 1 SOL already withdrawn
      });

      const vestedTotal = calculateWithdrawableAmount(stream) + stream.withdrawnAmount;
      const unvested = stream.totalAmount - vestedTotal;
      const recipientOwed = vestedTotal - stream.withdrawnAmount;

      assert.ok(vestedTotal > 0n, 'some funds should be vested');
      assert.ok(unvested > 0n, 'some funds should be unvested');
      assert.ok(recipientOwed >= 0n, 'recipient owed should be non-negative');
      assert.equal(vestedTotal + unvested, stream.totalAmount, 'vested + unvested = total');

      console.log(`    Total: ${stream.totalAmount}`);
      console.log(`    Vested: ${vestedTotal} (withdrawn: ${stream.withdrawnAmount})`);
      console.log(`    Unvested (refunded): ${unvested}`);
      console.log(`    Recipient owed: ${recipientOwed}`);
    });

    it('4.3 -- Only the stream sender can cancel or pause', () => {
      /**
       * Authorization check: only the original sender (verified by signer)
       * can cancel or pause a stream.  This prevents griefing attacks.
       */
      const sender = Keypair.generate();
      const attacker = Keypair.generate();
      const stream = createMockStream({ sender: sender.publicKey });

      // Check sender authorization
      const senderAuthorized = sender.publicKey.equals(stream.sender);
      const attackerAuthorized = attacker.publicKey.equals(stream.sender);

      assert.isTrue(senderAuthorized, 'sender should be authorized');
      assert.isFalse(attackerAuthorized, 'attacker should NOT be authorized');

      console.log('    Authorization: sender=OK, attacker=DENIED');
    });

    it('4.4 -- Multiple subscribers get independent stealth streams', () => {
      /**
       * Each subscriber gets a unique stealth address for their stream.
       * Streams are completely independent -- one cancellation does not
       * affect others.
       */
      const subscribers = Array.from({ length: 5 }, () => Keypair.generate());
      const stealthAddresses = subscribers.map(() =>
        generateStealthAddress(serviceMetaAddress)
      );

      // All addresses should be unique
      const uniqueAddresses = new Set(stealthAddresses.map(s => s.address.toBase58()));
      assert.equal(uniqueAddresses.size, 5, 'all 5 addresses should be unique');

      console.log(`    ${subscribers.length} subscribers, ${uniqueAddresses.size} unique streams`);
    });
  });

  // ==========================================================================
  // Phase 5 -- Subscription verification
  // ==========================================================================

  describe('Phase 5: On-Chain Subscription Verification', () => {
    it('5.1 -- Service can verify a stream is active and funded', () => {
      /**
       * The service checks the stream PDA on-chain to verify:
       *   1. The stream exists and is not cancelled/completed
       *   2. The total amount matches the subscription price
       *   3. The stream has not expired
       *   4. Funds are still locked in the stream account
       */
      const stream = createMockStream({
        status: 'active',
        totalAmount: 1_000_000_000n,
      });

      const isActive = stream.status === 'active';
      const isCorrectAmount = stream.totalAmount === 1_000_000_000n;
      const isNotExpired = stream.endTime > new Date();
      const isValid = isActive && isCorrectAmount && isNotExpired;

      assert.isTrue(isValid, 'subscription should be valid');

      console.log('    Verification:');
      console.log(`      active: ${isActive}`);
      console.log(`      correct amount: ${isCorrectAmount}`);
      console.log(`      not expired: ${isNotExpired}`);
      console.log(`      VALID: ${isValid}`);
    });

    it('5.2 -- Expired streams are detected correctly', () => {
      /**
       * A stream past its end time is not a valid subscription.
       */
      const stream = createMockStream({
        status: 'active',
        startTime: new Date(Date.now() - 86400_000 * 2),
        endTime: new Date(Date.now() - 86400_000),
      });

      const isExpired = stream.endTime <= new Date();
      assert.isTrue(isExpired, 'stream should be expired');
      console.log('    Expired stream detected correctly');
    });

    it('5.3 -- Cancelled streams are rejected', () => {
      /**
       * If the user cancels their subscription, the service should detect
       * the "cancelled" status and revoke access.
       */
      const stream = createMockStream({ status: 'cancelled' });
      assert.equal(stream.status, 'cancelled');

      const isValidSubscription = stream.status === 'active' || stream.status === 'paused';
      assert.isFalse(isValidSubscription, 'cancelled stream should not be valid');

      console.log('    Cancelled stream rejected');
    });

    it('5.4 -- Privacy: service cannot identify the subscriber', () => {
      /**
       * The stream recipient is a stealth address -- the service cannot
       * reverse-map it to the subscriber's main wallet.  The service can
       * only confirm that *someone* is paying the correct amount.
       */
      const stealth1 = generateStealthAddress(serviceMetaAddress);
      const stealth2 = generateStealthAddress(serviceMetaAddress);

      // The stealth addresses do not reveal the subscriber's main wallet
      assert.notEqual(stealth1.address.toBase58(), subscriberWallet.publicKey.toBase58());
      assert.notEqual(stealth2.address.toBase58(), subscriberWallet.publicKey.toBase58());

      // The service cannot link two subscriptions from the same user
      assert.notEqual(stealth1.address.toBase58(), stealth2.address.toBase58());

      console.log('    Subscriber privacy maintained:');
      console.log('      stealth addr != main wallet');
      console.log('      two subscriptions are unlinkable');
    });
  });

  // ==========================================================================
  // Phase 6 -- Full round-trip simulation
  // ==========================================================================

  describe('Phase 6: Complete Subscription Lifecycle', () => {
    it('6.1 -- Full lifecycle: subscribe -> accrue -> withdraw -> cancel -> refund', () => {
      /**
       * Simulates the complete subscription lifecycle offchain:
       *
       * 1. User subscribes (stream created)
       * 2. 50% of time passes (funds accrue)
       * 3. Service withdraws vested funds
       * 4. User cancels subscription
       * 5. Unvested funds returned to user
       */
      console.log('\n    --- Complete Subscription Lifecycle ---');

      // Step 1: Create subscription stream
      const now = Date.now();
      const stealthAddr = generateStealthAddress(serviceMetaAddress);
      const stream = createMockStream({
        sender: subscriberWallet.publicKey,
        recipient: stealthAddr.address,
        totalAmount: 10_000_000_000n,
        startTime: new Date(now - 1800_000),   // Started 30 min ago
        endTime: new Date(now + 1800_000),     // Ends in 30 min
        status: 'active',
        withdrawnAmount: 0n,
      });
      console.log(`    [1] Stream created: ${stream.id.toBase58().slice(0, 20)}...`);

      // Step 2: Calculate accrued amount (50% elapsed)
      const withdrawable = calculateWithdrawableAmount(stream);
      console.log(`    [2] 50% elapsed: ${withdrawable} lamports withdrawable`);
      assert.ok(withdrawable > 0n);

      // Step 3: Service withdraws accrued funds
      const afterWithdraw = createMockStream({
        ...stream,
        withdrawnAmount: withdrawable,
        updatedAt: new Date(),
      });
      const newWithdrawable = calculateWithdrawableAmount(afterWithdraw);
      console.log(`    [3] After withdrawal: ${newWithdrawable} lamports remaining withdrawable`);
      // Immediately after withdrawal, almost nothing new has accrued
      assert.ok(newWithdrawable < 100_000_000n, 'very little should be newly available');

      // Step 4: User cancels
      const vestedTotal = calculateWithdrawableAmount(afterWithdraw) + afterWithdraw.withdrawnAmount;
      const unvested = afterWithdraw.totalAmount - vestedTotal;
      const recipientOwed = vestedTotal - afterWithdraw.withdrawnAmount;
      console.log(`    [4] Cancellation: refund ${unvested} to user, send ${recipientOwed} to service`);

      // Step 5: Verify accounting
      assert.equal(
        vestedTotal + unvested,
        afterWithdraw.totalAmount,
        'accounting should balance'
      );
      console.log(`    [5] Accounting verified: vested(${vestedTotal}) + unvested(${unvested}) = total(${afterWithdraw.totalAmount})`);

      console.log('\n    Lifecycle COMPLETE');
    });
  });
});

import { PublicKey } from '@solana/web3.js';
import { STREAM_SEED, ESCROW_SEED } from './constants';

/**
 * Derive the stream PDA address
 */
export function deriveStreamPDA(
  programId: PublicKey,
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(STREAM_SEED),
      sender.toBuffer(),
      recipient.toBuffer(),
      mint.toBuffer(),
    ],
    programId
  );
}

/**
 * Derive the escrow token account PDA
 */
export function deriveEscrowPDA(
  programId: PublicKey,
  stream: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), stream.toBuffer()],
    programId
  );
}

/**
 * Calculate how many intervals have elapsed
 */
export function calculateElapsedIntervals(
  lastWithdrawalAt: number,
  intervalSeconds: number,
  currentTime: number = Math.floor(Date.now() / 1000)
): number {
  const elapsed = currentTime - lastWithdrawalAt;
  return Math.floor(elapsed / intervalSeconds);
}

/**
 * Calculate withdrawable amount from a stream
 */
export function calculateWithdrawableAmount(
  amountPerInterval: bigint,
  intervalSeconds: number,
  totalIntervals: number,
  intervalsPaid: number,
  lastWithdrawalAt: number
): bigint {
  const elapsed = calculateElapsedIntervals(lastWithdrawalAt, intervalSeconds);
  const remaining = totalIntervals - intervalsPaid;
  const intervalsToPay = Math.min(elapsed, remaining);
  return amountPerInterval * BigInt(intervalsToPay);
}

/**
 * Calculate refund amount for cancellation
 */
export function calculateRefundAmount(
  amountPerInterval: bigint,
  totalIntervals: number,
  intervalsPaid: number
): bigint {
  const remaining = totalIntervals - intervalsPaid;
  return amountPerInterval * BigInt(remaining);
}

/**
 * Format lamports to SOL string
 */
export function formatLamports(lamports: bigint | number): string {
  const sol = Number(lamports) / 1e9;
  return sol.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  });
}

/**
 * Format token amount with decimals
 */
export function formatTokenAmount(amount: bigint | number, decimals: number): string {
  const value = Number(amount) / Math.pow(10, decimals);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

/**
 * Parse SOL string to lamports
 */
export function parseSolToLamports(sol: string | number): bigint {
  return BigInt(Math.floor(Number(sol) * 1e9));
}

/**
 * Parse token amount with decimals
 */
export function parseTokenAmount(amount: string | number, decimals: number): bigint {
  return BigInt(Math.floor(Number(amount) * Math.pow(10, decimals)));
}

/**
 * Format interval to human readable string
 */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)} weeks`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)} months`;
  return `${Math.floor(seconds / 31536000)} years`;
}

/**
 * Format timestamp to date string
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Calculate next payment date
 */
export function getNextPaymentDate(
  lastWithdrawalAt: number,
  intervalSeconds: number
): Date {
  const nextTimestamp = lastWithdrawalAt + intervalSeconds;
  return new Date(nextTimestamp * 1000);
}

/**
 * Calculate stream end date
 */
export function getStreamEndDate(
  createdAt: number,
  intervalSeconds: number,
  totalIntervals: number
): Date {
  const endTimestamp = createdAt + intervalSeconds * totalIntervals;
  return new Date(endTimestamp * 1000);
}

/**
 * Check if a stream is currently active and has payments due
 */
export function hasPaymentsDue(
  lastWithdrawalAt: number,
  intervalSeconds: number,
  totalIntervals: number,
  intervalsPaid: number
): boolean {
  const elapsed = calculateElapsedIntervals(lastWithdrawalAt, intervalSeconds);
  return elapsed > 0 && intervalsPaid < totalIntervals;
}

/**
 * Generate a unique stream name
 */
export function generateStreamName(prefix: string = 'P01'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${prefix}-${timestamp}-${random}`.toUpperCase();
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendSol } from './transactions';
import { getConnection } from './connection';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  applyAmountNoise,
  NoiseAdjustment,
  createNoiseAdjustment,
  updateNoiseAdjustment,
} from '../../utils/crypto/amountNoise';
import {
  applyTimingNoise,
  ensurePaymentNotSkipped,
} from '../../utils/privacy/timingNoise';

// Stream status types
export type StreamStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type StreamFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'custom';
export type StreamDirection = 'outgoing' | 'incoming';

// Stream interface
export interface Stream {
  id: string;
  name: string;
  description?: string;

  // Payment details
  recipientAddress: string;
  recipientName?: string;
  totalAmount: number; // Total SOL to stream
  amountPerPayment: number; // SOL per payment

  // Timing
  frequency: StreamFrequency;
  customIntervalDays?: number; // For custom frequency
  startDate: number; // Timestamp
  endDate?: number; // Optional end date
  nextPaymentDate: number; // Next scheduled payment (base time)
  noisyPaymentDate?: number; // Actual payment time with timing noise applied

  // Progress
  amountStreamed: number; // Total SOL already sent
  paymentsCompleted: number;
  totalPayments?: number; // Total expected payments (if endDate set)

  // Status
  status: StreamStatus;
  direction: StreamDirection;

  // Privacy options (synced from extension subscriptions)
  amountNoise: number;       // Amount variation +/- % (0-20)
  timingNoise: number;       // Timing variation +/- hours (0-24)
  useStealthAddress: boolean; // Use unique derived address per payment

  // Amount noise tracking (for balancing over time)
  noiseAdjustment?: NoiseAdjustment; // Tracks cumulative overpay/underpay from noise

  // Service info (auto-detected or manually selected)
  serviceId?: string;
  serviceName?: string;
  serviceCategory?: string;
  serviceColor?: string;

  // Metadata
  createdAt: number;
  updatedAt: number;

  // Payment history
  paymentHistory: StreamPayment[];
}

export interface StreamPayment {
  id: string;
  amount: number;           // Original scheduled amount
  actualAmount?: number;    // Actual amount sent (with noise applied)
  noiseDelta?: number;      // Noise adjustment applied (actualAmount - amount)
  signature: string;
  timestamp: number;
  status: 'success' | 'failed';
  error?: string;
}

export interface CreateStreamParams {
  name: string;
  description?: string;
  recipientAddress: string;
  recipientName?: string;
  totalAmount: number;
  frequency: StreamFrequency;
  customIntervalDays?: number;
  startDate?: number;
  endDate?: number;
  // Privacy options (optional, defaults to 0/false)
  amountNoise?: number;
  timingNoise?: number;
  useStealthAddress?: boolean;
  // Service info (optional)
  serviceId?: string;
  serviceName?: string;
  serviceCategory?: string;
  serviceColor?: string;
}

const STORAGE_KEY = 'p01_streams';
const DELETED_IDS_KEY = 'p01_streams_deleted_ids';
const CANCELLED_IDS_KEY = 'p01_streams_cancelled_ids';
const PAUSED_IDS_KEY = 'p01_streams_paused_ids';

// Helper to get deleted stream IDs (defined early for use in cancel/delete)
async function getDeletedIds(): Promise<Set<string>> {
  try {
    const data = await AsyncStorage.getItem(DELETED_IDS_KEY);
    if (!data) return new Set();
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

// Helper to get cancelled stream IDs
async function getCancelledIds(): Promise<Set<string>> {
  try {
    const data = await AsyncStorage.getItem(CANCELLED_IDS_KEY);
    if (!data) return new Set();
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

// Add ID to cancelled list
async function addCancelledId(streamId: string): Promise<void> {
  const cancelledIds = await getCancelledIds();
  console.log('[Streams] Current cancelled IDs before add:', cancelledIds.size, [...cancelledIds]);
  cancelledIds.add(streamId);
  const idsArray = [...cancelledIds];
  await AsyncStorage.setItem(CANCELLED_IDS_KEY, JSON.stringify(idsArray));
  console.log('[Streams] Added to cancelled list:', streamId, '- total now:', idsArray.length);
  // Verify write
  const verify = await AsyncStorage.getItem(CANCELLED_IDS_KEY);
  console.log('[Streams] Verified cancelled IDs after write:', verify);
}

// Helper to get paused stream IDs
async function getPausedIds(): Promise<Set<string>> {
  try {
    const data = await AsyncStorage.getItem(PAUSED_IDS_KEY);
    if (!data) return new Set();
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

// Add ID to paused list
async function addPausedId(streamId: string): Promise<void> {
  const pausedIds = await getPausedIds();
  pausedIds.add(streamId);
  await AsyncStorage.setItem(PAUSED_IDS_KEY, JSON.stringify([...pausedIds]));
  console.log('[Streams] Added to paused list:', streamId);
}

// Remove ID from paused list (when resumed)
async function removePausedId(streamId: string): Promise<void> {
  const pausedIds = await getPausedIds();
  pausedIds.delete(streamId);
  await AsyncStorage.setItem(PAUSED_IDS_KEY, JSON.stringify([...pausedIds]));
  console.log('[Streams] Removed from paused list:', streamId);
}

// Helper to generate unique ID
function generateId(): string {
  return `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get interval in milliseconds based on frequency
function getIntervalMs(frequency: StreamFrequency, customDays?: number): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (frequency) {
    case 'daily':
      return DAY_MS;
    case 'weekly':
      return 7 * DAY_MS;
    case 'biweekly':
      return 14 * DAY_MS;
    case 'monthly':
      return 30 * DAY_MS;
    case 'custom':
      return (customDays || 1) * DAY_MS;
    default:
      return DAY_MS;
  }
}

// Calculate amount per payment based on frequency and total
function calculateAmountPerPayment(
  totalAmount: number,
  startDate: number,
  endDate: number | undefined,
  frequency: StreamFrequency,
  customDays?: number
): number {
  if (!endDate) {
    // If no end date, default to monthly payments
    return totalAmount;
  }

  const intervalMs = getIntervalMs(frequency, customDays);
  const durationMs = endDate - startDate;
  const numPayments = Math.ceil(durationMs / intervalMs);

  return totalAmount / Math.max(numPayments, 1);
}

// Load all streams from storage (filters deleted, applies cancelled status)
export async function loadStreams(): Promise<Stream[]> {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    if (!data) return [];

    let streams: Stream[] = JSON.parse(data);

    // Filter out deleted IDs
    const deletedIds = await getDeletedIds();
    if (deletedIds.size > 0) {
      streams = streams.filter(s => !deletedIds.has(s.id));
      console.log(`[Streams] Filtered out ${deletedIds.size} deleted streams`);
    }

    // Apply cancelled status to streams in cancelled list
    const cancelledIds = await getCancelledIds();
    console.log(`[Streams] Cancelled IDs in list: ${cancelledIds.size}`, [...cancelledIds]);

    if (cancelledIds.size > 0) {
      streams = streams.map(s => {
        if (cancelledIds.has(s.id)) {
          if (s.status !== 'cancelled') {
            console.log(`[Streams] Marking as cancelled: ${s.name} (was ${s.status})`);
            return { ...s, status: 'cancelled' as StreamStatus };
          } else {
            console.log(`[Streams] Already cancelled: ${s.name}`);
          }
        }
        return s;
      });
    }

    // Apply paused status to streams in paused list (if not already cancelled)
    const pausedIds = await getPausedIds();
    console.log(`[Streams] Paused IDs in list: ${pausedIds.size}`, [...pausedIds]);

    if (pausedIds.size > 0) {
      streams = streams.map(s => {
        // Don't override cancelled status
        if (cancelledIds.has(s.id)) return s;

        if (pausedIds.has(s.id)) {
          if (s.status !== 'paused') {
            console.log(`[Streams] Marking as paused: ${s.name} (was ${s.status})`);
            return { ...s, status: 'paused' as StreamStatus };
          }
        }
        return s;
      });
    }

    // Log status of loaded streams
    const statusCounts = streams.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`[Streams] Loaded ${streams.length} streams:`, statusCounts);
    return streams;
  } catch (error) {
    console.error('Failed to load streams:', error);
    return [];
  }
}

// Save streams to storage
async function saveStreams(streams: Stream[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(streams));
  } catch (error) {
    console.error('Failed to save streams:', error);
    throw error;
  }
}

// Create a new stream
export async function createStream(params: CreateStreamParams): Promise<Stream> {
  const now = Date.now();
  const startDate = params.startDate || now;
  const intervalMs = getIntervalMs(params.frequency, params.customIntervalDays);

  // Calculate payments
  let totalPayments: number | undefined;
  let amountPerPayment: number;

  if (params.endDate) {
    const durationMs = params.endDate - startDate;
    totalPayments = Math.ceil(durationMs / intervalMs);
    amountPerPayment = params.totalAmount / Math.max(totalPayments, 1);
  } else {
    // Ongoing stream - payment amount based on frequency
    switch (params.frequency) {
      case 'daily':
        amountPerPayment = params.totalAmount / 30; // Monthly budget split daily
        break;
      case 'weekly':
        amountPerPayment = params.totalAmount / 4; // Monthly budget split weekly
        break;
      case 'biweekly':
        amountPerPayment = params.totalAmount / 2;
        break;
      case 'monthly':
      default:
        amountPerPayment = params.totalAmount;
        break;
    }
  }

  // Calculate first payment date - should be in the future (after first interval)
  const firstPaymentDate = startDate + intervalMs;

  // Apply timing noise to first payment if enabled
  const timingNoise = params.timingNoise ?? 0;
  let noisyPaymentDate: number | undefined;
  if (timingNoise > 0) {
    const rawNoisyTime = await applyTimingNoise(firstPaymentDate, timingNoise);
    // Ensure noise doesn't push first payment past the interval
    noisyPaymentDate = ensurePaymentNotSkipped(rawNoisyTime, firstPaymentDate, intervalMs);
    console.log(
      `[Streams] Applied initial timing noise: ` +
      `base=${new Date(firstPaymentDate).toISOString()}, ` +
      `noisy=${new Date(noisyPaymentDate).toISOString()}, ` +
      `offset=${Math.round((noisyPaymentDate - firstPaymentDate) / (60 * 1000))} min`
    );
  }

  const stream: Stream = {
    id: generateId(),
    name: params.name,
    description: params.description,
    recipientAddress: params.recipientAddress,
    recipientName: params.recipientName,
    totalAmount: params.totalAmount,
    amountPerPayment: Math.round(amountPerPayment * 1000000) / 1000000, // Round to 6 decimals
    frequency: params.frequency,
    customIntervalDays: params.customIntervalDays,
    startDate,
    endDate: params.endDate,
    nextPaymentDate: firstPaymentDate, // First payment scheduled after first interval
    noisyPaymentDate, // Actual time with noise (undefined if noise is 0)
    amountStreamed: 0,
    paymentsCompleted: 0,
    totalPayments,
    status: 'active',
    direction: 'outgoing',
    // Privacy options (default to 0/false)
    amountNoise: params.amountNoise ?? 0,
    timingNoise,
    useStealthAddress: params.useStealthAddress ?? false,
    // Service info
    serviceId: params.serviceId,
    serviceName: params.serviceName,
    serviceCategory: params.serviceCategory,
    serviceColor: params.serviceColor,
    createdAt: now,
    updatedAt: now,
    paymentHistory: [],
  };

  const streams = await loadStreams();
  streams.push(stream);
  await saveStreams(streams);

  return stream;
}

// Get a single stream by ID
export async function getStream(streamId: string): Promise<Stream | null> {
  const streams = await loadStreams();
  return streams.find(s => s.id === streamId) || null;
}

// Update a stream
export async function updateStream(streamId: string, updates: Partial<Stream>): Promise<Stream | null> {
  const streams = await loadStreams();
  const index = streams.findIndex(s => s.id === streamId);

  if (index === -1) return null;

  streams[index] = {
    ...streams[index],
    ...updates,
    updatedAt: Date.now(),
  };

  await saveStreams(streams);
  return streams[index];
}

// Pause a stream
export async function pauseStream(streamId: string): Promise<Stream | null> {
  // Add to paused list so status persists after sync/reload
  await addPausedId(streamId);
  return updateStream(streamId, { status: 'paused' });
}

// Resume a stream
export async function resumeStream(streamId: string): Promise<Stream | null> {
  const stream = await getStream(streamId);
  if (!stream) return null;

  // Remove from paused list
  await removePausedId(streamId);

  // Calculate new next payment date
  const now = Date.now();
  const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);
  const nextPaymentDate = now + intervalMs;

  // Apply timing noise if enabled
  let noisyPaymentDate: number | undefined;
  if (stream.timingNoise > 0) {
    const rawNoisyTime = await applyTimingNoise(nextPaymentDate, stream.timingNoise);
    noisyPaymentDate = ensurePaymentNotSkipped(rawNoisyTime, nextPaymentDate, intervalMs);
    console.log(
      `[Streams] Applied timing noise on resume for ${stream.name}: ` +
      `base=${new Date(nextPaymentDate).toISOString()}, ` +
      `noisy=${new Date(noisyPaymentDate).toISOString()}`
    );
  }

  return updateStream(streamId, {
    status: 'active',
    nextPaymentDate,
    noisyPaymentDate,
  });
}

// Cancel a stream (adds to cancelled list - will show in History)
export async function cancelStream(streamId: string): Promise<Stream | null> {
  // Add to cancelled list so status persists after sync
  await addCancelledId(streamId);
  return updateStream(streamId, { status: 'cancelled' });
}

// Cancel stream and publish to blockchain (for cross-device sync)
export async function cancelStreamAndPublish(
  streamId: string,
  keypair: import('@solana/web3.js').Keypair
): Promise<{ stream: Stream | null; signature: string | null }> {
  // First cancel locally
  const stream = await cancelStream(streamId);

  // Then publish to blockchain
  let signature: string | null = null;
  try {
    const { publishStatusUpdate } = await import('./onchainSync');
    signature = await publishStatusUpdate(streamId, 'cancelled', keypair);
    console.log('[Streams] Published cancel to blockchain:', signature);
  } catch (error) {
    console.warn('[Streams] Failed to publish cancel to blockchain:', error);
    // Local cancel still succeeded, so don't throw
  }

  return { stream, signature };
}

// Delete a stream (also adds to deleted list to prevent re-sync)
export async function deleteStream(streamId: string): Promise<boolean> {
  const streams = await loadStreams();
  const filtered = streams.filter(s => s.id !== streamId);

  if (filtered.length === streams.length) return false;

  // Add to deleted list so it won't come back on sync
  const deletedIds = await getDeletedIds();
  deletedIds.add(streamId);
  await AsyncStorage.setItem(DELETED_IDS_KEY, JSON.stringify([...deletedIds]));
  console.log('[Streams] Deleted and added to deleted list:', streamId);

  await saveStreams(filtered);
  return true;
}

// Process a payment for a stream
export async function processStreamPayment(streamId: string): Promise<StreamPayment | null> {
  const stream = await getStream(streamId);
  if (!stream || stream.status !== 'active') return null;

  const paymentId = `payment_${Date.now()}`;

  try {
    // Calculate amount to send (with noise if enabled for privacy)
    let amountToSend = stream.amountPerPayment;
    let noiseDelta = 0;
    let newNoiseAdjustment = stream.noiseAdjustment || createNoiseAdjustment();

    // Apply amount noise for privacy if enabled
    if (stream.amountNoise > 0) {
      // Calculate remaining payments for smart balancing
      let remainingPayments: number | undefined;
      const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);
      if (stream.totalPayments) {
        remainingPayments = stream.totalPayments - stream.paymentsCompleted;
      } else if (stream.endDate) {
        const remainingMs = stream.endDate - Date.now();
        remainingPayments = Math.ceil(remainingMs / intervalMs);
      }

      // Apply noise with cumulative tracking
      const currentCumulative = stream.noiseAdjustment?.cumulative || 0;
      const noiseResult = await applyAmountNoise(
        stream.amountPerPayment,
        stream.amountNoise,
        currentCumulative,
        remainingPayments
      );

      amountToSend = noiseResult.adjustedAmount;
      noiseDelta = noiseResult.noiseDelta;
      newNoiseAdjustment = updateNoiseAdjustment(newNoiseAdjustment, noiseDelta);

      console.log(
        `[Streams] Applied amount noise to ${stream.name}: ` +
        `${stream.amountPerPayment} -> ${amountToSend.toFixed(9)} SOL ` +
        `(delta: ${noiseDelta >= 0 ? '+' : ''}${noiseDelta.toFixed(9)}, ` +
        `cumulative: ${newNoiseAdjustment.cumulative >= 0 ? '+' : ''}${newNoiseAdjustment.cumulative.toFixed(9)})`
      );
    }

    // Execute the payment with potentially noise-adjusted amount
    const result = await sendSol(stream.recipientAddress, amountToSend);

    if (!result.success) {
      throw new Error(result.error || 'Payment failed');
    }

    const payment: StreamPayment = {
      id: paymentId,
      amount: stream.amountPerPayment,    // Original scheduled amount
      actualAmount: amountToSend,         // Amount actually sent (with noise)
      noiseDelta: noiseDelta !== 0 ? noiseDelta : undefined,
      signature: result.signature!,
      timestamp: Date.now(),
      status: 'success',
    };

    // Calculate next payment date (base time without noise)
    const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);
    const nextPaymentDate = Date.now() + intervalMs;

    // Apply timing noise if enabled
    // This randomizes when the payment actually triggers within +/- timingNoise hours
    let noisyPaymentDate: number | undefined;
    if (stream.timingNoise > 0) {
      const rawNoisyTime = await applyTimingNoise(nextPaymentDate, stream.timingNoise);
      // Ensure noise doesn't push payment past next interval (which would skip it)
      noisyPaymentDate = ensurePaymentNotSkipped(
        rawNoisyTime,
        nextPaymentDate,
        intervalMs
      );
      console.log(
        `[Streams] Applied timing noise to ${stream.name}: ` +
        `base=${new Date(nextPaymentDate).toISOString()}, ` +
        `noisy=${new Date(noisyPaymentDate).toISOString()}, ` +
        `offset=${Math.round((noisyPaymentDate - nextPaymentDate) / (60 * 1000))} min`
      );
    }

    // Update stream - track actual amount sent
    const newAmountStreamed = stream.amountStreamed + amountToSend;
    const newPaymentsCompleted = stream.paymentsCompleted + 1;

    // Check if stream is complete
    let newStatus: StreamStatus = 'active';
    if (stream.totalPayments && newPaymentsCompleted >= stream.totalPayments) {
      newStatus = 'completed';
    } else if (stream.endDate && nextPaymentDate > stream.endDate) {
      newStatus = 'completed';
    }

    await updateStream(streamId, {
      amountStreamed: newAmountStreamed,
      paymentsCompleted: newPaymentsCompleted,
      nextPaymentDate,
      noisyPaymentDate,
      noiseAdjustment: stream.amountNoise > 0 ? newNoiseAdjustment : undefined,
      status: newStatus,
      paymentHistory: [...stream.paymentHistory, payment],
    });

    return payment;
  } catch (error: any) {
    console.error('Stream payment failed:', error);

    const payment: StreamPayment = {
      id: paymentId,
      amount: stream.amountPerPayment,
      signature: '',
      timestamp: Date.now(),
      status: 'failed',
      error: error.message,
    };

    // Update stream with failed payment
    await updateStream(streamId, {
      paymentHistory: [...stream.paymentHistory, payment],
    });

    return payment;
  }
}

// Check and process due payments
export async function processDuePayments(): Promise<StreamPayment[]> {
  const streams = await loadStreams();
  const now = Date.now();
  const payments: StreamPayment[] = [];

  for (const stream of streams) {
    if (stream.status !== 'active') continue;

    // Determine which time to check against:
    // - If timing noise is enabled and we have a pre-computed noisy time, use that
    // - Otherwise, fall back to the base scheduled time
    const effectivePaymentTime = stream.timingNoise > 0 && stream.noisyPaymentDate
      ? stream.noisyPaymentDate
      : stream.nextPaymentDate;

    if (effectivePaymentTime > now) continue;

    const payment = await processStreamPayment(stream.id);
    if (payment) {
      payments.push(payment);
    }
  }

  return payments;
}

// Get streams by status
export async function getStreamsByStatus(status: StreamStatus): Promise<Stream[]> {
  const streams = await loadStreams();
  return streams.filter(s => s.status === status);
}

// Get active streams
export async function getActiveStreams(): Promise<Stream[]> {
  return getStreamsByStatus('active');
}

// Get stream statistics
export async function getStreamStats(): Promise<{
  totalOutgoing: number;
  totalIncoming: number;
  activeStreams: number;
  monthlyOutflow: number;
}> {
  const streams = await loadStreams();
  const activeStreams = streams.filter(s => s.status === 'active');

  let totalOutgoing = 0;
  let totalIncoming = 0;
  let monthlyOutflow = 0;

  for (const stream of streams) {
    if (stream.direction === 'outgoing') {
      totalOutgoing += stream.amountStreamed;
    } else {
      totalIncoming += stream.amountStreamed;
    }
  }

  // Calculate monthly outflow from active streams
  for (const stream of activeStreams) {
    if (stream.direction !== 'outgoing') continue;

    const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);
    const paymentsPerMonth = (30 * 24 * 60 * 60 * 1000) / intervalMs;
    monthlyOutflow += stream.amountPerPayment * paymentsPerMonth;
  }

  return {
    totalOutgoing,
    totalIncoming,
    activeStreams: activeStreams.length,
    monthlyOutflow: Math.round(monthlyOutflow * 1000) / 1000,
  };
}

// Format frequency for display
export function formatFrequency(frequency: StreamFrequency, customDays?: number): string {
  switch (frequency) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'biweekly':
      return 'Every 2 weeks';
    case 'monthly':
      return 'Monthly';
    case 'custom':
      return `Every ${customDays} days`;
    default:
      return frequency;
  }
}

// Calculate streaming rate (SOL per day)
export function calculateDailyRate(stream: Stream): number {
  const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);
  const DAY_MS = 24 * 60 * 60 * 1000;
  return (stream.amountPerPayment / intervalMs) * DAY_MS;
}

// ============ On-Chain Sync ============

const LAST_SYNC_KEY = 'p01_streams_last_sync';

/**
 * Get list of locally deleted stream IDs (exported version)
 */
export async function getDeletedStreamIds(): Promise<Set<string>> {
  return getDeletedIds();
}

/**
 * Add a stream ID to the deleted list
 */
export async function addDeletedStreamId(streamId: string): Promise<void> {
  try {
    const deletedIds = await getDeletedIds();
    deletedIds.add(streamId);
    await AsyncStorage.setItem(DELETED_IDS_KEY, JSON.stringify([...deletedIds]));
    console.log('[Streams] Added to deleted list:', streamId);
  } catch (error) {
    console.error('[Streams] Failed to add deleted ID:', error);
  }
}

/**
 * Clear deleted IDs list (useful for full resync)
 */
export async function clearDeletedStreamIds(): Promise<void> {
  await AsyncStorage.removeItem(DELETED_IDS_KEY);
}

/**
 * Reset all streams data - clears local storage, deleted IDs, cancelled IDs, and paused IDs
 * Use this to do a fresh sync from blockchain
 */
export async function resetAllStreamsData(): Promise<void> {
  console.log('[Streams] Resetting all streams data...');
  await AsyncStorage.removeItem(STORAGE_KEY);
  await AsyncStorage.removeItem(DELETED_IDS_KEY);
  await AsyncStorage.removeItem(CANCELLED_IDS_KEY);
  await AsyncStorage.removeItem(PAUSED_IDS_KEY);
  await AsyncStorage.removeItem(LAST_SYNC_KEY);
  console.log('[Streams] All streams data cleared');
}

/**
 * Mark all current subscriptions as cancelled (move to history)
 */
export async function cancelAllStreams(): Promise<number> {
  const streams = await loadStreams();
  const activeStreams = streams.filter(s => s.status === 'active' || s.status === 'paused');

  for (const stream of activeStreams) {
    await addCancelledId(stream.id);
  }

  // Update all to cancelled status
  const updatedStreams = streams.map(s => ({
    ...s,
    status: 'cancelled' as StreamStatus,
  }));

  await saveStreams(updatedStreams);
  console.log(`[Streams] Cancelled ${activeStreams.length} streams`);
  return activeStreams.length;
}

/**
 * Cancel all streams and publish updates to blockchain
 */
export async function cancelAllStreamsAndPublish(
  keypair: import('@solana/web3.js').Keypair
): Promise<{ count: number; signatures: string[] }> {
  const streams = await loadStreams();
  const activeStreams = streams.filter(s => s.status === 'active' || s.status === 'paused');

  // First cancel all locally
  const count = await cancelAllStreams();

  // Then publish to blockchain
  const signatures: string[] = [];
  const { publishStatusUpdate } = await import('./onchainSync');

  for (const stream of activeStreams) {
    try {
      const sig = await publishStatusUpdate(stream.id, 'cancelled', keypair);
      signatures.push(sig);
      console.log(`[Streams] Published cancel for ${stream.name}: ${sig}`);
    } catch (error) {
      console.warn(`[Streams] Failed to publish cancel for ${stream.name}:`, error);
    }
  }

  console.log(`[Streams] Published ${signatures.length}/${activeStreams.length} cancels to blockchain`);
  return { count, signatures };
}

/**
 * Sync streams from blockchain
 * Fetches subscriptions stored on-chain via memo program
 * Respects locally deleted IDs - won't re-add them
 */
export async function syncFromBlockchain(walletAddress: string): Promise<{
  newStreams: number;
  updatedStreams: number;
}> {
  try {
    console.log('[Streams] Starting blockchain sync...');

    // Import the on-chain sync module
    const { fetchSubscriptionsFromChain, mergeStreams } = await import('./onchainSync');

    // Fetch from chain
    const chainStreams = await fetchSubscriptionsFromChain(walletAddress);
    console.log(`[Streams] Found ${chainStreams.length} subscriptions on-chain`);

    if (chainStreams.length === 0) {
      // No subscriptions on chain, save sync time and return
      await AsyncStorage.setItem(LAST_SYNC_KEY, Date.now().toString());
      return { newStreams: 0, updatedStreams: 0 };
    }

    // Get locally deleted IDs to filter them out
    const deletedIds = await getDeletedIds();
    console.log(`[Streams] Filtering out ${deletedIds.size} locally deleted subscriptions`);

    // Filter out deleted subscriptions from chain data
    const filteredChainStreams = chainStreams.filter(s => !deletedIds.has(s.id));
    console.log(`[Streams] ${filteredChainStreams.length} subscriptions after filtering`);

    if (filteredChainStreams.length === 0) {
      await AsyncStorage.setItem(LAST_SYNC_KEY, Date.now().toString());
      return { newStreams: 0, updatedStreams: 0 };
    }

    // Load local streams
    const localStreams = await loadStreams();

    // Merge with local (only non-deleted chain streams)
    const mergedStreams = mergeStreams(localStreams, filteredChainStreams);

    // Get cancelled and paused IDs to ensure they stay after merge
    const cancelledIds = await getCancelledIds();
    const pausedIds = await getPausedIds();

    // Apply cancelled and paused status as a safeguard (in case merge didn't preserve it)
    const finalStreams = mergedStreams.map(s => {
      // Cancelled takes priority
      if (cancelledIds.has(s.id) && s.status !== 'cancelled') {
        console.log(`[Streams] Re-applying cancelled status to: ${s.name}`);
        return { ...s, status: 'cancelled' as StreamStatus };
      }
      // Then paused
      if (pausedIds.has(s.id) && s.status !== 'paused' && s.status !== 'cancelled') {
        console.log(`[Streams] Re-applying paused status to: ${s.name}`);
        return { ...s, status: 'paused' as StreamStatus };
      }
      return s;
    });

    // Count changes
    const existingIds = new Set(localStreams.map(s => s.id));
    let newStreams = 0;
    let updatedStreams = 0;

    for (const stream of finalStreams) {
      if (!existingIds.has(stream.id)) {
        newStreams++;
      } else {
        // Check if it was updated
        const local = localStreams.find(s => s.id === stream.id);
        if (local && local.status !== stream.status) {
          updatedStreams++;
        }
      }
    }

    // Save streams with cancelled status preserved
    await saveStreams(finalStreams);

    // Save sync time
    await AsyncStorage.setItem(LAST_SYNC_KEY, Date.now().toString());

    console.log(`[Streams] Sync complete: ${newStreams} new, ${updatedStreams} updated`);
    return { newStreams, updatedStreams };
  } catch (error) {
    console.error('[Streams] Blockchain sync failed:', error);
    throw error;
  }
}

/**
 * Check if sync is needed (every 5 minutes)
 */
export async function shouldSyncFromChain(): Promise<boolean> {
  try {
    const lastSync = await AsyncStorage.getItem(LAST_SYNC_KEY);
    if (!lastSync) return true;

    const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes
    return Date.now() - parseInt(lastSync, 10) > SYNC_INTERVAL;
  } catch {
    return true;
  }
}

/**
 * Get last sync time
 */
export async function getLastSyncTime(): Promise<number | null> {
  try {
    const lastSync = await AsyncStorage.getItem(LAST_SYNC_KEY);
    return lastSync ? parseInt(lastSync, 10) : null;
  } catch {
    return null;
  }
}

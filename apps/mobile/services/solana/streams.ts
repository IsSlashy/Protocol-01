import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendSol } from './transactions';
import { getConnection } from './connection';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

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
  nextPaymentDate: number; // Next scheduled payment

  // Progress
  amountStreamed: number; // Total SOL already sent
  paymentsCompleted: number;
  totalPayments?: number; // Total expected payments (if endDate set)

  // Status
  status: StreamStatus;
  direction: StreamDirection;

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
  amount: number;
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
  // Service info (optional)
  serviceId?: string;
  serviceName?: string;
  serviceCategory?: string;
  serviceColor?: string;
}

const STORAGE_KEY = 'p01_streams';

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

// Load all streams from storage
export async function loadStreams(): Promise<Stream[]> {
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data);
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
    nextPaymentDate: startDate, // First payment at start
    amountStreamed: 0,
    paymentsCompleted: 0,
    totalPayments,
    status: 'active',
    direction: 'outgoing',
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
  return updateStream(streamId, { status: 'paused' });
}

// Resume a stream
export async function resumeStream(streamId: string): Promise<Stream | null> {
  const stream = await getStream(streamId);
  if (!stream) return null;

  // Calculate new next payment date
  const now = Date.now();
  const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);

  return updateStream(streamId, {
    status: 'active',
    nextPaymentDate: now + intervalMs,
  });
}

// Cancel a stream
export async function cancelStream(streamId: string): Promise<Stream | null> {
  return updateStream(streamId, { status: 'cancelled' });
}

// Delete a stream
export async function deleteStream(streamId: string): Promise<boolean> {
  const streams = await loadStreams();
  const filtered = streams.filter(s => s.id !== streamId);

  if (filtered.length === streams.length) return false;

  await saveStreams(filtered);
  return true;
}

// Process a payment for a stream
export async function processStreamPayment(streamId: string): Promise<StreamPayment | null> {
  const stream = await getStream(streamId);
  if (!stream || stream.status !== 'active') return null;

  const paymentId = `payment_${Date.now()}`;

  try {
    // Execute the payment
    const result = await sendSol(stream.recipientAddress, stream.amountPerPayment);

    if (!result.success) {
      throw new Error(result.error || 'Payment failed');
    }

    const payment: StreamPayment = {
      id: paymentId,
      amount: stream.amountPerPayment,
      signature: result.signature!,
      timestamp: Date.now(),
      status: 'success',
    };

    // Calculate next payment date
    const intervalMs = getIntervalMs(stream.frequency, stream.customIntervalDays);
    const nextPaymentDate = Date.now() + intervalMs;

    // Update stream
    const newAmountStreamed = stream.amountStreamed + stream.amountPerPayment;
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
    if (stream.nextPaymentDate > now) continue;

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

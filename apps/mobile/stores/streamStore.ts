import { create } from 'zustand';
import { Keypair } from '@solana/web3.js';
import {
  Stream,
  StreamStatus,
  StreamPayment,
  CreateStreamParams,
  loadStreams,
  createStream,
  getStream,
  pauseStream,
  resumeStream,
  cancelStream,
  cancelStreamAndPublish,
  deleteStream,
  processStreamPayment,
  processDuePayments,
  getStreamStats,
  syncFromBlockchain,
  shouldSyncFromChain,
  getLastSyncTime,
  resetAllStreamsData,
  cancelAllStreams,
  cancelAllStreamsAndPublish,
} from '../services/solana/streams';

interface StreamStats {
  totalOutgoing: number;
  totalIncoming: number;
  activeStreams: number;
  monthlyOutflow: number;
}

interface StreamState {
  // State
  streams: Stream[];
  loading: boolean;
  refreshing: boolean;
  syncing: boolean;
  error: string | null;
  stats: StreamStats;
  processingPayment: string | null; // Stream ID being processed
  lastSyncTime: number | null;

  // Actions
  initialize: (walletAddress?: string) => Promise<void>;
  refresh: (walletAddress?: string) => Promise<void>;
  syncFromChain: (walletAddress: string) => Promise<{ newStreams: number; updatedStreams: number }>;
  createNewStream: (params: CreateStreamParams) => Promise<Stream>;
  pauseStream: (streamId: string) => Promise<void>;
  resumeStream: (streamId: string) => Promise<void>;
  cancelStream: (streamId: string) => Promise<void>;
  cancelStreamWithSync: (streamId: string, keypair: Keypair) => Promise<string | null>;
  deleteStream: (streamId: string) => Promise<void>;
  processPayment: (streamId: string) => Promise<StreamPayment | null>;
  processAllDuePayments: () => Promise<StreamPayment[]>;
  resetAll: (walletAddress?: string) => Promise<void>;
  cancelAll: () => Promise<number>;
  cancelAllWithSync: (keypair: Keypair) => Promise<{ count: number; signatures: string[] }>;
  clearError: () => void;

  // Getters
  getActiveStreams: () => Stream[];
  getOutgoingStreams: () => Stream[];
  getIncomingStreams: () => Stream[];
  getStreamById: (id: string) => Stream | undefined;
}

export const useStreamStore = create<StreamState>((set, get) => ({
  // Initial state
  streams: [],
  loading: false,
  refreshing: false,
  syncing: false,
  error: null,
  stats: {
    totalOutgoing: 0,
    totalIncoming: 0,
    activeStreams: 0,
    monthlyOutflow: 0,
  },
  processingPayment: null,
  lastSyncTime: null,

  // Initialize - load streams from storage and optionally sync from chain
  initialize: async (walletAddress?: string) => {
    try {
      set({ loading: true, error: null });

      // Load local streams first
      const streams = await loadStreams();
      const stats = await getStreamStats();
      const lastSync = await getLastSyncTime();

      set({
        streams,
        stats,
        lastSyncTime: lastSync,
        loading: false,
      });

      // Auto-sync from chain if wallet provided and sync is due
      if (walletAddress) {
        const needsSync = await shouldSyncFromChain();
        if (needsSync) {
          // Sync in background without blocking
          get().syncFromChain(walletAddress).catch(err => {
            console.warn('[StreamStore] Background sync failed:', err);
          });
        }
      }
    } catch (error: any) {
      set({
        error: error.message || 'Failed to load streams',
        loading: false,
      });
    }
  },

  // Refresh streams with optional chain sync
  refresh: async (walletAddress?: string) => {
    try {
      set({ refreshing: true });

      // If wallet provided, sync from chain first
      if (walletAddress) {
        set({ syncing: true });
        try {
          await syncFromBlockchain(walletAddress);
        } catch (err) {
          console.warn('[StreamStore] Chain sync failed during refresh:', err);
        }
        set({ syncing: false });
      }

      const streams = await loadStreams();
      const stats = await getStreamStats();
      const lastSync = await getLastSyncTime();

      set({
        streams,
        stats,
        lastSyncTime: lastSync,
        refreshing: false,
        error: null,
      });
    } catch (error: any) {
      set({
        error: error.message || 'Failed to refresh streams',
        refreshing: false,
        syncing: false,
      });
    }
  },

  // Sync from blockchain
  syncFromChain: async (walletAddress: string) => {
    try {
      set({ syncing: true, error: null });

      const result = await syncFromBlockchain(walletAddress);

      // Reload streams after sync
      const streams = await loadStreams();
      const stats = await getStreamStats();
      const lastSync = await getLastSyncTime();

      set({
        streams,
        stats,
        lastSyncTime: lastSync,
        syncing: false,
      });

      return result;
    } catch (error: any) {
      set({
        error: error.message || 'Failed to sync from blockchain',
        syncing: false,
      });
      throw error;
    }
  },

  // Create a new stream
  createNewStream: async (params: CreateStreamParams) => {
    try {
      set({ loading: true, error: null });

      const stream = await createStream(params);

      // Refresh all streams
      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({
        streams,
        stats,
        loading: false,
      });

      return stream;
    } catch (error: any) {
      set({
        error: error.message || 'Failed to create stream',
        loading: false,
      });
      throw error;
    }
  },

  // Pause stream
  pauseStream: async (streamId: string) => {
    try {
      await pauseStream(streamId);

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({ streams, stats });
    } catch (error: any) {
      set({ error: error.message || 'Failed to pause stream' });
    }
  },

  // Resume stream
  resumeStream: async (streamId: string) => {
    try {
      await resumeStream(streamId);

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({ streams, stats });
    } catch (error: any) {
      set({ error: error.message || 'Failed to resume stream' });
    }
  },

  // Cancel stream
  cancelStream: async (streamId: string) => {
    try {
      await cancelStream(streamId);

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({ streams, stats });
    } catch (error: any) {
      set({ error: error.message || 'Failed to cancel stream' });
    }
  },

  // Cancel stream and publish to blockchain for cross-device sync
  cancelStreamWithSync: async (streamId: string, keypair: Keypair) => {
    try {
      set({ loading: true, error: null });

      const { signature } = await cancelStreamAndPublish(streamId, keypair);

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({ streams, stats, loading: false });
      return signature;
    } catch (error: any) {
      set({ error: error.message || 'Failed to cancel stream', loading: false });
      return null;
    }
  },

  // Delete stream
  deleteStream: async (streamId: string) => {
    try {
      await deleteStream(streamId);

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({ streams, stats });
    } catch (error: any) {
      set({ error: error.message || 'Failed to delete stream' });
    }
  },

  // Process a single payment
  processPayment: async (streamId: string) => {
    try {
      set({ processingPayment: streamId, error: null });

      const payment = await processStreamPayment(streamId);

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({
        streams,
        stats,
        processingPayment: null,
      });

      return payment;
    } catch (error: any) {
      set({
        error: error.message || 'Payment failed',
        processingPayment: null,
      });
      return null;
    }
  },

  // Process all due payments
  processAllDuePayments: async () => {
    try {
      set({ loading: true, error: null });

      const payments = await processDuePayments();

      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({
        streams,
        stats,
        loading: false,
      });

      return payments;
    } catch (error: any) {
      set({
        error: error.message || 'Failed to process payments',
        loading: false,
      });
      return [];
    }
  },

  // Reset all streams data and resync from blockchain
  resetAll: async (walletAddress?: string) => {
    try {
      set({ loading: true, error: null });

      // Clear all local data
      await resetAllStreamsData();

      // Reset state
      set({
        streams: [],
        stats: {
          totalOutgoing: 0,
          totalIncoming: 0,
          activeStreams: 0,
          monthlyOutflow: 0,
        },
        lastSyncTime: null,
      });

      // Resync from blockchain if wallet provided
      if (walletAddress) {
        await get().syncFromChain(walletAddress);
      }

      set({ loading: false });
    } catch (error: any) {
      set({
        error: error.message || 'Failed to reset streams',
        loading: false,
      });
    }
  },

  // Cancel all streams (move to history)
  cancelAll: async () => {
    try {
      set({ loading: true, error: null });

      const count = await cancelAllStreams();

      // Reload streams
      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({
        streams,
        stats,
        loading: false,
      });

      return count;
    } catch (error: any) {
      set({
        error: error.message || 'Failed to cancel streams',
        loading: false,
      });
      return 0;
    }
  },

  // Cancel all streams and publish to blockchain for cross-device sync
  cancelAllWithSync: async (keypair: Keypair) => {
    try {
      set({ loading: true, error: null });

      const result = await cancelAllStreamsAndPublish(keypair);

      // Reload streams
      const streams = await loadStreams();
      const stats = await getStreamStats();

      set({
        streams,
        stats,
        loading: false,
      });

      return result;
    } catch (error: any) {
      set({
        error: error.message || 'Failed to cancel streams',
        loading: false,
      });
      return { count: 0, signatures: [] };
    }
  },

  // Clear error
  clearError: () => {
    set({ error: null });
  },

  // Getters
  getActiveStreams: () => {
    return get().streams.filter(s => s.status === 'active');
  },

  getOutgoingStreams: () => {
    return get().streams.filter(s => s.direction === 'outgoing');
  },

  getIncomingStreams: () => {
    return get().streams.filter(s => s.direction === 'incoming');
  },

  getStreamById: (id: string) => {
    return get().streams.find(s => s.id === id);
  },
}));

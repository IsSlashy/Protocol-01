/**
 * Sharing Store — Zustand state for P2P note sharing (BLE + NFC)
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getShareService,
  type ShareServiceCallbacks,
} from '@/services/sharing';
import type {
  PeerInfo,
  ShareSession,
  ShareRecord,
  NotePayload,
  NoteType,
  ShareSessionState,
} from '@/services/sharing/types';

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

interface SharingState {
  // Connection state
  nearbyPeers: PeerInfo[];
  activeSession: Partial<ShareSession> | null;
  isScanning: boolean;
  isBleAvailable: boolean;
  isNfcAvailable: boolean;

  // NFC
  nfcPin: string | null;

  // History
  recentShares: ShareRecord[];

  // Received note awaiting import
  pendingNote: NotePayload | null;

  // Error
  error: string | null;

  // Actions — BLE
  checkAvailability: () => Promise<void>;
  startBleScan: () => Promise<void>;
  stopBleScan: () => void;
  connectToPeer: (peerId: string) => Promise<void>;
  confirmFingerprintAndSend: (noteType: NoteType, exportedData: string) => Promise<void>;
  confirmFingerprintAndReceive: () => Promise<void>;
  startBleReceiver: () => Promise<void>;

  // Actions — NFC
  generateNfcPin: () => string;
  sendViaNfc: (noteType: NoteType, exportedData: string, pin: string) => Promise<void>;
  startNfcReceiver: (pin: string) => Promise<void>;

  // Actions — General
  cancelSession: () => Promise<void>;
  clearPendingNote: () => void;
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSharingStore = create<SharingState>()(
  persist(
    (set, get) => {
      // Wire up ShareService callbacks on first use
      let callbacksWired = false;

      function ensureCallbacks() {
        if (callbacksWired) return;
        callbacksWired = true;

        const service = getShareService();
        const callbacks: ShareServiceCallbacks = {
          onSessionUpdate: (session) => {
            set({
              activeSession: session,
              isScanning: session.state === 'scanning',
            });
          },
          onPeerDiscovered: (peer) => {
            set((state) => {
              const existing = state.nearbyPeers.findIndex((p) => p.id === peer.id);
              const peers = [...state.nearbyPeers];
              if (existing >= 0) {
                peers[existing] = peer;
              } else {
                peers.push(peer);
              }
              return { nearbyPeers: peers };
            });
          },
          onPeerRemoved: (peerId) => {
            set((state) => ({
              nearbyPeers: state.nearbyPeers.filter((p) => p.id !== peerId),
            }));
          },
          onNoteReceived: (payload) => {
            set({ pendingNote: payload });
          },
          onError: (error) => {
            set({ error });
          },
          onShareComplete: (record) => {
            set((state) => ({
              recentShares: [record, ...state.recentShares].slice(0, 50),
            }));
          },
        };
        service.setCallbacks(callbacks);
      }

      return {
        // Initial state
        nearbyPeers: [],
        activeSession: null,
        isScanning: false,
        isBleAvailable: false,
        isNfcAvailable: false,
        nfcPin: null,
        recentShares: [],
        pendingNote: null,
        error: null,

        // ---------------------------------------------------------------
        // Availability
        // ---------------------------------------------------------------

        checkAvailability: async () => {
          ensureCallbacks();
          const service = getShareService();
          const [ble, nfc] = await Promise.allSettled([
            service.isBleAvailable(),
            service.isNfcAvailable(),
          ]);
          set({
            isBleAvailable: ble.status === 'fulfilled' && ble.value,
            isNfcAvailable: nfc.status === 'fulfilled' && nfc.value,
          });
        },

        // ---------------------------------------------------------------
        // BLE — Sender
        // ---------------------------------------------------------------

        startBleScan: async () => {
          ensureCallbacks();
          set({ nearbyPeers: [], error: null });
          await getShareService().startBleScan();
        },

        stopBleScan: () => {
          getShareService().stopBleScan();
          set({ isScanning: false });
        },

        connectToPeer: async (peerId) => {
          set({ error: null });
          await getShareService().connectToPeer(peerId);
        },

        confirmFingerprintAndSend: async (noteType, exportedData) => {
          const service = getShareService();
          const payload = service.prepareNote(noteType, exportedData);
          await service.confirmFingerprintAndSend(payload);
        },

        // ---------------------------------------------------------------
        // BLE — Receiver
        // ---------------------------------------------------------------

        startBleReceiver: async () => {
          ensureCallbacks();
          set({ nearbyPeers: [], error: null, pendingNote: null });
          await getShareService().startBleReceiver();
        },

        confirmFingerprintAndReceive: async () => {
          await getShareService().confirmFingerprintAndReceive();
        },

        // ---------------------------------------------------------------
        // NFC
        // ---------------------------------------------------------------

        generateNfcPin: () => {
          ensureCallbacks();
          const pin = getShareService().generateNfcPin();
          set({ nfcPin: pin });
          return pin;
        },

        sendViaNfc: async (noteType, exportedData, pin) => {
          ensureCallbacks();
          set({ error: null });
          const service = getShareService();
          const payload = service.prepareNote(noteType, exportedData);
          await service.sendViaNfc(payload, pin);
        },

        startNfcReceiver: async (pin) => {
          ensureCallbacks();
          set({ error: null, pendingNote: null });
          await getShareService().startNfcReceiver(pin);
        },

        // ---------------------------------------------------------------
        // General
        // ---------------------------------------------------------------

        cancelSession: async () => {
          await getShareService().cancelSession();
          set({
            activeSession: null,
            isScanning: false,
            nearbyPeers: [],
            nfcPin: null,
            error: null,
          });
        },

        clearPendingNote: () => set({ pendingNote: null }),
        clearError: () => set({ error: null }),
      };
    },
    {
      name: 'p01-sharing',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        recentShares: state.recentShares,
      }),
    },
  ),
);

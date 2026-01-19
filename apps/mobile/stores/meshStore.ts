/**
 * P-01 Mesh Store - State management for Bluetooth mesh network
 *
 * Features:
 * - Peer discovery and connection
 * - Zone-based proximity management
 * - Encrypted messaging
 * - Offline transaction queue
 * - Mesh relay protocol
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MeshPeer,
  MeshMessage,
  MeshIdentity,
  getOrCreateIdentity,
  updateAlias as updateIdentityAlias,
  savePeer,
  getKnownPeers,
  setTrustPeer,
  createMessage,
  estimateDistance,
} from '../services/mesh/bluetooth';
import {
  startScanning as startBleScan,
  stopScanning as stopBleScan,
  isScanningActive,
  requestBluetoothPermissions,
  isBluetoothEnabled,
  getBluetoothState,
  connectToPeer as bleConnectToPeer,
  disconnectFromPeer as bleDisconnectFromPeer,
  setAdvertisingName,
} from '../services/mesh/bleManager';
import {
  MeshZone,
  getZoneFromRSSI,
  getZoneInfo,
  getZoneIndicators,
  groupPeersByZone,
  calculateMeshStats,
  canTransactInZone,
  ZoneIndicator,
} from '../services/mesh/zones';
import {
  OfflineTransaction,
  OfflineTxStatus,
  getPendingTransactions,
  createOfflineTransfer,
  createOfflineSwap,
  signTransactionOffline,
  queueForBroadcast,
  broadcastTransaction,
  getQueueStats,
  cancelTransaction,
  retryTransaction,
} from '../services/mesh/offline';
import {
  MeshPacket,
  createDiscoveryPacket,
  createTextPacket,
  createPaymentRequestPacket,
  shouldRelay,
  isForMe,
  serializePacket,
  deserializePacket,
} from '../services/mesh/protocol';

// Storage keys
const MESSAGES_KEY = '@p01_mesh_messages';
const CHATS_KEY = '@p01_mesh_chats';
const CONNECTION_REQUESTS_KEY = '@p01_connection_requests';
const SAVED_CONTACTS_KEY = '@p01_mesh_contacts';

// Connection request status
export enum ConnectionRequestStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

// Connection request (incoming or outgoing)
export interface ConnectionRequest {
  id: string;
  fromId: string;
  fromAlias: string;
  fromAddress: string;
  toId: string;
  toAlias: string;
  toAddress: string;
  status: ConnectionRequestStatus;
  isIncoming: boolean;
  createdAt: number;
  expiresAt: number;
  rssi?: number;
  zone?: MeshZone;
}

// Saved mesh contact (from QR code)
export interface MeshContact {
  id: string;
  alias: string;
  address: string;  // Solana wallet address
  publicKey: string;
  addedAt: number;
  addedVia: 'qr' | 'bluetooth' | 'manual';
  isOnline?: boolean;
  lastSeen?: number;
}

// Proximity detection state
export interface ProximityState {
  isDetecting: boolean;
  detectedPeer: MeshPeer | null;
  showBumpModal: boolean;
}

export interface Chat {
  peerId: string;
  peerAlias: string;
  peerZone: MeshZone;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
}

export interface MeshStats {
  totalPeers: number;
  connectedPeers: number;
  trustedPeers: number;
  alphaCount: number;
  betaCount: number;
  gammaCount: number;
  relayCount: number;
  meshStrength: number;
  canTransact: boolean;
  canRelay: boolean;
}

interface MeshState {
  // Identity
  identity: MeshIdentity | null;
  isInitialized: boolean;

  // Bluetooth state
  isBluetoothEnabled: boolean;
  isScanning: boolean;
  isBroadcasting: boolean;

  // Peers by zone
  nearbyPeers: MeshPeer[];
  trustedPeers: MeshPeer[];
  peersByZone: Record<MeshZone, MeshPeer[]>;
  zoneIndicators: ZoneIndicator[];
  meshStats: MeshStats;

  // Active zone (current focus)
  activeZone: MeshZone;

  // Messages
  chats: Chat[];
  messages: Record<string, MeshMessage[]>;

  // Offline transactions
  pendingTransactions: OfflineTransaction[];
  txQueueStats: ReturnType<typeof getQueueStats> extends Promise<infer T> ? T : never;

  // Relay queue
  relayQueue: MeshPacket[];

  // Connection requests
  connectionRequests: ConnectionRequest[];
  pendingConnectionCount: number;

  // Saved contacts (from QR)
  meshContacts: MeshContact[];

  // Proximity detection
  proximity: ProximityState;

  // UI State
  error: string | null;
  isOnline: boolean;

  // Actions
  initialize: () => Promise<void>;
  updateAlias: (alias: string) => Promise<void>;
  startScanning: () => Promise<void>;
  stopScanning: () => void;
  startBroadcasting: () => Promise<void>;
  stopBroadcasting: () => void;
  setActiveZone: (zone: MeshZone) => void;
  connectToPeer: (peerId: string) => Promise<void>;
  disconnectFromPeer: (peerId: string) => void;
  trustPeer: (peerId: string) => Promise<void>;
  untrustPeer: (peerId: string) => Promise<void>;
  sendMessage: (peerId: string, content: string) => Promise<void>;
  sendPaymentRequest: (peerId: string, amount: number, currency: string, memo?: string) => Promise<void>;
  loadMessages: (peerId: string) => Promise<void>;
  markAsRead: (peerId: string) => void;

  // Offline transactions
  createTransfer: (toAddress: string, amount: number, currency: string, memo?: string) => Promise<OfflineTransaction>;
  createSwap: (fromCurrency: string, fromAmount: number, toCurrency: string, toAmount: number) => Promise<OfflineTransaction>;
  signAndQueue: (txId: string) => Promise<void>;
  broadcastWhenOnline: () => Promise<void>;
  cancelTx: (txId: string) => Promise<void>;
  retryTx: (txId: string) => Promise<void>;
  refreshPendingTx: () => Promise<void>;

  // Relay
  addToRelayQueue: (packet: MeshPacket) => void;
  processRelayQueue: () => Promise<void>;

  // Connection requests
  sendConnectionRequest: (peerId: string) => Promise<void>;
  acceptConnectionRequest: (requestId: string) => Promise<void>;
  rejectConnectionRequest: (requestId: string) => Promise<void>;
  cancelConnectionRequest: (requestId: string) => Promise<void>;
  receiveConnectionRequest: (request: ConnectionRequest) => void;

  // Mesh contacts (QR)
  addContactFromQR: (qrData: string) => Promise<MeshContact | null>;
  removeContact: (contactId: string) => Promise<void>;
  getContactByAddress: (address: string) => MeshContact | null;

  // Proximity
  setProximityDetection: (detecting: boolean) => void;
  handleProximityBump: (peer: MeshPeer) => void;
  dismissProximityBump: () => void;

  clearError: () => void;
  setOnlineStatus: (isOnline: boolean) => void;
}

const initialMeshStats: MeshStats = {
  totalPeers: 0,
  connectedPeers: 0,
  trustedPeers: 0,
  alphaCount: 0,
  betaCount: 0,
  gammaCount: 0,
  relayCount: 0,
  meshStrength: 0,
  canTransact: false,
  canRelay: false,
};

const initialTxQueueStats = {
  total: 0,
  created: 0,
  signed: 0,
  queued: 0,
  relaying: 0,
  broadcasting: 0,
  failed: 0,
  expired: 0,
};

const initialProximityState: ProximityState = {
  isDetecting: false,
  detectedPeer: null,
  showBumpModal: false,
};

export const useMeshStore = create<MeshState>((set, get) => ({
  // Initial state
  identity: null,
  isInitialized: false,
  isBluetoothEnabled: false,
  isScanning: false,
  isBroadcasting: false,
  nearbyPeers: [],
  trustedPeers: [],
  peersByZone: {
    [MeshZone.ALPHA]: [],
    [MeshZone.BETA]: [],
    [MeshZone.GAMMA]: [],
    [MeshZone.RELAY]: [],
    [MeshZone.OFFLINE]: [],
  },
  zoneIndicators: [],
  meshStats: initialMeshStats,
  activeZone: MeshZone.ALPHA,
  chats: [],
  messages: {},
  pendingTransactions: [],
  txQueueStats: initialTxQueueStats,
  relayQueue: [],
  connectionRequests: [],
  pendingConnectionCount: 0,
  meshContacts: [],
  proximity: initialProximityState,
  error: null,
  isOnline: false,

  // Initialize mesh network
  initialize: async () => {
    try {
      // Get or create identity
      const identity = await getOrCreateIdentity();

      // Load trusted peers
      const knownPeers = await getKnownPeers();
      const trustedPeers = knownPeers.filter(p => p.isTrusted);

      // Load chats
      const chatsData = await AsyncStorage.getItem(CHATS_KEY);
      const chats: Chat[] = chatsData ? JSON.parse(chatsData) : [];

      // Load pending transactions
      const pendingTransactions = await getPendingTransactions();
      const txQueueStats = await getQueueStats();

      // Load connection requests
      const requestsData = await AsyncStorage.getItem(CONNECTION_REQUESTS_KEY);
      const connectionRequests: ConnectionRequest[] = requestsData ? JSON.parse(requestsData) : [];
      const pendingRequests = connectionRequests.filter(
        r => r.status === ConnectionRequestStatus.PENDING && r.isIncoming
      );

      // Load mesh contacts
      const contactsData = await AsyncStorage.getItem(SAVED_CONTACTS_KEY);
      const meshContacts: MeshContact[] = contactsData ? JSON.parse(contactsData) : [];

      set({
        identity,
        trustedPeers,
        chats,
        pendingTransactions,
        txQueueStats,
        connectionRequests,
        pendingConnectionCount: pendingRequests.length,
        meshContacts,
        isInitialized: true,
        isBluetoothEnabled: true,
      });
    } catch (error: any) {
      set({ error: error.message, isInitialized: true });
    }
  },

  // Update alias
  updateAlias: async (alias: string) => {
    try {
      await updateIdentityAlias(alias);
      const identity = get().identity;
      if (identity) {
        set({ identity: { ...identity, alias } });
      }
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Start scanning for nearby peers
  startScanning: async () => {
    try {
      set({ isScanning: true, error: null });

      // Check Bluetooth state
      const btState = await getBluetoothState();
      if (btState !== 'on') {
        set({
          error: btState === 'off'
            ? 'Bluetooth is off. Please enable Bluetooth to discover nearby peers.'
            : `Bluetooth unavailable: ${btState}`,
          isScanning: false,
          isBluetoothEnabled: false,
        });
        return;
      }

      set({ isBluetoothEnabled: true });

      // Set up advertising name (for other devices to see us)
      await setAdvertisingName();

      // Start real BLE scanning
      const success = await startBleScan((discoveredPeers: MeshPeer[]) => {
        // This callback is called whenever peers are discovered/updated
        const knownPeersPromise = getKnownPeers();

        knownPeersPromise.then(knownPeers => {
          // Merge with known peer data
          const nearbyPeers = discoveredPeers.map(peer => {
            const known = knownPeers.find(p => p.id === peer.id || p.publicKey === peer.publicKey);
            return known ? { ...peer, isTrusted: known.isTrusted, alias: known.alias || peer.alias } : peer;
          });

          // Group by zone
          const peersByZone = groupPeersByZone(nearbyPeers);
          const zoneIndicators = getZoneIndicators(nearbyPeers);
          const meshStats = calculateMeshStats(nearbyPeers);

          set({
            nearbyPeers,
            peersByZone,
            zoneIndicators,
            meshStats,
          });
        });
      });

      if (!success) {
        set({
          error: 'Failed to start Bluetooth scanning. Please check permissions.',
          isScanning: false,
        });
        return;
      }

      // Keep scanning state active (will be updated via callback)
      // The scanning will continue until stopScanning is called
    } catch (error: any) {
      set({ error: error.message, isScanning: false });
    }
  },

  // Stop scanning
  stopScanning: () => {
    stopBleScan();
    set({ isScanning: false });
  },

  // Start broadcasting presence
  startBroadcasting: async () => {
    try {
      const { identity, activeZone } = get();
      if (!identity) return;

      set({ isBroadcasting: true });

      // Create discovery packet
      const packet = await createDiscoveryPacket(identity, activeZone);
      console.log('Broadcasting:', packet.senderId);

      // In production, send via BLE advertising
    } catch (error: any) {
      set({ error: error.message, isBroadcasting: false });
    }
  },

  // Stop broadcasting
  stopBroadcasting: () => {
    set({ isBroadcasting: false });
  },

  // Set active zone
  setActiveZone: (zone: MeshZone) => {
    set({ activeZone: zone });
  },

  // Connect to peer
  connectToPeer: async (peerId: string) => {
    try {
      const { nearbyPeers } = get();
      const peer = nearbyPeers.find(p => p.id === peerId);

      if (peer) {
        // Try to connect via BLE
        const device = await bleConnectToPeer(peerId);

        if (device) {
          const updatedPeers = nearbyPeers.map(p =>
            p.id === peerId ? { ...p, isConnected: true } : p
          );

          const peersByZone = groupPeersByZone(updatedPeers);
          const meshStats = calculateMeshStats(updatedPeers);

          set({ nearbyPeers: updatedPeers, peersByZone, meshStats });

          // Save as known peer
          await savePeer({ ...peer, isConnected: true });
        } else {
          set({ error: 'Failed to connect to peer' });
        }
      }
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Disconnect from peer
  disconnectFromPeer: async (peerId: string) => {
    // Disconnect via BLE
    await bleDisconnectFromPeer(peerId);

    const { nearbyPeers } = get();
    const updatedPeers = nearbyPeers.map(p =>
      p.id === peerId ? { ...p, isConnected: false } : p
    );
    const meshStats = calculateMeshStats(updatedPeers);
    set({ nearbyPeers: updatedPeers, meshStats });
  },

  // Trust peer
  trustPeer: async (peerId: string) => {
    try {
      await setTrustPeer(peerId, true);

      const { nearbyPeers, trustedPeers } = get();

      const updatedNearby = nearbyPeers.map(p =>
        p.id === peerId ? { ...p, isTrusted: true } : p
      );

      const peer = nearbyPeers.find(p => p.id === peerId);
      const isAlreadyTrusted = trustedPeers.some(p => p.id === peerId);

      if (peer && !isAlreadyTrusted) {
        const meshStats = calculateMeshStats(updatedNearby);
        set({
          nearbyPeers: updatedNearby,
          trustedPeers: [...trustedPeers, { ...peer, isTrusted: true }],
          meshStats,
        });
      } else {
        set({ nearbyPeers: updatedNearby });
      }
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Untrust peer
  untrustPeer: async (peerId: string) => {
    try {
      await setTrustPeer(peerId, false);

      const { nearbyPeers, trustedPeers } = get();

      const updatedNearby = nearbyPeers.map(p =>
        p.id === peerId ? { ...p, isTrusted: false } : p
      );

      const updatedTrusted = trustedPeers.filter(p => p.id !== peerId);
      const meshStats = calculateMeshStats(updatedNearby);

      set({
        nearbyPeers: updatedNearby,
        trustedPeers: updatedTrusted,
        meshStats,
      });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Send message
  sendMessage: async (peerId: string, content: string) => {
    try {
      const { identity, messages, chats, nearbyPeers, trustedPeers } = get();
      if (!identity) throw new Error('Not initialized');

      // Create message
      const message = await createMessage(peerId, content, 'text');

      // Add to messages
      const peerMessages = messages[peerId] || [];
      const updatedMessages = {
        ...messages,
        [peerId]: [...peerMessages, message],
      };

      // Get peer info
      const peer = nearbyPeers.find(p => p.id === peerId) ||
                   trustedPeers.find(p => p.id === peerId);
      const peerAlias = peer?.alias || 'Unknown';
      const peerZone = peer ? getZoneFromRSSI(peer.rssi) : MeshZone.OFFLINE;

      // Update or create chat
      const existingChatIndex = chats.findIndex(c => c.peerId === peerId);
      let updatedChats: Chat[];

      if (existingChatIndex >= 0) {
        updatedChats = [...chats];
        updatedChats[existingChatIndex] = {
          ...updatedChats[existingChatIndex],
          lastMessage: content,
          lastMessageTime: Date.now(),
          peerZone,
        };
      } else {
        updatedChats = [
          {
            peerId,
            peerAlias,
            peerZone,
            lastMessage: content,
            lastMessageTime: Date.now(),
            unreadCount: 0,
          },
          ...chats,
        ];
      }

      set({
        messages: updatedMessages,
        chats: updatedChats,
      });

      // Persist
      await AsyncStorage.setItem(
        `${MESSAGES_KEY}_${peerId}`,
        JSON.stringify(updatedMessages[peerId])
      );
      await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(updatedChats));

      // Create and queue packet for transmission
      if (peer) {
        const packet = await createTextPacket(
          identity.id,
          peerId,
          content,
          peer.publicKey
        );
        console.log('Sending packet:', packet.messageId);
        // In production, send via BLE
      }
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Send payment request
  sendPaymentRequest: async (peerId: string, amount: number, currency: string, memo?: string) => {
    try {
      const { identity, nearbyPeers, trustedPeers } = get();
      if (!identity) throw new Error('Not initialized');

      const peer = nearbyPeers.find(p => p.id === peerId) ||
                   trustedPeers.find(p => p.id === peerId);

      if (!peer) throw new Error('Peer not found');

      // Check if peer is in transactable zone
      const peerZone = getZoneFromRSSI(peer.rssi);
      if (!canTransactInZone(peerZone)) {
        throw new Error(`Cannot transact in ${peerZone} zone. Move closer to the peer.`);
      }

      // Create payment request packet
      const packet = await createPaymentRequestPacket(
        identity.id,
        peerId,
        amount,
        currency,
        identity.publicKey, // Our address for receiving
        memo
      );

      console.log('Payment request:', packet.messageId);

      // Also create message for chat
      const message = await createMessage(
        peerId,
        `Payment Request: ${amount} ${currency}${memo ? ` - ${memo}` : ''}`,
        'payment_request'
      );

      // Add to messages
      const { messages, chats } = get();
      const peerMessages = messages[peerId] || [];
      const updatedMessages = {
        ...messages,
        [peerId]: [...peerMessages, message],
      };

      set({ messages: updatedMessages });

      await AsyncStorage.setItem(
        `${MESSAGES_KEY}_${peerId}`,
        JSON.stringify(updatedMessages[peerId])
      );

      // In production, send packet via BLE
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Load messages for peer
  loadMessages: async (peerId: string) => {
    try {
      const stored = await AsyncStorage.getItem(`${MESSAGES_KEY}_${peerId}`);
      const peerMessages: MeshMessage[] = stored ? JSON.parse(stored) : [];

      set(state => ({
        messages: {
          ...state.messages,
          [peerId]: peerMessages,
        },
      }));
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Mark messages as read
  markAsRead: (peerId: string) => {
    const { chats } = get();
    const updatedChats = chats.map(c =>
      c.peerId === peerId ? { ...c, unreadCount: 0 } : c
    );
    set({ chats: updatedChats });
    AsyncStorage.setItem(CHATS_KEY, JSON.stringify(updatedChats));
  },

  // Create offline transfer
  createTransfer: async (toAddress: string, amount: number, currency: string, memo?: string) => {
    try {
      const { identity } = get();
      if (!identity) throw new Error('Not initialized');

      const tx = await createOfflineTransfer(
        identity.publicKey,
        toAddress,
        amount,
        currency,
        memo
      );

      await get().refreshPendingTx();
      return tx;
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Create offline swap
  createSwap: async (fromCurrency: string, fromAmount: number, toCurrency: string, toAmount: number) => {
    try {
      const { identity } = get();
      if (!identity) throw new Error('Not initialized');

      const tx = await createOfflineSwap(
        identity.publicKey,
        fromCurrency,
        fromAmount,
        toCurrency,
        toAmount
      );

      await get().refreshPendingTx();
      return tx;
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Sign and queue transaction
  signAndQueue: async (txId: string) => {
    try {
      const { identity } = get();
      if (!identity) throw new Error('Not initialized');

      await signTransactionOffline(txId, identity.privateKey);
      await queueForBroadcast(txId);
      await get().refreshPendingTx();
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Broadcast queued transactions when online
  broadcastWhenOnline: async () => {
    try {
      const { pendingTransactions, isOnline } = get();

      if (!isOnline) {
        console.log('Offline - transactions will be relayed via mesh');
        return;
      }

      const queuedTxs = pendingTransactions.filter(
        tx => tx.status === OfflineTxStatus.QUEUED
      );

      for (const tx of queuedTxs) {
        try {
          const result = await broadcastTransaction(tx.id);
          if (result.success) {
            console.log('Transaction confirmed:', result.signature);
          }
        } catch (error) {
          console.error('Broadcast failed for', tx.id);
        }
      }

      await get().refreshPendingTx();
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Cancel transaction
  cancelTx: async (txId: string) => {
    try {
      await cancelTransaction(txId);
      await get().refreshPendingTx();
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Retry transaction
  retryTx: async (txId: string) => {
    try {
      await retryTransaction(txId);
      await get().refreshPendingTx();
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Refresh pending transactions
  refreshPendingTx: async () => {
    try {
      const pendingTransactions = await getPendingTransactions();
      const txQueueStats = await getQueueStats();
      set({ pendingTransactions, txQueueStats });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Add packet to relay queue
  addToRelayQueue: (packet: MeshPacket) => {
    const { identity, relayQueue } = get();
    if (!identity) return;

    // Check if we should relay this packet
    if (shouldRelay(packet, identity.id)) {
      set({ relayQueue: [...relayQueue, packet] });
    }
  },

  // Process relay queue
  processRelayQueue: async () => {
    try {
      const { relayQueue, nearbyPeers, identity } = get();
      if (!identity || relayQueue.length === 0) return;

      const connectedPeers = nearbyPeers.filter(p => p.isConnected);

      for (const packet of relayQueue) {
        // Find best peer to relay to
        for (const peer of connectedPeers) {
          if (!packet.relayPath.includes(peer.id)) {
            // Relay packet to peer
            console.log(`Relaying ${packet.messageId} to ${peer.alias}`);
            // In production, send via BLE
          }
        }
      }

      // Clear processed packets
      set({ relayQueue: [] });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Clear error
  clearError: () => set({ error: null }),

  // Set online status
  setOnlineStatus: (isOnline: boolean) => {
    set({ isOnline });
    if (isOnline) {
      // Try to broadcast queued transactions
      get().broadcastWhenOnline();
    }
  },

  // Send connection request to peer
  sendConnectionRequest: async (peerId: string) => {
    try {
      const { identity, nearbyPeers, connectionRequests } = get();
      if (!identity) throw new Error('Not initialized');

      const peer = nearbyPeers.find(p => p.id === peerId);
      if (!peer) throw new Error('Peer not found');

      // Check if request already exists
      const existing = connectionRequests.find(
        r => r.toId === peerId && r.status === ConnectionRequestStatus.PENDING
      );
      if (existing) throw new Error('Connection request already sent');

      const request: ConnectionRequest = {
        id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromId: identity.id,
        fromAlias: identity.alias,
        fromAddress: identity.publicKey,
        toId: peer.id,
        toAlias: peer.alias,
        toAddress: peer.publicKey,
        status: ConnectionRequestStatus.PENDING,
        isIncoming: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
        rssi: peer.rssi,
        zone: getZoneFromRSSI(peer.rssi),
      };

      const updatedRequests = [...connectionRequests, request];
      set({ connectionRequests: updatedRequests });

      await AsyncStorage.setItem(CONNECTION_REQUESTS_KEY, JSON.stringify(updatedRequests));

      // In production, send via BLE
      console.log('Connection request sent to:', peer.alias);
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Accept incoming connection request
  acceptConnectionRequest: async (requestId: string) => {
    try {
      const { connectionRequests, nearbyPeers } = get();

      const request = connectionRequests.find(r => r.id === requestId);
      if (!request) throw new Error('Request not found');

      if (!request.isIncoming) throw new Error('Cannot accept outgoing request');

      // Update request status
      const updatedRequests = connectionRequests.map(r =>
        r.id === requestId ? { ...r, status: ConnectionRequestStatus.ACCEPTED } : r
      );

      // Add peer as connected and trusted
      const peer = nearbyPeers.find(p => p.id === request.fromId);
      if (peer) {
        const updatedPeers = nearbyPeers.map(p =>
          p.id === request.fromId ? { ...p, isConnected: true, isTrusted: true } : p
        );
        const peersByZone = groupPeersByZone(updatedPeers);
        const meshStats = calculateMeshStats(updatedPeers);

        set({
          connectionRequests: updatedRequests,
          nearbyPeers: updatedPeers,
          peersByZone,
          meshStats,
          pendingConnectionCount: updatedRequests.filter(
            r => r.status === ConnectionRequestStatus.PENDING && r.isIncoming
          ).length,
        });

        await savePeer({ ...peer, isConnected: true, isTrusted: true });
      } else {
        set({
          connectionRequests: updatedRequests,
          pendingConnectionCount: updatedRequests.filter(
            r => r.status === ConnectionRequestStatus.PENDING && r.isIncoming
          ).length,
        });
      }

      await AsyncStorage.setItem(CONNECTION_REQUESTS_KEY, JSON.stringify(updatedRequests));

      // In production, send acceptance via BLE
      console.log('Connection accepted from:', request.fromAlias);
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Reject incoming connection request
  rejectConnectionRequest: async (requestId: string) => {
    try {
      const { connectionRequests } = get();

      const updatedRequests = connectionRequests.map(r =>
        r.id === requestId ? { ...r, status: ConnectionRequestStatus.REJECTED } : r
      );

      set({
        connectionRequests: updatedRequests,
        pendingConnectionCount: updatedRequests.filter(
          r => r.status === ConnectionRequestStatus.PENDING && r.isIncoming
        ).length,
      });

      await AsyncStorage.setItem(CONNECTION_REQUESTS_KEY, JSON.stringify(updatedRequests));
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Cancel outgoing connection request
  cancelConnectionRequest: async (requestId: string) => {
    try {
      const { connectionRequests } = get();

      const updatedRequests = connectionRequests.filter(r => r.id !== requestId);

      set({ connectionRequests: updatedRequests });
      await AsyncStorage.setItem(CONNECTION_REQUESTS_KEY, JSON.stringify(updatedRequests));
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Receive incoming connection request (from BLE)
  receiveConnectionRequest: (request: ConnectionRequest) => {
    const { connectionRequests, identity } = get();

    // Validate it's for us
    if (identity && request.toId === identity.id) {
      const updatedRequests = [...connectionRequests, { ...request, isIncoming: true }];
      const pendingCount = updatedRequests.filter(
        r => r.status === ConnectionRequestStatus.PENDING && r.isIncoming
      ).length;

      set({
        connectionRequests: updatedRequests,
        pendingConnectionCount: pendingCount,
      });

      AsyncStorage.setItem(CONNECTION_REQUESTS_KEY, JSON.stringify(updatedRequests));
    }
  },

  // Add contact from QR code
  addContactFromQR: async (qrData: string) => {
    try {
      const { meshContacts, identity } = get();
      if (!identity) throw new Error('Not initialized');

      // Parse QR data
      // Expected format: p01://connect?address=XXX&alias=YYY&pubkey=ZZZ
      let address = '';
      let alias = '';
      let publicKey = '';

      if (qrData.startsWith('p01://')) {
        const url = new URL(qrData);
        address = url.searchParams.get('address') || '';
        alias = url.searchParams.get('alias') || 'Unknown';
        publicKey = url.searchParams.get('pubkey') || address;
      } else if (qrData.startsWith('solana:')) {
        // Solana Pay format: solana:ADDRESS
        address = qrData.replace('solana:', '').split('?')[0];
        alias = `Wallet ${address.slice(0, 4)}...${address.slice(-4)}`;
        publicKey = address;
      } else {
        // Assume it's just an address
        address = qrData;
        alias = `Wallet ${address.slice(0, 4)}...${address.slice(-4)}`;
        publicKey = address;
      }

      if (!address) throw new Error('Invalid QR code');

      // Check if already exists
      const existing = meshContacts.find(c => c.address === address);
      if (existing) {
        return existing;
      }

      // Don't add yourself
      if (address === identity.publicKey) {
        throw new Error('Cannot add yourself as a contact');
      }

      const contact: MeshContact = {
        id: `contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        alias,
        address,
        publicKey,
        addedAt: Date.now(),
        addedVia: 'qr',
        isOnline: false,
      };

      const updatedContacts = [...meshContacts, contact];
      set({ meshContacts: updatedContacts });

      await AsyncStorage.setItem(SAVED_CONTACTS_KEY, JSON.stringify(updatedContacts));

      return contact;
    } catch (error: any) {
      set({ error: error.message });
      return null;
    }
  },

  // Remove contact
  removeContact: async (contactId: string) => {
    try {
      const { meshContacts } = get();
      const updatedContacts = meshContacts.filter(c => c.id !== contactId);

      set({ meshContacts: updatedContacts });
      await AsyncStorage.setItem(SAVED_CONTACTS_KEY, JSON.stringify(updatedContacts));
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Get contact by address
  getContactByAddress: (address: string) => {
    const { meshContacts } = get();
    return meshContacts.find(c => c.address === address) || null;
  },

  // Proximity detection
  setProximityDetection: (detecting: boolean) => {
    set(state => ({
      proximity: { ...state.proximity, isDetecting: detecting },
    }));
  },

  // Handle proximity bump (when device is very close)
  handleProximityBump: (peer: MeshPeer) => {
    const zone = getZoneFromRSSI(peer.rssi);

    // Only trigger bump for Alpha zone (very close)
    if (zone === MeshZone.ALPHA) {
      set(state => ({
        proximity: {
          ...state.proximity,
          detectedPeer: peer,
          showBumpModal: true,
        },
      }));
    }
  },

  // Dismiss proximity bump modal
  dismissProximityBump: () => {
    set(state => ({
      proximity: {
        ...state.proximity,
        detectedPeer: null,
        showBumpModal: false,
      },
    }));
  },
}));

/**
 * P-01 Mesh - Anonymous Bluetooth Mesh Network
 *
 * Enables peer-to-peer anonymous communication via Bluetooth LE
 * Similar to AnonMesh concept - no internet required
 */

import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Storage keys
const MESH_ID_KEY = '@p01_mesh_id';
const MESH_KEYS_KEY = '@p01_mesh_keys';
const KNOWN_PEERS_KEY = '@p01_known_peers';

// Mesh configuration
export const MESH_CONFIG = {
  SERVICE_UUID: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
  CHAR_TX_UUID: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E',
  CHAR_RX_UUID: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E',
  SCAN_DURATION: 10000, // 10 seconds
  BROADCAST_INTERVAL: 5000, // 5 seconds
  MAX_MESSAGE_SIZE: 512, // bytes
  MESSAGE_TTL: 5, // hops
  DISCOVERY_RANGE: 30, // meters (approximate)
};

// Types
export interface MeshPeer {
  id: string;
  alias: string;
  publicKey: string;
  lastSeen: number;
  rssi: number;
  distance: string;
  isConnected: boolean;
  isTrusted: boolean;
}

export interface MeshMessage {
  id: string;
  fromId: string;
  toId: string;
  content: string;
  encrypted: boolean;
  timestamp: number;
  ttl: number;
  signature: string;
  type: 'text' | 'payment_request' | 'payment' | 'file' | 'ping';
}

export interface MeshIdentity {
  id: string;
  alias: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

export interface PaymentRequest {
  amount: number;
  token: string;
  memo: string;
  recipient: string;
}

// Generate anonymous mesh ID
export async function generateMeshId(): Promise<string> {
  const randomBytes = await Crypto.getRandomBytesAsync(16);
  const hex = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `SPEC_${hex.slice(0, 12).toUpperCase()}`;
}

// Generate random alias
export function generateAlias(): string {
  const adjectives = [
    'Shadow', 'Ghost', 'Phantom', 'Stealth', 'Silent', 'Crypto',
    'Cipher', 'Anon', 'Dark', 'Mystic', 'Quantum', 'Zero',
    'Binary', 'Hex', 'Null', 'Void', 'Echo', 'Spectre'
  ];
  const nouns = [
    'Wolf', 'Raven', 'Phoenix', 'Dragon', 'Falcon', 'Viper',
    'Cobra', 'Tiger', 'Panther', 'Hawk', 'Eagle', 'Shark',
    'Fox', 'Bear', 'Lion', 'Jaguar', 'Owl', 'Lynx'
  ];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 1000);
  return `${adj}${noun}${num}`;
}

// Estimate distance from RSSI
export function estimateDistance(rssi: number): string {
  if (rssi >= -50) return '< 1m';
  if (rssi >= -60) return '1-3m';
  if (rssi >= -70) return '3-10m';
  if (rssi >= -80) return '10-20m';
  if (rssi >= -90) return '20-30m';
  return '> 30m';
}

// Create or load mesh identity
export async function getOrCreateIdentity(): Promise<MeshIdentity> {
  try {
    const stored = await AsyncStorage.getItem(MESH_KEYS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }

    // Generate new identity
    const id = await generateMeshId();
    const alias = generateAlias();

    // Generate key pair (simplified - in production use proper ECDH)
    const keyBytes = await Crypto.getRandomBytesAsync(32);
    const publicKey = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    );
    const privateKey = Array.from(keyBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const identity: MeshIdentity = {
      id,
      alias,
      publicKey: publicKey.slice(0, 32),
      privateKey,
      createdAt: Date.now(),
    };

    await AsyncStorage.setItem(MESH_KEYS_KEY, JSON.stringify(identity));
    return identity;
  } catch (error) {
    console.error('Failed to get/create identity:', error);
    throw error;
  }
}

// Update alias
export async function updateAlias(newAlias: string): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(MESH_KEYS_KEY);
    if (stored) {
      const identity = JSON.parse(stored);
      identity.alias = newAlias;
      await AsyncStorage.setItem(MESH_KEYS_KEY, JSON.stringify(identity));
    }
  } catch (error) {
    console.error('Failed to update alias:', error);
  }
}

// Save known peer
export async function savePeer(peer: MeshPeer): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(KNOWN_PEERS_KEY);
    const peers: MeshPeer[] = stored ? JSON.parse(stored) : [];

    const existingIndex = peers.findIndex(p => p.id === peer.id);
    if (existingIndex >= 0) {
      peers[existingIndex] = { ...peers[existingIndex], ...peer };
    } else {
      peers.push(peer);
    }

    await AsyncStorage.setItem(KNOWN_PEERS_KEY, JSON.stringify(peers));
  } catch (error) {
    console.error('Failed to save peer:', error);
  }
}

// Get known peers
export async function getKnownPeers(): Promise<MeshPeer[]> {
  try {
    const stored = await AsyncStorage.getItem(KNOWN_PEERS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to get known peers:', error);
    return [];
  }
}

// Trust/untrust peer
export async function setTrustPeer(peerId: string, trusted: boolean): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(KNOWN_PEERS_KEY);
    const peers: MeshPeer[] = stored ? JSON.parse(stored) : [];

    const peer = peers.find(p => p.id === peerId);
    if (peer) {
      peer.isTrusted = trusted;
      await AsyncStorage.setItem(KNOWN_PEERS_KEY, JSON.stringify(peers));
    }
  } catch (error) {
    console.error('Failed to set trust:', error);
  }
}

// Create message
export async function createMessage(
  toId: string,
  content: string,
  type: MeshMessage['type'] = 'text'
): Promise<MeshMessage> {
  const identity = await getOrCreateIdentity();
  const messageId = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${identity.id}-${toId}-${Date.now()}-${Math.random()}`
  );

  // Sign message (simplified)
  const signature = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${content}-${identity.privateKey}`
  );

  return {
    id: messageId.slice(0, 16),
    fromId: identity.id,
    toId,
    content,
    encrypted: true,
    timestamp: Date.now(),
    ttl: MESH_CONFIG.MESSAGE_TTL,
    signature: signature.slice(0, 16),
    type,
  };
}

// Encrypt message for peer (simplified - use proper encryption in production)
export async function encryptForPeer(
  message: string,
  peerPublicKey: string
): Promise<string> {
  // In production, use proper ECDH key exchange + AES-GCM
  const encoded = btoa(message);
  return encoded;
}

// Decrypt message (simplified)
export async function decryptMessage(
  encryptedContent: string,
  _senderPublicKey: string
): Promise<string> {
  try {
    return atob(encryptedContent);
  } catch {
    return encryptedContent;
  }
}

// Format relative time
export function formatLastSeen(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

// Check if Bluetooth is available
export function isBluetoothSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

// Get nearby peers from Bluetooth scanning
// Returns empty array when no real peers are detected
export function getMockNearbyPeers(): MeshPeer[] {
  // In production, this would return actual BLE scan results
  // For now, return empty array - no fake peers
  return [];
}

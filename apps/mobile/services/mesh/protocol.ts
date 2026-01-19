/**
 * Protocol 01 - Mesh Network Protocol
 *
 * Handles mesh message routing, encryption, and relay logic
 * Implements hop-based message forwarding with TTL
 */

import * as Crypto from 'expo-crypto';
import { Buffer } from 'buffer';

// Protocol version
export const MESH_PROTOCOL_VERSION = '1.0.0';

// Message types
export enum MeshMessageType {
  DISCOVERY = 0x01,      // Node discovery broadcast
  HANDSHAKE = 0x02,      // Key exchange handshake
  TEXT = 0x03,           // Encrypted text message
  PAYMENT_REQ = 0x04,    // Payment request
  PAYMENT_TX = 0x05,     // Signed transaction
  ACK = 0x06,            // Message acknowledgment
  RELAY = 0x07,          // Relayed message
  PING = 0x08,           // Keep-alive ping
  ZONE_ANNOUNCE = 0x09,  // Zone presence announcement
}

// Encryption algorithms
export const ENCRYPTION = {
  ALGORITHM: 'AES-256-GCM',
  KEY_SIZE: 32,
  IV_SIZE: 12,
  TAG_SIZE: 16,
};

// Protocol packet structure
export interface MeshPacket {
  version: number;
  type: MeshMessageType;
  senderId: string;
  recipientId: string;  // '*' for broadcast
  messageId: string;
  timestamp: number;
  ttl: number;
  hopCount: number;
  relayPath: string[];  // List of node IDs that relayed this message
  payload: string;      // Encrypted payload
  signature: string;    // Digital signature
}

// Discovery payload
export interface DiscoveryPayload {
  nodeId: string;
  alias: string;
  publicKey: string;
  zone: string;
  capabilities: string[];
  timestamp: number;
}

// Payment request payload
export interface PaymentRequestPayload {
  requestId: string;
  amount: number;
  currency: string;
  recipientAddress: string;
  memo?: string;
  expiresAt: number;
}

// Signed transaction payload
export interface SignedTransactionPayload {
  requestId: string;
  serializedTx: string;  // Base64 encoded signed transaction
  senderAddress: string;
  recipientAddress: string;
  amount: number;
  currency: string;
  signature: string;
}

// Generate message ID
export async function generateMessageId(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(8);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Create discovery packet
export async function createDiscoveryPacket(
  identity: { id: string; alias: string; publicKey: string },
  zone: string
): Promise<MeshPacket> {
  const messageId = await generateMessageId();

  const payload: DiscoveryPayload = {
    nodeId: identity.id,
    alias: identity.alias,
    publicKey: identity.publicKey,
    zone,
    capabilities: ['text', 'payment', 'relay'],
    timestamp: Date.now(),
  };

  const signature = await signPayload(JSON.stringify(payload), identity.id);

  return {
    version: 1,
    type: MeshMessageType.DISCOVERY,
    senderId: identity.id,
    recipientId: '*',
    messageId,
    timestamp: Date.now(),
    ttl: 3,
    hopCount: 0,
    relayPath: [],
    payload: JSON.stringify(payload),
    signature,
  };
}

// Create text message packet
export async function createTextPacket(
  senderId: string,
  recipientId: string,
  content: string,
  recipientPublicKey: string
): Promise<MeshPacket> {
  const messageId = await generateMessageId();

  // Encrypt content (simplified - use proper AES-GCM in production)
  const encryptedContent = await encryptContent(content, recipientPublicKey);

  const signature = await signPayload(encryptedContent, senderId);

  return {
    version: 1,
    type: MeshMessageType.TEXT,
    senderId,
    recipientId,
    messageId,
    timestamp: Date.now(),
    ttl: 5,
    hopCount: 0,
    relayPath: [],
    payload: encryptedContent,
    signature,
  };
}

// Create payment request packet
export async function createPaymentRequestPacket(
  senderId: string,
  recipientId: string,
  amount: number,
  currency: string,
  recipientAddress: string,
  memo?: string
): Promise<MeshPacket> {
  const messageId = await generateMessageId();

  const payload: PaymentRequestPayload = {
    requestId: messageId,
    amount,
    currency,
    recipientAddress,
    memo,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };

  const signature = await signPayload(JSON.stringify(payload), senderId);

  return {
    version: 1,
    type: MeshMessageType.PAYMENT_REQ,
    senderId,
    recipientId,
    messageId,
    timestamp: Date.now(),
    ttl: 3,
    hopCount: 0,
    relayPath: [],
    payload: JSON.stringify(payload),
    signature,
  };
}

// Create relay packet (wrap existing packet for forwarding)
export function createRelayPacket(
  originalPacket: MeshPacket,
  relayNodeId: string
): MeshPacket {
  return {
    ...originalPacket,
    hopCount: originalPacket.hopCount + 1,
    ttl: originalPacket.ttl - 1,
    relayPath: [...originalPacket.relayPath, relayNodeId],
  };
}

// Check if packet should be relayed
export function shouldRelay(packet: MeshPacket, myNodeId: string): boolean {
  // Don't relay if TTL exhausted
  if (packet.ttl <= 0) return false;

  // Don't relay own messages
  if (packet.senderId === myNodeId) return false;

  // Don't relay if we already relayed
  if (packet.relayPath.includes(myNodeId)) return false;

  // Don't relay messages addressed to us
  if (packet.recipientId === myNodeId) return false;

  return true;
}

// Check if packet is for us
export function isForMe(packet: MeshPacket, myNodeId: string): boolean {
  return packet.recipientId === myNodeId || packet.recipientId === '*';
}

// Encrypt content (simplified - production should use proper ECDH + AES-GCM)
async function encryptContent(content: string, recipientPublicKey: string): Promise<string> {
  // In production:
  // 1. Generate ephemeral key pair
  // 2. ECDH with recipient's public key
  // 3. Derive AES key with HKDF
  // 4. Encrypt with AES-256-GCM
  // 5. Return: ephemeral public key + IV + ciphertext + tag

  // Simplified for demo: base64 encode with a hash
  const combined = content + recipientPublicKey.slice(0, 8);
  const encoded = Buffer.from(combined).toString('base64');
  return encoded;
}

// Decrypt content (simplified)
export async function decryptContent(
  encryptedContent: string,
  senderPublicKey: string,
  myPrivateKey: string
): Promise<string> {
  try {
    const decoded = Buffer.from(encryptedContent, 'base64').toString('utf8');
    // Remove the appended key portion
    return decoded.slice(0, -8);
  } catch {
    return encryptedContent;
  }
}

// Sign payload
async function signPayload(payload: string, senderId: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    payload + senderId + Date.now()
  );
  return hash.slice(0, 32);
}

// Verify signature (simplified)
export async function verifySignature(
  packet: MeshPacket,
  senderPublicKey: string
): Promise<boolean> {
  // In production, verify with sender's public key
  return packet.signature.length === 32;
}

// Serialize packet for transmission
export function serializePacket(packet: MeshPacket): string {
  return JSON.stringify(packet);
}

// Deserialize packet from transmission
export function deserializePacket(data: string): MeshPacket | null {
  try {
    const packet = JSON.parse(data) as MeshPacket;
    // Validate required fields
    if (!packet.senderId || !packet.messageId || packet.type === undefined) {
      return null;
    }
    return packet;
  } catch {
    return null;
  }
}

// Calculate message priority for relay queue
export function calculatePriority(packet: MeshPacket): number {
  let priority = 0;

  // Payment transactions have highest priority
  if (packet.type === MeshMessageType.PAYMENT_TX) priority += 100;
  else if (packet.type === MeshMessageType.PAYMENT_REQ) priority += 80;
  else if (packet.type === MeshMessageType.TEXT) priority += 50;

  // Fresher messages have higher priority
  const age = Date.now() - packet.timestamp;
  if (age < 60000) priority += 20; // < 1 minute
  else if (age < 300000) priority += 10; // < 5 minutes

  // Lower hop count = higher priority
  priority += Math.max(0, 10 - packet.hopCount);

  return priority;
}

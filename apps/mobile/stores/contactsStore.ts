/**
 * Protocol 01 - Contacts Store
 *
 * Manages Solana address-based encrypted contacts and messaging
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
  getOrCreateKeys,
  encryptMessage,
  decryptMessage,
  signMessage,
  EncryptedMessage,
  EncryptionKeyPair,
} from '../services/crypto/encryption';

// Storage keys
const CONTACTS_KEY = '@p01_contacts';
const MESSAGES_KEY = '@p01_messages';
const PAYMENT_REQUESTS_KEY = '@p01_payment_requests';

// Supported currencies
export const SUPPORTED_CURRENCIES = [
  { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', decimals: 9, icon: '◎' },
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, icon: '$' },
  { symbol: 'USDT', name: 'Tether', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, icon: '$' },
  { symbol: 'BONK', name: 'Bonk', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5, icon: '🐕' },
  { symbol: 'JUP', name: 'Jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6, icon: '♃' },
  { symbol: 'WIF', name: 'dogwifhat', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6, icon: '🎩' },
  { symbol: 'PYTH', name: 'Pyth', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6, icon: 'Ψ' },
  { symbol: 'RAY', name: 'Raydium', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6, icon: '☀' },
  { symbol: 'ORCA', name: 'Orca', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', decimals: 6, icon: '🐋' },
  // Wrapped tokens (bridged)
  { symbol: 'wBTC', name: 'Wrapped Bitcoin', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8, icon: '₿' },
  { symbol: 'wETH', name: 'Wrapped Ether', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', decimals: 8, icon: 'Ξ' },
] as const;

export type CurrencySymbol = typeof SUPPORTED_CURRENCIES[number]['symbol'];

// Contact source types
export type ContactSource = 'p01_qr' | 'p01_mesh' | 'manual' | 'solana_address';

// Types
export interface Contact {
  id: string;
  address: string;
  alias: string;
  publicKey: string;
  avatar?: string;
  addedAt: number;
  lastMessageAt?: number;
  isFavorite: boolean;
  isBlocked: boolean;
  notes?: string;
  // P01-specific fields
  isP01User: boolean;        // True if this contact uses the P-01 app
  contactSource: ContactSource;   // How this contact was added
  p01PublicKey?: string;      // P-01 encryption public key (for messaging)
  canMessage: boolean;            // Can send messages (only P-01 users)
  canSendCrypto: boolean;         // Can send crypto (all Solana addresses)
}

export interface Message {
  id: string;
  contactId: string;
  content: string;
  encrypted: EncryptedMessage | null;
  type: 'text' | 'payment_request' | 'payment_sent' | 'payment_received' | 'system';
  timestamp: number;
  isOutgoing: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  paymentData?: PaymentData;
}

export interface PaymentData {
  amount: number;
  currency: CurrencySymbol;
  memo?: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  txSignature?: string;
  expiresAt?: number;
}

export interface PaymentRequest {
  id: string;
  fromAddress: string;
  toAddress: string;
  amount: number;
  currency: CurrencySymbol;
  memo: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  createdAt: number;
  expiresAt: number;
  txSignature?: string;
}

export interface Conversation {
  contactId: string;
  contact: Contact;
  lastMessage: Message | null;
  unreadCount: number;
}

interface ContactsState {
  // Keys
  encryptionKeys: EncryptionKeyPair | null;

  // Contacts
  contacts: Contact[];
  blockedContacts: Contact[];

  // Messages
  messages: Record<string, Message[]>;
  conversations: Conversation[];

  // Payment requests
  paymentRequests: PaymentRequest[];
  pendingPayments: PaymentRequest[];

  // UI state
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  addContact: (
    address: string,
    alias: string,
    options?: {
      publicKey?: string;
      isP01User?: boolean;
      contactSource?: ContactSource;
      p01PublicKey?: string;
    }
  ) => Promise<Contact>;
  removeContact: (contactId: string) => Promise<void>;
  updateContact: (contactId: string, updates: Partial<Contact>) => Promise<void>;
  blockContact: (contactId: string) => Promise<void>;
  unblockContact: (contactId: string) => Promise<void>;
  sendMessage: (contactId: string, content: string) => Promise<void>;
  loadMessages: (contactId: string) => Promise<void>;
  markAsRead: (contactId: string) => void;
  createPaymentRequest: (
    toAddress: string,
    amount: number,
    currency: CurrencySymbol,
    memo?: string
  ) => Promise<PaymentRequest>;
  respondToPaymentRequest: (requestId: string, action: 'pay' | 'cancel') => Promise<void>;
  getConversations: () => Conversation[];
  clearError: () => void;
}

// Helper to generate unique ID
async function generateId(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(8);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Format address for display
export function formatAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export const useContactsStore = create<ContactsState>((set, get) => ({
  // Initial state
  encryptionKeys: null,
  contacts: [],
  blockedContacts: [],
  messages: {},
  conversations: [],
  paymentRequests: [],
  pendingPayments: [],
  isInitialized: false,
  isLoading: false,
  error: null,

  // Initialize
  initialize: async () => {
    try {
      set({ isLoading: true });

      // Get encryption keys
      const encryptionKeys = await getOrCreateKeys();

      // Load contacts
      const contactsData = await AsyncStorage.getItem(CONTACTS_KEY);
      const allContacts: Contact[] = contactsData ? JSON.parse(contactsData) : [];
      const contacts = allContacts.filter(c => !c.isBlocked);
      const blockedContacts = allContacts.filter(c => c.isBlocked);

      // Load payment requests
      const requestsData = await AsyncStorage.getItem(PAYMENT_REQUESTS_KEY);
      const paymentRequests: PaymentRequest[] = requestsData ? JSON.parse(requestsData) : [];
      const pendingPayments = paymentRequests.filter(r => r.status === 'pending');

      // Build conversations
      const conversations: Conversation[] = [];
      for (const contact of contacts) {
        const messagesData = await AsyncStorage.getItem(`${MESSAGES_KEY}_${contact.id}`);
        const contactMessages: Message[] = messagesData ? JSON.parse(messagesData) : [];
        const unreadCount = contactMessages.filter(m => !m.isOutgoing && m.status !== 'read').length;

        conversations.push({
          contactId: contact.id,
          contact,
          lastMessage: contactMessages[contactMessages.length - 1] || null,
          unreadCount,
        });
      }

      // Sort by last message
      conversations.sort((a, b) => {
        const aTime = a.lastMessage?.timestamp || a.contact.addedAt;
        const bTime = b.lastMessage?.timestamp || b.contact.addedAt;
        return bTime - aTime;
      });

      set({
        encryptionKeys,
        contacts,
        blockedContacts,
        conversations,
        paymentRequests,
        pendingPayments,
        isInitialized: true,
        isLoading: false,
      });
    } catch (error: any) {
      set({ error: error.message, isLoading: false, isInitialized: true });
    }
  },

  // Add contact
  addContact: async (address: string, alias: string, options?: {
    publicKey?: string;
    isP01User?: boolean;
    contactSource?: ContactSource;
    p01PublicKey?: string;
  }) => {
    try {
      const { contacts, encryptionKeys } = get();

      // Check if already exists
      if (contacts.some(c => c.address === address)) {
        throw new Error('Contact already exists');
      }

      const id = await generateId();

      // Determine if this is a P-01 user
      const isP01User = options?.isP01User ?? false;
      const contactSource = options?.contactSource ?? 'manual';

      // If no public key provided, derive from address (simplified)
      const derivedPublicKey = options?.publicKey || await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        address + 'public'
      );

      const contact: Contact = {
        id,
        address,
        alias: alias || formatAddress(address),
        publicKey: derivedPublicKey.slice(0, 64),
        addedAt: Date.now(),
        isFavorite: false,
        isBlocked: false,
        // P01-specific fields
        isP01User,
        contactSource,
        p01PublicKey: options?.p01PublicKey,
        canMessage: isP01User, // Only P-01 users can receive messages
        canSendCrypto: true, // All Solana addresses can receive crypto
      };

      const updatedContacts = [...contacts, contact];

      // Save
      const allContacts = [...updatedContacts, ...get().blockedContacts];
      await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(allContacts));

      // Update conversations (only for P-01 users who can message)
      const conversations = [...get().conversations];
      if (isP01User) {
        conversations.push({
          contactId: contact.id,
          contact,
          lastMessage: null,
          unreadCount: 0,
        });
      }

      set({ contacts: updatedContacts, conversations });
      return contact;
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Remove contact
  removeContact: async (contactId: string) => {
    try {
      const { contacts, blockedContacts, conversations } = get();

      const updatedContacts = contacts.filter(c => c.id !== contactId);
      const updatedConversations = conversations.filter(c => c.contactId !== contactId);

      const allContacts = [...updatedContacts, ...blockedContacts];
      await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(allContacts));

      // Remove messages
      await AsyncStorage.removeItem(`${MESSAGES_KEY}_${contactId}`);

      set({
        contacts: updatedContacts,
        conversations: updatedConversations,
      });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Update contact
  updateContact: async (contactId: string, updates: Partial<Contact>) => {
    try {
      const { contacts, blockedContacts, conversations } = get();

      const updatedContacts = contacts.map(c =>
        c.id === contactId ? { ...c, ...updates } : c
      );

      const allContacts = [...updatedContacts, ...blockedContacts];
      await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(allContacts));

      const updatedConversations = conversations.map(conv =>
        conv.contactId === contactId
          ? { ...conv, contact: { ...conv.contact, ...updates } }
          : conv
      );

      set({ contacts: updatedContacts, conversations: updatedConversations });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Block contact
  blockContact: async (contactId: string) => {
    try {
      const { contacts, blockedContacts, conversations } = get();

      const contact = contacts.find(c => c.id === contactId);
      if (!contact) return;

      const blockedContact = { ...contact, isBlocked: true };
      const updatedContacts = contacts.filter(c => c.id !== contactId);
      const updatedBlocked = [...blockedContacts, blockedContact];

      const allContacts = [...updatedContacts, ...updatedBlocked];
      await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(allContacts));

      const updatedConversations = conversations.filter(c => c.contactId !== contactId);

      set({
        contacts: updatedContacts,
        blockedContacts: updatedBlocked,
        conversations: updatedConversations,
      });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Unblock contact
  unblockContact: async (contactId: string) => {
    try {
      const { contacts, blockedContacts } = get();

      const contact = blockedContacts.find(c => c.id === contactId);
      if (!contact) return;

      const unblockedContact = { ...contact, isBlocked: false };
      const updatedBlocked = blockedContacts.filter(c => c.id !== contactId);
      const updatedContacts = [...contacts, unblockedContact];

      const allContacts = [...updatedContacts, ...updatedBlocked];
      await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(allContacts));

      set({
        contacts: updatedContacts,
        blockedContacts: updatedBlocked,
      });

      // Rebuild conversations
      await get().initialize();
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Send message
  sendMessage: async (contactId: string, content: string) => {
    try {
      const { contacts, messages, encryptionKeys } = get();

      const contact = contacts.find(c => c.id === contactId);
      if (!contact) throw new Error('Contact not found');

      // Check if contact is a P-01 user
      if (!contact.isP01User || !contact.canMessage) {
        throw new Error('Cannot send messages to non-P-01 users. This contact can only receive crypto.');
      }

      const id = await generateId();

      // Encrypt message
      const encrypted = await encryptMessage(content, contact.publicKey, contactId);

      const message: Message = {
        id,
        contactId,
        content,
        encrypted,
        type: 'text',
        timestamp: Date.now(),
        isOutgoing: true,
        status: 'sent',
      };

      // Update messages
      const contactMessages = [...(messages[contactId] || []), message];
      const updatedMessages = { ...messages, [contactId]: contactMessages };

      // Save
      await AsyncStorage.setItem(
        `${MESSAGES_KEY}_${contactId}`,
        JSON.stringify(contactMessages)
      );

      // Update contact last message time
      await get().updateContact(contactId, { lastMessageAt: Date.now() });

      // Update conversations
      const conversations = get().conversations.map(conv =>
        conv.contactId === contactId
          ? { ...conv, lastMessage: message }
          : conv
      );

      set({ messages: updatedMessages, conversations });
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Load messages
  loadMessages: async (contactId: string) => {
    try {
      const stored = await AsyncStorage.getItem(`${MESSAGES_KEY}_${contactId}`);
      const contactMessages: Message[] = stored ? JSON.parse(stored) : [];

      set(state => ({
        messages: {
          ...state.messages,
          [contactId]: contactMessages,
        },
      }));
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Mark as read
  markAsRead: (contactId: string) => {
    const { messages, conversations } = get();
    const contactMessages = messages[contactId] || [];

    const updatedMessages = contactMessages.map(m =>
      !m.isOutgoing ? { ...m, status: 'read' as const } : m
    );

    const updatedConversations = conversations.map(conv =>
      conv.contactId === contactId ? { ...conv, unreadCount: 0 } : conv
    );

    set({
      messages: { ...messages, [contactId]: updatedMessages },
      conversations: updatedConversations,
    });

    AsyncStorage.setItem(
      `${MESSAGES_KEY}_${contactId}`,
      JSON.stringify(updatedMessages)
    );
  },

  // Create payment request
  createPaymentRequest: async (
    toAddress: string,
    amount: number,
    currency: CurrencySymbol,
    memo?: string
  ) => {
    try {
      const { paymentRequests, contacts, encryptionKeys } = get();

      const id = await generateId();

      // Find or create contact
      let contact = contacts.find(c => c.address === toAddress);
      if (!contact) {
        contact = await get().addContact(toAddress, formatAddress(toAddress));
      }

      const request: PaymentRequest = {
        id,
        fromAddress: encryptionKeys?.publicKey || '',
        toAddress,
        amount,
        currency,
        memo: memo || '',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      };

      const updatedRequests = [...paymentRequests, request];
      await AsyncStorage.setItem(PAYMENT_REQUESTS_KEY, JSON.stringify(updatedRequests));

      // Send as message
      const messageContent = JSON.stringify({
        type: 'payment_request',
        amount,
        currency,
        memo,
        requestId: id,
      });

      const messageId = await generateId();
      const message: Message = {
        id: messageId,
        contactId: contact.id,
        content: `Payment request: ${amount} ${currency}${memo ? ` - ${memo}` : ''}`,
        encrypted: null,
        type: 'payment_request',
        timestamp: Date.now(),
        isOutgoing: true,
        status: 'sent',
        paymentData: {
          amount,
          currency,
          memo,
          status: 'pending',
          expiresAt: request.expiresAt,
        },
      };

      const contactMessages = [...(get().messages[contact.id] || []), message];
      await AsyncStorage.setItem(
        `${MESSAGES_KEY}_${contact.id}`,
        JSON.stringify(contactMessages)
      );

      set({
        paymentRequests: updatedRequests,
        pendingPayments: updatedRequests.filter(r => r.status === 'pending'),
        messages: { ...get().messages, [contact.id]: contactMessages },
      });

      return request;
    } catch (error: any) {
      set({ error: error.message });
      throw error;
    }
  },

  // Respond to payment request
  respondToPaymentRequest: async (requestId: string, action: 'pay' | 'cancel') => {
    try {
      const { paymentRequests } = get();

      const updatedRequests = paymentRequests.map(r =>
        r.id === requestId
          ? { ...r, status: action === 'pay' ? 'completed' : 'cancelled' as const }
          : r
      );

      await AsyncStorage.setItem(PAYMENT_REQUESTS_KEY, JSON.stringify(updatedRequests));

      set({
        paymentRequests: updatedRequests,
        pendingPayments: updatedRequests.filter(r => r.status === 'pending'),
      });

      // If paying, initiate transaction (would integrate with wallet)
      if (action === 'pay') {
        // TODO: Integrate with wallet store to send actual payment
        console.log('Initiating payment for request:', requestId);
      }
    } catch (error: any) {
      set({ error: error.message });
    }
  },

  // Get conversations
  getConversations: () => get().conversations,

  // Clear error
  clearError: () => set({ error: null }),
}));

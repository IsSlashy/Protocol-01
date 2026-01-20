/**
 * Message Store for P-01 Wallet E2E Encrypted Messaging
 *
 * Handles:
 * - Conversations and messages storage
 * - Message encryption/decryption
 * - Persistence to chrome.storage (encrypted at rest)
 * - Read/unread status tracking
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import {
  EncryptedMessage,
  encryptMessage,
  decryptMessage,
  deriveConversationId,
  generateMessageId,
  deriveEncryptionKeys,
  deriveStorageKey,
  uint8ArrayToBase64,
} from '../services/encryption';

// ============ Types ============

export type MessageType = 'text' | 'payment_request' | 'payment_sent';
export type PaymentStatus = 'pending' | 'completed' | 'declined';

export interface PaymentData {
  /** Amount in smallest units (lamports for SOL) */
  amount: number;
  /** Token mint address or 'SOL' for native */
  token: string;
  /** Token symbol for display */
  tokenSymbol: string;
  /** Payment status */
  status: PaymentStatus;
  /** Transaction signature once completed */
  txSignature?: string;
  /** Optional memo/note */
  memo?: string;
}

export interface Message {
  /** Unique message ID */
  id: string;
  /** Conversation this message belongs to */
  conversationId: string;
  /** Sender's wallet address */
  sender: string;
  /** Recipient's wallet address */
  recipient: string;
  /** Message type */
  type: MessageType;
  /** Encrypted content (stored encrypted) */
  encryptedContent: EncryptedMessage;
  /** Decrypted content (only in memory, never persisted) */
  decryptedContent?: string;
  /** Timestamp of message creation */
  timestamp: number;
  /** Whether the message has been read */
  read: boolean;
  /** Payment data for payment-type messages */
  paymentData?: PaymentData;
  /** Message delivery status */
  status: 'sending' | 'sent' | 'delivered' | 'failed';
}

export interface Conversation {
  /** Unique conversation ID (derived from participants) */
  id: string;
  /** Participant wallet addresses (always 2 for DM) */
  participants: string[];
  /** Last message in conversation (for preview) */
  lastMessage?: {
    content: string;
    timestamp: number;
    sender: string;
    type: MessageType;
  };
  /** Number of unread messages */
  unreadCount: number;
  /** Conversation creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  updatedAt: number;
  /** Contact's encryption public key (base64) */
  contactEncryptionKey?: string;
  /** Whether the conversation is muted */
  muted: boolean;
  /** Whether the conversation is archived */
  archived: boolean;
}

interface MessageStoreState {
  // Data
  conversations: Record<string, Conversation>;
  messages: Record<string, Message[]>; // conversationId -> messages[]

  // Encryption state (in-memory only)
  encryptionKeys: {
    publicKey: Uint8Array | null;
    secretKey: Uint8Array | null;
  };
  storageKey: Uint8Array | null;
  isInitialized: boolean;
  isLoading: boolean;

  // Actions
  initializeEncryption: (ed25519SecretKey: Uint8Array) => Promise<void>;
  getEncryptionPublicKey: () => string | null;

  // Conversation actions
  getOrCreateConversation: (
    myWalletAddress: string,
    contactWalletAddress: string,
    contactEncryptionKey?: string
  ) => Conversation;
  getConversation: (conversationId: string) => Conversation | undefined;
  getConversations: () => Conversation[];
  updateContactEncryptionKey: (
    conversationId: string,
    encryptionKey: string
  ) => void;
  muteConversation: (conversationId: string, muted: boolean) => void;
  archiveConversation: (conversationId: string, archived: boolean) => void;
  deleteConversation: (conversationId: string) => void;

  // Message actions
  sendMessage: (
    conversationId: string,
    content: string,
    myWalletAddress: string,
    recipientWalletAddress: string,
    type?: MessageType,
    paymentData?: PaymentData
  ) => Promise<Message>;
  receiveMessage: (
    encryptedMessage: EncryptedMessage,
    senderWalletAddress: string,
    senderEncryptionKey: string,
    myWalletAddress: string,
    type?: MessageType,
    paymentData?: PaymentData
  ) => Promise<Message>;
  getMessages: (conversationId: string) => Message[];
  decryptMessages: (conversationId: string) => Promise<void>;
  markAsRead: (conversationId: string, messageIds?: string[]) => void;
  markConversationAsRead: (conversationId: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  updatePaymentStatus: (
    conversationId: string,
    messageId: string,
    status: PaymentStatus,
    txSignature?: string
  ) => void;

  // Utility
  getTotalUnreadCount: () => number;
  clearAllData: () => void;
  reset: () => void;
}

// Initial state
const initialState = {
  conversations: {} as Record<string, Conversation>,
  messages: {} as Record<string, Message[]>,
  encryptionKeys: {
    publicKey: null as Uint8Array | null,
    secretKey: null as Uint8Array | null,
  },
  storageKey: null as Uint8Array | null,
  isInitialized: false,
  isLoading: false,
};

export const useMessageStore = create<MessageStoreState>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Initialize encryption with wallet's secret key
      initializeEncryption: async (ed25519SecretKey: Uint8Array) => {
        set({ isLoading: true });

        try {
          // Derive encryption keypair from wallet
          const encryptionKeys = await deriveEncryptionKeys(ed25519SecretKey);

          // Derive storage key for at-rest encryption
          const storageKey = deriveStorageKey(ed25519SecretKey);

          set({
            encryptionKeys: {
              publicKey: encryptionKeys.publicKey,
              secretKey: encryptionKeys.secretKey,
            },
            storageKey,
            isInitialized: true,
            isLoading: false,
          });
        } catch (error) {
          console.error('Failed to initialize encryption:', error);
          set({ isLoading: false });
          throw error;
        }
      },

      // Get our encryption public key as base64
      getEncryptionPublicKey: () => {
        const { encryptionKeys } = get();
        if (!encryptionKeys.publicKey) return null;
        return uint8ArrayToBase64(encryptionKeys.publicKey);
      },

      // Get or create a conversation with a contact
      getOrCreateConversation: (
        myWalletAddress: string,
        contactWalletAddress: string,
        contactEncryptionKey?: string
      ) => {
        const conversationId = deriveConversationId(
          myWalletAddress,
          contactWalletAddress
        );

        const existing = get().conversations[conversationId];
        if (existing) {
          // Update encryption key if provided
          if (contactEncryptionKey && !existing.contactEncryptionKey) {
            set((state) => ({
              conversations: {
                ...state.conversations,
                [conversationId]: {
                  ...existing,
                  contactEncryptionKey,
                },
              },
            }));
            return { ...existing, contactEncryptionKey };
          }
          return existing;
        }

        // Create new conversation
        const now = Date.now();
        const conversation: Conversation = {
          id: conversationId,
          participants: [myWalletAddress, contactWalletAddress].sort(),
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
          contactEncryptionKey,
          muted: false,
          archived: false,
        };

        set((state) => ({
          conversations: {
            ...state.conversations,
            [conversationId]: conversation,
          },
          messages: {
            ...state.messages,
            [conversationId]: [],
          },
        }));

        return conversation;
      },

      getConversation: (conversationId: string) => {
        return get().conversations[conversationId];
      },

      getConversations: () => {
        return Object.values(get().conversations)
          .filter((c) => !c.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      },

      updateContactEncryptionKey: (
        conversationId: string,
        encryptionKey: string
      ) => {
        set((state) => {
          const conversation = state.conversations[conversationId];
          if (!conversation) return state;

          return {
            conversations: {
              ...state.conversations,
              [conversationId]: {
                ...conversation,
                contactEncryptionKey: encryptionKey,
              },
            },
          };
        });
      },

      muteConversation: (conversationId: string, muted: boolean) => {
        set((state) => {
          const conversation = state.conversations[conversationId];
          if (!conversation) return state;

          return {
            conversations: {
              ...state.conversations,
              [conversationId]: { ...conversation, muted },
            },
          };
        });
      },

      archiveConversation: (conversationId: string, archived: boolean) => {
        set((state) => {
          const conversation = state.conversations[conversationId];
          if (!conversation) return state;

          return {
            conversations: {
              ...state.conversations,
              [conversationId]: { ...conversation, archived },
            },
          };
        });
      },

      deleteConversation: (conversationId: string) => {
        set((state) => {
          const { [conversationId]: _conv, ...restConversations } =
            state.conversations;
          const { [conversationId]: _msgs, ...restMessages } = state.messages;

          return {
            conversations: restConversations,
            messages: restMessages,
          };
        });
      },

      // Send a message
      sendMessage: async (
        conversationId: string,
        content: string,
        myWalletAddress: string,
        recipientWalletAddress: string,
        type: MessageType = 'text',
        paymentData?: PaymentData
      ) => {
        const { encryptionKeys, conversations } = get();

        if (!encryptionKeys.secretKey || !encryptionKeys.publicKey) {
          throw new Error('Encryption not initialized');
        }

        const conversation = conversations[conversationId];
        if (!conversation?.contactEncryptionKey) {
          throw new Error('Contact encryption key not available');
        }

        // Encrypt the message
        const encryptedMessage = await encryptMessage(
          content,
          conversation.contactEncryptionKey,
          encryptionKeys.secretKey,
          encryptionKeys.publicKey
        );

        const messageId = generateMessageId();
        const now = Date.now();

        const message: Message = {
          id: messageId,
          conversationId,
          sender: myWalletAddress,
          recipient: recipientWalletAddress,
          type,
          encryptedContent: encryptedMessage,
          decryptedContent: content, // We know the content since we sent it
          timestamp: now,
          read: true, // Our own messages are always read
          paymentData,
          status: 'sent',
        };

        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: [...(state.messages[conversationId] || []), message],
          },
          conversations: {
            ...state.conversations,
            [conversationId]: {
              ...state.conversations[conversationId],
              lastMessage: {
                content,
                timestamp: now,
                sender: myWalletAddress,
                type,
              },
              updatedAt: now,
            },
          },
        }));

        return message;
      },

      // Receive and decrypt a message
      receiveMessage: async (
        encryptedMessage: EncryptedMessage,
        senderWalletAddress: string,
        senderEncryptionKey: string,
        myWalletAddress: string,
        type: MessageType = 'text',
        paymentData?: PaymentData
      ) => {
        const { encryptionKeys } = get();

        if (!encryptionKeys.secretKey) {
          throw new Error('Encryption not initialized');
        }

        // Decrypt the message
        const decryptedContent = await decryptMessage(
          encryptedMessage,
          senderEncryptionKey,
          encryptionKeys.secretKey
        );

        // Get or create conversation
        const conversationId = deriveConversationId(
          myWalletAddress,
          senderWalletAddress
        );

        get().getOrCreateConversation(
          myWalletAddress,
          senderWalletAddress,
          senderEncryptionKey
        );

        const messageId = generateMessageId();
        const now = encryptedMessage.timestamp || Date.now();

        const message: Message = {
          id: messageId,
          conversationId,
          sender: senderWalletAddress,
          recipient: myWalletAddress,
          type,
          encryptedContent: encryptedMessage,
          decryptedContent,
          timestamp: now,
          read: false,
          paymentData,
          status: 'delivered',
        };

        set((state) => {
          const conversation = state.conversations[conversationId];

          return {
            messages: {
              ...state.messages,
              [conversationId]: [...(state.messages[conversationId] || []), message],
            },
            conversations: {
              ...state.conversations,
              [conversationId]: {
                ...conversation,
                lastMessage: {
                  content: decryptedContent,
                  timestamp: now,
                  sender: senderWalletAddress,
                  type,
                },
                unreadCount: conversation.unreadCount + 1,
                updatedAt: now,
              },
            },
          };
        });

        return message;
      },

      getMessages: (conversationId: string) => {
        return get().messages[conversationId] || [];
      },

      // Decrypt all messages in a conversation (called when opening a chat)
      decryptMessages: async (conversationId: string) => {
        const { messages, encryptionKeys, conversations } = get();
        const conversationMessages = messages[conversationId] || [];
        const conversation = conversations[conversationId];

        if (!encryptionKeys.secretKey || !conversation?.contactEncryptionKey) {
          return;
        }

        const decryptedMessages = await Promise.all(
          conversationMessages.map(async (msg) => {
            if (msg.decryptedContent) return msg;

            try {
              // Determine whose encryption key to use based on who sent the message
              const senderEncryptionKey =
                msg.sender === conversation.participants[0]
                  ? conversation.contactEncryptionKey
                  : uint8ArrayToBase64(encryptionKeys.publicKey!);

              const decryptedContent = await decryptMessage(
                msg.encryptedContent,
                senderEncryptionKey!,
                encryptionKeys.secretKey!
              );

              return { ...msg, decryptedContent };
            } catch (error) {
              console.error('Failed to decrypt message:', msg.id, error);
              return { ...msg, decryptedContent: '[Decryption failed]' };
            }
          })
        );

        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: decryptedMessages,
          },
        }));
      },

      markAsRead: (conversationId: string, messageIds?: string[]) => {
        set((state) => {
          const conversationMessages = state.messages[conversationId] || [];

          const updatedMessages = conversationMessages.map((msg) => {
            if (messageIds && !messageIds.includes(msg.id)) return msg;
            if (msg.read) return msg;
            return { ...msg, read: true };
          });

          const unreadCount = updatedMessages.filter((m) => !m.read).length;

          return {
            messages: {
              ...state.messages,
              [conversationId]: updatedMessages,
            },
            conversations: {
              ...state.conversations,
              [conversationId]: {
                ...state.conversations[conversationId],
                unreadCount,
              },
            },
          };
        });
      },

      markConversationAsRead: (conversationId: string) => {
        get().markAsRead(conversationId);
      },

      deleteMessage: (conversationId: string, messageId: string) => {
        set((state) => {
          const conversationMessages = state.messages[conversationId] || [];
          const updatedMessages = conversationMessages.filter(
            (m) => m.id !== messageId
          );

          // Update last message if needed
          const lastMessage = updatedMessages[updatedMessages.length - 1];

          return {
            messages: {
              ...state.messages,
              [conversationId]: updatedMessages,
            },
            conversations: {
              ...state.conversations,
              [conversationId]: {
                ...state.conversations[conversationId],
                lastMessage: lastMessage
                  ? {
                      content: lastMessage.decryptedContent || '[Encrypted]',
                      timestamp: lastMessage.timestamp,
                      sender: lastMessage.sender,
                      type: lastMessage.type,
                    }
                  : undefined,
              },
            },
          };
        });
      },

      updatePaymentStatus: (
        conversationId: string,
        messageId: string,
        status: PaymentStatus,
        txSignature?: string
      ) => {
        set((state) => {
          const conversationMessages = state.messages[conversationId] || [];
          const updatedMessages = conversationMessages.map((msg) => {
            if (msg.id !== messageId || !msg.paymentData) return msg;
            return {
              ...msg,
              paymentData: {
                ...msg.paymentData,
                status,
                txSignature,
              },
            };
          });

          return {
            messages: {
              ...state.messages,
              [conversationId]: updatedMessages,
            },
          };
        });
      },

      getTotalUnreadCount: () => {
        return Object.values(get().conversations).reduce(
          (total, conv) => total + (conv.muted ? 0 : conv.unreadCount),
          0
        );
      },

      clearAllData: () => {
        set({
          conversations: {},
          messages: {},
        });
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'p01-messages',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => ({
        // Only persist conversations and encrypted messages
        // Encryption keys and decrypted content are never persisted
        conversations: state.conversations,
        messages: Object.fromEntries(
          Object.entries(state.messages).map(([convId, msgs]) => [
            convId,
            msgs.map((msg) => ({
              ...msg,
              // Never persist decrypted content
              decryptedContent: undefined,
            })),
          ])
        ),
      }),
    }
  )
);

// Selector hooks for common queries
export const useConversations = () => useMessageStore((state) => state.getConversations());
export const useConversation = (id: string) =>
  useMessageStore((state) => state.conversations[id]);
export const useMessages = (conversationId: string) =>
  useMessageStore((state) => state.messages[conversationId] || []);
export const useTotalUnreadCount = () =>
  useMessageStore((state) => state.getTotalUnreadCount());

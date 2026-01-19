/**
 * useMessages - E2E Encrypted Messaging Hook
 * @module hooks/social/useMessages
 *
 * Provides a high-level interface for encrypted messaging functionality.
 * Integrates with the message store and encryption services.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useMessageStore, Message, MessageType, PaymentData, Conversation } from '@/stores/messageStore';
import { useWalletStore } from '@/stores/walletStore';
import { useContacts, Contact } from './useContacts';
import {
  deriveConversationId,
  EncryptedMessage,
} from '@/services/crypto/messaging';

export interface UseMessagesOptions {
  /** Contact address to load messages for */
  contactAddress?: string;
  /** Auto-decrypt messages when loading */
  autoDecrypt?: boolean;
}

export interface UseMessagesReturn {
  // State
  messages: Message[];
  conversation: Conversation | null;
  isLoading: boolean;
  isSending: boolean;
  error: string | null;
  isEncryptionReady: boolean;
  myEncryptionPublicKey: string | null;

  // Actions
  sendTextMessage: (content: string) => Promise<Message | null>;
  sendPaymentRequest: (amount: number, token: string, tokenSymbol: string, memo?: string) => Promise<Message | null>;
  sendPaymentSent: (amount: number, token: string, tokenSymbol: string, txSignature: string, memo?: string) => Promise<Message | null>;
  markAsRead: () => void;
  deleteMessage: (messageId: string) => void;
  refreshMessages: () => Promise<void>;

  // Encryption
  initializeEncryption: () => Promise<boolean>;
  setContactEncryptionKey: (encryptionKey: string) => void;
}

export function useMessages(options: UseMessagesOptions = {}): UseMessagesReturn {
  const { contactAddress, autoDecrypt = true } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get wallet state
  const publicKey = useWalletStore((state) => state.publicKey);

  // Get message store state and actions
  const {
    isInitialized,
    encryptionKeys,
    conversations,
    messages: allMessages,
    initializeEncryption,
    getEncryptionPublicKey,
    getOrCreateConversation,
    sendMessage,
    getMessages,
    decryptMessages,
    markAsRead: storeMarkAsRead,
    deleteMessage: storeDeleteMessage,
    updateContactEncryptionKey,
  } = useMessageStore();

  // Get contact info
  const { getContactByAddress } = useContacts();
  const contact = contactAddress ? getContactByAddress(contactAddress) : undefined;

  // Compute conversation ID
  const conversationId = useMemo(() => {
    if (!publicKey || !contactAddress) return null;
    return deriveConversationId(publicKey, contactAddress);
  }, [publicKey, contactAddress]);

  // Get current conversation
  const conversation = useMemo(() => {
    if (!conversationId) return null;
    return conversations[conversationId] || null;
  }, [conversationId, conversations]);

  // Get messages for the current conversation
  const messages = useMemo(() => {
    if (!conversationId) return [];
    return allMessages[conversationId] || [];
  }, [conversationId, allMessages]);

  // Check if encryption is ready
  const isEncryptionReady = useMemo(() => {
    return isInitialized && !!encryptionKeys.publicKey && !!encryptionKeys.secretKey;
  }, [isInitialized, encryptionKeys]);

  // Get our encryption public key
  const myEncryptionPublicKey = useMemo(() => {
    return getEncryptionPublicKey();
  }, [encryptionKeys.publicKey]);

  // Initialize encryption when wallet is available
  const initEncryption = useCallback(async (): Promise<boolean> => {
    if (isEncryptionReady) return true;

    try {
      // Get wallet secret key - this would come from secure storage
      // For now, we'll use a placeholder that the wallet store should provide
      const walletSecretKey = await getWalletSecretKey();
      if (!walletSecretKey) {
        setError('Wallet secret key not available');
        return false;
      }

      await initializeEncryption(walletSecretKey);
      return true;
    } catch (err) {
      console.error('Failed to initialize encryption:', err);
      setError('Failed to initialize encryption');
      return false;
    }
  }, [isEncryptionReady, initializeEncryption]);

  // Load and decrypt messages when conversation changes
  useEffect(() => {
    if (conversationId && autoDecrypt && isEncryptionReady) {
      decryptMessages(conversationId).catch((err) => {
        console.error('Failed to decrypt messages:', err);
      });
    }
  }, [conversationId, autoDecrypt, isEncryptionReady, decryptMessages]);

  // Create or get conversation when contact is available
  useEffect(() => {
    if (publicKey && contactAddress && isEncryptionReady) {
      const contactEncryptionKey = contact?.encryptionPublicKey;
      getOrCreateConversation(publicKey, contactAddress, contactEncryptionKey);
    }
  }, [publicKey, contactAddress, isEncryptionReady, contact?.encryptionPublicKey]);

  // Set contact encryption key
  const setContactEncryptionKey = useCallback((encryptionKey: string) => {
    if (!conversationId) return;
    updateContactEncryptionKey(conversationId, encryptionKey);
  }, [conversationId, updateContactEncryptionKey]);

  // Send a text message
  const sendTextMessage = useCallback(async (content: string): Promise<Message | null> => {
    if (!publicKey || !contactAddress || !conversationId) {
      setError('Missing required parameters');
      return null;
    }

    if (!isEncryptionReady) {
      setError('Encryption not initialized');
      return null;
    }

    if (!conversation?.contactEncryptionKey) {
      setError('Contact encryption key not available');
      return null;
    }

    setIsSending(true);
    setError(null);

    try {
      const message = await sendMessage(
        conversationId,
        content,
        publicKey,
        contactAddress,
        'text'
      );
      return message;
    } catch (err) {
      console.error('Failed to send message:', err);
      setError('Failed to send message');
      return null;
    } finally {
      setIsSending(false);
    }
  }, [publicKey, contactAddress, conversationId, isEncryptionReady, conversation, sendMessage]);

  // Send a payment request
  const sendPaymentRequest = useCallback(async (
    amount: number,
    token: string,
    tokenSymbol: string,
    memo?: string
  ): Promise<Message | null> => {
    if (!publicKey || !contactAddress || !conversationId) {
      setError('Missing required parameters');
      return null;
    }

    if (!isEncryptionReady) {
      setError('Encryption not initialized');
      return null;
    }

    if (!conversation?.contactEncryptionKey) {
      setError('Contact encryption key not available');
      return null;
    }

    setIsSending(true);
    setError(null);

    try {
      const content = `Payment request: ${amount} ${tokenSymbol}${memo ? ` - ${memo}` : ''}`;
      const paymentData: PaymentData = {
        amount,
        token,
        tokenSymbol,
        status: 'pending',
        memo,
      };

      const message = await sendMessage(
        conversationId,
        content,
        publicKey,
        contactAddress,
        'payment_request',
        paymentData
      );
      return message;
    } catch (err) {
      console.error('Failed to send payment request:', err);
      setError('Failed to send payment request');
      return null;
    } finally {
      setIsSending(false);
    }
  }, [publicKey, contactAddress, conversationId, isEncryptionReady, conversation, sendMessage]);

  // Send a payment sent notification
  const sendPaymentSent = useCallback(async (
    amount: number,
    token: string,
    tokenSymbol: string,
    txSignature: string,
    memo?: string
  ): Promise<Message | null> => {
    if (!publicKey || !contactAddress || !conversationId) {
      setError('Missing required parameters');
      return null;
    }

    if (!isEncryptionReady) {
      setError('Encryption not initialized');
      return null;
    }

    if (!conversation?.contactEncryptionKey) {
      setError('Contact encryption key not available');
      return null;
    }

    setIsSending(true);
    setError(null);

    try {
      const content = `Sent ${amount} ${tokenSymbol}${memo ? ` - ${memo}` : ''}`;
      const paymentData: PaymentData = {
        amount,
        token,
        tokenSymbol,
        status: 'completed',
        txSignature,
        memo,
      };

      const message = await sendMessage(
        conversationId,
        content,
        publicKey,
        contactAddress,
        'payment_sent',
        paymentData
      );
      return message;
    } catch (err) {
      console.error('Failed to send payment notification:', err);
      setError('Failed to send payment notification');
      return null;
    } finally {
      setIsSending(false);
    }
  }, [publicKey, contactAddress, conversationId, isEncryptionReady, conversation, sendMessage]);

  // Mark messages as read
  const markAsRead = useCallback(() => {
    if (!conversationId) return;
    storeMarkAsRead(conversationId);
  }, [conversationId, storeMarkAsRead]);

  // Delete a message
  const deleteMessage = useCallback((messageId: string) => {
    if (!conversationId) return;
    storeDeleteMessage(conversationId, messageId);
  }, [conversationId, storeDeleteMessage]);

  // Refresh messages (decrypt again)
  const refreshMessages = useCallback(async () => {
    if (!conversationId || !isEncryptionReady) return;

    setIsLoading(true);
    try {
      await decryptMessages(conversationId);
    } catch (err) {
      console.error('Failed to refresh messages:', err);
      setError('Failed to refresh messages');
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isEncryptionReady, decryptMessages]);

  return {
    // State
    messages,
    conversation,
    isLoading,
    isSending,
    error,
    isEncryptionReady,
    myEncryptionPublicKey,

    // Actions
    sendTextMessage,
    sendPaymentRequest,
    sendPaymentSent,
    markAsRead,
    deleteMessage,
    refreshMessages,

    // Encryption
    initializeEncryption: initEncryption,
    setContactEncryptionKey,
  };
}

/**
 * Get wallet secret key from secure storage
 * This is a placeholder - actual implementation should use expo-secure-store
 */
async function getWalletSecretKey(): Promise<Uint8Array | null> {
  try {
    // Import the secure storage module dynamically to avoid circular dependencies
    const SecureStore = await import('expo-secure-store');
    const keyHex = await SecureStore.getItemAsync('wallet_secret_key');

    if (!keyHex) {
      // Fallback: try to derive from mnemonic or other source
      console.warn('Wallet secret key not found in secure storage');
      return null;
    }

    // Convert hex string to Uint8Array
    const bytes = new Uint8Array(keyHex.length / 2);
    for (let i = 0; i < keyHex.length; i += 2) {
      bytes[i / 2] = parseInt(keyHex.slice(i, i + 2), 16);
    }
    return bytes;
  } catch (error) {
    console.error('Failed to get wallet secret key:', error);
    return null;
  }
}

/**
 * Hook to get unread message count across all conversations
 */
export function useUnreadMessageCount(): number {
  return useMessageStore((state) => state.getTotalUnreadCount());
}

/**
 * Hook to get all conversations
 */
export function useConversations(): Conversation[] {
  return useMessageStore((state) => state.getConversations());
}

/**
 * Hook to get conversation by ID
 */
export function useConversation(conversationId: string): Conversation | undefined {
  return useMessageStore((state) => state.conversations[conversationId]);
}

export type { Message, MessageType, PaymentData, Conversation } from '@/stores/messageStore';

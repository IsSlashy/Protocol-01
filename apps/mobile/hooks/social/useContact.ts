/**
 * useContact - Single contact with detailed info
 * @module hooks/social/useContact
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Contact, useContacts } from './useContacts';
import { useTransactions, Transaction } from '../wallet/useTransactions';
import { useWallet } from '../wallet/useWallet';
import { useStreams, Stream } from '../streams/useStreams';

export interface ContactStats {
  totalSent: bigint;
  totalSentFormatted: string;
  totalReceived: bigint;
  totalReceivedFormatted: string;
  transactionCount: number;
  lastTransaction?: Transaction;
  averageTransactionValue: bigint;
  firstInteraction?: number;
  lastInteraction?: number;
}

export interface ContactActivity {
  id: string;
  type: 'transaction' | 'stream' | 'request';
  direction: 'sent' | 'received';
  amount: bigint;
  amountFormatted: string;
  tokenSymbol: string;
  timestamp: number;
  status: string;
  txHash?: string;
  streamId?: string;
}

interface UseContactOptions {
  contactId?: string;
  address?: string;
}

interface UseContactReturn {
  contact: Contact | null;
  stats: ContactStats | null;
  activities: ContactActivity[];
  streams: Stream[];
  isLoading: boolean;
  error: Error | null;
  updateContact: (updates: Partial<Contact>) => Promise<boolean>;
  deleteContact: () => Promise<boolean>;
  toggleFavorite: () => Promise<boolean>;
  sendToContact: () => void;
  requestFromContact: () => void;
  createStreamToContact: () => void;
}

export function useContact({
  contactId,
  address,
}: UseContactOptions): UseContactReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const {
    contacts,
    getContactByAddress,
    updateContact: updateContactInList,
    deleteContact: deleteContactFromList,
    toggleFavorite: toggleFavoriteInList,
  } = useContacts();

  const { wallet } = useWallet();

  // Find contact
  const contact = useMemo(() => {
    if (contactId) {
      return contacts.find(c => c.id === contactId) ?? null;
    }
    if (address) {
      return getContactByAddress(address) ?? null;
    }
    return null;
  }, [contactId, address, contacts, getContactByAddress]);

  // Get transactions with this contact
  const { transactions } = useTransactions({
    address: wallet?.address ?? null,
  });

  const contactTransactions = useMemo(() => {
    if (!contact) return [];

    return transactions.filter(
      tx =>
        tx.from.toLowerCase() === contact.address.toLowerCase() ||
        tx.to.toLowerCase() === contact.address.toLowerCase()
    );
  }, [transactions, contact]);

  // Get streams with this contact
  const { streams: allStreams } = useStreams();

  const contactStreams = useMemo(() => {
    if (!contact) return [];

    return allStreams.filter(
      stream =>
        stream.sender.toLowerCase() === contact.address.toLowerCase() ||
        stream.recipient.toLowerCase() === contact.address.toLowerCase()
    );
  }, [allStreams, contact]);

  // Calculate stats
  const stats = useMemo((): ContactStats | null => {
    if (!contact || !wallet) return null;

    let totalSent = BigInt(0);
    let totalReceived = BigInt(0);

    for (const tx of contactTransactions) {
      if (tx.from.toLowerCase() === wallet.address.toLowerCase()) {
        totalSent += tx.value;
      } else {
        totalReceived += tx.value;
      }
    }

    const transactionCount = contactTransactions.length;
    const avgValue = transactionCount > 0
      ? (totalSent + totalReceived) / BigInt(transactionCount)
      : BigInt(0);

    const sortedTxs = [...contactTransactions].sort((a, b) => b.timestamp - a.timestamp);
    const firstTx = sortedTxs[sortedTxs.length - 1];
    const lastTx = sortedTxs[0];

    return {
      totalSent,
      totalSentFormatted: formatBigInt(totalSent),
      totalReceived,
      totalReceivedFormatted: formatBigInt(totalReceived),
      transactionCount,
      lastTransaction: lastTx,
      averageTransactionValue: avgValue,
      firstInteraction: firstTx?.timestamp,
      lastInteraction: lastTx?.timestamp,
    };
  }, [contact, wallet, contactTransactions]);

  // Build activity list
  const activities = useMemo((): ContactActivity[] => {
    if (!contact || !wallet) return [];

    const activityList: ContactActivity[] = [];

    // Add transactions
    for (const tx of contactTransactions) {
      const isSent = tx.from.toLowerCase() === wallet.address.toLowerCase();
      activityList.push({
        id: tx.id,
        type: 'transaction',
        direction: isSent ? 'sent' : 'received',
        amount: tx.value,
        amountFormatted: tx.valueFormatted,
        tokenSymbol: tx.tokenSymbol ?? 'ETH',
        timestamp: tx.timestamp,
        status: tx.status,
        txHash: tx.hash,
      });
    }

    // Add streams
    for (const stream of contactStreams) {
      const isSent = stream.sender.toLowerCase() === wallet.address.toLowerCase();
      activityList.push({
        id: stream.id,
        type: 'stream',
        direction: isSent ? 'sent' : 'received',
        amount: stream.depositAmount,
        amountFormatted: stream.depositAmountFormatted,
        tokenSymbol: stream.tokenSymbol,
        timestamp: stream.createdAt,
        status: stream.status,
        streamId: stream.id,
      });
    }

    // Sort by timestamp (newest first)
    activityList.sort((a, b) => b.timestamp - a.timestamp);

    return activityList;
  }, [contact, wallet, contactTransactions, contactStreams]);

  useEffect(() => {
    setIsLoading(false);
  }, [contact]);

  const updateContact = useCallback(async (
    updates: Partial<Contact>
  ): Promise<boolean> => {
    if (!contact) return false;
    return updateContactInList(contact.id, updates);
  }, [contact, updateContactInList]);

  const deleteContact = useCallback(async (): Promise<boolean> => {
    if (!contact) return false;
    return deleteContactFromList(contact.id);
  }, [contact, deleteContactFromList]);

  const toggleFavorite = useCallback(async (): Promise<boolean> => {
    if (!contact) return false;
    return toggleFavoriteInList(contact.id);
  }, [contact, toggleFavoriteInList]);

  // Navigation actions (to be connected to navigation)
  const sendToContact = useCallback(() => {
    if (!contact) return;
    // Navigate to send screen with pre-filled recipient
    console.log('Navigate to send with recipient:', contact.address);
  }, [contact]);

  const requestFromContact = useCallback(() => {
    if (!contact) return;
    // Navigate to request screen
    console.log('Navigate to request from:', contact.address);
  }, [contact]);

  const createStreamToContact = useCallback(() => {
    if (!contact) return;
    // Navigate to create stream with pre-filled recipient
    console.log('Navigate to create stream to:', contact.address);
  }, [contact]);

  return {
    contact,
    stats,
    activities,
    streams: contactStreams,
    isLoading,
    error,
    updateContact,
    deleteContact,
    toggleFavorite,
    sendToContact,
    requestFromContact,
    createStreamToContact,
  };
}

// Helper to format bigint
function formatBigInt(value: bigint, decimals: number = 18): string {
  const divisor = BigInt(10 ** decimals);
  const integer = value / divisor;
  const fractional = (value % divisor).toString().padStart(decimals, '0').slice(0, 4);
  return `${integer}.${fractional}`.replace(/\.?0+$/, '') || '0';
}

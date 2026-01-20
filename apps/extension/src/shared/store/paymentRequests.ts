/**
 * Payment Requests Store
 * Manages payment requests and in-chat payment state
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import {
  PaymentRequest,
  PaymentSent,
  createPaymentRequest,
  payRequest,
  declineRequest,
  sendCryptoInChat,
  updateExpiredRequests,
  CreatePaymentRequestOptions,
  SendCryptoOptions,
} from '../services/paymentRequest';
import { NetworkType } from '../services/wallet';
import { Keypair } from '@solana/web3.js';

export interface PaymentRequestsState {
  // Payment requests (both sent and received)
  paymentRequests: PaymentRequest[];

  // Sent payments history
  sentPayments: PaymentSent[];

  // Loading states
  isProcessing: boolean;
  error: string | null;

  // Actions
  createRequest: (options: Omit<CreatePaymentRequestOptions, 'requesterId'>, requesterId: string) => PaymentRequest;
  payPendingRequest: (requestId: string, keypair: Keypair, network: NetworkType) => Promise<{ signature: string }>;
  declinePendingRequest: (requestId: string) => void;
  sendCrypto: (options: SendCryptoOptions) => Promise<{ signature: string; payment: PaymentSent }>;
  getRequestById: (id: string) => PaymentRequest | undefined;
  getRequestsForContact: (contactAddress: string, myAddress: string) => PaymentRequest[];
  getPaymentsForContact: (contactAddress: string, myAddress: string) => PaymentSent[];
  updateExpiredPaymentRequests: () => void;
  clearError: () => void;
  reset: () => void;
}

export const usePaymentRequestsStore = create<PaymentRequestsState>()(
  persist(
    (set, get) => ({
      paymentRequests: [],
      sentPayments: [],
      isProcessing: false,
      error: null,

      // Create a new payment request
      createRequest: (options, requesterId) => {
        const request = createPaymentRequest({
          ...options,
          requesterId,
        });

        set((state) => ({
          paymentRequests: [...state.paymentRequests, request],
        }));

        return request;
      },

      // Pay a pending payment request
      payPendingRequest: async (requestId, keypair, network) => {
        const request = get().paymentRequests.find((r) => r.id === requestId);

        if (!request) {
          throw new Error('Payment request not found');
        }

        set({ isProcessing: true, error: null });

        try {
          const { signature, updatedRequest } = await payRequest(request, keypair, network);

          set((state) => ({
            paymentRequests: state.paymentRequests.map((r) =>
              r.id === requestId ? updatedRequest : r
            ),
            isProcessing: false,
          }));

          return { signature };
        } catch (error) {
          set({ isProcessing: false, error: (error as Error).message });
          throw error;
        }
      },

      // Decline a pending payment request
      declinePendingRequest: (requestId) => {
        const request = get().paymentRequests.find((r) => r.id === requestId);

        if (!request) {
          return;
        }

        const updatedRequest = declineRequest(request);

        set((state) => ({
          paymentRequests: state.paymentRequests.map((r) =>
            r.id === requestId ? updatedRequest : r
          ),
        }));
      },

      // Send crypto directly in chat
      sendCrypto: async (options) => {
        set({ isProcessing: true, error: null });

        try {
          const result = await sendCryptoInChat(options);

          set((state) => ({
            sentPayments: [...state.sentPayments, result.payment],
            isProcessing: false,
          }));

          return result;
        } catch (error) {
          set({ isProcessing: false, error: (error as Error).message });
          throw error;
        }
      },

      // Get a request by ID
      getRequestById: (id) => {
        return get().paymentRequests.find((r) => r.id === id);
      },

      // Get payment requests for a specific contact
      getRequestsForContact: (contactAddress, myAddress) => {
        return get().paymentRequests.filter(
          (r) =>
            (r.requesterId === contactAddress && r.recipientId === myAddress) ||
            (r.requesterId === myAddress && r.recipientId === contactAddress)
        );
      },

      // Get sent payments for a specific contact
      getPaymentsForContact: (contactAddress, myAddress) => {
        return get().sentPayments.filter(
          (p) =>
            (p.senderId === contactAddress && p.recipientId === myAddress) ||
            (p.senderId === myAddress && p.recipientId === contactAddress)
        );
      },

      // Update expired payment requests
      updateExpiredPaymentRequests: () => {
        set((state) => ({
          paymentRequests: updateExpiredRequests(state.paymentRequests),
        }));
      },

      // Clear error
      clearError: () => {
        set({ error: null });
      },

      // Reset store
      reset: () => {
        set({
          paymentRequests: [],
          sentPayments: [],
          isProcessing: false,
          error: null,
        });
      },
    }),
    {
      name: 'p01-payment-requests',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => ({
        paymentRequests: state.paymentRequests,
        sentPayments: state.sentPayments,
      }),
    }
  )
);

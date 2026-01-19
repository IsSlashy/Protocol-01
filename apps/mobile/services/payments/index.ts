/**
 * Payments service exports
 * @module services/payments
 */

export {
  // Types
  type PaymentRequest,
  type PaymentRequestStatus,
  type PaymentSent,
  type CreatePaymentRequestOptions,
  type SendCryptoOptions,
  type ChatPaymentMessage,
  type SupportedToken,

  // Constants
  KNOWN_TOKENS,
  SUPPORTED_TOKENS,

  // Payment request functions
  createPaymentRequest,
  payRequest,
  declineRequest,
  isRequestExpired,
  updateExpiredRequests,

  // In-chat transfer functions
  sendCryptoInChat,

  // Utility functions
  isValidSolanaAddress,
  formatPaymentAmount,
  getTokenInfo,
  getTokenSymbolFromMint,
  validatePaymentAmount,
  getTransactionUrl,
  openTransactionInExplorer,
  createChatPaymentMessage,
  formatExpirationTime,
  getStatusText,
  getStatusColor,
} from './paymentRequest';

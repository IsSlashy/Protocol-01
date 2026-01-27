/**
 * Payments service exports
 * @module services/payments
 *
 * Services:
 * - p01-payments: Native fiat-to-crypto (P-01 Network)
 * - paymentRequest: In-app payment requests
 * - helio: Backend for crypto payments (internal)
 * - jupiter: Token swaps (see ../jupiter)
 */

// P-01 Payments - Native Fiat On-Ramp
export {
  getCryptoPrices,
  getPaymentQuote,
  createPaymentSession,
  verifyWebhookSignature,
  formatCryptoAmount,
  formatFiatAmount,
  getAsset,
  getPaymentMethod,
  calculateP01Fee,
  validatePaymentLimits,
  SUPPORTED_ASSETS,
  SUPPORTED_FIAT,
  PAYMENT_METHODS,
  P01_NETWORK_FEE_BPS,
  type CryptoAsset,
  type FiatCurrency,
  type PaymentMethod,
  type PaymentQuote,
  type PaymentSession,
} from './p01-payments';

// Helio - Backend Payment Processing (internal use)
export {
  helio,
  type HelioConfig,
  type HelioSubscription,
  type HelioTransaction,
  type CreatePayLinkParams,
  type CreateSubscriptionPlanParams,
  type PayLink,
  type SubscriptionPlan,
} from './helio';

// Payment Requests (P2P)
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

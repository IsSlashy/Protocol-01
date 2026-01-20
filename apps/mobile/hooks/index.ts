/**
 * Protocol 01 Mobile Hooks
 *
 * All custom React hooks for the mobile application.
 * Organized by domain for easy discovery and usage.
 *
 * @module hooks
 */

// ============================================================================
// Wallet Hooks
// ============================================================================
export {
  useWallet,
  useBalance,
  useTokenBalance,
  useTransactions,
  useSend,
  useReceive,
  generateQRContent,
  parseQRContent,
} from './wallet';

export type {
  P01Wallet,
  WalletBalance,
  TokenBalance,
  Transaction,
  TransactionType,
  TransactionStatus,
  TransactionFilter,
  SendParams,
  GasEstimate,
  SendStep,
  SendState,
  ReceiveAddress,
  QRCodeData,
} from './wallet';

// ============================================================================
// Stealth Hooks
// ============================================================================
export {
  useStealth,
  useScan,
  usePrivacy,
} from './stealth';

export type {
  StealthKeys,
  StealthMetaAddress,
  GeneratedStealthAddress,
  StealthPayment,
  ScanProgress,
  ScanResult,
  PrivacyLevel,
  PrivacyScore,
  PrivacyFactor,
  PrivacyRecommendation,
  PrivacySettings,
} from './stealth';

// ============================================================================
// Streams Hooks
// ============================================================================
export {
  useStreams,
  useStream,
  useCreateStream,
  useStreamProgress,
  formatStreamTime,
  STREAM_DURATIONS,
} from './streams';

export type {
  Stream,
  StreamStatus,
  StreamDirection,
  StreamStats,
  StreamActions,
  CreateStreamParams,
  StreamPreview,
  CreateStreamStep,
  StreamProgress,
  StreamMilestone,
} from './streams';

// ============================================================================
// Social Hooks
// ============================================================================
export {
  useContacts,
  useContact,
  useRequests,
  useAddContact,
  createContactFromTransaction,
  validateStealthMetaAddress,
  formatAddressForDisplay,
} from './social';

export type {
  Contact,
  ContactGroup,
  ContactStats,
  ContactActivity,
  PaymentRequest,
  RequestStatus,
  RequestDirection,
  AddContactFormData,
  ValidationResult,
  AddContactStep,
} from './social';

// ============================================================================
// Agent Hooks
// ============================================================================
export {
  useAgent,
  useChat,
  useExecution,
  createPendingConfirmation,
} from './agent';

export type {
  AgentStatus,
  AgentCapability,
  AgentSettings,
  AgentState,
  PendingConfirmation,
  ChatMessage,
  MessageRole,
  MessageType,
  Suggestion,
  ChatContext,
  Execution,
  ExecutionStatus,
  ExecutionType,
  ExecutionStep,
  ExecutionResult,
} from './agent';

// ============================================================================
// Storage Hooks
// ============================================================================
export {
  useSecureStorage,
  useAsyncStorage,
  useBiometrics,
  asyncStorageUtils,
  quickAuthenticate,
  SECURE_KEYS,
  ASYNC_KEYS,
} from './storage';

export type {
  SecureKey,
  AsyncKey,
  BiometricType,
} from './storage';

// ============================================================================
// Common Hooks
// ============================================================================
export {
  useNetwork,
  useNetworkStatus,
  usePrice,
  useTokenPrice,
  useRefresh,
  useMultiRefresh,
  useSequentialRefresh,
  useAutoRefresh,
  useHaptics,
  useButtonHaptics,
  useListHaptics,
  useSwipeHaptics,
  NETWORKS,
  TOKEN_IDS,
} from './common';

export type {
  NetworkType,
  NetworkConfig,
  NetworkState,
  TokenPrice,
  PriceCache,
  RefreshConfig,
  MultiRefreshSource,
  AutoRefreshConfig,
  HapticFeedbackType,
  HapticsSettings,
} from './common';

// ============================================================================
// Bluetooth Hooks
// ============================================================================
export {
  useMesh,
  getZoneStatusColor,
  getZoneStatusLabel,
  getDeviceZoneColor,
  formatDeviceZone,
} from './bluetooth';

export type {
  UseMeshOptions,
  UseMeshReturn,
} from './bluetooth';

// ============================================================================
// Sync Hooks
// ============================================================================
export {
  useRealtimeSync,
} from './sync';

export type {
  UseRealtimeSyncOptions,
  UseRealtimeSyncReturn,
} from './sync';

// ============================================================================
// Font Loading
// ============================================================================
export { useLoadFonts } from './useLoadFonts';

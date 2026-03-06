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
} from './wallet';

export type {
  P01Wallet,
  WalletBalance,
  TokenBalance,
} from './wallet';

// ============================================================================
// Stealth Hooks
// ============================================================================
export {
  useStealth,
  useScan,
} from './stealth';

export type {
  StealthKeys,
  StealthMetaAddress,
  GeneratedStealthAddress,
  StealthPayment,
  ScanProgress,
  ScanResult,
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
// Agent Hooks
// ============================================================================
export {
  useAgent,
  useChat,
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
  useRefresh,
  useMultiRefresh,
  useSequentialRefresh,
  useAutoRefresh,
  useHaptics,
  useButtonHaptics,
  useListHaptics,
  useSwipeHaptics,
} from './common';

export type {
  RefreshConfig,
  MultiRefreshSource,
  AutoRefreshConfig,
  HapticFeedbackType,
  HapticsSettings,
} from './common';

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

/**
 * Agent hooks exports
 * @module hooks/agent
 */

export { useAgent, createPendingConfirmation } from './useAgent';
export type {
  AgentStatus,
  AgentCapability,
  AgentSettings,
  AgentState,
  PendingConfirmation,
} from './useAgent';

export { useChat } from './useChat';
export type {
  ChatMessage,
  MessageRole,
  MessageType,
  Suggestion,
  ChatContext,
} from './useChat';


/**
 * Social hooks exports
 * @module hooks/social
 */

export { useContacts } from './useContacts';
export type { Contact, ContactGroup } from './useContacts';

export { useContact } from './useContact';
export type { ContactStats, ContactActivity } from './useContact';

export { useRequests } from './useRequests';
export type {
  PaymentRequest,
  RequestStatus,
  RequestDirection,
} from './useRequests';

export {
  useAddContact,
  createContactFromTransaction,
  validateStealthMetaAddress,
  formatAddressForDisplay,
} from './useAddContact';
export type {
  AddContactFormData,
  ValidationResult,
  AddContactStep,
} from './useAddContact';

export {
  useMessages,
  useUnreadMessageCount,
  useConversations,
  useConversation,
} from './useMessages';
export type {
  Message,
  MessageType,
  PaymentData,
  Conversation,
  UseMessagesOptions,
  UseMessagesReturn,
} from './useMessages';

export { usePayments } from './usePayments';
export type {
  TokenBalance,
  CreatePaymentRequestParams,
  SendPaymentParams,
  UsePaymentsReturn,
} from './usePayments';

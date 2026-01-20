/**
 * Protocol 01 - Notification Types
 *
 * Type definitions for push and local notifications
 */

/**
 * Push notification token information
 */
export interface PushToken {
  token: string;
  platform: 'ios' | 'android' | 'web';
  createdAt: number;
}

/**
 * Notification permission status
 */
export type NotificationPermissionStatus =
  | 'granted'
  | 'denied'
  | 'undetermined';

/**
 * Notification category for different types of alerts
 */
export type NotificationCategory =
  | 'transaction'
  | 'payment_request'
  | 'mesh_message'
  | 'security'
  | 'general';

/**
 * Custom data payload for notifications
 */
export interface NotificationData {
  category?: NotificationCategory;
  transactionId?: string;
  senderId?: string;
  amount?: string;
  token?: string;
  action?: string;
  deepLink?: string;
  [key: string]: unknown;
}

/**
 * Local notification configuration
 */
export interface LocalNotificationConfig {
  title: string;
  body: string;
  data?: NotificationData;
  sound?: boolean | string;
  badge?: number;
  categoryIdentifier?: NotificationCategory;
  priority?: 'default' | 'high' | 'max';
}

/**
 * Scheduled notification configuration
 */
export interface ScheduledNotificationConfig extends LocalNotificationConfig {
  trigger: NotificationTrigger;
}

/**
 * Notification trigger types
 */
export type NotificationTrigger =
  | { seconds: number; repeats?: boolean }
  | { date: Date }
  | { hour: number; minute: number; repeats?: boolean };

/**
 * Notification response from user interaction
 */
export interface NotificationResponse {
  notification: {
    request: {
      identifier: string;
      content: {
        title: string | null;
        body: string | null;
        data: NotificationData;
      };
    };
  };
  actionIdentifier: string;
}

/**
 * Notification listener callback types
 */
export type NotificationReceivedCallback = (notification: {
  request: {
    identifier: string;
    content: {
      title: string | null;
      body: string | null;
      data: NotificationData;
    };
  };
}) => void;

export type NotificationResponseCallback = (response: NotificationResponse) => void;

/**
 * Notification service state
 */
export interface NotificationServiceState {
  isInitialized: boolean;
  permissionStatus: NotificationPermissionStatus;
  pushToken: PushToken | null;
  lastError: string | null;
}

/**
 * Notification channel configuration (Android)
 */
export interface NotificationChannel {
  id: string;
  name: string;
  importance: 'none' | 'min' | 'low' | 'default' | 'high' | 'max';
  description?: string;
  sound?: string;
  vibrationPattern?: number[];
  lightColor?: string;
  showBadge?: boolean;
}

/**
 * Default notification channels for Protocol 01
 */
export const DEFAULT_CHANNELS: NotificationChannel[] = [
  {
    id: 'transactions',
    name: 'Transactions',
    importance: 'high',
    description: 'Notifications for incoming and outgoing transactions',
    showBadge: true,
  },
  {
    id: 'payments',
    name: 'Payment Requests',
    importance: 'high',
    description: 'Notifications for payment requests from other users',
    showBadge: true,
  },
  {
    id: 'mesh',
    name: 'Mesh Network',
    importance: 'default',
    description: 'Notifications from mesh network peers',
    showBadge: false,
  },
  {
    id: 'security',
    name: 'Security Alerts',
    importance: 'max',
    description: 'Important security notifications',
    showBadge: true,
  },
  {
    id: 'general',
    name: 'General',
    importance: 'default',
    description: 'General app notifications',
    showBadge: false,
  },
];

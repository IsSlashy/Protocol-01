/**
 * Expo Notifications Wrapper
 *
 * This wrapper handles the conditional import of expo-notifications
 * to avoid auto-registration errors in Expo Go (SDK 53+).
 *
 * Push notifications are NOT available in Expo Go.
 * Local notifications still work.
 */

import Constants from 'expo-constants';

// Check if running in Expo Go
export const isExpoGo = Constants.appOwnership === 'expo';

// Type definitions for what we need from expo-notifications
export interface NotificationContentInput {
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown>;
  sound?: boolean | string;
  priority?: string;
}

export interface NotificationTriggerInput {
  type?: string;
  seconds?: number;
}

export interface NotificationRequestInput {
  content: NotificationContentInput;
  trigger: NotificationTriggerInput | null;
}

// Lazy-loaded notifications module
let _notifications: typeof import('expo-notifications') | null = null;
let _loadAttempted = false;
let _loadError: Error | null = null;

/**
 * Get the expo-notifications module (lazy loaded)
 * Returns null if in Expo Go or if loading fails
 */
export function getNotificationsModule(): typeof import('expo-notifications') | null {
  if (_loadAttempted) {
    return _notifications;
  }

  _loadAttempted = true;

  if (isExpoGo) {
    return null;
  }

  try {
    // Dynamic require to avoid auto-registration at module load time
    _notifications = require('expo-notifications');
    return _notifications;
  } catch (error) {
    _loadError = error as Error;
    console.warn('[Notifications] Failed to load expo-notifications:', error);
    return null;
  }
}

/**
 * Schedule a notification (safe wrapper)
 */
export async function scheduleNotification(
  request: NotificationRequestInput
): Promise<string> {
  const Notifications = getNotificationsModule();
  if (!Notifications) {
    return '';
  }

  try {
    return await Notifications.scheduleNotificationAsync(request as any);
  } catch (error) {
    console.warn('[Notifications] Failed to schedule notification:', error);
    return '';
  }
}

/**
 * Cancel a notification (safe wrapper)
 */
export async function cancelNotification(identifier: string): Promise<void> {
  const Notifications = getNotificationsModule();
  if (!Notifications || !identifier) return;

  try {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  } catch (error) {
    console.warn('[Notifications] Failed to cancel notification:', error);
  }
}

/**
 * Cancel all notifications (safe wrapper)
 */
export async function cancelAllNotifications(): Promise<void> {
  const Notifications = getNotificationsModule();
  if (!Notifications) return;

  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (error) {
    console.warn('[Notifications] Failed to cancel all notifications:', error);
  }
}

/**
 * Set badge count (safe wrapper)
 */
export async function setBadgeCount(count: number): Promise<void> {
  const Notifications = getNotificationsModule();
  if (!Notifications) return;

  try {
    await Notifications.setBadgeCountAsync(count);
  } catch (error) {
    console.warn('[Notifications] Failed to set badge count:', error);
  }
}

/**
 * Get Android importance constant
 */
export function getAndroidImportance(level: 'none' | 'min' | 'low' | 'default' | 'high' | 'max'): number {
  const Notifications = getNotificationsModule();
  if (!Notifications) return 3; // DEFAULT

  const map: Record<string, number> = {
    none: Notifications.AndroidImportance.NONE,
    min: Notifications.AndroidImportance.MIN,
    low: Notifications.AndroidImportance.LOW,
    default: Notifications.AndroidImportance.DEFAULT,
    high: Notifications.AndroidImportance.HIGH,
    max: Notifications.AndroidImportance.MAX,
  };

  return map[level] ?? 3;
}

/**
 * Check if notifications are available
 */
export function isNotificationsAvailable(): boolean {
  return getNotificationsModule() !== null;
}

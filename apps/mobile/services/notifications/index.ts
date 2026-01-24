/**
 * Protocol 01 - Notification Service
 *
 * Push and local notification management.
 *
 * Note: Push notifications are NOT available in Expo Go (SDK 53+).
 * Use a development build for full push notification support.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

import {
  isExpoGo,
  getNotificationsModule,
  scheduleNotification,
  cancelNotification as cancelNotificationWrapper,
  cancelAllNotifications as cancelAllNotificationsWrapper,
  setBadgeCount as setBadgeCountWrapper,
  getAndroidImportance,
  isNotificationsAvailable,
} from './notificationsWrapper';

import {
  PushToken,
  NotificationPermissionStatus,
  NotificationData,
  LocalNotificationConfig,
  ScheduledNotificationConfig,
  NotificationResponse,
  NotificationReceivedCallback,
  NotificationResponseCallback,
  NotificationServiceState,
  DEFAULT_CHANNELS,
} from './types';

// Service state
let serviceState: NotificationServiceState = {
  isInitialized: false,
  permissionStatus: 'undetermined',
  pushToken: null,
  lastError: isExpoGo ? 'Push notifications not available in Expo Go' : null,
};

// Initialize notification handler (only if not in Expo Go)
if (!isExpoGo) {
  const Notifications = getNotificationsModule();
  if (Notifications) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        priority: Notifications.AndroidNotificationPriority.HIGH,
      }),
    });
  }
}

/**
 * Initialize Android notification channels
 */
async function initializeAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android' || isExpoGo) return;

  const Notifications = getNotificationsModule();
  if (!Notifications) return;

  for (const channel of DEFAULT_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance: getAndroidImportance(channel.importance as any),
      description: channel.description,
      sound: channel.sound,
      vibrationPattern: channel.vibrationPattern,
      lightColor: channel.lightColor,
      showBadge: channel.showBadge,
    });
  }
}

/**
 * Request notification permissions and register for push notifications
 * @returns Push token information or null if registration fails
 */
export async function registerForPushNotifications(): Promise<PushToken | null> {
  // Skip in Expo Go
  if (isExpoGo) {
    console.log('[Notifications] Push notifications not available in Expo Go');
    serviceState.lastError = 'Push notifications not available in Expo Go';
    return null;
  }

  const Notifications = getNotificationsModule();
  if (!Notifications) {
    serviceState.lastError = 'Notifications module not available';
    return null;
  }

  try {
    // Check if running on a physical device
    if (!Device.isDevice) {
      console.warn('Push notifications require a physical device');
      serviceState.lastError = 'Push notifications require a physical device';
      return null;
    }

    // Initialize Android channels first
    await initializeAndroidChannels();

    // Check existing permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    // Request permissions if not already granted
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    // Update service state with permission status
    serviceState.permissionStatus = finalStatus as NotificationPermissionStatus;

    if (finalStatus !== 'granted') {
      console.warn('Push notification permissions not granted');
      serviceState.lastError = 'Push notification permissions not granted';
      return null;
    }

    // Get the Expo push token
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      console.warn('Project ID not found for push token registration');
      serviceState.lastError = 'Project ID not found';
      return null;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    const pushToken: PushToken = {
      token: tokenData.data,
      platform: Platform.OS as 'ios' | 'android',
      createdAt: Date.now(),
    };

    // Update service state
    serviceState.pushToken = pushToken;
    serviceState.isInitialized = true;
    serviceState.lastError = null;

    console.log('Push notification token registered:', pushToken.token);
    return pushToken;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to register for push notifications:', errorMessage);
    serviceState.lastError = errorMessage;
    return null;
  }
}

/**
 * Schedule a local notification
 */
export async function scheduleLocalNotification(
  title: string,
  body: string,
  data?: NotificationData
): Promise<string> {
  return scheduleNotification({
    content: {
      title,
      body,
      data: data ?? {},
      sound: 'default',
      priority: 'high',
    },
    trigger: null, // Immediate notification
  });
}

/**
 * Schedule a delayed or repeating notification
 */
export async function scheduleDelayedNotification(
  config: ScheduledNotificationConfig
): Promise<string> {
  return scheduleNotification({
    content: {
      title: config.title,
      body: config.body,
      data: config.data ?? {},
      sound: config.sound === true ? 'default' : config.sound || undefined,
      priority: config.priority,
    },
    trigger: config.trigger as any,
  });
}

/**
 * Cancel a scheduled notification
 */
export async function cancelNotification(identifier: string): Promise<void> {
  return cancelNotificationWrapper(identifier);
}

/**
 * Cancel all scheduled notifications
 */
export async function cancelAllNotifications(): Promise<void> {
  return cancelAllNotificationsWrapper();
}

/**
 * Set up notification listeners for foreground and response handling
 */
export function setupNotificationListeners(
  onReceived?: NotificationReceivedCallback,
  onResponse?: NotificationResponseCallback
): () => void {
  const Notifications = getNotificationsModule();
  if (!Notifications) {
    return () => {}; // No-op cleanup
  }

  // Listener for notifications received while app is foregrounded
  const receivedSubscription = Notifications.addNotificationReceivedListener(
    (notification) => {
      console.log('Notification received:', notification.request.identifier);
      if (onReceived) {
        onReceived({
          request: {
            identifier: notification.request.identifier,
            content: {
              title: notification.request.content.title,
              body: notification.request.content.body,
              data: notification.request.content.data as NotificationData,
            },
          },
        });
      }
    }
  );

  // Listener for user interaction with notifications
  const responseSubscription =
    Notifications.addNotificationResponseReceivedListener((response) => {
      console.log('Notification response:', response.notification.request.identifier);
      if (onResponse) {
        onResponse({
          notification: {
            request: {
              identifier: response.notification.request.identifier,
              content: {
                title: response.notification.request.content.title,
                body: response.notification.request.content.body,
                data: response.notification.request.content.data as NotificationData,
              },
            },
          },
          actionIdentifier: response.actionIdentifier,
        });
      }
    });

  // Return cleanup function
  return () => {
    receivedSubscription.remove();
    responseSubscription.remove();
  };
}

/**
 * Get the last notification response
 */
export async function getLastNotificationResponse(): Promise<NotificationResponse | null> {
  const Notifications = getNotificationsModule();
  if (!Notifications) return null;

  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    if (!response) return null;

    return {
      notification: {
        request: {
          identifier: response.notification.request.identifier,
          content: {
            title: response.notification.request.content.title,
            body: response.notification.request.content.body,
            data: response.notification.request.content.data as NotificationData,
          },
        },
      },
      actionIdentifier: response.actionIdentifier,
    };
  } catch (error) {
    console.error('Failed to get last notification response:', error);
    return null;
  }
}

/**
 * Get current notification permission status
 */
export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  const Notifications = getNotificationsModule();
  if (!Notifications) return 'undetermined';

  try {
    const { status } = await Notifications.getPermissionsAsync();
    serviceState.permissionStatus = status as NotificationPermissionStatus;
    return status as NotificationPermissionStatus;
  } catch (error) {
    console.error('Failed to get permission status:', error);
    return 'undetermined';
  }
}

/**
 * Get the current service state
 */
export function getNotificationServiceState(): NotificationServiceState {
  return { ...serviceState };
}

/**
 * Set the badge count on the app icon
 */
export async function setBadgeCount(count: number): Promise<void> {
  return setBadgeCountWrapper(count);
}

/**
 * Get all pending notification requests
 */
export async function getPendingNotifications(): Promise<string[]> {
  const Notifications = getNotificationsModule();
  if (!Notifications) return [];

  try {
    const notifications = await Notifications.getAllScheduledNotificationsAsync();
    return notifications.map((n) => n.identifier);
  } catch (error) {
    console.error('Failed to get pending notifications:', error);
    return [];
  }
}

// Re-export types
export * from './types';
export { isExpoGo, isNotificationsAvailable };

/**
 * Protocol 01 - Notification Service
 *
 * Push and local notification management:
 * - Permission handling and token registration
 * - Local notification scheduling
 * - Notification response handling
 * - Android notification channels
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

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

// Configure default notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    priority: Notifications.AndroidNotificationPriority.HIGH,
  }),
});

// Service state
let serviceState: NotificationServiceState = {
  isInitialized: false,
  permissionStatus: 'undetermined',
  pushToken: null,
  lastError: null,
};

/**
 * Initialize Android notification channels
 */
async function initializeAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  for (const channel of DEFAULT_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance: getAndroidImportance(channel.importance),
      description: channel.description,
      sound: channel.sound,
      vibrationPattern: channel.vibrationPattern,
      lightColor: channel.lightColor,
      showBadge: channel.showBadge,
    });
  }
}

/**
 * Convert importance string to Android constant
 */
function getAndroidImportance(
  importance: string
): Notifications.AndroidImportance {
  const importanceMap: Record<string, Notifications.AndroidImportance> = {
    none: Notifications.AndroidImportance.NONE,
    min: Notifications.AndroidImportance.MIN,
    low: Notifications.AndroidImportance.LOW,
    default: Notifications.AndroidImportance.DEFAULT,
    high: Notifications.AndroidImportance.HIGH,
    max: Notifications.AndroidImportance.MAX,
  };
  return importanceMap[importance] ?? Notifications.AndroidImportance.DEFAULT;
}

/**
 * Request notification permissions and register for push notifications
 * @returns Push token information or null if registration fails
 */
export async function registerForPushNotifications(): Promise<PushToken | null> {
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
    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
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
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to register for push notifications:', errorMessage);
    serviceState.lastError = errorMessage;
    return null;
  }
}

/**
 * Schedule a local notification
 * @param title - Notification title
 * @param body - Notification body text
 * @param data - Optional custom data payload
 * @returns Notification identifier
 */
export async function scheduleLocalNotification(
  title: string,
  body: string,
  data?: NotificationData
): Promise<string> {
  try {
    const config: LocalNotificationConfig = {
      title,
      body,
      data,
      sound: true,
      priority: 'high',
    };

    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: config.title,
        body: config.body,
        data: config.data ?? {},
        sound: config.sound === true ? 'default' : config.sound || undefined,
        priority: config.priority,
      },
      trigger: null, // Immediate notification
    });

    console.log('Local notification scheduled:', identifier);
    return identifier;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to schedule local notification:', errorMessage);
    throw new Error(`Failed to schedule notification: ${errorMessage}`);
  }
}

/**
 * Schedule a delayed or repeating notification
 * @param config - Scheduled notification configuration
 * @returns Notification identifier
 */
export async function scheduleDelayedNotification(
  config: ScheduledNotificationConfig
): Promise<string> {
  try {
    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: config.title,
        body: config.body,
        data: config.data ?? {},
        sound: config.sound === true ? 'default' : config.sound || undefined,
        priority: config.priority,
      },
      trigger: config.trigger,
    });

    console.log('Delayed notification scheduled:', identifier);
    return identifier;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to schedule delayed notification:', errorMessage);
    throw new Error(`Failed to schedule notification: ${errorMessage}`);
  }
}

/**
 * Cancel a scheduled notification
 * @param identifier - Notification identifier to cancel
 */
export async function cancelNotification(identifier: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(identifier);
    console.log('Notification cancelled:', identifier);
  } catch (error) {
    console.error('Failed to cancel notification:', error);
  }
}

/**
 * Cancel all scheduled notifications
 */
export async function cancelAllNotifications(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    console.log('All notifications cancelled');
  } catch (error) {
    console.error('Failed to cancel all notifications:', error);
  }
}

/**
 * Set up notification listeners for foreground and response handling
 * @param onReceived - Callback when notification is received in foreground
 * @param onResponse - Callback when user interacts with notification
 * @returns Cleanup function to remove listeners
 */
export function setupNotificationListeners(
  onReceived?: NotificationReceivedCallback,
  onResponse?: NotificationResponseCallback
): () => void {
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
      console.log(
        'Notification response:',
        response.notification.request.identifier
      );
      if (onResponse) {
        onResponse({
          notification: {
            request: {
              identifier: response.notification.request.identifier,
              content: {
                title: response.notification.request.content.title,
                body: response.notification.request.content.body,
                data: response.notification.request.content
                  .data as NotificationData,
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
 * Get the last notification response (for handling app launch from notification)
 * @returns Last notification response or null
 */
export async function getLastNotificationResponse(): Promise<NotificationResponse | null> {
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
 * @returns Permission status
 */
export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
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
 * @returns Current notification service state
 */
export function getNotificationServiceState(): NotificationServiceState {
  return { ...serviceState };
}

/**
 * Set the badge count on the app icon
 * @param count - Badge count (0 to clear)
 */
export async function setBadgeCount(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch (error) {
    console.error('Failed to set badge count:', error);
  }
}

/**
 * Get all pending notification requests
 * @returns Array of pending notification identifiers
 */
export async function getPendingNotifications(): Promise<string[]> {
  try {
    const notifications =
      await Notifications.getAllScheduledNotificationsAsync();
    return notifications.map((n) => n.identifier);
  } catch (error) {
    console.error('Failed to get pending notifications:', error);
    return [];
  }
}

// Re-export types
export * from './types';

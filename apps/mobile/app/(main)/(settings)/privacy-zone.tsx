/**
 * Privacy Zone Settings Screen
 *
 * Configure Bluetooth-based privacy zone functionality:
 * - Enable/disable privacy zone
 * - Manage trusted devices
 * - Configure auto-lock settings
 * - View nearby devices
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  SettingsSection,
  SettingsRow,
  ToggleRow,
} from '../../../components/settings';
import {
  useMesh,
  getDeviceZoneColor,
  formatDeviceZone,
} from '../../../hooks/bluetooth';
import type { NearbyDevice, TrustedDevice } from '../../../services/bluetooth/mesh';

const AUTO_LOCK_OPTIONS = [
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
  { label: '1 minute', value: 60000 },
  { label: 'Disabled', value: -1 },
];

const MIN_DEVICES_OPTIONS = [
  { label: '1 device', value: 1 },
  { label: '2 devices', value: 2 },
  { label: '3 devices', value: 3 },
];

export default function PrivacyZoneSettingsScreen() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [showNearbyDevices, setShowNearbyDevices] = useState(false);

  const {
    isInitialized,
    isScanning,
    bluetoothState,
    error,
    zoneStatus,
    isInZone,
    isInBufferZone,
    zoneColor,
    zoneLabel,
    nearbyDevices,
    trustedDevices,
    nearbyTrustedCount,
    settings,
    startScanning,
    stopScanning,
    refreshDevices,
    addTrustedDevice,
    removeTrustedDevice,
    updateSettings,
    clearError,
  } = useMesh({
    autoStart: true,
    onZoneEnter: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onZoneExit: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    },
  });

  // Handle refresh
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    refreshDevices();
    if (!isScanning && settings.enabled) {
      await startScanning();
    }
    setRefreshing(false);
  }, [refreshDevices, isScanning, settings.enabled, startScanning]);

  // Handle toggle privacy zone
  const handleToggleEnabled = async (value: boolean) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await updateSettings({ enabled: value });

    if (value && !isScanning) {
      await startScanning();
    } else if (!value && isScanning) {
      stopScanning();
    }
  };

  // Handle toggle auto-lock
  const handleToggleAutoLock = async (value: boolean) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await updateSettings({ autoLockEnabled: value });
  };

  // Handle toggle background scanning
  const handleToggleBackgroundScan = async (value: boolean) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await updateSettings({ backgroundScanEnabled: value });
  };

  // Handle toggle notifications
  const handleToggleNotifications = async (value: boolean) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await updateSettings({ notifyOnZoneChange: value });
  };

  // Handle auto-lock delay selection
  const handleAutoLockDelaySelect = () => {
    Alert.alert(
      'Auto-Lock Delay',
      'How long to wait before locking after leaving the privacy zone?',
      AUTO_LOCK_OPTIONS.map((option) => ({
        text: option.label,
        onPress: async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          if (option.value === -1) {
            await updateSettings({ autoLockEnabled: false });
          } else {
            await updateSettings({ autoLockDelay: option.value, autoLockEnabled: true });
          }
        },
      }))
    );
  };

  // Handle min devices selection
  const handleMinDevicesSelect = () => {
    Alert.alert(
      'Minimum Trusted Devices',
      'How many trusted devices are required to activate the privacy zone?',
      MIN_DEVICES_OPTIONS.map((option) => ({
        text: option.label,
        onPress: async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await updateSettings({ requireMinDevices: option.value });
        },
      }))
    );
  };

  // Handle add trusted device
  const handleAddDevice = async (device: NearbyDevice) => {
    Alert.alert(
      'Add Trusted Device',
      `Add "${device.name || 'Unknown Device'}" to your privacy zone?\n\nThis device will be used to determine when you're in a secure location.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Add',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await addTrustedDevice(device);
          },
        },
      ]
    );
  };

  // Handle remove trusted device
  const handleRemoveDevice = async (device: TrustedDevice) => {
    Alert.alert(
      'Remove Trusted Device',
      `Remove "${device.name}" from your privacy zone?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            await removeTrustedDevice(device.id);
          },
        },
      ]
    );
  };

  // Get auto-lock label
  const getAutoLockLabel = () => {
    if (!settings.autoLockEnabled) return 'Disabled';
    const option = AUTO_LOCK_OPTIONS.find((o) => o.value === settings.autoLockDelay);
    return option?.label || `${settings.autoLockDelay / 1000}s`;
  };

  // Get min devices label
  const getMinDevicesLabel = () => {
    const option = MIN_DEVICES_OPTIONS.find((o) => o.value === settings.requireMinDevices);
    return option?.label || `${settings.requireMinDevices} device(s)`;
  };

  // Get Bluetooth status message
  const getBluetoothStatusMessage = () => {
    switch (bluetoothState) {
      case 'off':
        return 'Bluetooth is off. Please enable Bluetooth to use privacy zones.';
      case 'unauthorized':
        return 'Bluetooth permission not granted. Please enable in Settings.';
      case 'unsupported':
        return 'Bluetooth is not supported on this device.';
      default:
        return null;
    }
  };

  const btMessage = getBluetoothStatusMessage();

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">Privacy Zone</Text>
        <TouchableOpacity
          onPress={onRefresh}
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
          disabled={!isInitialized}
        >
          {isScanning ? (
            <ActivityIndicator size="small" color="#39c5bb" />
          ) : (
            <Ionicons name="refresh" size={20} color="#39c5bb" />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#39c5bb"
          />
        }
      >
        {/* Status Card */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl border" style={{ borderColor: zoneColor + '40' }}>
          <View className="flex-row items-center justify-between mb-3">
            <View className="flex-row items-center">
              <View
                className="w-3 h-3 rounded-full mr-2"
                style={{ backgroundColor: zoneColor }}
              />
              <Text className="text-white text-base font-semibold">
                Privacy Zone {zoneLabel}
              </Text>
            </View>
            {isScanning && (
              <View className="flex-row items-center">
                <ActivityIndicator size="small" color="#39c5bb" />
                <Text className="text-p01-cyan text-xs ml-1">Scanning</Text>
              </View>
            )}
          </View>

          <View className="flex-row justify-between">
            <View>
              <Text className="text-p01-gray text-xs uppercase">Nearby Trusted</Text>
              <Text className="text-white text-lg font-bold">{nearbyTrustedCount}</Text>
            </View>
            <View>
              <Text className="text-p01-gray text-xs uppercase">Total Nearby</Text>
              <Text className="text-white text-lg font-bold">{zoneStatus.totalNearbyCount}</Text>
            </View>
            <View>
              <Text className="text-p01-gray text-xs uppercase">Trusted Devices</Text>
              <Text className="text-white text-lg font-bold">{trustedDevices.length}</Text>
            </View>
          </View>

          {zoneStatus.autoLockScheduled && (
            <View className="mt-3 pt-3 border-t border-p01-border">
              <Text className="text-yellow-500 text-sm">
                Auto-lock scheduled...
              </Text>
            </View>
          )}
        </View>

        {/* Bluetooth Warning */}
        {btMessage && (
          <View className="mx-4 mb-4 p-4 bg-red-500/10 rounded-2xl border border-red-500/30">
            <View className="flex-row items-center">
              <Ionicons name="bluetooth" size={20} color="#ef4444" />
              <Text className="text-red-400 text-sm ml-3 flex-1">{btMessage}</Text>
            </View>
          </View>
        )}

        {/* Error Message */}
        {error && (
          <TouchableOpacity
            onPress={clearError}
            className="mx-4 mb-4 p-4 bg-red-500/10 rounded-2xl border border-red-500/30"
          >
            <View className="flex-row items-center">
              <Ionicons name="warning" size={20} color="#ef4444" />
              <Text className="text-red-400 text-sm ml-3 flex-1">{error}</Text>
              <Ionicons name="close" size={16} color="#ef4444" />
            </View>
          </TouchableOpacity>
        )}

        {/* Privacy Zone Toggle */}
        <SettingsSection title="Privacy Zone">
          <ToggleRow
            label="Enable Privacy Zone"
            description="Auto-protect wallet when near trusted devices"
            value={settings.enabled}
            onValueChange={handleToggleEnabled}
            disabled={bluetoothState !== 'on'}
          />
        </SettingsSection>

        {/* Settings */}
        <SettingsSection title="Settings">
          <ToggleRow
            label="Auto-lock on exit"
            description="Lock wallet when leaving privacy zone"
            value={settings.autoLockEnabled}
            onValueChange={handleToggleAutoLock}
            disabled={!settings.enabled}
          />
          <View className="h-px bg-p01-border mx-4" />
          <SettingsRow
            label="Lock delay"
            value={getAutoLockLabel()}
            onPress={handleAutoLockDelaySelect}
            leftIcon="timer-outline"
            disabled={!settings.enabled || !settings.autoLockEnabled}
          />
          <View className="h-px bg-p01-border mx-4" />
          <SettingsRow
            label="Required devices"
            value={getMinDevicesLabel()}
            onPress={handleMinDevicesSelect}
            leftIcon="people-outline"
            disabled={!settings.enabled}
          />
          <View className="h-px bg-p01-border mx-4" />
          <ToggleRow
            label="Zone notifications"
            description="Notify when entering/leaving zone"
            value={settings.notifyOnZoneChange}
            onValueChange={handleToggleNotifications}
            disabled={!settings.enabled}
          />
          <View className="h-px bg-p01-border mx-4" />
          <ToggleRow
            label="Background scanning"
            description="Continue scanning when app is minimized"
            value={settings.backgroundScanEnabled}
            onValueChange={handleToggleBackgroundScan}
            disabled={!settings.enabled}
          />
        </SettingsSection>

        {/* Trusted Devices */}
        <SettingsSection title="Trusted Devices">
          {trustedDevices.length === 0 ? (
            <View className="py-6 px-4">
              <Text className="text-p01-gray text-sm text-center">
                No trusted devices yet.{'\n'}Add devices from the nearby list below.
              </Text>
            </View>
          ) : (
            trustedDevices.map((device, index) => (
              <React.Fragment key={device.id}>
                {index > 0 && <View className="h-px bg-p01-border mx-4" />}
                <TouchableOpacity
                  className="flex-row items-center justify-between py-4 px-4"
                  onPress={() => handleRemoveDevice(device)}
                >
                  <View className="flex-row items-center flex-1">
                    <View className="w-10 h-10 rounded-full bg-p01-elevated items-center justify-center mr-3">
                      <Ionicons name="phone-portrait-outline" size={20} color="#39c5bb" />
                    </View>
                    <View className="flex-1">
                      <Text className="text-white text-base font-medium">{device.name}</Text>
                      <Text className="text-p01-gray text-xs">
                        {device.isInRange ? formatDeviceZone(device.zone) : 'Out of range'}
                      </Text>
                    </View>
                  </View>
                  <View className="flex-row items-center">
                    <View
                      className="w-2 h-2 rounded-full mr-2"
                      style={{ backgroundColor: device.isInRange ? getDeviceZoneColor(device.zone) : '#666' }}
                    />
                    <Ionicons name="trash-outline" size={18} color="#666" />
                  </View>
                </TouchableOpacity>
              </React.Fragment>
            ))
          )}
        </SettingsSection>

        {/* Nearby Devices */}
        <SettingsSection title="Nearby Devices">
          <TouchableOpacity
            className="flex-row items-center justify-between py-4 px-4"
            onPress={() => setShowNearbyDevices(!showNearbyDevices)}
          >
            <View className="flex-row items-center">
              <View className="w-8 h-8 rounded-lg bg-p01-elevated items-center justify-center mr-3">
                <Ionicons name="bluetooth" size={18} color="#39c5bb" />
              </View>
              <Text className="text-white text-base font-medium">
                {nearbyDevices.length} devices found
              </Text>
            </View>
            <Ionicons
              name={showNearbyDevices ? 'chevron-up' : 'chevron-down'}
              size={20}
              color="#555560"
            />
          </TouchableOpacity>

          {showNearbyDevices && nearbyDevices.length > 0 && (
            <>
              <View className="h-px bg-p01-border mx-4" />
              {nearbyDevices
                .filter(d => !d.isTrusted)
                .slice(0, 10)
                .map((device, index) => (
                  <React.Fragment key={device.id}>
                    {index > 0 && <View className="h-px bg-p01-border mx-4" />}
                    <TouchableOpacity
                      className="flex-row items-center justify-between py-3 px-4"
                      onPress={() => handleAddDevice(device)}
                    >
                      <View className="flex-row items-center flex-1">
                        <View
                          className="w-2 h-2 rounded-full mr-3"
                          style={{ backgroundColor: getDeviceZoneColor(device.zone) }}
                        />
                        <View className="flex-1">
                          <Text className="text-white text-sm">
                            {device.name || 'Unknown Device'}
                          </Text>
                          <Text className="text-p01-gray text-xs">
                            {formatDeviceZone(device.zone)} | {device.rssi} dBm
                          </Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        className="px-3 py-1 bg-p01-cyan/20 rounded-full"
                        onPress={() => handleAddDevice(device)}
                      >
                        <Text className="text-p01-cyan text-xs font-medium">Add</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>
                  </React.Fragment>
                ))}
            </>
          )}

          {showNearbyDevices && nearbyDevices.filter(d => !d.isTrusted).length === 0 && (
            <>
              <View className="h-px bg-p01-border mx-4" />
              <View className="py-4 px-4">
                <Text className="text-p01-gray text-sm text-center">
                  {isScanning
                    ? 'Scanning for nearby devices...'
                    : 'No untrusted devices nearby'}
                </Text>
              </View>
            </>
          )}
        </SettingsSection>

        {/* Info */}
        <View className="mx-4 mt-2 p-4 bg-p01-surface rounded-2xl border border-p01-cyan/20">
          <View className="flex-row items-start mb-2">
            <Ionicons name="information-circle" size={18} color="#39c5bb" />
            <Text className="text-p01-cyan text-sm font-semibold ml-2">
              How Privacy Zones Work
            </Text>
          </View>
          <Text className="text-p01-text-secondary text-sm leading-5">
            Privacy zones use Bluetooth to detect trusted devices nearby.
            When you're near your trusted devices (like your laptop or home speaker),
            the wallet stays unlocked. When you leave, it can automatically lock to
            protect your assets.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

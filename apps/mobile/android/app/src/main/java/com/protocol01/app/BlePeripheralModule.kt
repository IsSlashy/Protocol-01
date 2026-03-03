package com.protocol01.app

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.*

/**
 * Native Android module providing BLE peripheral (GATT server + advertising) for P2P note sharing.
 *
 * react-native-ble-plx only supports central mode (scanning/connecting).
 * This module makes the receiver phone act as a peripheral so the sender can discover and connect.
 *
 * Service UUID and characteristic UUIDs match the constants in services/sharing/types.ts.
 */
@SuppressLint("MissingPermission")
class BlePeripheralModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "BlePeripheral"

        // Must match types.ts
        private val SERVICE_UUID = UUID.fromString("F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5A")
        private val PUBKEY_CHAR_UUID = UUID.fromString("F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5B")
        private val DATA_CHAR_UUID = UUID.fromString("F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C")
        private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private var bluetoothManager: BluetoothManager? = null
    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var isAdvertisingActive = false
    private var connectedDevice: BluetoothDevice? = null

    override fun getName(): String = "BlePeripheralModule"

    private fun emit(event: String, params: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, params)
    }

    // -----------------------------------------------------------------------
    // GATT Server Callback
    // -----------------------------------------------------------------------

    private val gattCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            Log.d(TAG, "Connection state: device=${device.address} status=$status state=$newState")

            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connectedDevice = device
                val params = Arguments.createMap().apply {
                    putString("peerId", device.address)
                    putString("displayName", device.name ?: "P01 Device")
                }
                emit("BlePeripheralPeerConnected", params)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                val peerId = device.address
                if (connectedDevice?.address == peerId) {
                    connectedDevice = null
                }
                val params = Arguments.createMap().apply {
                    putString("peerId", peerId)
                }
                emit("BlePeripheralPeerDisconnected", params)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            Log.d(TAG, "Write request: char=${characteristic.uuid} len=${value.size} responseNeeded=$responseNeeded")

            // Send response first
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }

            // Emit raw data to JS — JS handles fragment reassembly
            val params = Arguments.createMap().apply {
                putString("peerId", device.address)
                putString("characteristicUuid", characteristic.uuid.toString().uppercase())
                putString("data", Base64.encodeToString(value, Base64.NO_WRAP))
            }
            emit("BlePeripheralDataReceived", params)
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) {
            Log.d(TAG, "Read request: char=${characteristic.uuid}")
            val value = characteristic.value ?: ByteArray(0)
            val response = if (offset < value.size) value.sliceArray(offset until value.size) else ByteArray(0)
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, response)
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray
        ) {
            // Handle CCCD subscription for notifications
            if (descriptor.uuid == CCCD_UUID) {
                if (Arrays.equals(value, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ||
                    Arrays.equals(value, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
                ) {
                    Log.d(TAG, "Device subscribed to notifications: ${device.address}")
                } else {
                    Log.d(TAG, "Device unsubscribed: ${device.address}")
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor
        ) {
            if (descriptor.uuid == CCCD_UUID) {
                gattServer?.sendResponse(
                    device, requestId, BluetoothGatt.GATT_SUCCESS, 0,
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                )
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            Log.d(TAG, "MTU changed: device=${device.address} mtu=$mtu")
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            Log.d(TAG, "Notification sent: status=$status")
        }
    }

    // -----------------------------------------------------------------------
    // Advertise Callback
    // -----------------------------------------------------------------------

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            Log.d(TAG, "Advertising started successfully")
            isAdvertisingActive = true
        }

        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "Advertising failed: errorCode=$errorCode")
            isAdvertisingActive = false
            val params = Arguments.createMap().apply {
                putString("message", "BLE advertising failed (code: $errorCode)")
            }
            emit("BlePeripheralError", params)
        }
    }

    // -----------------------------------------------------------------------
    // React Native Methods
    // -----------------------------------------------------------------------

    @ReactMethod
    fun startPeripheral(promise: Promise) {
        try {
            bluetoothManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = bluetoothManager?.adapter

            if (adapter == null || !adapter.isEnabled) {
                promise.reject("BLE_DISABLED", "Bluetooth is not enabled")
                return
            }

            // Check permissions on Android 12+
            if (Build.VERSION.SDK_INT >= 31) {
                val advertiseOk = ContextCompat.checkSelfPermission(
                    reactContext, android.Manifest.permission.BLUETOOTH_ADVERTISE
                ) == PackageManager.PERMISSION_GRANTED
                val connectOk = ContextCompat.checkSelfPermission(
                    reactContext, android.Manifest.permission.BLUETOOTH_CONNECT
                ) == PackageManager.PERMISSION_GRANTED

                if (!advertiseOk || !connectOk) {
                    promise.reject("BLE_NO_PERMISSION", "Bluetooth ADVERTISE/CONNECT permissions required")
                    return
                }
            }

            // Create GATT server
            gattServer = bluetoothManager?.openGattServer(reactContext, gattCallback)
            if (gattServer == null) {
                promise.reject("GATT_FAILED", "Failed to open GATT server")
                return
            }

            // Build the GATT service with two characteristics
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

            // Pubkey characteristic: read + write + notify
            val pubkeyChar = BluetoothGattCharacteristic(
                PUBKEY_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ or
                    BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                    BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ or
                    BluetoothGattCharacteristic.PERMISSION_WRITE
            )
            pubkeyChar.addDescriptor(
                BluetoothGattDescriptor(
                    CCCD_UUID,
                    BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
                )
            )
            service.addCharacteristic(pubkeyChar)

            // Data characteristic: read + write + notify
            val dataChar = BluetoothGattCharacteristic(
                DATA_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ or
                    BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                    BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ or
                    BluetoothGattCharacteristic.PERMISSION_WRITE
            )
            dataChar.addDescriptor(
                BluetoothGattDescriptor(
                    CCCD_UUID,
                    BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
                )
            )
            service.addCharacteristic(dataChar)

            gattServer?.addService(service)

            // Start advertising
            advertiser = adapter.bluetoothLeAdvertiser
            if (advertiser == null) {
                promise.reject("ADVERTISER_NULL", "BLE advertising not supported on this device")
                return
            }

            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0) // Advertise indefinitely
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .build()

            val advData = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()

            val scanResponse = AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .build()

            advertiser?.startAdvertising(settings, advData, scanResponse, advertiseCallback)

            Log.d(TAG, "Peripheral started: GATT server + advertising")
            promise.resolve(true)

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start peripheral", e)
            promise.reject("START_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopPeripheral(promise: Promise) {
        try {
            if (isAdvertisingActive && advertiser != null) {
                try {
                    advertiser?.stopAdvertising(advertiseCallback)
                } catch (e: SecurityException) {
                    Log.w(TAG, "SecurityException stopping advertising", e)
                }
                isAdvertisingActive = false
            }

            gattServer?.close()
            gattServer = null
            connectedDevice = null

            Log.d(TAG, "Peripheral stopped")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop peripheral", e)
            promise.reject("STOP_FAILED", e.message, e)
        }
    }

    /**
     * Send a notification to the connected central device.
     * Used to send our pubkey and ACK responses back to the sender.
     *
     * @param characteristicUuid UUID of the characteristic to notify on
     * @param dataBase64 Data to send, base64-encoded
     */
    @ReactMethod
    fun sendNotification(characteristicUuid: String, dataBase64: String, promise: Promise) {
        try {
            val device = connectedDevice
            if (device == null) {
                promise.reject("NO_DEVICE", "No connected device")
                return
            }

            val server = gattServer
            if (server == null) {
                promise.reject("NO_SERVER", "GATT server not running")
                return
            }

            val uuid = UUID.fromString(characteristicUuid)
            val service = server.getService(SERVICE_UUID)
            val characteristic = service?.getCharacteristic(uuid)

            if (characteristic == null) {
                promise.reject("NO_CHAR", "Characteristic not found: $characteristicUuid")
                return
            }

            val data = Base64.decode(dataBase64, Base64.NO_WRAP)

            if (Build.VERSION.SDK_INT >= 33) {
                val status = server.notifyCharacteristicChanged(device, characteristic, false, data)
                if (status == BluetoothStatusCodes.SUCCESS) {
                    promise.resolve(true)
                } else {
                    promise.reject("NOTIFY_FAILED", "notifyCharacteristicChanged returned status: $status")
                }
            } else {
                @Suppress("DEPRECATION")
                characteristic.value = data
                @Suppress("DEPRECATION")
                val result = server.notifyCharacteristicChanged(device, characteristic, false)
                if (result) {
                    promise.resolve(true)
                } else {
                    promise.reject("NOTIFY_FAILED", "notifyCharacteristicChanged returned false")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send notification", e)
            promise.reject("SEND_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun isAdvertising(promise: Promise) {
        promise.resolve(isAdvertisingActive)
    }

    // Required for NativeEventEmitter
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}

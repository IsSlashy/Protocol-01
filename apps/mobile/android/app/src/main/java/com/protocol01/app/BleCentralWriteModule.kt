package com.protocol01.app

import android.annotation.SuppressLint
import android.bluetooth.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import java.util.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Native BLE central write module — bypasses react-native-ble-plx operation queue.
 *
 * ble-plx's internal operation queue gets permanently stuck after receiving
 * notifications on some Android devices, blocking all subsequent writes.
 * This module uses the raw Android BluetoothGatt API to connect and write.
 */
@SuppressLint("MissingPermission")
class BleCentralWriteModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "BleCentralWrite"
        private const val TIMEOUT_CONNECT_SEC = 10L
        private const val TIMEOUT_WRITE_SEC = 5L
        private const val TIMEOUT_MTU_SEC = 3L
    }

    private var gatt: BluetoothGatt? = null

    @Volatile private var connectLatch: CountDownLatch? = null
    @Volatile private var writeLatch: CountDownLatch? = null
    @Volatile private var mtuLatch: CountDownLatch? = null
    @Volatile private var lastWriteStatus: Int = BluetoothGatt.GATT_SUCCESS
    @Volatile private var negotiatedMtu: Int = 23

    override fun getName(): String = "BleCentralWriteModule"

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            Log.d(TAG, "onConnectionStateChange: status=$status state=$newState")
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connectLatch?.countDown()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connectLatch?.countDown() // unblock if waiting
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            Log.d(TAG, "onServicesDiscovered: status=$status")
            connectLatch?.countDown()
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            Log.d(TAG, "onCharacteristicWrite: status=$status")
            lastWriteStatus = status
            writeLatch?.countDown()
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            Log.d(TAG, "onMtuChanged: mtu=$mtu status=$status")
            if (status == BluetoothGatt.GATT_SUCCESS) {
                negotiatedMtu = mtu
            }
            mtuLatch?.countDown()
        }
    }

    /**
     * Connect to a BLE peripheral, discover services, negotiate MTU, and write
     * multiple data chunks to a characteristic. All done via raw Android GATT API.
     *
     * @param deviceAddress MAC address of the peripheral (e.g., "BC:A5:8B:76:44:63")
     * @param serviceUuid UUID of the GATT service
     * @param charUuid UUID of the characteristic to write to
     * @param chunksBase64 ReadableArray of base64-encoded byte chunks
     */
    @ReactMethod
    fun connectAndWrite(
        deviceAddress: String,
        serviceUuid: String,
        charUuid: String,
        chunksBase64: ReadableArray,
        promise: Promise
    ) {
        Thread {
            try {
                val manager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                val adapter = manager?.adapter
                if (adapter == null || !adapter.isEnabled) {
                    promise.reject("BLE_DISABLED", "Bluetooth is not enabled")
                    return@Thread
                }

                if (Build.VERSION.SDK_INT >= 31) {
                    val ok = ContextCompat.checkSelfPermission(
                        reactContext, android.Manifest.permission.BLUETOOTH_CONNECT
                    ) == PackageManager.PERMISSION_GRANTED
                    if (!ok) {
                        promise.reject("BLE_NO_PERMISSION", "BLUETOOTH_CONNECT permission required")
                        return@Thread
                    }
                }

                val device = adapter.getRemoteDevice(deviceAddress)

                // 1. Connect
                Log.d(TAG, "Connecting to $deviceAddress")
                connectLatch = CountDownLatch(1)
                gatt = device.connectGatt(reactContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                if (!connectLatch!!.await(TIMEOUT_CONNECT_SEC, TimeUnit.SECONDS)) {
                    cleanup()
                    promise.reject("TIMEOUT", "Connection timeout")
                    return@Thread
                }

                val g = gatt
                if (g == null) {
                    promise.reject("CONNECT_FAILED", "GATT is null after connect")
                    return@Thread
                }

                // 2. Discover services
                Log.d(TAG, "Discovering services")
                connectLatch = CountDownLatch(1)
                g.discoverServices()
                if (!connectLatch!!.await(TIMEOUT_CONNECT_SEC, TimeUnit.SECONDS)) {
                    cleanup()
                    promise.reject("TIMEOUT", "Service discovery timeout")
                    return@Thread
                }

                // 3. Request MTU
                Log.d(TAG, "Requesting MTU 517")
                mtuLatch = CountDownLatch(1)
                g.requestMtu(517)
                mtuLatch!!.await(TIMEOUT_MTU_SEC, TimeUnit.SECONDS) // OK if times out, just use default
                Log.d(TAG, "Negotiated MTU: $negotiatedMtu")

                // 4. Get characteristic
                val svcUuid = UUID.fromString(serviceUuid)
                val cUuid = UUID.fromString(charUuid)
                val service = g.getService(svcUuid)
                if (service == null) {
                    cleanup()
                    promise.reject("NO_SERVICE", "Service $serviceUuid not found")
                    return@Thread
                }
                val characteristic = service.getCharacteristic(cUuid)
                if (characteristic == null) {
                    cleanup()
                    promise.reject("NO_CHAR", "Characteristic $charUuid not found")
                    return@Thread
                }

                // 5. Write chunks
                val totalChunks = chunksBase64.size()
                Log.d(TAG, "Writing $totalChunks chunks")

                for (i in 0 until totalChunks) {
                    val chunkData = Base64.decode(chunksBase64.getString(i), Base64.NO_WRAP)
                    writeLatch = CountDownLatch(1)
                    lastWriteStatus = -1

                    if (Build.VERSION.SDK_INT >= 33) {
                        val writeResult = g.writeCharacteristic(
                            characteristic,
                            chunkData,
                            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        )
                        if (writeResult != BluetoothStatusCodes.SUCCESS) {
                            cleanup()
                            promise.reject("WRITE_FAILED", "writeCharacteristic returned $writeResult for chunk $i")
                            return@Thread
                        }
                    } else {
                        @Suppress("DEPRECATION")
                        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        @Suppress("DEPRECATION")
                        characteristic.value = chunkData
                        @Suppress("DEPRECATION")
                        val ok = g.writeCharacteristic(characteristic)
                        if (!ok) {
                            cleanup()
                            promise.reject("WRITE_FAILED", "writeCharacteristic returned false for chunk $i")
                            return@Thread
                        }
                    }

                    if (!writeLatch!!.await(TIMEOUT_WRITE_SEC, TimeUnit.SECONDS)) {
                        cleanup()
                        promise.reject("TIMEOUT", "Write timeout on chunk $i")
                        return@Thread
                    }
                    if (lastWriteStatus != BluetoothGatt.GATT_SUCCESS) {
                        cleanup()
                        promise.reject("WRITE_ERROR", "Chunk $i write status: $lastWriteStatus")
                        return@Thread
                    }
                    Log.d(TAG, "Chunk ${i + 1}/$totalChunks written OK")
                }

                Log.d(TAG, "All $totalChunks chunks written successfully")
                cleanup()
                promise.resolve(totalChunks)

            } catch (e: Exception) {
                Log.e(TAG, "connectAndWrite failed", e)
                cleanup()
                promise.reject("ERROR", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        cleanup()
        promise.resolve(true)
    }

    private fun cleanup() {
        try {
            gatt?.disconnect()
            gatt?.close()
        } catch (e: Exception) {
            Log.w(TAG, "cleanup error", e)
        }
        gatt = null
    }

    // Required for NativeEventEmitter compatibility
    @ReactMethod
    fun addListener(eventName: String) {}
    @ReactMethod
    fun removeListeners(count: Int) {}
}

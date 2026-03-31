package com.protocol01.app

import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import java.util.concurrent.atomic.AtomicBoolean

/**
 * React Native bridge for controlling the NFC HCE service.
 * Lets JS set/clear the encrypted note data and wait for actual transfer.
 */
class NfcHceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "NfcHceModule"
        private const val TRANSFER_TIMEOUT_MS = 60_000L // 60 seconds
    }

    override fun getName(): String = "NfcHceModule"

    /**
     * Set the encrypted note data that the HCE service will serve on NFC tap.
     */
    @ReactMethod
    fun setNoteData(base64Data: String, promise: Promise) {
        try {
            NfcShareService.noteData = Base64.decode(base64Data, Base64.NO_WRAP)
            NfcShareService.resetState()
            Log.d(TAG, "Note data set: ${NfcShareService.noteData?.size} bytes")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SET_DATA_FAILED", e.message, e)
        }
    }

    /**
     * Wait for the receiver to actually tap and read all the data.
     * The promise resolves when NfcShareService detects a complete read,
     * or rejects after TRANSFER_TIMEOUT_MS if no tap occurs.
     */
    @ReactMethod
    fun waitForTransfer(promise: Promise) {
        Log.d(TAG, "Waiting for NFC transfer (timeout=${TRANSFER_TIMEOUT_MS}ms)...")
        val resolved = AtomicBoolean(false)
        val handler = Handler(Looper.getMainLooper())

        val timeoutRunnable = Runnable {
            if (resolved.compareAndSet(false, true)) {
                NfcShareService.onTransferComplete = null
                Log.w(TAG, "Transfer timeout — receiver did not tap")
                promise.reject("NFC_TIMEOUT", "Receiver did not tap within ${TRANSFER_TIMEOUT_MS / 1000}s")
            }
        }

        handler.postDelayed(timeoutRunnable, TRANSFER_TIMEOUT_MS)

        NfcShareService.onTransferComplete = {
            handler.removeCallbacks(timeoutRunnable)
            if (resolved.compareAndSet(false, true)) {
                Log.d(TAG, "Transfer complete callback fired")
                promise.resolve(true)
            }
        }
    }

    /** Clear the note data — stops serving on NFC tap. */
    @ReactMethod
    fun clearNoteData(promise: Promise) {
        NfcShareService.noteData = null
        NfcShareService.onTransferComplete = null
        NfcShareService.resetState()
        promise.resolve(true)
    }

    /** Check if note data is currently set. */
    @ReactMethod
    fun hasNoteData(promise: Promise) {
        promise.resolve(NfcShareService.noteData != null)
    }
}

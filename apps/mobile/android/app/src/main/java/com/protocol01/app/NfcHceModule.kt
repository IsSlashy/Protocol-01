package com.protocol01.app

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*

/**
 * React Native bridge for controlling the NFC HCE service.
 * Lets JS set/clear the encrypted note data and wait for actual transfer.
 */
class NfcHceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "NfcHceModule"
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
     * The promise resolves when NfcShareService detects a complete read.
     */
    @ReactMethod
    fun waitForTransfer(promise: Promise) {
        Log.d(TAG, "Waiting for NFC transfer...")
        NfcShareService.onTransferComplete = {
            Log.d(TAG, "Transfer complete callback fired")
            promise.resolve(true)
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

package com.protocol01.app

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.util.Log

/**
 * HCE (Host Card Emulation) service for NFC phone-to-phone note sharing.
 *
 * The sender's phone emulates an NFC tag via this service. When the receiver
 * taps their phone, the service responds to APDU commands with the encrypted note data.
 *
 * Protocol:
 *   SELECT AID (F050303100) → SW 9000
 *   GET LENGTH (INS=B1)     → [len_hi, len_lo, 90, 00]
 *   GET DATA   (INS=B0, P1P2=offset) → [chunk..., 90, 00]
 */
class NfcShareService : HostApduService() {

    companion object {
        private const val TAG = "NfcShareService"

        /** The encrypted note data to serve. Set by NfcHceModule before tap. */
        @Volatile
        var noteData: ByteArray? = null

        /** Callback invoked when receiver has read all the data. */
        @Volatile
        var onTransferComplete: (() -> Unit)? = null

        /** Track whether data was actually read during this session. */
        @Volatile
        private var dataWasRead = false

        /** Total bytes of data that have been read by the receiver. */
        @Volatile
        private var bytesRead = 0

        // Status words
        private val SW_OK = byteArrayOf(0x90.toByte(), 0x00.toByte())
        private val SW_NOT_FOUND = byteArrayOf(0x6A.toByte(), 0x82.toByte())
        private val SW_WRONG_INS = byteArrayOf(0x6D.toByte(), 0x00.toByte())

        // Max chunk size per APDU response (leave room for SW)
        private const val MAX_CHUNK = 250

        fun resetState() {
            dataWasRead = false
            bytesRead = 0
        }
    }

    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
        if (commandApdu.size < 4) return SW_WRONG_INS

        val ins = commandApdu[1]

        return when {
            // SELECT AID
            ins == 0xA4.toByte() -> {
                Log.d(TAG, "SELECT AID received")
                resetState()
                SW_OK
            }

            // GET LENGTH
            ins == 0xB1.toByte() -> {
                val data = noteData
                if (data == null) {
                    Log.w(TAG, "GET LENGTH but no data set")
                    return SW_NOT_FOUND
                }
                val len = data.size
                Log.d(TAG, "GET LENGTH: $len bytes")
                byteArrayOf(
                    ((len shr 8) and 0xFF).toByte(),
                    (len and 0xFF).toByte(),
                ) + SW_OK
            }

            // GET DATA at offset P1:P2
            ins == 0xB0.toByte() -> {
                val data = noteData
                if (data == null) return SW_NOT_FOUND

                val offset = ((commandApdu[2].toInt() and 0xFF) shl 8) or
                    (commandApdu[3].toInt() and 0xFF)

                if (offset >= data.size) {
                    Log.d(TAG, "GET DATA: offset $offset past end (${data.size})")
                    return SW_NOT_FOUND
                }

                val chunkSize = minOf(MAX_CHUNK, data.size - offset)
                val chunk = data.sliceArray(offset until offset + chunkSize)
                bytesRead = offset + chunkSize
                dataWasRead = true
                Log.d(TAG, "GET DATA: offset=$offset chunk=$chunkSize total_read=$bytesRead/${data.size}")

                // If we've served all the data, notify JS
                if (bytesRead >= data.size) {
                    Log.d(TAG, "All data read by receiver — transfer complete")
                    onTransferComplete?.invoke()
                    onTransferComplete = null
                }

                chunk + SW_OK
            }

            else -> {
                Log.w(TAG, "Unknown INS: ${ins.toInt() and 0xFF}")
                SW_WRONG_INS
            }
        }
    }

    override fun onDeactivated(reason: Int) {
        Log.d(TAG, "Deactivated: reason=$reason dataWasRead=$dataWasRead bytesRead=$bytesRead")
        // If deactivated before all data was read, still notify if partial read happened
        if (dataWasRead && onTransferComplete != null) {
            onTransferComplete?.invoke()
            onTransferComplete = null
        }
        resetState()
    }
}

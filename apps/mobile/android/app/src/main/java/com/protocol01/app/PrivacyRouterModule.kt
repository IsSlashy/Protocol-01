package com.protocol01.app

import com.facebook.react.bridge.*

/**
 * React Native bridge for the Privacy Router foreground service.
 *
 * JS API:
 *   import { NativeModules } from 'react-native';
 *   const { PrivacyRouterModule } = NativeModules;
 *
 *   PrivacyRouterModule.startService(14, "7:01 PM");  // 14 hops, ETA
 *   PrivacyRouterModule.updateNotification(12, "8:30 PM");
 *   PrivacyRouterModule.stopService();
 *   PrivacyRouterModule.isRunning().then(running => ...);
 */
class PrivacyRouterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PrivacyRouterModule"

    @ReactMethod
    fun startService(hopsRemaining: Int, eta: String, promise: Promise) {
        try {
            PrivacyRouterService.start(reactApplicationContext, hopsRemaining, eta)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SERVICE_START_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopService(promise: Promise) {
        try {
            PrivacyRouterService.stop(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SERVICE_STOP_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun updateNotification(hopsRemaining: Int, eta: String, promise: Promise) {
        try {
            PrivacyRouterService.updateNotification(reactApplicationContext, hopsRemaining, eta)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("NOTIFICATION_UPDATE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun isRunning(promise: Promise) {
        promise.resolve(PrivacyRouterService.isRunning)
    }
}

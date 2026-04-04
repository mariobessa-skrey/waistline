package com.waistline.xdrip

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import org.apache.cordova.CallbackContext
import org.apache.cordova.CordovaPlugin
import org.json.JSONArray
import org.json.JSONObject

class XDripBroadcastPlugin : CordovaPlugin() {

    companion object {
        // xDrip+ Broadcast Service constants
        private const val ACTION_RECEIVER =
            "com.eveningoutpost.dexdrip.watch.wearintegration.BROADCAST_SERVICE_RECEIVER"
        private const val ACTION_SENDER =
            "com.eveningoutpost.dexdrip.watch.wearintegration.BROADCAST_SERVICE_SENDER"
        private const val FUNCTION_KEY = "FUNCTION"
        private const val CMD_SET_SETTINGS = "set_settings"
        private const val CMD_ADD_TREATMENT = "add_treatment"
        private const val SETTINGS_KEY = "SETTINGS"
        private const val PACKAGE_KEY = "PACKAGE"
    }

    private var registrationCallback: CallbackContext? = null
    private var registered = false

    private val broadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent == null) return
            val function = intent.getStringExtra(FUNCTION_KEY) ?: return
            if (function == "start") {
                // xDrip+ broadcast service started, register ourselves
                registerWithXDrip()
            }
        }
    }

    override fun pluginInitialize() {
        val filter = IntentFilter(ACTION_SENDER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            cordova.activity.registerReceiver(broadcastReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            cordova.activity.registerReceiver(broadcastReceiver, filter)
        }
    }

    override fun onDestroy() {
        try {
            cordova.activity.unregisterReceiver(broadcastReceiver)
        } catch (e: Exception) {
            // Receiver may not be registered
        }
    }

    override fun execute(action: String, args: JSONArray, callbackContext: CallbackContext): Boolean {
        when (action) {
            "register" -> {
                cordova.threadPool.execute {
                    register(callbackContext)
                }
                return true
            }
            "addTreatment" -> {
                val carbs = args.getDouble(0)
                val timestamp = args.getLong(1)
                cordova.threadPool.execute {
                    addTreatment(carbs, timestamp, callbackContext)
                }
                return true
            }
            "isAvailable" -> {
                callbackContext.success(JSONObject().put("available", true))
                return true
            }
            else -> return false
        }
    }

    private fun register(callbackContext: CallbackContext) {
        try {
            registerWithXDrip()
            registered = true
            callbackContext.success(JSONObject().put("registered", true))
        } catch (e: Exception) {
            callbackContext.error("Failed to register: ${e.message}")
        }
    }

    private fun registerWithXDrip() {
        val intent = Intent(ACTION_RECEIVER)
        intent.putExtra(FUNCTION_KEY, CMD_SET_SETTINGS)
        intent.putExtra(PACKAGE_KEY, cordova.activity.packageName)
        intent.putExtra(SETTINGS_KEY, JSONObject().apply {
            put("name", "Waistline")
        }.toString())
        cordova.activity.sendBroadcast(intent)
    }

    private fun addTreatment(carbs: Double, timestamp: Long, callbackContext: CallbackContext) {
        try {
            if (!registered) {
                registerWithXDrip()
                registered = true
            }

            val intent = Intent(ACTION_RECEIVER)
            intent.putExtra(FUNCTION_KEY, CMD_ADD_TREATMENT)
            intent.putExtra(PACKAGE_KEY, cordova.activity.packageName)
            intent.putExtra("carbs", carbs)
            intent.putExtra("timeStamp", timestamp)
            intent.putExtra("insulin", 0.0)
            cordova.activity.sendBroadcast(intent)

            callbackContext.success(JSONObject().put("sent", true))
        } catch (e: Exception) {
            callbackContext.error("Failed to send treatment: ${e.message}")
        }
    }
}

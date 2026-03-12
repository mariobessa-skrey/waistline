package com.waistline.healthconnect

import android.content.Intent
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Energy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.apache.cordova.CallbackContext
import org.apache.cordova.CordovaPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

class HealthConnectPlugin : CordovaPlugin() {

    companion object {
        private const val REQUEST_CODE_PERMISSIONS = 1001
        private const val APP_TAG = "Waistline"
    }

    private var permissionCallback: CallbackContext? = null

    private fun getClient(): HealthConnectClient? {
        return try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
            val status = HealthConnectClient.getSdkStatus(cordova.activity)
            if (status == HealthConnectClient.SDK_AVAILABLE) {
                HealthConnectClient.getOrCreate(cordova.activity)
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    override fun execute(action: String, args: JSONArray, callbackContext: CallbackContext): Boolean {
        when (action) {
            "isAvailable" -> {
                cordova.threadPool.execute {
                    isAvailable(callbackContext)
                }
                return true
            }
            "requestPermission" -> {
                requestPermission(callbackContext)
                return true
            }
            "writeNutrition" -> {
                val mealData = args.getJSONArray(0)
                val dateStr = args.getString(1)
                cordova.threadPool.execute {
                    writeNutrition(mealData, dateStr, callbackContext)
                }
                return true
            }
            else -> return false
        }
    }

    private fun isAvailable(callbackContext: CallbackContext) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                callbackContext.success(JSONObject().put("available", false))
                return
            }
            val status = HealthConnectClient.getSdkStatus(cordova.activity)
            val available = status == HealthConnectClient.SDK_AVAILABLE
            callbackContext.success(JSONObject().put("available", available))
        } catch (e: Exception) {
            callbackContext.success(JSONObject().put("available", false))
        }
    }

    private fun requestPermission(callbackContext: CallbackContext) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                callbackContext.success(JSONObject().put("granted", false))
                return
            }

            val client = getClient()
            if (client == null) {
                callbackContext.success(JSONObject().put("granted", false))
                return
            }

            permissionCallback = callbackContext

            CoroutineScope(Dispatchers.Main).launch {
                try {
                    val permissions = setOf(
                        HealthPermission.getWritePermission(NutritionRecord::class),
                        HealthPermission.getReadPermission(NutritionRecord::class)
                    )

                    val granted = client.permissionController.getGrantedPermissions()
                    if (granted.containsAll(permissions)) {
                        permissionCallback?.success(JSONObject().put("granted", true))
                        permissionCallback = null
                        return@launch
                    }

                    val intent = Intent("androidx.health.ACTION_MANAGE_HEALTH_PERMISSIONS").apply {
                        putExtra("android.intent.extra.PACKAGE_NAME", cordova.activity.packageName)
                    }
                    cordova.startActivityForResult(this@HealthConnectPlugin, intent, REQUEST_CODE_PERMISSIONS)
                } catch (e: Exception) {
                    permissionCallback?.success(JSONObject().put("granted", false))
                    permissionCallback = null
                }
            }
        } catch (e: Exception) {
            callbackContext.success(JSONObject().put("granted", false))
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, intent: Intent?) {
        super.onActivityResult(requestCode, resultCode, intent)
        if (requestCode == REQUEST_CODE_PERMISSIONS) {
            val client = getClient()
            if (client != null) {
                CoroutineScope(Dispatchers.Main).launch {
                    try {
                        val permissions = setOf(
                            HealthPermission.getWritePermission(NutritionRecord::class),
                            HealthPermission.getReadPermission(NutritionRecord::class)
                        )
                        val granted = client.permissionController.getGrantedPermissions()
                        val allGranted = granted.containsAll(permissions)
                        permissionCallback?.success(JSONObject().put("granted", allGranted))
                    } catch (e: Exception) {
                        permissionCallback?.success(JSONObject().put("granted", false))
                    }
                    permissionCallback = null
                }
            } else {
                permissionCallback?.success(JSONObject().put("granted", false))
                permissionCallback = null
            }
        }
    }

    private fun writeNutrition(mealData: JSONArray, dateStr: String, callbackContext: CallbackContext) {
        val client = getClient()
        if (client == null) {
            callbackContext.error("Health Connect not available")
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val zone = ZoneId.systemDefault()
                val date = LocalDate.parse(dateStr.substring(0, 10))
                val startOfDay = date.atStartOfDay(zone).toInstant()
                val endOfDay = date.plusDays(1).atStartOfDay(zone).toInstant().minusMillis(1)

                // Delete existing records from this app for this day
                val existingRecords = client.readRecords(
                    ReadRecordsRequest(
                        recordType = NutritionRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(startOfDay, endOfDay)
                    )
                )

                val idsToDelete = existingRecords.records
                    .filter { it.metadata.dataOrigin.packageName == cordova.activity.packageName }
                    .mapNotNull { it.metadata.id }

                if (idsToDelete.isNotEmpty()) {
                    client.deleteRecords(NutritionRecord::class, idsToDelete, emptyList())
                }

                // Write a NutritionRecord per meal
                val records = mutableListOf<NutritionRecord>()
                for (i in 0 until mealData.length()) {
                    val meal = mealData.getJSONObject(i)
                    val calories = meal.getDouble("calories")
                    val timestampStr = meal.getString("timestamp")

                    if (calories <= 0) continue

                    val mealTimestamp = Instant.parse(timestampStr)
                    val zoneOffset = zone.rules.getOffset(mealTimestamp)

                    // Record spans from 1 second before to the timestamp
                    val recordStart = mealTimestamp.minusSeconds(1)

                    records.add(
                        NutritionRecord(
                            startTime = recordStart,
                            startZoneOffset = zoneOffset,
                            endTime = mealTimestamp,
                            endZoneOffset = zoneOffset,
                            energy = Energy.calories(calories * 1000) // Energy.calories expects small calories
                        )
                    )
                }

                if (records.isNotEmpty()) {
                    client.insertRecords(records)
                }

                callbackContext.success(JSONObject().put("written", records.size))
            } catch (e: Exception) {
                callbackContext.error("Failed to write nutrition: ${e.message}")
            }
        }
    }
}

class HealthConnectPermissionActivity : android.app.Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        finish()
    }
}

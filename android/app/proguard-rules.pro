# Preserve Capacitor plugins and annotations
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve Tournixo native bridge classes
-keep class com.tournixo.app.** { *; }

# Preserve OneSignal SDK classes
-keep class com.onesignal.** { *; }
-dontwarn com.onesignal.**

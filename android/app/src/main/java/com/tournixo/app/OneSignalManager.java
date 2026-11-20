package com.tournixo.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.onesignal.Continue;
import com.onesignal.OneSignal;
import com.onesignal.debug.LogLevel;
import com.onesignal.notifications.INotificationClickEvent;
import com.onesignal.notifications.INotificationClickListener;
import com.onesignal.notifications.INotificationLifecycleListener;
import com.onesignal.notifications.INotificationWillDisplayEvent;
import java.lang.ref.WeakReference;
import org.json.JSONException;
import org.json.JSONObject;

public final class OneSignalManager {

    private static volatile boolean sInitialized = false;
    private static volatile boolean sWebReady = false;
    private static JSONObject sPendingClickPayload = null;
    private static WeakReference<WebView> sWebViewRef = new WeakReference<>(null);
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());

    private OneSignalManager() {}

    public static synchronized void init(@NonNull Context context, @Nullable String appId) {
        if (sInitialized) return;
        if (TextUtils.isEmpty(appId) || appId.contains("YOUR_ONESIGNAL_APP_ID")) {
            return;
        }

        OneSignal.getDebug().setLogLevel(BuildConfig.DEBUG ? LogLevel.WARN : LogLevel.NONE);
        OneSignal.initWithContext(context.getApplicationContext(), appId.trim());

        OneSignal.getNotifications().addForegroundLifecycleListener(new INotificationLifecycleListener() {
            @Override
            public void onWillDisplay(@NonNull INotificationWillDisplayEvent event) {
                event.getNotification().display();
            }
        });

        OneSignal.getNotifications().addClickListener(new INotificationClickListener() {
            @Override
            public void onClick(@NonNull INotificationClickEvent event) {
                JSONObject data = event.getNotification().getAdditionalData();
                JSONObject payload = buildClickPayload(data);
                dispatchOrQueueClick(payload);
            }
        });

        sInitialized = true;
    }

    public static boolean isInitialized() {
        return sInitialized;
    }

    public static void attachWebView(@Nullable WebView webView) {
        sWebViewRef = new WeakReference<>(webView);
    }

    public static void setWebReady(boolean ready) {
        sWebReady = ready;
    }

    @NonNull
    private static JSONObject buildClickPayload(@Nullable JSONObject additionalData) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("clicked", true);
            if (additionalData != null) {
                payload.put("data", additionalData);
                if (additionalData.has("view")) {
                    payload.put("view", additionalData.optString("view", ""));
                }
                if (additionalData.has("tid")) {
                    payload.put("tid", additionalData.optString("tid", ""));
                } else if (additionalData.has("tournamentId")) {
                    payload.put("tid", additionalData.optString("tournamentId", ""));
                }
            }
        } catch (JSONException ignored) {}
        return payload;
    }

    private static void dispatchOrQueueClick(@NonNull JSONObject payload) {
        WebView webView = sWebViewRef.get();
        if (sWebReady && webView != null) {
            final String js = "if (typeof window.handleNotificationClick === 'function') { window.handleNotificationClick(" + payload.toString() + "); }";
            MAIN_HANDLER.post(() -> {
                WebView current = sWebViewRef.get();
                if (current != null) {
                    current.evaluateJavascript(js, null);
                } else {
                    synchronized (OneSignalManager.class) {
                        sPendingClickPayload = payload;
                    }
                }
            });
            return;
        }
        synchronized (OneSignalManager.class) {
            sPendingClickPayload = payload;
        }
    }

    @Nullable
    public static synchronized JSONObject consumePendingClick() {
        JSONObject pending = sPendingClickPayload;
        sPendingClickPayload = null;
        return pending;
    }

    public static boolean isSubscribed() {
        if (!sInitialized) return false;
        try {
            return OneSignal.getNotifications().getPermission()
                && OneSignal.getUser().getPushSubscription().getOptedIn();
        } catch (Exception e) {
            return false;
        }
    }

    public interface PermissionCallback {
        void onResult(boolean granted);
    }

    public static void requestPermission(@NonNull PermissionCallback callback) {
        if (!sInitialized) {
            callback.onResult(false);
            return;
        }
        try {
            OneSignal.getNotifications().requestPermission(true, Continue.with(result -> {
                boolean granted = result.isSuccess() && Boolean.TRUE.equals(result.getData());
                if (granted) {
                    try {
                        OneSignal.getUser().getPushSubscription().optIn();
                    } catch (Exception ignored) {}
                }
                callback.onResult(granted);
            }));
        } catch (Exception e) {
            callback.onResult(false);
        }
    }

    public static void optOut() {
        if (!sInitialized) return;
        try {
            OneSignal.getUser().getPushSubscription().optOut();
        } catch (Exception ignored) {}
    }

    public static void login(@Nullable String externalId) {
        if (!sInitialized || TextUtils.isEmpty(externalId)) return;
        try {
            OneSignal.login(externalId.trim());
        } catch (Exception ignored) {}
    }

    public static void logout() {
        if (!sInitialized) return;
        try {
            OneSignal.logout();
        } catch (Exception ignored) {}
    }

    public static void setTag(@Nullable String key, @Nullable String value) {
        if (!sInitialized || TextUtils.isEmpty(key)) return;
        try {
            OneSignal.getUser().addTag(key.trim(), value == null ? "" : value);
        } catch (Exception ignored) {}
    }
}

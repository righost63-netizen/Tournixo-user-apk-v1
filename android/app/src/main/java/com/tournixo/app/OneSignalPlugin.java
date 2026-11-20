package com.tournixo.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "OneSignalBridge")
public class OneSignalPlugin extends Plugin {

    @PluginMethod
    public void consumeNotificationClick(PluginCall call) {
        OneSignalManager.setWebReady(true);
        JSONObject pending = OneSignalManager.consumePendingClick();
        JSObject result = new JSObject();
        if (pending == null) {
            result.put("clicked", false);
            call.resolve(result);
            return;
        }
        Iterator<String> keys = pending.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                result.put(key, pending.get(key));
            } catch (JSONException ignored) {}
        }
        result.put("clicked", true);
        call.resolve(result);
    }

    @PluginMethod
    public void isSubscribed(PluginCall call) {
        JSObject result = new JSObject();
        result.put("subscribed", OneSignalManager.isSubscribed());
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        OneSignalManager.requestPermission(granted -> {
            JSObject result = new JSObject();
            result.put("granted", granted);
            result.put("subscribed", OneSignalManager.isSubscribed());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void optOut(PluginCall call) {
        OneSignalManager.optOut();
        call.resolve();
    }

    @PluginMethod
    public void login(PluginCall call) {
        String externalId = call.getString("externalId", "");
        OneSignalManager.login(externalId);
        call.resolve();
    }

    @PluginMethod
    public void logout(PluginCall call) {
        OneSignalManager.logout();
        call.resolve();
    }

    @PluginMethod
    public void setTag(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        OneSignalManager.setTag(key, value);
        call.resolve();
    }
}

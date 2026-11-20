package com.tournixo.app;

import android.app.Application;

public class TournixoApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        OneSignalManager.init(this, BuildConfig.ONESIGNAL_APP_ID);
    }
}

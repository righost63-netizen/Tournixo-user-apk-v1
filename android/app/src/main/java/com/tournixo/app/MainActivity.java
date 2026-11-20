package com.tournixo.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    private View errorOverlay;
    private long lastBackPressAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);

        // Register native Capacitor plugins before super.onCreate builds the Bridge
        registerPlugin(OneSignalPlugin.class);
        registerPlugin(ImageDownloaderPlugin.class);

        super.onCreate(savedInstanceState);

        configureSystemBars();
        setupNetworkErrorOverlay();
        configureWebView();
        setupBackNavigation();
    }

    private void configureSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getWindow().setStatusBarColor(Color.parseColor("#080808"));
        getWindow().setNavigationBarColor(Color.parseColor("#080808"));
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
    }

    private void configureWebView() {
        Bridge capBridge = getBridge();
        if (capBridge == null) return;

        WebView webView = capBridge.getWebView();
        if (webView == null) return;

        OneSignalManager.attachWebView(webView);
        webView.setBackgroundColor(Color.parseColor("#080808"));

        WebSettings settings = webView.getSettings();
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        capBridge.setWebViewClient(new TournixoWebViewClient(capBridge));
    }

    private void setupNetworkErrorOverlay() {
        ViewGroup root = findViewById(android.R.id.content);
        if (root == null) return;

        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(Color.parseColor("#080808"));
        overlay.setPadding(64, 64, 64, 64);
        overlay.setVisibility(View.GONE);
        overlay.setClickable(true);
        overlay.setFocusable(true);

        TextView title = new TextView(this);
        title.setText("Connection Problem");
        title.setTextColor(Color.WHITE);
        title.setTextSize(20f);
        title.setGravity(Gravity.CENTER);
        overlay.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Unable to load this screen. Please check your internet connection and try again.");
        subtitle.setTextColor(Color.parseColor("#B3FFFFFF"));
        subtitle.setTextSize(14f);
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        subLp.topMargin = 20;
        subLp.bottomMargin = 40;
        overlay.addView(subtitle, subLp);

        Button retryBtn = new Button(this);
        retryBtn.setText("Retry");
        retryBtn.setAllCaps(false);
        retryBtn.setTextColor(Color.parseColor("#0A0F00"));
        retryBtn.setBackgroundColor(Color.parseColor("#C7FF3E"));
        retryBtn.setPadding(64, 24, 64, 24);
        retryBtn.setOnClickListener(v -> {
            hideNetworkError();
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().reload();
            }
        });
        overlay.addView(retryBtn);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
        root.addView(overlay, lp);
        this.errorOverlay = overlay;
    }

    private void showNetworkError() {
        runOnUiThread(() -> {
            if (errorOverlay != null) {
                errorOverlay.setVisibility(View.VISIBLE);
            }
        });
    }

    private void hideNetworkError() {
        runOnUiThread(() -> {
            if (errorOverlay != null && errorOverlay.getVisibility() == View.VISIBLE) {
                errorOverlay.setVisibility(View.GONE);
            }
        });
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                long now = System.currentTimeMillis();
                if (now - lastBackPressAt < 2000L) {
                    finish();
                } else {
                    lastBackPressAt = now;
                    Toast.makeText(MainActivity.this, "Press back again to exit", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    public void onDestroy() {
        OneSignalManager.setWebReady(false);
        OneSignalManager.attachWebView(null);
        super.onDestroy();
    }

    private class TournixoWebViewClient extends BridgeWebViewClient {

        TournixoWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null || request.getUrl() == null) {
                return false;
            }
            Boolean handled = handleNavigationUri(request.getUrl());
            return handled != null ? handled : super.shouldOverrideUrlLoading(view, request);
        }

        @Deprecated
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url == null) return false;
            Boolean handled = handleNavigationUri(Uri.parse(url));
            return handled != null ? handled : super.shouldOverrideUrlLoading(view, url);
        }

        private Boolean handleNavigationUri(Uri uri) {
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "";
            String host = uri.getHost() != null ? uri.getHost().toLowerCase() : "";

            // Keep bundled local app pages inside the WebView
            if ("https".equals(scheme) && "localhost".equals(host)) {
                return false;
            }
            if ("data".equals(scheme) || "blob".equals(scheme)) {
                return false;
            }

            // Open UPI intents, WhatsApp, Telegram, mailto, tel, and external links outside the app
            if (
                "upi".equals(scheme) ||
                "mailto".equals(scheme) ||
                "tel".equals(scheme) ||
                "whatsapp".equals(scheme) ||
                "tg".equals(scheme) ||
                "intent".equals(scheme) ||
                "https".equals(scheme) ||
                "http".equals(scheme)
            ) {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    String msg = "upi".equals(scheme)
                        ? "No UPI app installed on this device"
                        : "No app found to open this link";
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            return null;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            hideNetworkError();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request != null && request.isForMainFrame()) {
                showNetworkError();
            }
        }
    }
}

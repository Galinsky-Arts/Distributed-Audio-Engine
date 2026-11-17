package org.neophilism.dae;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

/** Test-only foreground Activity owning the WebView under test. */
public final class WebViewHostActivity extends Activity {
    WebView webView;
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        // A fresh CI emulator may still show the keyguard; the host requires real window focus.
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        setContentView(webView);
    }
    @Override protected void onDestroy() { if (webView != null) webView.destroy(); super.onDestroy(); }
}

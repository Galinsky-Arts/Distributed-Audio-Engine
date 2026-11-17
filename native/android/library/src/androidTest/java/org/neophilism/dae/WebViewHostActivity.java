package org.neophilism.dae;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

/** Test-only foreground Activity owning the WebView under test. */
public final class WebViewHostActivity extends Activity {
    WebView webView;
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        setContentView(webView);
    }
    @Override protected void onDestroy() { if (webView != null) webView.destroy(); super.onDestroy(); }
}

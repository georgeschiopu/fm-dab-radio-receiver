package com.georgeschiopu.sdrmobile;

import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // While the app is showing the remote SDR server, the hardware back button
    // returns to the local settings shell instead of exiting, so the server
    // address can be changed. ?settings=1 tells the shell to show the form.
    @Override
    public void onBackPressed() {
        WebView webView = bridge.getWebView();
        String url = webView != null ? webView.getUrl() : null;
        String appUrl = bridge.getAppUrl();
        if (url != null && appUrl != null && !url.startsWith(appUrl)) {
            String base = appUrl.endsWith("/") ? appUrl : appUrl + "/";
            webView.loadUrl(base + "?settings=1");
            return;
        }
        super.onBackPressed();
    }
}

package cn.xuzf.tlg;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

/**
 * 极简外壳：用 WebView 承载 web/ 下的前端。
 *
 * 关键点：
 *  1. getUserMedia 要求「安全上下文」，直接用 file:///android_asset/ 不可靠，
 *     因此用 androidx.webkit 的 WebViewAssetLoader 把 assets 映射成
 *     https://appassets.androidplatform.net/ 这个安全源。
 *  2. WebView 的相机授权走 WebChromeClient#onPermissionRequest，
 *     必须在应用已获得 CAMERA 权限后主动 grant。
 *  3. FLAG_KEEP_SCREEN_ON：跑步过程中屏幕常亮。
 */
public class MainActivity extends Activity {

    private static final int REQ_CAMERA = 1001;
    private static final String APP_URL =
            "https://appassets.androidplatform.net/assets/index.html";

    private WebView web;

    /**
     * 暴露给网页的方向开关：landscape / portrait / auto。
     * 只改屏幕方向，不做别的 —— 网页里识别逻辑仍按画面实际比例自动适配。
     */
    private class OrientationBridge {
        @android.webkit.JavascriptInterface
        public void setOrientation(final String mode) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if ("landscape".equals(mode)) {
                        setRequestedOrientation(
                                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    } else if ("portrait".equals(mode)) {
                        setRequestedOrientation(
                                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                    } else {
                        setRequestedOrientation(
                                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
                    }
                }
            });
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        setContentView(web);

        // 让前端可以主动把整个应用转成横屏/竖屏。
        // 意义：系统的"自动旋转"开关常常是关着的，那就只有网页布局变、屏幕不转，
        // 使用者会觉得"切了横屏没用"。这里由应用自己控制，不依赖系统开关。
        web.addJavascriptInterface(new OrientationBridge(), "TLGAndroid");

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 设置项要写 localStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // 单页应用，不跳出
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 本应用只用到相机；其余权限一律拒绝
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    boolean needCamera = false;
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                            needCamera = true;
                        }
                    }
                    if (needCamera && hasCameraPermission()) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        return;
                    }
                    request.deny();
                } else {
                    request.deny();
                }
            }
        });

        if (!hasCameraPermission()) {
            requestCamera();
        } else {
            web.loadUrl(APP_URL);
        }
    }

    private boolean hasCameraPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestCamera() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode,
                                           String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA) {
            boolean ok = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (!ok) {
                Toast.makeText(this, "需要相机权限才能识别跑道，请在系统设置中开启。",
                        Toast.LENGTH_LONG).show();
            }
            web.loadUrl(APP_URL);
        }
    }

    @SuppressLint("MissingSuperCall")
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            finishAffinity();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

package app.plusultra.puppet

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * Pip lives here.
 *
 * The whole web app is bundled in `assets/www` and served to the WebView through
 * [WebViewAssetLoader] on `https://appassets.androidplatform.net`, which is a *secure
 * origin* — that is what lets the puppet use the microphone (hold-to-talk + wake word)
 * and the on-device presence camera, both of which browsers refuse on plain `file://`.
 *
 * Build: open the `android/` folder in Android Studio and press Run, or
 *        `cd android && ./gradlew assembleDebug` (needs the Android SDK).
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // Pip's localStorage notebook
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false   // he may speak unprompted
            allowFileAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }

        // Keep every request inside the bundled assets (plus the free AI gateways
        // the page itself calls over https).
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        // Microphone + camera: the page asks, we grant — the OS permission prompt has
        // already been shown below.
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        // Ask once, up front, for the three things Pip can use. Declining is fine:
        // the web app degrades to keyboard + tap and says so politely.
        requestPermissions(
            arrayOf(
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.CAMERA,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ),
            7101,
        )
    }

    override fun onBackPressed() {
        @Suppress("DEPRECATION")
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
        // Never listen or watch while the phone is in a pocket.
        web.evaluateJavascript("window.__PIP_TEST__ = window.__PIP_TEST__; try { window.__pip && window.__pip.shutdown && 0 } catch (e) {} window.dispatchEvent(new Event('pip:app-paused'));", null)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.evaluateJavascript("window.dispatchEvent(new Event('pip:app-resumed'));", null)
    }
}

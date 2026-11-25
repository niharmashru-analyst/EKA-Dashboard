# CORMATE production build intentionally keeps WebView bridge methods.
-keepclassmembers class com.renee.analytics.MainActivity {
    @android.webkit.JavascriptInterface <methods>;
}

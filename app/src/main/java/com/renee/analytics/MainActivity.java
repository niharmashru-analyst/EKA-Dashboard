package com.renee.analytics;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;


import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import android.util.Base64;

public class MainActivity extends Activity {

    private static final String APP_URL = "https://eka-ughi.onrender.com/entry";
    private static final String APP_UA_MARKER = " CormateApp/1.1";
    private static final String APP_HOST = "eka-ughi.onrender.com";
    private static final int STORAGE_PERMISSION_REQUEST = 4101;
    private static final int CAMERA_PERMISSION_REQUEST = 4102;
    private static final int FILE_CHOOSER_REQUEST = 4103;

    // camera for the in-page barcode scanner (getUserMedia) and for "take a photo" (<input type=file capture>)
    private PermissionRequest pendingWebPermission;
    private ValueCallback<Uri[]> fileChooserCallback;
    private WebChromeClient.FileChooserParams pendingChooserParams;
    private Uri cameraPhotoUri;

    private WebView webView;
    private View splashView;
    private View offlineView;
    private FrameLayout rootContainer;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();

    private String pendingLegacyPdfName;
    private byte[] pendingLegacyPdfBytes;

    private final ByteArrayOutputStream pdfBuffer = new ByteArrayOutputStream();
    private String pdfFileName;
    private String pdfRemainder = "";
    private boolean pdfInProgress = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.rgb(8, 8, 8));
        getWindow().setNavigationBarColor(Color.rgb(8, 8, 8));
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // the screen must not sleep while counting stock

        setupWebView();
        showSplash();
        loadApp();
    }

    private void showSplash() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.rgb(8, 8, 8));
        root.setPadding(32, 32, 32, 32);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.cormate_logo);
        logo.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        root.addView(logo, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        ProgressBar progress = new ProgressBar(this);
        progress.setIndeterminate(true);
        root.addView(progress, new LinearLayout.LayoutParams(48, 48));

        TextView loading = new TextView(this);
        loading.setText(getString(R.string.loading_workspace));
        loading.setTextColor(Color.rgb(190, 190, 196));
        loading.setTextSize(13);
        loading.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 18;
        root.addView(loading, lp);

        splashView = root;
        rootContainer.addView(splashView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splashView.bringToFront();
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void setupWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(8, 8, 8));
        webView.setVisibility(View.INVISIBLE);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);          // the page never needs file:// access
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + APP_UA_MARKER);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new CormateBridge(), "CormatePDF");
        webView.addJavascriptInterface(new AndroidPdfBridge(), "Android");
        webView.addJavascriptInterface(new AppBridge(), "CormateApp");
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());
        webView.setDownloadListener(new AppDownloadListener());

        rootContainer = new FrameLayout(this);
        rootContainer.setBackgroundColor(Color.rgb(8, 8, 8));
        rootContainer.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootContainer);
    }

    /** Gives the page the camera: live scanner (getUserMedia) and photo capture through <input type="file">. */
    private class AppChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                String host = request.getOrigin() == null ? "" : request.getOrigin().getHost();
                if (host == null || !(host.equals(APP_HOST) || host.endsWith("." + APP_HOST))) { request.deny(); return; }
                boolean wantsCamera = false;
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
                }
                if (!wantsCamera) { request.deny(); return; }   // microphone etc. are not needed
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    if (pendingWebPermission != null) pendingWebPermission.deny();
                    pendingWebPermission = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingWebPermission == request) pendingWebPermission = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            pendingChooserParams = params;
            boolean camera = params != null && (params.isCaptureEnabled() || acceptsImages(params));
            if (camera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
                return true;                                     // launched after the user answers the permission prompt
            }
            return launchFileChooser();
        }
    }

    private boolean acceptsImages(WebChromeClient.FileChooserParams params) {
        String[] types = params.getAcceptTypes();
        if (types == null) return false;
        for (String t : types) if (t != null && t.startsWith("image")) return true;
        return false;
    }

    private boolean launchFileChooser() {
        WebChromeClient.FileChooserParams params = pendingChooserParams;
        try {
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("image/*");
            Intent chooser = new Intent(Intent.ACTION_CHOOSER);
            chooser.putExtra(Intent.EXTRA_INTENT, pick);
            chooser.putExtra(Intent.EXTRA_TITLE, "Take a photo or choose one");
            cameraPhotoUri = null;
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                File dir = new File(getCacheDir(), "camera");
                if (!dir.exists()) dir.mkdirs();
                File photo = File.createTempFile("scan_", ".jpg", dir);
                cameraPhotoUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photo);
                Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri);
                cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (params != null && params.isCaptureEnabled()) {
                    startActivityForResult(cam, FILE_CHOOSER_REQUEST);          // page asked for the camera directly
                    return true;
                }
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
            }
            startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
            return true;
        } catch (Exception e) {
            if (fileChooserCallback != null) { fileChooserCallback.onReceiveValue(null); fileChooserCallback = null; }
            Toast.makeText(this, "Could not open the camera.", Toast.LENGTH_LONG).show();
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getData() != null) result = new Uri[]{data.getData()};   // picked from gallery / files
            else if (cameraPhotoUri != null) result = new Uri[]{cameraPhotoUri};              // photo from the camera
        }
        fileChooserCallback.onReceiveValue(result);
        fileChooserCallback = null;
        cameraPhotoUri = null;
    }

    private void loadApp() {
        if (!isNetworkAvailable()) {
            showOfflineIfNeeded(true);
            return;
        }
        showOfflineIfNeeded(false);
        webView.loadUrl(APP_URL);
    }

    private void showOfflineIfNeeded(boolean show) {
        if (rootContainer == null) return;
        if (!show) {
            if (offlineView != null) {
                rootContainer.removeView(offlineView);
                offlineView = null;
            }
            webView.setVisibility(View.VISIBLE);
            return;
        }

        webView.setVisibility(View.INVISIBLE);
        if (offlineView != null) {
            offlineView.bringToFront();
            return;
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.rgb(8, 8, 8));
        root.setPadding(36, 36, 36, 36);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.cormate_logo);
        logo.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        root.addView(logo, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 220));

        TextView title = new TextView(this);
        title.setText(R.string.offline_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        TextView message = new TextView(this);
        message.setText(R.string.offline_message);
        message.setTextColor(Color.rgb(170, 170, 178));
        message.setTextSize(14);
        message.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mlp.topMargin = 10;
        root.addView(message, mlp);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setTextColor(Color.WHITE);
        retry.setOnClickListener(v -> loadApp());
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(220, 56);
        blp.topMargin = 24;
        root.addView(retry, blp);

        offlineView = root;
        rootContainer.addView(offlineView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        offlineView.bringToFront();
    }

    private boolean isNetworkAvailable() {
        android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        android.net.Network network = cm.getActiveNetwork();
        if (network == null) return false;
        android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        return caps != null && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void hideSplash() {
        if (splashView != null) {
            View oldSplash = splashView;
            splashView = null;
            oldSplash.animate()
                    .alpha(0f)
                    .setDuration(180)
                    .withEndAction(() -> rootContainer.removeView(oldSplash))
                    .start();
        }
        if (webView != null) webView.setVisibility(View.VISIBLE);
    }

    private String safeFileName(String input) {
        String name = input == null ? "CORMATE_Report.pdf" : input.trim();
        if (name.isEmpty()) name = "CORMATE_Report.pdf";
        try {
            name = URLDecoder.decode(name, StandardCharsets.UTF_8.name());
        } catch (Exception ignored) { }
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_");
        if (!name.toLowerCase(Locale.ROOT).endsWith(".pdf")) name += ".pdf";
        return name;
    }

    private void savePdfToDownloads(String requestedName, byte[] bytes) {
        final String fileName = safeFileName(requestedName);
        ioExecutor.execute(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    android.content.ContentValues values = new android.content.ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/pdf");
                    values.put(MediaStore.Downloads.IS_PENDING, 1);

                    Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                    Uri uri = getContentResolver().insert(collection, values);
                    if (uri == null) throw new IllegalStateException("Could not create Downloads file");

                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new IllegalStateException("Could not open Downloads file");
                        out.write(bytes);
                        out.flush();
                    }

                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(uri, values, null, null);
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            != PackageManager.PERMISSION_GRANTED) {
                        pendingLegacyPdfName = fileName;
                        pendingLegacyPdfBytes = bytes;
                        runOnUiThread(() -> requestPermissions(
                                new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                                STORAGE_PERMISSION_REQUEST));
                        return;
                    }
                    File downloads = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    if (!downloads.exists() && !downloads.mkdirs()) {
                        throw new IllegalStateException("Could not create Downloads folder");
                    }
                    File target = new File(downloads, fileName);
                    try (FileOutputStream out = new FileOutputStream(target)) {
                        out.write(bytes);
                        out.flush();
                    }
                }

                runOnUiThread(() -> Toast.makeText(this,
                        "PDF saved to Downloads: " + fileName,
                        Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this,
                        "PDF download failed: " + e.getMessage(),
                        Toast.LENGTH_LONG).show());
            }
        });
    }

    private void resetPdfBuffer() {
        pdfBuffer.reset();
        pdfRemainder = "";
        pdfFileName = null;
        pdfInProgress = false;
    }

    private void appendBase64Chunk(String chunk) {
        if (chunk == null) return;
        String combined = pdfRemainder + chunk.replaceAll("\\s+", "");
        int usable = combined.length() - (combined.length() % 4);
        if (usable > 0) {
            String decodable = combined.substring(0, usable);
            byte[] decoded = Base64.decode(decodable, Base64.DEFAULT);
            pdfBuffer.write(decoded, 0, decoded.length);
        }
        pdfRemainder = combined.substring(usable);
    }

    private void finishPdfTransfer() {
        if (!pdfInProgress) return;
        try {
            if (!pdfRemainder.isEmpty()) {
                byte[] decoded = Base64.decode(pdfRemainder, Base64.DEFAULT);
                pdfBuffer.write(decoded, 0, decoded.length);
            }
            byte[] bytes = pdfBuffer.toByteArray();
            String name = pdfFileName;
            resetPdfBuffer();
            if (bytes.length == 0) throw new IllegalStateException("PDF data was empty");
            savePdfToDownloads(name, bytes);
        } catch (Exception e) {
            resetPdfBuffer();
            runOnUiThread(() -> Toast.makeText(this,
                    "PDF download failed: " + e.getMessage(),
                    Toast.LENGTH_LONG).show());
        }
    }

    private class AppBridge {
        @JavascriptInterface
        public String getVersionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "1.0.0";
            }
        }

        @JavascriptInterface
        public int getVersionCode() {
            try {
                android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return (int) info.getLongVersionCode();
                return info.versionCode;
            } catch (Exception e) {
                return 1;
            }
        }
    }

    private class CormateBridge {
        @JavascriptInterface
        public synchronized void beginPdfDownload(String filename, int totalChunks) {
            resetPdfBuffer();
            pdfFileName = safeFileName(filename);
            pdfInProgress = true;
        }

        @JavascriptInterface
        public synchronized void appendPdfChunk(String base64Chunk) {
            if (!pdfInProgress) return;
            appendBase64Chunk(base64Chunk);
        }

        @JavascriptInterface
        public synchronized boolean finishPdfDownload() {
            if (!pdfInProgress) return false;
            finishPdfTransfer();
            return true;
        }

        @JavascriptInterface
        public void savePdf(String filename, String base64Pdf) {
            try {
                byte[] bytes = Base64.decode(base64Pdf, Base64.DEFAULT);
                savePdfToDownloads(filename, bytes);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "PDF download failed: " + e.getMessage(),
                        Toast.LENGTH_LONG).show());
            }
        }
    }

    // Compatibility bridge for the website's native CORMATE PDF API.
    // The website calls window.Android.beginPdf/appendPdfChunk/finishPdf.
    // Keep this bridge aligned with that contract so the PDF never falls back
    // to a blob: URL, which Android DownloadManager cannot download.
    private class AndroidPdfBridge {
        @JavascriptInterface
        public synchronized void beginPdf(String filename) {
            resetPdfBuffer();
            pdfFileName = safeFileName(filename);
            pdfInProgress = true;
        }

        @JavascriptInterface
        public synchronized void appendPdfChunk(String base64Chunk) {
            if (!pdfInProgress) return;
            appendBase64Chunk(base64Chunk);
        }

        @JavascriptInterface
        public synchronized boolean finishPdf() {
            if (!pdfInProgress) return false;
            finishPdfTransfer();
            return true;
        }
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (scheme == null) return false;
            if (scheme.equals("http") || scheme.equals("https")) {
                String host = uri.getHost();
                if (host == null || host.equals(APP_HOST) || host.endsWith("." + APP_HOST)) return false;   // our own site stays in the app
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) { }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            hideSplash();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request != null && request.isForMainFrame()) showOfflineIfNeeded(true);   // server unreachable / waking up: show Retry, not a blank page
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            super.onReceivedError(view, errorCode, description, failingUrl);
            if (!isNetworkAvailable()) showOfflineIfNeeded(true);
        }
    }

    private class AppDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimetype, long contentLength) {
            try {
                String fileName = extractFileName(contentDisposition, url);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimetype == null || mimetype.isEmpty()
                        ? "application/octet-stream" : mimetype);
                request.addRequestHeader("User-Agent", userAgent);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) request.addRequestHeader("Cookie", cookie);
                request.setTitle(fileName);
                request.setDescription("Downloading from CORMATE");
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (manager != null) {
                    manager.enqueue(request);
                    Toast.makeText(MainActivity.this,
                            "Download started: " + fileName,
                            Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                Toast.makeText(MainActivity.this,
                        "Download failed: " + e.getMessage(),
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    private String extractFileName(String contentDisposition, String url) {
        String name = null;
        if (contentDisposition != null) {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("filename\\s*=\\s*(?:\\\"([^\\\"]+)\\\"|([^;]+))",
                            java.util.regex.Pattern.CASE_INSENSITIVE)
                    .matcher(contentDisposition);
            if (m.find()) name = m.group(1) != null ? m.group(1) : m.group(2).trim();
        }
        if (name == null || name.isEmpty()) {
            try {
                String path = Uri.parse(url).getLastPathSegment();
                if (path != null) name = path;
            } catch (Exception ignored) { }
        }
        if (name == null || name.isEmpty()) {
            name = "CORMATE_Download_" +
                    new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        }
        return safeFileName(name);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingWebPermission != null) {                       // live scanner was waiting
                if (ok) pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); else pendingWebPermission.deny();
                pendingWebPermission = null;
            }
            if (fileChooserCallback != null) {                        // photo capture was waiting
                if (ok) launchFileChooser(); else { fileChooserCallback.onReceiveValue(null); fileChooserCallback = null; }
            }
            if (!ok) Toast.makeText(this, "Camera permission is needed to scan barcodes. You can allow it in Settings > Apps > CORMATE > Permissions.", Toast.LENGTH_LONG).show();
            return;
        }
        if (requestCode == STORAGE_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED
                    && pendingLegacyPdfBytes != null) {
                byte[] bytes = pendingLegacyPdfBytes;
                String name = pendingLegacyPdfName;
                pendingLegacyPdfBytes = null;
                pendingLegacyPdfName = null;
                savePdfToDownloads(name, bytes);
            } else {
                pendingLegacyPdfBytes = null;
                pendingLegacyPdfName = null;
                Toast.makeText(this,
                        "Storage permission is required to save the PDF.",
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("CormatePDF");
            webView.removeJavascriptInterface("Android");
            webView.removeJavascriptInterface("CormateApp");
            webView.stopLoading();
            webView.destroy();
        }
        ioExecutor.shutdownNow();
        super.onDestroy();
    }
}

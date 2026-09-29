# CORMATE Mobile PDF Download Fix

The Field Entry PDF buttons now support a native CORMATE Android bridge. In the CORMATE app, the generated PDF is streamed in small chunks to the native Android layer and saved to the device's **Downloads** folder. This avoids the Android WebView `blob:`/`doc.save()` download limitation.

For normal mobile/desktop browsers, the existing direct PDF download remains available, with a mobile Share/Save fallback.

## Required for the native app

Build the companion Android source in `CORMATE_Android_PDF_Download_Fix.zip` and replace the APK served at:
`static/downloads/EKA-Analytics-Android.apk`

The website and Android bridge must be updated together.

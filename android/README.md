# Pip, natively (Android WebView shell)

The web app is the whole product — this folder just wraps it so Pip can live on a phone
home screen with a real icon, a real back button, and a **secure origin** so the microphone
and camera actually work.

```
android/
├── app/src/main/java/app/plusultra/puppet/MainActivity.kt   the whole shell (~90 lines)
├── app/src/main/AndroidManifest.xml                          permissions
├── app/build.gradle.kts                                      bundles the web app into assets/www
└── app/src/main/res/                                         icon + theme
```

## Build it

```bash
cd android
gradle wrapper --gradle-version 8.7     # once, if you don't have the wrapper
./gradlew assembleDebug                 # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open the `android/` folder in Android Studio and press **Run**. Requires the Android SDK
(compileSdk 34) and JDK 17. The first build downloads Gradle + AndroidX Webkit.

## Why a WebView and not plain "Add to Home screen"?

| | PWA on the phone | This shell |
|---|---|---|
| Microphone / camera | needs **https** (a localhost page won't do) | ✅ `https://appassets.androidplatform.net` is a secure origin |
| Works offline | needs the service worker to have cached everything | ✅ assets ship inside the APK |
| Back button, portrait lock, no browser chrome | ✗ | ✅ |
| Updates | automatic | re-run `./gradlew installDebug` |

`MainActivity` also forwards lifecycle events (`pip:app-paused` / `pip:app-resumed`) so the
camera is released while the phone is in a pocket.

## No Android SDK handy?

Use the PWA: serve the repo over any https URL (or `npm run dev` + a tunnel), open it on the
phone, and *Add to Home screen*. Everything except camera/mic works over plain HTTP on the
LAN; those two need https or this shell.

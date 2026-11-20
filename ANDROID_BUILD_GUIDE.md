# Tournixo Android APK Build & Signing Guide

## 1. Prerequisites
- **JDK 17** (bundled with Android Studio Hedgehog / Jellyfish / Koala / Ladybug)
- **Android Studio** with **Android SDK 34** (`compileSdk 34`, `targetSdk 34`, `minSdk 23`)
- **Node.js 18+** and **npm**

---

## 2. Configure Your OneSignal App ID
1. Open `android/gradle.properties` and replace `[YOUR_ONESIGNAL_APP_ID]` with your actual OneSignal App ID:
   ```properties
   ONESIGNAL_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
   *(Or pass `-PONESIGNAL_APP_ID=your-id` / set `ONESIGNAL_APP_ID` in your environment before running Gradle.)*
2. Do **not** add any OneSignal REST API key anywhere in the Android project.

---

## 3. Sync Web Assets & Open in Android Studio
1. Install Node dependencies and bundle all web files into `android/app/src/main/assets/public/`:
   ```bash
   npm install
   npm run build
   ```
2. Open the `android/` folder in **Android Studio** (`File -> Open -> select android/`).
3. Wait for Gradle Sync to finish.

---

## 4. Build Debug APK (Installable Directly on Phone)
From Android Studio (**Build -> Build Bundle(s) / APK(s) -> Build APK(s)**) or via terminal inside `android/`:

```bash
cd android
gradle assembleDebug
```
*(Or `./gradlew assembleDebug` if you generate the Gradle wrapper JAR via `gradle wrapper` in Android Studio.)*

Then copy the signed debug APK to `src/Tournixo-debug.apk`:
```bash
mkdir -p ../src
cp app/build/outputs/apk/debug/app-debug.apk ../src/Tournixo-debug.apk
```
The debug build is automatically signed with the Android debug keystore so it installs directly on your phone (`adb install src/Tournixo-debug.apk` or tap the APK file on your phone).

---

## 5. Build Release APK (Keystore + Signing)
1. **Generate a release keystore** (keep this file and passwords safe; never commit them):
   ```bash
   keytool -genkey -v -keystore android/tournixo-release.keystore \
     -alias tournixo -keyalg RSA -keysize 2048 -validity 10000
   ```
2. **Create `android/keystore.properties`** (copy from `android/keystore.properties.example`):
   ```properties
   storeFile=tournixo-release.keystore
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=tournixo
   keyPassword=YOUR_KEY_PASSWORD
   ```
3. **Build the signed release APK**:
   ```bash
   cd android
   gradle assembleRelease
   ```
   Output APK: `android/app/build/outputs/apk/release/app-release.apk`
   *(For Google Play Store uploads, run `gradle bundleRelease` to generate `app-release.aab`.)*

---

## 6. Firebase Authorized Domains Note
Capacitor serves your bundled web app inside the Android WebView at:
- **`https://localhost`** (origin `https://localhost`)

Check **Firebase Console -> Authentication -> Settings -> Authorized domains**:
- `localhost` is included by default in Firebase Authentication. Verify it is still present (do not remove it).
- Keep your existing web domains (`free-fire-ff37d.firebaseapp.com`, `free-fire-ff37d.web.app`, `t.tournixo.workers.dev`, and any Netlify domain you still use for web).
- If you later change `"hostname"` in `capacitor.config.json` to a custom domain (e.g. `app.tournixo.local`), you **must** add that exact hostname to Firebase Authorized Domains.

---

## 7. Features Not Supported / Platform Notes
1. **Binary APK Compilation Inside This Cloud Environment**: This workspace is a Node.js-only Linux container without JDK or the Android SDK, so `src/Tournixo-debug.apk` cannot be compiled here—follow Section 4 locally in Android Studio or CI.
2. **Browser PWA Install Prompt (`beforeinstallprompt`)**: In the APK WebView, `window.Capacitor` is active and Chrome's PWA install banner does not fire, so the Profile "Install App" row automatically stays hidden (which is intentional inside an already-installed APK).
3. **External UPI App Dependency**: `upi://pay?...` links launch installed UPI apps via Android `Intent.ACTION_VIEW`; if the device has no UPI app installed, a toast is shown and the user can still copy the Admin UPI ID or scan the Deposit QR code.
4. **Google Fonts / Firebase / Cloudinary Require Internet**: UI shell HTML/CSS/JS files are bundled inside the APK for instant loading without Netlify, while Firebase Auth, Firestore, Cloudinary photo uploads, and Google Fonts require active internet access (with `scripts/network.js` and `MainActivity` error handling when offline).

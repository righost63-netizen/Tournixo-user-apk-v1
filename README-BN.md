# Tournixo User Panel v8.12 — APK-READY (2026-11-20)

**এই zip = v8.11.1-এর 141 ফাইল + APK-র জন্য OneSignal বদল (139 ফাইল)।**
এটা Capacitor প্রজেক্টের `www/` ফোল্ডার হিসেবে বসানোর জন্য। Live website
(t.tournixo.workers.dev)-এ এটা বসিও না — ওখানে v8.11.1-ই থাকবে, যতদিন না
APK তৈরি। (এই build web-এ চলবে, কিন্তু web remote push আর থাকবে না —
push এখন শুধু APK-তে আসবে, এটাই সিদ্ধান্ত।)

**যাচাই করা:** JS 60/60 `node --check` PASS; web OneSignal কোডের কোনো
reference নেই (শুধু comment-এ নাম আছে); সব import/export মিলেছে
(initOneSignal, oneSignalLogin, oneSignalLogout, syncNotifToggleUI);
version 8.12 সব জায়গায়। **Live-tested না / APK-তে test করা হয়নি।**

## v8.11.1 থেকে কী বদলেছে (শুধু এই ৭টা জায়গা)

1. **`services/onesignal.service.js` — পুরো নতুন করে লেখা।** Web OneSignal
   SDK-র কোড সব তোলা। এখন শুধু native ব্রিজকে ডাকে
   (`window.Capacitor.Plugins.OneSignalBridge` → `OneSignalManager.java` →
   OneSignal Android SDK 5.9.2)। App ID এই ফাইলে নেই — native কোডে আছে।
   Login-এ `login({externalId: Firebase UID})`, logout-এ `logout()`,
   Profile toggle-এ আসল subscription দেখে ON/OFF হয় (fake-success নেই)।
2. **`config/onesignal-config.js` — মুছে দেওয়া হয়েছে** (পুরনো App ID +
   web SDK URL)। কোনো ফাইল এটাকে import করত না।
3. **`services/onesignal-native.js` — মুছে দেওয়া হয়েছে**
   (onesignal-cordova-plugin ব্রিজ — native প্রজেক্টে এই plugin নেই)।
4. **`sw.js` — OneSignal web worker `importScripts` লাইন তোলা।**
5. **`scripts/home.js` — login-এর পরের web push prompt
   (`maybePromptForPushOnce`) তোলা।** APK-তে permission native dialog-এ
   চাওয়া হয়।
6. **`scripts/app.js` — `/onesignal/i` error filter তোলা।**
7. **`netlify.toml` — CSP থেকে `onesignal.com` তোলা** (script/connect/
   frame/worker)।
8. **নতুন: notification tap routing** (`services/onesignal.service.js`-এ
   `routeNotificationClick` + `window.handleNotificationClick`)। Tap
   করলে শুধু Notifications পেজ না — `view`/`tid` দেখে যায়:
   `tournament`/`room` (+ tid) → Details পেজ; `wallet`/`matches`/
   `results`/`notifications` → সেই পেজ; কিছু না থাকলে Notifications।
   **নোট:** এখন native plugin শুধু `{clicked}` ফেরায়, তাই consume পথে
   আজ শুধু Notifications খুলবে; native যখন result-এ `view`/`tid`
   দেবে (OneSignalPlugin-এর বদল) তখন routing নিজে থেকেই চলবে। আর
   admin-কে push-এ `data: {view, tid}` দিতে হবে।

## APK বানাতে এই zip দিয়ে যা করতে হবে

1. v8.12 Capacitor প্রজেক্টের `www/` ফোল্ডার পুরো বদলে এই zip-এর ফাইলগুলো
   বসাও (zip root-ই `www/`)।
2. `npx cap sync android` (এটা `www/` → `android/app/src/main/assets/public/`-এ কপি করে)।
3. `android/app/google-services.json` রাখো — **এই ফাইল এই zip-এ নেই।**
   Firebase Console (প্রজেক্ট `free-fire-ff37d`) থেকে ডাউনলোড করো।
   Package name যেন App ID-র সাথে মেলে।
4. `./gradlew assembleDebug` (android/ ফোল্ডার থেকে, Java 21) বা GitHub
   Actions workflow (`build-capacitor-apk.yml`) — APK আসবে
   `android/app/build/outputs/apk/debug/app-debug.apk`।
5. OneSignal Dashboard-এ FCM service-account JSON আপলোড করো (প্রজেক্ট
   `free-fire-ff37d`-র key — তুমি যেটা পাঠিয়েছো সেটাই)। কোন App-এ
   আপলোড করবে (পুরনো `1d0c2af9` না নতুন `58ecb270`) — সিদ্ধান্ত এখনো
   বাকি; native কোডে এখন নতুন App ID (`58ecb270`) আছে।
6. Admin প্যানেল: OneSignal App ID + REST key নতুন App-এরটা করতে হবে
   (নতুন App রাখলে), আর push payload-এ `data: {view, tid}` যোগ করতে
   হবে — নাহলে tap-routing কাজ করবে না।

## এই zip-এ নেই (android/ প্রজেক্টের কাজ, আলাদা করতে হবে)

- `tournixo_high_priority` notification channel (IMPORTANCE_HIGH) —
  native-এ বানাতে হবে + admin payload-এ `android_channel_id` দিতে হবে।
- Portrait lock, কালো splash PNG (এখন সাদা Capacitor লোগো),
  `WRITE_EXTERNAL_STORAGE` (maxSdk 28), download-saved toast,
  বাইরের লিংক Custom Tabs-এ খোলা — সব android/ দিকের বদল।
- Application ID সিদ্ধান্ত: প্রজেক্টে এখন `com.tournixo.app`;
  `com.aistudio.tournixo.vqzmrt` চাইলে rename করতে হবে।

## ফোনে test (APK install-এর পর)

1. Profile footer-এ **v8.12** দেখায় কিনা।
2. Splash → Login → Home — আগের মতো (v8.11.1-এর look)।
3. FREE SOLO join → Details নিজেই update হয়; BACK-এ Joined badge।
4. Profile → Notifications toggle ON → OS permission sheet আসে →
   OneSignal Dashboard-এ subscription দেখায় → test push আসে।
5. Notification-এ tap → Notifications পেজ খোলে (view/tid routing
   পুরো চালু হলে Details পেজ খুলবে — native + admin বদলের পর)।
6. QR ডাউনলোড → Downloads-এ PNG সেভ হয়।
7. Room ID/Password Copy বাটন কাজ করে।

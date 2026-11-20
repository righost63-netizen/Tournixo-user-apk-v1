# Tournixo User Panel v8.8 — Deploy Guide (বাংলা)

**Live site: https://t.tournixo.workers.dev** (Cloudflare Workers — Netlify না)

## ⚠️ আগে এই একটা জিনিস — assetlinks SHA

`.well-known/assetlinks.json`-এ এখনো `REPLACE_WITH_YOUR_SHA256_CERT_FINGERPRINT`
লেখা আছে। **আমি কোনো fingerprint বানাইনি — বানানো যাবে না।**
তোমার keystore / Play Console থেকে আসল SHA-256 fingerprint নিয়ে ওই
জায়গাটা বদলাতে হবে। এটা না করলে Android app-link verification হবে না।

## Deploy — নম্বর অনুযায়ী করো

**১. Rules v19 publish করো (Firebase Console → Firestore → Rules)**
- `firestore-rules-v19-DEPLOY.txt` ফাইলটা পুরো কপি করে বসাও।
- আগে **Rules Playground-এ compile** করো, তারপর **Publish** — একবারই।
- v18 / v16 আলাদা করে publish করবে না। App আবার deploy লাগবে না।

**২. Index বানাও (Firebase Console → Firestore → Indexes)**
এই ৫টা index বানাতে হবে (একটাও না থাকলে Join / Wallet আটকাবে):
- tournamentTeams: `tournamentId` + `status`
- tournamentTeams: `tournamentId` + `captainUserId`
- depositRequests: `userId` + `status`
- withdrawalRequests: `userId` + `status`
- paymentRequests: `userId` + `paymentMethod` + `status`

**৩. File বদলাও**
- Zip-এর সব file দিয়ে আগের file-গুলো replace করো।
- ফোনে **সব PWA tab বন্ধ করো**, তারপর hard refresh / clear site data করো।
- Service worker cache এখন `tournixo-user-v8-8-2026-11-14` — পুরনো cache-এ
  থাকলে নতুন fix দেখাবে না।

**৪. OneSignal push test করো**
- ফোনে https://t.tournixo.workers.dev খুলে notification allow করো।
- OneSignal dashboard-এ subscription এসেছে কি না দেখো।
- Dashboard থেকে একটা test push পাঠাও।
- ⚠️ সত্যি কথা: এখান থেকে live push test করা যায়নি — ফোনে test করতেই হবে।

**৫. ফোনে এই test-গুলো করো**
- ১. Free SOLO join — slot বেছে Confirm (এখন আর "Registration শেষ হয়নি" আসবে না)
- ২. Paid wallet join — Deposit Balance থেকে টাকা কাটবে, instant confirmed
- ৩. DUO join — mate না বাছলে আটকাবে (আগে চুপচাপ প্রথম mate নিত)
- ৪. Verify email — Resend চাপলে mail না গেলে আসল কারণ দেখাবে
- ৫. Deposit form — settings ঠিক থাকলে খুলবে
- ৬. Results — "Rank Prize: ₹0" আর দেখাবে না, শুধু total দেখাবে

## এই build-এ যা ঠিক হলো (সংক্ষেপে)

- Rules v19 zip-এই আছে, v18 মুছে দেওয়া হয়েছে
- Slot cap SOLO 50 (আগে 48 ছিল)
- নতুন paid join শুধু wallet দিয়ে — পুরনো pending UPI আবেদন আগের মতোই
  admin confirm করতে পারবে, কিছু মোছা হয়নি
- Join error এখন modal-এর ভেতরে স্থায়ীভাবে দেখাবে, শুধু toast না
- Design কিছু বদলানো হয়নি (D1–D15 পরের build-এ)

## এখনো live test হয়নি

- Rules publish + live join retry
- Index বানানো (Console-এ করতে হবে)
- OneSignal live push
- assetlinks SHA (উপরের ⚠️ দেখো)

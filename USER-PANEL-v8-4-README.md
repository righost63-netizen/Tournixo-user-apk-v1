# TOURNIXO USER PANEL — v8.4 (FULL PANEL, 2026-11-11)

v8.2 final + v8.3 instant slot booking + deep-scan fixes — সম্পূর্ণ প্যানেল,
একটাই zip। আগের v8.3 ছিল changed-files-only; এটা FULL panel — সব file
এখানেই আছে, শুধু replace করলেই হবে।

## ⚠️ DEPLOY ORDER — এই order-ই মানতে হবে

1. **Rules v18 FIRST (Firebase Console → Firestore → Rules):**
   zip-এর `firestore-rules-v18-DEPLOY.txt` পুরোটা paste করে **Publish** করো।
   এতে v17-এর সব slot-booking rule-ও আছে — v17 আলাদা করে publish করতে
   হবে না। v18 ছাড়া free + paid instant join permission-denied-এ fail
   করবে (atomic — টাকা/slot কিছুই বদলাবে না, শুধু join হবে না)।
2. **Composite index (H5):** প্রথমবার slot picker খুললে Firestore
   console-এ index বানানোর link দেখাতে পারে — এক ক্লিকে বানিয়ে নাও।
   অথবা `firestore.indexes.json` (zip-এ আছে) Firebase CLI দিয়ে deploy
   করো: `firebase deploy --only firestore:indexes`। Index না থাকলে
   picker error দেখাবে, join বন্ধ থাকবে (fail-closed)।
3. **সব file replace করো** (Netlify Drop / deploy — পুরো zip-এর content)।
4. **সব PWA tab বন্ধ করে hard refresh** করো (SW cache v8.4)।

## FIXED — একটা একটা করে (spec অনুযায়ী)

### CRITICAL
- [FIXED: C1 — admin participants-free.js] — USER PANEL-এ কিছু বদলানো
  হয়নি; fix admin panel-এ করতে হবে (নিচে "ADMIN-SIDE বাকি" দেখো)।
- [FIXED: C2 — firestore.rules:601] — slot cap 48 → 50 (admin SOLO
  default 50-র সঙ্গে মিললো)। এখন slot 49/50 বুক হবে।
- [FIXED: C3 — firestore.rules:622, scripts/join-tournament.js:860,
  services/payment.service.js:821] — squat-heal এখন captain-mismatch-ও
  ধরে (lock.captainUserId != team.captainUserId হলে lock মৃত)। live
  teamId দিয়ে বসানো griefing lock আর slot আটকে রাখবে না।
- [FIXED: C4 — firestore.rules:267,275] — counterGuard default
  playersPerTeam teamFormat থেকে (SOLO 1 / DUO 2 / SQUAD 4)। পুরনো
  DUO/SQUAD টুর্নামেন্টে join আবার হবে।
- [FIXED: C5 — services/auth.service.js:75] — registeredUIDs doc-এ আর
  email লেখা হয় না ({userId, registeredAt} শুধু)। Roster-এর FF UID
  দিয়ে email লিক বন্ধ।

### HIGH
- [FIXED: H1 — scripts/results.js:49] — scoreboard gate এখন
  `published===true` OR `resultStatus in ['Completed','Distributed']`
  OR `results.length > 0`। BUILD 30-র result-এও scoreboard দেখাবে,
  পুরনো published doc-ও চলবে।
- [FIXED: H2 — scripts/results.js:106] — প্রতি row-এ
  `totalPrize = r.prizeAmount ?? r.totalPrize ?? (killReward+rankPrize)`।
  BUILD 30-র row-এ আর ₹0 দেখাবে না।
- [FIXED: H3 — services/tournaments.service.js:67-69,
  scripts/tournament-details.js:359,361] — normalizer এখন totalPrize /
  prizeInstructions / prizeType পাস করে; Details-এ Prize Instructions
  section দেখায়; `prizeType==='manual'` হলে "Per kill ₹0" লাইন লুকায়।
- [FIXED: H4 — firestore.rules (withdrawal/deposit read)] — দুটো read
  rule-এ `(resource == null || ...)` guard। Tracked request doc delete
  করলেও পরের deposit/withdrawal ভাঙবে না।
- [FIXED: H5 — services/slot.service.js:57, firestore.indexes.json,
  backfill-slot-locks.js] — teams query এখন `status in
  ['confirmed','pending']` + `limit(50)` (confirmed+pending মিলে
  maxTeams-এর বেশি হয় না, তাই কেউ কাটা পড়ে না)। Composite index
  (tournamentId + status) লাগবে। পুরনো confirmed team-দের lock backfill
  করতে `backfill-slot-locks.js` একবার চালাও (file-এ instruction আছে)।
- [FIXED: H6 — services/payment.service.js:756] — instant txn-এ capacity
  এখন `filled + pending >= maxTeams` (UI + free txn-এর মতোই)।
  Legacy UPI/wallet-pending flow-এর capacity check (লাইন 317/550)
  ইচ্ছা করে বদলানো হয়নি — ওগুলো seat নেয় না, admin confirm-এ আবার
  check হয়।
- [FIXED: H7 — services/slot.service.js (lock loop)] — lock-এর team
  map-এ না থাকলে (rejected/expired/deleted) slot ফাঁকা দেখায়, txn
  arbitrate করে। আর "Booked" চিরকাল দেখাবে না।
- [FIXED: H8 — scripts/join-tournament.js:243,316,348,
  scripts/tournament-details.js:252, scripts/wallet.js:228,277] —
  Captain label + Slot নম্বর এখন lime `var(--accent)`; wallet pending
  এখন muted `var(--text2)`। Gold শুধু prize figure-এ
  (tournament-details.js:278, results.js)।
- [FIXED: H9 — scripts/payment.js (loadPaymentPage try/catch)] —
  load fail করলে form লুকিয়ে `#pay-load-error` + Try Again দেখায়;
  retry-তে form আবার দেখায় (আগে retry চাপলেও form ফিরত না)।
- [FIXED: H10 — sw.js:9] — OneSignal `importScripts` try/catch-এ মোড়া।
  CDN down থাকলেও cache worker install হবে।

### MEDIUM
- [FIXED: M1 — scripts/join-tournament.js:624] — free txn-এ
  `isValidSlot(chosenSlot, maxTeams)` check (slot > maxTeams আর বুক
  হবে না)।
- [FIXED: M8 — scripts/matches.js:298,312,325] — cancelled টুর্নামেন্টে
  "Cancelled" badge + cancel banner, room note লুকানো।
- [FIXED: M9 — scripts/tournament-details.js:202,230] — "reschedule
  হবে" শুধু reschedule field থাকলে; না থাকলে "admin-এর সিদ্ধান্ত
  pending"। No-refund লাইনের gold → warning রঙ।
- [FIXED: M12 — scripts/join-tournament.js, scripts/payment.js] —
  join/payment-এর সব validation + error toast Bengali করা হয়েছে
  (যেমন "দলের নাম দাও", "টুর্নামেন্ট ভরে গেছে")।
- [FIXED: M13 — styles/theme.css:12] — `:root --accent` এখন `#C7FF3E`
  (lime); ৬টা dead token মুছে ফেলা হয়েছে (blue accent-grad, gold
  gradient/glow, accent-glow, shadow-accent, shadow-gold)। নতুন page-এ
  scope না থাকলেও আর সবুজ button হবে না।
- [FIXED: M16 — pages/payment.html, scripts/payment.js:167] —
  display:none payment-method section + `selectPayMethod` handler
  পুরো মুছে ফেলা হয়েছে (v8.3 থেকে paid join wallet-only)।
- [FIXED: M17 — scripts/join-tournament.js:175] — existing-team check
  fail করলে toast + return (fail-closed); form আর চুপচাপ খোলে না।

### LOW
- [FIXED: L1 — scripts/wallet.js:232,283] — দুটো status map-এ
  `completed: 'Completed'` + success color যোগ। Withdrawal-এ আর raw
  grey "completed" দেখাবে না।
- [FIXED: L8 — styles/components/skeleton-loader.css] — gradient
  shimmer বাদ; flat bg + opacity pulse (`skeleton-pulse`)।
- [FIXED: L11 — scripts/tournaments.js:414] — date/time না থাকলে "—"
  নয়, "Date TBD" / "Time TBD"।
- [FIXED: L13 — services/team.service.js:93] — SQUAD gate-এ name-ও
  বাধ্যতামূলক (UID-এর পাশাপাশি)।
- [FIXED: L14 — scripts/matches.js:366] — payment-deadline note শুধু
  legacy pending team-এ; instant-join team-এ deadline-র কথা দেখায় না।

### RULES-ONLY (এই zip-এর firestore.rules-এ করা হয়েছে — console-এ publish করতে হবে)
- [FIXED: L2 — firestore.rules] — teams / walletTransactions /
  playerReports / joinRequests read-এ `resource == null` guard।
- [FIXED: L3 — firestore.rules] — tournamentTeams create-এ
  `&& isNotBanned()` (shape veto আগের মতোই, শুধু ban check যোগ)।
- [FIXED: L4 — firestore.rules] — captain-lock + UID-lock create-এ
  `&& isNotBanned()`।
- [FIXED: L5 — firestore.rules] — UPI paymentRequests branch-এ
  `paymentMethod == 'upi'` বাঁধা।

## ADMIN-SIDE বাকি (এই zip-এ নেই — admin panel-এ করতে হবে)
- **C1-ADMIN:** admin `participants-free.js` kick txn-এ
  `transaction.delete(teamRef)` + `transaction.delete(tournamentSlots/{tid}_{slot})`
  যোগ করতে হবে — নইলে free kick-এ slot চিরকাল আটকে থাকবে।
- **M10-ADMIN:** admin `participants-paid.js` kick-এ একই txn-এ
  `depositBalance` credit করতে হবে, অথবা rejected paid player-কে
  "contact admin for refund" notice দেখাতে হবে।
- **M20-ADMIN:** admin `wallet.js:428` push title-এ raw SVG আছে —
  plain `'Withdrawal Completed'` করতে হবে।

## ছোঁয়া হয়নি (spec অনুযায়ী)
Instant ledger shape, double-debit prevention, UPI duplicate-UTR guard,
withdrawal cap, self-credit prevention, team doc PII exclusion,
insufficient-balance UX — সব আগের মতোই আছে।

## TEST CHECKLIST (deploy-এর পর ফোনে)
1. Free join: slot বেছে Confirm → সাথে সাথে Confirmed + slot lock।
2. Paid join: slot + Confirm → deposit কাটলো + wallet-এ `−₹fee` entry।
3. Slot 49/50 (SOLO 50): বুক হয় (C2)।
4. পুরনো DUO টুর্নামেন্টে join হয় (C4)।
5. Results page: BUILD 30 finalize-এর পর scoreboard + সঠিক prize (H1/H2)।
6. Details page: Prize Instructions দেখায়, manual-এ "Per kill" লাইন নেই (H3)।
7. Wallet: completed withdrawal সবুজ "Completed" (L1)।
8. Matches: cancelled টুর্নামেন্টে Cancel banner (M8)।
9. Payment page: offline-এ error + Try Again কাজ করে (H9)।
10. Double-click join: একটাই debit entry (আগের মতোই)।
11. Insufficient balance: hard block + Add Money (আগের মতোই)।

## VERIFY করা হয়েছে (এখানে — live Firebase test হয়নি)
- `node --check` clean 13/13 changed JS।
- Slot logic test: পুরনো 13 + নতুন fetchTakenSlots 8 — সব pass
  (confirmed+pending taken, rejected/unknown-team lock free, 100
  rejected + 20 confirmed churn-এ সব slot পাওয়া যায়)।
- Changed pages serve HTTP 200; rules brace/paren/bracket balance 0।
- SW cache `tournixo-user-v8-4-2026-11-11`।
- Live Firebase / ফোন test এখনো বাকি — উপরের checklist ফোনে চালিয়ে
  দেখো।

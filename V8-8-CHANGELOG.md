# Tournixo User Panel — v8.8 Production (2026-11-14)

Base: v8.7 full (134 files). This build fixes ALL 12 items from the 2026-11-14 scan
(security + app problems). Design items D1–D15 were NOT touched, except the
persistent inline error areas that items 5 and 12 explicitly required.
Locked direction unchanged: one lime #C7FF3E, dark neutrals, flat, no
gradients/glows/emoji, gold solid only on prize figures. Toasts stay Bengali.

## What was fixed (items 1–12)

1. **Rules v19 IN THE ZIP** — `firestore.rules` is a byte-identical copy of the
   delivered merged v19 file (`firestore-rules-v19-MERGED-DEPLOY.txt`).
   `firestore-rules-v18-DEPLOY.txt` DELETED so nobody pastes v18 by mistake.
   `firestore-rules-v19-DEPLOY.txt` is the paste file. Rules logic untouched.
   Publish v19 in Console (Playground compile first, then Publish once, never
   v18/v16 separately) — no app redeploy needed for rules. This is the fix for
   the slot-join `permission-denied` ("Registration শেষ হয়নি") error.
2. **Composite indexes** — `firestore.indexes.json` now has 5 indexes (was 1):
   tournamentTeams tournamentId+status (kept), tournamentTeams
   tournamentId+captainUserId (join modal + payment), depositRequests
   userId+status, withdrawalRequests userId+status, paymentRequests
   userId+paymentMethod+status. Console deploy step — see DEPLOY-v8-8-BN.md.
3. **Device ban** — verified, no logic weakened. `device-ban.js` reads a single
   `bannedDevices/{deviceId}` doc (no list) matching v19's block (get: anyone
   signed in, list: never, writes: admin only). Login-time `deviceIds`
   recording is allowed by v19's owner-update allow-lists. Only stale v18
   comments were updated. Live re-entry test is in the deploy checklist.
4. **Orphan slot lock** — verified both slot-lock writes already include
   `teamId` (free txn + instant-wallet txn); no teamId-less write path exists.
   New user-visible path: a teamId-less confirmed lock now shows as Booked in
   the picker (it used to look free, then the txn blocked it) with a Bengali
   stuck-slot note ("Slot X আটকে আছে — অ্যাডমিনকে জানাও") and a distinct
   `slot-stuck` error code. No user-side delete invented — admin-only.
   Rules squat-heal limit (teamId-less locks are admin-only) still applies.
5. **Verification email silent failure** — `sendEmailVerification` failure no
   longer shows register success. `registerUser()` returns
   `{ verificationEmailSent: false, verificationErrorCode }`; the Verify page
   shows a persistent Bengali error area (`#ve-send-error`) with the real cause
   (domain / rate-limit / network) + next steps (Spam check → Resend → tell
   admin). `continueUrl` is `https://t.tournixo.workers.dev/pages/login.html`
   in all 3 calls. Follows the surface_real_errors skill.
6. **Settings-doc guard** — new `checkDepositSettings()` in
   `settings.service.js`. If `settings/deposit` is missing, deposit/withdrawal
   requests throw a clear Bengali message and the forms block with a persistent
   message + disabled submit, instead of a permission-denied toast. Rules
   fail-closed behaviour untouched.
7. **DUO mate** — silent `mateIdx 0` default REMOVED in free and paid paths
   (including the pre-checked first radio). No mate selected = hard block with
   a Bengali message. `getMyTeam()` now throws typed `team-load-failed` on a
   read failure instead of returning null; all 7 call sites show a retry
   message instead of misrouting to "make a team". Genuinely-no-team still
   returns null → My Team gate unchanged.
8. **Slot cap** — SOLO default `maxTeams` 48 → 50 everywhere
   (`tournaments.service.js`, slot service comment, join-txn comment).
   Matches rules slot ≤ 50 and admin default 50. Legacy tournaments without
   `maxTeams` now show 50 slots. DUO 24 / SQUAD 12 unchanged.
9. **Results prize breakdown** — never shows "Rank Prize: ₹0 / Kill Reward:
   ₹0" when only a total `prizeAmount` exists. The split is computed only from
   real data (row `rankPrize`/`killReward` or `perKill`); otherwise only the
   total shows and the ₹0 lines (and the `(+₹0)` kills suffix) are hidden.
10. **OneSignal + new domain** — App ID unchanged
    `1d0c2af9-4033-4585-b1bd-198b02675a14`. `twa-manifest.json`: host, iconUrl,
    maskableIconUrl, webManifestUrl → `https://t.tournixo.workers.dev`,
    `appVersion` 8.8.0, `appVersionCode` 880. `sw.js` OneSignalSDKWorker import
    is the CDN importScripts (host-independent); `serviceWorkerPath: '/sw.js'`,
    scope `'/'` — origin-relative, no host assumption. `assetlinks.json`:
    placeholder left EXACTLY as-is — no SHA-256 was invented; pasting the real
    fingerprint from the keystore/Play Console is the one manual step (flagged
    in DEPLOY-v8-8-BN.md). `netlify.toml` kept; live site is Cloudflare
    Workers, not Netlify.
11. **Dual paid paths** — `submitPaidJoinRequest()` now hard-throws at the top:
    no NEW paid join can go through legacy UPI. New joins are instant
    wallet-only. OLD pending UPI requests stay visible with a Bengali status
    ("UPI পেমেন্টসহ জয়েনের আবেদন অ্যাডমিন যাচাইয়ের অপেক্ষায় আছে…") and are
    still admin-confirmable. No pending data deleted.
12. **Join error visibility** — hardcoded `'Registration শেষ হয়নি: '` prefix
    REMOVED (grep: 0). New `joinErrorMessage()` maps the real code:
    `permission-denied` → rules/index check + tell admin, `slot-taken` →
    pick another slot, `failed-precondition` → missing index, plus
    `slot-stuck` / `duplicate-ff-uid` / `unavailable` / `unauthenticated`.
    Shown PERSISTENTLY in a `#join-error` box inside the join modal (dismiss
    button, cleared on next attempt/modal open) plus the toast. `toast.js`
    mapper KEYS untouched — all still the English strings services throw
    (verified 26/26 with a lookup harness; see below).

## Not broken (verified after edits)

- Paid instant-join atomic debit + deterministic `debit_<teamId>` ledger.
- UTR duplicate guard (`trx_` + trim + uppercase).
- `registeredUIDs` no-email (C5 fix).
- DUO/SQUAD My Team gate.
- IN phone validation `^[6-9]\d{9}$`.
- Slot-picker CSS loads on all 5 Join pages (index, home, tournaments,
  tournament-details, payment).
- sw.js cache `tournixo-user-v8-8-2026-11-14`; version/footer strings v8.8
  (incl. profile footer, which still said v8.1).

## Verification (done by the coordinator, not just the builders)

- `node --check`: **56/56** JS files clean (scripts/ + services/ + utils/ +
  config/ + root JS).
- Local serve: **10/10** main pages return 200 (index, home, tournaments,
  tournament-details, payment, wallet, profile, my-team, results,
  verify-email).
- `diff firestore.rules` vs delivered v19 source: **IDENTICAL** (0 lines
  differ). 43 match blocks per the v19 delivery record.
- `firestore.indexes.json` + `manifest.json` + `twa-manifest.json`:
  `python -m json.tool` valid.
- `grep -rni netlify` in `*.js`/`*.html`/`*.json`: **0 live references** —
  only one explanatory comment (`services/onesignal.service.js:100`, noting
  the domain moved off Netlify) and historical docs (old changelogs,
  CAPACITOR.md, DEPLOY-ORDER-v8-1.txt, build-apk workflow, .gitignore,
  netlify.toml header).
- `continueUrl` workers.dev: **3/3** in `services/auth.service.js`.
- `grep 'Registration শেষ হয়নি'`: **0**. Silent mate default: **0**.
- Toast-mapper harness (`friendlyErrorMessage`, 26 cases incl. all
  permission/index/network/auth codes + exact-message keys + patterns):
  **26/26 passed**.
- No `firestore-rules-v18-DEPLOY.txt` remains in the zip.

## Notes / left as-is

- `teamPlayersForFormat()` (team.service.js) still lists `validMates[0]` as a
  DUO `players[1]` placeholder — verified harmless: no DUO join path consumes
  it (free and paid DUO build the roster from the explicitly chosen mate).
- Design items D1–D15 from the scan were NOT done in this build, by choice.
- The v8.7 scan's U14 (BD numbers blocked by IN-only validation) was NOT
  changed — IN-only is intentional for the West Bengal community.

## Still NOT live-tested

- Rules v19 publish + live free SOLO / paid wallet join retry.
- Composite indexes in Console (queries will fail-precondition until created).
- OneSignal push on workers.dev (dashboard Site URL already changed by Anik;
  phone allow + test push still needed — no live push test was possible here).
- assetlinks SHA-256 fingerprint (manual step, see deploy guide).
- No live Firebase / phone test was possible from the build environment.

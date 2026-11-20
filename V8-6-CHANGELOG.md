# Tournixo User Panel v8.6 — CHANGELOG (2026-11-13)

Full panel, production-ready, built on v8.5. Base: `tournixo-user-v8-5-full-2026-11-12.zip`.
Ordered by Anik 2026-11-13: U1 approved, U2 = option (a) free tournaments distribute
prizes per template, plus the rest as listed in the 2026-11-13 audit (room packet,
device ban, mobile number, verify page, Bengali toasts, no editing at join time).

**HARD RULES KEPT:** `firestore.rules` is byte-identical to v8.5 (verified by diff —
see Verification). No design/theme changes (locked: one lime #C7FF3E, gold solid
only on prize figures, dark neutrals, flat). No Cloud Functions, no new dependencies.
Every fix carries an in-code comment naming what changed and why.

## A. U1 — Per-kill line now shows (was never shown)
- `scripts/tournament-details.js:359-361` — the "Per kill ₹X" line was hidden when
  `prizeType === 'manual'`, but admin BUILD 31 writes `prizeType:'manual'` on EVERY
  tournament, so the line could never appear. Fixed: it now shows whenever
  `Number(t.perKill) > 0`, regardless of prizeType.
- Grep: `prizeType === 'manual'` now has **zero** hits in the whole tree — this was
  the only such gate.

## B. U2a (user side) — free-distribution amounts display correctly
- Verified in `scripts/results.js:106`: `prizeAmount` is authoritative whenever
  present, and the row renders it as the headline amount with "Prize credited"
  when `prizesDistributed === true`. There is no free/paid branch in the render
  path, so a free tournament with a real `prizeAmount > 0` (written by the admin
  free-distribution packet) shows the real amount with the same label as paid.
  No change made; paid display untouched.
- Cosmetic note (pre-existing, paid too): the row foot shows "Rank Prize: ₹0"
  when the admin writes only `prizeAmount` per row (no per-row `rankPrize` split)
  — the headline total is always correct. Kill Reward falls back to
  `kills × perKill` and shows correctly.

## C. Device ban in the USER app (NEW)
- NEW `services/device-ban.js` — `getOrCreateDeviceId()` (localStorage key
  `tournixo-device-id`, `crypto.randomUUID` with fallback), `isDeviceBanned()`
  (reads `bannedDevices/{deviceId}`), `recordDeviceId()` (best-effort
  `arrayUnion` on the user doc, never throws).
- `services/auth.service.js` — registration checks the device BEFORE creating
  the account (`:63-68`, throws `auth/device-banned`, no orphan account);
  login checks after sign-in (`:31-43`, signs out + throws); `deviceIds` is
  written into the create doc (`:93`).
- `scripts/app.js:346-355` — session restore checks the device right after
  `state.currentUser = user`, before any UI paint: banned device → Bengali
  message + sign out. Mirrors the existing account-ban branch (untouched).
- `scripts/auth-ui.js:113,213` — `auth/device-banned` mapped to Bengali.
- **Fail-open by design** (stated in code comments): any read error returns
  "not banned", so a missing rules block can never lock all users out.
- Rules finding: `deviceIds` on CREATE is allowed (users-create rule
  `firestore.rules:293-303` has no key allow-list). `bannedDevices` has NO
  rule at all in v18 — reads are denied until the merged rules step adds it,
  which is exactly why the check fails open.
- **OPEN:** login-time `deviceIds` recording is blocked by v18 — the
  owner-update allow-lists (`firestore.rules:320` and `:333`) do not include
  `deviceIds`, so `recordDeviceId()` at login is denied (silently swallowed,
  never breaks login) and self-activates once the merged rules add it.
  Practical effect: new accounts record their device at registration, but
  pre-existing accounts won't record a device at login until the merged rules
  land — so an admin ban of such a user covers only devices recorded at
  registration or later. Full device-ban enforcement waits on the merged
  rules `bannedDevices` read rule.

## D. Room-teammates packet folded in
- `scripts/matches.js` — the false note "Teammate হিসেবে Room ID/password
  captain-এর Matches-এ দেখা যায় (admin publish শুধু captain-কে allow করে)"
  is removed, plus the stale captain-only comment corrected. Applied from the
  delivered `user-panel-room-teammates-2026-11-13.zip`; post-apply diff of
  `matches.js` against the packet is IDENTICAL.
- Grep: the wrong-note text now has **zero** hits in the tree.
- `sw.js:27` — cache bumped to `tournixo-user-v8-6-2026-11-13`.

## E. Registration mobile number (NEW, required)
- `pages/register.html:61-67` — new REQUIRED field after FF UID, before Email:
  label `মোবাইল নম্বর`, `type="tel"`, placeholder `01XXXXXXXXX`.
- `scripts/auth-ui.js:159-164,180-183` — strips spaces/dashes, validates
  `/^01\d{9}$/` → Bengali error, no submit on invalid; passes `phone` to
  `registerUser`.
- `services/auth.service.js:54-66,103` — accepts `phone`, normalises and
  re-validates server-side (`auth/invalid-phone`, before `state.registering`
  is set), stores `phone` on the user doc at creation.
- Rules finding: **allowed, nothing OPEN** — the users-create rule has no key
  allow-list, so `phone` passes. (Note: the owner-update allow-list does not
  include `phone`, so a future "edit phone" feature would need a rules
  addition — creation is unaffected.)

## F. Verify-page behaviour (NEW — re-enabled)
- **What the code actually was:** verification was fully DISABLED
  (`app.js` skipped the check, `registerUser` never sent the mail). It is now
  re-enabled with the Verify page as the explicit exception.
- `services/auth.service.js` — `registerUser()` sends the verification mail
  after the profile commits, existing `continueUrl` unchanged
  (`https://tournixo.netlify.app/pages/login.html`); send failure only warns
  (Resend is the recovery); session is kept (no sign-out). New helpers
  `:213-248`: `PENDING_VERIFY_EMAIL_KEY = 'ff_pending_verify_email'` +
  `set/get/clearPendingVerifyEmail()` (localStorage), and
  `resendVerificationForCurrentUser()` (no password prompt, no sign-out).
- `scripts/auth-ui.js:200-209` — after register: persists pending email,
  Bengali flash toast, `goReplace('verify-email')` (no longer Home).
  `auth/email-already-in-use` (`:213-221`) shows the Verify page again.
- `scripts/app.js:333-352` — auth listener gates unverified users to the
  Verify page (before any user-doc listener / Home routing); exceptions are
  the Verify page itself and the public reading pages (Terms/Help). Verified
  users take the old path.
- `pages/verify-email.html` — title `ইমেইল ভেরিফাই করো`; Bengali text that a
  verification mail has gone to the mailbox; registered email shown; Resend
  button; primary button `আমি ভেরিফাই করেছি — চেক করো` (reloads, Home if
  verified, else stays with a Bengali toast); polls every 5s AND on
  `visibilitychange` (foreground return), auto-routes Home once verified.
- **Behaviour change to know:** accounts created while verification was
  disabled with `emailVerified=false` will now be gated to the Verify page
  on next app open until they verify — that is the specified behaviour, but
  it affects existing unverified users, not just new registrations.

## G. Toasts → simple professional Bengali (whole app)
- Every user-facing toast in `scripts/` + `services/` + pages inline is now
  simple professional Bengali. New helper `scripts/toast.js:181`
  `friendlyErrorMessage(err)` maps Firebase auth + Firestore error codes and
  every owned service error to Bengali (already-Bengali messages pass through;
  unmapped errors fall back to generic Bengali, original logged to console).
- Service errors translated at source (`payment/deposit/withdrawal/team/
  report/profile-photo/slot.service.js`), so `err.message` toasts are Bengali
  even where the caller just passes the error through. Two logic traps fixed
  along the way: `withdrawal.service.js` and `payment.service.js` matched on
  English error text (`indexOf('Insufficient balance'...)`) — updated to the
  Bengali prefixes.
- Toast styling, position, and duration logic untouched. Developer console
  logs, code comments, and internal error strings that never reach the UI
  were not translated. In-app notification titles/bodies in the same services
  were translated alongside the toasts (same wording, shown on the
  Notifications page).
- **Files touched for toasts (28):** `scripts/toast.js` (helper),
  `account-settings.js`, `withdrawal.js`, `wallet.js`, `tournaments.js`,
  `report-player.js`, `payment.js`, `network.js`, `navigation.js`,
  `my-team.js`, `leaderboard.js`, `auth-ui.js`, `app.js`,
  `join-tournament.js`, `matches.js`, `tournament-details.js`,
  `utils/dom-helpers.js`, `services/payment.service.js`,
  `deposit.service.js`, `withdrawal.service.js`, `team.service.js`,
  `report.service.js`, `profile-photo.service.js`, `slot.service.js`,
  `wallet.service.js`, `onesignal.service.js`, `notifications.service.js`,
  `pages/verify-email.html`. Grep proof: **zero** pure-English toast literals
  remain in the tree (remaining English tokens are proper nouns like
  Tournixo / UPI / UTR / Slot / Wallet, or runtime variables resolved
  through `friendlyErrorMessage`).
- Out of scope, left as-is: the offline banner text in `network.js`,
  `showConfirm` dialog texts, and the leaderboard "No rankings available"
  empty state.

## H. No name/anything change at join time (NEW)
- `scripts/join-tournament.js:295-311,367-378` — SOLO sheet: the editable
  name input and hidden UID input are gone; name + UID are plain read-only
  display from the profile, with a note that edits happen on the Profile
  page. Submit reads name/UID from `state.userData` (profile), never the DOM.
- `scripts/payment.js:283-372,394-424` — paid join roster sheet: captain /
  mate / SOLO name + UID are read-only display from the saved My Team /
  profile; editable team-name input removed → saved team name as read-only
  display; dead manual-input block deleted. The roster comes only from the
  saved My Team.
- **Kept:** slot picker and DUO mate radio (choosing a mate is a selection,
  not an edit). Profile / My Team editing is unchanged.
- Grep proof: no `<input type="text">` for name/UID/team-name remains in any
  join sheet (only the two DUO mate radios remain, plus the legacy UPI UTR
  field `pay-trxid` in `pages/payment.html:93`, which is not a name/UID field).

## NOT in this build
- The earlier U1–U18 list from 2026-11-12 — not in scope, not built.
- `firestore.rules` — untouched by order; merged rules (prizeDistributions
  block, bannedDevices read rule, `deviceIds` in the owner-update allow-list,
  staff cleanup) is still the final step, after the admin panel.
- Free-finalize manual-template tournaments: a free tournament with a pool
  but template `manual` and no per-kill rate has no computable split, so the
  admin packet finalizes it history-only (see the admin packet changelog).
- Cosmetic: results row foot "Rank Prize: ₹0" when the admin writes only
  `prizeAmount` per row (see B above) — headline total is always correct.

## Verification (coordinator, whole tree)
- `node --check` on EVERY JS file in the tree (module-aware check):
  **109 files checked across the user + admin trees, 0 failures.**
- Pages served 200 (10/10): index, register, verify-email, login,
  tournaments, matches, wallet, profile, sw.js, manifest.json.
- `firestore.rules` byte-identical to v8.5 (diff proof, zero differences).
- Grep proofs: wrong room note 0 hits; `prizeType === 'manual'` 0 hits;
  no editable name/UID input in join sheets; 0 pure-English toast literals;
  device-ban code present with fail-open comments; mobile field required +
  validation present; verify-page polling present (`setInterval` 5s +
  `visibilitychange`).
- NOT live-tested: no live Firebase or phone test was run (same standing
  caveat as all previous builds).

## Deploy notes
1. Replace the live files, close ALL PWA tabs, hard refresh (service-worker
   cache is `tournixo-user-v8-6-2026-11-13`).
2. Apply the admin free-distribution packet separately if free tournaments
   should pay prizes (see `admin-free-distribute-2026-11-13.zip`).
3. Existing unverified users will be gated to the Verify page until they
   verify (see F above).
4. The merged rules step is still pending — until it lands, device-ban checks
   fail open by design and login-time `deviceIds` recording stays inactive.

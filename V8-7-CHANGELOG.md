# Tournixo User Panel — v8.7 Changelog (2026-11-13)

## Base
- v8.6 FULL (133 files) + the three deltas below, all carried in from the v8.6 line.
- **No zip is produced from this tree** — the parent agent packages it.

## Carried-in deltas (already applied before v8.7 work, verified present)
1. **Premium slot-grid redesign** — `styles/components/slot-picker.css` rewritten
   (panel, count pill, legend pills, 6-column grid, lime selected state);
   `services/slot.service.js` `renderSlotGrid` (panel wrapper + free-count);
   `slot-picker.css` `<link>` added to `index.html`, `pages/home.html`,
   `pages/tournaments.html`. Root cause it fixed: the CSS was only linked on
   tournament-details + payment pages, so the Join modal opened from Home
   rendered with unstyled white browser-default buttons and a jammed legend.
2. **Indian phone validation** — `scripts/auth-ui.js`, `services/auth.service.js`
   ("IN NUMBER" code), `pages/register.html` (placeholder `98765 43210`,
   maxlength 14). Indian 10-digit `/^[6-9]\d{9}$/`; `+91`/`91`/`0` prefixes
   accepted and stripped, stored as 10 digits; BD `01...` numbers now error.
3. **New live domain** — `services/auth.service.js` `continueUrl` is
   `https://t.tournixo.workers.dev/pages/login.html` (3 places);
   `index.html` og meta uses `t.tournixo.workers.dev`; `sw.js` CACHE is
   `'tournixo-user-v8-7-2026-11-13'`.

## Task A — Design / missing audit (no fixes needed)
- Audited the slot-picker bug class across the whole tree: every shared
  component CSS file under `styles/components/` (9 files) checked against the
  pages that mount/use it — all clean (banner-slider/mode-chips home-only;
  bottom-nav + main-header on the 5 tab pages; skeleton-loader on
  home/matches/tournaments/wallet; splash-screen index-only; toast/
  confirm-dialog everywhere; slot-picker already fixed above).
- Modal classes (`.full-modal`, `.modal-header`, …) live in `styles/global.css`;
  `notif-popup.js` and `backend-failure.js` inject their own `<style>`;
  offline banner is in `toast.css`.
- No TODOs / lorem / dead buttons / broken stylesheet links found; empty
  states exist on all list pages. **No audit fixes were required — nothing
  changed under Task A.**

## Task B — Language rule (CORRECTED by the user, same evening)
- **Rule (his words: "Toast Bangla"): toasts stay in BENGALI — simple,
  professional, the v8.6 state. App text stays Bengali where Bengali is
  needed or better (verify-email instructions, join-sheet note,
  payment/deposit instructions); everything else left as-is.**
- What happened: the English-toast direction was started first (all
  `showToast`/`flashToast` strings + the `friendlyErrorMessage()` mapper in
  `scripts/toast.js` converted to English), then the user corrected it the
  same evening and the work was stopped immediately.
- **Revert (done in full, verified by the parent agent):** the first revert
  attempt left the mapper KEYS in Bengali (keys must stay the English error
  strings the services throw, values Bengali) — that would have broken every
  mapped message. Caught in verification: `scripts/toast.js` is now
  byte-identical to the v8.6 zip (diff empty), and `services/team.service.js`
  is byte-identical too. No other file was touched by the language pass.
  **Net language change in v8.7: none.**
- `twa-manifest.json` still references `tournixo.netlify.app` — left as-is
  per the brief (it is not a `.js`/`.html` file).

## Files changed vs the v8.6 base (9 files — the carried-in deltas only)
- `styles/components/slot-picker.css` — rewritten (slot-grid redesign)
- `services/slot.service.js` — `renderSlotGrid` panel + free-count
- `index.html`, `pages/home.html`, `pages/tournaments.html` — slot-picker.css link
- `scripts/auth-ui.js`, `services/auth.service.js` — Indian phone validation
- `pages/register.html` — phone placeholder `98765 43210`
- `sw.js` — cache bumped to `tournixo-user-v8-7-2026-11-13` (+ comment fix)

## Verification (2026-11-13, in-tree)
- `node --check` on every standalone `.js` file (scripts + services + config +
  firebase + utils): **56/56 pass, 0 failures.**
- `tournixo.netlify.app`: **zero occurrences in `*.js` / `*.html`** (only
  `twa-manifest.json` still references it — left as-is, see above).
- Toasts confirmed Bengali (v8.6 state); no English toast literals remain.

## Deploy notes
- Service-worker cache: `tournixo-user-v8-7-2026-11-13`.
- After deploy: close ALL PWA tabs, then hard refresh (or Clear site data)
  so the new service worker takes over; otherwise the old cached panel
  keeps serving.

## OPEN items (do NOT fix in this build — separate steps)
- `firestore.rules` still v18 — the merged v19 (prizeDistributions +
  bannedDevices + staff removal) is a separate deploy step.
- `assetlinks.json` still has the `REPLACE_WITH` placeholder.
- `firestore.indexes.json` needs publishing in the Firebase Console.
- No live Firebase / phone test done on this build.
- Results row shows "Rank Prize: ₹0" (cosmetic) when the admin writes only
  `prizeAmount` on a result.
- OneSignal dashboard Site URL still points at netlify — push on the new
  workers.dev domain needs a dashboard update + users re-allowing.

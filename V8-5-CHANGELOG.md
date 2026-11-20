# Tournixo User Panel v8.5 — Flow Fixes (2026-11-12)

Base: v8.4 full (2026-11-11). Changed files: only 3 —
`scripts/join-tournament.js`, `scripts/payment.js`, `sw.js` (cache bump).
**Firebase rules NOT touched** — per owner, rules are written once at the
very end, after the admin panel is fixed.

## Canonical flow (stated by owner 2026-11-12, verified against this tree)

- FREE SOLO: Join → slot picker → Join → instant confirmed, no admin.
- FREE SQUAD: Join → saved 4-player sheet (My Team) → slot → instant confirmed.
- FREE DUO: same sheet, pick any ONE mate (radio) → slot → instant confirmed.
- No saved team for DUO/SQUAD → "আগে নিজের team বানাও" + redirect to My Team.
- PAID deposit: Wallet → admin UPI ID (settings/payment) → Add Money form →
  request PENDING → admin accept = credited, reject = nothing.
- PAID join: Join → sheet / one mate → slot + fee → Confirm → wallet debited
  ONLY if the slot is booked, instant confirmed, no admin. No slot = no debit.
- PAID SOLO: no sheet — direct slot + fee + Confirm.

## What was already correct (verified in code, no change)

- Free SOLO / SQUAD / DUO join, slot picker, instant confirm.
- No-team gate (openJoinModal + submit + teamPlayersForFormat).
- Paid instant wallet join (one txn: slot lock + confirmed + debit + ledger).
- Deposit flow (admin UPI ID, dep_ doc, pending status).
- Paid SOLO (direct slot + fee, no sheet).

## What was broken and is fixed here

- **F1 — Join button died after a validation failure.** In
  `submitTournamentRegistration`, every validation-failure `return`
  (missing UID, duplicate UID, team error, no mate) left `_joinInFlight`
  true, so the next Join tap did nothing until a full page reload.
  Fix: `finally { _joinInFlight = false; }` — every return path releases it.
- **F2 — Paid DUO had no mate selection.** The paid page always used the
  sheet's FIRST mate (`validMates[0]`); the user could not choose. Free
  DUO already had the radio. Fix: `pay-duo-mate-select` radio list on the
  paid page (same look as the free modal) + `collectRoster` reads the
  selected radio.
- **F3 — Old UPI pending join was still callable for NEW joins.**
  `submitTournamentPayment` (UPI + admin approval) stayed wired to the
  Submit Payment button inside the hidden UPI block. Fix: it now refuses
  unless `_mode === 'legacy'` (old unpaid teams finishing payment only).
  New joins are wallet-only.
- **F4 — Dead manual DUO/SQUAD code + wrong comments.** The manual
  DUO/SQUAD forms and submit branches were unreachable (the team gate
  returns first) but still in the code, and comments said "My Team
  removed / manual entry only" — the opposite of the real flow. Removed
  both dead blocks; comments now describe the canonical flow.

## Verification

- `node --check` on ALL JS files in the tree: clean.
- Zero remaining references to removed manual ids
  (`duo-team-name`, `squad-p2/p3/p4`, `duo-p2`).
- `firestore.rules` + `firestore-rules-v18-DEPLOY.txt`: byte-identical to v8.4.
- Pages served 200 (spot check). NOT live-tested on Firebase / phone —
  deploy first, then run the phone checklist (slot pick + join for
  Free SOLO/SQUAD/DUO, Paid DUO mate radio, deposit request, wallet debit).

## Deploy

- Replace files, close ALL PWA tabs, hard refresh (cache name is now
  `tournixo-user-v8-5-2026-11-12`).
- Rules: publish v18 first (unchanged from v8.4) — no new rules in v8.5.

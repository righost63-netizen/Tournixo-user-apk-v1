// scripts/rules.js
// FIX (Tournament Rules, 2026-11-19): Global Tournament Rules page —
// mirrors scripts/terms.js line for line in structure (same cache
// pattern, same renderer, same back behaviour). Admin writes the rules
// once in the admin panel (settings/tournamentRules); everyone reads
// them here. The renderer below is deliberately DUPLICATED from
// terms.js (renderTermsBody → renderRulesBody) instead of refactored
// into a shared helper — smallest blast radius, Terms stays untouched.
import { initPage } from './app.js';
import { goBack } from '../config/app-config.js';
import { db, doc, getDoc } from '../firebase/firebase-init.js';
import { cacheGet, cacheSet, cacheIsFresh } from './cache.js';
import { state } from './state.js';
import { STORAGE_KEYS, CACHE_TTL } from '../utils/constants.js';
import { escHtml } from '../utils/escape.js';

const RULES_CACHE_KEY = STORAGE_KEYS.tournamentRules;
const RULES_CACHE_MS  = CACHE_TTL.tournamentRules;

// FIX (Tournament Rules, 2026-11-19): default Tournament Rules shown
// until the admin publishes their own via the admin panel
// (settings/tournamentRules). Generic fair-play rules only — no fees,
// no time limits, no invented specifics.
const DEFAULT_RULES = `1. Fair Play
- No hacks, mods, emulators, or exploits of any kind.
- Teaming with opponents or stream-sniping to gain advantage is prohibited.
- Violations lead to disqualification.

2. Eligibility
- You must register with your own correct Free Fire UID.
- One account per player. Fake or duplicate accounts will be removed.

3. Registration & Slots
- Slots are confirmed on a first-come, first-served basis.
- Only confirmed players may take part in the match.

4. Room & Match
- Room ID and password are shared only with confirmed participants.
- Join the room on time and follow the room host's instructions during the match.

5. Results
- Results are published after verification by the Tournixo team.
- Disputes must be raised with the Tournixo team.

6. Conduct
- Abusive behaviour towards players, staff, or admins leads to a ban.
- Do not share room credentials publicly.`;

async function loadRules() {
    const el = document.getElementById('rules-content');
    if (!el) return;

    const cached = cacheGet(RULES_CACHE_KEY);
    if (cached && cached.data) renderRules(cached.data);
    if (cached && cacheIsFresh(cached, RULES_CACHE_MS)) return;

    try {
        const snap = await getDoc(doc(db, 'settings', 'tournamentRules'));
        const data = snap.exists() ? snap.data() : {};
        cacheSet(RULES_CACHE_KEY, data);
        renderRules(data);
    } catch (error) {
        if (!cached) {
            // FIX (2026-11-20, S8): load fail-এ Retry (Leaderboard pattern) —
            // পুরো page reload নয়, শুধু Rules আবার load।
            el.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
                    <div class="empty-title">লোড হয়নি</div>
                    <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryRules()">আবার চেষ্টা করো</button>
                </div>
            `;
        }
    }
}

// FIX (2026-11-20, S8): load-fail Retry।
window.retryRules = () => { loadRules(); };

// ── Renderer: admin writes plain text, we turn it into
//    numbered sections, bullet cards and clean paragraphs.
//    Everything is HTML-escaped first (XSS-safe).
//    (Duplicated from renderTermsBody in terms.js — see file header.)
function renderRulesBody(raw) {
    const lines = String(raw || '').split(/\r?\n/);
    let html = '', inList = false, sectionNum = 0;

    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) { closeList(); continue; }

        // 1. Numbered section — "1. Fair Play" / "2) Payments"
        let m = line.match(/^(\d{1,2})[.)]\s+(.+)$/);
        if (m) {
            closeList();
            sectionNum++;
            html += `<h3 class="terms-h"><span class="terms-h-num">${sectionNum}</span><span>${escHtml(m[2])}</span></h3>`;
            continue;
        }

        // 2. Bullet — "- item" / "• item"
        m = line.match(/^[-•*]\s+(.+)$/);
        if (m) {
            if (!inList) { html += '<ul class="terms-ul">'; inList = true; }
            html += `<li>${escHtml(m[1])}</li>`;
            continue;
        }

        // 3. Plain heading — short ALL-CAPS line without trailing period
        const letters = line.replace(/[^A-Za-z]/g, '');
        if (letters.length >= 4 && line.length <= 60 && line === line.toUpperCase()
            && letters === letters.toUpperCase() && !/[.!?]$/.test(line)) {
            closeList();
            html += `<h3 class="terms-h-plain">${escHtml(line)}</h3>`;
            continue;
        }

        // 4. Regular paragraph
        closeList();
        html += `<p class="terms-p">${escHtml(line)}</p>`;
    }
    closeList();
    return html;
}

function renderRules(data) {
    const el = document.getElementById('rules-content');
    if (!el) return;

    // FIX (Tournament Rules, 2026-11-19): bundled default rules — shown
    // when the admin hasn't published rules yet
    // (settings/tournamentRules missing or empty). The admin panel can
    // overwrite this anytime by writing that document.
    const content = (data?.content || '').trim() || DEFAULT_RULES;
    el.innerHTML = renderRulesBody(content);

    // "Last updated" chip from the admin-written updatedAt
    const chip = document.getElementById('rules-updated-chip');
    if (chip) {
        const upd = data?.updatedAt?.toDate?.();
        if (upd) {
            const dstr = upd.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            chip.textContent = 'Last updated: ' + dstr;
            chip.style.display = 'inline-block';
        } else {
            chip.style.display = 'none';
        }
    }
}

// Import the shared back helper directly (the same implementation used by
// Account Settings, My Team and Report Player) instead of depending on a
// separately assigned window global being present at tap time. It uses real
// history back for in-app arrivals and replaces with the safe origin page
// when there is no usable in-app history entry.
window.closeRules = function () {
    goBack(state.currentUser ? 'profile' : 'register');
};

initPage({
    page: 'rules',
    onReady: () => { loadRules(); }
});

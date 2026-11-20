// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { initPage } from './app.js';
import { state } from './state.js';
import { getInitials } from '../utils/formatters.js';
import { escHtml } from '../utils/escape.js';
import { fetchPublishedLeaderboard } from '../services/leaderboard.service.js';
import { friendlyErrorMessage } from './toast.js';

// UNSLOP (pass 3): empty/error icons are line SVGs, not emoji.
const ICON_TROPHY_40 = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';
const ICON_ALERT_40 = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

// ════════════════════════════════════════════════════════════════
// LEADERBOARD — ranked by Total Earnings (totalEarnings)
// v6.1: reads the admin-published `leaderboard/current` doc (1 read).
// U5: no live all-users fallback — if nothing is published yet, the page
// says so instead of scanning the users collection.
// "You" is matched by Firebase UID first (matchMe), FF UID fallback —
// published entries carry no Firebase uid yet (admin writes only
// rank/name/ffUID/totalEarnings), so the fallback does the work today.
// ════════════════════════════════════════════════════════════════
function renderLeaderboard(users, meta) {
    const myUid = String(state.currentUser?.uid || '').trim();
    const myFfUID = String(state.userData?.ffUID || '').trim();
    // FIX (2026-11-19, v8.11): "You" আগে Firebase UID দিয়ে মেলাও
    // (entry-তে userId/uid থাকলে), না থাকলে FF UID fallback।
    // Admin এখন entries-তে শুধু { rank, name, ffUID, totalEarnings }
    // লেখে (userId লেখে না), তাই আপাতত FF UID fallback-ই কাজ করে;
    // admin userId লিখতে শুরু করলে সেটাই প্রাধান্য পাবে।
    const matchMe = (u) => {
        if (!u) return false;
        if (myUid && (String(u.userId || '').trim() === myUid || String(u.uid || '').trim() === myUid)) return true;
        return myFfUID !== '' && String(u.ffUID || '').trim() === myFfUID;
    };
    const podiumArea = document.getElementById('podium-area');
    const lbList = document.getElementById('lb-list');
    const youBanner = document.getElementById('lb-you-banner');
    const updatedNote = document.getElementById('lb-updated-note');

    if (updatedNote) {
        // v6.1: show when the ranking was published (daily by admin).
        const upd = meta && meta.updatedAt;
        const d = upd && typeof upd.toDate === 'function' ? upd.toDate() : (upd ? new Date(upd) : null);
        updatedNote.textContent = d && !isNaN(d.getTime())
            ? `Updated ${d.toLocaleDateString()} · refreshed daily`
            : '';
        updatedNote.style.display = updatedNote.textContent ? 'block' : 'none';
    }

    // FIX (2026-11-19, v8.9): Top 50 scope — মোট কতজনের মধ্যে টপ ৫০,
    // সেটাও দেখাও (totalPlayers আগে আনা হতো কিন্তু দেখানো হতো না)।
    const scopeNote = document.getElementById('lb-scope-note');
    if (scopeNote) {
        const total = meta ? Number(meta.totalPlayers || 0) : 0;
        scopeNote.textContent = total > 0
            ? `Top 50 · মোট ${total.toLocaleString()} জন প্লেয়ারের মধ্যে`
            : 'Top 50 · Total Earnings-এর ranking';
    }

    if (!podiumArea || !lbList) return;

    if (!users || users.length === 0) {
        podiumArea.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${ICON_TROPHY_40}</div>
                <div class="empty-title">No rankings available</div>
                <div class="empty-sub">Leaderboard rankings will be updated after tournament matches</div>
            </div>`;

        if (youBanner) youBanner.innerHTML = '';
        lbList.innerHTML = '';
        return;
    }

    const top3 = users.slice(0, 3);

    let po = [],
        pc = [],
        pk = [],
        pr = [];

    if (top3.length >= 3) {
        po = [top3[1], top3[0], top3[2]];
        pc = ['g2', 'g1', 'g3'];
        pk = ['2', '1', '3'];
        pr = [2, 1, 3];
    } else if (top3.length === 2) {
        po = [top3[1], top3[0]];
        pc = ['g2', 'g1'];
        pk = ['2', '1'];
        pr = [2, 1];
    } else {
        po = [top3[0]];
        pc = ['g1'];
        pk = ['1'];
        pr = [1];
    }

    podiumArea.innerHTML = `
        <div class="podium">
            ${po.map((u, i) => `
                <div class="p-col ${pc[i]}">
                    <div class="p-av">
                        <span class="medal">${pk[i]}</span>${escHtml(getInitials(u.name))}
                    </div>
                    <div class="p-name">${escHtml(u.name || 'Player')}</div>
                    <div class="p-uid">UID: ${escHtml(u.ffUID || '—')}</div>
                    <div class="p-amt">₹${Number(u.totalEarnings || 0).toFixed(0)}</div>
                    <div class="p-bar">${pr[i]}</div>
                </div>
            `).join('')}
        </div>`;

    lbList.innerHTML = '';

    // FIX (2026-11-19, v8.11): "You" Firebase UID আগে, FF UID পরে
    // (matchMe দেখো) — FF UID খালি/বদলে গেলেও UID দিয়ে মেলে।
    const myRank = users.findIndex(matchMe);

    if (youBanner) {
        youBanner.innerHTML = (myRank >= 0 && myRank < 3)
            ? `<div class="you-banner">You are ranked <b>#${myRank + 1}</b> · Total earnings <b>₹${Number(users[myRank].totalEarnings || 0).toFixed(0)}</b></div>`
            : (myRank >= 3
                ? `<div class="you-banner">You are ranked <b>#${myRank + 1}</b> · keep climbing!</div>`
                : '');
    }

    const lbFragment = document.createDocumentFragment();

    users.slice(3).forEach((u, i) => {
        const isMe = matchMe(u);

        const item = document.createElement('div');
        item.className = 'l-row' + (isMe ? ' me' : '');

        item.innerHTML = `
            <div class="l-rank">${i + 4}</div>
            <div class="l-av">${escHtml(getInitials(u.name))}</div>
            <div class="l-body">
                <div class="l-name">${escHtml(u.name || 'Player')}${isMe ? ' (You)' : ''}</div>
                <div class="l-uid">Gaming UID: ${escHtml(u.ffUID || '—')}</div>
            </div>
            <div class="l-amt">₹${Number(u.totalEarnings || 0).toFixed(0)}</div>`;

        lbFragment.appendChild(item);
    });

    lbList.appendChild(lbFragment);
}

async function loadLeaderboard() {
    const podiumArea = document.getElementById('podium-area');
    const lbList = document.getElementById('lb-list');

    if (podiumArea) {
        podiumArea.innerHTML =
            '<div class="empty-state"><div class="spinner"></div></div>';
    }

    if (lbList) lbList.innerHTML = '';

    try {
        // U5: published doc only (1 read). Missing/empty doc → a clear
        // 'not published yet' state, never a scan of the users collection.
        // Ranking stays by lifetime totalEarnings (sorted in the service).
        const pub = await fetchPublishedLeaderboard();
        if (!pub || !pub.entries.length) {
            if (podiumArea) {
                podiumArea.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">${ICON_TROPHY_40}</div>
                        <div class="empty-title">Leaderboard not published yet</div>
                        <div class="empty-sub">The ranking is published daily by the admin. Please check back soon.</div>
                    </div>`;
            }
            if (lbList) lbList.innerHTML = '';
            return;
        }
        renderLeaderboard(pub.entries, pub);
    } catch (err) {
        // v6: real failures (permission / network) surface here, distinctly from
        // the "No rankings available" empty state that renderLeaderboard shows
        // when the query legitimately returns zero users.
        // v8.6 (G): লিডারবোর্ড লোডের error-ও বাংলায় (friendlyErrorMessage)।
        const msg = friendlyErrorMessage(err);
        if (podiumArea) {
            podiumArea.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_ALERT_40}</div>
                    <div class="empty-title">লিডারবোর্ড লোড হয়নি</div>
                    <div class="empty-sub">${escHtml(msg)}</div>
                    <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryLeaderboard()">আবার চেষ্টা করো</button>
                </div>`;
        }
    }
}

// FIX (2026-11-19, v8.11): load fail-এ Retry — আবার load চলে, পুরো
// page reload লাগে না।
window.retryLeaderboard = () => { loadLeaderboard(); };

initPage({
    page: 'leaderboard',
    tab: 'leaderboard',
    onReady: async () => {
        await loadLeaderboard();
    }
});
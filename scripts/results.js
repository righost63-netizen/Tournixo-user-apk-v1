import { initPage } from './app.js';
import { state } from './state.js';
import { goTo, getParam } from '../config/app-config.js';
import { formatDateOnly } from '../utils/formatters.js';
import { fetchTournamentResults, fetchCompletedTournaments, fetchResultPosts, fetchResultPoster, fetchDistributionRecipients, fetchMyPaidTournamentIds } from '../services/results.service.js';

// ════════════════════════════════════════════════════════════════
// XSS PROTECTION: Firestore থেকে আসা যেকোনো string innerHTML এ বসানোর আগে escape করতে হবে।
// (`??` ব্যবহার করা হয়েছে যাতে 0 মানটা খালি string না হয়ে যায়)
// inline onclick="fn('${...}')" এর ভেতরে এটা যথেষ্ট নয় — ওখানে data-* attribute ব্যবহার করো।
// ════════════════════════════════════════════════════════════════
import { escHtml } from '../utils/escape.js';

// UNSLOP (pass 3): empty/error icons are line SVGs, not emoji.
const ICON_MEGAPHONE_40 = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';
const ICON_ALERT_40 = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const ICON_IMAGE_18 = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

// FIX (2026-10-25, W4): poster-এর onclick="window.open('...')" ছিল stored
// XSS — escHtml-এর &#39; HTML parser decode করে JS string ভেঙে দিত।
// এখন data-* attribute + একটাই delegated listener; শুধু https URL খুলবে।
let _posterClickBound = false;
if (!_posterClickBound) {
    _posterClickBound = true;
    document.addEventListener('click', (e) => {
        const el = e.target?.closest?.('.result-poster-open');
        if (!el) return;
        const url = el.getAttribute('data-poster-url');
        if (url && /^https:\/\//.test(url)) window.open(url, '_blank');
    });
}

// ════════════════════════════════════════════════════════════════
// PARSE TOURNAMENT RESULTS ARRAY ACCURATELY (results.html?id=<tournamentId>)
// ════════════════════════════════════════════════════════════════
async function openTournamentResults(tournamentId) {
    const container = document.getElementById('published-results-list');
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div><div style="margin-top:10px;">রেজাল্ট লোড হচ্ছে…</div></div>'; /* FIX (2026-11-20, S6): Bengali. */
    try {
        const { tourn, resData } = await fetchTournamentResults(tournamentId);
        // FIX (2026-11-20, S-R2): tournament doc না থাকলে ভুয়া নাম
        // "Tournament" দেখানো হতো — এখন পরিষ্কার error state।
        if (!tourn) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_ALERT_40}</div>
                    <div class="empty-title">টুর্নামেন্ট পাওয়া যায়নি</div>
                    <div class="empty-sub">এই টুর্নামেন্টটি আর নেই — admin মুছে দিতে পারে।</div>
                </div>`;
            return;
        }
        // ৩. রেজাল্ট পাবলিশ করা আছে কি না যাচাই
        // নতুন Result flow (2026-10-24): scoreboard publish না থাকলে
        // Result টুলের poster-ই অফিসিয়াল result — থাকলে সেটা দেখাও।
        // FIX (2026-11-11, H1): admin BUILD 30 `published` লেখে না —
        // লেখে resultStatus ('Completed'/'Distributed')। পুরনো gate-এ
        // scoreboard কখনো render হতো না। Legacy doc-এ published:true
        // থাকলেও চলবে, আর results array থাকলেও চলবে।
        const isPublished = resData && (resData.published === true
            || ['Completed', 'Distributed'].includes(resData.resultStatus)
            || (Array.isArray(resData.results) && resData.results.length > 0));
        if (!isPublished) {
            const poster = await fetchResultPoster(tournamentId).catch(() => null);
            if (poster?.imageUrl) {
                container.innerHTML = `
                    <div class="results-board-head">
                        <div class="results-board-title">${escHtml(tourn.name)}</div>
                        <div class="results-board-meta">অফিসিয়াল রেজাল্ট পোস্টার</div>
                    </div>
                    <div style="margin-top:12px;" class="result-poster-open" data-poster-url="${escHtml(poster.imageUrl)}">
                        <img src="${escHtml(poster.imageUrl)}" alt="${escHtml(poster.title || 'Result')}" style="width:100%;border-radius:14px;display:block;">
                    </div>
                    <div style="text-align:center;color:var(--text2);font-size:13px;margin-top:10px;">${escHtml(poster.title || '')} — বড় করে দেখতে ছবিতে ট্যাপ করো</div>`;
                return;
            }
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_MEGAPHONE_40}</div>
                    <div class="empty-title">রেজাল্ট এখনো পাবলিশ হয়নি</div>
                    <div class="empty-sub">Admin এখনো "${escHtml(tourn.name)}"-এর অফিসিয়াল রেজাল্ট পাবলিশ করেননি।</div>
                </div>`;
            return;
        }
        // ৪. রেজাল্ট অ্যারে বের করে নেওয়া (results অথবা players ফিল্ড থেকে)
        let entries = [];
        if (Array.isArray(resData.results)) {
            entries = resData.results;
        } else if (Array.isArray(resData.players)) {
            entries = resData.players;
        }
        if (entries.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_MEGAPHONE_40}</div>
                    <div class="empty-title">স্কোরবোর্ড খালি</div>
                    <div class="empty-sub">এই টুর্নামেন্টের কোনো স্কোর রেকর্ড করা হয়নি।</div>
                </div>`;
            return;
        }
        // ৫. Rank অনুযায়ী ক্রমানুসারে সাজানো (Rank #1, #2, #3...)
        entries.sort((a, b) => Number(a.rank || 999) - Number(b.rank || 999));
        // UNSLOP (pass 3/4): medals are plain rank numbers now — see rankLabel below.
        const isSolo = (tourn.teamFormat || resData.teamFormat) === 'SOLO';
        const isDistributed = resData.prizesDistributed === true;

        // FIX (2026-11-19, v8.11): per-user credited state — tournament-
        // level flag-এ partial distribution-এও সবাইকে "Prize credited"
        // দেখাত। recipients list (prizeDistributions/<tid>.recipients[]
        // .userId = captain-এর Firebase UID) পড়া গেলে সেটাই সত্যের
        // উৎস; না গেলে (admin-only read, deny হবে) নিজের prizeHistory
        // দেখা হয়। দুটোই best-effort — পড়া না গেলে flag-based দেখানো
        // হয়, কিন্তু টাকা না পাওয়া user-কে "Credited" দেখানো হয় না।
        const myUid = String(state.currentUser?.uid || '').trim();
        const distRecipients = await fetchDistributionRecipients(tournamentId);
        const myPaidTournaments = (distRecipients === null && myUid)
            ? await fetchMyPaidTournamentIds(myUid)
            : null;

        const rowsHtml = entries.map(r => {
            const rankNum = Number(r.rank || 0);
            const rankLabel = rankNum > 0 ? `#${rankNum}` : '—';
            const kills = Number(r.kills || 0);
            const perKill = Number(tourn.perKill || resData.perKill || 0);
            // v8.8 (item 9): admin শুধু prizeAmount লিখলে (BUILD 30)
            // breakdown-এ ₹0 দেখানো যাবে না। Split তখনই দেখাও যখন
            // আসল তথ্য আছে: row-এর rankPrize/killReward field, বা
            // perKill দিয়ে হিসাব করা killReward। rankPrize field না
            // থাকলে total − killReward-ই rank ভাগ। কিছুই না থাকলে
            // শুধু total দেখাও — ₹0 breakdown লাইন লুকিয়ে যাবে।
            const hasKillRewardField = r.killReward !== undefined && r.killReward !== null;
            const hasRankPrizeField = r.rankPrize !== undefined && r.rankPrize !== null;
            const hasTotalField = r.prizeAmount !== undefined && r.prizeAmount !== null;
            const killReward = hasKillRewardField
                ? Number(r.killReward)
                : (perKill > 0 ? kills * perKill : null);
            const rankPrize = hasRankPrizeField
                ? Number(r.rankPrize)
                : (hasTotalField && killReward !== null ? Math.max(0, Number(r.prizeAmount) - killReward) : null);
            // v8.8 (item 9, কঠোর): হিসাব করা ভাগ (computed split) ₹0
            // হলে লাইনটাই লুকিয়ে যাবে — "Rank Prize: ₹0" কখনো
            // দেখাবে না। Admin সরাসরি field-এ ₹0 লিখলে সেটা আসল তথ্য,
            // তাই শুধু সেটাই দেখানো হয়।
            const rankPrizeShown = (rankPrize !== null && (hasRankPrizeField || rankPrize > 0)) ? rankPrize : null;
            const killRewardShown = (killReward !== null && (hasKillRewardField || killReward > 0)) ? killReward : null;
            // FIX (2026-11-11, H2): admin BUILD 30 প্রতি row-তে শুধু
            // prizeAmount লেখে — perKill/rankPrize থেকে হিসাব করলে সব
            // row-এ ₹0 দেখাত। prizeAmount থাকলে সেটাই শেষ কথা।
            const totalPrize = Number(r.prizeAmount !== undefined ? r.prizeAmount : (r.totalPrize !== undefined ? r.totalPrize : ((killReward || 0) + (rankPrize || 0))));

            // v6: highlight the logged-in user's own team/row (match by FF UID).
            const myFfUID = String(state.userData?.ffUID || '').trim();
            const rowUids = [];
            if (r.ffUID) rowUids.push(String(r.ffUID).trim());
            if (Array.isArray(r.players)) r.players.forEach(p => { if (p?.ffUID) rowUids.push(String(p.ffUID).trim()); });
            const isMe = myFfUID !== '' && rowUids.includes(myFfUID);

            // FIX (2026-11-19, v8.11): এই row-এর captain টাকা পেয়েছে
            // কিনা — row-তে userId = captain-এর Firebase UID (admin
            // save-এ লেখে)। recipients থাকলে সেটাই চূড়ান্ত: captain
            // list-এ নেই মানে এই team-কে টাকা দেওয়া হয়নি (partial
            // distribution হলেও)। recipients না পড়া গেলে শুধু নিজের
            // row-এ নিজের prizeHistory দেখা হয়। row-তে captain UID না
            // থাকলে (legacy row) per-user তথ্য নেই — flag-based দেখাও।
            const rowCaptainUid = String(r.userId || '').trim();
            let credited = null; // null = per-user তথ্য নেই → flag-based
            let creditedAmount = null; // এই row-এর captain-কে দেওয়া টাকা (₹0-ও থাকে)
            if (distRecipients) {
                if (rowCaptainUid && distRecipients.has(rowCaptainUid)) {
                    credited = true;
                    creditedAmount = distRecipients.get(rowCaptainUid);
                } else if (rowCaptainUid) {
                    credited = false;
                }
            } else if (myPaidTournaments && myUid && rowCaptainUid === myUid) {
                if (myPaidTournaments.has(tournamentId)) {
                    credited = true;
                    creditedAmount = myPaidTournaments.get(tournamentId);
                }
            }
            // FIX (2026-11-20, S-R1): ₹0 winner-কে আর "Verified (Pending
            // Payout)" দেখানো হয় না — distribution record-এ amount 0
            // থাকলে (শুধু win, পুরস্কার নেই) label "No prize amount"।
            // per-user তথ্য না থাকলে prizeAmount field-এ 0 থাকলেও তাই।
            const creditLabel = credited === true
                ? (Number(creditedAmount || 0) > 0 ? 'Prize credited' : 'No prize amount')
                : credited === false ? 'Verified (Pending Payout)'
                : (hasTotalField && totalPrize === 0 ? 'No prize amount'
                : (isDistributed ? 'Prize credited' : 'Verified (Pending Payout)'));
            const creditColor = creditLabel === 'No prize amount' ? 'var(--text2)'
                : credited === true ? 'var(--success)'
                : credited === false ? 'var(--warning)'
                : (isDistributed ? 'var(--success)' : 'var(--warning)');

            // Duo বা Squad হলে প্লেয়ারদের নাম ও Gaming UID শো করা
            let playerDetailsHtml = '';
            if (!isSolo && Array.isArray(r.players) && r.players.length > 0) {
                playerDetailsHtml = `
                    <div class="results-player-sub">
                        ${r.players.map(p => `<span>${escHtml(p.playerName || 'Player')} (UID: ${escHtml(p.ffUID || '—')})</span>`).join(' · ')}
                    </div>`;
            } else if (r.ffUID) {
                playerDetailsHtml = `<div class="results-player-sub" style="font-family:monospace;">Gaming UID: ${escHtml(r.ffUID)}</div>`;
            }

            return `
                <div class="results-row${isMe ? ' me' : ''}">
                    <div class="results-row-top">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div class="results-rank">${rankLabel}</div>
                            <div>
                                <div class="results-player">${escHtml(r.teamName || r.playerName || r.userName || 'Player')}${isMe ? ' <span class="you-tag">You</span>' : ''}</div>
                                ${playerDetailsHtml}
                            </div>
                        </div>
                        <div class="results-prize">
                            <div class="results-prize-amt">₹${totalPrize.toLocaleString()}</div>
                            <div class="results-prize-kills">${kills} Kills${killRewardShown !== null ? ` (+₹${killRewardShown})` : ''}</div>
                        </div>
                    </div>
                    <div class="results-row-foot">
                        ${rankPrizeShown !== null ? `<span>Rank Prize: ₹${rankPrizeShown}</span>` : ''}
                        ${killRewardShown !== null ? `<span>Kill Reward: ₹${killRewardShown}</span>` : ''}
                        <span style="color:${creditColor}; font-weight:600;">${creditLabel}</span>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = `
            <div class="results-board-head">
                <div class="results-board-title">${escHtml(tourn.name)}</div>
                <div class="results-board-meta">
                    ${escHtml(tourn.teamFormat)} · ${escHtml(tourn.gameMode)} · Map: ${escHtml(tourn.map)}
                </div>
                ${!isSolo ? `<div class="results-team-note">পুরস্কার টিমের — টিম ক্যাপ্টেনের wallet-এ জমা হয়।</div>` : ''}
            </div>
            ${rowsHtml}`;
    } catch (err) {
        console.error('openTournamentResults error:', err);
        // FIX (2026-11-20, S8): load fail-এ Retry (Leaderboard pattern) —
        // পুরো page reload নয়, শুধু এই tournament-এর result আবার load।
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${ICON_ALERT_40}</div>
                <div class="empty-title">রেজাল্ট লোড হয়নি</div>
                <div class="empty-sub">${escHtml(err.message)}</div>
                <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryResultsLoad()">আবার চেষ্টা করো</button>
            </div>`;
    }
}

// ════════════════════════════════════════════════════════════════
// Global Published Results (from Profile) — results.html without ?id
// ════════════════════════════════════════════════════════════════
// FIX (2026-11-20, S-R2): "আরও দেখো" — 20-এ cap নয়, প্রতিবার আরও 20।
let _publishedLimit = 20;
async function openPublishedResults() {
    const container = document.getElementById('published-results-list');
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    try {
        // Fetch completed tournaments that have published results
        const tournList = await fetchCompletedTournaments(_publishedLimit);
        if (tournList.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_MEGAPHONE_40}</div>
                    <div class="empty-title">কোনো সম্পন্ন টুর্নামেন্ট নেই</div>
                    <div class="empty-sub">টুর্নামেন্ট শেষ হলে এখানে রেজাল্ট দেখাবে</div>
                </div>`;
            return;
        }
        // নতুন Result flow (2026-10-24): সবার উপরে Result Poster
        // section — admin-এর Result টুল থেকে আপলোড করা poster-গুলো।
        let posterHtml = '';
        try {
            const posters = await fetchResultPosts();
            if (posters.length) {
                posterHtml = `
                    <div class="results-pick-label">অফিসিয়াল রেজাল্ট পোস্টার</div>
                    ${posters.map(po => `
                        <div class="results-tourn-card result-poster-open" data-poster-url="${escHtml(po.imageUrl)}">
                            <div>
                                <div class="results-tourn-name">${escHtml(po.title || 'Result')}</div>
                                <div class="results-tourn-meta">${escHtml(po.tournamentName || '')}</div>
                            </div>
                            <span style="display:flex;flex-shrink:0;">${ICON_IMAGE_18}</span>
                        </div>`).join('')}
                    <div class="results-pick-label" style="margin-top:18px;">অফিসিয়াল রেজাল্ট দেখতে একটা টুর্নামেন্ট বেছে নাও:</div>`;
            }
        } catch (e) { /* poster section না থাকলে list-ই দেখাবে */ }
        // FIX (2026-11-20, S-R2): limit-এ পৌঁছালে "আরও দেখো" — আরও 20।
        const moreHtml = tournList.length >= _publishedLimit
            ? `<button class="btn btn-secondary" id="results-load-more" style="margin-top:12px;">আরও দেখো</button>`
            : '';
        container.innerHTML = `
            ${posterHtml || '<div class="results-pick-label">অফিসিয়াল রেজাল্ট দেখতে একটা টুর্নামেন্ট বেছে নাও:</div>'}
            ${tournList.map(t => `
                <div class="results-tourn-card">
                    <div>
                        <div class="results-tourn-name">${escHtml(t.name)}</div>
                        <div class="results-tourn-meta">${escHtml(t.teamFormat)} · ${t.dateObj ? formatDateOnly(t.dateObj) : ''}</div>
                    </div>
                    <button class="btn btn-primary btn-sm" data-id="${escHtml(t.id)}" onclick="openTournamentResults(this.dataset.id)">রেজাল্ট দেখো</button>
                </div>
            `).join('')}
            ${moreHtml}`;
        const moreBtn = document.getElementById('results-load-more');
        if (moreBtn) moreBtn.addEventListener('click', () => { _publishedLimit += 20; openPublishedResults(); });
    } catch (err) {
        // FIX (2026-11-20, S8): load fail-এ Retry (Leaderboard pattern)।
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${ICON_ALERT_40}</div>
                <div class="empty-title">লোড হয়নি</div>
                <div class="empty-sub">${escHtml(err.message)}</div>
                <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryResultsLoad()">আবার চেষ্টা করো</button>
            </div>`;
    }
}

// FIX (2026-11-20, S8): load-fail Retry — যে mode-এ খোলা ছিল সেই mode-ই আবার load।
window.retryResultsLoad = () => {
    const id = getParam('id');
    if (id) openTournamentResults(id);
    else openPublishedResults();
};

// List → tournament scoreboard (opens results.html?id=…; back button returns via history)
// (openTournamentResults now centralized in navigation.js)
initPage({
    page: 'results',
    onReady: () => {
        const id = getParam('id');
        if (id) openTournamentResults(id);
        else { _publishedLimit = 20; openPublishedResults(); }
    }
});
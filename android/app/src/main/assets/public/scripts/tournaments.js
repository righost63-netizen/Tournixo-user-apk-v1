// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
// Tournament cards + tournaments page logic.
// • home.js imports buildTournamentCard from here.
// • pages/tournaments.html loads this file directly (data-page="tournaments").
import { initPage } from './app.js';
import { state } from './state.js';
import { showSkeleton } from './modal.js';
import { goTo, getParam } from '../config/app-config.js';
import { formatDateOnly, formatTimeOnly } from '../utils/formatters.js';
// v6: XSS — card fields come from Firestore (admin/staff-written); escape them.
// (escHtml alone is NOT enough inside inline onclick="" — entities decode before
// JS runs — so buttons use data-action/data-tid + listeners instead.)
import { escHtml } from '../utils/escape.js';
import { fetchTournamentList, fetchTournamentListMore, tournamentListMoreAvailable, getTournamentCapacity, ensureCaptainStatusCache, getCaptainStatus } from '../services/tournaments.service.js';
import { showToast } from './toast.js';

// ════════════════════════════════════════════════════════════════
// TOURNAMENT FILTER LOGIC
// FIX (2026-11-19): search removed — browse-only page now (filter tabs
// + mode chips). onTournSearch / tournSearchQuery deleted with it.
// ════════════════════════════════════════════════════════════════

export function setTournFilter(filter, btn) {
    state.tournFilter = filter;
    document.querySelectorAll('#tab-tournaments .filter-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadTournaments();
}

export function filterAndRenderTournaments() {
    const container = document.getElementById('tournaments-list');
    if (!container) return;

    // FIX: a re-render replaces the card DOM, but the countdown registry
    // kept old element-id → start-time entries. The 1s ticker would then
    // find the NEW span (same id) and overwrite its text — e.g. a stale
    // "⏱ 00:00:01" stamped over the LIVE badge. Drop all stale entries
    // before rebuilding the cards.
    clearCardCountdowns();

    let items = state.tournaments || [];
    const statusFilter = state.tournFilter || 'upcoming';

    if (statusFilter !== 'all') {
        items = items.filter(t => t.status === statusFilter);
    }

    if (state.modeFilter) {
        const mf = state.modeFilter.toLowerCase();
        items = items.filter(t =>
            t.gameMode.toLowerCase().includes(mf) ||
            t.teamFormat.toLowerCase().includes(mf) ||
            t.name.toLowerCase().includes(mf)
        );
    }

    if (items.length === 0) {
        // FIX (2026-11-19): per-filter empty message — the old generic
        // "Try changing your search or filter options" was wrong when the
        // search box was empty and Upcoming (the default) was selected.
        // English copy, like the rest of this page's UI (Bengali is for toasts).
        const EMPTY_SUBS = {
            all: 'No tournaments yet',
            upcoming: 'No upcoming tournaments yet — check back soon',
            ongoing: 'No live tournaments right now',
            completed: 'No completed tournaments yet'
        };
        let emptySub = EMPTY_SUBS[statusFilter] || EMPTY_SUBS.all;
        if (state.modeFilter) emptySub += ' — try another mode.';
        const showViewAll = statusFilter !== 'all';
        container.innerHTML = `
            <div class="empty-state">
                <!-- UNSLOP (pass 3): trophy emoji -> 40px line-icon trophy (sized in tournaments.css). -->
                <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg></div>
                <div class="empty-title">No Tournaments Found</div>
                <div class="empty-sub">${escHtml(emptySub)}</div>
                ${showViewAll ? '<button class="btn btn-secondary empty-action" id="empty-view-all">View All Tournaments</button>' : ''}
            </div>`;
        const viewAllBtn = document.getElementById('empty-view-all');
        if (viewAllBtn) {
            viewAllBtn.addEventListener('click', () => {
                const allTab = [...document.querySelectorAll('#tab-tournaments .filter-tab')]
                    .find(b => (b.getAttribute('onclick') || '').includes("'all'"));
                setTournFilter('all', allTab || null);
            });
        }
        renderLoadMoreButton();
        return;
    }

    container.innerHTML = '';

    items.forEach((t, i) => {
        const card = buildTournamentCard(t);
        // FIX (2026-10-25, F-12): stagger cap — 50 কার্ডে 2.5s tail নয়।
        card.style.animationDelay = (Math.min(i, 10) * 0.05) + 's';
        container.appendChild(card);
    });
    renderLoadMoreButton();
}

// FIX (2026-10-25, F-03): Load More বাটন — list container-এর বাইরে
// থাকে (re-render-এ মুছে যায় না), শুধু আরো page থাকলে দেখাবে।
// FIX (2026-11-19): mode filter আর লুকায় না — mode filter client-side,
// fetch করা page state.tournaments-এ append হয় আর filter দিয়ে re-render
// হয়, তাই আরো page থাকলে বাটন দেখাতেই হবে। (Search তুলে দেওয়া হয়েছে,
// তাই search শর্তও আর নেই।)
let _loadMoreBtn = null;
let _loadingMore = false;
function renderLoadMoreButton() {
    const container = document.getElementById('tournaments-list');
    if (!container) return;
    const statusFilter = state.tournFilter || 'upcoming';
    const show = tournamentListMoreAvailable(statusFilter);
    if (!_loadMoreBtn) {
        _loadMoreBtn = document.createElement('button');
        _loadMoreBtn.className = 'btn btn-secondary';
        _loadMoreBtn.style.cssText = 'width:100%;margin:12px 0;';
        _loadMoreBtn.textContent = 'Load More';
        _loadMoreBtn.addEventListener('click', async () => {
            if (_loadingMore) return;
            _loadingMore = true;
            _loadMoreBtn.disabled = true;
            _loadMoreBtn.textContent = 'Loading...';
            try {
                const { items } = await fetchTournamentListMore(state.tournFilter || 'upcoming');
                const seen = new Set((state.tournaments || []).map(t => t.id));
                (state.tournaments || []).push(...items.filter(t => !seen.has(t.id)));
                filterAndRenderTournaments();
            } catch (e) {
                showToast('আরও টুর্নামেন্ট লোড হয়নি। আবার চেষ্টা করো।', 'error');
                _loadMoreBtn.disabled = false;
                _loadMoreBtn.textContent = 'Load More';
            } finally {
                _loadingMore = false;
            }
        });
    }
    if (show) {
        _loadMoreBtn.disabled = false;
        _loadMoreBtn.textContent = 'Load More';
        if (_loadMoreBtn.parentNode !== container.parentNode || _loadMoreBtn.previousElementSibling !== container) {
            container.after(_loadMoreBtn);
        }
    } else {
        _loadMoreBtn.remove();
    }
}

// ════════════════════════════════════════════════════════════════
// LOAD TOURNAMENTS
// ════════════════════════════════════════════════════════════════
export async function loadTournaments(forceRefresh = false) {
    if (state.tournamentsLoading) {
        // A tap during a load must not be lost: remember it and reload with the
        // latest filter as soon as the current load finishes. A force refresh
        // (countdown expiry) stays force on the pending run too.
        state.tournamentsReloadPending = forceRefresh ? 'force' : true;
        return;
    }

    state.tournamentsLoading = true;

    const container = document.getElementById('tournaments-list');

    showSkeleton('tournaments-list');

    try {
        const statusFilter = state.tournFilter || 'upcoming';

        // FIX (2026-11-19): captain-status cache আর list-কে মারতে পারে না —
        // Home fix-এর মতো decouple: list আলাদা await, cache fail হলে শুধু
        // null (Join/captain state ছাড়া list দেখাবে, error state নয়)।
        // forceRefresh=true service cache (45s TTL) bypass করে — countdown
        // শেষ হলে fresh status আনার জন্য লাগে।
        // SLOT-UPDATE (2026-11-20): force refresh-এ captain cache-ও
        // bypass করতে হবে — নইলে list fresh এলেও "Joined"/"Pending"
        // badge 45s পর্যন্ত বাসি থাকত (join-এর ঠিক পরের refresh-এ)।
        const listPromise = fetchTournamentList(statusFilter, forceRefresh);
        const captainPromise = ensureCaptainStatusCache(state.currentUser?.uid, forceRefresh).catch(() => null);
        const list = await listPromise;
        await captainPromise;

        state.tournaments = list;

        filterAndRenderTournaments();

    } catch (err) {

        if (container) {
            container.innerHTML = `
                <div class="empty-state">
                    <!-- UNSLOP (pass 3): warning emoji -> line-icon alert triangle. -->
                    <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
                    <div class="empty-title">টুর্নামেন্ট লোড হয়নি</div>
                    <div class="empty-sub">${escHtml(err.message)}</div>
                    <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryTournamentsLoad()">আবার চেষ্টা করো</button>
                </div>`;
        }

    } finally {
        state.tournamentsLoading = false;
        if (state.tournamentsReloadPending) {
            const force = state.tournamentsReloadPending === 'force';
            state.tournamentsReloadPending = false;
            loadTournaments(force);
        }
    }
}

// ════════════════════════════════════════════════════════════════
// COUNTDOWNS — ONE shared 1s ticker for every card (not one interval per card).
// Cards whose element left the DOM are dropped automatically; the ticker stops
// itself when nothing is left to update.
// ════════════════════════════════════════════════════════════════
const _countdowns = new Map();   // element id → start time (ms)
let _countdownTimer = null;

function formatCountdown(rem) {
    const d = Math.floor(rem / 86400000);
    const h = Math.floor((rem % 86400000) / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    const p = n => String(n).padStart(2, '0');
    // UNSLOP (pass 3): stopwatch emoji prefix removed — the mono timer text is the signature.
    return (d > 0 ? `${d}d ${p(h)}h ${p(m)}m` : `${p(h)}:${p(m)}:${p(s)}`);
}

function tickCountdowns() {
    _countdowns.forEach((startMs, id) => {
        const el = document.getElementById(id);
        if (!el) {
            _countdowns.delete(id);
            return;
        }
        const rem = startMs - Date.now();
        if (rem <= 0) {
            // FIX (2026-11-19): "Starting!"-এ freeze নয় — card-এর state
            // refresh হবে: cache bypass করে list আবার আনা হয়, re-render-এ
            // card-এর আসল (server) status + সঠিক Join বাটন দেখাবে।
            // একসাথে অনেক card expire হলে একবারই refresh (debounce)।
            el.textContent = 'Starting!';
            _countdowns.delete(id);
            scheduleCountdownExpiryRefresh();
            return;
        }
        el.textContent = formatCountdown(rem);
    });
    if (_countdowns.size === 0) stopCountdowns();
}

// FIX (2026-11-19): countdown শেষ হলে force-refresh। শুধু Tournaments
// পেজে — এই ticker home.js-ও share করে (buildTournamentCard), Home-এর
// নিজের refresh এই zip-এর বাইরে, তাই সেখানে পুরনো আচরণই থাকবে।
let _expiryRefreshTimer = null;
function scheduleCountdownExpiryRefresh() {
    if (!document.body || document.body.dataset.page !== 'tournaments') return;
    if (_expiryRefreshTimer) return;
    _expiryRefreshTimer = setTimeout(() => {
        _expiryRefreshTimer = null;
        loadTournaments(true).catch(() => {});
    }, 1500);
}

function stopCountdowns() {
    if (_countdownTimer) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
    }
}

// Called before any card re-render (tournaments page + home page share
// buildTournamentCard): drops stale element-id → start-time entries so the
// 1s ticker can never overwrite a freshly rendered badge.
export function clearCardCountdowns() {
    _countdowns.clear();
    stopCountdowns();
}

function registerCountdown(elId, startMs) {
    _countdowns.set(elId, startMs);
    if (!_countdownTimer) _countdownTimer = setInterval(tickCountdowns, 1000);
}

// Stop while the page is in the background / leaving; resume when it is visible again.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCountdowns();
    else if (_countdowns.size && !_countdownTimer) _countdownTimer = setInterval(tickCountdowns, 1000);
});
window.addEventListener('pagehide', () => { stopCountdowns(); _countdowns.clear(); });

// SLOT-UPDATE (2026-11-20): back/forward cache (bfcache) restore —
// Details/payment পেজ থেকে back এলে page-টা memory থেকে ফেরে, script
// আবার চলে না, 45s service cache-ও বাসি থাকে — join করা tournament-এর
// card-এ পুরনো "X slots left" + Join বাটন দেখাত। persisted restore-এ
// force refresh (list + captain cache দুটোই bypass)।
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    loadTournaments(true).catch(() => {});
});

// FIX (2026-11-20, S8): load-failure-এ Retry — Leaderboard pattern।
window.retryTournamentsLoad = () => { loadTournaments(true).catch(() => {}); };

// ════════════════════════════════════════════════════════════════
// BUILD TOURNAMENT CARD — v8.1 premium layout (presentation only; logic, filters, countdown, join wiring unchanged)
// ════════════════════════════════════════════════════════════════
export function buildTournamentCard(t) {

    const uid = state.currentUser?.uid;

    const cap = getTournamentCapacity(t);

    const isFree =
        t.entryType === 'FREE' ||
        t.entryFee === 0;

    const capStatus =
        uid ? getCaptainStatus(t.id) : null;

    const myStatus =
        capStatus ? capStatus.status : null;

    const legacyJoined =
        uid && (
            (state.userData?.joinedTournaments || []).includes(t.id) ||
            (t.raw.participants || []).includes(uid)
        );

    const isConfirmed =
        myStatus === 'confirmed' ||
        legacyJoined;

    const isPending =
        myStatus === 'pending';

    const isRejected =
        myStatus === 'rejected';

    // FIX (2026-11-19): start time পেরিয়ে গেছে কিন্তু status এখনো
    // 'upcoming' (admin ongoing করেনি) — card-কে started হিসেবে দেখাও,
    // Join আর খোলা নয়। Firestore status বদলানো হয় না — শুধু display।
    // tDateMs/diff এখানে hoist করা হলো — নিচে countdown section-এও লাগে।
    const tDateMs =
        t.dateObj
            ? t.dateObj.getTime()
            : 0;
    const isStartedUpcoming =
        t.status === 'upcoming' && tDateMs > 0 && (tDateMs - Date.now()) <= 0;

    // ─────────────────────────────────────────────
    // BUTTONS
    // ─────────────────────────────────────────────

    let actionBtnHtml = '';

    if (t.status === 'cancelled') {

        actionBtnHtml =
            `<button class="btn btn-secondary btn-sm"
                disabled
                style="color:var(--error); border-color:var(--error);">
                Cancelled
            </button>`;

    } else if (t.status === 'completed') {

        actionBtnHtml =
            `<button class="btn btn-primary btn-sm"
                style="background:var(--accent);color:#0A0B0D;"
                data-action="results"
                data-tid="${escHtml(t.id)}">
                View Results
            </button>`;

    } else if (t.status === 'ongoing') {

        if (isConfirmed) {

            actionBtnHtml =
                `<button class="btn btn-success btn-sm"
                    data-action="room"
                    data-tid="${escHtml(t.id)}">
                    View Room
                </button>`;

        } else {

            actionBtnHtml =
                `<button class="btn btn-secondary btn-sm"
                    disabled
                    style="color:var(--success);">
                    Live
                </button>`;
        }

    } else if (isStartedUpcoming) {

        // FIX (2026-11-19): শুরু হয়ে গেছে — Join বন্ধ (ongoing-এর
        // non-confirmed "Live" বাটনের মতোই)।
        actionBtnHtml = isConfirmed
            ? `<button class="btn btn-success btn-sm"
                    disabled>
                    Joined
                </button>`
            : `<button class="btn btn-secondary btn-sm"
                    disabled
                    style="color:var(--success);">
                    Live
                </button>`;

    } else {

        if (isConfirmed) {

            actionBtnHtml =
                `<button class="btn btn-success btn-sm"
                    disabled>
                    Joined
                </button>`;

        } else if (isPending) {

            actionBtnHtml =
                `<button class="btn btn-sm"
                    style="background:rgba(255,149,0,0.15);
                           color:var(--warning);
                           border:1px solid rgba(255,149,0,0.3);"
                    disabled>
                    Pending
                </button>`;

        } else if (cap.isFull) {

            actionBtnHtml =
                `<button class="btn btn-danger btn-sm"
                    disabled>
                    Full
                </button>`;

        } else {

            actionBtnHtml =
                `<button class="btn-join-card"
                    data-action="join"
                    data-tid="${escHtml(t.id)}">
                    ${isRejected ? 'Join Again' : 'Join'}
                </button>`;
        }
    }

    // ─────────────────────────────────────────────
    // DATE / TIME — তারিখ বদল হলে admin Edit করে dateTime বদলায়,
    // তাই dateObj-ই সবসময় সঠিক start।
    // ─────────────────────────────────────────────

    const displayDateObj = t.dateObj;

    // FIX (#11): show EXACTLY the date/time the admin set (stored dateString /
    // timeString), verbatim on every device — no timezone/device conversion.
    // The converted Date object is only a fallback for legacy docs that have
    // no admin-set strings.
    // FIX (2026-10-25, L8): admin-generated হলেও defense-in-depth —
    // date/time label escape করে render (আগে raw interpolate হতো)।
    // FIX (2026-11-11, L11): date/time না থাকলে "—" নয় — "Date TBD" /
    // "Time TBD" দেখাও।
    const dateStr = escHtml(t.dateLabel || (displayDateObj ? formatDateOnly(displayDateObj) : (t.raw.date || 'Date TBD')));
    const timeStr = escHtml(t.timeLabel || (displayDateObj ? formatTimeOnly(displayDateObj) : (t.raw.time || 'Time TBD')));

    // ─────────────────────────────────────────────
    // COUNTDOWN
    // ─────────────────────────────────────────────

    const cardId =
        'card-' +
        t.id.replace(/[^a-z0-9]/gi, '');

    let countdownHtml = '';

    // tDateMs hoisted above (BUTTONS section) — এখানে শুধু diff।
    const diff =
        tDateMs - Date.now();

    if (
        t.status === 'upcoming' &&
        diff > 0
    ) {

        countdownHtml =
            `<div class="countdown-container"
                id="cd-${cardId}">
                <div class="timer-dot"></div>
                <span class="timer-text"
                    id="ct-${cardId}">
                    Loading...
                </span>
            </div>`;

    } else if (isStartedUpcoming) {

        // FIX (2026-11-19): start time পেরিয়ে গেছে, status এখনো
        // 'upcoming' — "Starting!"-এ freeze নয়, Started strip।
        countdownHtml =
            `<div class="countdown-container"
                style="background:rgba(0,200,83,0.75);">
                <span class="live-badge"><span class="live-dot"></span>Started</span>
            </div>`;

    } else if (t.status === 'ongoing') {

        countdownHtml =
            `<div class="countdown-container"
                style="background:rgba(0,200,83,0.75);">
                <span class="live-badge"><span class="live-dot"></span>LIVE</span>
            </div>`;

    } else if (t.status === 'cancelled') {

        countdownHtml =
            `<div class="countdown-container"
                style="background:rgba(255,69,58,0.85);">
                <span class="timer-text">
                    Cancelled
                </span>
            </div>`;
    }

    // ─────────────────────────────────────────────
    // OPTIONAL BANNER
    //
    // Image exists:
    //     image + countdown
    //
    // Image doesn't exist:
    //     compact countdown only
    //
    // NO TROPHY PLACEHOLDER
    // NO LARGE EMPTY BANNER
    // ─────────────────────────────────────────────

    // v6: banner URL is admin-written — escape it and allow only http(s).
    // (An <img> can't run javascript: URLs, but a broken-out attribute could.)
    const safeBannerUrl = /^https?:\/\//i.test(t.bannerUrl || '') ? t.bannerUrl : '';
        const bannerHtml = safeBannerUrl

        ? `
            <div class="tournament-banner-wrap">
                <img class="tournament-banner" src="${escHtml(safeBannerUrl)}" alt="Banner" loading="lazy">
                ${countdownHtml ? `<div class="banner-countdown-wrap">${countdownHtml}</div>` : ''}
            </div>
          `

        : (countdownHtml
                ? `<div class="card-countdown-strip">${countdownHtml}</div>`
                : '');

    // ─────────────────────────────────────────────
    // CARD
    // ─────────────────────────────────────────────

    const card =
        document.createElement('div');

    card.className =
        'tournament-card';

        card.innerHTML = `

        ${bannerHtml}

        <div class="tournament-body">

            <div class="tournament-title-row">
                <div class="tournament-title">
                    ${escHtml(t.name)}
                </div>
                <span class="badge badge-${isFree ? 'free' : 'paid'} title-fee">
                    ${isFree ? 'FREE' : '₹' + escHtml(t.entryFee)}
                </span>
            </div>

            <!-- FINAL (2026-11-09, approved card redesign): the card holds
                 ONLY name, timer (countdown above), FREE/PAID, slots,
                 date + time, and Details + Join. The badges row
                 (mode/format/map/status) and the Prize + Per Kill boxes
                 moved to the Details view — nothing was deleted from the
                 app. Banner + countdown logic above is unchanged. -->
            <div class="tournament-datetime">
                <div class="dt-item">
                    <span class="dt-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                        </svg>
                    </span>
                    <span class="dt-text"><span class="dt-label">Date</span><span class="dt-val">${dateStr}</span></span>
                </div>
                <div class="dt-item">
                    <span class="dt-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                    </span>
                    <span class="dt-text"><span class="dt-label">Time</span><span class="dt-val">${timeStr}</span></span>
                </div>
            </div>

            ${
                t.maxTeams > 0
                    ? `
                        <div class="slots-bar">
                            <div class="slots-fill ${cap.pct >= 80 ? 'slots-hot' : ''}" style="width:${cap.pct}%"></div>
                        </div>
                        <div class="slots-text">
                            <!-- UNSLOP (pass 3): lock emoji removed — plain "Full". -->
                            <span>${cap.isFull ? 'Full' : `${cap.max - cap.current} slots left`}</span>
                            <span>${cap.isFull ? '' : `${cap.current} / ${cap.max} Joined`}</span>
                        </div>
                      `
                    : ''
            }

            <div class="card-actions">
                <button class="btn btn-secondary btn-sm" data-action="detail" data-tid="${escHtml(t.id)}">Details</button>
                ${actionBtnHtml}
            </div>

        </div>
    `;


    // v6: wire card buttons via data-action (no inline onclick — see XSS note above).
    // window.* fns are centralized in navigation.js / tournaments.js.
    card.querySelectorAll('[data-action]').forEach(btn => {
        const tid = btn.getAttribute('data-tid');
        const action = btn.getAttribute('data-action');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (action === 'detail') window.openTournDetail(tid);
            else if (action === 'results') window.openTournamentResults(tid);
            else if (action === 'room') window.openRoomCredentials(tid);
            else if (action === 'join') window.startTournamentJoin(tid);
        });
    });

    // ─────────────────────────────────────────────
    // COUNTDOWN TIMER
    // ─────────────────────────────────────────────

    if (tDateMs > 0 && t.status === 'upcoming' && diff > 0) {
        registerCountdown(`ct-${cardId}`, tDateMs);
    }

    return card;
}

// ════════════════════════════════════════════════════════════════
// CARD BUTTONS → PAGES (centralized in navigation.js: openTournDetail,
// startTournamentJoin, joinTournament, openTournamentResults)
// ════════════════════════════════════════════════════════════════

window.openRoomCredentials =
    (id) => window.openTournDetail(id);

// FIX (2026-11-19): window.onTournSearch search-এর সাথে তোলা হয়েছে।

window.setTournFilter =
    setTournFilter;

// ════════════════════════════════════════════════════════════════
// PAGE INIT
// ════════════════════════════════════════════════════════════════

const _page =
    document.body &&
    document.body.dataset
        ? document.body.dataset.page
        : null;

if (_page === 'tournaments') {

    const mode =
        getParam('mode');

    if (mode)
        state.modeFilter = mode;

    document.addEventListener(
        'ff:cache-updated',
        (e) => {

            const f =
                e.detail.fields;

            if (
                f.includes('tournaments') ||
                f.includes('rules')
            ) {
                loadTournaments()
                    .catch(() => {});
            }
        }
    );

    initPage({

        page: 'tournaments',

        tab: 'tournaments',

        onReady: () => {
            loadTournaments();
        }

    });
}
import { initPage } from './app.js';
import { state } from './state.js';
import { loadBanners } from './banners.js';
import { cacheGet, cacheSet, cacheIsFresh } from './cache.js';
import { showSkeleton } from './modal.js';
import { buildTournamentCard, clearCardCountdowns } from './tournaments.js';
import { fetchHomeTournaments, ensureCaptainStatusCache } from '../services/tournaments.service.js';
import { fetchGameModes } from '../services/banners.service.js';
import { escHtml } from '../utils/escape.js';
import { listenNotifications, scheduleTournamentReminders } from '../services/notifications.service.js';
import { mountComponent } from '../utils/dom-helpers.js';
import { STORAGE_KEYS, CACHE_TTL } from '../utils/constants.js';
import { goTo, goReplace } from '../config/app-config.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. [x] Line 120: leftover note `// ← ADD THIS LINE`
 *    [ok] সরানো হয়েছে। কোড ইতিমধ্যেই add করা ছিল — শুধু comment টা
 *       থেকে গেছিল, এটা production এ অদ্ভুত দেখায়।
 * 2. [ok] বাকি সব লজিক অপরিবর্তিত — শুধু comment cleanup।
 * ─────────────────────────────────────────────────────────────
 */

const _mounts = Promise.all([
    mountComponent('banner-slider', '#mount-banner-slider'),
    mountComponent('mode-chips', '#mount-mode-chips')
]);

async function loadModeChips(force = false) {
    if (state.modeChipsLoaded && !force) return;
    const container = document.getElementById('mode-chips');
    if (!container) return;
    const CACHE_KEY = STORAGE_KEYS.gameModes,
        CACHE_MS = CACHE_TTL.gameModes;
    const renderChips = (modes) => {
        container.innerHTML = '';
        container.appendChild(createModeChip('All', !state.modeFilter));
        // FIX (Home, 2026-11-19, D1): mode name only — admin gameModes
        // stores `icon` as an emoji by design, and this panel has no SVG
        // icon mapping for modes, so rendering `icon + ' ' + name` put an
        // emoji in the chip (direction: no emoji). createModeChip also
        // strips any emoji that sneaks into the name itself.
        modes.forEach(m => {
            const name = String(m.name || '').replace(/\p{Emoji}/gu, '').trim();
            if (name) container.appendChild(createModeChip(name, false));
        });
    };
    const cached = cacheGet(CACHE_KEY);
    if (cached && Array.isArray(cached.data)) renderChips(cached.data);
    else {
        container.innerHTML = '';
        container.appendChild(createModeChip('All', true));
    }
    if (cached && cacheIsFresh(cached, CACHE_MS) && !force) {
        state.modeChipsLoaded = true;
        return;
    }
    try {
        const modes = await fetchGameModes();
        cacheSet(CACHE_KEY, modes);
        renderChips(modes);
        state.modeChipsLoaded = true;
    } catch (e) {
        if (!cached) {
            state.modeChipsLoaded = false;
            // FIX (Home, 2026-11-19, F2): fetch failed and there is no
            // cache, so the user would only see the "All" chip with no
            // explanation. Show a retry chip instead of failing silently.
            container.appendChild(createModeRetryChip());
        }
    }
}

// FIX (Home, 2026-11-19, F2): retry chip for a failed mode load.
// NOT createModeChip — that one navigates to the Tournaments page.
// This one re-fetches the modes in place.
function createModeRetryChip() {
    const chip = document.createElement('div');
    chip.className = 'mode-chip mode-chip-retry';
    chip.textContent = '↻ Retry';
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', 'Retry loading game modes');
    chip.onclick = () => {
        state.modeChipsLoaded = false;
        loadModeChips(true);
    };
    return chip;
}

function createModeChip(label, isActive) {
    // FIX (Home, 2026-11-19, D1): never render an emoji in a chip —
    // strip any emoji from the label itself too, so even a mode name
    // typed with an emoji in the admin panel shows as clean text.
    const cleanLabel = String(label || '').replace(/\p{Emoji}/gu, '').trim();
    const chip = document.createElement('div');
    chip.className = 'mode-chip' + (isActive ? ' active' : '');
    chip.textContent = cleanLabel;
    chip.onclick = () => {
        document.querySelectorAll('.mode-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const mode = cleanLabel === 'All' ? null : cleanLabel;
        goReplace('tournaments', mode ? { mode } : undefined);
    };
    return chip;
}

// FIX (2026-11-19, v8.11): Home-এর countdown-ও "Starting!"-এ freeze
// হতো — shared ticker (tournaments.js) expiry-তে শুধু Tournaments
// পেজেই force-refetch করে (page guard), Home-এ করে না। তাই Home
// নিজে সবচেয়ে কাছের start time-এ list আবার আঁকবে — re-render-এ
// buildTournamentCard শুরু হয়ে যাওয়া card-এ সবুজ "Started" strip
// + disabled "Live" বাটন দেখাবে (display only, Firestore status
// ছোঁয়া হয় না)। Cache-এর item দিয়েই চলে — render-এর সময়
// Date.now() দিয়ে হিসাব হয়। একবারে একটাই timer; পরের expiry-র
// জন্য re-render-এর পর আবার schedule হয়।
let _homeExpiryTimer = null;
function scheduleHomeExpiryRefresh(items) {
    if (_homeExpiryTimer) { clearTimeout(_homeExpiryTimer); _homeExpiryTimer = null; }
    const now = Date.now();
    let nearest = Infinity;
    (items || []).forEach((t) => {
        if (t.status !== 'upcoming' || !t.dateObj || typeof t.dateObj.getTime !== 'function') return;
        const ms = t.dateObj.getTime();
        if (ms > now && ms < nearest) nearest = ms;
    });
    if (!Number.isFinite(nearest)) return;
    _homeExpiryTimer = setTimeout(() => {
        _homeExpiryTimer = null;
        loadHomeTournaments().catch(() => {});
    }, Math.max(0, nearest - Date.now()) + 1500);
}

async function loadHomeTournaments(force = false) {
    if (state.homeTournamentsLoading) return;
    const container = document.getElementById('home-tournaments');
    if (!container) return;
    state.homeTournamentsLoading = true;
    showSkeleton('home-tournaments');
    try {
        // FIX (Home, 2026-11-19, F1): the captain-status cache must never
        // kill the tournament list. Before, Promise.all([list, cache])
        // showed "Failed to load" when the cache threw, even though the
        // list had loaded fine. Now both start together, the list is
        // awaited on its own, and a cache failure is swallowed — cards
        // read the cache via getCaptainStatus() at render time, so at
        // worst a captain badge is missing, never the whole list.
        // SLOT-UPDATE (2026-11-20): force=true হলে 45s service cache +
        // captain cache দুটোই bypass — bfcache restore-এ join-এর পরের
        // fresh filled count + Joined badge দেখাতে লাগে।
        const listPromise = fetchHomeTournaments(force);
        const captainPromise = ensureCaptainStatusCache(state.currentUser?.uid, force).catch(() => null);
        const items = await listPromise;
        await captainPromise;
        if (items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <!-- UNSLOP (pass 3): trophy emoji -> 40px line-icon trophy (sized in home.css). -->
                    <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg></div>
                    <div class="empty-title">এখনো কোনো টুর্নামেন্ট নেই</div>
                    <div class="empty-sub">নতুন টুর্নামেন্ট এলে এখানে দেখাবে।</div>
                </div>`;
            scheduleHomeExpiryRefresh([]);
            return;
        }
        container.innerHTML = '';
        clearCardCountdowns();
        items.forEach(t => { container.appendChild(buildTournamentCard(t)); });
        scheduleHomeExpiryRefresh(items);
    } catch (e) {
        container.innerHTML = `
            <div class="empty-state">
                <!-- UNSLOP (pass 3): warning emoji -> line-icon alert triangle. -->
                <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
                <div class="empty-title">লোড হয়নি</div>
                <div class="empty-sub">${escHtml(e.message)}</div>
                <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryHomeLoad()">আবার চেষ্টা করো</button>
            </div>`;
        scheduleHomeExpiryRefresh([]);
    } finally {
        state.homeTournamentsLoading = false;
    }
}

function loadHome() {
    loadBanners();
    loadModeChips();
    loadHomeTournaments();
    setTimeout(scheduleTournamentReminders, 1500);
}

document.addEventListener('ff:cache-updated', (e) => {
    const f = e.detail.fields;
    if (f.includes('banners')) loadBanners().catch(() => {});
    if (f.includes('gameModes')) loadModeChips(true).catch(() => {});
    if (f.includes('tournaments') || f.includes('rules')) loadHomeTournaments().catch(() => {});
});

// SLOT-UPDATE (2026-11-20): back/forward cache (bfcache) restore —
// Details/payment পেজ থেকে back এলে Home memory থেকে ফেরে, script
// আবার চলে না, 45s service cache-ও বাসি থাকে — join করা tournament-এর
// card-এ পুরনো "X slots left" + Join বাটন দেখাত। persisted restore-এ
// force refresh (list + captain cache দুটোই bypass)।
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    loadHomeTournaments(true).catch(() => {});
});

// FIX (2026-11-20, S8): load-failure-এ Retry — Leaderboard pattern।
window.retryHomeLoad = () => { loadHomeTournaments(true).catch(() => {}); };

window.navToNotifications = () => goTo('notifications');
window.goToTournaments = () => goTo('tournaments');

initPage({
    page: 'home',
    tab: 'home',
    onReady: async (user) => {
        await _mounts;
        loadHome();
        listenNotifications(user.uid);
        // v8.12: web push prompt তোলা — APK-তে permission নেটিভ
        // dialog-এ চাওয়া হয় (verification dialog / Profile toggle)।
    }
});
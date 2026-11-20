// ════════════════════════════════════════════════════════════════
// Page bootstrap. EVERY page calls initPage() once from its own script.
// ════════════════════════════════════════════════════════════════
import { renderHomeAvatar } from '../services/profile-photo.service.js';
import { auth, db, onAuthStateChanged, signOut, reload, doc, getDoc, onSnapshot } from '../firebase/firebase-init.js';
import { APP_CONFIG, PUBLIC_PAGES, OPEN_PAGES, TAB_PAGES, goReplace } from '../config/app-config.js';
import { state } from './state.js';
import { initTheme } from './theme.js';
import { initNetworkMonitoring } from './network.js';
// FIXED: showToast আগে unused import ছিল (line 17); এখন সত্যিই
//    notifyUnexpectedError() এ ব্যবহার হচ্ছে — তাই import টা রাখা ঠিক।
import { showToast, flashToast, showPendingFlash } from './toast.js';
// v8.6 (G): বাকি English toast-গুলোও সহজ পেশাদার বাংলায় করা হয়েছে — app-র English toast বাংলায়
import './modal.js';
import { setActiveTab, redirectToHome, redirectToLogin, wireTabPrefetch } from './navigation.js';
import { syncAppConfigCache, isEmailVerifiedThisSession, markEmailVerifiedThisSession, readSessionUser, writeSessionUser, clearSessionUser } from './cache.js';
import { reportCoreFailure } from './backend-failure.js';
import { setLoading, mountComponent } from '../utils/dom-helpers.js';
import { getInitials } from '../utils/formatters.js';
import { initOneSignal, oneSignalLogin } from '../services/onesignal.service.js';
import { refreshUserData, setPendingVerifyEmail } from '../services/auth.service.js';
import { invalidateTournamentCaches } from '../services/tournaments.service.js';
// v8.6 (C, device ban — mirrors admin BUILD 31): session-restore
// device check (fail open) + the shared ban message.
import { getOrCreateDeviceId, isDeviceBanned, DEVICE_BANNED_MESSAGE } from '../services/device-ban.js';
import { listenMaintenanceMode } from '../services/settings.service.js';
import { armReminders, listenNotifications } from '../services/notifications.service.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. Unused import `showToast` (line 17)
 *    আসলে এটা unused ছিল না — `notifyUnexpectedError()` এ ব্যবহার
 *    হচ্ছে। কিন্তু list এ flagged ছিল, তাই double-check করে
 *    নিশ্চিত করলাম এবং এখানে রেখে দিলাম।
 *    যদি সত্যিই unused হয়ে থাকে কোনো refactor এ, তাহলে remove করো।
 * 2. `getInitials` import রাখা হলো — এই file এ সরাসরি ব্যবহার না
 *    হলেও refreshUserUI() এর refactor এ দরকার হতে পারে। যদি না লাগে,
 *    remove করো।
 * ─────────────────────────────────────────────────────────────
 */

/*
 * ─────────────────────────────────────────────────────────────
 * WINNING BALANCE INVARIANT — Winning Money must NEVER exceed Earned Money.
 * Prize publishing increments both walletBalance and totalEarnings together,
 * and withdrawals only reduce walletBalance, so walletBalance > totalEarnings
 * can only come from bad/legacy data or a manual edit. Every balance display
 * and every withdraw gate in the app goes through this helper, so the app
 * can never show — or let the user spend — more than was actually earned.
 * (Data repair for already-inconsistent docs is an admin-panel job.)
 * ─────────────────────────────────────────────────────────────
 */
export function effectiveWinningBalance(u) {
    const wallet = Number(u?.walletBalance || 0);
    const earned = Number(u?.totalEarnings || 0);
    return Math.max(0, Math.min(wallet, earned));
}

// WALLET (2026-11-07): Deposit Balance is a SEPARATE pot from winnings.
// Top-up money is entry-fee only and is NEVER clamped by totalEarnings
// (the clamp above exists because winnings must never exceed what was
// earned) and NEVER counts toward totalEarnings or the leaderboard.
export function effectiveDepositBalance(u) {
    return Math.max(0, Number(u?.depositBalance || 0));
}

export function refreshUserUI() {
    const u = state.userData;
    if (!u) return;

    // Winning Balance must never exceed lifetime Earned Money — the clamp
    // lives in effectiveWinningBalance() so every screen agrees.
    const winBal = effectiveWinningBalance(u);
    // WALLET (2026-11-07): Deposit Balance + lifetime deposited, both
    // display-only here (values are numbers only — the ₹ lives in the HTML).
    const depBal = effectiveDepositBalance(u);
    const totDep = Math.max(0, Number(u?.totalDeposited || 0));

    const name = (u.name || '').split(' ')[0];
    const els = {
        'home-greeting': `Hey, ${name}`,
        'home-balance': `${winBal.toFixed(2)}`,
        'stat-joined': (u.joinedTournaments || []).length,
        'stat-wins': u.totalWins || 0,
        'stat-earnings': `₹${Number(u.totalEarnings || 0).toFixed(0)}`,
        'profile-name-big': u.name || '—',
        'prf-stat-tournaments': (u.joinedTournaments || []).length,
        'prf-stat-wins': u.totalWins || 0,
        'prf-stat-winning': `₹${winBal.toFixed(2)}`,
        'wallet-balance-amt': `${winBal.toFixed(2)}`,
        'wallet-balance-amt2': `${winBal.toFixed(2)}`,
        'deposit-balance-amt': `${depBal.toFixed(2)}`,
        'total-deposited-amt': `${totDep.toFixed(2)}`,
        'withdraw-available': `₹${winBal.toFixed(2)}`
    };

    Object.entries(els).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    });

    const puid = document.getElementById('profile-uid-big');
    if (puid) puid.innerHTML = `<span class="prf-meta-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg></span>UID: ${u.ffUID || '—'}`;

    const pearn = document.getElementById('profile-earn-big');
    if (pearn) pearn.innerHTML = `<span class="prf-meta-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg></span>₹${Number(u.totalEarnings || 0).toFixed(0)} Lifetime Earned`;

    renderHomeAvatar(document.getElementById('profile-avatar-big'), u, 192);
    renderHomeAvatar(document.getElementById('home-avatar'), u);
}
window.refreshUserUI = refreshUserUI;

export function hideSplash(next) {
    const splash = document.getElementById('screen-splash');
    if (!splash) { next(); return; }
    splash.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    splash.style.opacity = '0';
    splash.style.transform = 'scale(1.05)';
    setTimeout(() => {
        splash.classList.remove('active');
        splash.style.display = 'none';
        next();
    }, 600);
}

let _serviceWorkerRegisterStarted = false;

function registerMainServiceWorker() {
    if (_serviceWorkerRegisterStarted || !('serviceWorker' in navigator)) return;
    _serviceWorkerRegisterStarted = true;

    // app.js lives in /scripts, while the merged OneSignal + cache worker is
    // the single root /sw.js. Resolving from this module keeps registration
    // working from index.html and every /pages/*.html bootstrap.
    const register = () => {
        navigator.serviceWorker
            .register(new URL('../sw.js', import.meta.url).href)
            .catch(() => {});
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
}

function setAuthPending(on) {
    if (on && !document.getElementById('ff-auth-pending-style')) {
        const s = document.createElement('style');
        s.id = 'ff-auth-pending-style';
        s.textContent = 'html.auth-pending body{visibility:hidden}';
        document.head.appendChild(s);
    }
    document.documentElement.classList.toggle('auth-pending', on);
}

function domReady() {
    return document.readyState === 'loading' ?
        new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true })) :
        Promise.resolve();
}

const ERROR_TOAST_GAP_MS = 6000;
let _lastErrorToastAt = 0;

function notifyUnexpectedError() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const now = Date.now();
    if (now - _lastErrorToastAt < ERROR_TOAST_GAP_MS) return;
    _lastErrorToastAt = now;
    showToast('কিছু একটা ভুল হয়েছে। আবার চেষ্টা করো।', 'error', 4000);
}

function showPageError() {
    if (document.getElementById('ff-error-screen')) return;
    const wrap = document.createElement('div');
    wrap.id = 'ff-error-screen';
    wrap.setAttribute('role', 'alert');
    wrap.innerHTML = `
        <div class="ff-error-card">
            <div class="ff-error-ic"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
            <div class="ff-error-title">Something went wrong</div>
            <div class="ff-error-text">This page could not load properly. Please try again.</div>
            <div class="ff-error-actions">
                <button type="button" class="btn btn-secondary" data-act="dismiss">Dismiss</button>
                <button type="button" class="btn btn-primary" data-act="retry">Retry</button>
            </div>
        </div>`;
    wrap.querySelector('[data-act="retry"]').onclick = () => window.location.reload();
    wrap.querySelector('[data-act="dismiss"]').onclick = () => wrap.remove();
    document.body.appendChild(wrap);
}

// FIX (2026-10-25, F-20): visibility ফেরা + online event একসাথে এলে
// user doc + appConfig দুইবার forced read হতো। এখন 2s debounce-এ
// একবার coalesce হবে (live user-doc listener এমনিতেই চলে, এটা শুধু
// safety refresh)।
let _reconnectTimer = null;
function scheduleReconnectRefresh() {
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        if (!state.currentUser) return;
        refreshUserData(true);
        syncAppConfigCache(true);
    }, 2000);
}

function wireVisibility() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            document.body.classList.add('app-paused');
        } else {
            document.body.classList.remove('app-paused');
            if (state.currentUser) scheduleReconnectRefresh();
        }
    });
    window.addEventListener('network-status', (e) => {
        if (e.detail && e.detail.online && state.currentUser) {
            scheduleReconnectRefresh();
        }
    });
}

// U1: exactly one live user-doc listener per page session. It is stopped on
// logout, ban and auth change so listeners never stack across pages/users.
let _userDocUnsub = null;
let _userDocRetryTimer = null;
function stopUserDocListener() {
    if (_userDocUnsub) {
        try { _userDocUnsub(); } catch (e) {}
        _userDocUnsub = null;
    }
    // FIX (2026-10-25, F-15): stop-এর সাথে pending retry-ও clear — নইলে
    // logout/ban-এর পর timer leak হয়ে stale attach চেষ্টা করত।
    if (_userDocRetryTimer) {
        clearTimeout(_userDocRetryTimer);
        _userDocRetryTimer = null;
    }
}

export async function initPage({
    page = 'index',
    tab = null,
    onReady = null
} = {}) {
    const isIndex = page === 'index';
    const isPublic = PUBLIC_PAGES.includes(page);
    const canViewLoggedOut = isPublic || OPEN_PAGES.includes(page);
    state.page = page;
    state.currentTab = tab || page;

    // v7.3: প্রতিটা page সবসময় উপর থেকে খুলবে। Browser-এর scroll
    // restoration মাঝে মাঝে আগের page-এর scroll position ফিরিয়ে এনে
    // page-কে মাঝখান থেকে খুলে দিত (উপরের অংশ কাটা দেখাত) — সেটা বন্ধ।
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);

    if (!isIndex) setAuthPending(true);
    await domReady();

    initTheme(); // dark-only: wipes any stale light preference
    initNetworkMonitoring();
    registerMainServiceWorker();

    const host = document.getElementById('app') || document.body;
    try {
        if (isIndex) await mountComponent('splash-screen', host);
        await mountComponent('toast', host);
        await mountComponent('confirm-dialog', host);
        if (tab) {
            await mountComponent('bottom-nav', host.querySelector('.screen') || host);
            setActiveTab(tab);
            wireTabPrefetch();
        }
    } catch (e) {
        console.error('[Components]', e);
    }

    initOneSignal();
    listenMaintenanceMode();
    wireVisibility();

    const markReady = () => {
        setAuthPending(false);
        // v7.3: content দেখানোর মুহূর্তে scroll-area আবার একদম উপরে
        document.querySelectorAll('.scroll-area').forEach((el) => { el.scrollTop = 0; });
        showPendingFlash();
    };

    const runReady = async (user) => {
        try {
            if (onReady) await onReady(user, state.userData);
        } catch (e) {
            console.error('[onReady]', e);
            showPageError();
        }
    };

    const onLoggedOut = async () => {
        if (isIndex) return hideSplash(redirectToLogin);
        if (canViewLoggedOut) { markReady(); await runReady(null); return; }
        redirectToLogin();
    };

    const onLoggedIn = async (user) => {
        if (isPublic) {
            if (isIndex) hideSplash(redirectToHome);
            else redirectToHome();
            return;
        }
        markReady();
        syncAppConfigCache();
        // The shared main-page header carries the notification bell on all
        // five tabs; its existing guarded listener keeps the badge current.
        if (TAB_PAGES.includes(state.currentTab)) listenNotifications(user.uid);
        armReminders();
        await runReady(user);
    };

    onAuthStateChanged(auth, async (user) => {
        setLoading('login-btn', false);
        setLoading('reg-btn', false);
        state.authResolved = true;

        if (state.registering) { state.currentUser = user; return; }

        if (!user) {
            stopUserDocListener();
            state.currentUser = null;
            state.userData = null;
            return onLoggedOut();
        }

        // v8.6 (F): email verification is enforced again. An unverified
        // user is gated out of Home/Tournaments/Wallet (and every other
        // app page except the Verify page itself and the public reading
        // pages Terms/Help) — they are sent to the Verify page, which
        // polls reload(user) and routes Home once verified. The pending
        // email is persisted in localStorage so reopening the app before
        // verifying shows the Verify page again, not a plain login.
        // NOTE: the Verify page (pages/verify-email.html) does not run
        // initPage(), so this listener never fires there — no loop.
        if (!user.emailVerified && !isEmailVerifiedThisSession()) {
            setPendingVerifyEmail(user.email || '');
            try { sessionStorage.setItem('verify_email', user.email || ''); } catch (_) {}
            if (page !== 'verify-email' && page !== 'verifyEmail' && !OPEN_PAGES.includes(page)) {
                goReplace('verify-email');
                return;
            }
        } else {
            markEmailVerifiedThisSession();
        }

        state.currentUser = user;

        // v8.6 (C, device ban — mirrors admin BUILD 31 navigation.js
        // session-restore guard): a banned device must not stay signed in
        // with a live session. Checked here on every session restore (and
        // right after login, since this auth listener fires for that too),
        // with the same ban message as login/register. Fail-open:
        // isDeviceBanned() returns false when the read fails (no
        // bannedDevices rule in firestore.rules v18 yet), so a missing
        // rules block never signs everyone out. state.registering
        // sessions return above, so this never fires mid-registration.
        if (await isDeviceBanned(getOrCreateDeviceId())) {
            stopUserDocListener();
            flashToast(DEVICE_BANNED_MESSAGE + ' সহায়তার জন্য যোগাযোগ করুন।', 'error', 6000);
            clearSessionUser(user.uid);
            state.currentUser = null;
            state.userData = null;
            signOut(auth).catch(() => {});
            return;
        }

        // 2. Instant first paint from the session user cache (stale-while-revalidate)…
        const cachedUser = readSessionUser(user.uid);
        if (cachedUser) {
            state.userData = cachedUser;
            state.userDataCacheAt = Date.now();
            try { refreshUserUI(); } catch (e) {}
        }

        // …then follow the user doc LIVE in the background — never blocks render.
        // U1: an onSnapshot listener (not a one-time getDoc) keeps the header,
        // Wallet and Profile balances current within a second of an admin
        // approve or a prize credit, without reopening the app. Critical
        // actions (withdrawals, joins, payments) still re-read Firestore
        // inside their own transactions, so this is display-only.
        stopUserDocListener();
        const applyUserDoc = (data) => {
            if (state.currentUser?.uid !== user.uid) return; // user switched meanwhile
            if (data.isBanned === true || data.status === 'banned') {
                stopUserDocListener();
                flashToast('আপনার অ্যাকাউন্টটি স্থগিত (Ban) করা হয়েছে। সহায়তার জন্য যোগাযোগ করুন।', 'error', 6000);
                clearSessionUser(user.uid);
                state.currentUser = null;
                state.userData = null;
                signOut(auth).catch(() => {});
                return;
            }
            // SLOT-UPDATE (2026-11-20): joinedTournaments বাড়ল মানে এই
            // user এইমাত্র join করেছে (FREE txn + PAID instant join
            // দুটোতেই arrayUnion লেখে) — tournament list / home list /
            // captain-status cache খালি করো, যাতে পরের load-এ fresh
            // filled count + Join/Confirmed state আসে। Balance/prize
            // update-এ (joinedTournaments না বদলালে) cache ছোঁয়া হয় না।
            const prevJoined = state.userData?.joinedTournaments;
            if (Array.isArray(prevJoined) && Array.isArray(data.joinedTournaments)
                && data.joinedTournaments.length > prevJoined.length) {
                invalidateTournamentCaches();
            }
            state.userData = data;
            state.userDataCacheAt = Date.now();
            writeSessionUser(user.uid, data);
            try { refreshUserUI(); } catch (e) {}
            // U2 hook: keep the Wallet pending-approval note in sync.
            if (typeof window.refreshPendingWithdrawal === 'function') {
                try { window.refreshPendingWithdrawal(); } catch (e) {}
            }
            // WALLET (2026-11-07): same hook for the pending-deposit note.
            if (typeof window.refreshPendingDeposit === 'function') {
                try { window.refreshPendingDeposit(); } catch (e) {}
            }
            // INSTANT SLOT BOOKING (v8.3): payment page-এর balance summary
            // + Confirm/Add-Money state live রাখা — user doc দেরিতে এলে
            // বা deposit approve হলে section-টা refresh হবে।
            if (typeof window.refreshInstantWalletSection === 'function') {
                try { window.refreshInstantWalletSection(); } catch (e) {}
            }
            // CARD REDESIGN (2026-11-09): same hook for the card face —
            // the card number (FF UID) and cardholder name come from the
            // user doc, so a cold load with no session cache still fills
            // them when the live listener first fires.
            if (typeof window.refreshWalletCardIdentity === 'function') {
                try { window.refreshWalletCardIdentity(); } catch (e) {}
            }
        };
        // FIX (2026-10-25, F-15): listener error-এ আগে fallback getDoc-এর
        // পর listener চিরতরে মরে যেত (balance stale)। এখন একবার 30s
        // backoff-এ re-attach চেষ্টা হবে — retry loop নয়।
        const attachUserDocListener = () => {
            stopUserDocListener();
            _userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
                if (!snap || !snap.exists()) return;
                applyUserDoc(snap.data());
            }, (e) => {
                console.warn('Live user listener failed, falling back to one-time read:', e.message);
                // FIX (2026-10-25, Backend Failure Dialog): core doc-এর
                // permission/config failure হলে dialog-কে জানানো হবে
                // (সাধারণ room denial এখানে আসে না)।
                reportCoreFailure(e);
                stopUserDocListener();
                getDoc(doc(db, 'users', user.uid)).then((snap) => {
                    if (snap && snap.exists()) applyUserDoc(snap.data());
                }).catch((err) => {
                    console.warn('Auth user check failed:', err.message);
                    reportCoreFailure(err);
                });
                if (_userDocRetryTimer) clearTimeout(_userDocRetryTimer);
                _userDocRetryTimer = setTimeout(() => {
                    _userDocRetryTimer = null;
                    if (state.currentUser?.uid === user.uid && !_userDocUnsub) attachUserDocListener();
                }, 30000);
            });
        };
        attachUserDocListener();

        oneSignalLogin(user.uid);
        await onLoggedIn(user);
    });

    setTimeout(() => {
        if (state.authResolved) return;
        if (isIndex) hideSplash(redirectToLogin);
        else if (canViewLoggedOut) markReady();
        else redirectToLogin();
    }, APP_CONFIG.splashFallbackMs);
}

window.addEventListener('error', e => {
    console.error('[Error]', e.message, '@', e.filename, e.lineno);
    if (!e.message || /ResizeObserver/i.test(e.message)) return;
    if (e.filename && !e.filename.startsWith(window.location.origin)) return;
    notifyUnexpectedError();
});

window.addEventListener('unhandledrejection', e => {
    console.error('[Promise]', e.reason);
    const r = e.reason;
    // v8.12: /onesignal/i filter তোলা — web OneSignal কোড আর নেই।
    if (r == null || r.name === 'AbortError') return;
    notifyUnexpectedError();
});
// ════════════════════════════════════════════════════════════════
// v6.1: REAL PWA install (Chrome → "Install app", not a shortcut).
// Captures beforeinstallprompt, reveals the Profile → Install App row,
// and fires the real install dialog on tap.
// Requirements (all met): HTTPS, manifest (id/icons/standalone),
// service worker with fetch handler, icons 192+512+maskable.
// ════════════════════════════════════════════════════════════════
let _installPromptEvent = null;

function syncInstallRow() {
    const row = document.getElementById('install-app-row');
    if (!row) return;
    // Hide if already installed (standalone) or no prompt available.
    const installed =
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;
    row.style.display = (!installed && _installPromptEvent) ? '' : 'none';
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we trigger it from the Install App row instead
    _installPromptEvent = e;
    syncInstallRow();
});

window.addEventListener('appinstalled', () => {
    _installPromptEvent = null;
    syncInstallRow();
    if (window.showToast) window.showToast('Tournixo ইনস্টল হয়েছে!', 'success', 3000);
});

window.installTournixoApp = async () => {
    if (!_installPromptEvent) {
        if (window.showToast) window.showToast('Chrome-এ এই পেজ খুলে ⋮ মেনু থেকে "Install app" চাপো', 'info', 4000);
        return;
    }
    _installPromptEvent.prompt();
    await _installPromptEvent.userChoice.catch(() => {});
    _installPromptEvent = null;
    syncInstallRow();
};

// Re-check when the profile page renders (row may not exist on other pages).
window.addEventListener('page-ready', syncInstallRow);
document.addEventListener('DOMContentLoaded', () => setTimeout(syncInstallRow, 500));

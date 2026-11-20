// ─────────────────────────────────────────────────────────────
// OneSignal — v8.12 APK-ready (2026-11-20): NATIVE-ONLY, Capacitor bridge.
// ─────────────────────────────────────────────────────────────
// আগের সব OneSignal web কোড বাদ (web JS SDK, onesignal-cordova-plugin,
// services/onesignal-native.js, config/onesignal-config.js — সব মুছে
// দেওয়া হয়েছে)। এই ফাইলটাই JS-এর একমাত্র OneSignal রাস্তা, আর এটা
// সরাসরি OneSignal SDK-কে ডাকে না — শুধু Android-এর নেটিভ ব্রিজ
// প্লাগইন (OneSignalBridge, android/.../OneSignalPlugin.java) কে ডাকে,
// যেটা আবার OneSignalManager.java-র ভেতর দিয়ে নেটিভ Android SDK
// (5.9.2) চালায়। App ID native কোডে থাকে (OneSignalManager.APP_ID) —
// এই ফাইলে কোনো App ID নেই।
//
// ওয়েবে (workers.dev) remote push আর নেই — web JS SDK তুলে দেওয়া
// হয়েছে। ওয়েবে toggle শুধু পছন্দ (pref) সেভ করে; অ্যাপের ভেতরের
// নোটিফিকেশন (Notifications পেজ) Firestore দিয়ে আগের মতোই চলে।
// Remote push শুধু APK-তে আসে।
//
// Permission কখনো নিজে থেকে চাওয়া হয় না — শুধু দুটো জায়গায়, user
// নিজে tap করলে: (১) প্রথমবারের নেটিভ verification dialog-এ "Got it",
// (২) Profile-এর Notifications toggle ON করলে।
//
// Notification tap routing (v8.12, 2026-11-20): tap করলে শুধু
// Notifications পেজ না — additionalData-র view/tid দেখে নির্দিষ্ট
// screen-এ যায় (নিচে routeNotificationClick দেখো)। Native দিক
// (OneSignalPlugin.consumeNotificationClick) এখন শুধু {clicked}
// ফেরায়, তাই consume পথে আজ শুধু Notifications পেজ খোলে; native
// যখন result-এ view/tid দেবে, তখন routing নিজে থেকেই চলবে। আর
// window.handleNotificationClick(data) global-টা native সরাসরি
// ডাকতে পারে (evaluateJavascript) — অ্যাপ খোলা থাকলে tap-এও routing
// হবে। Admin-কে push পাঠানোর সময় data: {view, tid} দিতে হবে —
// নাহলে route করার মতো কিছু থাকবে না।
// ─────────────────────────────────────────────────────────────
import { STORAGE_KEYS } from '../utils/constants.js';
import { state } from '../scripts/state.js';
import { goTo } from '../config/app-config.js';

const __DEV__ = false;
const log = (...args) => { if (__DEV__) console.log(...args); };
const warn = (...args) => { if (__DEV__) console.warn(...args); };

let _initStarted = false;
let _toggleBusy = false;

// Capacitor native (APK) কিনা — web-এ false।
export function isCapacitorNative() {
    try {
        if (typeof window !== 'undefined' && window.Capacitor) {
            if (typeof window.Capacitor.isNativePlatform === 'function') return window.Capacitor.isNativePlatform();
            if (typeof window.Capacitor.getPlatform === 'function') return window.Capacitor.getPlatform() !== 'web';
            return true;
        }
    } catch (e) {}
    return false;
}

// নেটিভ ব্রিজ প্লাগইন (MainActivity-তে registerPlugin করা)।
function bridge() {
    try {
        return window.Capacitor?.Plugins?.OneSignalBridge || null;
    } catch (e) { return null; }
}

function savePref(value) {
    try { localStorage.setItem(STORAGE_KEYS.notifications, value); } catch (e) {}
}

function savedPrefIsOn() {
    try { return localStorage.getItem(STORAGE_KEYS.notifications) === 'on'; }
    catch (e) { return false; }
}

function setToggle(el, on) {
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function showToast(msg, type, ms) {
    try {
        if (typeof window.showToast === 'function') window.showToast(msg, type || 'info', ms || 3500);
    } catch (e) {}
}

// Notification tap → কোন screen-এ যাবে (view/tid অনুযায়ী)।
// view: 'tournament' / 'room' (+ tid) → Details পেজ; 'wallet' /
// 'matches' / 'results' / 'notifications' ইত্যাদি → সেই পেজ; কিছু
// না থাকলে Notifications পেজ (আগের আচরণ)।
const NOTIF_PAGES = new Set(['notifications', 'wallet', 'matches', 'results', 'tournaments', 'home', 'profile', 'my-team', 'leaderboard', 'account-settings', 'help-support', 'rules', 'terms']);

export function routeNotificationClick(data) {
    const raw = data || {};
    // OneSignal additionalData কখনো data-র ভেতরে, কখনো সরাসরি আসে।
    const merged = (raw.data && typeof raw.data === 'object') ? { ...raw.data, ...raw } : raw;
    const view = String(merged.view || '').trim();
    const tid = String(merged.tid || merged.tournamentId || '').trim();
    try {
        if (tid && (view === 'tournament' || view === 'room' || view === 'tournament-details' || !view)) {
            goTo('tournament-details', { id: tid });
            return;
        }
        if (view && NOTIF_PAGES.has(view)) {
            goTo(view);
            return;
        }
    } catch (e) {}
    try { goTo('notifications'); } catch (e) {}
}

// Native সরাসরি ডাকতে পারে: window.handleNotificationClick({view, tid})।
window.handleNotificationClick = (data) => {
    try { routeNotificationClick(data); } catch (e) {}
};

// App চালু হলে একবার — নেটিভ SDK Application-এ আগেই init হয়ে গেছে
// (TournixoApplication.onCreate)। এখানে শুধু: ব্রিজ আছে কিনা দেখো,
// আর notification-এ tap করে অ্যাপ খুললে সেই notification-এর screen-এ যাও।
export function initOneSignal() {
    if (_initStarted) return;
    _initStarted = true;
    if (!isCapacitorNative()) return; // web-এ কিছু করার নেই

    // Notification tap → app খুলেছে: একবারই route করো (view/tid
    // থাকলে নির্দিষ্ট screen, নাহলে Notifications পেজ)।
    try {
        const b = bridge();
        if (b && typeof b.consumeNotificationClick === 'function') {
            b.consumeNotificationClick().then(res => {
                if (res && res.clicked === true) {
                    routeNotificationClick(res);
                }
            }).catch(() => {});
        }
    } catch (e) {}
    syncNotifToggleUI();
}

// Profile toggle-এর অবস্থা — native-এ আসল subscription দেখে,
// web-এ শুধু সেভ করা পছন্দ দেখে (web-এ remote push নেই)।
export function syncNotifToggleUI() {
    const el = document.getElementById('notif-toggle');
    if (!el) return;

    if (!isCapacitorNative()) {
        setToggle(el, savedPrefIsOn());
        return;
    }
    const b = bridge();
    if (!b || typeof b.isSubscribed !== 'function') {
        setToggle(el, savedPrefIsOn());
        return;
    }
    b.isSubscribed().then(res => {
        setToggle(el, !!(res && res.subscribed === true));
    }).catch(() => setToggle(el, savedPrefIsOn()));
}

// Profile → Notifications toggle (onclick="toggleNotifications(this)")।
export async function toggleNotifications(el) {
    if (_toggleBusy) return;
    _toggleBusy = true;
    try {
        const turningOn = !el.classList.contains('on');

        if (!turningOn) {
            savePref('off');
            setToggle(el, false);
            showToast('নোটিফিকেশন বন্ধ হয়েছে', 'info', 2000);
            if (isCapacitorNative()) {
                try { await bridge()?.optOut?.(); } catch (e) {}
            }
            return;
        }

        // ── ON ──
        if (!isCapacitorNative()) {
            // ওয়েবে remote push নেই — শুধু পছন্দ সেভ হলো, ভান করা হচ্ছে না।
            savePref('on');
            setToggle(el, true);
            showToast('পছন্দ সেভ হয়েছে। রিমোট পুশ শুধু APK-তে আসবে — এখানে অ্যাপের ভেতরের নোটিফিকেশন চলবে।', 'info', 5000);
            return;
        }

        const b = bridge();
        if (!b || typeof b.requestPermission !== 'function') {
            savePref('off');
            setToggle(el, false);
            showToast('নোটিফিকেশন চালু হয়নি — APK-তে OneSignal ব্রিজ পাওয়া যায়নি।', 'warning', 4000);
            return;
        }

        // User নিজে toggle চাপল — তাই OS permission sheet আসবে (Android 13+)।
        await b.requestPermission();
        const uid = state.currentUser?.uid;
        if (uid && typeof b.login === 'function') {
            try { await b.login({ externalId: uid }); } catch (e) {}
        }
        // আসল subscription না হলে ON দেখানো হবে না (আগের fake-success আর নয়)।
        let subscribed = false;
        try {
            const res = await b.isSubscribed();
            subscribed = !!(res && res.subscribed === true);
        } catch (e) {}
        if (!subscribed) {
            // একটু দেরিতে subscription তৈরি হতে পারে — ১.৫ সেকেন্ড পর আবার দেখো।
            await new Promise(r => setTimeout(r, 1500));
            try {
                const res = await b.isSubscribed();
                subscribed = !!(res && res.subscribed === true);
            } catch (e) {}
        }
        if (!subscribed) {
            savePref('off');
            setToggle(el, false);
            showToast('নোটিফিকেশন চালু হয়নি — পুশ সার্ভিসে subscription তৈরি হয়নি। আবার চাপো।', 'warning', 5000);
            return;
        }
        savePref('on');
        setToggle(el, true);
        showToast('নোটিফিকেশন চালু হয়েছে — এখন app বন্ধ থাকলেও mobile-এর notification panel-এ Tournixo notification আসবে', 'success', 5000);
    } catch (e) {
        warn('toggleNotifications error:', e.message);
        syncNotifToggleUI();
        showToast('নোটিফিকেশনের সেটিং বদলানো যায়নি। আবার চেষ্টা করো।', 'error', 3500);
    } finally {
        _toggleBusy = false;
    }
}

// Login-এর পর — external_id = Firebase UID, যাতে admin-এর পাঠানো push
// এই user-এর কাছেই যায়। নেটিভ SDK-তে login (5.9.2: login(externalId))।
export function oneSignalLogin(uid) {
    if (!uid || !isCapacitorNative()) return;
    try {
        const b = bridge();
        if (b && typeof b.login === 'function') b.login({ externalId: uid }).catch(() => {});
    } catch (e) {}
}

// Logout-এর পর — এই ডিভাইস আর আগের user-এর push পাবে না।
export function oneSignalLogout() {
    if (!isCapacitorNative()) return;
    try {
        const b = bridge();
        if (b && typeof b.logout === 'function') b.logout().catch(() => {});
    } catch (e) {}
}

// ভবিষ্যতের জন্য (এখনো কোনো caller নেই): user-কে tag করা,
// যেমন setPushTag('role', 'player')।
export function setPushTag(key, value) {
    if (!key || !isCapacitorNative()) return;
    try {
        const b = bridge();
        if (b && typeof b.setTag === 'function') b.setTag({ key, value: String(value) }).catch(() => {});
    } catch (e) {}
}

// নেটিভ verification dialog-ই এখন একমাত্র push prompt (MainActivity
// থেকে প্রথম registration-এ একবার দেখায়)। পুরনো web post-login
// prompt (maybePromptForPushOnce) তুলে দেওয়া হয়েছে — home.js-এর
// call-ও সরানো হয়েছে, তাই এই নামে আর কোনো export নেই।

window.toggleNotifications = toggleNotifications;

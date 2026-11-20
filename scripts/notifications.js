import { initPage } from './app.js';
import { state } from './state.js';
import { timeAgo } from '../utils/formatters.js';
import { escHtml } from '../utils/escape.js';
import { fetchNotifications, markNotificationRead } from '../services/notifications.service.js';

// UNSLOP Group 4 (pass 3): notification-type icons are line SVGs
// (18px, 1.5 stroke, currentColor), not emoji. Values are inserted as
// innerHTML, so SVG strings render directly.
const _ic = inner => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const NOTIF_ICONS = {
    join_confirmed: _ic('<path d="M20 6 9 17l-5-5"/>'),
    payment_pending: _ic('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    room_published: _ic('<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
    prize_credited: _ic('<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>'),
    prize: _ic('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
    tournament_soon: _ic('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    withdrawal_pending: _ic('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    withdrawal_approved: _ic('<path d="M20 6 9 17l-5-5"/>'),
    announcement: _ic('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
    info: _ic('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    success: _ic('<path d="M20 6 9 17l-5-5"/>'),
    warning: _ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    default: _ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>')
};
const EMPTY_BELL = NOTIF_ICONS.default;

let currentUid = null;
let currentItems = [];

async function loadNotifications(uid) {
    currentUid = uid;
    const container = document.getElementById('notif-list');
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    try {
        // FIX (2026-10-25, F-05): admin না হলে adminNotifications query
        // চলবে না (service-এ skip) — প্রতি open-এ denied roundtrip বাঁচবে।
        const items = await fetchNotifications(uid, state.userData?.role === 'admin');
        currentItems = items;
        if (items.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">${EMPTY_BELL}</div><div class="empty-title">এখনো কোনো নোটিফিকেশন নেই</div></div>`;
            return;
        }
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();
        for (const n of items) {
            // FIX (2026-10-25, BUILD 20 paired patch): global broadcast
            // item-এর read ফিল্ড নেই → সবসময় unread dot দেখাত, আর tap-এ
            // dot কখনো clear হতো না (mark-read শুধু _src 'user'-এ
            // বাঁধা ছিল)। এখন দেখা global id localStorage-এ (শেষ 50টা)
            // রাখা হয় — tap করলে dot clear হবে, পরের বার আর দেখাবে না।
            if (n._src === 'global' && _globalSeenHas(n.id)) n.read = true;
            const item = document.createElement('div');
            item.className = 'notif-item' + (!n.read ? ' unread' : '');
            item.innerHTML = `<div class="notif-icon">${NOTIF_ICONS[n.type]||NOTIF_ICONS.default}</div><div class="notif-content"><div class="notif-title">${escHtml(n.title||'Notification')}</div><div class="notif-body">${escHtml(n.body||n.message||'')}</div><div class="notif-time">${timeAgo(n.createdAt)}</div></div>${!n.read?'<div class="unread-dot"></div>':''}`;
            // Opening the page no longer marks notifications as read.
            // A notification is marked read when the user actually taps it.
            if (!n.read && n._src === 'user') {
                item.addEventListener('click', () => markOneRead(n, item), { once: true });
            } else if (!n.read && n._src === 'global') {
                item.addEventListener('click', () => {
                    n.read = true;
                    item.classList.remove('unread');
                    const dot = item.querySelector('.unread-dot');
                    if (dot) dot.remove();
                    _globalSeenAdd(n.id);
                }, { once: true });
            }
            fragment.appendChild(item);
        }
        container.appendChild(fragment);
    } catch (e) {
        // FIX (2026-11-19, v8.11, B3): load fail হলে আর "No notifications
        // yet" নয় — আসল error + Retry বাটন (আবার load করে, reload নয়)।
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">${EMPTY_BELL}</div><div class="empty-title">নোটিফিকেশন লোড হয়নি</div><div class="empty-sub">নেটওয়ার্ক বা সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করো।</div><button class="btn btn-primary" id="notif-retry-btn" style="margin-top:14px">আবার চেষ্টা করো</button></div>`;
        const rb = document.getElementById('notif-retry-btn');
        if (rb) rb.addEventListener('click', () => loadNotifications(currentUid));
    }
}

// FIX (2026-10-25, BUILD 20 paired patch): global broadcast item-এর
// seen-state localStorage-এ (backend-এ write নেই — global doc সবার
// জন্য একটাই, per-user read ফিল্ড নেই)।
function _globalSeenHas(id) {
    try { return (JSON.parse(localStorage.getItem('tx_global_seen') || '[]')).includes(id); }
    catch (e) { return false; }
}
function _globalSeenAdd(id) {
    try {
        const arr = JSON.parse(localStorage.getItem('tx_global_seen') || '[]');
        if (!arr.includes(id)) { arr.push(id); localStorage.setItem('tx_global_seen', JSON.stringify(arr.slice(-50))); }
    } catch (e) {}
}

function markOneRead(n, item) {
    if (n.read) return;
    n.read = true;
    item.classList.remove('unread');
    // FIX (2026-10-25, W7): dot আগে সরিয়ে ফেলা হতো, আর write fail হলে
    // শুধু class ফিরত — dot আর ফিরত না (phantom unread)। এখন dot
    // শুধু write সফল হলেই সরবে; fail হলে dot + class দুটোই থাকে।
    markNotificationRead(currentUid, n.id).then(() => {
        const dot = item.querySelector('.unread-dot');
        if (dot) dot.remove();
    }).catch(() => {
        // Revert local state on failure so it doesn't drift from the backend
        n.read = false;
        item.classList.add('unread');
    });
}

initPage({
    page: 'notifications',
    onReady: (user) => {
        if (user) loadNotifications(user.uid);
    }
});
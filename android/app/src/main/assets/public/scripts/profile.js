import { initPage, refreshUserUI } from './app.js';
import './auth-ui.js'; // provides window.confirmLogout (auth-ui only starts a page on login/register)
import { syncNotifToggleUI } from '../services/onesignal.service.js';
import { state } from './state.js';
import { getMyTeam } from '../services/team.service.js';
import { changeMyFFUID } from '../services/auth.service.js';
import { showToast } from './toast.js';
import { showPrompt } from './modal.js';
import { APP_CONFIG } from '../config/app-config.js';

// v8.1: My Team আর Profile-এর ভেতরে inline form নয় — Profile-এ শুধু
// "My Team" option row থাকে, tap করলে pages/my-team.html খোলে।

// ── Edit Free Fire UID (v8.11.1, B4) ──
// Same shared flow as Account Settings: showPrompt modal →
// changeMyFFUID() in services/auth.service.js (validate → claim check →
// profile update → claim txn, with revert on failure). The UID chip
// (#profile-uid-big) is the entry point — tapping it runs this flow.
// refreshUserUI() re-renders the chip's innerHTML but never replaces the
// chip element itself, so the click listener wired in loadProfile()
// survives every refresh.
let _ffuidBusy = false;

async function editFFUID() {
    const uid = state.currentUser?.uid;
    if (!uid || _ffuidBusy) return;
    const current = String(state.userData?.ffUID || '').trim();
    const raw = await showPrompt(
        'Free Fire UID বদলাও',
        current ? `বর্তমান UID: ${current} — নতুন UID লেখো (৮–১২ সংখ্যা)` : 'তোমার Free Fire UID লেখো (৮–১২ সংখ্যা)',
        { value: current, placeholder: 'যেমন 1234567890', maxLength: 12, okText: 'বদলাও' }
    );
    if (raw === null) return; // বাতিল
    const next = raw.trim();
    if (!next || next === current) {
        if (next === current) showToast('নতুন UID আগের UID-এর মতোই — অন্য UID দাও', 'warning');
        return;
    }
    _ffuidBusy = true;
    try {
        await changeMyFFUID(next);
        refreshUserUI();
        showToast('FF UID বদলে গেছে', 'success');
    } catch (err) {
        if (err?.code === 'auth/ffuid-already-in-use' || err?.code === 'auth/invalid-ffuid' || err?.code === 'auth/ffuid-unchanged') {
            showToast(err.message, 'error', 4500);
        } else {
            // Revert already ran inside changeMyFFUID() if the profile
            // had been updated — the old UID is still the live one.
            showToast('FF UID বদলানো যায়নি — পুরনো UID-ই আছে। আবার চেষ্টা করো।', 'error', 4500);
        }
    } finally {
        _ffuidBusy = false;
    }
}
window.editFFUID = editFFUID;

async function loadProfile() {
    // FIX (2026-11-19, P5): footer version comes from APP_CONFIG.version —
    // the HTML keeps the same text as a no-JS fallback.
    const verEl = document.getElementById('prf-version');
    if (verEl) verEl.textContent = `Tournixo v${APP_CONFIG.version}`;
    refreshUserUI();
    // v8.11.1 (B4): the UID chip is the FF UID edit entry point on this
    // page — tappable, with a hint. Wired once (dataset flag); the
    // listener lives on the chip element, so refreshUserUI()'s innerHTML
    // rewrites do not unwire it.
    const uidChip = document.getElementById('profile-uid-big');
    if (uidChip && !uidChip.dataset.ffuidWired) {
        uidChip.dataset.ffuidWired = '1';
        uidChip.style.cursor = 'pointer';
        uidChip.title = 'FF UID বদলাতে ট্যাপ করো';
        uidChip.addEventListener('click', editFFUID);
    }
    syncNotifToggleUI();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncNotifToggleUI();
    });
    const uid = state.currentUser?.uid;
    const sub = document.getElementById('team-row-sub');
    if (uid && sub) {
        // v8.8 (item 7): getMyTeam read fail করলে "No team yet" ভান
        // করা হবে না — load error দেখাও।
        let team = null;
        try {
            team = await getMyTeam(uid);
        } catch (e) {
            sub.textContent = 'টিম লোড হয়নি — আবার চেষ্টা করো।';
            return;
        }
        if (!team) sub.textContent = 'এখনো কোনো টিম নেই — DUO/SQUAD join করতে আগে টিম বানাও।';
        else {
            const n = (team.members || []).length;
            sub.textContent = `${team.teamName} • ${n >= 3 ? 'Squad-ready (3 mates)' : n >= 1 ? 'Duo-ready (Mate 1 আছে)' : 'Teammate যোগ করো'}`;
        }
    }
}

initPage({
    page: 'profile',
    tab: 'profile',
    onReady: () => {
        loadProfile();
    }
});

// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { initPage, effectiveDepositBalance } from './app.js';
import { state } from './state.js';
import { showToast, flashToast, friendlyErrorMessage } from './toast.js';
import { db, doc, getDoc, getDocs, collection, query, where } from '../firebase/firebase-init.js';
import { goTo, goBack, goReplace, getParam } from '../config/app-config.js';
import { isValidTrxId, isNumeric } from '../utils/validators.js';
import { escHtml } from '../utils/escape.js';
import { normalizeTournament, invalidateTournamentCaches } from '../services/tournaments.service.js';
import { getMyTeam, teamPlayersForFormat } from '../services/team.service.js';
import { fetchPaymentSettings, buildUpiIntentUrl, submitPaymentRequest, submitInstantWalletJoin } from '../services/payment.service.js';
// SLOT BOOKING (v8.3, 2026-11-11): Paid join-এও user নিজের slot বেছে
// নেয় — picker-এর taken list + txn-এর slot-lock-ই guard। UPI আর
// নতুন join-এর option নয় (নিচে setupInstantWalletSection দেখো)।
import { fetchSlotStates, renderSlotGrid } from '../services/slot.service.js';

// ════════════════════════════════════════════════════════════════
// PAYMENT PAGE — two modes
//
// NEW FLOW (payment.html?id=<tournamentId>):
//   Join button → this page. The player picks a slot + confirms with
//   Deposit Balance — ONE instant transaction (submitInstantWalletJoin):
//   slot lock + team confirmed + depositBalance debit. No admin wait,
//   no UPI. (v8.8 item 11: UPI new-join removed — submitPaidJoinRequest
//   is hard-blocked in the service; old pending UPI requests stay
//   visible in Matches / here as "admin verification pending" and
//   remain admin-confirmable.)
//
// LEGACY MODE (payment.html?id=<tid>&team=<teamId>):
//   Pre-flow-change teams that already exist with paymentStatus
//   'unpaid' — payment is submitted against the existing team via
//   submitPaymentRequest, exactly as before.
// ════════════════════════════════════════════════════════════════
let _mode = 'new'; // 'new' | 'legacy'

// SLOT BOOKING (v8.3): Paid page-এর picker state। _paySlotsLoaded
// false থাকলে submit বন্ধ (fail-closed)।
let _paySelectedSlot = null;
let _paySlotsLoaded = false;
let _paySlotsTaken = new Set();
// v8.8 (item 4): আটকে থাকা slot-গুলো (teamId-হীন confirmed lock)।
let _paySlotsStuck = [];
let _walletJoinInFlight = false;

/* UNSLOP (pass 3): status-view icons are line SVGs, not emoji. */
const ICON_LOCK_40 = '<span style="color:var(--text2); display:inline-flex;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>';
const ICON_CHECK_40 = '<span style="color:var(--accent); display:inline-flex;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span>';
const ICON_CLOCK_40 = '<span style="color:var(--text2); display:inline-flex;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>';

async function loadUpiIntoSheet(t, intentTeamId) {
    const submitBtn = document.getElementById('pay-submit-btn');
    const upiDisplay = document.getElementById('pay-upi-id-display');
    const loadError = document.getElementById('pay-load-error');
    if (loadError) loadError.style.display = 'none';
    if (submitBtn) submitBtn.disabled = true;
    if (upiDisplay) upiDisplay.textContent = 'লোড হচ্ছে…'; /* FIX (2026-11-20, S6): Bengali. */

    let adminUpiId, payeeName;
    try {
        ({ adminUpiId, payeeName } = await fetchPaymentSettings());
    } catch (e) {
        showToast('Payment details load হয়নি। আবার চেষ্টা করো।', 'error');
        if (loadError) loadError.style.display = 'block';
        if (upiDisplay) upiDisplay.textContent = '—';
        const upiCopyBtnErr = document.getElementById('pay-upi-copy');
        if (upiCopyBtnErr) upiCopyBtnErr.hidden = true;
        return false;
    }
    // FIX (2026-10-25, F16): per-tournament upiId override সরানো হলো —
    // এর কোনো writer ছিল না, কিন্তু কেউ কোনোদিন set করলে payment চুপচাপ
    // ভুল payee-তে যেত। settings/payment-ই একমাত্র source of truth।
    if (submitBtn) submitBtn.disabled = false;

    document.getElementById('pay-tournament-name').textContent = t.name;
    document.getElementById('pay-fee').textContent = '₹' + Number(t.entryFee || 0);
    document.getElementById('pay-upi-id-display').textContent = adminUpiId;
    const upiCopyBtn = document.getElementById('pay-upi-copy');
    if (upiCopyBtn) {
        upiCopyBtn.hidden = false;
        upiCopyBtn.onclick = () => window.copyText(adminUpiId, 'UPI ID');
    }
    const amtInput = document.getElementById('pay-amount-input');
    if (amtInput) amtInput.value = Number(t.entryFee || 0);
    const trxInput = document.getElementById('pay-trxid');
    if (trxInput) trxInput.value = '';

    const upiIntentUrl = buildUpiIntentUrl(adminUpiId, payeeName, Number(t.entryFee || 0), intentTeamId || t.id);
    const intentBtn = document.getElementById('pay-upi-intent-link');
    if (intentBtn) intentBtn.href = upiIntentUrl;
    return true;
}

// ── INSTANT WALLET (v8.3, 2026-11-11): Paid join এখন wallet-only —
// আর UPI pay করে admin-এর অপেক্ষা নেই। User আগেই Wallet-এ Deposit
// করে রাখে; Confirm করলেই এক txn-এ slot বুক + Deposit Balance থেকে
// fee কাটা + সাথে সাথে confirmed। UPI block নতুন flow-তে লুকানো থাকে
// (legacy unpaid team-এর finish-এ UPI আগের মতোই চলে — ওটা উপরের
// legacy branch, এখানে নয়)।
function setupInstantWalletSection(t) {
    const fee = Number(t.entryFee || 0);
    const depBal = effectiveDepositBalance(state.userData);
    const upiBlock = document.getElementById('pay-upi-block');
    if (upiBlock) upiBlock.style.display = 'none';
    // Summary card-এর UPI ID row-টাও নতুন flow-তে দেখানো হবে না।
    const upiIdEl = document.getElementById('pay-upi-id-display');
    if (upiIdEl && upiIdEl.closest) { const row = upiIdEl.closest('.row'); if (row) row.style.display = 'none'; }
    const walletConfirm = document.getElementById('pay-wallet-confirm');
    if (walletConfirm) walletConfirm.style.display = '';
    const summaryEl = document.getElementById('pay-wallet-summary');
    if (summaryEl) {
        summaryEl.innerHTML = `Deposit Balance ₹${depBal.toFixed(2)} · Entry Fee ₹${fee.toFixed(2)} · <b>বাকি থাকবে ₹${Math.max(0, depBal - fee).toFixed(2)}</b>`;
    }
    const noteEl = document.getElementById('pay-wallet-note-text');
    if (noteEl) noteEl.textContent = 'Confirm করলেই Slot বুক হবে আর Deposit Balance থেকে টাকা কেটে যাবে — সাথে সাথে। Slot না পেলে টাকা কাটবে না। রিফান্ড নেই — টুর্নামেন্ট cancel হলে admin টাকা manually ফেরত দেবে।'; /* FIX (2026-11-20, S6): "No refund" → Bengali. */
    const submitBtn = document.getElementById('pay-wallet-submit-btn');
    const addMoneyBtn = document.getElementById('pay-add-money-btn');
    if (fee > 0 && depBal < fee) {
        // INSUFFICIENT BALANCE — hard block: Confirm disable, Add Money দেখাও।
        if (submitBtn) submitBtn.disabled = true;
        if (addMoneyBtn) addMoneyBtn.style.display = '';
        if (summaryEl) summaryEl.innerHTML += `<div style="color:var(--error); margin-top:6px;">Balance কম আছে — আরও ₹${(fee - depBal).toFixed(2)} লাগবে।</div>`;
    } else {
        if (submitBtn) submitBtn.disabled = false;
        if (addMoneyBtn) addMoneyBtn.style.display = 'none';
    }
    updateWalletSubmitLabel(t);
}

// FIX (2026-11-19, v8.9-2): বাটনে শুধু "Join" — fee/slot-এর লেখা
// ওপরের summary লাইনেই থাকে।
// FIX (2026-11-20, S6): label Bengali — "জয়েন করো"।
function updateWalletSubmitLabel(t) {
    const btn = document.getElementById('pay-wallet-submit-btn');
    if (!btn) return;
    btn.textContent = 'জয়েন করো';
}

// SLOT BOOKING (v8.3): Paid page-এর slot picker (Free modal-এর মতোই)।
async function renderPaySlotPicker(t) {
    const box = document.getElementById('pay-slot-picker');
    if (!box) return;
    _paySelectedSlot = null;
    _paySlotsLoaded = false;
    updateWalletSubmitLabel(t);
    box.innerHTML = '<div class="slot-picker-note">Slot list load হচ্ছে…</div>';
    try {
        const _paySlotStates = await fetchSlotStates(t.id);
        _paySlotsTaken = _paySlotStates.taken;
        _paySlotsStuck = _paySlotStates.stuck;
        _paySlotsLoaded = true;
        renderPaySlotPickerRefresh(t);
    } catch (e) {
        _paySlotsLoaded = false;
        box.innerHTML = `<div class="slot-picker-note" style="color:var(--error);">${escHtml(e?.message || 'Slot list load হয়নি।')}</div>`
            + '<button type="button" class="btn btn-secondary" id="pay-slot-retry-btn" style="margin-top:10px;">Try Again</button>';
        const retry = document.getElementById('pay-slot-retry-btn');
        if (retry) retry.addEventListener('click', () => renderPaySlotPicker(t));
    }
}

function renderPaySlotPickerRefresh(t) {
    const box = document.getElementById('pay-slot-picker');
    if (!box || !_paySlotsLoaded) return;
    renderSlotGrid(box, {
        maxTeams: Number(t.maxTeams || 0),
        taken: _paySlotsTaken,
        selected: _paySelectedSlot,
        onSelect: (n) => { _paySelectedSlot = n; renderPaySlotPickerRefresh(t); updateWalletSubmitLabel(t); }
    });
    // v8.8 (item 4): stuck slot থাকলে picker-এর নিচেই বাংলায় জানাও —
    // user-side delete নেই, শুধু admin ছাড়াতে পারবে।
    const oldNote = document.getElementById('pay-stuck-slot-note');
    if (oldNote) oldNote.remove();
    if (_paySlotsStuck.length > 0) {
        const note = document.createElement('div');
        note.id = 'pay-stuck-slot-note';
        note.style.cssText = 'margin-top:10px; background:var(--bg3); border:1px solid var(--error); border-radius:12px; padding:10px 12px; font-size:13px; color:var(--text); line-height:1.6;';
        note.textContent = `Slot ${_paySlotsStuck.join(', ')} আটকে আছে — অ্যাডমিনকে জানাও। শুধু অ্যাডমিনই এই Slot ছাড়াতে পারবে, তুমি নিজে ছাড়াতে পারবে না। অন্য খালি Slot বেছে নাও।`;
        box.appendChild(note);
    }
    updateWalletSubmitLabel(t);
}

// FIX (2026-11-11, M16): selectPayMethod মুছে ফেলা হয়েছে — payment-method
// choice section-টাই আর নেই (v8.3 থেকে paid join wallet-only)।

export async function submitWalletJoin() {
    const t = state.activePaymentTournament;
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!t || !uid) {
        showToast('Payment session শেষ হয়ে গেছে। আবার জয়েন করো।', 'error');
        return;
    }
    // SLOT BOOKING (v8.3) + DUPLICATE PROTECTION: double-click-এ একই
    // submit দুবার চলবে না (আসল guard txn-এর ভেতরে captain lock;
    // এটা শুধু UI layer)।
    if (_walletJoinInFlight) return;
    // Slot না বেছে Confirm করা যাবে না; list load না হওয়া পর্যন্তও না।
    if (!_paySlotsLoaded) {
        showToast('Slot list এখনো load হচ্ছে — একটু অপেক্ষা করো', 'warning');
        return;
    }
    if (!_paySelectedSlot) {
        showToast('আগে একটা খালি Slot বেছে নাও', 'warning');
        return;
    }
    // FIX (2026-11-20, A1): flag + button disable SYNCHRONOUSLY, roster
    // load-এর আগেই — collectRoster await-এর ফাঁকে দ্বিতীয় tap দ্বিতীয়
    // submit চালাত (txn backstop double-debit আটকাত, কিন্তু দ্বিতীয়
    // attempt confusing error দেখাত)।
    const submitBtn = document.getElementById('pay-wallet-submit-btn');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
    _walletJoinInFlight = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Slot বুক হচ্ছে…';
    }
    const roster = await collectRoster(t);
    if (!roster) {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
        _walletJoinInFlight = false;
        updateWalletSubmitLabel(t);
        return;
    }
    // Same live-fee guard as the UPI submit: if the fee changed since
    // the page opened, stop and tell the user (the transaction fee is
    // still authoritative).
    try {
        const feeSnap = await getDoc(doc(db, 'tournaments', t.id));
        const liveFee = feeSnap.exists() ? Number(feeSnap.data().entryFee || 0) : Number(t.entryFee || 0);
        if (liveFee !== Number(t.entryFee || 0)) {
            showToast(`Entry fee বদলে ₹${liveFee} হয়েছে। নতুন fee দেখে আবার চেষ্টা করো।`, 'error', 5500);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
            _walletJoinInFlight = false;
            updateWalletSubmitLabel(t);
            return;
        }
    } catch (e) { /* fee re-read failed — transaction fee stays authoritative */ }
    try {
        // INSTANT WALLET (v8.3): এক txn-এ slot book + fee debit +
        // confirmed — আর admin-এর অপেক্ষা নেই।
        const res = await submitInstantWalletJoin({
            t,
            teamName: roster.teamName,
            players: roster.players,
            slot: _paySelectedSlot,
            uid,
            uData,
            authEmail: state.currentUser?.email
        });
        flashToast(`সফলভাবে জয়েন হয়েছে! Slot ${res.slot} তোমার — ₹${res.fee.toFixed(2)} Deposit Balance থেকে কেটেছে।`, 'success', 5000);
        // SLOT-UPDATE (2026-11-20): PAID join-এর পর list/detail-এর
        // 45s cache clear করো, যাতে BACK করলে fresh filled count +
        // Joined badge দেখায় (FREE path-এর মতোই)।
        invalidateTournamentCaches();
        goReplace('matches');
    } catch (err) {
        if (err.code === 'slot-taken' || err.code === 'slot-stuck') {
            // অন্য কেউ ঠিক এই slot-টা নিয়ে নিয়েছে — picker refresh
            // করলে সেটা Booked দেখাবে। Stuck slot হলে refresh-এ stuck
            // note-ও দেখাবে (v8.8 item 4)।
            showToast(friendlyErrorMessage(err), 'error', 5500);
            try { await renderPaySlotPicker(t); } catch (e) {}
        } else if (err.code === 'insufficient-balance') {
            showToast(friendlyErrorMessage(err), 'error', 5500);
            setupInstantWalletSection(t);
        } else {
            showToast(friendlyErrorMessage(err), 'error', 5500);
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
        _walletJoinInFlight = false;
        updateWalletSubmitLabel(t);
    }
}
window.goToWalletForDeposit = () => goTo('wallet');
// INSTANT SLOT BOOKING (v8.3): user doc live listener (app.js) থেকে ডাকা
// হয় — balance দেরিতে এলে বা deposit approve হলে wallet section-টা
// (summary + Confirm/Add-Money) refresh হবে। Picker-কে ছোঁয় না।
window.refreshInstantWalletSection = () => {
    const t = state.activePaymentTournament;
    if (t && _mode === 'new') setupInstantWalletSection(t);
};
window.submitWalletJoin = submitWalletJoin;

// ── Status view (request already submitted / confirmed) ──
function showStatusView(icon, title, body) {
    const form = document.getElementById('pay-main-form');
    if (form) form.style.display = 'none';
    const view = document.getElementById('pay-status-view');
    if (!view) return;
    view.style.display = 'block';
    view.innerHTML = `
        <div style="text-align:center; padding:18px 8px 8px;">
            <div style="margin-bottom:12px; display:flex; justify-content:center;">${icon}</div>
            <div style="font-size:16px; font-weight:600; margin-bottom:8px;">${escHtml(title)}</div>
            <p style="font-size:13px; color:var(--text2); line-height:1.6; margin-bottom:16px;">${escHtml(body)}</p>
            <button class="btn btn-primary" onclick="goToMatches()">View My Matches</button>
        </div>`;
}
window.goToMatches = () => goReplace('matches');

// ── Roster form (manual entry — same fields as the free join form) ──
async function renderRosterForm(t) {
    const wrap = document.getElementById('pay-roster-section');
    if (!wrap) return;
    const uData = state.userData || {};
    const uName = uData.name || '';
    const uFFUID = uData.ffUID || '';
    // FIX (2026-11-13, H): DUO/SQUAD-এর saved team sheet বানানোর আগেই
    // load করা হয়, যাতে roster card-গুলো শুরু থেকেই read-only display
    // হিসেবে বানানো যায় — আগে editable input বানিয়ে পরে readOnly করা
    // হতো, সেটা আর নেই। Join time-এ নাম/UID/team name বদলানো যায় না;
    // roster শুধু My Team-এর saved team থেকে আসে।
    let _tp = null;
    if (t.teamFormat === 'DUO' || t.teamFormat === 'SQUAD') {
        // v8.8 (item 7): getMyTeam read fail করলে retry message —
        // "team নেই" ভেবে My Team পেজে পাঠিও না।
        // FIX (2026-11-19, v8.11, N2): read fail-এ 'error' ফেরত দাও —
        // caller sheet-এর ভেতরেই বাংলা error + Retry দেখাবে। 'team নেই'
        // কেসটা আলাদা (নিচে My Team-এ পাঠায়, সেখানে return false থাকে)।
        let _team = null;
        try {
            _team = await getMyTeam(state.currentUser?.uid);
        } catch (e) {
            showToast('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error', 4500);
            return 'error';
        }
        _tp = _team ? teamPlayersForFormat(_team, { uid: state.currentUser?.uid, name: uData.name || '', ffUID: uData.ffUID || '' }, t.teamFormat) : { error: `${t.teamFormat} join-এর আগে My Team পেজে গিয়ে নিজের team বানাও।` };
        if (_tp.error) { showToast(_tp.error, 'warning', 4500); goReplace('myTeam', { team: String(t.teamFormat).toLowerCase() }); return false; }
    }
    const captainCard = (label) => `
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:600; color:var(--text); margin-bottom:8px;">${label}</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
            </div>`;
    // FIX (2026-11-13, H): mate card আর editable name/UID input নয় —
    // saved team-এর player-ই read-only display। pl না থাকলে (template-এ
    // DUO-র জন্য ডাকা হয় না) খালি card নয়, কিছুই render হয় না।
    const mateCard = (n, title, pl) => `
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:600; color:var(--text); margin-bottom:8px;">${title}</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(pl ? pl.playerName : '')}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(pl ? pl.ffUID : '')}</div>
            </div>`;
    let html = `
        <div style="font-size:14px; font-weight:600; margin-bottom:12px; color:var(--text);">Team details</div>`;
    if (t.teamFormat === 'SOLO') {
        // FIX (2026-11-13, H): SOLO-র নাম আর editable input নয় — profile
        // থেকে read-only display। collectRoster এখন profile থেকেই নেয়।
        html += `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border); margin-bottom:12px;">
                <div style="font-size:14px; font-weight:600; margin-bottom:14px; color:var(--accent);">Player Details (Solo)</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <div style="font-size:12px; color:var(--text2); margin-top:6px;">Your profile name and UID are used automatically — they cannot be changed here. বদলাতে চাইলে Profile পেজে গিয়ে edit করো।</div>
            </div>`;
    } else {
        // FIX (2026-11-13, H): team name আর editable input নয় — saved
        // team-এর নাম read-only display। Mate card-গুলোও saved team-এর
        // player দিয়ে ভরা হয় (উপরে _tp থেকে)।
        html += `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border); margin-bottom:12px;">
                <div style="font-size:13px; font-weight:600; color:var(--text); margin-bottom:8px;">${t.teamFormat === 'DUO' ? 'Team' : 'Squad Team'} Name</div>
                <div style="font-size:14px; color:var(--text); font-weight:600;">${escHtml(_tp.teamName)}</div>
            </div>
            ${captainCard(t.teamFormat === 'DUO' ? 'Captain (Player 1)' : 'Squad Captain (Player 1)')}
            ${t.teamFormat === 'DUO'
                // FIX (2026-11-12, F2): DUO-তে mate input নয় — sheet-এর
                // mate-দের radio list (নিচে saved team থেকে ভরা হয়)।
                ? '<div id="pay-duo-mate-list"></div>'
                : mateCard(2, 'Player 2', _tp.players[1]) + mateCard(3, 'Player 3', _tp.players[2]) + mateCard(4, 'Player 4', _tp.players[3])}`;
    }
    wrap.innerHTML = html;
    // FIX (2026-11-13, H): saved team (_tp) sheet বানানোর আগেই load করা
    // হয়েছে — এখানে আর team fetch বা input readOnly নেই। শুধু DUO-র
    // mate radio list ভরা হয় (selection, edit নয়)।
    if (t.teamFormat === 'DUO') {
        // FIX (2026-11-12, F2): Paid DUO mate radio — Free modal-এর
        // duo-mate-select-এর মতোই, শুধু নাম আলাদা (pay-duo-mate-select)।
        const _list = document.getElementById('pay-duo-mate-list');
        const _mates = (_tp.validMates || []).filter(m => m && m.name && m.ffUID);
        if (_list && _mates.length) {
                _list.innerHTML = '<div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:10px;">Teammate বেছে নাও:</div>' + _mates.map((m, i) => `
                    <label class="duo-mate-option" style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg4);border:1.5px solid var(--border);border-radius:12px;cursor:pointer;margin-bottom:8px;">
                        <input type="radio" name="pay-duo-mate-select" value="${i}" style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;">
                        <div>
                            <div style="font-size:14px;font-weight:700;color:var(--text);">${escHtml(m.name)}</div>
                            <div style="font-size:12px;color:var(--text2);font-family:monospace;">UID: ${escHtml(m.ffUID)}</div>
                        </div>
                    </label>`).join('');
                const _paint = () => {
                    _list.querySelectorAll('.duo-mate-option').forEach(lbl => {
                        const r = lbl.querySelector('input[type="radio"]');
                        lbl.style.borderColor = r?.checked ? 'var(--accent)' : 'var(--border)';
                        lbl.style.background = r?.checked ? 'rgba(199,255,62,0.07)' : 'var(--bg4)';
                    });
                };
                _list.querySelectorAll('input[name="pay-duo-mate-select"]').forEach(radio => radio.addEventListener('change', _paint));
                _paint();
            }
    }
    // FIX (2026-11-13, H): mate input-এ value/readOnly বসানো আর নেই —
    // mate card-গুলো আগেই saved team দিয়ে read-only display হিসেবে
    // বানানো হয়েছে। Note শুধু DUO/SQUAD-এ (SOLO-র roster Profile থেকে)।
    if (t.teamFormat === 'DUO' || t.teamFormat === 'SQUAD') {
        const _note = document.createElement('div');
        _note.style.cssText = 'font-size:12px;color:var(--text2);margin-top:8px;line-height:1.6;';
        _note.textContent = 'এই roster My Team পেজ থেকে এসেছে। বদলাতে চাইলে My Team পেজে গিয়ে team edit করো।';
        wrap.appendChild(_note);
    }
    return true;
}

// v8.0: DUO/SQUAD-এর roster My Team পেজের saved team থেকে নেওয়া হয়।
// Same validation as the join form: numeric UIDs, all mates required,
// no duplicate UID inside the roster.
async function collectRoster(t) {
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    const format = t.teamFormat || 'SOLO';
    let teamName = '';
    const players = [];
    if (format === 'SOLO') {
        // FIX (2026-11-13, H): SOLO-র নাম+UID আর DOM input থেকে পড়া হয়
        // না — sheet-এ editable input নেই, profile (state.userData)
        // থেকেই নেওয়া হয়। Instant wallet join-এর txn captain UID
        // profile doc থেকে live যাচাই করে।
        const pName = uData.name || 'Player';
        let pUid = String(uData.ffUID || '').trim();
        if (!pUid) {
            // FIX (2026-11-20, B4): state.userData stale হতে পারে — profile
            // doc live পড়ে দেখো, তারপর dead-end দেখাও।
            try {
                const freshSnap = await getDoc(doc(db, 'users', uid));
                if (freshSnap.exists()) pUid = String(freshSnap.data().ffUID || '').trim();
            } catch (e) { /* live read failed — stale value-ই ব্যবহার হবে */ }
        }
        if (!pUid) { showToast('তোমার profile-এ Free Fire UID নেই — আগে Profile-এ save করো।', 'warning'); return null; }
        if (!isNumeric(pUid)) { showToast('Free Fire UID শুধু সংখ্যা হতে হবে', 'warning'); return null; }
        teamName = pName;
        players.push({ userId: uid, playerName: pName, ffUID: pUid });
    } else {
        // v8.0 TEAM GATE (paid): form input থেকে নয়, saved team থেকে।
        // v8.8 (item 7): getMyTeam read fail করলে retry message —
        // "team নেই" ভেবে My Team পেজে পাঠিও না।
        let _team;
        try {
            _team = await getMyTeam(uid);
        } catch (e) {
            showToast('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error', 4500);
            return null;
        }
        const _tp = teamPlayersForFormat(_team, { uid, name: uData.name || '', ffUID: uData.ffUID || '' }, format);
        if (_tp.error) { showToast(_tp.error, 'warning', 4500); goReplace('myTeam', { team: format.toLowerCase() }); return null; }
        if (format === 'DUO') {
            // FIX (2026-11-12, F2): radio থেকে বাছা mate নাও — আগে সবসময়
            // sheet-এর প্রথম mate-ই (validMates[0]) যেত, user বাছতে পারত না।
            // Free modal-এ এই radio অনেক আগে থেকেই আছে; paid-এ ছিল না।
            // v8.8 (item 7): silent mateIdx 0 default তোলা হলো — কেউ
            // mate না বাছলে hard block, validMates[0] fallback আর নেই।
            const _sel = document.querySelector('input[name="pay-duo-mate-select"]:checked');
            if (!_sel) { showToast('Teammate বেছে নাও — কে তোমার সাথে খেলবে সেটা না বাছলে জয়েন হবে না।', 'warning', 4500); return null; }
            const _idx = parseInt(_sel.value, 10);
            const _mates = (_tp.validMates || []).filter(m => m && m.name && m.ffUID);
            const _chosen = _mates[_idx];
            if (!_chosen) { showToast('Teammate বেছে নাও', 'warning'); return null; }
            return { teamName: _tp.teamName, players: [
                { userId: uid, playerName: uData.name || 'Captain', ffUID: String(uData.ffUID || '') },
                { userId: '', playerName: _chosen.name, ffUID: String(_chosen.ffUID) }
            ] };
        }
        return { teamName: _tp.teamName, players: _tp.players };
        // FIX (2026-11-13, H): নিচের manual input পড়া block মুছে দেওয়া
        // হলো — DUO/SQUAD-এ এখানে আগেই return হয় (dead code ছিল), আর
        // ওই input-গুলো (pay-team-name-input, pay-p{n}-name/uid) sheet
        // থেকে তুলে দেওয়া হয়েছে, তাই dead code-ও ভুল reference রাখত।
    }
    players.forEach(pl => { pl.ffUID = String(pl.ffUID ?? '').trim(); });
    if (new Set(players.map(pl => pl.ffUID)).size !== players.length) {
        showToast('তোমার টিমে একই Free Fire UID দুইবার আছে!', 'error');
        return null;
    }
    // FIX (2026-10-25, L6): join form-এর মতো 25 অক্ষরের নামের সীমা।
    if (teamName.length > 25 || players.some(pl => (pl.playerName || '').length > 25)) {
        showToast('টিম আর player-এর নাম ২৫ অক্ষরের বেশি হতে পারবে না — Profile থেকে নাম এলে ওখানে ছোট করো', 'warning');
        return null;
    }
    return { teamName, players };
}

// ════════════════════════════════════════════════════════════════
// SUBMIT (both modes)
// ════════════════════════════════════════════════════════════════
export async function submitTournamentPayment() {
    // FIX (2026-11-12, F3): এই UPI pending flow শুধু legacy unpaid team-এর
    // finish-এর জন্য। নতুন join wallet-only — UPI block লুকানো থাকলেও
    // DOM থেকে submit ডাকলে pending request বানিয়ে ফেলত, আর admin-কে
    // confirm করতে হতো। New mode-এ এখানে আসা মানেই ভুল path।
    if (_mode !== 'legacy') {
        showToast('নতুন join শুধু Wallet দিয়ে — Confirm Join with Deposit Balance চাপো', 'warning');
        return;
    }
    const t = state.activePaymentTournament;
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!t || !uid) {
        showToast('Payment session শেষ হয়ে গেছে। আবার জয়েন করো।', 'error');
        return;
    }
    const trxId = document.getElementById('pay-trxid').value.trim();
    if (!trxId) {
        showToast('তোমার UPI Transaction / UTR ID দাও', 'error');
        return;
    }
    if (!isValidTrxId(trxId)) {
        showToast('সঠিক Transaction / UTR ID দাও (কমপক্ষে ৮ অক্ষর, space ছাড়া)', 'error');
        return;
    }

    const submitBtn = document.getElementById('pay-submit-btn');
    const originalBtnText = submitBtn.innerHTML;

    // LEGACY MODE — existing unpaid team
    if (_mode === 'legacy') {
        const teamData = state.activePaymentTeam;
        if (!teamData) { showToast('Payment session শেষ হয়ে গেছে। আবার জয়েন করো।', 'error'); return; }
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Verifying & Submitting...';
        try {
            await submitPaymentRequest({ t, teamData, trxId, uid, uData, authEmail: state.currentUser?.email });
            flashToast('পেমেন্ট জমা হয়েছে। অ্যাডমিন অনুমোদনের অপেক্ষায় আছে।', 'success', 5000);
            goReplace('matches');
        } catch (err) {
            showToast(friendlyErrorMessage(err), 'error', 5000);
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
        return;
    }

    // v8.8 (item 11): UPI new-join branch মুছে দেওয়া হলো — উপরের
    // _mode guard-এর পর এখানে আসা code dead ছিল (new mode আগেই return
    // করে), আর submitPaidJoinRequest service-এও hard block আছে।
    // নতুন paid join শুধু wallet-only instant (submitWalletJoin)।
    // Legacy unpaid team-এর finish (submitPaymentRequest) উপরের
    // legacy branch-এ আগের মতোই চলে — পুরনো pending UPI request
    // admin-এর কাছে confirm-যোগ্যই থাকে।
}

export function closePaymentSheet() {
    goBack('matches');
}

// ════════════════════════════════════════════════════════════════
// PAGE LOAD
// ════════════════════════════════════════════════════════════════
// FIX (2026-11-19, v8.11, N2): load fail-এ ফাঁকা sheet নয় — sheet-এর
// ভেতরেই বাংলা error + Retry দেখাও। একই helper roster-fail আর
// catch (H9) দুই জায়গাতেই চলে; মেসেজটা আলাদা করে বসানো যায়।
function showPayLoadError(msg) {
    const form = document.getElementById('pay-main-form');
    if (form) form.style.display = 'none';
    const textEl = document.getElementById('pay-load-error-text');
    if (textEl) textEl.textContent = msg;
    const errBox = document.getElementById('pay-load-error');
    if (errBox) errBox.style.display = '';
}

async function loadPaymentPage() {
    const tid = getParam('id');
    const teamId = getParam('team');
    const uid = state.currentUser?.uid;
    if (!tid || !uid) {
        flashToast('টুর্নামেন্ট পাওয়া যায়নি', 'error');
        goBack('matches');
        return;
    }
    try {
        // FIX (2026-11-11, H9): retry-তে form আবার দেখাতে হবে — নইলে
        // catch-এ লুকানো form আর ফিরত না।
        const mainForm = document.getElementById('pay-main-form');
        if (mainForm) mainForm.style.display = '';
        const loadErr = document.getElementById('pay-load-error');
        if (loadErr) loadErr.style.display = 'none';
        const tSnap = await getDoc(doc(db, 'tournaments', tid));
        if (!tSnap.exists()) {
            flashToast('টুর্নামেন্ট পাওয়া যায়নি', 'error');
            goBack('matches');
            return;
        }
        const t = normalizeTournament(tSnap.data(), tSnap.id);
        state.activePaymentTournament = t;

        // ── LEGACY MODE ──
        if (teamId) {
            _mode = 'legacy';
            const teamSnap = await getDoc(doc(db, 'tournamentTeams', teamId));
            if (!teamSnap.exists()) {
                flashToast('টিম পাওয়া যায়নি', 'error');
                goBack('matches');
                return;
            }
            if (teamSnap.data().captainUserId !== uid) {
                flashToast('এই টিম তোমার নয়।', 'error');
                goBack('matches');
                return;
            }
            state.activePaymentTeam = teamSnap.data();
            document.getElementById('pay-team-name').textContent = teamSnap.data().teamName || 'My Team';
            document.getElementById('pay-team-id').textContent = teamSnap.data().teamId;
            const submitBtn = document.getElementById('pay-submit-btn');
            if (submitBtn) submitBtn.textContent = 'পেমেন্ট সাবমিট করো'; /* FIX (2026-11-20, S6): Bengali. */
            await loadUpiIntoSheet(t, teamSnap.data().teamId);
            return;
        }

        // ── NEW FLOW ──
        _mode = 'new';
        if (Number(t.entryFee || 0) <= 0 || t.entryType === 'FREE') {
            flashToast('এটা free টুর্নামেন্ট — Join button দিয়ে register করো।', 'info');
            goReplace('tournamentDetails', { id: tid });
            return;
        }
        if (t.status !== 'upcoming') {
            document.getElementById('pay-tournament-name').textContent = t.name;
            showStatusView(ICON_LOCK_40, 'টুর্নামেন্ট ' + String(t.status).charAt(0).toUpperCase() + String(t.status).slice(1), 'এই টুর্নামেন্টে এখন জয়েন নেওয়া হচ্ছে না।');
            return;
        }

        // Existing request states for this captain
        try {
            const ownSnap = await getDocs(query(
                collection(db, 'tournamentTeams'),
                where('tournamentId', '==', tid),
                where('captainUserId', '==', uid)
            ));
            let legacyUnpaid = null;
            for (const d of ownSnap.docs) {
                const tm = d.data();
                if (tm.status === 'confirmed' || tm.status === 'approved') {
                    document.getElementById('pay-tournament-name').textContent = t.name;
                    document.getElementById('pay-team-name').textContent = tm.teamName || 'My Team';
                    document.getElementById('pay-team-id').textContent = tm.teamId || d.id;
                    showStatusView(ICON_CHECK_40, 'You are already confirmed', 'Your team is confirmed for this tournament. Room details will appear in My Matches when the admin publishes them.');
                    return;
                }
                if (tm.status === 'pending' && tm.paymentStatus === 'pending') {
                    document.getElementById('pay-tournament-name').textContent = t.name;
                    document.getElementById('pay-team-name').textContent = tm.teamName || 'My Team';
                    document.getElementById('pay-team-id').textContent = tm.teamId || d.id;
                    // v8.8 (item 11): পুরনো pending request (UPI / wallet)
                    // — পরিষ্কার বাংলা status: অ্যাডমিন যাচাইয়ের
                    // অপেক্ষায় আছে, এখনো কিছু করতে হবে না। Doc মুছা
                    // হয়নি — admin আগের মতোই confirm/reject করবে।
                    const _isUpiPending = (tm.paymentMethod || '') === 'upi';
                    showStatusView(ICON_CLOCK_40, 'জয়েনের আবেদন জমা হয়েছে', _isUpiPending
                        ? 'তোমার UPI পেমেন্টসহ জয়েনের আবেদন অ্যাডমিন যাচাইয়ের অপেক্ষায় আছে। অ্যাডমিন অনুমোদন করলেই টিম কনফার্ম হবে।'
                        : 'তোমার জয়েনের আবেদন অ্যাডমিন যাচাইয়ের অপেক্ষায় আছে। অ্যাডমিন অনুমোদন করলেই টিম কনফার্ম হবে।');
                    return;
                }
                if (tm.status === 'pending' && tm.paymentStatus === 'unpaid') legacyUnpaid = tm;
            }
            if (legacyUnpaid) {
                // Pre-flow-change team: finish it through the legacy path.
                goReplace('payment', { id: tid, team: legacyUnpaid.teamId });
                return;
            }
        } catch (e) {
            // FIX (2026-10-25, F19): advisory check fail হলে আগে চুপচাপ
            // থাকত — user পুরো form ভরে submit-এ গিয়ে জানত। এখন log +
            // ছোট note; transaction-ই final backstop থাকবে।
            console.warn('[Payment] own-team state check failed:', e?.message);
            showToast('তোমার আগের registration যাচাই করা যায়নি — submit-এ আবার চেক হবে।', 'warning', 3500);
        }

        const rowName = document.getElementById('row-team-name');
        const rowId = document.getElementById('row-team-id');
        if (rowName) rowName.style.display = 'none';
        if (rowId) rowId.style.display = 'none';
        // FIX (2026-11-19, v8.11, N2): team load fail-এ আগে শুধু
        // `return` হতো — sheet ফাঁকা থাকত, শুধু X দিয়ে বেরোনো যেত,
        // Retry ছিল না। এখন sheet-এর ভেতরেই বাংলা error + Retry দেখাও;
        // নাম/fee আগেই জানা, তাই header-এ বসিয়ে দাও। 'team নেই' কেসে
        // renderRosterForm নিজেই My Team-এ পাঠায় (return false) — সেটা
        // error নয়, তাই শুধু 'error' ফেরত এলেই error state দেখাও।
        const _roster = await renderRosterForm(t);
        if (_roster === 'error') {
            const nameEl = document.getElementById('pay-tournament-name');
            if (nameEl) nameEl.textContent = t.name;
            const feeEl = document.getElementById('pay-fee');
            if (feeEl) feeEl.textContent = '₹' + Number(t.entryFee || 0);
            showPayLoadError('টিমের তথ্য লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো।');
            return;
        }
        if (!_roster) return;
        // SLOT BOOKING + INSTANT WALLET (v8.3): Paid join এখন wallet-only,
        // সাথে সাথে slot confirm — UPI block নতুন flow-তে দেখানো হয় না।
        // (Legacy unpaid team-এর finish-এ UPI আগের মতোই চলে — ওটা
        // উপরের legacy branch-এ loadUpiIntoSheet দিয়ে।)
        const nameEl = document.getElementById('pay-tournament-name');
        if (nameEl) nameEl.textContent = t.name;
        const feeEl = document.getElementById('pay-fee');
        if (feeEl) feeEl.textContent = '₹' + Number(t.entryFee || 0);
        setupInstantWalletSection(t);
        await renderPaySlotPicker(t);
    } catch (e) {
        // FIX (2026-11-19, v8.11, N2): H9-র error view এখন helper দিয়ে —
        // একই box, একই Retry (শুধু toast নয়)।
        showPayLoadError('পেমেন্টের তথ্য লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো।');
        showToast('পেমেন্ট খুলতে সমস্যা: ' + friendlyErrorMessage(e), 'error');
    }
}

window.submitTournamentPayment = submitTournamentPayment;
window.closePaymentSheet = closePaymentSheet;
window.retryPaymentLoad = () => {
    const err = document.getElementById('pay-load-error');
    if (err) err.style.display = 'none';
    loadPaymentPage();
};

initPage({
    page: 'payment',
    onReady: () => {
        loadPaymentPage();
    }
});

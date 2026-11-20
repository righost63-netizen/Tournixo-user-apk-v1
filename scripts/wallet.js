// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { initPage, effectiveWinningBalance } from './app.js';
import { state } from './state.js';
import { showToast, flashToast, friendlyErrorMessage } from './toast.js';
import { showSkeleton } from './modal.js';
import { goTo } from '../config/app-config.js';
import { formatDate, formatRupees } from '../utils/formatters.js'; /* FIX (2026-11-20, W12): history amounts একই formatter-এ। */
import { escHtml } from '../utils/escape.js';
import { fetchWalletTransactions } from '../services/wallet.service.js';
import { fetchWithdrawals } from '../services/withdrawal.service.js';
import { loadMinWithdrawal, loadDepositLimits, checkDepositSettings, DEPOSIT_SETTINGS_MISSING_MESSAGE } from '../services/settings.service.js';
// WALLET (2026-11-07): deposit service + UPI helpers for the Add Money sheet.
import { fetchDeposits, fetchDepositLimits, requestDeposit } from '../services/deposit.service.js';
import { fetchPaymentSettings, buildUpiIntentUrl } from '../services/payment.service.js';
import { isValidTrxId } from '../utils/validators.js';
import { APP_CONFIG } from '../utils/constants.js';   // min-withdrawal constant
import { saveImageFile } from '../utils/download-helper.js'; // v8.11: APK-তে <a download> চলে না — native bridge

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. Hard-coded `100` min-withdrawal fallback (line 133) removed —
 *    APP_CONFIG.defaultMinWithdrawal is used instead.
 * ─────────────────────────────────────────────────────────────
 */

const DEFAULT_MIN_WITHDRAWAL = APP_CONFIG.defaultMinWithdrawal;

/* UNSLOP (pass 3): transaction/empty-state icons are line SVGs, not emoji.
   18px in rows, 40px in empty states, 1.5 stroke, muted colour. */
const ICON_TROPHY_18 = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';
const ICON_ROTATE_18 = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const ICON_OUT_18 = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';
const ICON_ALERT_40 = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const ICON_BANKNOTE_40 = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>';
/* WALLET (2026-11-07): 18px banknote for deposit rows. */
const ICON_BANKNOTE_18 = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>';

let withdrawHistoryLoaded = false;
let depositHistoryLoaded = false;

export function setTxTab(tab, btn) {
    state.txTab = tab;
    document.querySelectorAll('#tab-wallet .tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('tx-prize-list').style.display    = tab === 'prize'    ? 'block' : 'none';
    document.getElementById('tx-withdraw-list').style.display = tab === 'withdraw' ? 'block' : 'none';
    document.getElementById('tx-deposit-list').style.display  = tab === 'deposit'  ? 'block' : 'none';
    if (tab === 'withdraw' && !withdrawHistoryLoaded) {
        withdrawHistoryLoaded = true;
        loadWithdrawHistory().then(ok => { if (ok === false) withdrawHistoryLoaded = false; });
    }
    // WALLET (2026-11-07): Deposits tab — same lazy-load + retry pattern
    // as Withdrawals.
    if (tab === 'deposit' && !depositHistoryLoaded) {
        depositHistoryLoaded = true;
        loadDepositHistory().then(ok => { if (ok === false) depositHistoryLoaded = false; });
    }
}

function loadWallet() {
    loadPrizeHistory();
    loadPendingNote();
    loadPendingDepositNote();
    updateDepositDisplays();
}

// (2026-11-19) fillWalletCardIdentity REMOVED: it looked for
// #card-number / #card-holder-name, which never existed in wallet.html,
// so it could never do anything. Its call site in loadWallet() and the
// window.refreshWalletCardIdentity exposure are gone too; app.js only
// calls that hook behind a typeof-guard, so nothing breaks.
// WALLET (2026-11-07): Deposit Balance + Total Deposited come from
// state.userData (the live user-doc listener in app.js refreshes them
// through refreshUserUI too); this is the same-value fallback for the
// first paint before the listener fires.
function updateDepositDisplays() {
    const u = state.userData || {};
    const depEl = document.getElementById('deposit-balance-amt');
    if (depEl) depEl.textContent = `${Math.max(0, Number(u.depositBalance || 0)).toFixed(2)}`;
    const totEl = document.getElementById('total-deposited-amt');
    if (totEl) totEl.textContent = `${Math.max(0, Number(u.totalDeposited || 0)).toFixed(2)}`;
}

// U2: '₹X withdrawal pending approval' — display only; the balance above
// never drops until the admin approves. app.js (U1 live listener) re-calls
// this through window.refreshPendingWithdrawal whenever the user doc updates.
async function loadPendingNote() {
    const el = document.getElementById('wallet-pending-note');
    const uid = state.currentUser?.uid;
    if (!el || !uid) return;
    // FIX (2026-10-25, F-08): আগে আলাদা ≤50 query চলত প্রতিবার (আর
    // user-doc update-এও) — এখন withdrawal history-র 30s shared cache
    // থেকেই pending total ধরা হয়, extra read নয়। Display-only।
    try {
        const items = await fetchWithdrawals(uid);
        const total = items
            .filter(w => w.status === 'pending')
            .reduce((s, w) => s + Number(w.amount || 0), 0);
        if (total > 0) {
            el.textContent = `₹${Math.round(total * 100) / 100} withdrawal pending approval`;
            el.style.display = '';
        } else {
            el.style.display = 'none';
        }
    } catch (e) {
        el.style.display = 'none';
    }
}
window.refreshPendingWithdrawal = loadPendingNote;

// WALLET (2026-11-07): '₹X deposit pending approval' — display only;
// the Deposit Balance never moves until the admin approves. Reuses the
// deposit history 30s shared cache (fetchDeposits) — no extra query.
// app.js re-calls this through window.refreshPendingDeposit whenever
// the user doc updates.
async function loadPendingDepositNote() {
    const el = document.getElementById('wallet-pending-deposit-note');
    const uid = state.currentUser?.uid;
    if (!el || !uid) return;
    try {
        const items = await fetchDeposits(uid);
        const total = items
            .filter(d => d.status === 'pending')
            .reduce((s, d) => s + Number(d.amount || 0), 0);
        if (total > 0) {
            el.textContent = `₹${Math.round(total * 100) / 100} deposit pending approval`;
            el.style.display = '';
        } else {
            el.style.display = 'none';
        }
    } catch (e) {
        el.style.display = 'none';
    }
}
window.refreshPendingDeposit = loadPendingDepositNote;

async function loadPrizeHistory(forceRefresh = false) {
    const uid = state.currentUser?.uid;
    const container = document.getElementById('tx-prize-list');
    if (!uid || !container) return;
    showSkeleton('tx-prize-list', 'tx');
    try {
        // FIX (2026-10-25, W3): Try Again এখন forceRefresh দিয়ে চলে —
        // 30s cache-এর পুরনো/খালি result আর ফিরে আসবে না।
        const transactions = await fetchWalletTransactions(uid, state.userData, forceRefresh);
        // WALLET (2026-11-07): Total Spent = sum of DEBIT ledger entries
        // (wallet-pay entry fees, written by the admin at confirm time).
        // 0 when there are none — no dummy value.
        const spentEl = document.getElementById('total-spent-amt');
        if (spentEl) {
            const spent = transactions
                .filter(tx => tx.type === 'debit')
                .reduce((s, tx) => s + Math.abs(Number(tx.amount || 0)), 0);
            spentEl.textContent = `${spent.toFixed(2)}`;
        }
        if (transactions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_BANKNOTE_40}</div>
                    <div class="empty-title">No transactions yet</div>
                    <div class="empty-sub">Tournament prizes and ledger credits will appear here</div>
                </div>`;
            return;
        }
        container.innerHTML = '';
        transactions.forEach(tx => {
            const isCredit = tx.type === 'prize' || tx.type === 'refund' || tx.type === 'credit' || (Number(tx.amount) > 0);
            const dateFormatted = formatDate(tx.createdAt || tx.date);
            const item = document.createElement('div');
            item.className = 'tx';
            item.innerHTML = `
                <div class="tx-ic ${isCredit ? 'in' : 'out'}">
                    ${tx.type === 'refund' ? ICON_ROTATE_18 : isCredit ? ICON_TROPHY_18 : ICON_OUT_18}
                </div>
                <div class="tx-body">
                    <div class="tx-title">${escHtml(tx.title || tx.tournamentName || 'Wallet Event')}</div>
                    <div class="tx-sub">${dateFormatted} · <span style="text-transform:capitalize;">${tx.type || 'Transaction'}</span></div>
                </div>
                <div class="tx-amt ${isCredit ? 'in' : 'out'}">
                    ${isCredit ? '+' : '-'}${formatRupees(Math.abs(Number(tx.amount || 0)))}
                </div>`;
            container.appendChild(item);
        });
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${ICON_ALERT_40}</div>
                <div class="empty-title">Failed to load ledger</div>
                <div class="empty-sub">Please check your connection and try again.</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="retryWalletHistory('prize')">Try Again</button>
            </div>`;
    }
}

let _withdrawForceRefresh = false;
async function loadWithdrawHistory() {
    const uid = state.currentUser?.uid;
    const container = document.getElementById('tx-withdraw-list');
    if (!uid || !container) return false;
    showSkeleton('tx-withdraw-list', 'tx');
    try {
        // FIX (2026-10-25, W3): Try Again-এর forceRefresh flag এখানে
        // ধরা হয় (tab-switch path দিয়ে load হলেও কাজ করবে)।
        const forceRefresh = _withdrawForceRefresh;
        _withdrawForceRefresh = false;
        const items = await fetchWithdrawals(uid, forceRefresh);
        if (items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_BANKNOTE_40}</div>
                    <div class="empty-title">No withdrawals yet</div>
                    <div class="empty-sub">Withdraw your tournament winnings to your UPI account</div>
                </div>`;
            return true;
        }
        container.innerHTML = '';
        // FIX (2026-11-11, H8+L1): pending আর gold নয় (gold শুধু prize
        // figure-এ) — muted text2; completed যোগ (BUILD 29 থেকে status
        // 'completed' আসে, আগে raw grey lowercase দেখাত)।
        const colors = { pending: 'var(--text2)', approved: 'var(--success)', rejected: 'var(--error)', completed: 'var(--success)' };
        const labels = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', completed: 'Completed' };
        items.forEach(w => {
            // FIX (2026-11-20, W2): pending/rejected এখনো টাকা ছাড়েনি —
            // amount neutral (sign ছাড়া, muted); শুধু approved/completed
            // −₹ লাল। আগের মতো সব request −₹ দেখালে pending-ও কাটা মনে হতো।
            const isPaid = w.status === 'approved' || w.status === 'completed';
            const item = document.createElement('div');
            item.className = 'tx';
            item.innerHTML = `
                <div class="tx-ic out">${ICON_OUT_18}</div>
                <div class="tx-body">
                    <div class="tx-title">UPI: ${escHtml(w.phoneNumber || w.upiId || 'Account')}</div>
                    <div class="tx-sub">${formatDate(w.requestedAt)} · <span style="color:${colors[w.status] || 'var(--text2)'}; font-weight:600;">${escHtml(labels[w.status] || w.status)}</span></div>
                </div>
                <div class="tx-amt ${isPaid ? 'out' : 'neutral'}">${isPaid ? '-' : ''}${formatRupees(w.amount)}</div>`;
            container.appendChild(item);
        });
        return true;
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${ICON_ALERT_40}</div>
                <div class="empty-title">Failed to load withdrawals</div>
                <div class="empty-sub">Please check your connection and try again.</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="retryWalletHistory('withdraw')">Try Again</button>
            </div>`;
        return false;
    }
}

// WALLET (2026-11-07): deposit history — mirrors loadWithdrawHistory
// (skeleton, empty state, error state with Try Again, force-refresh flag).
let _depositForceRefresh = false;
async function loadDepositHistory() {
    const uid = state.currentUser?.uid;
    const container = document.getElementById('tx-deposit-list');
    if (!uid || !container) return false;
    showSkeleton('tx-deposit-list', 'tx');
    try {
        const forceRefresh = _depositForceRefresh;
        _depositForceRefresh = false;
        const items = await fetchDeposits(uid, forceRefresh);
        if (items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${ICON_BANKNOTE_40}</div>
                    <div class="empty-title">No deposits yet</div>
                    <div class="empty-sub">Add money to join paid tournaments</div>
                </div>`;
            return true;
        }
        container.innerHTML = '';
        // FIX (2026-11-11, H8+L1): pending আর gold নয় — muted text2;
        // completed যোগ (উপরের withdrawals map-এর মতোই)।
        const colors = { pending: 'var(--text2)', approved: 'var(--success)', rejected: 'var(--error)', completed: 'var(--success)' };
        const labels = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', completed: 'Completed' };
        items.forEach(d => {
            // FIX (2026-11-20, W1): pending/rejected এখনো credit হয়নি —
            // amount neutral (sign ছাড়া, muted); শুধু approved/completed
            // +₹ সবুজ। আগের মতো সব deposit +₹ দেখালে pending-ও জমা মনে হতো।
            const isCredited = d.status === 'approved' || d.status === 'completed';
            const item = document.createElement('div');
            item.className = 'tx';
            const reason = d.status === 'rejected' && d.rejectionReason
                ? `<div class="tx-sub">${escHtml(d.rejectionReason)}</div>` : '';
            item.innerHTML = `
                <div class="tx-ic in">${ICON_BANKNOTE_18}</div>
                <div class="tx-body">
                    <div class="tx-title">Deposit · UTR ${escHtml(d.transactionId || '')}</div>
                    <div class="tx-sub">${formatDate(d.createdAt)} · <span style="color:${colors[d.status] || 'var(--text2)'}; font-weight:600;">${escHtml(labels[d.status] || d.status)}</span></div>
                    ${reason}
                </div>
                <div class="tx-amt ${isCredited ? 'in' : 'neutral'}">${isCredited ? '+' : ''}${formatRupees(d.amount)}</div>`;
            container.appendChild(item);
        });
        return true;
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${ICON_ALERT_40}</div>
                <div class="empty-title">Failed to load deposits</div>
                <div class="empty-sub">Please check your connection and try again.</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="retryWalletHistory('deposit')">Try Again</button>
            </div>`;
        return false;
    }
}

window.retryWalletHistory = (tab) => {
    if (tab === 'withdraw') {
        withdrawHistoryLoaded = false;
        _withdrawForceRefresh = true;
        setTxTab('withdraw');
    } else if (tab === 'deposit') {
        depositHistoryLoaded = false;
        _depositForceRefresh = true;
        setTxTab('deposit');
    } else {
        loadPrizeHistory(true);
    }
};

// ── WALLET (2026-11-07): Add Money bottom sheet ──
// The sheet collects amount + UTR for a deposit REQUEST only. No balance
// changes here — the admin approves the request later (admin panel) and
// only then is the Deposit Balance credited.
let _depPaySettings = null;
let _depLimits = null;

function setDepError(msg) {
    const el = document.getElementById('dep-error');
    if (!el) return;
    if (msg) {
        el.textContent = msg;
        el.style.display = '';
    } else {
        el.textContent = '';
        el.style.display = 'none';
    }
}

function updateDepIntentLink() {
    const link = document.getElementById('dep-upi-intent-link');
    const amtInput = document.getElementById('dep-amount-input');
    if (!link || !amtInput || !_depPaySettings) return;
    const amt = Math.round((Number(amtInput.value) || 0) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) {
        link.href = '#';
    } else {
        try {
            link.href = buildUpiIntentUrl(_depPaySettings.adminUpiId, _depPaySettings.payeeName, amt, 'DEPOSIT');
        } catch (e) {
            link.href = '#';
        }
    }
    // Same payload as the Pay link — the QR rebuilds with the amount, so
    // QR and Pay link can never disagree.
    renderDepQr();
}

// ── QR (2026-11-19): REAL UPI QR ──────────────────────────────────────
// The payload is byte-identical to the Pay-link href: same function
// (buildUpiIntentUrl), same admin UPI ID + payee name + amount, rebuilt
// live whenever the amount changes. Any UPI app scanning it opens
// payment to the admin with the amount prefilled — no static image.
// Library: qrcode-generator 1.4.4 (MIT, Kazuhiko Arase), vendored at
// scripts/vendor/qrcode-generator.js, loaded as a classic script in
// wallet.html before this module, so the global `qrcode` exists here.
let _depQrPayload = null;

function buildDepQrPayload() {
    if (!_depPaySettings) return null;
    const upiId = String(_depPaySettings.adminUpiId || '').trim();
    const name = String(_depPaySettings.payeeName || '').trim();
    if (!upiId || !name) return null;
    const amtInput = document.getElementById('dep-amount-input');
    const amt = Math.round((Number(amtInput?.value) || 0) * 100) / 100;
    if (Number.isFinite(amt) && amt > 0) {
        try {
            return buildUpiIntentUrl(upiId, name, amt, 'DEPOSIT');
        } catch (e) {
            return null;
        }
    }
    // No valid amount yet — payee only; the user types the amount in
    // their UPI app after scanning.
    return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(name)}&cu=INR`;
}

function makeDepQr(payload) {
    // qrcode-generator: typeNumber 0 = auto-detect version, 'M' correction.
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    return qr;
}

function drawQrOnCanvas(canvas, qr, px) {
    const count = qr.getModuleCount();
    const quiet = 4;
    const cell = px / (count + quiet * 2);
    const ctx = canvas.getContext('2d');
    canvas.width = px;
    canvas.height = px;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) {
                ctx.fillRect(Math.round((c + quiet) * cell), Math.round((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
            }
        }
    }
}

function renderDepQr() {
    const card = document.getElementById('dep-qr-card');
    const canvas = document.getElementById('dep-qr-canvas');
    const errEl = document.getElementById('dep-qr-error');
    if (!card || !canvas) return;
    // FIX (2026-11-20, W7): vendor script না লোড হলে QR card চুপচাপ
    // লুকিয়ে যেত — user জানতই না QR কেন নেই। এখন পরিষ্কার মেসেজ।
    const showQrError = () => { if (errEl) errEl.hidden = false; };
    const hideQrError = () => { if (errEl) errEl.hidden = true; };
    const payload = buildDepQrPayload();
    if (!payload || typeof qrcode !== 'function') {
        card.hidden = true;
        _depQrPayload = null;
        showQrError();
        return;
    }
    try {
        const qr = makeDepQr(payload);
        drawQrOnCanvas(canvas, qr, 240);
        const nameEl = document.getElementById('dep-qr-name');
        if (nameEl) nameEl.textContent = String(_depPaySettings.payeeName || '').trim() || 'Tournixo';
        const upiEl = document.getElementById('dep-qr-upi');
        if (upiEl) upiEl.textContent = String(_depPaySettings.adminUpiId || '').trim();
        card.hidden = false;
        hideQrError();
        _depQrPayload = payload;
    } catch (e) {
        card.hidden = true;
        _depQrPayload = null;
        showQrError();
    }
}

function downloadDepQr() {
    const payload = _depQrPayload || buildDepQrPayload();
    if (!payload || typeof qrcode !== 'function') {
        showToast('QR তৈরি হয়নি। আবার চেষ্টা করো।', 'error');
        return;
    }
    try {
        const qr = makeDepQr(payload);
        // Download PNG: white sheet, QR on top, payee name + UPI ID below.
        const W = 640, qrPx = 480, top = 40;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = top + qrPx + 150;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        const tmp = document.createElement('canvas');
        drawQrOnCanvas(tmp, qr, qrPx);
        ctx.drawImage(tmp, (W - qrPx) / 2, top);
        ctx.fillStyle = '#111111';
        ctx.textAlign = 'center';
        ctx.font = '600 30px Manrope, sans-serif';
        ctx.fillText(String(_depPaySettings.payeeName || 'Tournixo'), W / 2, top + qrPx + 48);
        ctx.fillStyle = '#555555';
        ctx.font = '500 24px monospace';
        ctx.fillText(String(_depPaySettings.adminUpiId || ''), W / 2, top + qrPx + 88);
        ctx.fillStyle = '#777777';
        ctx.font = '500 20px Manrope, sans-serif';
        ctx.fillText('Scan with any UPI app', W / 2, top + qrPx + 124);
        cv.toBlob(async (blob) => {
            if (!blob) {
                showToast('QR ডাউনলোড হয়নি। আবার চেষ্টা করো।', 'error');
                return;
            }
            // FIX (2026-11-19, v8.11, APK-DOWNLOAD): আগের anchor download
            // APK WebView-তে চুপচাপ কিছুই করত না। helper native-এ
            // MediaStore দিয়ে Downloads-এ সেভ করে, web-এ আগের মতোই।
            const r = await saveImageFile({ blob, filename: 'tournixo-pay-qr.png', mimeType: 'image/png' });
            if (r.ok && r.method === 'native') showToast('QR Downloads-এ সেভ হয়েছে', 'success', 3000);
            else if (!r.ok) showToast('QR ডাউনলোড হয়নি। আবার চেষ্টা করো।', 'error');
        }, 'image/png');
    } catch (e) {
        showToast('QR ডাউনলোড হয়নি। আবার চেষ্টা করো।', 'error');
    }
}


// FIX (2026-11-20, W6): quick-amount chips admin min/max থেকে বানানো —
// hardcoded ₹50/100/500/1000 chip min/max-এর বাইরের amount বসিয়ে
// validation-এ ফেল করাত। Sheet খোলার প্রতিবার limits দিয়ে rebuild হয়।
function buildDepChips() {
    const wrap = document.querySelector('.dep-chips');
    const amtInput = document.getElementById('dep-amount-input');
    if (!wrap) return;
    const limits = _depLimits || { min: APP_CONFIG.defaultMinDeposit, max: APP_CONFIG.defaultMaxDeposit };
    const candidates = [limits.min, 100, 200, 500, 1000, limits.max];
    const amounts = [...new Set(candidates.filter(a => Number.isFinite(a) && a >= limits.min && a <= limits.max))].sort((a, b) => a - b);
    wrap.innerHTML = amounts.map(a => `<button type="button" class="dep-chip" data-amt="${a}">₹${a}</button>`).join('');
    wrap.querySelectorAll('.dep-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            if (amtInput) {
                amtInput.value = chip.dataset.amt;
                amtInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            wrap.querySelectorAll('.dep-chip').forEach((c) => c.classList.toggle('active', c === chip));
        });
    });
}

export async function openDepositSheet() {
    const overlay = document.getElementById('overlay-deposit');
    if (!overlay) return;
    overlay.classList.add('active');
    setDepError(null);
    const _depSubmitBtn = document.getElementById('dep-submit-btn');
    if (_depSubmitBtn) _depSubmitBtn.disabled = false;
    // v8.8 (item 6): settings/deposit না থাকলে ফর্ম খুলেই আটকাও —
    // persistent Bengali message + submit disable; user ভুল
    // permission-denied toast দেখে submit চাপবে না।
    try {
        const _depSettingsState = await checkDepositSettings();
        if (_depSettingsState.state === 'missing' || (_depSettingsState.state === 'error' && _depSettingsState.code === 'permission-denied')) {
            setDepError(DEPOSIT_SETTINGS_MISSING_MESSAGE);
            if (_depSubmitBtn) _depSubmitBtn.disabled = true;
        }
    } catch (e) { /* settings read fail — service guard-ই submit-এ আটকাবে */ }
    const amtInput = document.getElementById('dep-amount-input');
    if (amtInput && !amtInput.dataset.wired) {
        amtInput.dataset.wired = '1';
        amtInput.addEventListener('input', updateDepIntentLink);
    }
    const dlBtn = document.getElementById('dep-qr-download');
    if (dlBtn && !dlBtn.dataset.wired) {
        dlBtn.dataset.wired = '1';
        dlBtn.addEventListener('click', downloadDepQr);
    }
    // Limits first (cheap, cached) so the sheet always shows the range.
    try {
        _depLimits = await fetchDepositLimits();
        const lt = document.getElementById('dep-limits-text');
        if (lt) lt.textContent = `Minimum ₹${_depLimits.min} · Maximum ₹${_depLimits.max} per request`;
    } catch (e) {
        _depLimits = { min: APP_CONFIG.defaultMinDeposit, max: APP_CONFIG.defaultMaxDeposit };
    }
    // FIX (2026-11-20, W6): chips limits দিয়ে rebuild — hardcoded chip
    // min/max-এর বাইরের amount বসাত।
    buildDepChips();
    // Admin UPI (same settings/payment source as the payment page).
    const upiDisplay = document.getElementById('dep-upi-id-display');
    try {
        _depPaySettings = await fetchPaymentSettings();
        // CARD REDESIGN (2026-11-09): recipient card — payee name + lime
        // avatar initial, from the same settings/payment source.
        const payeeNameEl = document.getElementById('dep-payee-name');
        if (payeeNameEl) payeeNameEl.textContent = _depPaySettings.payeeName;
        const avatarEl = document.getElementById('dep-payee-avatar');
        if (avatarEl) avatarEl.textContent = String(_depPaySettings.payeeName || 'T').trim().charAt(0).toUpperCase() || 'T';
        if (upiDisplay) upiDisplay.textContent = _depPaySettings.adminUpiId;
        const copyBtn = document.getElementById('dep-upi-copy');
        if (copyBtn) {
            copyBtn.hidden = false;
            copyBtn.onclick = () => window.copyText(_depPaySettings.adminUpiId, 'UPI ID');
        }
        updateDepIntentLink();
    } catch (e) {
        if (upiDisplay) upiDisplay.textContent = '—';
        const copyBtn = document.getElementById('dep-upi-copy');
        if (copyBtn) copyBtn.hidden = true;
        showToast('পেমেন্টের তথ্য লোড হয়নি। আবার চেষ্টা করো।', 'error');
    }
}

export function closeDepositSheet() {
    const overlay = document.getElementById('overlay-deposit');
    if (overlay) overlay.classList.remove('active');
}

export async function submitDepositRequest() {
    const uid = state.currentUser?.uid;
    if (!uid) {
        showToast('সেশন শেষ হয়ে গেছে। আবার সাইন ইন করো।', 'error');
        return;
    }
    const submitBtn = document.getElementById('dep-submit-btn');
    const amtInput = document.getElementById('dep-amount-input');
    const trxInput = document.getElementById('dep-trxid-input');
    const amount = Math.round((Number(amtInput?.value) || 0) * 100) / 100;
    const trxId = String(trxInput?.value || '').trim();

    const limits = _depLimits || { min: APP_CONFIG.defaultMinDeposit, max: APP_CONFIG.defaultMaxDeposit };
    let errMsg = '';
    if (!Number.isFinite(amount) || amount <= 0) {
        errMsg = 'সঠিক পরিমাণ দাও।';
    } else if (amount < limits.min) {
        errMsg = `সর্বনিম্ন ডিপোজিট ₹${limits.min}`;
    } else if (amount > limits.max) {
        errMsg = `সর্বোচ্চ ডিপোজিট ₹${limits.max}`;
    } else if (!trxId) {
        errMsg = 'তোমার UPI Transaction / UTR ID দাও';
    } else if (!isValidTrxId(trxId)) {
        errMsg = 'সঠিক Transaction / UTR ID দাও (কমপক্ষে ৮ অক্ষর, space ছাড়া)';
    }
    if (errMsg) {
        setDepError(errMsg);
        showToast(errMsg, 'error');
        return;
    }

    // Disable BEFORE the async call so a double-tap cannot file twice.
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
    }
    setDepError(null);
    try {
        await requestDeposit({
            uid,
            userName: (state.userData || {}).name,
            amount,
            transactionId: trxId
        });
        flashToast('তোমার ডিপোজিট আবেদন সফলভাবে জমা হয়েছে।', 'success', 5000);
        closeDepositSheet();
        // Refresh the Deposits tab + pending note with the new request.
        depositHistoryLoaded = false;
        _depositForceRefresh = true;
        if (state.txTab === 'deposit') setTxTab('deposit');
        else loadDepositHistory().catch(() => {});
        loadPendingDepositNote();
    } catch (err) {
        // v8.6 (G): service / Firebase error বাংলায় (friendlyErrorMessage)।
        const friendly = friendlyErrorMessage(err);
        setDepError(friendly);
        showToast(friendly, 'error', 4500);
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Deposit Request';
        }
    }
}

window.openDepositSheet = openDepositSheet;
window.closeDepositSheet = closeDepositSheet;
window.submitDepositRequest = submitDepositRequest;

export function openWithdraw() {
    // Winning Balance can never exceed Earned Money — gate on the clamped value.
    const bal = effectiveWinningBalance(state.userData);
    // constant-based fallback, no more hard-coded 100
    const min = Number(state.minWithdrawal || DEFAULT_MIN_WITHDRAWAL);
    if (bal < min) {
        showToast(`সর্বনিম্ন উত্তোলন ₹${min}। তোমার উপলব্ধ ব্যালেন্স ₹${bal.toFixed(2)}`, 'error', 4000);
        return;
    }
    goTo('withdrawal');
}

window.setTxTab = setTxTab;
window.openWithdraw = openWithdraw;

initPage({
    page: 'wallet',
    tab: 'wallet',
    onReady: () => {
        loadMinWithdrawal();
        loadDepositLimits();
        loadWallet();
    }
});
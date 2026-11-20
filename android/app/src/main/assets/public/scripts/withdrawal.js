// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { initPage, effectiveWinningBalance } from './app.js';
import { state } from './state.js';
import { showToast, flashToast, friendlyErrorMessage } from './toast.js';
import { goBack, goReplace } from '../config/app-config.js';
import { loadMinWithdrawal, checkDepositSettings, DEPOSIT_SETTINGS_MISSING_MESSAGE } from '../services/settings.service.js';
import { requestWithdrawal } from '../services/withdrawal.service.js';
import { APP_CONFIG } from '../utils/constants.js';   // min-withdrawal constant
import { isValidUpiId } from '../utils/validators.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. Hard-coded `100` min-withdrawal fallback (line 20, 74) removed —
 *    APP_CONFIG.defaultMinWithdrawal is used instead.
 *       state.minWithdrawal না এলে সেটাই default।
 * ─────────────────────────────────────────────────────────────
 */

const DEFAULT_MIN_WITHDRAWAL = APP_CONFIG.defaultMinWithdrawal;

// (2026-11-19) selectWdMethod REMOVED: the sheet had a single UPI chip
// with nothing to toggle — dead UI. UPI is the only method, no chip.
// (2026-11-19) No max-withdrawal setting exists anywhere (no value in
// settings or APP_CONFIG) — so the honest maximum is the Winning Balance
// itself. This overwrites the min-only text that loadMinWithdrawal sets.
function updateWdMinMaxText() {
    const min = Number(state.minWithdrawal || DEFAULT_MIN_WITHDRAWAL);
    const wt = document.getElementById('wd-min-text');
    if (wt) wt.textContent = `Minimum withdrawal: ₹${min} · Maximum: your Winning Balance`;
}

export async function submitWithdraw() {
    const uid = state.currentUser?.uid;
    // FIX (2026-10-25, W6): uid কখনো undefined হলে (অন্য tab-এ sign-out)
    // Firestore query-তে raw SDK error দেখাত। এখন আগেই ধরে friendly
    // message + login-এ পাঠানো হয়।
    if (!uid) {
        showToast('সেশন শেষ হয়ে গেছে। আবার সাইন ইন করো।', 'error');
        goReplace('login');
        return;
    }
    const u = state.userData || {};
    const rawAmount = parseFloat(document.getElementById('wd-amount').value);
    // Round to 2 decimal places to avoid floating-point dust (e.g. 100.999999)
    const amount = Math.round((Number(rawAmount) || 0) * 100) / 100;
    const upiId = document.getElementById('wd-phone').value.trim();

    // fallback now comes from APP_CONFIG, not hard-coded 100
    const min = Number(state.minWithdrawal || DEFAULT_MIN_WITHDRAWAL);

    if (!amount || isNaN(amount) || amount < min) {
        showToast(`সর্বনিম্ন উত্তোলন ₹${min}`, 'error');
        return;
    }
    if (!upiId) {
        showToast('টাকা পাওয়ার UPI ID দাও', 'error');
        return;
    }
    if (!isValidUpiId(upiId)) {
        showToast('সঠিক UPI ID দাও (যেমন: 9876543210@upi)', 'error');
        return;
    }

    const submitBtn = document.querySelector('#overlay-withdraw .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';
    }

    try {
        await requestWithdrawal({
            uid,
            userName: u.name,
            amount,
            phone: upiId,
            method: state.wdMethod
        });
        flashToast('উত্তোলনের আবেদন জমা হয়েছে।', 'success', 4000);
        goReplace('wallet');
    } catch (err) {
        // FIX (2026-10-25, W6): service-এর নিজের validation message যেমন
        // আছে তেমনই দেখাবে; শুধু raw SDK error-কে friendly করা হলো।
        // v8.6 (G): service / Firebase error বাংলায় (friendlyErrorMessage)।
        showToast(friendlyErrorMessage(err), 'error', 4500);
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Request Withdrawal';
        }
    }
}

export function closeWithdrawSheet() {
    goBack('wallet');
}

window.submitWithdraw = submitWithdraw;
window.closeWithdrawSheet = closeWithdrawSheet;

initPage({
    page: 'withdrawal',
    onReady: async () => {
        // v8.8 (item 6): settings/deposit না থাকলে ফর্ম আগেই আটকাও —
        // persistent Bengali message + submit disable। Balance gate-এর
        // আগেই return, যাতে message দেখা অবস্থায় page wallet-এ না যায়।
        try {
            const _wdSettingsState = await checkDepositSettings();
            if (_wdSettingsState.state === 'missing' || (_wdSettingsState.state === 'error' && _wdSettingsState.code === 'permission-denied')) {
                const errEl = document.getElementById('wd-settings-error');
                if (errEl) { errEl.textContent = DEPOSIT_SETTINGS_MISSING_MESSAGE; errEl.style.display = ''; }
                const submitBtn = document.querySelector('#overlay-withdraw .btn-primary');
                if (submitBtn) submitBtn.disabled = true;
                await loadMinWithdrawal();
                updateWdMinMaxText();
                return;
            }
        } catch (e) { /* settings read fail — service guard-ই submit-এ আটকাবে */ }
        await loadMinWithdrawal();
        updateWdMinMaxText();
        // Winning Balance can never exceed Earned Money — gate on the clamped value.
        const bal = effectiveWinningBalance(state.userData);
        // same fallback constant, no more magic number
        const min = Number(state.minWithdrawal || DEFAULT_MIN_WITHDRAWAL);
        if (bal < min) {
            flashToast(`সর্বনিম্ন উত্তোলন ₹${min}। তোমার উপলব্ধ ব্যালেন্স ₹${bal.toFixed(2)}`, 'error', 4000);
            goBack('wallet');
        }
    }
});
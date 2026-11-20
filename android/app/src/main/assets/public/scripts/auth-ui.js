// ════════════════════════════════════════════════════════════════
// Auth UI handlers: login, register, forgot password, logout.
// • login.html / register.html load this file directly (data-page decides).
// • profile page imports { confirmLogout } from here (no page init there).
// ════════════════════════════════════════════════════════════════
import { initPage } from './app.js';
import { showToast, flashToast, friendlyErrorMessage } from './toast.js';
// v8.6 (G): বাকি English toast-গুলোও সহজ পেশাদার বাংলায় করা হয়েছে — auth-ui-র English toast + error map বাংলায়
import { openModal, closeModal, showConfirm } from './modal.js';
import { redirectToLogin } from './navigation.js';
import { goReplace } from '../config/app-config.js';
import { setLoading, mountComponent } from '../utils/dom-helpers.js';
import { isValidEmail, isNumeric, MIN_PASSWORD_LENGTH } from '../utils/validators.js';
import { loginWithEmail, sendResetEmail, registerUser, logoutUser, resendVerificationEmail, setPendingVerifyEmail, setVerifySendFailed, clearVerifySendFailed } from '../services/auth.service.js';

let _forgotModalReady = null;

// ── Resend verification email ──
const RESEND_COOLDOWN_MS = 60 * 1000;
let _resendLastAt = 0;
let _resendTimer = null;

function removeResendButton() {
    if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
    const old = document.getElementById('resend-verify-btn');
    if (old) old.remove();
}

function showResendButton() {
    // FIX (2026-11-20, A2): dead code ছিল — কেউ ডাকত না। এখন doLogin-এর
    // catch থেকে ডাকা হয়, আর static বোতাম (login.html .auth-links-এ
    // "Resend verification" link-btn) মুছে গিয়ে থাকলে ঠিক একই জায়গায়
    // একই style-এ ফিরিয়ে আনে।
    if (document.getElementById('resend-verify-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'resend-verify-btn';
    btn.type = 'button';
    btn.className = 'link-btn';
    btn.textContent = 'Resend verification';
    btn.onclick = resendVerification;
    const links = document.querySelector('.auth-links');
    if (links) {
        if (typeof links.prepend === 'function') links.prepend(btn);
        else links.insertBefore(btn, links.firstChild);
        return;
    }
    const loginBtn = document.getElementById('login-btn');
    if (!loginBtn) return;
    loginBtn.insertAdjacentElement('beforebegin', btn);
}

function startResendCooldown(btn) {
    if (_resendTimer) clearInterval(_resendTimer);
    const tick = () => {
        const left = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - _resendLastAt)) / 1000);
        if (left <= 0) {
            clearInterval(_resendTimer);
            _resendTimer = null;
            btn.disabled = false;
            btn.textContent = 'Resend verification email';
        } else {
            btn.disabled = true;
            btn.textContent = 'Resend again in ' + left + 's';
        }
    };
    tick();
    _resendTimer = setInterval(tick, 1000);
}

export async function resendVerification() {
    const btn = document.getElementById('resend-verify-btn');
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    if (!email || !pass) {
        showToast('আগে email আর password দাও', 'error');
        return;
    }
    if (Date.now() - _resendLastAt < RESEND_COOLDOWN_MS) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    try {
        await resendVerificationEmail(email, pass);
        _resendLastAt = Date.now();
        showToast('ভেরিফিকেশন লিংক পাঠানো হয়েছে: ' + email + ' — Spam ফোল্ডারটাও চেক করো।', 'success', 6000);
        if (btn) startResendCooldown(btn);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Resend verification email'; }
        const msgs = {
            'auth/invalid-credential': 'Email বা Password ভুল হয়েছে',
            'auth/wrong-password': 'Password ভুল হয়েছে',
            'auth/user-not-found': 'এই email-এ কোনো account নেই',
            'auth/invalid-email': 'Email address টি সঠিক নয়',
            'auth/too-many-requests': 'অনেকবার চেষ্টা হয়েছে। একটু পরে আবার চেষ্টা করো।',
            'auth/email-already-verified': 'তোমার email ইতিমধ্যে ভেরিফাই হয়েছে — এখন সাইন ইন করো।'
        };
        showToast(msgs[e.code] || friendlyErrorMessage(e), 'error', 5000);
        if (e.code === 'auth/email-already-verified') removeResendButton();
    }
}

export async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    if (!email || !pass) {
        showToast('সব তথ্য পূরণ করো', 'error');
        const errEl0 = document.getElementById('login-error');
        if (errEl0) errEl0.textContent = 'সব তথ্য পূরণ করো';
        return;
    }
    setLoading('login-btn', true);
    const errElClear = document.getElementById('login-error');
    if (errElClear) errElClear.textContent = '';
    try {
        // On success, scripts/app.js (auth listener) redirects to home
        await loginWithEmail(email, pass);
    } catch (e) {
        setLoading('login-btn', false);
        // FIX (2026-11-20, A2): doLogin আগেই removeResendButton() ডাকত —
        // ভুল password-এও static "Resend verification" বোতাম DOM থেকে
        // মুছে যেত, reload ছাড়া resend path থাকত না। এখন আর মুছি না;
        // উল্টো fail হলে বোতাম ফিরিয়ে আনি (না থাকলে)।
        showResendButton();
        const msgs = {
            'auth/invalid-credential': 'Email বা Password ভুল হয়েছে',
            'auth/user-not-found': 'এই email-এ কোনো account নেই',
            'auth/wrong-password': 'Password ভুল হয়েছে',
            'auth/invalid-email': 'Email address টি সঠিক নয়',
            'auth/too-many-requests': 'অনেকবার চেষ্টা হয়েছে। একটু পরে আবার চেষ্টা করো।',
            'auth/user-disabled': 'এই account টি বন্ধ করা হয়েছে',
            // v8.6 (C, device ban): loginWithEmail throws this after
            // signing a banned device back out.
            'auth/device-banned': 'এই ডিভাইস থেকে অ্যাকাউন্ট ব্যবহার করা যাবে না।'
        };
        showToast(msgs[e.code] || friendlyErrorMessage(e), 'error');
        // FIX (2026-11-20): login পেজের #login-error লাইনটা শুধু
        // সাজানো ছিল — error শুধু toast-এ যেত। এখন লাইনেও লেখা হয়।
        const errEl = document.getElementById('login-error');
        if (errEl) errEl.textContent = msgs[e.code] || friendlyErrorMessage(e);
    }
}

export async function showForgotPass() {
    if (_forgotModalReady) await _forgotModalReady;
    const loginEmail = document.getElementById('login-email')?.value.trim() || '';
    const forgotInput = document.getElementById('forgot-email');
    if (forgotInput) forgotInput.value = loginEmail;
    openModal('modal-forgot-pass');
}

export async function sendPasswordReset() {
    const email = document.getElementById('forgot-email').value.trim();
    if (!email) {
        showToast('Email address দাও', 'error');
        return;
    }
    if (!isValidEmail(email)) {
        showToast('সঠিক Email address দাও', 'error');
        return;
    }
    setLoading('forgot-send-btn', true);
    try {
        await sendResetEmail(email);
        setLoading('forgot-send-btn', false);
        showToast('Password reset link পাঠানো হয়েছে! Email inbox চেক করো।', 'success', 5000);
        closeModal('modal-forgot-pass');
    } catch (e) {
        setLoading('forgot-send-btn', false);
        const msgs = {
            'auth/user-not-found': 'এই email-এ কোনো account নেই',
            'auth/invalid-email': 'Email address টি সঠিক নয়',
            'auth/too-many-requests': 'অনেকবার চেষ্টা হয়েছে। একটু পরে আবার চেষ্টা করো।'
        };
        showToast(msgs[e.code] || friendlyErrorMessage(e), 'error');
    }
}

export async function doRegister() {
    const name = document.getElementById('reg-name').value.trim();
    const ffUID = document.getElementById('reg-ffuid').value.trim();
    // IN NUMBER (2026-11-13): Indian mobile is REQUIRED — 10 digits,
    // 6/7/8/9 দিয়ে শুরু। +91 / 91 / 0 লিখলেও চলবে, ওগুলো ফেলে দিয়ে
    // শুধু 10 digit রাখা হয়। Bangladesh-এর 01... নম্বর আর চলবে না।
    let phone = document.getElementById('reg-phone').value.replace(/[\s-]/g, '').trim();
    if (phone.startsWith('+91')) phone = phone.slice(3);
    else if (phone.startsWith('91') && phone.length === 12) phone = phone.slice(2);
    else if (phone.startsWith('0')) phone = phone.slice(1);
    const email = document.getElementById('reg-email').value.trim();
    const pass = document.getElementById('reg-pass').value;
    const cpass = document.getElementById('reg-cpass').value;

    if (!name || !ffUID || !phone || !email || !pass || !cpass) {
        showToast('সব তথ্য পূরণ করো', 'error');
        return;
    }
    if (name.length > 25) {
        showToast('IGN সর্বোচ্চ ২৫ অক্ষর হতে পারবে', 'error');
        return;
    }
    if (!isNumeric(ffUID)) {
        showToast('Free Fire UID শুধু সংখ্যা দিয়ে হতে হবে', 'error');
        return;
    }
    if (!/^\d{8,12}$/.test(ffUID)) {
        showToast('Free Fire UID ৮ থেকে ১২ সংখ্যার হতে হবে', 'error');
        return;
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
        showToast('সঠিক ভারতীয় মোবাইল নম্বর দাও — 10 সংখ্যার, 6/7/8/9 দিয়ে শুরু (যেমন 98765 43210)', 'error');
        return;
    }
    if (pass !== cpass) {
        showToast('Password দুটো মিলছে না', 'error');
        return;
    }
    if (pass.length < MIN_PASSWORD_LENGTH) {
        showToast('Password কমপক্ষে ৬ অক্ষরের হতে হবে', 'error');
        return;
    }

    if (!document.getElementById('reg-terms')?.checked) {
        showToast('Terms & Conditions এ সম্মত হতে হবে', 'error');
        return;
    }

        setLoading('reg-btn', true);
    try {
        // v8.8 (item 5, surface_real_errors): registerUser reports
        // whether the verification mail REALLY went out. A send failure
        // must never flash a "mail sent" success toast — the failure is
        // stored so the Verify page shows it persistently instead.
        const regRes = await registerUser({ name, ffUID, email, pass, phone });
        // v8.6 (F): the session is KEPT after register — the verify page
        // polls and routes Home once verified. Persist the pending email
        // so reopening the app shows the Verify page again.
        setPendingVerifyEmail(email);
        try { sessionStorage.setItem('verify_email', email); } catch (_) {}
        if (regRes && regRes.verificationEmailSent === false) {
            setVerifySendFailed(regRes.verificationErrorCode || '');
            flashToast('ভেরিফিকেশন মেইল পাঠানো যায়নি — Verify পেজে কারণ ও পরের ধাপ দেখো', 'error', 6000);
        } else {
            clearVerifySendFailed();
            flashToast('ভেরিফিকেশন মেইল পাঠানো হয়েছে — ইনবক্স চেক করে ইমেইল ভেরিফাই করো', 'success', 5000);
        }
        goReplace('verify-email');
    } catch (e) {
        setLoading('reg-btn', false);
        if (e.code === 'auth/email-already-in-use') {
            // v8.6 (F): re-registering with the same email shows the
            // Verify page again (not a plain login) — the verify page
            // auto-routes Home if the account is already verified, and
            // offers Resend + a check button if it is not.
            setPendingVerifyEmail(email);
            try { sessionStorage.setItem('verify_email', email); } catch (_) {}
            showToast('এই Email দিয়ে আগেই account আছে — ভেরিফিকেশন চেক করো', 'error', 4500);
            goReplace('verify-email');
            return;
        }
        if (e.code === 'auth/ffuid-already-in-use') {
            showToast('এই Free Fire UID দিয়ে আগেই account আছে! অন্য UID ব্যবহার করো।', 'error', 5000);
            return;
        }
        const msgs = {
            'auth/invalid-email': 'Email address টি সঠিক নয়',
            'auth/weak-password': 'Password অনেক দুর্বল, আরও শক্তিশালী password দাও',
            // v8.6 (C, device ban): registerUser throws this before the
            // Auth account is created when the device is banned.
            'auth/device-banned': 'এই ডিভাইস থেকে অ্যাকাউন্ট ব্যবহার করা যাবে না।'
        };
        showToast(msgs[e.code] || friendlyErrorMessage(e), 'error', 4500);
    }
}

// Used by the profile page "Log Out" button
export function confirmLogout() {
    showConfirm('Log Out', 'Are you sure you want to sign out?', async () => {
        // FIX (2026-11-20, A3): success toast শুধু signOut সফল হলেই —
        // আগে toast আগেই দেখাত, signOut fail করলে user ভাবত হয়ে গেছে
        // অথচ redirect-ও চলত না।
        try {
            await logoutUser();
            flashToast('সফলভাবে সাইন আউট হয়েছে', 'success');
            redirectToLogin();
        } catch (e) {
            showToast(friendlyErrorMessage(e), 'error');
        }
    });
}

// Inline onclick handlers in the HTML need these on window (same names as original)
window.doLogin = doLogin;
window.resendVerification = resendVerification;
window.showForgotPass = showForgotPass;
window.sendPasswordReset = sendPasswordReset;
window.doRegister = doRegister;
window.confirmLogout = confirmLogout;

// ── Enter / mobile keyboard "Go" support ──
// No <form> is used, so we handle Enter ourselves. Delegated on document so it
// also covers the forgot-password modal, which is mounted after page load.
//   next   : Enter moves focus to that field
//   submit : Enter runs the action (only if its button is not already loading)
const ENTER_FLOW = {
    'login-email':  { next: 'login-pass' },
    'login-pass':   { submit: 'login-btn', run: () => doLogin() },
    'reg-name':     { next: 'reg-ffuid' },
    // v8.6 (E): reg-phone sits between FF UID and email in the form.
    'reg-ffuid':    { next: 'reg-phone' },
    'reg-phone':    { next: 'reg-email' },
    'reg-email':    { next: 'reg-pass' },
    'reg-pass':     { next: 'reg-cpass' },
    'reg-cpass':    { submit: 'reg-btn', run: () => doRegister() },
    'forgot-email': { submit: 'forgot-send-btn', run: () => sendPasswordReset() }
};

// Shows "Next" / "Go" on the mobile keyboard's action key
document.addEventListener('focusin', (e) => {
    const flow = ENTER_FLOW[e.target && e.target.id];
    if (flow) e.target.enterKeyHint = flow.next ? 'next' : 'go';
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    const flow = ENTER_FLOW[e.target && e.target.id];
    if (!flow) return;
    e.preventDefault();
    if (flow.next) {
        const nextEl = document.getElementById(flow.next);
        if (nextEl) nextEl.focus();
        return;
    }
    const btn = document.getElementById(flow.submit);
    if (btn && btn.disabled) return; // already submitting
    flow.run();
});

// ── Page init (only on login / register pages) ──
const _page = document.body && document.body.dataset ? document.body.dataset.page : null;
if (_page === 'login' || _page === 'register') {
    if (_page === 'login') {
        _forgotModalReady = mountComponent('forgot-password-modal', document.getElementById('app'));
    }
    initPage({ page: _page });
}
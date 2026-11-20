import {
    auth,
    db,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    sendPasswordResetEmail,
    sendEmailVerification,
    reload,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    runTransaction,
    serverTimestamp
} from '../firebase/firebase-init.js';
import { state } from '../scripts/state.js';
import { oneSignalLogout } from './onesignal.service.js';
import { clearSessionUser } from '../scripts/cache.js';
import { resetGlobalPopupListener } from './notifications.service.js';
// v8.6 (C, device ban — mirrors admin BUILD 31 auth.js I2): device id,
// banned-device check (fail open) and best-effort deviceIds recording.
import { getOrCreateDeviceId, isDeviceBanned, recordDeviceId, DEVICE_BANNED_MESSAGE } from './device-ban.js';

export async function loginWithEmail(email, pass) {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    // v8.6 (C, device ban — mirrors admin BUILD 31 auth.js I2): a banned
    // device may not log in. Checked AFTER sign-in — the bannedDevices
    // doc is keyed by device, not by user, so there is nothing to check
    // before Auth runs. A failed/denied read fails OPEN inside
    // isDeviceBanned(), so this never locks anyone out by mistake.
    const deviceId = getOrCreateDeviceId();
    if (await isDeviceBanned(deviceId)) {
        await signOut(auth).catch(() => {});
        const err = new Error(DEVICE_BANNED_MESSAGE);
        err.code = 'auth/device-banned';
        throw err;
    }
    // v8.6 (C): remember this device on the user doc (arrayUnion — never
    // overwrites other ids). Best effort only — recordDeviceId() never
    // throws, and under firestore.rules v18 the write is denied until
    // the merged rules step adds deviceIds to the owner-update
    // allow-list (see services/device-ban.js), so login never blocks.
    await recordDeviceId(cred.user.uid, deviceId);
    // v8.6 (F): verification is enforced by the app.js auth gate + the
    // verify page (unverified sign-ins are routed to verify-email) —
    // login itself just signs in, it does not decide the destination.
    return cred;
}

export function sendResetEmail(email) {
    return sendPasswordResetEmail(auth, email);
}

// v8.11.1 (B4, FF UID edit): the ONE shared FF UID validator — the same
// rule the register form checks (scripts/auth-ui.js:177-181: isNumeric +
// /^\d{8,12}$/). registerUser() itself never re-validates the format, so
// this helper is the single source of truth for every later check.
export function isValidFFUID(value) {
    return /^\d{8,12}$/.test(String(value || '').trim());
}

// v8.11.1 (B4, FF UID edit): change the signed-in user's Free Fire UID and
// re-claim it in registeredUIDs — the same two-phase shape as register
// (profile doc FIRST, then the claim, because the registeredUIDs create
// rule cross-checks that the caller's OWN users doc already carries the
// new UID). Used by BOTH account-settings.js and profile.js, so the
// logic exists exactly once.
//
// Order (do NOT reorder — the rules depend on it):
//   (a) validate format (8–12 digits, same as register); reject if the
//       new UID equals the current one.
//   (b) read registeredUIDs/{newUID}: it must not exist, or its userId
//       must be my own uid (my own stale claim from an interrupted
//       earlier change is fine to overwrite).
//   (c) updateDoc users/{uid} { ffUID: newUID, updatedAt } — the rules
//       (updated in parallel) allow an owner-only ffUID+updatedAt update.
//   (d) in ONE transaction: create registeredUIDs/{newUID}
//       { userId: uid, registeredAt } (re-checked inside the txn, so a
//       racer who grabbed the UID after step (b) is still caught) and,
//       if the old claim exists AND its userId is mine, delete
//       registeredUIDs/{oldUID} (owner-delete of own claim — also a
//       parallel rules change; someone else's claim is never touched).
//   (e) on ANY failure after step (c), revert users/{uid}.ffUID to the
//       old value (best effort) and rethrow — the caller shows a Bengali
//       error. Success is reported ONLY when the claim exists, so the
//       user is never left with no UID and never told "done" falsely.
//   A legacy account with NO ffUID yet (oldUID '') works the same way:
//   step (c) sets it, step (d) creates the claim, nothing to delete.
//   If the parallel rules change is NOT published yet, step (c) or (d)
//   fails with permission-denied, the revert runs, and the caller shows
//   the failure — nothing is faked as success.
export async function changeMyFFUID(newUID) {
    const user = auth.currentUser;
    if (!user) {
        const err = new Error('আগে সাইন ইন করো');
        err.code = 'auth/no-current-user';
        throw err;
    }
    const uid = user.uid;
    const next = String(newUID || '').trim();
    if (!isValidFFUID(next)) {
        const err = new Error('Free Fire UID ৮–১২ সংখ্যার হতে হবে');
        err.code = 'auth/invalid-ffuid';
        throw err;
    }
    // Fresh read of the profile — never stale state.userData (the join
    // pre-check bug in join-tournament.js is exactly this staleness).
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    const oldUID = String(userSnap.data()?.ffUID || '').trim();
    if (next === oldUID) {
        const err = new Error('নতুন UID আগের UID-এর মতোই — অন্য UID দাও');
        err.code = 'auth/ffuid-unchanged';
        throw err;
    }
    // (b) New-UID claim must be free, or already mine (stale claim).
    const newClaimRef = doc(db, 'registeredUIDs', next);
    const newClaimSnap = await getDoc(newClaimRef);
    if (newClaimSnap.exists() && newClaimSnap.data()?.userId !== uid) {
        const err = new Error('এই Free Fire UID দিয়ে আগেই একটি account আছে! অন্য UID ব্যবহার করো।');
        err.code = 'auth/ffuid-already-in-use';
        throw err;
    }
    // (c) Profile first — the claim rule requires users/{uid}.ffUID to
    // already equal the new UID.
    let profileUpdated = false;
    try {
        await updateDoc(userRef, { ffUID: next, updatedAt: serverTimestamp() });
        profileUpdated = true;
        // (d) Claim the new UID + release the old one, atomically.
        await runTransaction(db, async (transaction) => {
            const claimSnap = await transaction.get(newClaimRef);
            if (claimSnap.exists() && claimSnap.data()?.userId !== uid) {
                const err = new Error('এই Free Fire UID দিয়ে আগেই একটি account আছে! অন্য UID ব্যবহার করো।');
                err.code = 'auth/ffuid-already-in-use';
                throw err;
            }
            transaction.set(newClaimRef, {
                userId: uid,
                registeredAt: serverTimestamp()
            });
            if (oldUID && oldUID !== next) {
                const oldClaimRef = doc(db, 'registeredUIDs', oldUID);
                const oldSnap = await transaction.get(oldClaimRef);
                if (oldSnap.exists() && oldSnap.data()?.userId === uid) {
                    transaction.delete(oldClaimRef);
                }
            }
        });
    } catch (e) {
        // (e) Anything failed after step (c): put the old UID back so
        // the user is never left UID-less. Best effort — if the revert
        // itself is denied, the error still propagates and the caller
        // tells the user to retry / contact admin.
        if (profileUpdated) {
            try {
                await updateDoc(userRef, { ffUID: oldUID, updatedAt: serverTimestamp() });
            } catch (_) {}
        }
        throw e;
    }
    if (state.userData) {
        state.userData.ffUID = next;
        state.userDataCacheAt = Date.now();
    }
    return { oldUID, newUID: next };
}

export async function registerUser({ name, ffUID, email, pass, phone }) {
    // IN NUMBER (2026-11-13): Indian mobile is required — 10 digits,
    // 6/7/8/9 দিয়ে শুরু। +91 / 91 / 0 লিখলেও চলবে, ওগুলো ফেলে দিয়ে
    // শুধু 10 digit save হয়। Bangladesh-এর 01... নম্বর আর চলবে না।
    // Normalised here too (not only in the form) so no caller can store
    // a bad number on the user doc. Validated BEFORE state.registering
    // is set, so a validation throw cannot leave the flag stuck on.
    let mobile = String(phone || '').replace(/[\s-]/g, '');
    if (mobile.startsWith('+91')) mobile = mobile.slice(3);
    else if (mobile.startsWith('91') && mobile.length === 12) mobile = mobile.slice(2);
    else if (mobile.startsWith('0')) mobile = mobile.slice(1);
    if (!/^[6-9]\d{9}$/.test(mobile)) {
        const err = new Error('সঠিক ভারতীয় মোবাইল নম্বর দাও — 10 সংখ্যার, 6/7/8/9 দিয়ে শুরু (যেমন 98765 43210)');
        err.code = 'auth/invalid-phone';
        throw err;
    }
    state.registering = true;
    let createdUser = null;
    let profileCommitted = false;
    try {
        // v8.6 (C, device ban — mirrors admin BUILD 31 doAdminRegister):
        // a banned device cannot create an account at all — checked
        // BEFORE the Auth account is made, so no orphan Auth user or
        // profile doc is left behind. Fail-open: isDeviceBanned()
        // returns false when the read itself fails (no bannedDevices
        // rule in firestore.rules v18 yet), so registration never breaks.
        const regDeviceId = getOrCreateDeviceId();
        if (await isDeviceBanned(regDeviceId)) {
            const err = new Error(DEVICE_BANNED_MESSAGE);
            err.code = 'auth/device-banned';
            throw err;
        }
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        createdUser = cred.user;

        // FIX (#10, AUD-018) — two phases instead of one transaction:
        // Phase 1 writes the profile doc FIRST. Phase 2 then claims the
        // Free Fire UID in registeredUIDs, and the security rule for that
        // claim cross-checks (via get()) that the caller's OWN profile doc
        // carries this exact ffUID. Under the old single transaction a
        // squatter could claim ANY FF UID directly — the claim never had
        // to match an existing profile — so they could pre-register other
        // players' UIDs and block the real owners from signing up. Now a
        // claim for a UID that is not your own profile UID is denied by
        // the rules themselves.
        await setDoc(doc(db, 'users', cred.user.uid), {
            uid: cred.user.uid,
            name,
            ffUID,
            email,
            // IN NUMBER (2026-11-13): Indian mobile (10 digits) —
            // validated in registerUser() above. Allowed by the users
            // create rule (firestore.rules lines 293-304: no
            // keys().hasOnly check, only role + money counters pinned).
            phone: mobile,
            // v8.6 (C): store this device id with the account, so a later
            // admin ban can ban the device too. Allowed by firestore.rules
            // v18: the users create rule (lines 293-303) has no
            // keys().hasOnly check — only role + money counters are
            // constrained — so deviceIds passes here, unlike the
            // owner-update path (see recordDeviceId in device-ban.js).
            deviceIds: regDeviceId ? [regDeviceId] : [],
            walletBalance: 0,
            totalWins: 0,
            totalEarnings: 0,
            joinedTournaments: [],
            termsAcceptedAt: serverTimestamp(), // consent record (checkbox on register page)
            createdAt: serverTimestamp()
        });

        await runTransaction(db, async (transaction) => {
            const uidDocRef = doc(db, 'registeredUIDs', ffUID);
            const uidSnap = await transaction.get(uidDocRef);

            if (uidSnap.exists()) {
                const err = new Error('এই Free Fire UID দিয়ে আগেই একটি account আছে! অন্য UID ব্যবহার করো।');
                err.code = 'auth/ffuid-already-in-use';
                throw err;
            }

            // FIX (2026-11-11, C5): email এখানে লেখা যাবে না — registeredUIDs
            // get rule signed-in সবার জন্য খোলা, আর FF UID roster-এ public,
            // তাই email লিক হতো। email শুধু users doc-এই থাকে (owner/admin)।
            transaction.set(uidDocRef, {
                userId: cred.user.uid,
                registeredAt: serverTimestamp()
            });
        });

        // Send Firebase's built-in verification link after the profile is created.
        // FIX (2026-10-25): continueUrl দেওয়া হলো — email-এর link-এ click
        // করলে Firebase verify করে Tournixo login page-এ ফেরত পাঠাবে।
        // আগে continueUrl না থাকায় user Firebase-এর default page-এ আটকে
        // যেত, app-এ ফিরে login খুঁজতে হতো। এই URL Firebase Console-এর
        // Authorized domains-এ থাকতে হবে; live domain আলাদা হলে শুধু
        // এই একটা URL বদলালেই হবে।
        profileCommitted = true;
        // v8.8 (item 5, surface_real_errors): a send failure must NEVER
        // look like success. Registration itself still commits (profile
        // + UID claim already exist — the user can resend from the
        // verify page), but the result now carries verificationEmailSent
        // = false + the real error code, so the caller shows the failure
        // persistently on the Verify page instead of a "mail sent" toast.
        let verificationEmailSent = true;
        let verificationErrorCode = '';
        try {
            await sendEmailVerification(cred.user, {
                url: 'https://t.tournixo.workers.dev/pages/login.html',
                handleCodeInApp: false
            });
        } catch (sendErr) {
            verificationEmailSent = false;
            verificationErrorCode = String(sendErr?.code || '');
            console.warn('[register] verification email send failed:', sendErr && sendErr.message);
        }
        return { email: cred.user.email, verificationEmailSent, verificationErrorCode };
    } catch (e) {
        // Delete the auth user ONLY if registration never committed.
        // If the profile + UID claim exist (e.g. only the verification email
        // failed to send), the user can still verify later via "Resend
        // verification email" — deleting here would orphan the Firestore
        // profile and permanently block the Free Fire UID in registeredUIDs.
        // If phase 2 failed (FF UID already claimed), the auth user is
        // deleted; the phase-1 profile doc is left orphaned under a uid
        // Firebase will never reuse, and the UID claim was never written.
        if (createdUser && !profileCommitted) {
            await createdUser.delete().catch(() => {});
        }
        throw e;
    } finally {
        state.registering = false;
    }
}

// Re-sends the verification email for an account that has not verified yet.
// The user is signed out after login fails, so we briefly sign in with the
// credentials they typed, send the link, and sign out again.
// state.registering = true makes the auth listener in app.js ignore this
// temporary session (same technique registerUser uses).
export async function resendVerificationEmail(email, pass) {
    state.registering = true;
    try {
        const cred = await signInWithEmailAndPassword(auth, email, pass);
        await reload(cred.user);
        if (cred.user.emailVerified) {
            const error = new Error('Your email is already verified. You can sign in now.');
            error.code = 'auth/email-already-verified';
            throw error;
        }
        // FIX (2026-10-25): resend-এও একই continueUrl — verify-র পর
        // user Tournixo login page-এ ফিরবে, Firebase-এর default
        // page-এ আটকাবে না।
        await sendEmailVerification(cred.user, {
            url: 'https://t.tournixo.workers.dev/pages/login.html',
            handleCodeInApp: false
        });
    } finally {
        await signOut(auth).catch(() => {});
        state.registering = false;
    }
}

// v8.6 (F): pending-verification email, persisted in localStorage so
// reopening the app before verifying shows the Verify page again
// (instead of a plain login with no hint). The verify page also keeps
// the legacy sessionStorage 'verify_email' key in sync for display.
export const PENDING_VERIFY_EMAIL_KEY = 'ff_pending_verify_email';
export function setPendingVerifyEmail(email) {
    try { localStorage.setItem(PENDING_VERIFY_EMAIL_KEY, String(email || '')); } catch (_) {}
}
export function getPendingVerifyEmail() {
    try { return localStorage.getItem(PENDING_VERIFY_EMAIL_KEY) || ''; } catch (_) { return ''; }
}
export function clearPendingVerifyEmail() {
    try { localStorage.removeItem(PENDING_VERIFY_EMAIL_KEY); } catch (_) {}
    try { sessionStorage.removeItem('verify_email'); } catch (_) {}
}

// v8.6 (F): resend for a user who is STILL signed in (the verify page
// after register — the session is kept). No password prompt and NO
// sign-out, unlike resendVerificationEmail() above, which signs in
// temporarily for a signed-out user and signs out again in its
// finally block. Same continueUrl as register/resend.
export async function resendVerificationForCurrentUser() {
    const user = auth.currentUser;
    if (!user) {
        const err = new Error('No signed-in user');
        err.code = 'auth/no-current-user';
        throw err;
    }
    await reload(user);
    if (user.emailVerified) {
        const error = new Error('Your email is already verified. You can sign in now.');
        error.code = 'auth/email-already-verified';
        throw error;
    }
    await sendEmailVerification(user, {
        url: 'https://t.tournixo.workers.dev/pages/login.html',
        handleCodeInApp: false
    });
}

// v8.8 (item 5, surface_real_errors): the REAL send-failure cause,
// in Bengali, keyed by the Firebase error code the service returned
// (never a guessed cause). Used by the Verify page's persistent error
// area — and by Resend — so the user sees what failed and what to do.
export function verificationSendErrorMessage(code) {
    switch (String(code || '')) {
        case 'auth/unauthorized-continue-uri':
        case 'auth/invalid-continue-uri':
            return 'মেইল পাঠানো যায়নি — লিংকের ঠিকানা (domain) অনুমোদিত নয়। অ্যাডমিনকে জানাও।';
        case 'auth/too-many-requests':
            return 'অনেকবার চেষ্টা হয়েছে। একটু পরে আবার Resend চাপো।';
        case 'auth/network-request-failed':
            return 'নেটওয়ার্ক সমস্যা হয়েছে। ইন্টারনেট চেক করে Resend চাপো।';
        case 'auth/quota-exceeded':
            return 'অনেক মেইল পাঠানো হয়েছে। পরে আবার Resend চাপো।';
        default:
            return 'মেইল পাঠানো যায়নি। Spam folder চেক করো, আর না এলে নিচের Resend বাটন চাপো।';
    }
}

// v8.8 (item 5): the register-time send failure survives a page change
// (localStorage, cleared on a successful send / once verified), so the
// Verify page can show it persistently instead of a success toast.
export const VERIFY_SEND_FAILED_KEY = 'ff_verify_send_failed_v1';
export function setVerifySendFailed(code) {
    try { localStorage.setItem(VERIFY_SEND_FAILED_KEY, JSON.stringify({ code: String(code || ''), at: Date.now() })); } catch (_) {}
}
export function getVerifySendFailed() {
    try {
        const raw = localStorage.getItem(VERIFY_SEND_FAILED_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
    } catch (_) { return null; }
}
export function clearVerifySendFailed() {
    try { localStorage.removeItem(VERIFY_SEND_FAILED_KEY); } catch (_) {}
}

export async function logoutUser() {
    state.notifListenerActive = false;
    resetGlobalPopupListener(); // FIX (2026-10-25, W8): দেখো notifications.service.js
    state.joinRequestCache = null;
    state.leaderboardCache = null;
    state.modeChipsLoaded = false;

    if (Array.isArray(state.listeners)) {
        state.listeners.forEach(unsub => {
            try { if (typeof unsub === 'function') unsub(); } catch (e) {}
        });
        state.listeners = [];
    }

    oneSignalLogout();
    const uid = state.currentUser?.uid;
    await signOut(auth);
    if (uid) clearSessionUser(uid);
    try { sessionStorage.removeItem('ff_ev_ok_v1'); } catch (e) {}
    state.currentUser = null;
    state.userData = null;
}

export async function refreshUserData(forceRefresh = false) {
    const uid = state.currentUser?.uid;
    if (!uid) return null;

    const cached = state.userData;
    const cachedAt = Number(state.userDataCacheAt || 0);
    const USER_CACHE_TTL = 30 * 1000;

    // Non-critical UI profile data may use a very short session cache.
    // Critical actions must continue to read authoritative Firestore data.
    if (!forceRefresh && cached && (Date.now() - cachedAt) < USER_CACHE_TTL) {
        if (typeof window.refreshUserUI === 'function') window.refreshUserUI();
        return cached;
    }

    try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap.exists() && state.currentUser) {
            state.userData = snap.data();
            state.userDataCacheAt = Date.now();
            if (typeof window.refreshUserUI === 'function') window.refreshUserUI();
        }
        return state.userData || null;
    } catch (e) {
        console.warn('refreshUserData failed:', e.message);
        return state.userData || null;
    }
}

window.refreshUserData = refreshUserData;

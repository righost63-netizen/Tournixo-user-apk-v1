// ════════════════════════════════════════════════════════════════
// Device ban — user app (v8.6, item C).
// Mirrors admin BUILD 31 (scripts/core/auth.js, I2) for the user app:
//   • a stable per-browser id in localStorage ('tournixo-device-id')
//   • bannedDevices/{deviceId} docs are written by the admin Users ban
//     action; a doc existing means this device may not log in or
//     register, and may not stay signed in with a live session
//   • the id is stored on the user doc (deviceIds, arrayUnion) so a
//     later admin ban can ban the device too
// LIMITS, stated plainly (same as admin BUILD 31):
//   • localStorage id only — clearing browser data, incognito, or
//     another browser gives a new id. True IP blocking needs a
//     server/edge and cannot be done from this app; no IP is captured.
//   • FAIL OPEN BY DESIGN: getDoc(bannedDevices/…) is allowed by
//     firestore.rules v19 (M5 — public single-doc get, list NEVER,
//     admin-only writes, firestore.rules:732-736). A denied/failed
//     read still returns false here — it never blocks a login, a
//     registration, or a session restore. Full enforcement is live
//     once v19 is published (v8.8 ships v19 in the zip).
//   • LOGIN-TIME RECORDING IS ALLOWED under v19 (M8): 'deviceIds'
//     is in BOTH owner-update allow-lists (firestore.rules:360 and
//     :374 — profile branch + depositBalance branch), so the
//     recordDeviceId() update below succeeds once v19 is published.
//     It is still attempted best-effort and can never break login.
//     Registration does NOT have this problem: the users create rule
//     has no keys().hasOnly check — only role + money counters are
//     constrained — so deviceIds IS written in the create doc.
// ════════════════════════════════════════════════════════════════
import {
    db,
    doc,
    getDoc,
    updateDoc,
    arrayUnion
} from '../firebase/firebase-init.js';

export const DEVICE_ID_KEY = 'tournixo-device-id';

// v8.6 (C): the one ban message, used at login, registration and
// session restore alike, so a banned device always hears the same thing.
export const DEVICE_BANNED_MESSAGE = 'এই ডিভাইস থেকে অ্যাকাউন্ট ব্যবহার করা যাবে না।';

// v8.6 (C): stable per-browser device id, persisted in localStorage.
// Same key + same fallback shape as admin BUILD 31, so one device
// banned from the admin panel is the same id the user app checks.
export function getOrCreateDeviceId() {
    try {
        if (typeof localStorage === 'undefined') return null;
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
            id = (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID)
                ? window.crypto.randomUUID()
                : ('dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        return id;
    } catch (e) {
        return null;
    }
}

// v8.6 (C): true only when the bannedDevices doc exists. Any read
// failure — e.g. v19 not published yet (permission-denied) — returns
// false: FAIL OPEN BY DESIGN, so a missing rules block can never lock
// every user out.
export async function isDeviceBanned(deviceId) {
    if (!deviceId) return false;
    try {
        const snap = await getDoc(doc(db, 'bannedDevices', deviceId));
        return snap.exists();
    } catch (e) {
        console.warn('[device-ban] banned-device check unavailable, failing open:', e && e.message);
        return false;
    }
}

// v8.6 (C): remember this device on the user doc (arrayUnion — never
// overwrites other ids). Best effort only: never throws, never blocks
// login/register. NOTE — allowed under firestore.rules v19 (M8:
// 'deviceIds' in both owner-update onlyKeys branches, :360 and :374),
// live once v19 is published. Registration stores the id in the
// create doc instead, which the create rule also allows.
export async function recordDeviceId(uid, deviceId) {
    if (!uid || !deviceId) return false;
    try {
        await updateDoc(doc(db, 'users', uid), { deviceIds: arrayUnion(deviceId) });
        return true;
    } catch (e) {
        console.warn('[device-ban] deviceIds update failed (best effort, login continues):', e && e.message);
        return false;
    }
}

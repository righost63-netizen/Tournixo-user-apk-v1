// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
// ════════════════════════════════════════════════════════════════
// Deposit service — wallet top-up (2026-11-07).
// Mirrors services/withdrawal.service.js patterns exactly:
//   • 30s display cache, failed-precondition fallback that re-throws
//     on total failure (never shows a false empty state)
//   • requestDeposit() validates inside a transaction and NEVER
//     deducts or credits any balance — a deposit request only creates
//     a PENDING doc. The admin approves later (admin panel) and credits
//     depositBalance + totalDeposited + a ledger CREDIT entry there.
//   • duplicate UTR guard: deterministic doc ID `dep_<UTR-UPPERCASE>`,
//     checked inside the transaction (separate prefix from the UPI
//     payment `trx_` namespace, so one UTR can never be both).
//   • max 3 pending deposits per user, enforced atomically through
//     depositCounters/{uid} (mirrors withdrawalCounters).
// The user panel NEVER writes users/{uid} money fields or
// walletTransactions — it only reads balances and creates requests.
// ════════════════════════════════════════════════════════════════
import {
    db,
    doc,
    collection,
    query,
    where,
    orderBy,
    limit,
    getDoc,
    getDocs,
    addDoc,
    runTransaction,
    serverTimestamp
} from '../firebase/firebase-init.js';
import { APP_CONFIG } from '../config/app-config.js';
import { isValidTrxId } from '../utils/validators.js';
import { fetchSettingsDoc, checkDepositSettings, DEPOSIT_SETTINGS_MISSING_MESSAGE } from './settings.service.js';

const DEPOSIT_CACHE_TTL = 30 * 1000;
const depositCache = new Map();

// Deterministic doc ID — the duplicate-UTR guard. Same shape as
// payment.service.js transactionDocId, with its own `dep_` prefix.
export function depositDocId(trxId) {
    return `dep_${encodeURIComponent(String(trxId).trim().toUpperCase())}`;
}

function resolveLimits(data) {
    const _minRaw = Number(data?.minAmount);
    const min = (Number.isFinite(_minRaw) && _minRaw >= 1)
        ? Math.floor(_minRaw)
        : APP_CONFIG.defaultMinDeposit;
    const _maxRaw = Number(data?.maxAmount);
    const max = (Number.isFinite(_maxRaw) && _maxRaw > min)
        ? Math.floor(_maxRaw)
        : APP_CONFIG.defaultMaxDeposit;
    return { min, max };
}

// Admin-configured limits from settings/deposit; fallbacks only when
// the doc/fields are missing. Display/validation helper — the
// authoritative check runs inside the requestDeposit transaction.
export async function fetchDepositLimits(forceRefresh = false) {
    const data = await fetchSettingsDoc('deposit', forceRefresh);
    return resolveLimits(data);
}

// Deposit history (newest first). Display-only; never authorizes anything.
export async function fetchDeposits(uid, forceRefresh = false) {
    if (!uid) return [];

    const cached = depositCache.get(uid);
    if (!forceRefresh && cached && (Date.now() - cached.at) < DEPOSIT_CACHE_TTL) {
        return cached.items;
    }

    let items = [];
    try {
        const s = await getDocs(query(
            collection(db, 'depositRequests'),
            where('userId', '==', uid),
            orderBy('createdAt', 'desc'),
            limit(50)
        ));

        s.forEach(d => items.push({
            id: d.id,
            ...d.data()
        }));
    } catch (e) {
        // Same rule as withdrawals: fallback only on failed-precondition
        // (missing composite index); total failure re-throws (or returns
        // the cache) so the UI shows an error + Try Again, never a false
        // "No deposits yet".
        if (e?.code !== 'failed-precondition') {
            if (cached?.items) return cached.items;
            throw e;
        }
        try {
            const s = await getDocs(query(
                collection(db, 'depositRequests'),
                where('userId', '==', uid),
                limit(50)
            ));

            s.forEach(d => items.push({
                id: d.id,
                ...d.data()
            }));
        } catch (fallbackError) {
            console.warn('[Deposit] History fetch failed:', fallbackError.message);
            if (cached?.items) return cached.items;
            throw fallbackError;
        }
    }

    items.sort((a, b) => {
        const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
        const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
        return tb - ta;
    });

    depositCache.set(uid, { at: Date.now(), items });
    return items;
}

// Total of the user's PENDING deposit requests, for the Wallet card
// note ('₹X deposit pending approval'). Display-only: a pending
// request NEVER changes the Deposit Balance. Reuses the 30s shared
// cache from fetchDeposits — no extra query.
export async function fetchPendingDepositTotal(uid) {
    if (!uid) return 0;
    const items = await fetchDeposits(uid);
    return Math.round(
        items
            .filter(d => d.status === 'pending')
            .reduce((s, d) => s + Number(d.amount || 0), 0) * 100
    ) / 100;
}

// Deposit request — Tournixo money flow:
//   • Request time: NO balance change. The request is created with
//     status 'pending' and the Deposit Balance stays unchanged.
//   • On approve: the ADMIN credits depositBalance + totalDeposited
//     and writes a walletTransactions CREDIT entry (admin panel).
//   • On reject: status → 'rejected' (+ rejectionReason). Nothing
//     was ever credited, so nothing is taken back.
// The transaction below only VALIDATES (never writes to the user doc):
//   • amount is sane and within the admin-configured min/max
//   • UTR is valid and not already submitted (deterministic doc ID)
//   • max 3 pending requests per user (spam guard, atomic via counter)
export async function requestDeposit({ uid, userName, amount, transactionId }) {
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error('ডিপোজিটের পরিমাণ সঠিক নয়।');
    }

    const normalizedTrxId = String(transactionId || '').trim().toUpperCase();
    if (!isValidTrxId(normalizedTrxId)) {
        throw new Error('সঠিক Transaction / UTR ID দাও (কমপক্ষে ৮ অক্ষর, space ছাড়া)');
    }

    // v8.8 (item 6): settings/deposit না থাকলে rules fail-closed হয়ে
    // txn permission-denied-এ মরত — user শুধু ভুল toast দেখত। আগেই
    // পরিষ্কার বাংলায় আটকাও। Read-এ permission-denied মানেও একই —
    // rules ছাড়া doc পড়া যায় না, admin-কেই দেখতে হবে।
    const _depSettings = await checkDepositSettings();
    if (_depSettings.state === 'missing' || (_depSettings.state === 'error' && _depSettings.code === 'permission-denied')) {
        throw new Error(DEPOSIT_SETTINGS_MISSING_MESSAGE);
    }

    // Spam guard — OUTSIDE the transaction. Firestore's transaction.get()
    // accepts ONLY a DocumentReference, never a Query (same accepted race
    // as withdrawals: two tabs in the same millisecond could both pass;
    // the atomic check inside the transaction below is the backstop).
    const pendingSnap = await getDocs(query(
        collection(db, 'depositRequests'),
        where('userId', '==', uid),
        where('status', '==', 'pending'),
        limit(10)
    ));
    if (pendingSnap.size >= 3) {
        throw new Error('তোমার ৩টি ডিপোজিট আবেদন ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে। যাচাই শেষ হলে আবার আবেদন করো।');
    }

    const userRef = doc(db, 'users', uid);
    const depRef = doc(db, 'depositRequests', depositDocId(normalizedTrxId));
    const counterRef = doc(db, 'depositCounters', uid);

    await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(userRef);
        if (!snap.exists()) throw new Error('অ্যাকাউন্ট পাওয়া যায়নি।');

        const counterSnap = await transaction.get(counterRef);
        const trackedIds = Array.isArray(counterSnap.data()?.ids) ? counterSnap.data().ids : [];
        let livePendingCount = 0;
        const liveIds = [];
        for (const rid of trackedIds.slice(0, 10)) {
            const rSnap = await transaction.get(doc(db, 'depositRequests', rid));
            if (rSnap.exists() && rSnap.data().status === 'pending') {
                livePendingCount++;
                liveIds.push(rid);
            }
        }
        if (livePendingCount >= 3) {
            throw new Error('তোমার ৩টি ডিপোজিট আবেদন ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে। যাচাই শেষ হলে আবার আবেদন করো।');
        }

        // Authoritative min/max from settings/deposit INSIDE the
        // transaction — a UI bypass cannot file an out-of-range amount.
        // Fallbacks (APP_CONFIG) apply only when the doc/field is missing.
        const settingsSnap = await transaction.get(doc(db, 'settings', 'deposit'));
        const { min, max } = resolveLimits(settingsSnap.data() || null);
        if (amt < min) {
            throw new Error(`সর্বনিম্ন ডিপোজিট ₹${min}`);
        }
        if (amt > max) {
            throw new Error(`সর্বোচ্চ ডিপোজিট ₹${max}`);
        }

        // Authoritative duplicate-UTR check INSIDE the transaction.
        const depSnap = await transaction.get(depRef);
        if (depSnap.exists()) {
            throw new Error('এই Transaction ID আগেই জমা দেওয়া হয়েছে।');
        }

        // NOTE: depositBalance / totalDeposited / walletBalance /
        // totalEarnings are intentionally NOT touched here — the admin
        // credits them on approve. The user doc is read-only in this txn.
        const uData = snap.data();
        transaction.set(depRef, {
            userId: uid,
            userName: userName || 'User',
            ffUid: uData.ffUID || '',
            amount: amt,
            transactionId: normalizedTrxId,
            status: 'pending',
            createdAt: serverTimestamp(),
            requestId: depRef.id
        });

        // Keep the counter in the SAME transaction so the cap above can
        // never be raced: resolved IDs are pruned, the new one is appended.
        transaction.set(counterRef, {
            uid,
            ids: [...liveIds, depRef.id],
            updatedAt: serverTimestamp()
        });
    });

    // The newly-created history is no longer safe to display from the old cache.
    depositCache.delete(uid);

    // Inbox note at request time (same doc shape as the withdrawal note).
    // No push here — admin sends push on approve/reject.
    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'deposit_pending',
            title: 'ডিপোজিট আবেদন করা হয়েছে',
            body: `₹${amt.toFixed(2)} ডিপোজিটের আবেদন অ্যাডমিন অনুমোদনের অপেক্ষায় আছে। অনুমোদন না হওয়া পর্যন্ত Deposit Balance বদলাবে না।`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}
}

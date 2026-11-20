// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { db, collection, query, where, orderBy, limit, getDocs, addDoc, serverTimestamp } from '../firebase/firebase-init.js';

// ────────────────────────────────────────────────────────────────
// REPORT PLAYER (v7)
// Anyone can report any player (by FF UID). Reports go to the
// `playerReports` collection for admin review — there is NO auto-ban.
// Anti-abuse: max 3 reports per user per 24h, can't report yourself.
// DB cost: 1 small query (rate-limit check) + 1 write per report.
// ────────────────────────────────────────────────────────────────

// FIX (2026-11-19, v8.11): কারণের লেবেল বাংলা — তবে Firestore-এ
// জমা হওয়া value আগের মতোই English থাকে, যাতে admin-এর পুরনো
// রিপোর্ট/ফিল্টার না ভাঙে। select-এ label দেখায়, value পাঠায়।
export const REPORT_REASONS = [
    { value: 'Hacking / Cheating', label: 'হ্যাকিং / চিটিং' },
    { value: 'Abusive Behaviour', label: 'অশালীন আচরণ' },
    { value: 'Fake UID', label: 'ভুয়া UID' },
    { value: 'Teaming with Opponents', label: 'প্রতিপক্ষের সাথে টিমিং' },
    { value: 'Account Sharing', label: 'অ্যাকাউন্ট শেয়ারিং' },
    { value: 'Other', label: 'অন্যান্য' }
];

export const REPORT_DAILY_LIMIT = 3;

// How many reports has this user filed in the last 24h?
// FIX (2026-11-20, S11): fail-CLOSED — দুটো read-ই fail হলে 0 ধরে
// limit bypass করা যাবে না (আগে catch-এ চুপচাপ 0 ফিরত — fail-open)।
// Retryable error throw হয়, caller (report-player.js) toast দেখায়।
export async function countRecentReports(uid) {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    let count = 0;
    try {
        const s = await getDocs(query(
            collection(db, 'playerReports'),
            where('reporterUid', '==', uid),
            orderBy('createdAt', 'desc'),
            limit(REPORT_DAILY_LIMIT + 1)
        ));
        s.forEach(d => {
            const ts = d.data().createdAt;
            const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
            if (ms >= dayAgo) count++;
        });
    } catch (e) {
        // Fallback if the composite index isn't ready yet: unordered read.
        try {
            const s = await getDocs(query(
                collection(db, 'playerReports'),
                where('reporterUid', '==', uid),
                limit(REPORT_DAILY_LIMIT + 1)
            ));
            s.forEach(d => {
                const ts = d.data().createdAt;
                const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
                if (ms >= dayAgo) count++;
            });
        } catch (_) {
            const err = new Error('রিপোর্টের হিসাব যাচাই করা যায়নি — নেট চেক করে আবার চেষ্টা করো');
            err.retryable = true;
            throw err;
        }
    }
    return count;
}

// FIX (2026-11-19, v8.11): একই UID-কে একই কারণে ২৪ ঘণ্টায় দুইবার
// রিপোর্ট করা যাবে না। শুধু single-field query (reporterUid == me,
// limit 20) — orderBy নেই, নতুন composite index লাগে না; UID +
// কারণ + সময় client-side-এ মেলানো হয়।
export async function isDuplicateReport(uid, reportedFFUID, reason) {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    try {
        const s = await getDocs(query(
            collection(db, 'playerReports'),
            where('reporterUid', '==', uid),
            limit(20)
        ));
        let dup = false;
        s.forEach(d => {
            const data = d.data() || {};
            const ts = data.createdAt;
            const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
            if (data.reportedFFUID === String(reportedFFUID).trim() && data.reason === reason && ms >= dayAgo) dup = true;
        });
        return dup;
    } catch (_) {
        // FIX (2026-11-20, S11): fail-CLOSED — duplicate-check read fail
        // হলে false ধরে duplicate রিপোর্ট ঢোকানো যাবে না। Retryable
        // error throw হয়; caller toast দেখায়, user আবার চেষ্টা করে।
        const err = new Error('আগের রিপোর্ট যাচাই করা যায়নি — নেট চেক করে আবার চেষ্টা করো');
        err.retryable = true;
        throw err;
    }
}

export async function submitPlayerReport({ uid, reporterName, reportedFFUID, ownFFUID, reason, details, tournamentId }) {
    const ffUID = String(reportedFFUID || '').trim();
    if (!/^\d{8,12}$/.test(ffUID)) {
        throw new Error('সঠিক ৮–১২ সংখ্যার Free Fire UID দাও');
    }
    if (ownFFUID && ffUID === String(ownFFUID).trim()) {
        throw new Error('নিজেকে রিপোর্ট করা যাবে না');
    }
    if (!REPORT_REASONS.some(r => r.value === reason)) {
        throw new Error('একটি সঠিক কারণ বেছে নাও');
    }
    // FIX (2026-11-19, v8.11): dedupe — daily-limit-এর আগেই চেক।
    if (await isDuplicateReport(uid, ffUID, reason)) {
        throw new Error('এই খেলোয়াড়কে একই কারণে গত ২৪ ঘণ্টায় রিপোর্ট করা হয়েছে।');
    }
    const recent = await countRecentReports(uid);
    if (recent >= REPORT_DAILY_LIMIT) {
        throw new Error(`রিপোর্টের সীমা শেষ (${REPORT_DAILY_LIMIT}/দিন)। আগামীকাল আবার চেষ্টা করো।`);
    }
    const ref = await addDoc(collection(db, 'playerReports'), {
        reporterUid: uid,
        reporterName: String(reporterName || '').trim(),
        reportedFFUID: ffUID,
        reason,
        details: String(details || '').trim().slice(0, 500),
        tournamentId: tournamentId || null,
        status: 'pending', // pending → reviewed → actioned/dismissed (admin only)
        createdAt: serverTimestamp()
    });
    return ref.id;
}

import { db, doc, getDoc, getDocs, collection, query, where, limit, orderBy } from '../firebase/firebase-init.js';
import { normalizeTournament } from './tournaments.service.js';

// Tournament doc + its published-results doc.
// Returns { tourn, resData } (resData is null if there is no results document).
// FIX (2026-11-20, S-R2): tournament doc না থাকলে ভুয়া নাম "Tournament"
// বানানো হতো — এখন tourn null ফেরে, caller error state দেখায়।
export async function fetchTournamentResults(tournamentId) {
    const tSnap = await getDoc(doc(db, 'tournaments', tournamentId));
    const tourn = tSnap.exists() ? normalizeTournament(tSnap.data(), tSnap.id) : null;

    // tournamentResults/{tournamentId} is the authoritative result document.
    // Do not issue a second collection query when it does not exist.
    const directResSnap = await getDoc(doc(db, 'tournamentResults', tournamentId));
    const resData = directResSnap.exists() ? directResSnap.data() : null;

    return { tourn, resData };
}

// FIX (2026-11-19, v8.11): per-user credited state — admin আসলে
// যা লেখে (match-results.js distribution transaction):
//   prizeDistributions/<tid> = { recipients: [{ userId (captain-এর
//   Firebase UID), teamId, teamName, userName, rank, kills, amount,
//   ledgerId }], status: 'completed' | 'partial', totalAmount, ... }
//   tournaments/<tid>.prizesDistributed = true শুধু status
//   'completed' হলে; partial হলে prizesPartiallyDistributed = true.
// তাই recipients-ই সত্যের উৎস। কিন্তু rules-এ prizeDistributions
// admin-only read (admin v34 + user v19 দুটোতেই), তাই user-এর
// পড়া সাধারণত deny হবে — তখন নিচের prizeHistory fallback চলে:
// distribution transaction captain-এর users/{uid}.prizeHistory-তে
// { tournamentId, amount, distributedAt } লেখে (owner read চলে)।
// দুটোই best-effort: পড়া না গেলে null/খালি Set ফেরে, পেজ মরে না।
// FIX (2026-11-20, S-R1): Map<userId, amount> ফেরে — ₹0 recipient-ও
// থাকে (আগে শুধু amount > 0 রাখা হতো, তাই win-only ₹0 winner-কে
// "Verified (Pending Payout)" দেখাত চিরকাল)। caller amount 0 হলে
// "No prize amount" label দেয়। null = পড়া যায়নি (fallback চলে)।
export async function fetchDistributionRecipients(tournamentId) {
    try {
        const snap = await getDoc(doc(db, 'prizeDistributions', tournamentId));
        if (!snap.exists()) return null;
        const recips = Array.isArray(snap.data().recipients) ? snap.data().recipients : [];
        const paid = new Map();
        recips.forEach(r => { if (r && r.userId) paid.set(String(r.userId), Number(r.amount || 0)); });
        return paid;
    } catch (e) {
        // permission-denied (admin-only read) বা network — caller
        // prizeHistory fallback-এ যাবে।
        return null;
    }
}

// নিজের prizeHistory-তে টাকা পাওয়া tournament-গুলো — Map<tournamentId, amount>;
// ₹0 entry-ও থাকে (S-R1: win-only winner-কে চিরকাল pending দেখাত না)।
export async function fetchMyPaidTournamentIds(uid) {
    try {
        if (!uid) return new Map();
        const snap = await getDoc(doc(db, 'users', uid));
        if (!snap.exists()) return new Map();
        const hist = Array.isArray(snap.data().prizeHistory) ? snap.data().prizeHistory : [];
        const paid = new Map();
        hist.forEach(h => { if (h && h.tournamentId) paid.set(String(h.tournamentId), Number(h.amount || 0)); });
        return paid;
    } catch (e) {
        return new Map();
    }
}

// Completed tournaments (results list from the Profile menu)
// FIX (2026-10-25, F-07): আগের comment ভুল ছিল — orderBy ছাড়া limit(30)
// arbitrary doc আনে, client sort পরে করলেও নতুন tournament window-এর
// বাইরে থাকতে পারত। এখন orderBy('createdAt','desc') + limit;
// composite index না থাকলে শুধু failed-precondition-এ পুরনো path।
// FIX (2026-11-20, S-R2): limit param — "আরও দেখো" দিলে caller আরও
// 20 করে বাড়ায়; আগের মতো 20-এ থেমে যেত না।
export async function fetchCompletedTournaments(limitCount = 20) {
    const n = Math.max(1, Number(limitCount) || 20);
    let snap;
    try {
        snap = await getDocs(query(
            collection(db, 'tournaments'),
            where('status', '==', 'completed'),
            orderBy('createdAt', 'desc'),
            limit(n)
        ));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        snap = await getDocs(query(
            collection(db, 'tournaments'),
            where('status', '==', 'completed'),
            limit(n + 10)
        ));
        const fallback = [];
        snap.forEach(d => fallback.push(normalizeTournament(d.data(), d.id)));
        fallback.sort((a, b) => {
            const ta = a.dateObj ? a.dateObj.getTime() : 0;
            const tb = b.dateObj ? b.dateObj.getTime() : 0;
            return tb - ta;
        });
        return fallback.slice(0, n);
    }
    const list = [];
    snap.forEach(d => list.push(normalizeTournament(d.data(), d.id)));
    return list;
}

// ── Result posters (নতুন Result flow, 2026-10-24) ──
// Admin-এর Result টুল থেকে আপলোড করা poster/ছবি — public read।
// FIX (2026-10-25, F-07): প্রতি open-এ 50 read নয় — 1h localStorage
// cache। Admin-এর appConfig-এ resultPosts-এর touch writer নেই, তাই TTL
// cache-ই সঠিক invalidation (নতুন poster সর্বোচ্চ 1h পরে দেখাবে)।
// Fallback-ও শুধু failed-precondition-এ।
const RESULT_POSTS_CACHE_KEY = 'ff_result_posts_v1';
const RESULT_POSTS_TTL_MS = 60 * 60 * 1000;
export async function fetchResultPosts() {
    try {
        const raw = localStorage.getItem(RESULT_POSTS_CACHE_KEY);
        if (raw) {
            const entry = JSON.parse(raw);
            if (entry && Array.isArray(entry.data) && (Date.now() - (entry.t || 0)) < RESULT_POSTS_TTL_MS) {
                return entry.data;
            }
        }
    } catch (e) { /* cache unreadable — fetch fresh */ }
    let items;
    try {
        const snap = await getDocs(query(collection(db, 'resultPosts'), orderBy('createdAt', 'desc'), limit(50)));
        items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        const snap = await getDocs(query(collection(db, 'resultPosts'), limit(50)));
        items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    try {
        localStorage.setItem(RESULT_POSTS_CACHE_KEY, JSON.stringify({ t: Date.now(), data: items }));
    } catch (e) { /* storage full/disabled — app continues without cache */ }
    return items;
}
export async function fetchResultPoster(tournamentId) {
    // FIX (2026-10-25, W9): এক tournament-এ একাধিক poster থাকলে আগের
    // query-টি orderBy ছাড়া arbitrary doc ফেরাত — পুরনো poster দেখাতে
    // পারত। এখন newest poster নেওয়া হয়; শুধু missing-index
    // (failed-precondition) হলেই unordered fallback চলবে।
    try {
        const snap = await getDocs(query(collection(db, 'resultPosts'), where('tournamentId', '==', tournamentId), orderBy('createdAt', 'desc'), limit(1)));
        return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        const snap = await getDocs(query(collection(db, 'resultPosts'), where('tournamentId', '==', tournamentId), limit(1)));
        return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
}

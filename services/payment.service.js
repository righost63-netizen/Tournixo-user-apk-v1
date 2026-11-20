// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import {
    db,
    doc,
    getDoc,
    getDocs,
    addDoc,
    collection,
    query,
    where,
    limit,
    runTransaction,
    serverTimestamp,
    arrayUnion,
    arrayRemove
} from '../firebase/firebase-init.js';
import { normalizeTournament } from './tournaments.service.js';
import { invalidateWalletCache } from './wallet.service.js'; /* FIX (2026-11-20, W3): instant-join debit-এর পর ledger cache মোছা। */

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. Hard-coded 'admin@upi' / payee fallback (lines 27-28) removed — এখন settings/payment না থাকলে বা অসম্পূর্ণ হলে
 *       payment সম্পূর্ণ disable — কোনো fake destination এ টাকা যাবে না।
 * 2. Dead export clearPaymentSettingsCache removed (never called).
 * 3. Error handling made stricter — no silent fallback.
 * ─────────────────────────────────────────────────────────────
 */

// v8.6 (G): toast-এ দেখানো error বাংলায় — tournament status-ও বাংলায় ম্যাপ করা।
const _STATUS_BN = { upcoming: 'শুরু হয়নি', ongoing: 'চলছে', completed: 'শেষ হয়ে গেছে' };
const _statusBn = s => _STATUS_BN[String(s || '').toLowerCase()] || String(s || '');

let paymentSettingsCache = null;
const PAYMENT_SETTINGS_TTL = 60 * 1000;

export async function fetchPaymentSettings(forceRefresh = false) {
    const now = Date.now();

    if (
        !forceRefresh &&
        paymentSettingsCache &&
        (now - paymentSettingsCache.at) < PAYMENT_SETTINGS_TTL
    ) {
        return paymentSettingsCache.value;
    }

    try {
        const paySnap = await getDoc(doc(db, 'settings', 'payment'));

        // Never use a fake/default payment destination.
        if (!paySnap.exists()) {
            paymentSettingsCache = null;
            throw new Error('পেমেন্টের তথ্য পাওয়া যায়নি। পেমেন্ট এখন বন্ধ আছে।');
        }

        const pData = paySnap.data() || {};

        const adminUpiId = String(pData.upiId || pData.number || '').trim();
        const payeeName  = String(pData.payeeName || pData.accountName || '').trim();

        // Both values are required. Never allow incomplete payment config.
        if (!adminUpiId || !payeeName) {
            paymentSettingsCache = null;
            throw new Error('পেমেন্টের তথ্য অসম্পূর্ণ। পেমেন্ট এখন বন্ধ আছে।');
        }

        const value = { adminUpiId, payeeName };

        paymentSettingsCache = { at: Date.now(), value };
        return value;
    } catch (e) {
        paymentSettingsCache = null;
        console.error('[Payment] Settings fetch failed:', e);

        if (e instanceof Error && e.message) throw e;
        throw new Error('পেমেন্টের তথ্য লোড হয়নি। পেমেন্ট এখন বন্ধ আছে।');
    }
}

// Standard UPI Intent URL
export function buildUpiIntentUrl(adminUpiId, payeeName, fee, teamId) {
    const upiId  = String(adminUpiId || '').trim();
    const name   = String(payeeName || '').trim();
    const amount = Number(fee);

    if (!upiId || !name) {
        throw new Error('পেমেন্টের তথ্য পাওয়া যায়নি। পেমেন্ট এখন বন্ধ আছে।');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('পেমেন্টের পরিমাণ সঠিক নয়।');
    }
    if (!teamId) {
        throw new Error('টিমের তথ্য সঠিক নয়।');
    }

    return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(teamId)}`;
}

function transactionDocId(trxId) {
    return `trx_${encodeURIComponent(String(trxId).trim().toUpperCase())}`;
}

export async function submitPaymentRequest({ t, teamData, trxId, uid, uData, authEmail }) {
    const normalizedTrxId = String(trxId || '').trim().toUpperCase();
    if (!normalizedTrxId) throw new Error('Transaction ID দরকার।');

    const [tournSnap, teamSnap] = await Promise.all([
        getDoc(doc(db, 'tournaments', t.id)),
        getDoc(doc(db, 'tournamentTeams', teamData.teamId))
    ]);

    if (!tournSnap.exists()) throw new Error('টুর্নামেন্ট পাওয়া যায়নি');

    const freshTourn = tournSnap.data();
    if (freshTourn.status !== 'upcoming') {
        throw new Error(`পেমেন্ট জমা দেওয়া যাবে না। টুর্নামেন্ট এখন ${_statusBn(freshTourn.status)} অবস্থায় আছে।`);
    }

    const authoritativeFee = Number(freshTourn.entryFee || 0);
    if (authoritativeFee <= 0) throw new Error('এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।');

    if (!teamSnap.exists()) throw new Error('টিমের রেজিস্ট্রেশন পাওয়া যায়নি। আগে টিম রেজিস্টার করো।');

    const freshTeam = teamSnap.data();
    if (freshTeam.captainUserId !== uid) {
        throw new Error('শুধু টিমের ক্যাপ্টেন পেমেন্ট জমা দিতে পারবে।');
    }
    if (freshTeam.paymentStatus === 'approved' || freshTeam.status === 'confirmed') {
        throw new Error('এই টিম ইতিমধ্যে কনফার্ম ও পেমেন্ট করা হয়েছে।');
    }
    if (freshTeam.paymentStatus === 'pending') {
        throw new Error('এই টিমের একটি পেমেন্ট ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে।');
    }
    // FIX (2026-10-25, F10): rejected টিমে আবার UTR submit করলে
    // paymentStatus 'pending'-এ ফিরত, কিন্তু status 'rejected'-ই থাকত —
    // admin confirm করতে পারত না, queue-তে dangling pending জমত। এখন
    // rejected টিমকে নতুন join flow-এ পাঠানো হবে।
    if (freshTeam.status === 'rejected') {
        throw new Error('অ্যাডমিন এই টিমটি বাতিল করেছেন। নতুন করে জয়েন করো।');
    }

    const trxRef = doc(db, 'paymentRequests', transactionDocId(normalizedTrxId));
    // FIX (2026-10-25, F13): অন্যের UTR probe করলে getDoc permission-denied
    // দিত — raw SDK error-ই existence oracle হতো। এখন generic message;
    // আসল duplicate check txn-এর ভেতরে থাকবে। (পুরো oracle বন্ধ করা
    // যায় না — success vs failure নিজেই existence জানায় — কিন্তু UTR
    // একা কিছু কেনে না, তাই LOW হিসেবে এটুকুই যথেষ্ট।)
    let directTrxSnap;
    try {
        directTrxSnap = await getDoc(trxRef);
    } catch (e) {
        if (e?.code === 'permission-denied') {
            throw new Error('এই Transaction ID যাচাই করা যায়নি। আবার দেখে চেষ্টা করো।');
        }
        throw e;
    }
    if (directTrxSnap.exists()) throw new Error('এই Transaction ID আগেই জমা দেওয়া হয়েছে।');

    const legacyDupCheck = await getDocs(
        query(collection(db, 'paymentRequests'),
              where('transactionId', '==', normalizedTrxId),
              limit(1))
    );
    if (!legacyDupCheck.empty) throw new Error('এই Transaction ID আগেই জমা দেওয়া হয়েছে।');

    const paymentId =
        'PAY-' + Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
        await runTransaction(db, async (transaction) => {
            // FIX (#8, AUD-020): tournament status + fee are re-read and
            // re-validated INSIDE the transaction. Previously they were only
            // checked on stale pre-reads, so a tournament cancelled/completed
            // (or a fee changed) in the gap still committed a payment built
            // from old data. The payment doc is now built from the in-txn fee.
            const latestTournSnap = await transaction.get(tournSnap.ref);
            if (!latestTournSnap.exists()) {
                throw new Error('টুর্নামেন্ট পাওয়া যায়নি');
            }
            const latestTourn = latestTournSnap.data();
            if (latestTourn.status !== 'upcoming') {
                throw new Error(`পেমেন্ট জমা দেওয়া যাবে না। টুর্নামেন্ট এখন ${_statusBn(latestTourn.status)} অবস্থায় আছে।`);
            }
            const latestFee = Number(latestTourn.entryFee || 0);
            if (latestFee <= 0) throw new Error('এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।');

            const latestTeamSnap = await transaction.get(teamSnap.ref);
            if (!latestTeamSnap.exists()) {
                throw new Error('টিমের রেজিস্ট্রেশন পাওয়া যায়নি। আগে টিম রেজিস্টার করো।');
            }
            const latestTeam = latestTeamSnap.data();
            if (latestTeam.paymentStatus === 'approved' || latestTeam.status === 'confirmed') {
                throw new Error('এই টিম ইতিমধ্যে কনফার্ম ও পেমেন্ট করা হয়েছে।');
            }
            if (latestTeam.paymentStatus === 'pending') {
                throw new Error('এই টিমের একটি পেমেন্ট ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে।');
            }
            // FIX (2026-10-25, F10): txn-এর ভেতরেও একই rejected guard —
            // pre-check আর commit-এর মাঝে reject হলেও dangling pending নয়।
            if (latestTeam.status === 'rejected') {
                throw new Error('অ্যাডমিন এই টিমটি বাতিল করেছেন। নতুন করে জয়েন করো।');
            }

            // Authoritative duplicate-UTR check INSIDE the transaction.
            const trxSnap = await transaction.get(trxRef);
            if (trxSnap.exists()) {
                throw new Error('এই Transaction ID আগেই জমা দেওয়া হয়েছে।');
            }

            const paymentDocPayload = {
                paymentId,
                tournamentId: t.id,
                tournamentName: latestTourn.name || t.name,
                teamId: teamData.teamId,
                teamName: latestTeam.teamName || teamData.teamName,
                userId: uid,
                userName: uData.name || 'User',
                userEmail: uData.email || authEmail || '',
                entryFee: latestFee,
                amount: latestFee,
                transactionId: normalizedTrxId,
                paymentMethod: 'upi',
                status: 'pending',
                submittedAt: serverTimestamp(),
                reviewedAt: null,
                reviewedBy: null,
                rejectionReason: null
            };

            transaction.set(trxRef, paymentDocPayload);
            transaction.update(teamSnap.ref, {
                paymentId,
                transactionId: normalizedTrxId,
                paymentStatus: 'pending',
                updatedAt: serverTimestamp()
            });
        });
    } catch (e) {
        if (e && (e.code === 'permission-denied' || e.code === 'already-exists')) {
            throw new Error('এই Transaction ID আগেই জমা দেওয়া হয়েছে।');
        }
        throw e;
    }

    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'payment_pending',
            title: 'পেমেন্ট জমা হয়েছে',
            body: `"${freshTourn.name}"-এর জন্য ₹${authoritativeFee} পেমেন্ট (Team: ${teamData.teamId}) অ্যাডমিন যাচাইয়ের অপেক্ষায় আছে।`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}

    return authoritativeFee;
}

// ════════════════════════════════════════════════════════════════
// FIX (flow change): NEW PAID JOIN — one atomic request.
// The player confirms on the payment page with payment details; ONLY
// THEN is anything created:
//   • tournamentTeams doc  (status 'pending', paymentStatus 'pending')
//   • captain lock + player UID locks (status 'pending')
//   • paymentRequests doc  (deterministic UTR doc ID, status 'pending')
// NO seat is reserved (filledTeams/pendingTeams are NOT touched) and
// there is NO expiry — the request waits until the admin accepts
// (confirm → confirmed) or rejects it from the admin panel. The doc
// shapes match exactly what the admin panel's confirm/reject expects.
// ════════════════════════════════════════════════════════════════
function generatePaidTeamId() {
    // Same generator shape as the join flow (TEAM-XXXXX-XXXX).
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let randomPart = '';
    for (let i = 0; i < 4; i++) randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    return `TEAM-${timePart}-${randomPart}`;
}

export async function submitPaidJoinRequest({ t, teamName, players, trxId, uid, uData, authEmail }) {
    // v8.8 (item 11): UPI দিয়ে নতুন paid join বন্ধ — নতুন join শুধু
    // wallet-only instant (submitInstantWalletJoin)। এই function আর
    // নতুন paid join বানাবে না — কোনো team / lock / paymentRequests
    // doc তৈরি হবে না। পুরনো pending UPI request-গুলো (doc হিসেবে
    // আগেই আছে) এতে ছোঁয়া হয় না — admin আগের মতোই confirm/reject
    // করতে পারবে, আর matches/payment পেজে pending status দেখা যাবে।
    // নিচের body শুধু reference হিসেবে রাখা হলো, কখনো চলে না।
    throw new Error('নতুন paid join শুধু Wallet দিয়ে হয় — UPI দিয়ে নতুন join আর নেওয়া হয় না। Deposit Balance দিয়ে Confirm Join চাপো।');
    const normalizedTrxId = String(trxId || '').trim().toUpperCase();
    if (!normalizedTrxId) throw new Error('Transaction ID দরকার।');

    const teamId = generatePaidTeamId();
    const format = t.teamFormat || 'SOLO';
    const tournRef = doc(db, 'tournaments', t.id);
    const teamRef = doc(db, 'tournamentTeams', teamId);
    const captainLockRef = doc(db, 'tournamentCaptains', `${t.id}_${uid}`);
    const uidLockRefs = players.map(pl => doc(db, 'tournamentPlayerUIDs', `${t.id}_${pl.ffUID}`));
    const trxRef = doc(db, 'paymentRequests', transactionDocId(normalizedTrxId));
    const paymentId =
        'PAY-' + Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase();

    let committedFee = 0;
    let committedName = t.name || '';

    await runTransaction(db, async (transaction) => {
        // ── ALL reads first (Firestore transaction rule) ──
        const lockSnap = await transaction.get(captainLockRef);
        if (lockSnap.exists() && lockSnap.data().status !== 'rejected') {
            throw new Error('এই টুর্নামেন্টে তোমার টিম ইতিমধ্যে রেজিস্টার করা আছে।');
        }

        const tournSnap = await transaction.get(tournRef);
        if (!tournSnap.exists()) throw new Error('টুর্নামেন্ট পাওয়া যায়নি');
        const tournData = tournSnap.data();
        if ((tournData.status || 'upcoming') !== 'upcoming') {
            throw new Error(`জয়েন করা যাবে না। টুর্নামেন্ট এখন ${_statusBn(tournData.status)} অবস্থায় আছে।`);
        }
        // Fee is authoritative from the tournament doc — never from the client.
        const fee = Number(tournData.entryFee || 0);
        if (fee <= 0) throw new Error('এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।');
        committedFee = fee;
        committedName = tournData.name || t.name || '';

        // Capacity: only CONFIRMED seats count. Pending join requests hold
        // no seat under the new flow (the admin confirm re-checks capacity
        // again before confirming, so a tournament cannot overfill).
        const maxTeams = normalizeTournament(tournData, t.id).maxTeams;
        const filled = Number(tournData.filledTeams || tournData.filledSlots || 0);
        if (maxTeams > 0 && filled >= maxTeams) {
            throw new Error('টুর্নামেন্ট পূর্ণ হয়ে গেছে।');
        }

        const teamCollisionSnap = await transaction.get(teamRef);
        if (teamCollisionSnap.exists()) {
            throw new Error('কিছু একটা গণ্ডগোল হয়েছে। আবার Confirm চাপো।');
        }

        // FIX (2026-10-25, F1): captain-এর FF UID profile doc থেকে live
        // যাচাই — paid SOLO-তেও editable UID দিয়ে victim block করা যেত।
        const paidUserSnap = await transaction.get(doc(db, 'users', uid));
        const paidProfileFFUID = String(paidUserSnap.data()?.ffUID || '').trim();
        if (!paidProfileFFUID) {
            throw new Error('তোমার প্রোফাইলে Free Fire UID সেভ করা নেই। আগে প্রোফাইলে UID সেভ করো, তারপর জয়েন করো।');
        }
        if (String(players[0]?.ffUID || '').trim() !== paidProfileFFUID) {
            throw new Error('ক্যাপ্টেনের Free Fire UID প্রোফাইলের সঙ্গে মিলছে না। প্রোফাইল দেখে আবার চেষ্টা করো।');
        }

        // FIX (2026-10-25, F2): free txn-এর মতোই — lock-এর team live
        // দেখে squatted (team নেই / rejected / expired) হলে overwrite হবে;
        // live team থাকলে duplicate error। teamId-হীন lock block থাকবে।
        const uidLockSnaps = await Promise.all(uidLockRefs.map(r => transaction.get(r)));
        for (let i = 0; i < uidLockSnaps.length; i++) {
            const snap = uidLockSnaps[i];
            if (!snap.exists() || snap.data().status === 'rejected') continue;
            const lockTeamId = snap.data().teamId;
            let squatted = false;
            if (lockTeamId) {
                const lockTeamSnap = await transaction.get(doc(db, 'tournamentTeams', lockTeamId));
                if (!lockTeamSnap.exists() || lockTeamSnap.data().status === 'rejected' || lockTeamSnap.data().status === 'expired') {
                    squatted = true;
                }
            }
            if (!squatted) {
                const err = new Error(`Free Fire UID (${players[i].ffUID}) এই টুর্নামেন্টে ইতিমধ্যে রেজিস্টার করা আছে!`);
                err.code = 'duplicate-ff-uid';
                throw err;
            }
        }

        const trxSnap = await transaction.get(trxRef);
        if (trxSnap.exists()) {
            throw new Error('এই Transaction ID আগেই জমা দেওয়া হয়েছে।');
        }

        // ── Writes ──
        transaction.set(teamRef, {
            teamId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamName,
            teamFormat: format,
            persistentTeamId: null,
            captainUserId: uid,
            captainName: uData.name || 'User',
            // FIX (2026-10-25, M1): captainEmail REMOVED — see
            // join-tournament.js note (team docs are signed-in-readable).
            players,
            playerFFUIDs: players.map(pl => String(pl.ffUID).trim()),
            status: 'pending',
            paymentStatus: 'pending',
            locked: false,
            roomSlot: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        transaction.set(captainLockRef, {
            tournamentId: t.id,
            captainUserId: uid,
            teamId,
            status: 'pending',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        uidLockRefs.forEach((ref, i) => {
            transaction.set(ref, {
                tournamentId: t.id,
                ffUID: players[i].ffUID,
                playerName: players[i].playerName,
                teamId,
                captainUserId: uid,
                status: 'pending',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        transaction.set(trxRef, {
            paymentId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamId,
            teamName,
            userId: uid,
            userName: uData.name || 'User',
            userEmail: uData.email || authEmail || '',
            entryFee: fee,
            amount: fee,
            transactionId: normalizedTrxId,
            paymentMethod: 'upi',
            status: 'pending',
            submittedAt: serverTimestamp(),
            reviewedAt: null,
            reviewedBy: null,
            rejectionReason: null
        });
    });

    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'payment_pending',
            title: 'জয়েনের আবেদন জমা হয়েছে',
            body: `"${committedName}"-এর জন্য ₹${committedFee} পেমেন্টসহ জয়েনের আবেদন অ্যাডমিন অনুমোদনের অপেক্ষায় আছে।`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}

    return { teamId, fee: committedFee };
}

// ════════════════════════════════════════════════════════════════
// WALLET-PAY JOIN (2026-11-07) — same pending → admin-confirm flow
// as submitPaidJoinRequest, paid from Deposit Balance instead of UPI:
//   • NO UTR, NO transactionDocId check — the payment doc ID is the
//     deterministic `wlt_<teamId>` (one wallet request per team; a
//     second submit for the same team is blocked by the team's
//     paymentStatus 'pending' + this doc).
//   • NO debit here, from the client or anywhere in the user panel.
//     The debit happens in ADMIN-PANEL code at confirm time (atomic:
//     debit depositBalance + slot confirm + DEBIT ledger entry). A
//     client-side debit is impossible under the rules (users cannot
//     write their own money fields) and is never attempted.
//   • Balance is checked TWICE before the request exists: an advisory
//     pre-check (this user's Deposit Balance, and pending wallet
//     requests + fee ≤ balance) and authoritatively inside the
//     transaction. The admin re-checks AGAIN at confirm/debit time, so
//     a race here can only produce a pending request the admin rejects
//     — never an overdraft.
//   • Deposit Balance is spent FIRST by design: it is the only pot the
//     wallet-pay path can touch. Winnings are never debited here.
// ════════════════════════════════════════════════════════════════
export async function submitWalletJoinRequest({ t, teamName, players, uid, uData, authEmail }) {
    const teamId = generatePaidTeamId();
    const format = t.teamFormat || 'SOLO';
    const tournRef = doc(db, 'tournaments', t.id);
    const teamRef = doc(db, 'tournamentTeams', teamId);
    const captainLockRef = doc(db, 'tournamentCaptains', `${t.id}_${uid}`);
    const uidLockRefs = players.map(pl => doc(db, 'tournamentPlayerUIDs', `${t.id}_${pl.ffUID}`));
    const walletPayRef = doc(db, 'paymentRequests', `wlt_${teamId}`);
    const paymentId =
        'PAY-' + Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase();

    const advisoryFee = Number(t.entryFee || 0);
    if (advisoryFee <= 0) throw new Error('এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।');

    // Advisory pre-check: Deposit Balance must cover the fee, counting
    // this user's other pending wallet requests. A failed read must NOT
    // block — the transaction below (and the admin confirm) are the
    // backstops. Same accepted race as the withdrawal/deposit guards.
    try {
        const userSnap = await getDoc(doc(db, 'users', uid));
        if (userSnap.exists()) {
            const depBal = Math.max(0, Number(userSnap.data().depositBalance || 0));
            let pendingWalletTotal = 0;
            try {
                const pendSnap = await getDocs(query(
                    collection(db, 'paymentRequests'),
                    where('userId', '==', uid),
                    where('paymentMethod', '==', 'wallet'),
                    where('status', '==', 'pending'),
                    limit(50)
                ));
                pendSnap.forEach(d => { pendingWalletTotal += Number(d.data()?.amount || 0); });
            } catch (e) {
                // Composite index missing — fall back to userId-only + client filter.
                if (e?.code === 'failed-precondition') {
                    const pendSnap = await getDocs(query(
                        collection(db, 'paymentRequests'),
                        where('userId', '==', uid),
                        limit(50)
                    ));
                    pendSnap.forEach(d => {
                        const p = d.data();
                        if (p.paymentMethod === 'wallet' && p.status === 'pending') {
                            pendingWalletTotal += Number(p.amount || 0);
                        }
                    });
                } else {
                    throw e;
                }
            }
            if (pendingWalletTotal + advisoryFee > depBal) {
                throw new Error(`Deposit Balance যথেষ্ট নয়: ₹${pendingWalletTotal.toFixed(2)} ইতিমধ্যে pending আছে, উপলব্ধ ₹${depBal.toFixed(2)}।`);
            }
        }
    } catch (e) {
        // Keep our own advisory message; a failed read must not block.
        if (e && e.message && e.message.indexOf('Deposit Balance যথেষ্ট নয়') === 0) throw e;
    }

    let committedFee = 0;
    let committedName = t.name || '';

    await runTransaction(db, async (transaction) => {
        // ── ALL reads first (Firestore transaction rule) ──
        const lockSnap = await transaction.get(captainLockRef);
        if (lockSnap.exists() && lockSnap.data().status !== 'rejected') {
            throw new Error('এই টুর্নামেন্টে তোমার টিম ইতিমধ্যে রেজিস্টার করা আছে।');
        }

        const tournSnap = await transaction.get(tournRef);
        if (!tournSnap.exists()) throw new Error('টুর্নামেন্ট পাওয়া যায়নি');
        const tournData = tournSnap.data();
        if ((tournData.status || 'upcoming') !== 'upcoming') {
            throw new Error(`জয়েন করা যাবে না। টুর্নামেন্ট এখন ${_statusBn(tournData.status)} অবস্থায় আছে।`);
        }
        // Fee is authoritative from the tournament doc — never from the client.
        const fee = Number(tournData.entryFee || 0);
        if (fee <= 0) throw new Error('এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।');
        committedFee = fee;
        committedName = tournData.name || t.name || '';

        // Capacity: only CONFIRMED seats count. Pending join requests hold
        // no seat under the new flow (the admin confirm re-checks capacity
        // again before confirming, so a tournament cannot overfill).
        const maxTeams = normalizeTournament(tournData, t.id).maxTeams;
        const filled = Number(tournData.filledTeams || tournData.filledSlots || 0);
        if (maxTeams > 0 && filled >= maxTeams) {
            throw new Error('টুর্নামেন্ট পূর্ণ হয়ে গেছে।');
        }

        const teamCollisionSnap = await transaction.get(teamRef);
        if (teamCollisionSnap.exists()) {
            throw new Error('কিছু একটা গণ্ডগোল হয়েছে। আবার Confirm চাপো।');
        }

        // Captain's FF UID from the profile doc, live (same as paid join).
        const paidUserSnap = await transaction.get(doc(db, 'users', uid));
        const paidProfileFFUID = String(paidUserSnap.data()?.ffUID || '').trim();
        if (!paidProfileFFUID) {
            throw new Error('তোমার প্রোফাইলে Free Fire UID সেভ করা নেই। আগে প্রোফাইলে UID সেভ করো, তারপর জয়েন করো।');
        }
        if (String(players[0]?.ffUID || '').trim() !== paidProfileFFUID) {
            throw new Error('ক্যাপ্টেনের Free Fire UID প্রোফাইলের সঙ্গে মিলছে না। প্রোফাইল দেখে আবার চেষ্টা করো।');
        }

        // Authoritative balance check INSIDE the transaction: the Deposit
        // Balance (read, never written) must cover the fee. The admin
        // re-checks at debit time, so this guards the request only.
        const depBal = Math.max(0, Number(paidUserSnap.data()?.depositBalance || 0));
        if (depBal < fee) {
            throw new Error(`Deposit Balance যথেষ্ট নয়: আছে ₹${depBal.toFixed(2)}, এন্ট্রি ফি ₹${fee.toFixed(2)}।`);
        }

        const uidLockSnaps = await Promise.all(uidLockRefs.map(r => transaction.get(r)));
        for (let i = 0; i < uidLockSnaps.length; i++) {
            const snap = uidLockSnaps[i];
            if (!snap.exists() || snap.data().status === 'rejected') continue;
            const lockTeamId = snap.data().teamId;
            let squatted = false;
            if (lockTeamId) {
                const lockTeamSnap = await transaction.get(doc(db, 'tournamentTeams', lockTeamId));
                if (!lockTeamSnap.exists() || lockTeamSnap.data().status === 'rejected' || lockTeamSnap.data().status === 'expired') {
                    squatted = true;
                }
            }
            if (!squatted) {
                const err = new Error(`Free Fire UID (${players[i].ffUID}) এই টুর্নামেন্টে ইতিমধ্যে রেজিস্টার করা আছে!`);
                err.code = 'duplicate-ff-uid';
                throw err;
            }
        }

        // A wallet request for this team already exists (deterministic ID).
        const walletSnap = await transaction.get(walletPayRef);
        if (walletSnap.exists()) {
            throw new Error('এই টিমের একটি wallet পেমেন্ট ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে।');
        }

        // ── Writes ──
        // NOTE: depositBalance / walletBalance / totalEarnings are
        // intentionally NOT touched here — the admin debits depositBalance
        // at confirm time.
        transaction.set(teamRef, {
            teamId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamName,
            teamFormat: format,
            persistentTeamId: null,
            captainUserId: uid,
            captainName: uData.name || 'User',
            players,
            playerFFUIDs: players.map(pl => String(pl.ffUID).trim()),
            status: 'pending',
            paymentStatus: 'pending',
            paymentMethod: 'wallet',
            locked: false,
            roomSlot: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        transaction.set(captainLockRef, {
            tournamentId: t.id,
            captainUserId: uid,
            teamId,
            status: 'pending',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        uidLockRefs.forEach((ref, i) => {
            transaction.set(ref, {
                tournamentId: t.id,
                ffUID: players[i].ffUID,
                playerName: players[i].playerName,
                teamId,
                captainUserId: uid,
                status: 'pending',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        transaction.set(walletPayRef, {
            paymentId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamId,
            teamName,
            userId: uid,
            userName: uData.name || 'User',
            userEmail: uData.email || authEmail || '',
            entryFee: fee,
            amount: fee,
            transactionId: `WALLET-${teamId}`,
            paymentMethod: 'wallet',
            status: 'pending',
            submittedAt: serverTimestamp(),
            reviewedAt: null,
            reviewedBy: null,
            rejectionReason: null
        });
    });

    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'wallet_join_pending',
            title: 'জয়েনের আবেদন জমা হয়েছে',
            body: `Deposit Balance দিয়ে "${committedName}"-এর জয়েনের আবেদন অ্যাডমিন অনুমোদনের অপেক্ষায় আছে। অ্যাডমিন কনফার্ম করলেই ₹${committedFee.toFixed(2)} কাটবে।`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}

    return { teamId, fee: committedFee };
}

// ════════════════════════════════════════════════════════════════
// INSTANT SLOT BOOKING — PAID (v8.3, 2026-11-11)
// আগের flow (submitWalletJoinRequest): pending request → admin
// confirm-এ debit + slot। নতুন flow: আর অপেক্ষা নেই — user আগেই
// Deposit Balance-এ টাকা ভরে রাখে, Join-এ একটাই Firestore txn-এ
// সব হয়: slot lock + team confirmed + depositBalance debit +
// DEBIT ledger। Slot না পেলে বা balance কম হলে txn পুরোটা abort —
// টাকা কাটবে না, slot-ও বুক হবে না।
//
// ATOMIC (এক txn-এ, all-or-nothing):
//   1. Slot: tournamentSlots/{tid}_{slot} lock — আগে থেকে confirmed
//      lock থাকলে SLOT_TAKEN (দুজন এক slot পাবে না; contention-এ
//      Firestore একটা txn retry করিয়ে অন্যটাকে abort করাবে)।
//   2. Wallet: user doc থেকে live depositBalance পড়ে fee-র সঙ্গে
//      মিলিয়ে তারপরই debit — কম থাকলে INSUFFICIENT, txn abort।
//   3. Duplicate: ledger doc ID deterministic `debit_<teamId>` (set,
//      get নয় — retry-তে একই doc আবার লেখা হয়, দ্বিতীয় entry হয়
//      না) + captain lock (double-click-এ দ্বিতীয় txn 'already
//      registered' দেখে থামবে) + button in-flight guard (payment.js)।
//   4. Fee: tournament doc থেকে live — client-এর fee কখনো বিশ্বাস
//      করা হয় না।
// NO paymentRequests doc বানানো হয় না — বানালে admin queue-তে
// pending request যেত আর admin confirm করলে আবার debit হতো
// (double charge)। পুরনো pending wlt_ request-গুলো আগের মতোই admin
// confirm করবে (submitWalletJoinRequest অপরিবর্তিত রাখা হয়েছে)।
//
// ⚠️ HARD BLOCKER — rules v17: এই txn user হয়ে চলে, তাই v17 publish
// না হলে permission-denied-এ পুরো txn fail করবে (টাকা/slot কিছুই
// বদলাবে না — atomic বলেই নিরাপদ, কিন্তু join হবে না)। v17-তে যা
// লাগে: users owner depositBalance DECREASE-only update,
// walletTransactions owner debit-create (`debit_<teamId>`), আর
// tournamentSlots collection-এর rule। আগে console-এ v17 Publish
// করো, তারপর এই build deploy করো।
// ════════════════════════════════════════════════════════════════
export async function submitInstantWalletJoin({ t, teamName, players, slot, uid, uData, authEmail }) {
    const teamId = generatePaidTeamId();
    const format = t.teamFormat || 'SOLO';
    const chosenSlot = Number(slot);
    const tournRef = doc(db, 'tournaments', t.id);
    const teamRef = doc(db, 'tournamentTeams', teamId);
    const captainLockRef = doc(db, 'tournamentCaptains', `${t.id}_${uid}`);
    const uidLockRefs = players.map(pl => doc(db, 'tournamentPlayerUIDs', `${t.id}_${pl.ffUID}`));
    const slotLockRef = doc(db, 'tournamentSlots', `${t.id}_${chosenSlot}`);
    const ledgerRef = doc(db, 'walletTransactions', `debit_${teamId}`);
    const userRef = doc(db, 'users', uid);

    let committedFee = 0;
    let committedName = t.name || '';

    await runTransaction(db, async (transaction) => {
        // ── ALL reads first (Firestore transaction rule) ──
        const lockSnap = await transaction.get(captainLockRef);
        if (lockSnap.exists() && lockSnap.data().status !== 'rejected') {
            throw new Error('এই টুর্নামেন্টে তোমার টিম ইতিমধ্যে রেজিস্টার করা আছে।');
        }

        const tournSnap = await transaction.get(tournRef);
        if (!tournSnap.exists()) throw new Error('টুর্নামেন্ট পাওয়া যায়নি');
        const tournData = tournSnap.data();
        if ((tournData.status || 'upcoming') !== 'upcoming') {
            throw new Error(`জয়েন করা যাবে না। টুর্নামেন্ট এখন ${_statusBn(tournData.status)} অবস্থায় আছে।`);
        }
        // Fee authoritative from the tournament doc — never from the client.
        // FIX (2026-11-20, W8): 2dp-তে round (deposit/withdrawal-এর মতো) —
        // fractional entryFee (যেমন 99.999) ভগ্নাংশ paise কাটত।
        const fee = Math.round(Number(tournData.entryFee || 0) * 100) / 100;
        if (fee <= 0) throw new Error('এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।');
        committedFee = fee;
        committedName = tournData.name || t.name || '';

        // Capacity (FIX 2026-11-11, H6): instant confirm মানেই seat এখনই
        // নেওয়া — UI + free txn-এর মতোই filled + pending গুনতে হবে
        // (legacy pending request-ও seat ধরে রাখে)।
        const maxTeams = normalizeTournament(tournData, t.id).maxTeams;
        const filled = Number(tournData.filledTeams || tournData.filledSlots || 0);
        const pending = Number(tournData.pendingTeams || 0);
        if (maxTeams > 0 && filled + pending >= maxTeams) {
            throw new Error('টুর্নামেন্ট পূর্ণ হয়ে গেছে।');
        }
        if (!Number.isInteger(chosenSlot) || chosenSlot < 1 || (maxTeams > 0 && chosenSlot > maxTeams)) {
            throw new Error(`1 থেকে ${maxTeams}-এর মধ্যে একটি Slot বেছে নাও।`);
        }

        const teamCollisionSnap = await transaction.get(teamRef);
        if (teamCollisionSnap.exists()) {
            throw new Error('কিছু একটা গণ্ডগোল হয়েছে। আবার Confirm চাপো।');
        }

        // Captain's FF UID + Deposit Balance — profile doc থেকে live।
        const paidUserSnap = await transaction.get(userRef);
        if (!paidUserSnap.exists()) throw new Error('তোমার প্রোফাইল লোড হয়নি। আবার চেষ্টা করো।');
        const paidProfileFFUID = String(paidUserSnap.data()?.ffUID || '').trim();
        if (!paidProfileFFUID) {
            throw new Error('তোমার প্রোফাইলে Free Fire UID সেভ করা নেই। আগে প্রোফাইলে UID সেভ করো, তারপর জয়েন করো।');
        }
        if (String(players[0]?.ffUID || '').trim() !== paidProfileFFUID) {
            throw new Error('ক্যাপ্টেনের Free Fire UID প্রোফাইলের সঙ্গে মিলছে না। প্রোফাইল দেখে আবার চেষ্টা করো।');
        }
        // INSUFFICIENT BALANCE — balance কম থাকলে এখানেই abort: কোনো
        // write হয় না, টাকা কাটে না, slot বুক হয় না।
        const depBal = Math.max(0, Number(paidUserSnap.data()?.depositBalance || 0));
        if (depBal < fee) {
            const err = new Error(`Deposit Balance যথেষ্ট নয়: আছে ₹${depBal.toFixed(2)}, এন্ট্রি ফি ₹${fee.toFixed(2)}। আগে Wallet-এ টাকা যোগ করো।`);
            err.code = 'insufficient-balance';
            throw err;
        }

        // Duplicate FF UID check (free txn-এর মতোই squat-heal সহ)।
        const uidLockSnaps = await Promise.all(uidLockRefs.map(r => transaction.get(r)));
        for (let i = 0; i < uidLockSnaps.length; i++) {
            const snap = uidLockSnaps[i];
            if (!snap.exists() || snap.data().status === 'rejected') continue;
            const lockTeamId = snap.data().teamId;
            let squatted = false;
            if (lockTeamId) {
                const lockTeamSnap = await transaction.get(doc(db, 'tournamentTeams', lockTeamId));
                if (!lockTeamSnap.exists() || lockTeamSnap.data().status === 'rejected' || lockTeamSnap.data().status === 'expired') {
                    squatted = true;
                }
            }
            if (!squatted) {
                const err = new Error(`Free Fire UID (${players[i].ffUID}) এই টুর্নামেন্টে ইতিমধ্যে রেজিস্টার করা আছে!`);
                err.code = 'duplicate-ff-uid';
                throw err;
            }
        }

        // ── SLOT LOCK (atomic booking-এর মূল guard) ──
        // Lock আছে + confirmed + তার team-ও confirmed → SLOT_TAKEN।
        // Lock-এর team মৃত (doc নেই / rejected / expired) → squatted,
        // overwrite হবে (UID-lock F2 pattern-এর মতোই)। teamId-হীন lock
        // প্রমাণ করা যায় না বলে block থাকবে — admin-কে delete করতে হবে।
        const slotSnap = await transaction.get(slotLockRef);
        if (slotSnap.exists() && slotSnap.data().status !== 'released' && slotSnap.data().status !== 'rejected') {
            const lockTeamId = slotSnap.data().teamId;
            // v8.8 (item 4): teamId-হীন lock stuck — squat-heal করা যায়
            // না, তাই আলাদা code-এ জানাও (free txn-এর মতোই)। User-side
            // delete নেই — শুধু admin lock delete করতে পারে।
            if (!lockTeamId) {
                const stuckErr = new Error(`Slot ${chosenSlot} আটকে আছে — অ্যাডমিনকে জানাও। শুধু অ্যাডমিনই এই Slot ছাড়াতে পারবে। অন্য Slot বেছে নাও।`);
                stuckErr.code = 'slot-stuck';
                throw stuckErr;
            }
            let squatted = false;
            if (lockTeamId) {
                const lockTeamSnap = await transaction.get(doc(db, 'tournamentTeams', lockTeamId));
                // FIX (2026-11-11, C3): team-এর captain lock-এর captain-এর
                // সঙ্গে না মিললে lock-টাও squatted — live teamId দিয়ে
                // বসানো griefing lock আর চিরকাল slot আটকে রাখবে না।
                if (!lockTeamSnap.exists() || lockTeamSnap.data().status === 'rejected' || lockTeamSnap.data().status === 'expired' || lockTeamSnap.data().captainUserId !== slotSnap.data().captainUserId) {
                    squatted = true;
                }
            }
            if (!squatted) {
                const err = new Error(`Slot ${chosenSlot} ইতিমধ্যে বুক হয়ে গেছে — অন্য Slot বেছে নাও।`);
                err.code = 'slot-taken';
                throw err;
            }
        }

        // ── Writes (সব একসঙ্গে, না হলে কিছুই না) ──
        const newFilled = filled + 1;
        // FIX (2026-11-19, v8.11, B4): counterGuard rules live doc-এর
        // teamFormat দিয়ে default বের করে — UI state-এর format
        // (t.teamFormat) stale হতে পারে (admin format বদলালে, বা state-এ
        // teamFormat না থাকলে 'SOLO' ধরে নিত)। তখন লেখা filledPlayers
        // আর rules-এর হিসাবে মিলত না, পুরো txn permission-denied-এ
        // মরত। এখন fallback-ও live doc থেকেই (FREE পথের একই ফিক্স)।
        const _fmt = String(tournData.teamFormat || 'SOLO').toUpperCase();
        const playersPerTeam =
            Number(tournData.playersPerTeam || 0) ||
            (_fmt === 'DUO' ? 2 : _fmt === 'SQUAD' ? 4 : 1);
        const freedSlots = Array.isArray(tournData.freedSlots)
            ? tournData.freedSlots.map(Number).filter(n => Number.isFinite(n) && n >= 1)
            : [];

        transaction.update(tournRef, {
            filledTeams: newFilled,
            filledSlots: newFilled,
            filledPlayers: newFilled * playersPerTeam,
            ...(freedSlots.includes(chosenSlot) ? { freedSlots: arrayRemove(chosenSlot) } : {})
        });

        // Team — সাথে সাথে confirmed + locked, paymentStatus 'approved'
        // (admin confirm-এর মতোই shape, participants-paid.js:368)।
        transaction.set(teamRef, {
            teamId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamName,
            teamFormat: format,
            persistentTeamId: null,
            captainUserId: uid,
            captainName: uData.name || 'User',
            players,
            playerFFUIDs: players.map(pl => String(pl.ffUID).trim()),
            status: 'confirmed',
            paymentStatus: 'approved',
            paymentMethod: 'wallet',
            locked: true,
            roomSlot: chosenSlot,
            lockedAt: serverTimestamp(),
            lockedBy: 'system-auto-instant',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        transaction.set(captainLockRef, {
            tournamentId: t.id,
            captainUserId: uid,
            teamId,
            status: 'confirmed',
            roomSlot: chosenSlot,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        uidLockRefs.forEach((ref, i) => {
            transaction.set(ref, {
                tournamentId: t.id,
                ffUID: players[i].ffUID,
                playerName: players[i].playerName,
                teamId,
                captainUserId: uid,
                status: 'confirmed',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        transaction.set(slotLockRef, {
            tournamentId: t.id,
            slot: chosenSlot,
            slotKey: String(chosenSlot),
            teamId,
            captainUserId: uid,
            status: 'confirmed',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        // ATOMIC WALLET DEDUCTION — depositBalance − fee, একই txn-এ।
        // Rules v17: owner শুধু কমাতে পারে (decrease-only), বাড়াতে
        // পারে না — তাই client দিয়ে নিজের balance বাড়ানো অসম্ভব।
        transaction.update(userRef, {
            depositBalance: depBal - fee,
            joinedTournaments: arrayUnion(t.id),
            updatedAt: serverTimestamp()
        });

        // Idempotent DEBIT ledger — admin confirm-এর `debit_<id>` shape-ই
        // (type 'debit', amount −fee, status 'completed'), শুধু doc ID
        // `debit_<teamId>` (paymentRequest নেই বলে paymentId-ও নেই;
        // reference `WALLET-<teamId>`)। Wallet পেজের history-তে এটা
        // '-₹fee' হিসেবে দেখাবে।
        transaction.set(ledgerRef, {
            userId: uid,
            type: 'debit',
            title: 'টুর্নামেন্ট এন্ট্রি — Wallet',
            description: `Deposit Balance থেকে এন্ট্রি ফি কাটা হয়েছে — Slot ${chosenSlot} সঙ্গে সঙ্গে কনফার্ম হয়েছে`,
            paymentMethod: 'wallet',
            reference: `WALLET-${teamId}`,
            source: 'wallet',
            tournamentId: t.id,
            teamId,
            amount: -fee,
            status: 'completed',
            createdAt: serverTimestamp()
        });
    });

    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'slot_confirmed',
            title: 'Slot কনফার্ম হয়েছে',
            body: `"${committedName}"-এর জন্য Slot ${chosenSlot} কনফার্ম হয়েছে। Deposit Balance থেকে ₹${committedFee.toFixed(2)} কেটেছে।`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}

    // FIX (2026-11-20, W3): debit-এর পর ledger cache মোছো — নইলে
    // join-এর পরপর Wallet খুললে পুরনো ledger / Total Spent দেখাত।
    invalidateWalletCache(uid);

    return { teamId, fee: committedFee, slot: chosenSlot };
}

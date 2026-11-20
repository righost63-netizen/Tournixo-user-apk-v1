// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
// scripts/report-player.js — Fair play report page (v7.1)
import { initPage } from './app.js';
import { state } from './state.js';
import { showToast, friendlyErrorMessage } from './toast.js';
import { goBack, getParam } from '../config/app-config.js';
import { REPORT_REASONS, submitPlayerReport } from '../services/report.service.js';
import { db, collection, query, where, orderBy, limit, getDocs, doc, getDoc, documentId } from '../firebase/firebase-init.js';

// FIX (2026-11-19, v8.11): tournamentId — URL (?tournamentId=) থেকে
// এলে সেটাই ব্যবহার হবে; না থাকলে নিজের জয়েন করা টুর্নামেন্টের
// picker দেখাবে। দুটোই না পেলে ফিল্ড খালি থাকবে, crash নয়।
let _urlTournamentId = null;

function initForm() {
    const sel = document.getElementById('report-reason');
    REPORT_REASONS.forEach(r => {
        const o = document.createElement('option');
        o.value = r.value;
        o.textContent = r.label;
        sel.appendChild(o);
    });
    // Optional: pre-fill UID (?uid=...) when opened from a player context
    const pre = getParam('uid');
    if (pre && /^\d{8,12}$/.test(pre)) {
        document.getElementById('report-ffuid').value = pre;
    }
    initTournamentField();
    document.getElementById('report-submit-btn').addEventListener('click', onSubmit);
    // FIX (2026-11-19, v8.11): counter wiring এখানে, null guard-সহ —
    // আগে module top-level-এ guard ছাড়া ছিল, element না থাকলে
    // পুরো module মরত।
    const det = document.getElementById('report-details');
    const cnt = document.getElementById('report-details-count');
    if (det && cnt) det.addEventListener('input', () => { cnt.textContent = det.value.length + ' / 500'; });
}

// ── Tournament field: URL param থাকলে নাম দেখিয়ে lock করো, না থাকলে
//    নিজের জয়েন করা টুর্নামেন্টের list ভরো (matches.js-এর মতোই
//    tournamentTeams + tournaments read — নতুন collection নয়) ──
function initTournamentField() {
    const tid = getParam('tournamentId');
    const row = document.getElementById('report-tournament-row');
    const sel = document.getElementById('report-tournament');
    const fixed = document.getElementById('report-tournament-fixed');
    if (!row || !sel) return;
    if (tid) {
        _urlTournamentId = tid;
        row.style.display = 'none';
        if (fixed) {
            fixed.style.display = '';
            fixed.textContent = 'টুর্নামেন্ট লোড হচ্ছে…';
            getDoc(doc(db, 'tournaments', tid)).then(s => {
                fixed.textContent = 'টুর্নামেন্ট: ' + (s.exists() ? (s.data()?.name || tid) : tid);
            }).catch(() => {
                fixed.textContent = 'টুর্নামেন্ট: ' + tid;
            });
        }
        return;
    }
    loadMyTournaments(sel);
}

async function loadMyTournaments(sel) {
    const uid = state.currentUser?.uid;
    if (!uid) return;
    // matches.js-এর মতো: orderBy fail করলে (index নেই) plain query-তে fallback।
    const fetchTeams = async (qOrdered, qPlain) => {
        try { return await getDocs(qOrdered); }
        catch (e) { if (e?.code !== 'failed-precondition') throw e; return await getDocs(qPlain); }
    };
    try {
        const teamQueries = [
            fetchTeams(
                query(collection(db, 'tournamentTeams'), where('captainUserId', '==', uid), orderBy('createdAt', 'desc'), limit(100)),
                query(collection(db, 'tournamentTeams'), where('captainUserId', '==', uid))
            ),
            fetchTeams(
                query(collection(db, 'tournamentTeams'), where('playerUids', 'array-contains', uid), orderBy('createdAt', 'desc'), limit(100)),
                query(collection(db, 'tournamentTeams'), where('playerUids', 'array-contains', uid))
            ).catch(() => null)
        ];
        const myFFUID = String(state.userData?.ffUID || '').trim();
        if (myFFUID) {
            teamQueries.push(fetchTeams(
                query(collection(db, 'tournamentTeams'), where('playerFFUIDs', 'array-contains', myFFUID), orderBy('createdAt', 'desc'), limit(100)),
                query(collection(db, 'tournamentTeams'), where('playerFFUIDs', 'array-contains', myFFUID))
            ).catch(() => null));
        }
        const snaps = await Promise.all(teamQueries);
        const ids = new Set();
        snaps.forEach(s => s && s.forEach(d => { const t = d.data()?.tournamentId; if (t) ids.add(t); }));
        if (ids.size === 0) return;
        const idList = [...ids];
        const names = new Map();
        for (let i = 0; i < idList.length; i += 10) {
            try {
                const ts = await getDocs(query(collection(db, 'tournaments'), where(documentId(), 'in', idList.slice(i, i + 10))));
                ts.forEach(d => names.set(d.id, d.data()?.name || d.id));
            } catch (_) {}
        }
        idList.forEach(id => {
            const o = document.createElement('option');
            o.value = id;
            o.textContent = names.get(id) || id;
            sel.appendChild(o);
        });
    } catch (_) {
        // list না পেলে শুধু "কোনো টুর্নামেন্ট নয়" থাকে — পেজ আটকায় না।
    }
}

async function onSubmit() {
    const uid = state.currentUser?.uid;
    if (!uid) { showToast('আগে সাইন ইন করো', 'error'); return; }
    const btn = document.getElementById('report-submit-btn');
    const ffUID = document.getElementById('report-ffuid').value.trim();
    const reason = document.getElementById('report-reason').value;
    const details = document.getElementById('report-details').value.trim();
    // FIX (2026-11-19, v8.11): tournamentId আসলেই পাঠানো হয় — URL
    // param থাকলে সেটা, না থাকলে picker-এর বেছে নেওয়া টুর্নামেন্ট।
    const tournamentId = _urlTournamentId
        || (document.getElementById('report-tournament')?.value || null);
    if (!reason) { showToast('একটি কারণ বেছে নাও', 'warning'); return; }
    btn.disabled = true;
    btn.textContent = 'জমা হচ্ছে…';
    try {
        await submitPlayerReport({
            uid,
            reporterName: state.userData?.name || '',
            reportedFFUID: ffUID,
            ownFFUID: state.userData?.ffUID || '',
            reason,
            details,
            tournamentId
        });
        document.getElementById('report-ffuid').value = '';
        document.getElementById('report-reason').value = '';
        document.getElementById('report-details').value = '';
        const tSel = document.getElementById('report-tournament');
        if (tSel) tSel.value = '';
        showToast('রিপোর্ট জমা হয়েছে। আমাদের টিম যাচাই করবে।', 'success', 4000);
    } catch (e) {
        showToast(friendlyErrorMessage(e), 'error', 4500);
    } finally {
        btn.disabled = false;
        btn.textContent = 'রিপোর্ট জমা দাও';
    }
}

window.goBack = goBack;

initPage({
    page: 'reportPlayer',
    onReady: () => { initForm(); }
});

import { initPage } from './app.js';
import { state } from './state.js';
import { showSkeleton, showPrompt } from './modal.js';
import { showToast, friendlyErrorMessage } from './toast.js';
// v8.6 (G): বাকি English toast-গুলোও সহজ পেশাদার বাংলায় করা হয়েছে — matches-র team-name toast বাংলায়
import {
    db,
    doc,
    getDoc,
    getDocs,
    updateDoc,
    collection,
    query,
    where,
    orderBy,
    limit,
    documentId,
    serverTimestamp
} from '../firebase/firebase-init.js';
import { goTo } from '../config/app-config.js';
import { formatDateOnly, formatTimeOnly } from '../utils/formatters.js';
import { normalizeTournament } from '../services/tournaments.service.js';

// ════════════════════════════════════════════════════════════════
// XSS PROTECTION: Firestore থেকে আসা যেকোনো string innerHTML এ বসানোর আগে escape করতে হবে।
// (`??` ব্যবহার করা হয়েছে যাতে 0 মানটা খালি string না হয়ে যায়)
// NOTE: inline onclick="fn('${...}')" এর ভেতরে এটা যথেষ্ট নয় — ওখানে data-* attribute ব্যবহার করো।
// ════════════════════════════════════════════════════════════════
import { escHtml } from '../utils/escape.js';

// ════════════════════════════════════════════════════════════════
// MATCHES TAB FILTER & REAL DATA LOADER
// ════════════════════════════════════════════════════════════════
// FIX (2026-10-25, F-02): filter tap-এ আর পুরো reload নয় — data একই,
// শুধু filter বদলায়। load করা list cache থেকে client-side filter হবে।
// _matchLoadToken: দ্রুত tap-এ পুরনো load-এর result যাতে নতুন list-কে
// overwrite না করে (last-finishing-wins bug)।
let _cachedMatches = null; // { uid, list, deletedCount }
let _matchLoadToken = 0;
// FIX (2026-11-19, A3): room credentials batch fail করলে শুধু console.warn
// নয় — এই flag-এ ধরা থাকবে, যাতে confirmed কার্ডে Retry বোতাম দেখানো যায়।
let _roomCredsFailed = false;
let _roomRetryInFlight = false;

export function setMatchFilter(filter, btn) {
    state.matchFilter = filter;
    document.querySelectorAll('#tab-matches .filter-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const uid = state.currentUser?.uid;
    if (_cachedMatches && _cachedMatches.uid === uid) {
        renderMatchCards(_cachedMatches.list, state.matchFilter || 'all');
    } else {
        loadMatches();
    }
}

// FIX (2026-11-19, A3): room credentials batch fetch — loadMatches আর
// retryRoomLoad দুজনেই এটা ব্যবহার করে। Chunk query-তে denied doc এমনিতেই
// বাদ যায় (per-doc fallback recover করতে পারে না — 2026-10-25, F-09),
// তাই শুধু আসল throw-ই failed=true করে: "room এখনো publish হয়নি" (doc
// নেই, query সফল) আর "fetch fail করেছে" আলাদা থাকে — Retry বোতাম শুধু
// দ্বিতীয় ক্ষেত্রেই দেখায়।
async function fetchRoomCreds(confirmedTournIds) {
    const roomCredMap = {};
    let failed = false;
    if (!confirmedTournIds || confirmedTournIds.length === 0) return { map: roomCredMap, failed };
    const rChunks = [];
    for (let i = 0; i < confirmedTournIds.length; i += 30) {
        rChunks.push(confirmedTournIds.slice(i, i + 30));
    }
    await Promise.all(rChunks.map(async chunk => {
        try {
            const rSnap = await getDocs(query(collection(db, 'roomCredentials'), where(documentId(), 'in', chunk)));
            rSnap.forEach(d => {
                roomCredMap[d.id] = d.data();
            });
        } catch (e) {
            failed = true;
            console.warn('[Matches] room credentials batch failed:', e?.message);
        }
    }));
    return { map: roomCredMap, failed };
}

// FIX (2026-11-19, A3): room load fail → এক tap-এ Retry। শুধু room
// credentials আবার fetch করে, cache করা list-এ merge করে, আবার render
// করে — পুরো page reload নয়, list-ও মুছে যায় না। আবার fail করলে বোতাম
// থেকেই যায়; retry শুধু user tap-এই চলে, কোনো auto-loop নেই। Cache-এ
// confirmed team না থাকলে পুরো loadMatches চালায়।
export async function retryRoomLoad() {
    if (_roomRetryInFlight) return;
    const cached = _cachedMatches;
    if (!cached || !cached.list || cached.list.length === 0) { loadMatches(); return; }
    const confirmedTournIds = [...new Set(
        cached.list
            .filter(m => m.team.status === 'confirmed' || m.team.status === 'approved')
            .map(m => m.team.tournamentId)
            .filter(Boolean)
    )];
    if (confirmedTournIds.length === 0) return;
    _roomRetryInFlight = true;
    try {
        const { map, failed } = await fetchRoomCreds(confirmedTournIds);
        _roomCredsFailed = failed;
        // আংশিক সফল হলেও যা পাওয়া গেছে merge করো — যে কার্ডের room এলো
        // সেটা দেখাবে, বাকিগুলোতে Retry বোতাম থাকবে।
        cached.list.forEach(m => {
            if (map[m.team.tournamentId]) {
                m.tournament.roomSettings = {
                    ...(m.tournament.roomSettings || {}),
                    ...map[m.team.tournamentId]
                };
            }
        });
        renderMatchCards(cached.list, state.matchFilter || 'all');
        if (failed) showToast('Room তথ্য লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error');
    } finally {
        _roomRetryInFlight = false;
    }
}

export async function loadMatches() {
    const container = document.getElementById('matches-list');
    if (!container) return;
    showSkeleton('matches-list');
    const myToken = ++_matchLoadToken;
    _cachedMatches = null;
    _roomCredsFailed = false;
    const uid = state.currentUser?.uid;
    if (!uid) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><!-- UNSLOP (pass 3): gamepad emoji -> line-icon. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg></div>
                <div class="empty-title">Sign In Required</div>
                <div class="empty-sub">Log in to view your joined matches and room slots</div>
                <button class="btn btn-primary" style="margin-top:14px;" onclick="window.goToLogin()">লগইন করো</button>
            </div>`;
        return;
    }
    try {
        // 1. Fetch all teams where user is captain OR a teammate.
        // FIX (2026-11-19, A4): teammate lookup by Firebase UID —
        // tournamentTeams doc shape (verified in join-tournament.js:594-599,
        // payment.service.js:389-390, team.service.js:96-107):
        //   captainUserId = captain's Firebase UID
        //   players[] = [{ userId, playerName, ffUID }] — captain's userId-ই
        //   Firebase UID, teammate-দের userId '' (খালি); v8.8-র কোনো team
        //   doc-এ playerUids / memberUids array নেই, আর পুরনো FF UID-ও
        //   কোথাও save থাকে না। তাই existing doc-এ teammate-কে Firebase UID
        //   দিয়ে খোঁজার কোনো field-ই নেই (players[] array-of-objects-এর
        //   ভেতরে একটা field দিয়ে Firestore query করা যায় না)।
        //   → captain: UID query (আগের মতোই, FF UID বদলালেও ভাঙে না)।
        //   → member: নতুন playerUids array-contains UID query — এটা শুধু
        //     Firebase UID-এর ওপর চলে, myFFUID ছোঁয়ই না, তাই FF UID
        //     বদলালেও কাজ করবে — তবে শুধু সেই team doc-এই যেখানে join flow
        //     playerUids লিখেছে (join flow-র ওই লেখাটা এই Matches-only
        //     fix-এর বাইরে; README-BN দেখো)।
        //   → FF-UID array-contains থাকল teammate fallback হিসেবে — সব
        //     existing doc-এর জন্য এটাই একমাত্র teammate lookup। তিনটি
        //     query-ই আলাদা; একটা fail করলে captain-এর list ভাঙে না।
        const myTeams = [];
        const seenTeamIds = new Set();
        const addTeam = d => {
            if (seenTeamIds.has(d.id)) return;
            seenTeamIds.add(d.id);
            myTeams.push({
                id: d.id,
                ...d.data()
            });
        };
        const myFFUID = String(state.userData?.ffUID ?? '').trim();
        // FIX (2026-10-25, F-02): team query-তে orderBy createdAt desc +
        // limit(200) — veteran user-এর unbounded read বন্ধ; composite index
        // না থাকলে failed-precondition-এ plain query-তে fallback।
        const fetchTeams = async (qOrdered, qPlain) => {
            try { return await getDocs(qOrdered); }
            catch (e) { if (e?.code !== 'failed-precondition') throw e; return await getDocs(qPlain); }
        };
        const teamQueries = [
            // FIX (2026-11-20, S-M1): captain query-তেও .catch — বাকি দুটোর
            // মতোই। একটা query fail করলে পুরো list মরত; এখন শুধু ওই
            // query-টা null ফেরে, teammate query-র list অক্ষত থাকে।
            fetchTeams(
                query(collection(db, 'tournamentTeams'), where('captainUserId', '==', uid), orderBy('createdAt', 'desc'), limit(200)),
                query(collection(db, 'tournamentTeams'), where('captainUserId', '==', uid))
            ).catch(e => {
                console.warn('[Matches] captain lookup failed:', e.message);
                return null;
            }),
            // FIX (2026-11-19, A4): UID-based member query — myFFUID-এর ওপর
            // নির্ভর করে না, তাই FF UID বদলালেও চলে। পুরনো doc-এ field-টা
            // নেই বলে খালি ফেরে; fail করলে catch-এ ধরা পড়ে, captain list
            // অক্ষত থাকে।
            fetchTeams(
                query(collection(db, 'tournamentTeams'), where('playerUids', 'array-contains', uid), orderBy('createdAt', 'desc'), limit(200)),
                query(collection(db, 'tournamentTeams'), where('playerUids', 'array-contains', uid))
            ).catch(e => {
                console.warn('[Matches] playerUids lookup failed:', e.message);
                return null;
            })
        ];
        if (myFFUID) {
            teamQueries.push(
                fetchTeams(
                    query(collection(db, 'tournamentTeams'), where('playerFFUIDs', 'array-contains', myFFUID), orderBy('createdAt', 'desc'), limit(200)),
                    query(collection(db, 'tournamentTeams'), where('playerFFUIDs', 'array-contains', myFFUID))
                ).catch(e => {
                    // teammate lookup must never break the captain's own list
                    console.warn('[Matches] teammate lookup failed:', e.message);
                    return null;
                })
            );
        }
        const teamSnaps = await Promise.all(teamQueries);
        if (myToken !== _matchLoadToken) return;
        teamSnaps.forEach(snap => snap && snap.forEach(addTeam));
        // FIX (2026-11-19, A5): legacy joinRequests fallback আর শুধু
        // myTeams খালি থাকলে নয় — সবসময় merge হবে। একই team দুইবার
        // দেখাবে না: dedupe key teamId + tournamentId।
        const teamKey = tm => `${tm.teamId || tm.id || ''}|${tm.tournamentId || ''}`;
        const seenTeamKeys = new Set(myTeams.map(teamKey));
        try {
            const reqSnap = await getDocs(query(collection(db, 'joinRequests'), where('userId', '==', uid), limit(200)));
            reqSnap.forEach(d => {
                const dat = d.data();
                const legacyTeam = {
                    id: dat.teamId || d.id,
                    teamId: dat.teamId || ('TEAM-' + d.id.slice(0, 6).toUpperCase()),
                    teamName: dat.teamName || dat.userName || 'Solo Team',
                    tournamentId: dat.tournamentId,
                    tournamentName: dat.tournamentName,
                    teamFormat: 'SOLO',
                    captainUserId: dat.userId,
                    status: dat.status || 'confirmed',
                    paymentStatus: dat.status === 'confirmed' ? 'approved' : 'pending',
                    locked: true,
                    roomSlot: dat.roomSlot || null,
                    players: [{
                        userId: dat.userId,
                        playerName: dat.userName,
                        ffUID: dat.ffUID
                    }]
                };
                const key = teamKey(legacyTeam);
                if (seenTeamKeys.has(key)) return;
                seenTeamKeys.add(key);
                myTeams.push(legacyTeam);
            });
        } catch (e) {
            console.warn('[Matches] legacy joinRequests lookup failed:', e?.message);
        }
        if (myTeams.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon"><!-- UNSLOP (pass 3): gamepad emoji -> line-icon. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg></div>
                    <div class="empty-title">No Matches Yet</div>
                    <div class="empty-sub">Join an upcoming tournament to see your team and room details here</div>
                </div>`;
            return;
        }
        // 2. Fetch corresponding tournament docs in batch chunks of 30
        const tournIds = [...new Set(myTeams.map(t => t.tournamentId).filter(Boolean))];
        const tournamentMap = {};
        if (tournIds.length > 0) {
            const chunks = [];
            for (let i = 0; i < tournIds.length; i += 30) {
                chunks.push(tournIds.slice(i, i + 30));
            }
            await Promise.all(chunks.map(async chunk => {
                try {
                    const bSnap = await getDocs(query(collection(db, 'tournaments'), where(documentId(), 'in', chunk)));
                    bSnap.forEach(d => {
                        tournamentMap[d.id] = normalizeTournament(d.data(), d.id);
                    });
                } catch (e) {
                    await Promise.all(chunk.map(async tid => {
                        try {
                            const s = await getDoc(doc(db, 'tournaments', tid));
                            if (s.exists()) tournamentMap[s.id] = normalizeTournament(s.data(), s.id);
                        } catch (err) {}
                    }));
                }
            }));
        }
        // 3. Securely batch-fetch Room Credentials for CONFIRMED teams only.
        // (Previously did one getDoc per confirmed team inside the loop — N+1.
        //  Now collects the ids first and reads them in chunked 'in' queries,
        //  same pattern already used above for tournaments.)
        // FIX (2026-11-19, A3): fetch-টা fetchRoomCreds helper-এ গেল — fail
        // করলে failed=true ফেরে, আর Retry বোতাম (retryRoomLoad) শুধু room
        // fetch-টাই আবার চালায়; পুরো list মুছে error state হয় না।
        const confirmedTournIds = [...new Set(
            myTeams
                .filter(tm => tm.status === 'confirmed' || tm.status === 'approved')
                .map(tm => tm.tournamentId)
                .filter(Boolean)
        )];
        const { map: roomCredMap, failed: roomFailed } = await fetchRoomCreds(confirmedTournIds);
        _roomCredsFailed = roomFailed;

        // 4. Combine matches with tournaments (room data reused from the batch above)
        // FIX: when the admin deletes a tournament its doc no longer exists —
        // drop that team instead of rendering a fake fallback card, so deleted
        // tournaments disappear from Matches.
        // FIX (2026-11-19, A6): কার্ড লুকানোই থাকল, কিন্তু কতগুলো team এভাবে
        // বাদ গেল গুনে রাখা হলো — renderMatchCards list-এর ওপরে একটা ছোট
        // banner দেখাবে।
        let matchList = [];
        let deletedTournamentCount = 0;
        myTeams.forEach(tm => {
            const tourn = tm.tournamentId ? tournamentMap[tm.tournamentId] : null;
            if (tm.tournamentId && !tourn) { deletedTournamentCount++; return; } // deleted by admin → hide
            const t = tourn || {
                id: tm.tournamentId,
                name: tm.tournamentName || 'Tournament',
                status: 'upcoming',
                gameMode: tm.teamFormat || 'BR Ranked',
                map: 'Bermuda',
                roomSettings: {}
            };
            if ((tm.status === 'confirmed' || tm.status === 'approved') && tm.tournamentId) {
                if (roomCredMap[tm.tournamentId]) {
                    t.roomSettings = {
                        ...t.roomSettings,
                        ...roomCredMap[tm.tournamentId]
                    };
                } else {
                    // FIX (2026-10-25, F9): creds না পাওয়া গেলে (denied বা
                    // missing — chunk query-তে আলাদা করা যায় না) tournament
                    // doc-এর পুরনো room field render করা যাবে না। Fail closed।
                    // Legacy published doc-এর room দেখতে admin-কে re-publish
                    // করতে হবে (তখন সঠিক roomCredentials লেখা হবে)।
                    t.roomSettings = {};
                }
            }
            matchList.push({ team: tm, tournament: t });
        });
        if (myToken !== _matchLoadToken) return;
        // 5. Cache the unfiltered list for filter taps, then render.
        _cachedMatches = { uid, list: matchList, deletedCount: deletedTournamentCount };
        renderMatchCards(matchList, state.matchFilter || 'all');
    } catch (err) {
        // FIX (2026-11-20, S8): top-level load fail-এ Retry (Leaderboard
        // pattern) — পুরো page reload নয়, শুধু matches আবার load।
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><!-- UNSLOP (pass 3): warning emoji -> line-icon alert. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
                <div class="empty-title">Failed to load matches</div>
                <div class="empty-sub">${escHtml(err.message)}</div>
                <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryMatchesLoad()">আবার চেষ্টা করো</button>
            </div>`;
    }
}

// FIX (2026-11-20, S8): load-fail Retry।
window.retryMatchesLoad = () => { loadMatches(); };
// FIX (2026-11-20, S-M2): "Sign In Required" dead-end নয় — Login CTA।
window.goToLogin = () => goTo('login');

// FIX (2026-10-25, F-02): filter + render আলাদা function-এ — filter tap-এ
// loadMatches না চালিয়ে cache করা list থেকেই render হবে।
function renderMatchCards(list, filter) {
    const container = document.getElementById('matches-list');
    if (!container) return;
    // FIX (2026-11-19, A6): deleted-tournament banner — একটাই, list-এর
    // ওপরে। Cache থেকে filter tap-এও থাকে (deletedCount cache-এ ধরা)।
    const deletedCount = (_cachedMatches && _cachedMatches.deletedCount) || 0;
    const deletedBannerText = deletedCount === 1
        ? 'একটি টুর্নামেন্ট admin মুছে দিয়েছে — তার team এখানে আর দেখাবে না।'
        : deletedCount + 'টি টুর্নামেন্ট admin মুছে দিয়েছে — সেগুলোর team এখানে আর দেখাবে না।';
    const deletedBannerHtml = deletedCount > 0
        ? `<div class="deleted-notice">${deletedBannerText}</div>`
        : '';
    let filtered = list;
    if (filter === 'active') {
        filtered = list.filter(m => m.tournament.status === 'upcoming' || m.tournament.status === 'ongoing');
    } else if (filter === 'completed') {
        filtered = list.filter(m => m.tournament.status === 'completed');
    }
    if (filtered.length === 0) {
        container.innerHTML = deletedBannerHtml + `
            <div class="empty-state">
                <div class="empty-icon"><!-- UNSLOP (pass 3): gamepad emoji -> line-icon. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg></div>
                <div class="empty-title">No ${escHtml(filter.charAt(0).toUpperCase() + filter.slice(1))} matches</div>
                <div class="empty-sub">Check back later or try another filter</div>
            </div>`;
        return;
    }
    // Render match cards — batched into one DocumentFragment so the
    // browser does a single reflow/repaint instead of one per card.
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    if (deletedBannerHtml) {
        const bannerWrap = document.createElement('div');
        bannerWrap.innerHTML = deletedBannerHtml;
        frag.appendChild(bannerWrap.firstChild);
    }
    filtered.forEach((m, idx) => {
        const card = buildMatchCard(m);
        // FIX (2026-10-25, F-12): stagger cap — 100 match-এ 5s tail নয়,
        // প্রথম 10 কার্ডের পর আর delay বাড়বে না।
        card.style.animationDelay = (Math.min(idx, 10) * 0.05) + 's';
        frag.appendChild(card);
    });
    container.appendChild(frag);
}

// ════════════════════════════════════════════════════════════════
// BUILD MATCH CARD (TEAM DETAILS, LOCK STATUS & ROOM CREDENTIALS)
// ════════════════════════════════════════════════════════════════
function buildMatchCard(m) {
    const {
        team: tm,
        tournament: t
    } = m;
    const isConfirmed = tm.status === 'confirmed' || tm.status === 'approved';
    const isPending = tm.status === 'pending';
    const isExpired = tm.status === 'expired';
    // FIX (2026-11-11, M8): cancelled টুর্নামেন্ট আলাদা করে ধরতে হবে —
    // নইলে "Confirmed — room আসছে" দেখাত।
    const isCancelled = (t.status || '') === 'cancelled';
    const isLocked = tm.locked === true;
    // Room settings & publication state
    const roomSettings = t.roomSettings || {};
    const isRoomPublished = roomSettings.isPublished === true;
    const assignedSlot = tm.roomSlot || (roomSettings.slotAssignments && roomSettings.slotAssignments[tm.id]) || null;
    // FIX (2026-11-06, TDZ bug): myUid/isCaptain MUST be declared here, BEFORE the
    // noteHtml block below — the confirmed-but-room-not-published note used !isCaptain.
    // FIX (2026-11-13, room-teammates): that note line is now removed (room shows for
    // teammates too); the declaration stays here — the role banner below still needs it.
    // They were declared after that block, so a confirmed team with no room published
    // threw ReferenceError and the whole matches list failed to render. No logic change.
    const myUid = state.currentUser?.uid;
    const isCaptain = tm.captainUserId === myUid;

    // Status badge (top-right, first pill)
    const statusBadge = isCancelled
        ? `<div class="badge rejected">Cancelled</div>`
        : isConfirmed
        ? `<div class="badge confirmed">Confirmed</div>`
        : isPending
            ? `<div class="badge pending">Pending</div>`
            : isExpired
                ? `<div class="badge expired">Expired</div>`
                : `<div class="badge rejected">Rejected</div>`;
    // FIX (2026-11-19, v8.9-2): Locked badge পুরো তোলা হলো — status
    // (Confirmed/Pending) দিয়েই বোঝা যায়; lock ভেতরের ব্যাপার।
    // isLocked শুধু নিচের Edit Name শর্তে লাগে বলে const টা থাকে।

    // Note box (room info / status explanation)
    let noteHtml = '';
    if (isCancelled) {
        // FIX (2026-11-11, M8): cancelled টুর্নামেন্টে room note লুকিয়ে
        // cancel banner দেখাও — player যাতে ম্যাচ খেলতে না যায়।
        // FIX (2026-11-19, A2): cancelled-এ room note লুকিয়ে cancel banner
        // দেখাও — টাকা manual ফেরতের কথাটা পরিষ্কার করা হলো।
        noteHtml = `
            <div class="note reject">
                এই টুর্নামেন্টটি বাতিল (Cancelled) হয়েছে। Room ID/পাসওয়ার্ড আর আসবে না — টাকা admin manually তোমার wallet-এ ফেরত দেবে।
            </div>`;
    } else if (isConfirmed) {
        if (isRoomPublished && roomSettings.roomId) {
            noteHtml = `
                <div class="note ready">
                    <div class="room-row" style="margin-bottom:8px;">
                        <span class="room-label">Room Published</span>
                        <span class="slot">Slot: ${assignedSlot ? escHtml(assignedSlot) : 'Assigned in-game'}</span>
                    </div>
                    <div class="room-row">
                        <span class="room-label">Room ID</span>
                        <span class="room-val">${escHtml(roomSettings.roomId)} <button class="copy-btn" data-copy="${escHtml(roomSettings.roomId)}" onclick="copyText(this.dataset.copy,'Room ID')">Copy</button></span>
                    </div>
                    <div class="room-row">
                        <span class="room-label">Password</span>
                        <span class="room-val">${escHtml(roomSettings.password || roomSettings.roomPassword || 'No Password')} <button class="copy-btn" data-copy="${escHtml(roomSettings.password || roomSettings.roomPassword || '')}" onclick="copyText(this.dataset.copy,'Password')">Copy</button></span>
                    </div>
                </div>`;
        } else {
            // FIX (2026-11-19, v8.9-2): slot banner-এ থাকে, note-এ
            // আর "Your Slot" লেখা হয় না — একই তথ্য দুইবার নয়।
            noteHtml = `
                <div class="note wait">
                    <div class="room-title">Room ID ও পাসওয়ার্ড</div>
                    <div class="room-sub">Admin publish করলে এখানে দেখা যাবে</div>
                    ${_roomCredsFailed ? `<div class="room-load-failed">Room তথ্য লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো।</div><button class="btn primary retry-btn" onclick="retryRoomLoad()">আবার চেষ্টা করো</button>` : ''}
                </div>`;
        }
    } else if (isPending) {
        // FIX (flow change): no payment deadline / no auto-expiry anymore. A paid
        // join request stays pending until the admin accepts or rejects it.
        noteHtml = `
            <div class="note wait">
                তোমার পেমেন্টসহ জয়েন রিকোয়েস্ট অ্যাডমিনের কাছে পেন্ডিং আছে। অ্যাডমিন একসেপ্ট করলেই টিম কনফার্ম হবে ও রুম তথ্য আনলক হবে।
            </div>`;
    } else if (isExpired) {
        // FIX (2026-11-11, L14): payment-deadline note শুধু legacy pending
        // team-এর জন্য — instant join-এ কোনো payment deadline নেই।
        const isLegacyPending = (tm.paymentStatus || '') !== 'approved';
        noteHtml = isLegacyPending ? `
            <div class="note reject">
                এই জয়েন রিকোয়েস্টের পেমেন্ট সময় শেষ হয়ে গেছে। আবার join করতে চাইলে নতুন করে join করো।
            </div>` : `
            <div class="note reject">
                এই জয়েন রিকোয়েস্টের সময় শেষ হয়ে গেছে। আবার join করতে চাইলে নতুন করে join করো।
            </div>`;
    } else {
        noteHtml = `
            <div class="note reject">
                দুঃখিত, আপনার জয়েন রিকোয়েস্ট/পেমেন্ট অ্যাডমিন কর্তৃক রিজেক্ট করা হয়েছে।
            </div>`;
    }

    // REDESIGN (2026-11-20, Wallet & Matches reference): 3-column info
    // strip (Role / Slot / Team) + player pills. Template-only change —
    // same data, same handlers, no logic change. Role/Slot/Team আগেও এই
    // ফাংশনেই ছিল (roleBanner + teamLine), শুধু markup বদলেছে।
    // FIX (2026-11-13, room-teammates): Room ID/password teammate-রাও
    // দেখতে পায় — admin publish-এ participantUids-এ confirmed roster-এর
    // সব Firebase UID থাকে, rules-এ uid in participantUids পড়তে পারে।
    // Captain pill = সেই player যার userId tm.captainUserId-র সঙ্গে মেলে
    // (players[] = [{ userId, playerName, ffUID }]); legacy team-এ userId
    // খালি থাকলে crown দেওয়া হয় না — captain আন্দাজ করা হয় না।
    const slotCell = assignedSlot ? `#${escHtml(assignedSlot)}` : '—';
    const infoStrip = `
        <div class="info">
            <div><span>Role</span>${isCaptain ? 'Captain' : 'Teammate'}</div>
            <div><span>Slot</span>${slotCell}</div>
            <div><span>Team</span>${escHtml(tm.teamName || 'Team')}</div>
        </div>`;
    const crownSvg = `<svg viewBox="0 0 24 24"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>`;
    const playerPills = (tm.players || []).map((p) => {
        const name = p.playerName || 'Player';
        const isCap = !!p.userId && p.userId === tm.captainUserId;
        const initial = escHtml((name.trim().charAt(0) || 'P').toUpperCase());
        return `<span class="p${isCap ? ' cap' : ''}"><i>${isCap ? crownSvg : initial}</i>${escHtml(name)}${isCap ? '<em>Captain</em>' : ''}</span>`;
    }).join('');
    const playersBlock = playerPills
        ? `<div class="sec">Players</div><div class="team">${playerPills}</div>`
        : '';

    const card = document.createElement('div');
    card.className = 'match-card';
    card.innerHTML = `
        <div class="m-top">
            <div>
                <div class="m-title">${escHtml(t.name)}</div>
                <div class="m-sub">${escHtml(t.gameMode)} · ${escHtml(t.dateLabel || (t.dateObj ? formatDateOnly(t.dateObj) : ''))} ${escHtml(t.timeLabel || (t.dateObj ? formatTimeOnly(t.dateObj) : ''))}</div>
            </div>
            <div class="badges">
                ${statusBadge}
            </div>
        </div>
        ${infoStrip}
        ${playersBlock}
        ${noteHtml}
        <div class="btn-row">
            <button class="btn ghost" data-id="${escHtml(t.id)}" onclick="openTournDetail(this.dataset.id)">View Details</button>
            ${isPending && tm.paymentStatus === 'unpaid' && t.entryFee > 0 && tm.captainUserId === state.currentUser?.uid ? `
                <button class="btn primary" data-tid="${escHtml(t.id)}" data-team="${escHtml(tm.teamId)}" onclick="resumeTeamPayment(this.dataset.tid, this.dataset.team)">Pay / Submit UTR</button>
            ` : ''}
            ${!isLocked && tm.captainUserId === state.currentUser?.uid ? `
                <button class="btn ghost" data-team-id="${escHtml(tm.teamId)}" data-team-name="${escHtml(tm.teamName || '')}" onclick="promptEditTeamName(this.dataset.teamId, this.dataset.teamName)">Edit Name</button>
            ` : ''}
            ${t.status === 'completed' ? `
                <button class="btn primary" data-id="${escHtml(t.id)}" onclick="openTournamentResults(this.dataset.id)">View Results</button>
            ` : ''}
        </div>
    `;
    return card;
}

// ════════════════════════════════════════════════════════════════
// SYNCHRONIZED TEAM EDIT & LOCK RESTRICTION
// ════════════════════════════════════════════════════════════════
export async function promptEditTeamName(teamId, currentName) {
    const rawName = await showPrompt('Edit Team Name', 'Allowed only before match lock (max 25 characters).', {
        value: currentName || '',
        placeholder: 'Team name',
        maxLength: 25
    });
    if (!rawName || rawName === currentName) return;
    const newName = rawName;
    if (newName.length > 25) {
        showToast('টিমের নাম ২৫ অক্ষরের বেশি হতে পারবে না', 'warning');
        return;
    }
    try {
        const teamRef = doc(db, 'tournamentTeams', teamId);
        const teamSnap = await getDoc(teamRef);
        if (!teamSnap.exists()) {
            showToast('টিম পাওয়া যায়নি', 'error');
            return;
        }
        const teamData = teamSnap.data();
        // ১. শুধুমাত্র ক্যাপ্টেনই নাম এডিট করতে পারবে
        if (teamData.captainUserId !== state.currentUser?.uid) {
            showToast('শুধু টিমের captain-ই নাম বদলাতে পারবে', 'error');
            return;
        }
        // ২. টিম লক করা থাকলে কোনো এডিট চলবে না
        if (teamData.locked === true) {
            showToast('বদলানো যাবে না — admin তোমার টিম lock করে দিয়েছে!', 'error', 4500);
            return;
        }
        // ৩. টুর্নামেন্ট যদি শুরু (ongoing) বা শেষ (completed) হয়ে গিয়ে থাকে তবে এডিট বন্ধ
        if (teamData.tournamentId) {
            const tournSnap = await getDoc(doc(db, 'tournaments', teamData.tournamentId));
            if (tournSnap.exists()) {
                const tStatus = tournSnap.data().status;
                if (tStatus !== 'upcoming') {
                    showToast(`টিম বদলানো যাবে না — টুর্নামেন্ট ইতিমধ্যে ${({upcoming:'শুরু হয়নি',ongoing:'চলছে',completed:'শেষ হয়ে গেছে'}[tStatus] || tStatus)}!`, 'error', 4500);
                    return;
                }
            }
        }
        // ৪. টিমের নাম আপডেট করা
        await updateDoc(teamRef, {
            teamName: newName,
            updatedAt: serverTimestamp()
        });
        // v6: paymentRequests name-sync removed — that collection is admin-only
        // write, so the sync could never succeed (it failed silently in catch).
        // The admin panel reads the team name from the team doc itself.
        showToast('টিমের নাম সফলভাবে বদলানো হয়েছে!', 'success');
        loadMatches();
    } catch (e) {
        showToast('টিমের নাম বদলানো যায়নি: ' + friendlyErrorMessage(e), 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// Buttons that open other pages (multi-page navigation)
// ════════════════════════════════════════════════════════════════
window.setMatchFilter = setMatchFilter;
window.retryRoomLoad = retryRoomLoad;
window.promptEditTeamName = promptEditTeamName;
// (openTournDetail / openTournamentResults now centralized in navigation.js)
// Unpaid team → payment page (payment page loads tournament + team by id)
window.resumeTeamPayment = (tournId, teamId) => goTo('payment', { id: tournId, team: teamId });

initPage({
    page: 'matches',
    tab: 'matches',
    onReady: () => {
        loadMatches();
    }
});

// SLOT-UPDATE (2026-11-20): bfcache restore — Details/payment পেজ থেকে
// back এলে Matches memory থেকে ফিরত, script আর চলত না। Persisted
// restore-এ list fresh করে নাও (Home/Tournaments/Details-এর মতোই)।
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    loadMatches().catch(() => {});
});
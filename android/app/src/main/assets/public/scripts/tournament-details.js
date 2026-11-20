import { initPage } from './app.js';
import { state } from './state.js';
import { showToast } from './toast.js';
// v8.6 (G): বাকি English toast-গুলোও সহজ পেশাদার বাংলায় করা হয়েছে — details-র toast বাংলায়
import { db, doc, getDoc, getDocs, collection, query, where, limit, onSnapshot } from '../firebase/firebase-init.js';
import { goBack, goTo, getParam } from '../config/app-config.js';
import { formatDate, formatDateOnly, formatTimeOnly } from '../utils/formatters.js';
import { mountComponent } from '../utils/dom-helpers.js';
import { normalizeTournament, getTournamentCapacity } from '../services/tournaments.service.js';

// ════════════════════════════════════════════════════════════════
// XSS PROTECTION: Firestore থেকে আসা যেকোনো string innerHTML এ বসানোর আগে escape করতে হবে।
// (`??` ব্যবহার করা হয়েছে যাতে 0 মানটা খালি string না হয়ে যায়, যেমন prizePool = 0)
// NOTE: inline onclick="fn('${...}')" এর ভেতরে এটা যথেষ্ট নয় — ওখানে data-* attribute ব্যবহার করো।
// ════════════════════════════════════════════════════════════════
import { escHtml } from '../utils/escape.js';

// FIX (2026-10-25, F7): এক captain-এর এক tournament-এ একাধিক team doc
// থাকলে (reject-এর পর rejoin) live টিমটাই দেখাতে হবে। confirmed →
// pending → rejected/expired, তারপর newest first। orderBy দেওয়া হয়নি
// যাতে composite index না থাকলেও query fail না করে।
function pickLiveTeam(docs) {
    const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v ? new Date(v).getTime() : 0);
    const rank = s => (s === 'confirmed' ? 0 : (s === 'pending' ? 1 : 2));
    const list = docs.map(d => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (rank(a.status) - rank(b.status)) || (ms(b.createdAt) - ms(a.createdAt)));
    return list[0] || null;
}

// ════════════════════════════════════════════════════════════════
// REALTIME STATUS (Paid tournaments only): Pending → Confirmed/Rejected
// Listens on the existing deterministic captain-lock doc
// (tournamentCaptains/{tournamentId}_{uid}) so the User Panel updates
// instantly after Admin Confirm/Reject — no manual page refresh needed.
// Free tournaments stay untouched (already auto-confirmed on join).
// ════════════════════════════════════════════════════════════════
let _myStatusUnsub = null;
let _myStatusSeen = false;
let _lastKnownStatus = null;
let _myStatusArgs = null;   // remembered so the listener can be re-attached after a bfcache restore

function unsubscribeMyStatus() {
    if (_myStatusUnsub) {
        _myStatusUnsub();
        _myStatusUnsub = null;
    }
    _myStatusSeen = false;
    _lastKnownStatus = null;
}

function subscribeToMyStatus(tournamentId, uid) {
    // Avoid stacking multiple listeners if details are (re)loaded
    unsubscribeMyStatus();
    _myStatusArgs = { tournamentId, uid };
    const lockRef = doc(db, 'tournamentCaptains', `${tournamentId}_${uid}`);
    _myStatusUnsub = onSnapshot(lockRef, (snap) => {
        if (!snap.exists()) return;
        const status = snap.data().status;
        if (!_myStatusSeen) {
            // First snapshot just reflects what we already rendered on load
            _myStatusSeen = true;
            _lastKnownStatus = status;
            return;
        }
        if (status === _lastKnownStatus) return;
        _lastKnownStatus = status;
        if (status === 'confirmed') {
            showToast('আপনার রিকোয়েস্ট Confirmed হয়েছে!', 'success', 4500);
        } else if (status === 'rejected') {
            showToast('আপনার রিকোয়েস্ট Rejected হয়েছে। প্রয়োজনে আবার Join করুন।', 'error', 4500);
        }
        // Re-render with fresh authoritative data (room creds, participants,
        // join/pay buttons) — same render path as a normal load.
        loadTournamentDetail(tournamentId);
    }, (err) => {
        console.warn('[Realtime status] listener error:', err.message);
    });
}

// Stop listening when the user actually leaves this page
window.addEventListener('pagehide', unsubscribeMyStatus);

// SLOT-UPDATE (2026-11-20): FREE join success আর page reload করে না —
// join-tournament.js 'ff:joined-tournament' event dispatch করে; এখানে
// detail in-place re-load হয় (fresh tournament doc + myTeam + room
// creds — filled count, Join/Confirmed বাটন, slot একই পেজে আপডেট
// হবে)। preventDefault() দিয়ে dispatcher-কে জানানো হয় event ধরা
// হয়েছে, যাতে reload fallback না চলে। Participant list-ও reset করা
// হয় — নইলে join-এর আগের রাখা list-এ নতুন team থাকত না।
document.addEventListener('ff:joined-tournament', (e) => {
    const id = (e && e.detail && e.detail.tournamentId) || state.currentDetailId;
    if (!id) return;
    e.preventDefault();
    state.detailParticipantsLoaded = false;
    state.currentDetailTeams = [];
    loadTournamentDetail(id);
});

// Back/forward cache: the page is restored from memory (scripts do NOT re-run), so the
// listener detached on pagehide must be attached again here.
// SLOT-UPDATE (2026-11-20): bfcache restore-এ শুধু listener ফেরানো
// যথেষ্ট নয় — page-টা join-এর আগের snapshot (পুরনো filled count,
// Join বাটন, room section) নিয়ে ফেরে। তাই persisted restore-এ পুরো
// detail fresh re-load করা হয় — payment page থেকে back এলে (PAID
// join) বা list থেকে back এলে এটাই slot-কে আপডেট দেখায়।
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const id = state.currentDetailId || (_myStatusArgs && _myStatusArgs.tournamentId);
    if (id) {
        state.detailParticipantsLoaded = false;
        state.currentDetailTeams = [];
        loadTournamentDetail(id);
        return;
    }
    if (_myStatusArgs && !_myStatusUnsub) {
        subscribeToMyStatus(_myStatusArgs.tournamentId, _myStatusArgs.uid);
    }
});

// ════════════════════════════════════════════════════════════════
// TOURNAMENT DETAILS (page: tournament-details.html?id=<tournamentId>[&join=1])
// ════════════════════════════════════════════════════════════════
// FIX (2026-10-25, F-06): request token — my-status listener-এর
// re-render আর হাতের load race করলে stale (আগের) load-এর render যাতে
// নতুনটাকে overwrite না করে।
let _detailLoadToken = 0;
async function loadTournamentDetail(id) {
    const myDetailToken = ++_detailLoadToken;
    const modalTitle = document.getElementById('detail-modal-title');
    const modalContent = document.getElementById('detail-modal-content');
    if (modalTitle) modalTitle.textContent = 'Loading...';
    if (modalContent) modalContent.innerHTML = `
        <div style="padding:60px 20px; text-align:center;">
            <div class="spinner" style="margin:0 auto 12px; width:36px; height:36px;"></div>
            <div style="font-size:13px; color:var(--text2);">Loading tournament details...</div>
        </div>`;
    if (!id) {
        showToast('টুর্নামেন্ট পাওয়া যায়নি', 'error');
        goBack('tournaments');
        return;
    }
    try {
        const snap = await getDoc(doc(db, 'tournaments', id));
        if (!snap.exists()) {
            showToast('টুর্নামেন্ট পাওয়া যায়নি', 'error');
            goBack('tournaments');
            return;
        }
        const t = normalizeTournament(snap.data(), snap.id);
        if (modalTitle) modalTitle.textContent = t.name;
        const uid = state.currentUser?.uid;
        const cap = getTournamentCapacity(t);
        const isFree = t.entryType === 'FREE' || t.entryFee === 0;
        const myFfUID = state.userData?.ffUID;
        // v6.1: participant list is ON-DEMAND now (refresh button) — the old code
        // fetched EVERY team (up to ~48 reads) on each details view.
        // myTeam detection uses two cheap targeted queries instead (≤2 docs each).
        // Join state is unaffected: the join flow reads what it needs itself.
        let myTeam = null;
        try {
            const capSnap = await getDocs(query(
                collection(db, 'tournamentTeams'),
                where('tournamentId', '==', id),
                where('captainUserId', '==', uid)
            ));
            if (!capSnap.empty) {
                // FIX (2026-10-25, F7): docs[0] arbitrary ছিল — rejected
                // পুরনো টিম live pending-কে লুকিয়ে "Registration Rejected"
                // দেখাত। status priority + newest first-এ বেছে নেওয়া হলো।
                myTeam = pickLiveTeam(capSnap.docs);
            }
        } catch (e) {
            console.warn('[Details] my-team lookup failed:', e.message);
        }
        if (!myTeam && myFfUID) {
            try {
                const tmSnap = await getDocs(query(
                    collection(db, 'tournamentTeams'),
                    where('tournamentId', '==', id),
                    where('playerFFUIDs', 'array-contains', String(myFfUID).trim())
                ));
                if (!tmSnap.empty) {
                    // FIX (2026-10-25, F7): teammate lookup-এও limit(1)-এর
                    // arbitrary doc নয় — একই status priority।
                    myTeam = pickLiveTeam(tmSnap.docs);
                }
            } catch (e) { /* teammate lookup must never break the page */ }
        }
        // v6.1: keep an already-loaded participant list across re-renders of the
        // SAME tournament (e.g. lock-status change) — otherwise show the prompt.
        const keepList = state.detailParticipantsLoaded === true
            && state.currentDetailId === id
            && Array.isArray(state.currentDetailTeams)
            && state.currentDetailTeams.length > 0;
        if (!keepList) {
            state.currentDetailTeams = [];
            state.detailParticipantsLoaded = false;
        }
        state.currentDetailId = id;
        const isConfirmed = myTeam && (myTeam.status === 'confirmed' || myTeam.status === 'approved');
        const isPending = myTeam && myTeam.status === 'pending';
        // ── SECURITY FIX: Fetch Secure Room Credentials Only if Confirmed ──
        if (isConfirmed) {
            try {
                const roomSnap = await getDoc(doc(db, 'roomCredentials', id));
                if (roomSnap.exists()) {
                    t.roomSettings = {
                        ...t.roomSettings,
                        ...roomSnap.data()
                    };
                }
                // doc না থাকলে (legacy publish) tournament-doc-এর field
                // আগেই public — confirmed viewer-এর জন্য fallback থাকবে।
            } catch (e) {
                // FIX (2026-10-25, F9): permission-denied মানে বর্তমান
                // publish list-এ viewer নেই — tournament-doc-এর পুরনো room
                // field render করা যাবে না। Fail closed: clear।
                if (e?.code === 'permission-denied') {
                    t.roomSettings = {};
                }
                console.warn('[Security] Could not fetch room credentials:', e);
            }
        }
        // Cancellation Block (if cancelled) — FIX (2026-11-19, v8.9):
        // Cancelled মানেই cancelled; paid হলে
        // টাকা admin manually wallet-এ ফেরত দেবে।
        let cancellationHtml = '';
        if (t.status === 'cancelled') {
            cancellationHtml = `
                <div style="background: rgba(255, 69, 58, 0.1); border: 1px solid rgba(255, 69, 58, 0.3); border-radius: 12px; padding: 12px; margin-bottom: 16px;">
                    <div style="font-size: 15px; font-weight: 600; color: var(--error); margin-bottom: 6px;">Tournament Cancelled</div>
                    <div style="font-size: 13px; color: var(--text2); margin-bottom: 6px;">
                        <strong>Reason:</strong> ${escHtml(t.cancellationReason || 'Cancelled by admin due to technical reasons.')}
                    </div>
                    ${!isFree ? `<div style="font-size: 12px; color: var(--text2); font-weight: 600;">Paid টুর্নামেন্ট বাতিল হলে টাকা admin manually তোমার wallet-এ ফেরত দেবে।</div>` : ''}
                </div>`;
        }
        // Room Section (Strict eligibility check)
        let roomSectionHtml = '';
        const roomSettings = t.roomSettings || {};
        const isRoomPublished = roomSettings.isPublished === true;
        if (isConfirmed) {
            if (isRoomPublished && roomSettings.roomId) {
                const assignedSlot = myTeam.roomSlot || (roomSettings.slotAssignments && roomSettings.slotAssignments[myTeam.id]) || 'Not Assigned';
                roomSectionHtml = `
                    <div style="<!-- UNSLOP (pass 2): green wash removed — neutral surface, lime border only. Visibility still captain-only (isConfirmed gate above). -->background: var(--bg3); border: 1px solid rgba(199, 255, 62, 0.3); border-radius: 12px; padding: 12px; margin: 16px 0;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <div style="font-size: 15px; font-weight: 600; color: var(--success);">Room Details (Live)</div>
                            <span class="badge badge-ongoing">Published</span>
                        </div>
                        <div class="room-row" style="margin-bottom:8px;">
                            <span class="room-label">Room ID</span>
                            <span class="room-val">${escHtml(roomSettings.roomId)} <button class="copy-btn" data-copy="${escHtml(roomSettings.roomId)}" onclick="copyText(this.dataset.copy,'Room ID')">Copy</button></span>
                        </div>
                        <div class="room-row" style="margin-bottom:8px;">
                            <span class="room-label">Password</span>
                            <span class="room-val">${escHtml(roomSettings.password || roomSettings.roomPassword || 'No Password')} <button class="copy-btn" data-copy="${escHtml(roomSettings.password || roomSettings.roomPassword || '')}" onclick="copyText(this.dataset.copy,'Password')">Copy</button></span>
                        </div>
                        <div class="room-row">
                            <span class="room-label">Your Room Slot</span>
                            <span class="room-val" style="color:var(--accent); font-weight:600; font-size:15px;">Slot ${escHtml(assignedSlot)}</span>
                        </div>
                    </div>`;
            } else {
                roomSectionHtml = `
                    <div style="background: var(--bg3); border-radius: 12px; padding: 12px; margin: 16px 0; text-align: center;">
                        <div style="font-size: 13px; font-weight: 600; color: var(--warning);">Room Credentials</div>
                        <div style="font-size: 12px; color: var(--text2); margin-top: 4px;">Room ID ও পাসওয়ার্ড ম্যাচ শুরুর ১৫ মিনিট আগে এখানে দেখতে পাবেন।</div>
                    </div>`;
            }
        }
        // Dynamic Prize Distribution
        // FIX (2026-11-19, v8.11): admin-এর নতুন prize মডেল (Total Pool
        // + Per Kill + rank rows) — prizeRankRows থাকলে Rank # + Title +
        // ₹ দেখাবে; না থাকলে পুরনো prizeDistribution/legacy fallback
        // আগের মতোই চলবে। Per Kill লাইনও এই সেকশনে থাকবে। কিছুই না
        // থাকলে (FREE, pool 0) সেকশন পুরো লুকানো থাকবে — খালি বাক্স নয়।
        let prizeDistHtml = '';
        const rankRows = Array.isArray(t.prizeRankRows) ? t.prizeRankRows : [];
        const legacyDist = Array.isArray(t.prizeDistribution) ? t.prizeDistribution : [];
        const perKillAmt = Number(t.perKill) || 0;
        if (rankRows.length > 0 || legacyDist.length > 0 || perKillAmt > 0) {
            // UNSLOP (pass 3): medal emoji removed — plain rank numbers, gold amount carries the meaning.
            const rankLabel = (pos) => (pos <= 3 ? String(pos) : `#${escHtml(pos)}`);
            let rows = '';
            if (rankRows.length > 0) {
                rows = rankRows.map((r) => {
                    const pos = Number(r.rank) || 0;
                    const title = String(r.title || '').trim();
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding: 12px 16px; background: var(--bg3); border-radius: 10px; margin-bottom: 8px;">
                        <span style="font-size: 14px; font-weight: 600;">#${escHtml(pos)}${title ? ` · ${escHtml(title)}` : ''}</span>
                        <span style="font-size: 14px; font-weight: 600; color: var(--gold);">₹${Number(r.prize || 0).toLocaleString()}</span>
                    </div>`;
                }).join('');
            } else {
                rows = legacyDist.map((p, i) => {
                    const pos = p.rank || p.position || (i + 1);
                    const medal = rankLabel(pos);
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding: 12px 16px; background: var(--bg3); border-radius: 10px; margin-bottom: 8px;">
                        <span style="font-size: 14px; font-weight: 600;">${medal} ${pos > 3 ? 'Place' : ''}</span>
                        <span style="font-size: 14px; font-weight: 600; color: var(--gold);">₹${Number(p.amount || 0).toLocaleString()}</span>
                    </div>`;
                }).join('');
            }
            const perKillRow = perKillAmt > 0 ? `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding: 12px 16px; background: var(--bg3); border-radius: 10px; margin-bottom: 8px;">
                        <span style="font-size: 14px; font-weight: 600;">Per kill</span>
                        <span style="font-size: 14px; font-weight: 600; color: var(--gold);">₹${perKillAmt.toLocaleString()} / kill</span>
                    </div>` : '';
            prizeDistHtml = `
                <div style="margin: 18px 0;">
                    <div style="font-size: 16px; font-weight: 600; margin-bottom: 10px;">Prize Distribution</div>
                    ${rows}${perKillRow}
                </div>`;
        }
        // Rules Formatting (Preserve exact breaks)
        const rulesText = t.rules && t.rules.trim() ? t.rules : 'Rules not available.';
        // Join Action Button at the bottom
        let bottomActionHtml = '';
        let canJoin = false;
        if (t.status === 'cancelled') {
            bottomActionHtml = `<button class="btn btn-secondary" disabled style="color:var(--error);">Tournament Cancelled</button>`;
        } else if (t.status === 'completed') {
            bottomActionHtml = `<button class="btn btn-primary" data-id="${escHtml(t.id)}" onclick="openTournamentResults(this.dataset.id)">View Results & Leaderboard</button>`;
        } else if (myTeam) {
            if (isConfirmed) {
                bottomActionHtml = `<button class="btn btn-success" disabled>Team Confirmed</button>`;
            } else if (isPending) {
                bottomActionHtml = `<button class="btn" style="background:rgba(255,149,0,0.15); color:var(--warning); border:1px solid rgba(255,149,0,0.3);" disabled>Payment / Join Pending</button>`;
            } else {
                bottomActionHtml = `<button class="btn btn-danger" disabled>Registration Rejected</button>`;
            }
        } else if (cap.isFull) {
            bottomActionHtml = `<button class="btn btn-danger" disabled>Tournament Full</button>`;
        } else if (t.status === 'upcoming') {
            canJoin = true;
            bottomActionHtml = `<button class="btn-join-card" style="width:100%;" data-id="${escHtml(t.id)}" onclick="startTournamentJoin(this.dataset.id)">Join Tournament</button>`;
        }
// Build Main HTML
// Banner is optional.
// If admin did not upload an image, do not show
// any trophy placeholder or empty banner area.

const detailBannerHtml = t.bannerUrl
    ? `<img
        class="detail-banner"
        src="${escHtml(t.bannerUrl)}"
        alt="Banner"
        loading="eager"
        fetchpriority="high">`
    : '';

// FIX (2026-11-19, v8.9): তারিখ বদল হলে Edit করা
// dateTime-ই দেখাবে, dateObj সবসময় সঠিক start।
const displayDateObj = t.dateObj;

// FIX (2026-10-25, F-06): stale load-এর render এখানেই থামবে।
if (myDetailToken !== _detailLoadToken) return;

modalContent.innerHTML = `
    ${detailBannerHtml}
    <div class="detail-content">
                <!-- FINAL (2026-11-09): Details reorganised into clear premium
                     sections. Every field, gate, wording and button state is
                     exactly as before — only the structure changed. Title
                     also shows here (the page header already carries it). -->
                <div class="detail-title">${escHtml(t.name)}</div>
                <div class="detail-badges">
                    <span class="badge badge-mode">${escHtml(t.gameMode)}</span>
                    <!-- UNSLOP (pass 2): cyan inline badge removed — neutral badge-mode, as in Group 0 tournaments.js. --><span class="badge badge-mode">${escHtml(t.teamFormat)}</span>
                    <span class="badge badge-map">${escHtml(t.map)}</span>
                    <span class="badge badge-${escHtml(t.status)}">${escHtml(t.status.charAt(0).toUpperCase() + t.status.slice(1))}</span>
                    <span class="badge badge-${isFree ? 'free' : 'paid'}">${isFree ? 'FREE' : 'Entry: ₹' + escHtml(t.entryFee)}</span>
                </div>
                <!-- Prize hero — the prize figure is the moment (gold, solid). -->
                <section class="detail-section detail-prize-hero">
                    <div class="detail-section-title">Prize pool</div>
                    <div class="detail-prize-amount">₹${escHtml(t.prizePool)}</div>
                    <!-- FIX (2026-11-13, U1): admin BUILD 31 সব টুর্নামেন্টে prizeType:'manual' লেখে, তাই আগের prizeType গেটে "Per kill" লাইন কোনোদিনই দেখাত না। এখন perKill > 0 হলেই দেখাবে, prizeType যাই হোক। -->
                    ${Number(t.perKill) > 0 ? `<div class="detail-prize-kill">Per kill ₹${escHtml(t.perKill)}</div>` : ''}
                </section>
                ${t.prizeInstructions ? `<!-- FIX (2026-11-11, H3): admin-এর Prize Instructions এখানে দেখাবে। -->
                <section class="detail-section">
                    <div class="detail-section-title">Prize Instructions</div>
                    <div style="font-size:13px;color:var(--text2);white-space:pre-wrap;">${escHtml(t.prizeInstructions)}</div>
                </section>` : ''}
                <!-- Schedule -->
                <section class="detail-section">
                    <div class="detail-section-title">Schedule</div>
                    <div class="detail-grid">
                        <div class="detail-item"><div class="detail-item-label">Date</div><div class="detail-item-val">${escHtml(t.dateLabel || (displayDateObj ? formatDateOnly(displayDateObj) : '—'))}</div></div>
                        <div class="detail-item"><div class="detail-item-label">Time</div><div class="detail-item-val">${escHtml(t.timeLabel || (displayDateObj ? formatTimeOnly(displayDateObj) : '—'))}</div></div>
                    </div>
                </section>
                <!-- Format -->
                <section class="detail-section">
                    <div class="detail-section-title">Format</div>
                    <div class="detail-grid">
                        <div class="detail-item"><div class="detail-item-label">Mode</div><div class="detail-item-val">${escHtml(t.gameMode)}</div></div>
                        <div class="detail-item"><div class="detail-item-label">Format</div><div class="detail-item-val">${escHtml(t.teamFormat)}</div></div>
                        <div class="detail-item"><div class="detail-item-label">Map</div><div class="detail-item-val">${escHtml(t.map)}</div></div>
                        <div class="detail-item"><div class="detail-item-label">Capacity</div><div class="detail-item-val">${cap.label}</div></div>
                    </div>
                </section>
                ${cancellationHtml}
                ${roomSectionHtml}
                ${prizeDistHtml}
                <!-- Tournament Rules Section -->
                <section class="detail-section">
                    <div class="detail-section-title">Tournament Rules</div>
                    <div class="rules-list" style="white-space: pre-line; font-size: 13px; line-height: 1.6; color: var(--text2); background: var(--bg4); border-radius: 14px; padding: 14px;">${escHtml(rulesText)}</div>
                </section>
                <!-- Participants (components/participant-list.html) -->
                <div id="mount-participant-list"></div>
                <div style="margin-top: 24px;">
                    ${bottomActionHtml}
                </div>
            </div>`;
        await mountComponent('participant-list', '#mount-participant-list');
        // v6.1: participant list loads ONLY on refresh tap (see loadParticipants).
        // The count shown comes from the tournament counters (fresh, 0 extra reads).
        if (keepList) {
            renderParticipantsList(state.currentDetailTeams);
            const countEl = document.getElementById('participants-count');
            if (countEl) countEl.textContent = state.currentDetailTeams.length;
        } else {
            renderParticipantRefreshPrompt(t, cap);
        }

        // Live status for PAID tournaments only — FREE ones are already
        // instantly confirmed on join, so no pending state ever exists there.
        if (uid && !isFree) {
            subscribeToMyStatus(id, uid);
        } else {
            unsubscribeMyStatus();
            _myStatusArgs = null;
        }

        // Arrived from a card's "Join" button (?join=1) → open the join form
        if (getParam('join') === '1') {
            history.replaceState(null, '', window.location.pathname + '?id=' + encodeURIComponent(id));
            if (canJoin) window.startTournamentJoin(t.id);
        }
    } catch (err) {
        modalContent.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><!-- UNSLOP (pass 3): warning emoji -> line-icon alert. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
                <div class="empty-title">ডিটেইলস লোড হয়নি</div>
                <div class="empty-sub">${escHtml(err.message)}</div>
                <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryDetailLoad()">আবার চেষ্টা করো</button>
            </div>`;
    }
}


// FIX (2026-11-20, S8): load-failure-এ Retry — Leaderboard pattern।
window.retryDetailLoad = () => {
    const id = state.currentDetailId;
    if (id) loadTournamentDetail(id);
};

// ════════════════════════════════════════════════════════════════
// PARTICIPANT SEARCH & RENDER HELPERS (SOLO, DUO, SQUAD ACCURATE)
// ════════════════════════════════════════════════════════════════
export function onParticipantSearch(queryText) {
    // v6.1: if the list isn't loaded yet, load it first, then filter.
    if (!state.detailParticipantsLoaded) {
        const tid = state.currentDetailId;
        if (tid) loadParticipants(tid).then(() => onParticipantSearch(queryText));
        return;
    }
    const q = (queryText || '').trim().toLowerCase();
    const teams = state.currentDetailTeams || [];
    if (!q) {
        renderParticipantsList(teams);
        return;
    }
    const filtered = teams.filter(tm => {
        const matchTeam = (tm.teamName || '').toLowerCase().includes(q) || (tm.teamId || '').toLowerCase().includes(q);
        const matchPlayer = tm.players && tm.players.some(p =>
            (p.playerName || '').toLowerCase().includes(q) ||
            String(p.ffUID || '').includes(q)
        );
        return matchTeam || matchPlayer;
    });
    renderParticipantsList(filtered);
}

function renderParticipantsList(teams) {
    const container = document.getElementById('detail-participants-list');
    if (!container) return;
    if (!teams || teams.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding: 20px; color:var(--text3); font-size:13px; background:var(--bg3); border-radius:12px;">
                No participants yet.
            </div>`;
        return;
    }
    container.innerHTML = teams.map((tm, idx) => {
        const isSolo = tm.teamFormat === 'SOLO' || !tm.players || tm.players.length === 1;
        const isConfirmed = tm.status === 'confirmed' || tm.status === 'approved';
        if (isSolo) {
            const player = (tm.players && tm.players[0]) || {
                playerName: tm.teamName,
                ffUID: '—'
            };
            return `
                <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--bg3); border-radius:12px; border:1px solid var(--border);">
                    <div style="font-family:monospace; font-weight:600; font-size:13px; color:var(--accent); width:24px;">
                        ${String(idx + 1).padStart(2, '0')}
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:14px; font-weight:700; color:var(--text);">${escHtml(player.playerName || 'Player')}</div>
                        <div style="font-size:11px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(player.ffUID)}</div>
                    </div>
                    <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px; ${isConfirmed ? 'background:rgba(0,230,118,0.12);color:var(--success);' : 'background:rgba(255,149,0,0.12);color:var(--warning);'}">
                        ${isConfirmed ? 'Confirmed' : 'Pending'}
                    </span>
                </div>`;
        } else {
            // DUO or SQUAD card
            const playersListHtml = (tm.players || []).map((p, pIdx) => `
                <div style="display:flex; justify-content:space-between; font-size:12px; padding:3px 0; border-bottom:0.5px solid rgba(255,255,255,0.04);">
                    <span style="color:var(--text2);">${escHtml(p.playerName || ('Player ' + (pIdx + 1)))}</span>
                    <span style="font-family:monospace; color:var(--text); font-weight:600;">UID: ${escHtml(p.ffUID)}</span>
                </div>
            `).join('');
            return `
                <div style="background:var(--bg3); border-radius:14px; padding:12px 14px; border:1px solid var(--border); margin-bottom:4px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <div>
                            <div style="font-size:14px; font-weight:600; color:var(--text);">${escHtml(tm.teamName || 'Team')}</div>
                            <div style="font-size:11px; font-family:monospace; color:var(--accent); display:flex; align-items:center; gap:6px; margin-top:2px;">
                                ${escHtml(tm.teamId)} 
                                ${tm.teamId ? `<button class="copy-btn" style="padding:1px 6px; font-size:9px;" data-copy="${escHtml(tm.teamId)}" onclick="copyText(this.dataset.copy,'Team ID')">Copy</button>` : ''}
                            </div>
                        </div>
                        <span style="font-size:11px; font-weight:700; padding:3px 8px; border-radius:6px; ${isConfirmed ? 'background:rgba(0,230,118,0.12);color:var(--success);' : 'background:rgba(255,149,0,0.12);color:var(--warning);'}">
                            ${isConfirmed ? 'Confirmed' : 'Pending'}
                        </span>
                    </div>
                    <div style="background:rgba(0,0,0,0.2); border-radius:10px; padding:8px 10px;">
                        ${playersListHtml}
                    </div>
                </div>`;
        }
    }).join('');
}

// ════════════════════════════════════════════════════════════════
// v6.1: ON-DEMAND participant list (refresh button).
// The old code fetched EVERY team on each details view (~48 reads).
// Now the list loads only when the user taps refresh (or searches).
// ─═══════════════════════════════════════════════════════════════
function renderParticipantRefreshPrompt(t, cap) {
    const container = document.getElementById('detail-participants-list');
    const countEl = document.getElementById('participants-count');
    // Count from the tournament counters — fresh on every page open, 0 extra reads.
    if (countEl) countEl.textContent = cap.current;
    if (!container) return;
    container.innerHTML = `
        <div class="empty-state" style="padding:18px 12px;">
            <div class="empty-icon"><!-- UNSLOP (pass 3): users emoji -> line-icon. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
            <div class="empty-title">See who's joined</div>
            <div class="empty-sub">Tap refresh to load the participant list</div>
            <button class="btn btn-secondary btn-sm" id="participants-refresh-btn" style="margin-top:10px;">Load Participants</button>
        </div>`;
    const btn = document.getElementById('participants-refresh-btn');
    if (btn) btn.addEventListener('click', () => loadParticipants(t.id));
}

// FIX (2026-10-25, F-06): একই tournament-এর concurrent participant
// load একটাই in-flight promise শেয়ার করবে — search-এর প্রতি keystroke-এ
// আর নতুন load + re-render হবে না। (keystroke callback-গুলো registration
// order-এ চলে, তাই শেষ keystroke-এর filter-ই final render হবে।)
let _participantsInFlight = null;
let _participantsInFlightId = null;
function loadParticipants(tournamentId) {
    if (_participantsInFlight && _participantsInFlightId === tournamentId) return _participantsInFlight;
    _participantsInFlightId = tournamentId;
    _participantsInFlight = loadParticipantsInner(tournamentId).finally(() => {
        _participantsInFlight = null;
        _participantsInFlightId = null;
    });
    return _participantsInFlight;
}
async function loadParticipantsInner(tournamentId) {
    const container = document.getElementById('detail-participants-list');
    const btn = document.getElementById('participants-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
    try {
        let teams = [];
        const tSnap = await getDocs(query(
            collection(db, 'tournamentTeams'),
            where('tournamentId', '==', tournamentId)
        ));
        tSnap.forEach(d => teams.push({ id: d.id, ...d.data() }));
        // Legacy fallback (kept from the old eager load)
        if (teams.length === 0) {
            const reqSnap = await getDocs(query(
                collection(db, 'joinRequests'),
                where('tournamentId', '==', tournamentId)
            ));
            reqSnap.forEach(d => {
                const dat = d.data();
                if (dat.status !== 'rejected') {
                    teams.push({
                        id: dat.teamId || d.id,
                        teamId: dat.teamId || ('TEAM-' + d.id.slice(0, 6).toUpperCase()),
                        teamName: dat.teamName || dat.userName || 'Team',
                        captainUserId: dat.userId,
                        players: [{ userId: dat.userId, playerName: dat.userName, ffUID: dat.ffUID }],
                        status: dat.status || 'confirmed',
                        roomSlot: dat.roomSlot || null
                    });
                }
            });
        }
        state.currentDetailTeams = teams;
        state.detailParticipantsLoaded = true;
        const countEl = document.getElementById('participants-count');
        if (countEl) countEl.textContent = teams.length;
        renderParticipantsList(teams);
    } catch (e) {
        console.warn('[Details] loadParticipants failed:', e.message);
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding:18px 12px;">
                    <div class="empty-icon"><!-- UNSLOP (pass 3): warning emoji -> line-icon alert. --><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div>
                    <div class="empty-title">Couldn't load participants</div>
                    <div class="empty-sub">${escHtml(e.message)}</div>
                    <button class="btn btn-secondary btn-sm" id="participants-retry-btn" style="margin-top:10px;">Try Again</button>
                </div>`;
            const retry = document.getElementById('participants-retry-btn');
            if (retry) retry.addEventListener('click', () => loadParticipants(tournamentId));
        }
    }
}
window.loadParticipants = loadParticipants;

// ════════════════════════════════════════════════════════════════
// Window bindings (inline onclick handlers)
// ════════════════════════════════════════════════════════════════
window.onParticipantSearch = onParticipantSearch;
// (openTournamentResults / startTournamentJoin / joinTournament now centralized in navigation.js)

initPage({
    page: 'tournamentDetails',
    onReady: () => {
        loadTournamentDetail(getParam('id'));
    }
});
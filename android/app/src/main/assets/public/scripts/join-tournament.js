// Join flow. Loaded on demand by scripts/tournament-details.js
// (window.startTournamentJoin → import('./join-tournament.js')).
import { state } from './state.js';
import { showToast, friendlyErrorMessage } from './toast.js';
// v8.6 (G): বাকি English toast-গুলোও সহজ পেশাদার বাংলায় করা হয়েছে — join-এর raw error toast mapper দিয়ে বাংলায়
import { openModal, closeModal } from './modal.js';
import {
    db,
    doc,
    getDoc,
    getDocs,
    collection,
    query,
    where,
    runTransaction,
    serverTimestamp,
    arrayUnion,
    arrayRemove
} from '../firebase/firebase-init.js';
import { goTo, goReplace } from '../config/app-config.js';
import { mountComponent } from '../utils/dom-helpers.js';
import { escHtml } from '../utils/escape.js';
import { isNumeric } from '../utils/validators.js';
import { normalizeTournament, getTournamentCapacity, invalidateTournamentCaches } from '../services/tournaments.service.js';
import { getMyTeam, teamPlayersForFormat } from '../services/team.service.js';
// SLOT BOOKING (v8.3, 2026-11-11): user নিজের slot নম্বর বেছে নেয় —
// taken slot-গুলো picker-এ দেখানো হয়, আসল guard txn-এর ভেতরে
// tournamentSlots lock doc (slot.service.js দেখো)।
import { fetchSlotStates, renderSlotGrid, isValidSlot } from '../services/slot.service.js';

// SLOT BOOKING (v8.3): modal-এ বেছে নেওয়া slot + picker state।
// _slotsLoaded false থাকলে submit বন্ধ (fail-closed — taken list না
// জেনে blind pick করলে collision-ই হবে)।
let _selectedSlot = null;
let _slotTaken = new Set();
// v8.8 (item 4): আটকে থাকা slot-গুলো (teamId-হীন confirmed lock) —
// picker-এ বাংলায় জানানো হয়, শুধু admin-ই ছাড়াতে পারবে।
let _slotStuck = [];
let _slotsLoaded = false;
let _joinInFlight = false;

// ════════════════════════════════════════════════════════════════
// COLLISION-PROOF UNIQUE TEAM ID GENERATOR
// ════════════════════════════════════════════════════════════════
export function generateTeamId() {
    // বর্তমান টাইমস্ট্যাম্পের Base36 + ৪ অক্ষরের র‍্যান্ডম ক্যারেক্টার
    // উদাহরণ: TEAM-M3K9P-X8F4 (কখনোই দুটি টিমের আইডি এক হবে না)
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // বিভ্রান্তিকর 0, 1, O, I বাদ দেওয়া হয়েছে
    let randomPart = '';
    for (let i = 0; i < 4; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `TEAM-${timePart}-${randomPart}`;
}

// The join form (components/join-tournament-modal.html) is mounted once, when first needed
async function ensureJoinModal() {
    if (document.getElementById('modal-join-tournament')) return;
    await mountComponent('join-tournament-modal', document.getElementById('app') || document.body);
    // v8.8 (item 12): persistent error box-এর dismiss বাটন — একবারই wire হয়।
    const dismissBtn = document.getElementById('join-error-dismiss');
    if (dismissBtn && !dismissBtn.dataset.wired) {
        dismissBtn.dataset.wired = '1';
        dismissBtn.addEventListener('click', clearJoinError);
    }
}

// SLOT BOOKING (v8.3): Free join modal-এর slot picker। Taken list
// load না হওয়া পর্যন্ত submit বন্ধ থাকে (fail-closed)। Load fail
// করলে Retry দেখাবে — blind submit কখনো হবে না।
async function renderJoinSlotPicker(t) {
    const box = document.getElementById('join-slot-picker');
    if (!box) return;
    _selectedSlot = null;
    _slotsLoaded = false;
    updateJoinSubmitLabel(t);
    box.innerHTML = '<div class="slot-picker-note">Slot list load হচ্ছে…</div>';
    try {
        const _slotStates = await fetchSlotStates(t.id);
        _slotTaken = _slotStates.taken;
        _slotStuck = _slotStates.stuck;
        _slotsLoaded = true;
        renderJoinSlotPickerRefresh(t);
    } catch (e) {
        _slotsLoaded = false;
        box.innerHTML = `<div class="slot-picker-note" style="color:var(--error);">${escHtml(e?.message || 'Slot list load হয়নি।')}</div>`
            + '<button type="button" class="btn btn-secondary" id="join-slot-retry-btn" style="margin-top:10px;">Try Again</button>';
        const retry = document.getElementById('join-slot-retry-btn');
        if (retry) retry.addEventListener('click', () => renderJoinSlotPicker(t));
    }
}

// SLOT BOOKING (v8.3): picker-এ slot বদলালে শুধু grid + label refresh।
function renderJoinSlotPickerRefresh(t) {
    const box = document.getElementById('join-slot-picker');
    if (!box || !_slotsLoaded) return;
    renderSlotGrid(box, {
        maxTeams: getTournamentCapacity(t).max,
        taken: _slotTaken,
        selected: _selectedSlot,
        onSelect: (n) => { _selectedSlot = n; clearJoinError(); renderJoinSlotPickerRefresh(t); updateJoinSubmitLabel(t); }
    });
    // v8.8 (item 4): stuck slot থাকলে picker-এর নিচেই বাংলায় জানাও —
    // user-side delete নেই, শুধু admin ছাড়াতে পারবে।
    const oldNote = document.getElementById('join-stuck-slot-note');
    if (oldNote) oldNote.remove();
    if (_slotStuck.length > 0) {
        const note = document.createElement('div');
        note.id = 'join-stuck-slot-note';
        note.style.cssText = 'margin-top:10px; background:var(--bg3); border:1px solid var(--error); border-radius:12px; padding:10px 12px; font-size:13px; color:var(--text); line-height:1.6;';
        note.textContent = `Slot ${_slotStuck.join(', ')} আটকে আছে — অ্যাডমিনকে জানাও। শুধু অ্যাডমিনই এই Slot ছাড়াতে পারবে, তুমি নিজে ছাড়াতে পারবে না। অন্য খালি Slot বেছে নাও।`;
        box.appendChild(note);
    }
    updateJoinSubmitLabel(t);
}

// SLOT BOOKING (v8.3): Confirm button-এ শুধু "Join" লেখা থাকে
// (FIX 2026-11-19, v8.9-2) — বেছে নেওয়া slot-এর নোট picker-এর
// নিচে আলাদা দেখায়, বাটনে বাড়তি লেখা নয়।
function updateJoinSubmitLabel(t) {
    const btn = document.getElementById('join-submit-btn');
    if (!btn) return;
    if (btn.disabled && _joinInFlight) return;
    btn.innerHTML = '<span>Join</span>';
}

// v8.8 (item 12, surface_real_errors): join error-এর PERSISTENT
// জায়গা — modal-এর ভেতরে, dismiss / পরের চেষ্টা পর্যন্ত থাকে।
// শুধু toast-এ ভরসা করা যাবে না: কারণ + পরের ধাপ পড়ার সময় লাগে।
function showJoinError(msg) {
    const box = document.getElementById('join-error');
    const text = document.getElementById('join-error-text');
    if (!box || !text) return;
    text.textContent = String(msg || '');
    box.style.display = '';
}
function clearJoinError() {
    const box = document.getElementById('join-error');
    const text = document.getElementById('join-error-text');
    if (box) box.style.display = 'none';
    if (text) text.textContent = '';
}

// v8.8 (item 12): আসল error code থেকে বাংলা message — কোনো guessed
// কারণ hardcode করা নেই (আগের hardcoded prefix তোলা হলো,
// ওটা ভুল কারণ দেখাত — আসল কারণ permission-denied হলে rules/index
// চেক করতে হবে, sign-in নয়)। toast.js-এর mapper KEYS ছোঁয়া হয়নি —
// এখানে শুধু code দেখে নিজের Bengali string বাছা হয়।
function joinErrorMessage(err) {
    const code = String(err?.code || '');
    if (code === 'permission-denied') return 'অনুমতি পাওয়া যায়নি — Rules বা index-এ সমস্যা হতে পারে। অ্যাডমিনকে জানাও, তারপর আবার চেষ্টা করো।';
    if (code === 'failed-precondition') return 'ডাটাবেসের index পাওয়া যায়নি — অ্যাডমিনকে জানাও।';
    if (code === 'slot-stuck') return friendlyErrorMessage(err);
    if (code === 'slot-taken') return friendlyErrorMessage(err);
    if (code === 'duplicate-ff-uid') return friendlyErrorMessage(err);
    if (code === 'unavailable') return 'সার্ভারে সমস্যা হয়েছে। ইন্টারনেট চেক করে আবার চেষ্টা করো।';
    if (code === 'unauthenticated') return 'সেশন শেষ হয়ে গেছে। আবার সাইন ইন করো।';
    return friendlyErrorMessage(err);
}

// ════════════════════════════════════════════════════════════════
// START TOURNAMENT JOIN (SOLO / DUO / SQUAD DYNAMIC FORM)
// ════════════════════════════════════════════════════════════════
export async function startTournamentJoin(id) {
    const uid = state.currentUser?.uid;
    if (!uid) {
        showToast('জয়েন করতে আগে সাইন ইন করো', 'error');
        goReplace('login');
        return;
    }
    // Fetch latest tournament document
    let t = null;
    try {
        const snap = await getDoc(doc(db, 'tournaments', id));
        if (!snap.exists()) {
            showToast('টুর্নামেন্ট পাওয়া যায়নি', 'error');
            return;
        }
        t = normalizeTournament(snap.data(), snap.id);
    } catch (e) {
        showToast('টুর্নামেন্ট load হয়নি: ' + friendlyErrorMessage(e), 'error');
        return;
    }
    if (t.status !== 'upcoming') {
        showToast(`জয়েন করা যাবে না। টুর্নামেন্ট এখন ${t.status.toUpperCase()} অবস্থায় আছে`, 'error');
        return;
    }
    const cap = getTournamentCapacity(t);
    if (cap.isFull) {
        showToast('টুর্নামেন্ট ভরে গেছে', 'error');
        return;
    }
    // Check duplicate active team by current captain
    try {
        const existingTeamSnap = await getDocs(query(
            collection(db, 'tournamentTeams'),
            where('tournamentId', '==', t.id),
            where('captainUserId', '==', uid)
        ));
        if (!existingTeamSnap.empty) {
            // FIX (2026-10-25, F7): docs[0] ছিল arbitrary — rejected পুরনো
            // টিম থাকলে live pending টিম লুকিয়ে যেত। এখন status priority
            // (confirmed → pending → rejected/expired) + newest first।
            const _ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v ? new Date(v).getTime() : 0);
            const _rank = s => (s === 'confirmed' ? 0 : (s === 'pending' ? 1 : 2));
            const _docs = existingTeamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            _docs.sort((a, b) => (_rank(a.status) - _rank(b.status)) || (_ms(b.createdAt) - _ms(a.createdAt)));
            const existing = _docs[0];
            // Legacy only (pre-flow-change teams): a pending team whose payment
            // was never submitted opens the payment page in legacy-team mode.
            if (existing.status === 'pending' && existing.paymentStatus === 'unpaid' && t.entryFee > 0) {
                showToast(`টিম ${existing.teamName || existing.teamId}-এর payment আবার চালু হচ্ছে...`, 'info', 3000);
                goTo('payment', { id: t.id, team: existing.teamId });
                return;
            }
            // যদি ইতোমধ্যে পেমেন্ট সাবমিট করা থাকে
            if (existing.status === 'pending' && existing.paymentStatus === 'pending') {
                showToast(`টিম ${existing.teamId}-এর payment admin verification-এর জন্য pending আছে।`, 'info', 4000);
                return;
            }
            if (existing.status !== 'rejected') {
                showToast(`তুমি আগেই register করেছো (${existing.teamId})`, 'info', 4000);
                return;
            }
        }
    } catch (e) {
        // FIX (2026-11-11, M17): existing-team check fail করলে চুপচাপ
        // form খোলা যাবে না (fail-closed) — user পুরো form ভরে submit-এ
        // গিয়ে জানতো।
        showToast('তোমার আগের registration যাচাই করা যায়নি — connection চেক করে আবার চেষ্টা করো', 'error');
        return;
    }

    // v8.0 TEAM GATE: DUO/SQUAD-এ join করতে হলে Profile-এ বানানো team
    // থাকতেই হবে। SOLO-তে team লাগে না। এই gate free + paid দুই flow-কেই
    // আটকায় (paid-এর ক্ষেত্রে payment page-এ যাওয়ার আগেই)।
    const _fmtGate = String(t.teamFormat || 'SOLO').toUpperCase();
    let _savedTeam = null;
    if (_fmtGate === 'DUO' || _fmtGate === 'SQUAD') {
        // v8.8 (item 7): getMyTeam read fail করলে (team-load-failed)
        // retry message দেখাও — "team নেই" ভেবে My Team পেজে পাঠিও না।
        try {
            _savedTeam = await getMyTeam(uid);
        } catch (e) {
            showToast('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error', 4500);
            return;
        }
        const _chk = teamPlayersForFormat(_savedTeam, { uid, name: state.userData?.name || '', ffUID: state.userData?.ffUID || '' }, _fmtGate);
        if (_chk.error) {
            showToast(_chk.error, 'warning', 4500);
            goReplace('myTeam', { team: _fmtGate.toLowerCase() });
            return;
        }
    }

    // CANONICAL FLOW (2026-11-12): DUO/SQUAD-এ roster শুধু My Team-এর saved
    // team থেকে আসে — হাতে টাইপ করা যায় না। Team না থাকলে উপরের gate-ই
    // My Team পেজে পাঠিয়ে দিয়েছে, তাই নিচে আর manual form নেই।
    // PAID tournament → straight to the payment page; slot + fee ওখানেই,
    // confirm করলেই wallet থেকে কাটবে (instant, admin লাগে না)।
    // FREE tournament → নিচের modal: saved-team sheet + slot picker।
    const isFreeJoin = t.entryType === 'FREE' || Number(t.entryFee || 0) === 0;
    if (!isFreeJoin) {
        goTo('payment', { id: t.id });
        return;
    }

    await ensureJoinModal();
    state.activeJoinTournament = t;
    // v8.8 (item 12): নতুন join চেষ্টা — আগের বারের persistent error মুছে ফেলো।
    clearJoinError();

    // Update Mini Summary in Join Modal
    const isFree = t.entryType === 'FREE' || t.entryFee === 0;
    document.getElementById('join-summary-name').textContent = t.name;
    document.getElementById('join-summary-mode').textContent = t.gameMode;
    document.getElementById('join-summary-fee').textContent = isFree ? 'FREE' : '₹' + t.entryFee;
    document.getElementById('join-summary-format').textContent = t.teamFormat;

    // SLOT BOOKING (v8.3): Free join-এও slot বেছে নিতে হয় — picker-টা
    // form-এর আগেই load হতে শুরু করবে (DUO/SQUAD early-return branch-ও
    // এই একই modal ব্যবহার করে, তাই এখানেই call)।
    renderJoinSlotPicker(t);

    const formContainer = document.getElementById('join-form-container');
    // v8.0: DUO/SQUAD-এ manual form নয় — My Team পেজের saved team-ই দেখাও।
    // Submit-এর সময় team doc থেকে আবার players বানানো হয় (নিচে দেখো)।
        if (_savedTeam && (_fmtGate === 'DUO' || _fmtGate === 'SQUAD')) {
        const captain = { uid, name: state.userData?.name || '', ffUID: state.userData?.ffUID || '' };
        const _tp = teamPlayersForFormat(_savedTeam, captain, _fmtGate);

        if (_fmtGate === 'DUO') {
            // DUO: valid mate গুলো থেকে একজন select করতে দাও
            const validMates = (_savedTeam.members || []).filter(m => m && m.name && m.ffUID);
            const mateOptions = validMates.map((m, i) => `
                <label class="duo-mate-option" style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg4);border:1.5px solid var(--border);border-radius:12px;cursor:pointer;margin-bottom:8px;transition:border-color 0.2s;">
                    <input type="radio" name="duo-mate-select" value="${i}" style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;">
                    <div>
                        <div style="font-size:14px;font-weight:700;color:var(--text);">${escHtml(m.name)}</div>
                        <div style="font-size:12px;color:var(--text2);font-family:monospace;">UID: ${escHtml(m.ffUID)}</div>
                    </div>
                </label>`).join('');

            formContainer.innerHTML = `
                <div style="background:var(--bg3);border-radius:14px;padding:16px;border:1px solid var(--border);margin-bottom:12px;">
                    <div style="font-size:14px;font-weight:600;margin-bottom:4px;color:var(--accent);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg> ${escHtml(_savedTeam.teamName)}</div>
                    <div style="font-size:12px;color:var(--text2);">DUO টুর্নামেন্ট — তোমার সাথে কে খেলবে?</div>
                </div>

                <!-- Captain (fixed) -->
                <div style="background:var(--bg3);border-radius:14px;padding:13px 14px;border:1px solid var(--border);margin-bottom:12px;display:flex;align-items:center;gap:10px;">
                    <span style="display:inline-flex;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg></span>
                    <div>
                        <div style="font-size:13px;font-weight:600;color:var(--accent);">Captain (তুমি)</div>
                        <div style="font-size:13px;color:var(--text);font-weight:600;">${escHtml(captain.name)}</div>
                        <div style="font-size:11.5px;color:var(--text2);font-family:monospace;">UID: ${escHtml(captain.ffUID)}</div>
                    </div>
                </div>

                <!-- Mate selector -->
                <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:10px;">Teammate বেছে নাও:</div>
                <div id="duo-mate-list">${mateOptions}</div>`;

            // Radio select visual highlight
            formContainer.querySelectorAll('input[name="duo-mate-select"]').forEach(radio => {
                const updateHighlight = () => {
                    formContainer.querySelectorAll('.duo-mate-option').forEach((lbl, i) => {
                        const r = lbl.querySelector('input[type="radio"]');
                        lbl.style.borderColor = r?.checked ? 'var(--accent)' : 'var(--border)';
                        lbl.style.background  = r?.checked ? 'rgba(199,255,62,0.07)' : 'var(--bg4)';
                    });
                };
                radio.addEventListener('change', updateHighlight);
                updateHighlight();
            });

        } else {
            // SQUAD: সব player দেখাও (select নেই, সবাই যাবে)
            formContainer.innerHTML = `
                <div style="background:var(--bg3);border-radius:14px;padding:16px;border:1px solid var(--border);">
                    <div style="font-size:14px;font-weight:600;margin-bottom:10px;color:var(--accent);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg> Your Squad</div>
                    <div style="font-size:15px;font-weight:600;margin-bottom:10px;">${escHtml(_savedTeam.teamName)}</div>
                    ${_tp.players.map((pl, i) => `
                        <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">
                            <span style="display:inline-flex;">${i === 0 ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg>'}</span>
                            <div>
                                <div style="font-size:13px;font-weight:700;color:var(--text);">${escHtml(pl.playerName)}</div>
                                <div style="font-size:11.5px;color:var(--text2);font-family:monospace;">UID: ${escHtml(pl.ffUID)}</div>
                            </div>
                        </div>`).join('')}
                </div>`;
        }

        openModal('modal-join-tournament');
        return;
    }
    const uData = state.userData || {};
    const uName = uData.name || '';
    const uFFUID = uData.ffUID || '';

    if (t.teamFormat === 'SOLO') {
        // FIX (2026-11-13, H): join time-এ নাম/UID বদলানো যায় না — profile
        // থেকে read-only display। আগের editable solo-player-name input
        // তুলে দেওয়া হলো; submit এখন profile (state.userData) থেকেই
        // নাম+UID নেয় (নিচে দেখো)। বদলাতে চাইলে Profile পেজে edit করো।
        formContainer.innerHTML = `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border);">
                <div style="font-size:14px; font-weight:600; margin-bottom:14px; color:var(--accent);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg> Player Details (Solo)</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <div style="font-size:12px; color:var(--text2); margin-top:6px;">Your profile name and UID are used automatically — they cannot be changed here. বদলাতে চাইলে Profile পেজে গিয়ে edit করো।</div>
            </div>`;
    }  // FIX (2026-11-12, F4): manual DUO/SQUAD form removed — dead code.
    openModal('modal-join-tournament');
}

// ════════════════════════════════════════════════════════════════
// TOURNAMENT REGISTRATION SUBMISSION (SOLO, DUO, SQUAD)
// FREE modal only — Instant Confirm. PAID tournaments never reach this
// modal: openJoinModal sends them to the payment page (wallet-only
// instant join, no admin approval).
// ════════════════════════════════════════════════════════════════
export async function submitTournamentRegistration() {
    const t = state.activeJoinTournament;
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!t || !uid) {
        showToast('Session শেষ হয়ে গেছে। টুর্নামেন্ট আবার খোলো।', 'error');
        return;
    }
    // SLOT BOOKING (v8.3) + DUPLICATE PROTECTION: double-click-এ একই
    // submit দুবার চলবে না — দ্বিতীয় tap প্রথমটা শেষ না হওয়া পর্যন্ত
    // ignore হবে। (আসল guard txn-এর ভেতরে captain lock; এটা শুধু UI layer।)
    if (_joinInFlight) return;
    _joinInFlight = true;
    const submitBtn = document.getElementById('join-submit-btn');
    const originalBtnText = submitBtn.innerHTML;
    try {
        let teamName = '';
        let players = [];
        const format = t.teamFormat || 'SOLO';

        // v8.0: DUO/SQUAD-এর roster form input থেকে নয়, My Team পেজের saved
        // team doc থেকে নেওয়া হয় — DOM বদলে অন্য UID ঢোকানো যাবে না।
                if (format === 'DUO' || format === 'SQUAD') {
            // v8.8 (item 7): getMyTeam read fail করলে retry message —
            // "team নেই" ভেবে My Team পেজে পাঠিও না।
            let _team;
            try {
                _team = await getMyTeam(uid);
            } catch (e) {
                showToast('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error', 4500);
                return;
            }
            const captain = { uid, name: uData.name || '', ffUID: uData.ffUID || '' };
            const _tp = teamPlayersForFormat(_team, captain, format);
            if (_tp.error) { showToast(_tp.error, 'warning', 4500); goReplace('myTeam', { team: format.toLowerCase() }); return; }
            teamName = _tp.teamName;

            if (format === 'DUO') {
                // v8.8 (item 7): silent mateIdx 0 default তোলা হলো —
                // কেউ mate না বাছলে প্রথম mate চুপচাপ join হয়ে যেত।
                // কোনো radio checked না থাকলে hard block (Bengali),
                // ভুল index-ও block — validMates[0] fallback আর নেই।
                const selectedRadio = document.querySelector('input[name="duo-mate-select"]:checked');
                if (!selectedRadio) {
                    showJoinError('Teammate বেছে নাও — কে তোমার সাথে খেলবে সেটা না বাছলে জয়েন হবে না।');
                    showToast('Teammate বেছে নাও — কে তোমার সাথে খেলবে সেটা না বাছলে জয়েন হবে না।', 'warning', 4500);
                    return;
                }
                const mateIdx = parseInt(selectedRadio.value, 10);
                const validMates = (_team.members || []).filter(m => m && m.name && m.ffUID);
                const chosenMate = validMates[mateIdx];
                if (!chosenMate) {
                    showJoinError('Teammate বেছে নাও — কে তোমার সাথে খেলবে সেটা না বাছলে জয়েন হবে না।');
                    showToast('Teammate বেছে নাও', 'warning');
                    return;
                }
                players.push(
                    { userId: uid, playerName: captain.name || 'Captain', ffUID: String(captain.ffUID || '') },
                    { userId: '', playerName: chosenMate.name, ffUID: String(chosenMate.ffUID) }
                );
            } else {
                players.push(..._tp.players);
            }
        } else
        // ── ১. ভ্যালিডেশন এবং ডেটা সংগ্রহ (Solo, Duo, Squad) ──
        if (format === 'SOLO') {
            // FIX (2026-11-13, H): SOLO-র নাম+UID আর DOM input থেকে পড়া
            // হয় না — sheet-এ এখন কোনো editable input নেই, তাই profile
            // (state.userData) থেকেই নেওয়া হয়। Txn-এর ভেতরে captain UID
            // profile doc থেকে live যাচাই হয় (নিচে F1), তাই এখানে DOM-এর
            // ওপর নির্ভরতা তুলে দেওয়া নিরাপদ।
            const pName = uData.name || 'Player';
            let pUid = String(uData.ffUID || '').trim();
            if (!pUid) {
                // FIX (2026-11-20, B4): state.userData app start-এর cached
                // copy হতে পারে — profile doc live পড়ে দেখো, তারপর
                // dead-end দেখাও। Txn-এর ভেতরে live যাচাই তো আছেই (F1)।
                try {
                    const freshSnap = await getDoc(doc(db, 'users', uid));
                    if (freshSnap.exists()) pUid = String(freshSnap.data().ffUID || '').trim();
                } catch (e) { /* live read failed — stale value-ই ব্যবহার হবে */ }
            }
            if (!pUid) {
                showToast('তোমার profile-এ Free Fire UID save করা নেই। আগে Profile-এ save করো, তারপর জয়েন করো।', 'warning');
                return;
            }
            if (!isNumeric(pUid)) {
                showToast('Free Fire UID শুধু সংখ্যা হতে হবে', 'warning');
                return;
            }
            teamName = pName;
            players.push({
                userId: uid,
                playerName: pName,
                ffUID: pUid
            });
        }  // FIX (2026-11-12, F4): manual DUO/SQUAD branches removed — dead code.

        // ── সব প্লেয়ারের FF UID নরমালাইজ + ভ্যালিডেট (lock doc ID এর জন্য জরুরি) ──
        players.forEach(p => { p.ffUID = String(p.ffUID ?? '').trim(); });
        if (players.some(p => !p.ffUID || !isNumeric(p.ffUID))) {
            showToast('সব player-এর সঠিক সংখ্যার Free Fire UID লাগবে (profile-এর UID চেক করো)', 'warning');
            return;
        }
        if (new Set(players.map(p => p.ffUID)).size !== players.length) {
            showToast('তোমার টিমে একই Free Fire UID দুইবার আছে!', 'error');
            return;
        }

        // FIX (2026-10-25, L6): নামের দৈর্ঘ্য সীমা — maxlength টাইপিং
        // আটকালেও paste/devtools বাইপাস করতে পারে, তাই submit-এও চেক।
        // Edit Name-এর 25 অক্ষরের সীমার সঙ্গে মিলিয়ে।
        if (teamName.length > 25 || players.some(p => (p.playerName || '').length > 25)) {
            showToast('টিম আর player-এর নাম ২৫ অক্ষরের বেশি হতে পারবে না — Profile থেকে নাম এলে ওখানে ছোট করো', 'warning');
            return;
        }

        // বাটন লোডিং স্টেট
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Processing...';

        // ── v6.1: ADVISORY PRE-CHECK REMOVED ──
        // The old code downloaded EVERY team of the tournament here (up to ~48
        // reads per join) for a friendly duplicate error. The atomic duplicate
        // check inside the transaction below (tournamentPlayerUIDs locks) gives
        // the same friendly error — so this scan was pure waste. Removed.

        // ── v7: the rest runs through the shared executor ──
        // FIX (2026-10-25, F14): আসল বাটন text executor-কে দেওয়া হলো —
        // নইলে executor spinner-কেই "original" ধরে fail-এর পরেও spinner দেখাত।
        // SLOT BOOKING (v8.3): slot না বেছে Confirm করা যাবে না; taken
        // list load না হওয়া পর্যন্তও না (fail-closed)।
        if (!_slotsLoaded) {
            showToast('Slot list এখনো load হচ্ছে — একটু অপেক্ষা করো', 'warning');
            _joinInFlight = false;
            return;
        }
        if (!_selectedSlot) {
            showToast('আগে একটা খালি Slot বেছে নাও', 'warning');
            _joinInFlight = false;
            return;
        }
        await runJoinTransaction(t, teamName, players, null, { submitBtn, fromModal: true, originalBtnText, slot: _selectedSlot });
        _joinInFlight = false;
        // SLOT BOOKING (v8.3): slot-taken error-এর পর picker reset হয়েছে
        // (কোনো slot আর selected নয়) — button label-ও সেটাই দেখাবে।
        updateJoinSubmitLabel(t);
    } catch (err) {
        _joinInFlight = false;
        updateJoinSubmitLabel(t);
        // errors are toasted inside runJoinTransaction
    } finally {
        // FIX (2026-11-12, F1): validation-failure return-গুলো (UID নেই,
        // duplicate UID, team error, mate নেই) flag reset না করেই return
        // করত — তারপর Join বাটন চুপচাপ মরে থাকত, page reload ছাড়া আর
        // submit হতো না। finally থাকলে প্রতিটা return path-এ flag ছাড়ে।
        _joinInFlight = false;
    }
}

// ── v7: shared join executor — My Team (saved team) + SOLO use this ──
// persistentTeamId: links the entry to a saved team (kept null — the entry
// already carries the saved team's players + teamName, so no lookup needs it).
// FIX (2026-11-12, F4): manual form is gone — DUO/SQUAD can only join from
// the saved team (see the gate in openJoinModal), SOLO from profile UID.
export async function runJoinTransaction(t, teamName, players, persistentTeamId, opts = {}) {
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    const submitBtn = opts.submitBtn || null;
    // FIX (2026-10-25, F14): caller আসল text দিলে সেটাই restore হবে;
    // না দিলে আগের মতো spinner সেট করার আগের text ধরা হবে।
    const originalBtnText = opts.originalBtnText || (submitBtn ? submitBtn.innerHTML : '');
    const format = t.teamFormat || 'SOLO';
    const fromModal = opts.fromModal !== false;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Processing...';
    }
    try {
            const teamId = generateTeamId();
            const isFree = (t.entryType === 'FREE' || Number(t.entryFee || 0) === 0);
            // SLOT BOOKING (v8.3): Free join-এ slot বাধ্যতামূলক — modal-এ
            // বেছে নেওয়া slot ছাড়া executor-এ আসা যাবে না।
            const chosenSlot = Number(opts.slot);
            // FIX (2026-11-11, M1): শুধু ≥1 নয়, ≤ maxTeams-ও চাই —
            // stale picker / forged call-এ DUO-24-এ slot 49 বুক হতো।
            const maxTeams = Number(t.maxTeams || 0);
            if (isFree && !isValidSlot(chosenSlot, maxTeams)) {
                throw new Error('আগে একটা খালি Slot বেছে নাও');
            }

            // ════════════════════════════════════════════════════════════════
    // TEAM PAYLOAD — this executor is FREE-only now.
    // FREE tournament:
    //   - immediately confirmed
    //   - automatically locked
    //   - roomSlot = the slot the user picked (assigned in the txn)
    // PAID tournament: never reaches here — paid joins run through
    // payment.service.js submitInstantWalletJoin (one txn: slot lock +
    // team confirmed + Deposit Balance debit). The isFree=false branch
    // below is only a defensive fallback, never a live path.
    // ════════════════════════════════════════════════════════════════
    const teamPayload = {
        teamId: teamId,
        tournamentId: t.id,
        tournamentName: t.name,
        teamName: teamName,
        teamFormat: format,
        persistentTeamId: null, // FIX (2026-11-12): saved-team link is not
        // stored on the entry — the entry already carries the saved team's
        // players + teamName; null keeps old entries' shape unchanged.
        captainUserId: uid,
        captainName: uData.name || 'User',
        // FIX (2026-10-25, M1): captainEmail REMOVED — team docs are
        // readable by any signed-in user (public rosters), so storing the
        // captain's email there leaked PII. Admin lookup uses the
        // owner-scoped paymentRequests.userEmail instead; nothing reads
        // this field (verified by grep).
        players: players,

        // টিমমেটরা (userId: '') যাতে নিজেদের Matches পেজে টিম দেখতে পায়:
        // ffUID এর flat array — Firestore এ array-of-objects এর ভেতরে query করা যায় না,
        // তাই matches.js এই ফিল্ডে array-contains দিয়ে খোঁজে।
        playerFFUIDs: players.map(p => String(p.ffUID).trim()),

        // FREE = immediately confirmed (live path). PAID = pending is a
        // defensive fallback only — live paid joins never come through here.
        status: isFree ? 'confirmed' : 'pending',

        paymentStatus: isFree ? 'free' : 'unpaid',

        // FREE tournament will be locked automatically.
        // PAID tournament keeps the existing unlocked state.
        locked: isFree,

        // IMPORTANT:
        // SLOT BOOKING (v8.3): roomSlot আর auto-calculate হয় না — user
        // যে slot বেছে নিয়েছে সেটাই (txn-এর ভেতরে lock check-এর পর
        // assignedSlot-এ বসবে; নিচে দেখো)।
        roomSlot: isFree ? chosenSlot : null,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

            const tournRef = doc(db, 'tournaments', t.id);
            const teamRef = doc(db, 'tournamentTeams', teamId);
            const userRef = doc(db, 'users', uid);
            // SLOT BOOKING (v8.3): এই slot-এর deterministic lock doc —
            // atomic booking-এর guard (txn-এর ভেতরে get + set)।
            const slotLockRef = doc(db, 'tournamentSlots', `${t.id}_${chosenSlot}`);
            // ক্যাপ্টেনের জন্য ইউনিক লক ডকুমেন্ট (ডাবল ক্লিক ও ডুপ্লিকেট টিম রোধ)
            const captainLockRef = doc(db, 'tournamentCaptains', `${t.id}_${uid}`);
            // প্রতিটি FF UID এর জন্য ইউনিক লক ডকুমেন্ট (cross-team duplicate UID atomic ভাবে ব্লক)
            const playerUidLocks = players.map(p => ({
                player: p,
                ref: doc(db, 'tournamentPlayerUIDs', `${t.id}_${p.ffUID}`)
            }));

    // ════════════════════════════════════════════════════════════════
    // ATOMIC TOURNAMENT REGISTRATION
    //
    // FREE:
    //   Join → Confirmed → Auto Lock → Auto Slot → Joined
    //
    // PAID:
    //   Existing Pending → Payment flow remains unchanged
    //
    // Firestore transaction guarantees that if multiple users join
    // at nearly the same time, each user receives a different slot.
    // ════════════════════════════════════════════════════════════════
    // SLOT BOOKING (v8.3): success toast-এ দেখানোর জন্য txn-এর ভেতরে
    // confirm হওয়া slot-টা এখানে ধরে রাখা হয়।
    let confirmedSlot = null;
    await runTransaction(db, async (transaction) => {

        // ────────────────────────────────────────────────────────────
        // 1. DUPLICATE CAPTAIN CHECK
        // ────────────────────────────────────────────────────────────
        const lockSnap = await transaction.get(captainLockRef);

        if (
            lockSnap.exists() &&
            lockSnap.data().status !== 'rejected'
        ) {
            throw new Error(
                'এই টুর্নামেন্টে তোমার একটা active টিম আগেই register করা আছে!'
            );
        }


        // ────────────────────────────────────────────────────────────
        // 2. READ LATEST TOURNAMENT DATA
        //
        // IMPORTANT:
        // We MUST calculate the slot from this transaction's latest
        // filledTeams value, not from the old page data.
        // ────────────────────────────────────────────────────────────
        const tournSnap = await transaction.get(tournRef);

        if (!tournSnap.exists()) {
            throw new Error('টুর্নামেন্ট পাওয়া যায়নি!');
        }

        const tournData = tournSnap.data();

        // FIX (2026-10-25, F6): form খোলার পর admin tournament start করলে
        // বা free→paid করলেও পুরনো txn চুপচাপ confirmed টিম বানাত। এখন
        // live doc থেকেই status + fee যাচাই হবে।
        if ((tournData.status || 'upcoming') !== 'upcoming') {
            throw new Error(`জয়েন করা যাবে না। টুর্নামেন্ট এখন ${String(tournData.status).toUpperCase()} অবস্থায় আছে`);
        }
        if (!(tournData.entryType === 'FREE' || Number(tournData.entryFee || 0) === 0)) {
            throw new Error('এই টুর্নামেন্টে payment লাগবে। Payment page থেকে জয়েন করো।');
        }

        // FIX (2026-10-25, F1): captain-এর FF UID profile doc থেকে live
        // যাচাই — DOM-এর hidden input বদলে অন্যের UID দিয়ে join করা
        // যাবে না (victim block + নিজের double entry দুটোই বন্ধ)।
        const userSnap = await transaction.get(userRef);
        const profileFFUID = String(userSnap.data()?.ffUID || '').trim();
        if (!profileFFUID) {
            throw new Error('তোমার profile-এ Free Fire UID save করা নেই। আগে Profile-এ save করো, তারপর জয়েন করো।');
        }
        if (String(players[0]?.ffUID || '').trim() !== profileFFUID) {
            throw new Error('Captain-এর Free Fire UID তোমার profile-এর সঙ্গে মিলছে না। Profile চেক করে আবার চেষ্টা করো।');
        }

        // Use the SAME capacity rule as the UI (normalizeTournament), so a
        // tournament without an explicit maxTeams gets the same default
        // (SOLO 50 / DUO 24 / SQUAD 12) here as on the screen, instead of
        // being treated as unlimited.
        const maxTeams = normalizeTournament(tournData, t.id).maxTeams;

        // FIX (2026-11-20, K1): pre-txn check (উপরে, :562) শুধু stale
        // page doc-এর maxTeams দেখে — admin maxTeams কমালে (যেমন 50→24)
        // stale picker-এর slot 49 সেখান দিয়ে গলে যেত। PAID পথের
        // services/payment.service.js:772-এর re-check-এর মতোই, LIVE
        // maxTeams-এর বিরুদ্ধে txn-এর ভেতরে আবার যাচাই — capacity check
        // (filled+pending) এটা ধরে না, কারণ ওটা শুধু মোট গোনে।
        if (!Number.isInteger(chosenSlot) || chosenSlot < 1 || (maxTeams > 0 && chosenSlot > maxTeams)) {
            throw new Error(`1 থেকে ${maxTeams}-এর মধ্যে একটি Slot বেছে নাও।`);
        }

        const filledTeams = Number(
            tournData.filledTeams ||
            tournData.filledSlots ||
            0
        );

        // Legacy paid pendings from the old flow still hold seats
        // (pendingTeams > 0) until the admin resolves them; new-flow paid
        // requests hold NO seat, so this only ever counts legacy data.
        const pendingTeams = Number(tournData.pendingTeams || 0);


        // ────────────────────────────────────────────────────────────
        // 3. CAPACITY CHECK (confirmed seats + reserved pending seats)
        // ────────────────────────────────────────────────────────────
        if (
            maxTeams > 0 &&
            filledTeams + pendingTeams >= maxTeams
        ) {
            throw new Error('টুর্নামেন্ট ভরে গেছে!');
        }


        // ────────────────────────────────────────────────────────────
        // 4. TEAM ID COLLISION CHECK
        // ────────────────────────────────────────────────────────────
        const teamCollisionSnap = await transaction.get(teamRef);

        if (teamCollisionSnap.exists()) {
            throw new Error(
                'Team ID collision হয়েছে। আবার Confirm চাপো!'
            );
        }


        // ────────────────────────────────────────────────────────────
        // 4b. DUPLICATE FF UID CHECK (ATOMIC, CROSS-TEAM)
        //
        // Firestore requires ALL reads before ANY write, so every UID
        // lock is read here. If two users race with the same UID, one
        // transaction will be retried/aborted and will see the lock
        // written by the other → throws below.
        // 'rejected' lock = UID released (same rule as captain lock).
        // ────────────────────────────────────────────────────────────
        const uidLockSnaps = await Promise.all(
            playerUidLocks.map(l => transaction.get(l.ref))
        );
        // FIX (2026-10-25, F2): শুধু lock থাকলেই block নয় — lock-এর
        // teamId দিয়ে team doc-টি live দেখা হবে। team না থাকলে বা
        // rejected/expired হলে lock-টি squatted/মৃত ধরে overwrite হবে
        // (writes phase-এ নতুন lock বসবে)। teamId-হীন lock প্রমাণ করা
        // যায় না বলে আগের মতোই block থাকবে — সেটা admin-কে delete
        // করতে হবে।
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
                const err = new Error(
                    `Free Fire UID (${playerUidLocks[i].player.ffUID}) is already registered in this tournament!`
                );
                err.code = 'duplicate-ff-uid';
                throw err;
            }
        }


        // ════════════════════════════════════════════════════════════
        // 4c. SLOT LOCK CHECK (v8.3 — ATOMIC BOOKING)
        //
        // Firestore txn-এর ভেতরে query করা যায় না, তাই slot-এর দখল
        // এই একটা doc-ই বলে দেয়। Lock আছে + confirmed + তার team-ও
        // confirmed → SLOT_TAKEN। Lock-এর team মৃত (doc নেই / rejected /
        // expired) → squatted, overwrite হবে (UID-lock F2 pattern-এর
        // মতোই)। teamId-হীন lock প্রমাণ করা যায় না বলে block থাকবে।
        // ────────────────────────────────────────────────────────────
        const slotSnap = await transaction.get(slotLockRef);
        if (slotSnap.exists() && slotSnap.data().status !== 'released' && slotSnap.data().status !== 'rejected') {
            const lockTeamId = slotSnap.data().teamId;
            // v8.8 (item 4): teamId-হীন lock stuck — squat-heal করা যায়
            // না, তাই আলাদা code-এ জানাও: user অন্য slot নেবে, আর
            // picker-এ stuck note দেখে admin-কে জানাবে। User-side
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
                const err = new Error(`Slot ${chosenSlot} is already booked — অন্য Slot বেছে নাও।`);
                err.code = 'slot-taken';
                throw err;
            }
        }


        // ════════════════════════════════════════════════════════════
        // 5. FREE TOURNAMENT AUTO-JOIN
        // ════════════════════════════════════════════════════════════
        if (isFree) {

            // FIX (2026-10-24, AUD-024): আগে slot সবসময়
            // filledTeams+1 নেওয়া হতো — মাঝের কোনো টিম kick হলে
            // (যেমন slot 2 খালি) নতুন টিম এমন slot পেত যা আগেই অন্য
            // টিমের দখলে (collision)। এখন admin kick/reject-এর সময়
            // খালি slot tournament doc-এর freedSlots array-তে জমা হয়,
            // আর join সবচেয়ে ছোট খালি slot-টাই নেয়; খালি না থাকলে
            // আগের মতো filledTeams+1। (rules v13-এ freedSlots শুধু
            // ছোটই হতে পারে — বাড়ানো যায় না।)
            // SLOT BOOKING (v8.3): auto-assign বাদ — user যে slot বেছে
            // নিয়েছে সেটাই assignedSlot (lock check উপরে হয়েছে)।
            // freedSlots-এ থাকলে নিচের update-এ সেখান থেকে সরবে।
            const freedSlots = Array.isArray(tournData.freedSlots)
                ? tournData.freedSlots.map(Number).filter(n => Number.isFinite(n) && n >= 1)
                : [];
            const assignedSlot = chosenSlot;
            confirmedSlot = assignedSlot;
            // filledTeams হলো COUNT (কয়টা টিম), slot নম্বর নয় — freed
            // slot (যেমন 2) নিলেও count filledTeams+1-ই হবে, নইলে counter
            // ভেঙে capacity check ভুল দেখাত।
            const newFilled = filledTeams + 1;


            // FIX (2026-11-19, v8.11, B4): counterGuard rules live doc-এর
            // teamFormat দিয়ে default বের করে — UI state-এর format
            // (t.teamFormat) stale হতে পারে (admin format বদলালে, বা
            // state-এ teamFormat না থাকলে 'SOLO' ধরে নিত)। তখন লেখা
            // filledPlayers আর rules-এর হিসাবে মিলত না, পুরো txn
            // permission-denied-এ মরত। এখন fallback-ও live doc থেকেই।
            const _fmt = String(tournData.teamFormat || 'SOLO').toUpperCase();
            const playersPerTeam =
                Number(tournData.playersPerTeam || 0) ||
                (_fmt === 'DUO' ? 2 : _fmt === 'SQUAD' ? 4 : 1);


            // ────────────────────────────────────────────────────────
            // Update tournament counters
            // ────────────────────────────────────────────────────────
            transaction.update(tournRef, {

                // Number of teams / solo players registered
                filledTeams: newFilled,

                // Keep the existing filledSlots field synchronized
                filledSlots: newFilled,

                // Total player count
                filledPlayers:
                    newFilled * playersPerTeam,

                // নেওয়া slot freedSlots থেকে সরিয়ে দেওয়া (থাকলে)
                ...(freedSlots.includes(assignedSlot) ? { freedSlots: arrayRemove(assignedSlot) } : {})
            });


            // ────────────────────────────────────────────────────────
            // Update user's joined tournaments
            // ────────────────────────────────────────────────────────
            transaction.update(userRef, {
                joinedTournaments: arrayUnion(t.id)
            });


            // ────────────────────────────────────────────────────────
            // FREE TEAM = IMMEDIATELY CONFIRMED + LOCKED + SLOT
            // ────────────────────────────────────────────────────────
            transaction.set(teamRef, {

                ...teamPayload,

                // FREE tournament is instantly confirmed
                status: 'confirmed',

                // Free tournament team is automatically locked
                locked: true,

                // Automatically assigned room/participation slot
                roomSlot: assignedSlot,

                // System records why/how it was locked
                lockedAt: serverTimestamp(),
                lockedBy: 'system-auto',

                updatedAt: serverTimestamp()
            });


            // ────────────────────────────────────────────────────────
            // Captain lock
            // Prevents the same user from joining twice.
            // ────────────────────────────────────────────────────────
            transaction.set(captainLockRef, {

                tournamentId: t.id,

                captainUserId: uid,

                teamId: teamId,

                status: 'confirmed',

                // Store the assigned slot here too
                roomSlot: assignedSlot,

                createdAt: serverTimestamp(),

                updatedAt: serverTimestamp()
            });

            // SLOT BOOKING (v8.3): এই slot-এর lock — team + counter-এর
            // সঙ্গে একই txn-এ লেখা হয় বলে all-or-nothing।
            transaction.set(slotLockRef, {
                tournamentId: t.id,
                slot: assignedSlot,
                slotKey: String(assignedSlot),
                teamId: teamId,
                captainUserId: uid,
                status: 'confirmed',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });

        } else {

            // ════════════════════════════════════════════════════════
            // PAID TOURNAMENT
            //
            // KEEP EXISTING PAYMENT FLOW:
            // pending + unpaid + no automatic slot
            // ════════════════════════════════════════════════════════

            // FIX (flow change): paid joins NEVER reach this executor anymore —
            // they are created from the payment page (services/payment.service.js
            // submitPaidJoinRequest) only after payment details are confirmed.
            // This branch is a safety net and must not create a payable team.
            throw new Error('Paid জয়েন payment page-এ শেষ করতে হবে।');
        }


        // ════════════════════════════════════════════════════════════
        // 6. PLAYER UID LOCKS (FREE + PAID দুটোতেই)
        // Team doc এর সাথে একই transaction এ লেখা হয় → all-or-nothing।
        // ════════════════════════════════════════════════════════════
        playerUidLocks.forEach(({ player, ref }) => {
            transaction.set(ref, {
                tournamentId: t.id,
                ffUID: player.ffUID,
                playerName: player.playerName,
                teamId: teamId,
                captainUserId: uid,
                status: isFree ? 'confirmed' : 'pending',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });
    });

            // FREE join success (paid joins never reach this executor anymore)
            if (fromModal) { try { closeModal('modal-join-tournament'); } catch (e) {} }
            // SLOT-UPDATE (2026-11-20): blind window.location.reload() আর
            // নয় — reload-এ পুরো page (auth, listener, modal state) আবার
            // init হতো, আর back/forward-এ bfcache-এ ফেরা list পেজগুলো
            // তবুও বাসি থাকত। এখন: (1) list/captain cache খালি করো,
            // (2) Details পেজকে 'ff:joined-tournament' event-এ in-place
            // re-load করতে বলো (fresh tournament doc + myTeam + room —
            // filled count, Join বাটন, slot একই পেজেই আপডেট হবে),
            // (3) success toast এখনই দেখাও — flashToast শুধু
            // sessionStorage-এ লেখে, reload ছাড়া কখনো দেখায় না, তাই
            // এখানে showToast লাগবে। কোনো listener event না ধরলে
            // (Details পেজের বাইরে থেকে join হলে) fallback হিসেবে
            // আগের মতো reload হবে।
            invalidateTournamentCaches();
            const joinedEvent = new CustomEvent('ff:joined-tournament', {
                cancelable: true,
                detail: { tournamentId: t.id, slot: confirmedSlot }
            });
            const joinedHandled = document.dispatchEvent(joinedEvent);
            showToast(confirmedSlot ? `সফলভাবে জয়েন হয়েছে! Slot ${confirmedSlot} তোমার — ${t.name}` : `সফলভাবে জয়েন হয়েছে! — ${t.name}`, 'success', 5000);
            if (!joinedHandled) window.location.reload();
        } catch (err) {
            console.error('runJoinTransaction error:', err);
            // v8.8 (item 12, surface_real_errors): hardcoded
            // prefix তোলা হলো — ওটা আসল
            // কারণ না জেনেই একটা কারণ লিখে দিত। এখন আসল error code
            // থেকে বাংলা message বানিয়ে modal-এ PERSISTENT দেখানো হয়
            // (dismiss / পরের চেষ্টা পর্যন্ত) + toast-ও যায়।
            const joinMsg = joinErrorMessage(err);
            if (err.code === 'duplicate-ff-uid') {
                showJoinError(joinMsg);
                showToast(joinMsg, 'error', 5500);
            } else if (err.code === 'slot-taken' || err.code === 'slot-stuck') {
                // SLOT BOOKING (v8.3): অন্য কেউ ঠিক এই slot-টা নিয়ে
                // নিয়েছে — picker refresh করে নিলে সেটা Booked দেখাবে,
                // user অন্য slot বেছে নিতে পারবে। Stuck slot হলে picker
                // refresh-এ stuck note-ও দেখাবে।
                showJoinError(joinMsg);
                showToast(joinMsg, 'error', 5500);
                try { renderJoinSlotPicker(t); } catch (e) {}
            } else {
                showJoinError(joinMsg);
                showToast(joinMsg, 'error', 5500);
        throw err;
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            if (submitBtn) submitBtn.innerHTML = originalBtnText;
        }
    } // ── end runJoinTransaction ──

// Inline onclick handler in the modal needs this on window
window.submitTournamentRegistration = submitTournamentRegistration;
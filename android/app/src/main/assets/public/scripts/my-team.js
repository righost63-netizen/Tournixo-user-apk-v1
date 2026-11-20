// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { initPage } from './app.js';
import { state } from './state.js';
import { showToast, friendlyErrorMessage } from './toast.js';
import { showConfirm } from './modal.js';
import { db, doc, getDoc, collection, query, where, limit, getDocs } from '../firebase/firebase-init.js';
import { getParam } from '../config/app-config.js';
import { getMyTeam, saveMyTeam as saveTeamDoc, deleteMyTeam as deleteTeamDoc, validateTeamInput } from '../services/team.service.js';

// ─────────────────────────────────────────────
// FORM READ
// ─────────────────────────────────────────────
// v8.11.1 (K2): mate row গুলো slot নম্বরসহ ফেরে (Player 2 = Mate 1,
// Player 3 = Mate 2, Player 4 = Mate 3) — error মেসেজে আসল Player
// নম্বরটাই দেখাতে হবে। খালি row (নাম + UID দুটোই খালি) = mate নেই,
// members থেকে বাদ যাবে; আধা-ভরা row (নাম ছাড়া UID, বা UID ছাড়া নাম)
// = ভুল — { error } সহ ফিরবে, saveMyTeam সেটা toast দেখিয়ে থামবে।
function readTeamForm() {
    const v = id => document.getElementById(id)?.value.trim() || '';
    const teamName = v('team-name-input');
    const rows = [
        { slot: 2, name: v('team-m1-name'), ffUID: v('team-m1-uid') },
        { slot: 3, name: v('team-m2-name'), ffUID: v('team-m2-uid') },
        { slot: 4, name: v('team-m3-name'), ffUID: v('team-m3-uid') }
    ];
    for (const r of rows) {
        if (r.name && !r.ffUID) return { teamName, members: rows, error: `Player ${r.slot}-এর Gaming UID দাও` };
        if (!r.name && r.ffUID) return { teamName, members: rows, error: `Player ${r.slot}-এর নাম দাও` };
    }
    return { teamName, members: rows.filter(r => r.name && r.ffUID) };
}

// v8.11.1 (K2): Mate 2 (Player 3) আর Mate 3 (Player 4) ঐচ্ছিক —
// label-এ লাল * এর বদলে "(ঐচ্ছিক)" বসানো হয় (JS দিয়ে, HTML ছোঁয়া
// হয়নি)। Mate 1 (Player 2) আবশ্যকই থাকে — DUO-এর জন্য ওই একজনই
// লাগে। সঙ্গে পুরনো note-টাও ঠিক করা হয় ("চারজনের তথ্যই আবশ্যক"
// আর সত্যি নয়)।
function markOptionalMateLabels() {
    const labels = document.querySelectorAll('.team-card label.auth-label');
    // [0] Team Name, [1][2] Player 2 (Mate 1), [3][4] Player 3 (Mate 2),
    // [5][6] Player 4 (Mate 3) — শুধু Mate 2/3 ঐচ্ছিক।
    [3, 4, 5, 6].forEach(i => {
        const lab = labels[i];
        if (!lab || lab.dataset.optionalMarked) return;
        lab.dataset.optionalMarked = '1';
        const star = lab.querySelector('span');
        if (star) {
            star.style.color = '';
            star.textContent = '(ঐচ্ছিক)';
        } else {
            lab.insertAdjacentText('beforeend', ' (ঐচ্ছিক)');
        }
    });
    const note = document.querySelector('.team-note');
    if (note && !note.dataset.fixed) {
        note.dataset.fixed = '1';
        note.textContent = 'Mate 1 (Player 2)-এর নাম ও Free Fire UID দিলেই DUO join করা যাবে। SQUAD join-এর জন্য 3 জন mate-ই (Player 2, 3, 4) দিতে হবে। Teammate-দের মধ্যে যার এই অ্যাপে অ্যাকাউন্ট আছে, তার Matches পেজে এই টিমের হয়ে জয়েন + স্লট নম্বর দেখা যাবে।';
    }
}

// v8.11.1 (S3): HTML-এর English বাটন লেখা JS দিয়ে বাংলায় —
// HTML ছোঁয়া হয়নি, তাই প্রথম load-এও বাংলা দেখাবে।
function applyBengaliButtonLabels() {
    const saveBtn = document.getElementById('team-save-btn');
    if (saveBtn) saveBtn.textContent = 'টিম সেভ করো';
    const retryBtn = document.getElementById('team-retry-btn');
    if (retryBtn) retryBtn.textContent = 'আবার চেষ্টা করো';
}

// ─────────────────────────────────────────────
// LOCK / UNLOCK FORM
// ─────────────────────────────────────────────
function setFormLocked(locked) {
    const ids = [
        'team-name-input',
        'team-m1-name', 'team-m1-uid',
        'team-m2-name', 'team-m2-uid',
        'team-m3-name', 'team-m3-uid'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.readOnly = locked;
        el.style.opacity = locked ? '0.6' : '1';
        el.style.cursor  = locked ? 'not-allowed' : '';
    });

    const saveBtn   = document.getElementById('team-save-btn');
    const deleteBtn = document.getElementById('team-delete-btn');
    const lockedNote = document.getElementById('team-locked-note');

    if (saveBtn)    saveBtn.style.display   = locked ? 'none' : 'block';
    if (deleteBtn)  deleteBtn.style.display = locked ? 'block' : 'none';
    if (lockedNote) lockedNote.style.display = locked ? 'flex' : 'none';
}

// ─────────────────────────────────────────────
// FILL FORM
// ─────────────────────────────────────────────
function fillTeamForm(team) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
    };
    const status = document.getElementById('team-status');
    const retryBtn = document.getElementById('team-retry-btn');
    if (retryBtn) retryBtn.style.display = 'none';

    if (!team) {
        set('team-name-input', '');
        set('team-m1-name', ''); set('team-m1-uid', '');
        set('team-m2-name', ''); set('team-m2-uid', '');
        set('team-m3-name', ''); set('team-m3-uid', '');
        if (status) status.textContent = 'এখনো কোনো টিম নেই — DUO/SQUAD join করতে আগে এখানে টিম বানাও।';
        setFormLocked(false);
        return;
    }

    set('team-name-input', team.teamName);
    const m = team.members || [];
    set('team-m1-name', m[0]?.name); set('team-m1-uid', m[0]?.ffUID);
    set('team-m2-name', m[1]?.name); set('team-m2-uid', m[1]?.ffUID);
    set('team-m3-name', m[2]?.name); set('team-m3-uid', m[2]?.ffUID);

    const ready = m.length >= 3
        ? 'Squad-ready'
        : m.length >= 1
            ? 'Duo-ready'
            : 'Mate যোগ করো';

    if (status) status.textContent = `${team.teamName} — ${ready}`;

    // Team আছে → form lock করো
    setFormLocked(true);
}

// ─────────────────────────────────────────────
// LOAD ERROR (2026-11-19, M4)
// ─────────────────────────────────────────────
// Load fail হলে ফর্ম লক থাকে + Retry বাটন দেখায়। fillTeamForm(null)
// ডাকা হয় না — "No team yet" ভান করা হবে না, আসল team overwrite-এর
// ঝুঁকি থাকবে না।
function showTeamLoadError() {
    const ids = [
        'team-name-input',
        'team-m1-name', 'team-m1-uid',
        'team-m2-name', 'team-m2-uid',
        'team-m3-name', 'team-m3-uid'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.readOnly = true;
        el.style.opacity = '0.6';
        el.style.cursor = 'not-allowed';
    });
    const saveBtn = document.getElementById('team-save-btn');
    if (saveBtn) saveBtn.style.display = 'none';
    const deleteBtn = document.getElementById('team-delete-btn');
    if (deleteBtn) deleteBtn.style.display = 'none';
    const lockedNote = document.getElementById('team-locked-note');
    if (lockedNote) lockedNote.style.display = 'none';
    const status = document.getElementById('team-status');
    if (status) status.textContent = 'টিম লোড হয়নি — আবার চেষ্টা করো।';
    const retryBtn = document.getElementById('team-retry-btn');
    if (retryBtn) retryBtn.style.display = 'block';
}

async function retryLoadMyTeam() {
    const retryBtn = document.getElementById('team-retry-btn');
    if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = 'Loading…'; }
    try {
        fillTeamForm(await getMyTeam(state.currentUser?.uid));
    } catch (e) {
        showToast('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error', 4500);
        showTeamLoadError();
    } finally {
        if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = 'আবার চেষ্টা করো'; }
    }
}
window.retryLoadMyTeam = retryLoadMyTeam;

// ─────────────────────────────────────────────
// LOAD
// ─────────────────────────────────────────────
async function loadMyTeamPage() {
    markOptionalMateLabels();
    applyBengaliButtonLabels();
    const uid = state.currentUser?.uid;
    if (!uid) return;
    // v8.8 (item 7): getMyTeam read fail করলে retry message — ফর্ম
    // খালি দেখিয়ে "team নেই" ভান করা হবে না।
    try {
        fillTeamForm(await getMyTeam(uid));
    } catch (e) {
        // FIX (2026-11-19, M4): load error আর "No team yet" নয় — ফর্ম
        // লক থাকে (ভুল করে আসল team overwrite করা যাবে না), Retry বাটন আসে।
        showToast('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো', 'error', 4500);
        showTeamLoadError();
    }

    const teamNeed = getParam('team');
    if (teamNeed) {
        showToast(
            teamNeed === 'squad'
                ? 'SQUAD join-এর আগে 3 জন teammate-সহ team বানাও।'
                : 'DUO join-এর আগে Mate 1-সহ team বানাও।',
            'warning', 4500
        );
    }
}

// ─────────────────────────────────────────────
// SAVE
// ─────────────────────────────────────────────
async function saveMyTeam() {
    const uid   = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!uid) { showToast('আগে সাইন ইন করো', 'error'); return; }

    const { teamName, members, error: formError } = readTeamForm();
    if (formError) { showToast(formError, 'warning', 4000); return; }

    // v8.11.1 (A7): captain-এর নিজের FF UID ছাড়া team save করা যাবে না —
    // captainFFUID '' হলে join-এর সময় roster-এ খালি UID যেত। stale
    // state.userData-তে না থাকলে users doc থেকে fresh পড়া হয় (join
    // pre-check-এর stale-data ভুল এখানে করা যাবে না)।
    let captainFFUID = String(uData.ffUID || '').trim();
    if (!captainFFUID) {
        try {
            const snap = await getDoc(doc(db, 'users', uid));
            captainFFUID = String(snap.data()?.ffUID || '').trim();
            if (captainFFUID && state.userData) state.userData.ffUID = captainFFUID;
        } catch (_) { /* নিচের missing-UID error-ই দেখাবে */ }
    }
    if (!captainFFUID) {
        showToast('তোমার নিজের Free Fire UID প্রোফাইলে নেই — আগে Profile থেকে FF UID যোগ করো, তারপর টিম সেভ করো', 'warning', 4500);
        return;
    }

    const err = validateTeamInput(teamName, members, captainFFUID);
    if (err) { showToast(err, 'warning', 4000); return; }

    const btn = document.getElementById('team-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'সেভ হচ্ছে…'; }

    try {
        await saveTeamDoc(uid, { name: uData.name || '', ffUID: captainFFUID }, teamName, members);
        showToast('টিম সেভ হয়েছে — এখন DUO/SQUAD join করতে পারবে।', 'success', 3500);
        // v8.8 (item 7): save-এর পর reload fail করলে সেটা load error —
        // "সেভ হয়নি" বলে ভুল জানিও না।
        try {
            fillTeamForm(await getMyTeam(uid));
        } catch (e) {
            showToast('টিম সেভ হয়েছে, কিন্তু নতুন তথ্য লোড হয়নি — পেজ রিফ্রেশ করো', 'warning', 4500);
        }
    } catch (e) {
        showToast('টিম সেভ হয়নি: ' + friendlyErrorMessage(e), 'error', 4500);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'টিম সেভ করো'; }
    }
}

// ─────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────
// v8.11.1 (A8): delete-এ busy guard + active-join check। Check-টা
// confirm-এর আগেই চলে: এই টিম দিয়ে কোনো upcoming/ongoing টুর্নামেন্টে
// confirmed/pending join থাকলে confirm-এই বাংলায় সতর্ক করা হয় —
// টিম মুছলেও ওই join বাতিল হবে না। Check নিজে fail করলে (network /
// permission) delete আটকানো হয় না — সাধারণ confirm দিয়ে এগোয়, আর
// check-fail নোটটা confirm-এই জানিয়ে দেওয়া হয়।
let _deleteBusy = false;

async function deleteMyTeam() {
    const uid = state.currentUser?.uid;
    if (!uid || _deleteBusy) return;
    _deleteBusy = true;
    const deleteBtn = document.getElementById('team-delete-btn');
    if (deleteBtn) deleteBtn.disabled = true;

    // Active-join check (bounded: প্রথম 20টা tournamentTeams, orderBy
    // নেই — composite index লাগে না)। প্রতিটা team-এর tournament doc
    // পড়ে status দেখা হয়; একটা tournament পড়তে fail করলে বাকিগুলো
    // চলতেই থাকে।
    let warning = '';
    try {
        const snap = await getDocs(query(
            collection(db, 'tournamentTeams'),
            where('captainUserId', '==', uid),
            limit(20)
        ));
        const activeNames = [];
        for (const d of snap.docs) {
            const t = d.data() || {};
            if (!['confirmed', 'approved', 'pending'].includes(String(t.status || ''))) continue;
            if (!t.tournamentId) continue;
            try {
                const tsnap = await getDoc(doc(db, 'tournaments', t.tournamentId));
                if (!tsnap.exists()) continue;
                const td = tsnap.data() || {};
                const tStatus = String(td.status || '').toLowerCase();
                if (tStatus === 'upcoming' || tStatus === 'ongoing') {
                    activeNames.push(td.name || t.tournamentId);
                }
            } catch (_) { /* এই tournament-টা বাদ — বাকিগুলো চেক চলবে */ }
        }
        if (activeNames.length) {
            warning = ` সতর্কতা: এই টিম দিয়ে ${activeNames.length}টি আসন্ন/চলমান টুর্নামেন্টে join করা আছে (${activeNames.slice(0, 3).join(', ')}${activeNames.length > 3 ? '…' : ''})। টিম মুছলেও ওই join বাতিল হবে না — টুর্নামেন্টে তোমার entry আগের মতোই থাকবে।`;
        }
    } catch (e) {
        warning = ' (চলমান join আছে কিনা যাচাই করা যায়নি — নেটওয়ার্ক চেক করো।)';
    }

    const resetDeleteGuard = () => {
        _deleteBusy = false;
        if (deleteBtn) deleteBtn.disabled = false;
    };

    const doDelete = async () => {
        try {
            await deleteTeamDoc(uid);
            fillTeamForm(null);
            showToast('টিম মুছে গেছে। নতুন টিম বানাও।', 'info', 3500);
        } catch (e) {
            showToast('টিম মুছে ফেলা যায়নি: ' + friendlyErrorMessage(e), 'error', 4000);
        } finally {
            resetDeleteGuard();
        }
    };

    showConfirm(
        'Delete Team?',
        'Team delete করলে নতুন করে বানাতে হবে। Edit করার option নেই।' + warning,
        doDelete,
        resetDeleteGuard
    );
}

window.saveMyTeam   = saveMyTeam;
window.deleteMyTeam = deleteMyTeam;

initPage({
    page: 'myTeam',
    onReady: () => loadMyTeamPage()
});
// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
// scripts/account-settings.js — account management page (v7.2)
// (moved from profile.js; logic unchanged)
import { initPage, refreshUserUI } from './app.js';
import { state } from './state.js';
import { showToast, friendlyErrorMessage } from './toast.js';
import { showConfirm, showPrompt } from './modal.js';
import { goBack } from '../config/app-config.js';
import { auth, db, doc, setDoc, updateDoc, signOut, serverTimestamp } from '../firebase/firebase-init.js';
// FIX (2026-11-19, v8.11): deleteUser / re-auth ফাংশন firebase-init.js
// export করে না (ওই ফাইল এই ফিক্সের বাইরে), তাই একই 10.12.2 CDN থেকে
// সরাসরি import করা হলো — শুধু ফাংশন import, app আবার init হয় না।
import { deleteUser, EmailAuthProvider, reauthenticateWithCredential } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { sendResetEmail, changeMyFFUID } from '../services/auth.service.js';
import { uploadProfilePhoto, saveProfilePhotoUrl, renderHomeAvatar } from '../services/profile-photo.service.js';


const NAME_MIN = 2;
const NAME_MAX = 25;
const RESET_COOLDOWN_MS = 60 * 1000;
let _photoBusy = false;
let _resetLastAt = 0;

// ── Photo rows: label + "Remove" row depend on whether a photo exists ──
function syncPhotoRows(busyText) {
    const has = !!state.userData?.photoURL;
    const label = document.getElementById('photo-row-label');
    if (label) label.textContent = busyText || (has ? 'Change Profile Photo' : 'Add Profile Photo');
    const rm = document.getElementById('photo-remove-row');
    if (rm) rm.style.display = has ? '' : 'none';
}

function pickProfilePhoto() {
    if (_photoBusy) return;
    document.getElementById('photo-input')?.click();
}

async function onPhotoChosen(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = ''; // lets the user pick the same file again later
    const uid = state.currentUser?.uid;
    if (!file || !uid || _photoBusy) return;

    _photoBusy = true;
    syncPhotoRows('Uploading…');
    try {
        const url = await uploadProfilePhoto(file);
        await saveProfilePhotoUrl(uid, url);
        refreshUserUI();
        syncHero();
        showToast('প্রোফাইল ছবি আপডেট হয়েছে', 'success');
    } catch (err) {
        showToast(friendlyErrorMessage(err), 'error', 4500);
    } finally {
        _photoBusy = false;
        syncPhotoRows();
    }
}

function removeProfilePhoto() {
    const uid = state.currentUser?.uid;
    if (!uid || _photoBusy) return;
    showConfirm('Remove Photo', 'Remove your profile photo? Your initials will be shown instead.', async () => {
        try {
            await saveProfilePhotoUrl(uid, '');
            refreshUserUI();
            syncPhotoRows();
            syncHero();
            showToast('প্রোফাইল ছবি সরানো হয়েছে', 'success');
        } catch (err) {
            showToast('ছবি সরানো যায়নি। আবার চেষ্টা করো।', 'error');
        }
    });
}

// ── Edit name (email is NOT editable: it is the login identity) ──
// v8.11.1 (B4): Free Fire UID IS editable now — editFFUID() below
// (shared changeMyFFUID() flow in services/auth.service.js, with the
// registeredUIDs re-claim). The old "UID NOT editable" rule is gone.
async function editProfileName() {
    const uid = state.currentUser?.uid;
    if (!uid) return;
    const current = state.userData?.name || '';
    // FIX (2026-11-19, v8.11): native prompt() নয় — অ্যাপের নিজের
    // showPrompt modal (ফোনে native prompt বাজে দেখায়)।
    const raw = await showPrompt('Edit Name', 'তোমার নতুন নাম লেখো', { value: current, placeholder: 'তোমার নাম', maxLength: NAME_MAX, okText: 'Save' });
    if (raw === null) return;
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name || name === current) return;
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
        showToast(`নামের দৈর্ঘ্য ${NAME_MIN}–${NAME_MAX} অক্ষরের মধ্যে হতে হবে`, 'warning');
        return;
    }
    try {
        await updateDoc(doc(db, 'users', uid), { name });
        if (state.userData) state.userData.name = name;
        refreshUserUI();
        showToast('নাম আপডেট হয়েছে', 'success');
    } catch (err) {
        showToast('নাম আপডেট করা যায়নি। আবার চেষ্টা করো।', 'error');
    }
}

// ── Edit Free Fire UID (v8.11.1, B4) ──
// Same shared flow as the Profile page: showPrompt modal →
// changeMyFFUID() in services/auth.service.js (validate → claim check →
// profile update → claim txn, with revert on failure). Success is shown
// ONLY when the new claim exists; on failure the old UID stays and the
// user is told so — never a fake "done".
let _ffuidBusy = false;

async function editFFUID() {
    const uid = state.currentUser?.uid;
    if (!uid || _ffuidBusy) return;
    const current = String(state.userData?.ffUID || '').trim();
    const raw = await showPrompt(
        'Free Fire UID বদলাও',
        current ? `বর্তমান UID: ${current} — নতুন UID লেখো (৮–১২ সংখ্যা)` : 'তোমার Free Fire UID লেখো (৮–১২ সংখ্যা)',
        { value: current, placeholder: 'যেমন 1234567890', maxLength: 12, okText: 'বদলাও' }
    );
    if (raw === null) return; // বাতিল
    const next = raw.trim();
    if (!next || next === current) {
        if (next === current) showToast('নতুন UID আগের UID-এর মতোই — অন্য UID দাও', 'warning');
        return;
    }
    _ffuidBusy = true;
    try {
        await changeMyFFUID(next);
        refreshUserUI();
        syncHero();
        syncFFUIDRow();
        showToast('FF UID বদলে গেছে', 'success');
    } catch (err) {
        if (err?.code === 'auth/ffuid-already-in-use' || err?.code === 'auth/invalid-ffuid' || err?.code === 'auth/ffuid-unchanged') {
            showToast(err.message, 'error', 4500);
        } else {
            // Revert already ran inside changeMyFFUID() if the profile
            // had been updated — the old UID is still the live one.
            showToast('FF UID বদলানো যায়নি — পুরনো UID-ই আছে। আবার চেষ্টা করো।', 'error', 4500);
        }
    } finally {
        _ffuidBusy = false;
    }
}

// The HTML has no FF UID edit row — inject one under "Edit Name" (JS DOM
// injection, no HTML edit). The row shows the live UID so the user can
// see what will change before tapping.
function syncFFUIDRow() {
    const sub = document.getElementById('ffuid-edit-sub');
    if (!sub) return;
    const f = String(state.userData?.ffUID || '').trim();
    sub.textContent = f ? `বর্তমান UID: ${f} — বদলাতে ট্যাপ করো` : 'এখনো FF UID দেওয়া হয়নি — ট্যাপ করে যোগ করো';
}

function injectFFUIDRow() {
    if (document.getElementById('ffuid-edit-row')) { syncFFUIDRow(); return; }
    const nameRow = document.querySelector('.acc-row[onclick="editProfileName()"]');
    const row = document.createElement('div');
    row.className = 'acc-row';
    row.id = 'ffuid-edit-row';
    row.innerHTML = `
        <div class="acc-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="13" r="1" fill="currentColor"/><circle cx="18" cy="11" r="1" fill="currentColor"/></svg></div>
        <div class="acc-row-body">
            <div class="acc-row-label">Edit Free Fire UID</div>
            <div class="acc-row-sub" id="ffuid-edit-sub">—</div>
        </div>
        <div class="acc-chev">›</div>`;
    row.addEventListener('click', editFFUID);
    if (nameRow && nameRow.after) nameRow.after(row);
    else document.querySelector('.acc-card')?.appendChild(row);
    syncFFUIDRow();
}

// ── Change password: Firebase emails a secure reset link (no password is
//    ever typed into or handled by this page) ──
function changePassword() {
    const email = state.currentUser?.email;
    if (!email) return;
    const wait = Math.ceil((RESET_COOLDOWN_MS - (Date.now() - _resetLastAt)) / 1000);
    if (wait > 0) {
        showToast(`আরেকটি লিংক পেতে ${wait} সেকেন্ড অপেক্ষা করো`, 'warning');
        return;
    }
    showConfirm('Change Password', `A password reset link will be sent to ${email}.`, async () => {
        try {
            await sendResetEmail(email);
            _resetLastAt = Date.now();
            showToast('রিসেট লিংক পাঠানো হয়েছে। ইনবক্স আর স্প্যাম ফোল্ডার দেখো।', 'success', 4500);
        } catch (err) {
            // v8.6 (G): Firebase auth code-সহ সব error বাংলায় (friendlyErrorMessage)।
            showToast(friendlyErrorMessage(err), 'error');
        }
    });
}

// ── Delete account (FIX 2026-11-19, v8.11): আসল delete — আগে শুধু
//    Help & Support খুলত, কিছু মুছত না। Firebase deleteUser-এর জন্য
//    recent login লাগে, তাই আগে modal-এ পাসওয়ার্ড দিয়ে re-auth করতে হয়।
//    নিয়ম: banned/deleted user-এর টাকা কখনো ফেরত দেওয়া হয় না —
//    confirm লেখায় সেটা পরিষ্কার বলা আছে।
let _deleteBusy = false;

function requestAccountDeletion() {
    if (_deleteBusy) return;
    showConfirm(
        'Delete Account',
        'তোমার অ্যাকাউন্ট সাথে সাথে মুছে যাবে — আর ফিরে পাবে না। Wallet-এর টাকা (Deposit + Winning Balance) কখনো ফেরত দেওয়া হয় না, আর চলমান টুর্নামেন্টের entry-ও বাতিল হবে। নিশ্চিত তো?',
        () => { promptDeletePassword(); }
    );
}

// FIX (2026-11-19, v8.11): পাসওয়ার্ড চাওয়ার modal — showPrompt()
// শুধু text input বানায়, তাই একই confirm-dialog স্টাইলে password
// input-সহ এখানে বানানো হলো। Native prompt() নয়।
function showDeletePasswordPrompt() {
    return new Promise((resolve) => {
        const old = document.getElementById('delete-password-dialog');
        if (old) old.remove();
        const dlg = document.createElement('div');
        dlg.id = 'delete-password-dialog';
        dlg.className = 'confirm-dialog active';
        dlg.innerHTML = `
            <div class="confirm-box">
                <div class="confirm-title">পাসওয়ার্ড দাও</div>
                <div class="confirm-body" style="margin-bottom:16px;">অ্যাকাউন্ট মুছতে তোমার পাসওয়ার্ড দিয়ে নিশ্চিত করো।</div>
                <div class="input-group" style="margin-bottom:20px;">
                    <input type="password" placeholder="তোমার পাসওয়ার্ড" autocomplete="current-password">
                </div>
                <div class="confirm-actions">
                    <button type="button" class="btn btn-secondary confirm-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary confirm-ok">মুছে ফেলো</button>
                </div>
            </div>`;
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            dlg.remove();
            resolve(result);
        };
        dlg.querySelector('.confirm-cancel').addEventListener('click', () => finish(null));
        dlg.querySelector('.confirm-ok').addEventListener('click', () => finish(dlg.querySelector('input').value));
        dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null); });
        dlg.querySelector('input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(dlg.querySelector('input').value); }
            else if (e.key === 'Escape') finish(null);
        });
        document.body.appendChild(dlg);
        dlg.querySelector('input').focus();
    });
}

async function promptDeletePassword() {
    const user = auth.currentUser;
    const email = user?.email;
    if (!user || !email) { showToast('আগে সাইন ইন করো', 'error'); return; }
    const password = await showDeletePasswordPrompt();
    if (!password) return; // বাতিল
    _deleteBusy = true;
    try {
        const cred = EmailAuthProvider.credential(email, password);
        await reauthenticateWithCredential(user, cred);
        // v8.11.1 (S11): FIRST write the deletion ticket — the Auth user
        // must NEVER be deleted without it, or the users/{uid} doc (name /
        // FF UID / wallet / leaderboard data) would stay live with no
        // record for admin to clean up. If the ticket write fails, abort
        // here: the account stays, the user is told to retry.
        try {
            await setDoc(doc(db, 'accountDeletionRequests', user.uid), {
                userId: user.uid,
                userName: state.userData?.name || '',
                ffUID: state.userData?.ffUID || '',
                createdAt: serverTimestamp()
            });
        } catch (ticketErr) {
            showToast('ডিলিটের অনুরোধ জমা হয়নি — অ্যাকাউন্ট মোছা হয়নি। আবার চেষ্টা করো।', 'error', 4500);
            return;
        }
        await deleteUser(user);
        // FIX (2026-11-19, v8.11): users/{uid} doc নিজে মোছা যায় না —
        // firestore.rules-এ `allow delete: if isAdmin();` (owner-কে deny),
        // আর update allow-list-এও delete-ফ্ল্যাগের কোনো ফিল্ড নেই। তাই
        // doc মোছার ভান করা হয় না — admin-এর Delete User ফ্লো প্রোফাইল
        // রেকর্ড মুছে দেবে। Auth user মুছে গেছে, তাই sign-out করতেই হবে।
        await signOut(auth).catch(() => {});
        showToast('অ্যাকাউন্ট মুছে গেছে। প্রোফাইল রেকর্ড admin মুছে দেবে।', 'success', 5000);
        setTimeout(() => { window.location.href = '../pages/login.html'; }, 1200);
    } catch (err) {
        if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential' || err?.code === 'auth/invalid-login-credentials') {
            showToast('পাসওয়ার্ড ভুল হয়েছে। আবার চেষ্টা করো।', 'error');
        } else if (err?.code === 'auth/requires-recent-login') {
            showToast('আবার সাইন ইন করে চেষ্টা করো।', 'error');
        } else {
            showToast(friendlyErrorMessage(err), 'error', 4500);
        }
    } finally {
        _deleteBusy = false;
    }
}

window.pickProfilePhoto = pickProfilePhoto;
window.removeProfilePhoto = removeProfilePhoto;
window.editProfileName = editProfileName;
window.editFFUID = editFFUID;
window.changePassword = changePassword;
window.requestAccountDeletion = requestAccountDeletion;
window.goBack = goBack;

// ── Hero: avatar / name / email / FF UID ──
function syncHero() {
    const u = state.userData || {};
    const nameEl = document.getElementById('acc-name');
    if (nameEl) nameEl.textContent = u.name || '—';
    const emailEl = document.getElementById('acc-email');
    if (emailEl) emailEl.textContent = state.currentUser?.email || '—';
    const uidEl = document.getElementById('acc-uid');
    if (uidEl) uidEl.textContent = 'UID: ' + (u.ffUID || '—');
    // FIX (2026-11-19, P4): own mobile, read-only — never a fake number.
    const phoneEl = document.getElementById('acc-phone');
    if (phoneEl) phoneEl.textContent = 'Mobile: ' + (u.phone || '—');
    const sub = document.getElementById('acc-name-sub');
    if (sub) sub.textContent = u.name ? `Currently "${u.name}"` : 'Your display name';
    syncFFUIDRow();
    renderHomeAvatar(document.getElementById('acc-avatar'), u, 192);
}

initPage({
    page: 'accountSettings',
    onReady: () => {
        syncPhotoRows();
        syncHero();
        injectFFUIDRow();
        const input = document.getElementById('photo-input');
        if (input && !input.dataset.wired) {
            input.dataset.wired = '1';
            input.addEventListener('change', onPhotoChosen);
        }
    }
});

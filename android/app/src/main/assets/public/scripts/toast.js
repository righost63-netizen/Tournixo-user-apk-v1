// UNSLOP final assembly (2026-11-06): TOAST_ICONS was removed from
// utils/constants.js — it held emoji icons and is unused now; the
// message text is still set via textContent — only the static icon
// goes through innerHTML.
const _ic = inner => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const TOAST_ICON_SVGS = {
    success: _ic('<path d="M20 6 9 17l-5-5"/>'),
    error: _ic('<circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/>'),
    info: _ic('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    warning: _ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    default: _ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>')
};

export function showToast(msg, type = 'default', dur = 3000) {
    let c = document.getElementById('toast-container');
    if (!c) {
        c = document.createElement('div');
        c.id = 'toast-container';
        (document.getElementById('app') || document.body).appendChild(c);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    // textContent (not innerHTML): messages include user-controlled text such as
    // team names, and must never be interpreted as HTML.
    const icon = document.createElement('span');
    icon.className = 'toast-ic';
    icon.innerHTML = TOAST_ICON_SVGS[type] || TOAST_ICON_SVGS.default;
    const text = document.createElement('span');
    text.textContent = String(msg ?? '');
    t.append(icon, text);
    c.appendChild(t);
    setTimeout(() => {
        t.classList.add('hide');
        setTimeout(() => t.remove(), 300);
    }, dur);
}

// Multi-page helper: a toast that must survive a page change
// (e.g. "Signed out successfully", "Welcome back!"). It is shown on the next page.
const FLASH_KEY = 'ff_flash_toast';

export function flashToast(msg, type = 'default', dur = 3000) {
    try {
        sessionStorage.setItem(FLASH_KEY, JSON.stringify({
            msg,
            type,
            dur
        }));
    } catch (e) {}
}

export function showPendingFlash() {
    try {
        const raw = sessionStorage.getItem(FLASH_KEY);
        if (!raw) return;
        sessionStorage.removeItem(FLASH_KEY);
        const f = JSON.parse(raw);
        if (f && f.msg) showToast(f.msg, f.type, f.dur);
    } catch (e) {}
}

// v8.6 (G): toast-এ কখনো raw English / Firebase error দেখাবে না —
// err.message / err.code এখানে map করে সহজ বাংলায় ফেরত দেয়। Service-এর
// নিজের বাংলা message থাকলে সেটাই ফেরত যায়; অচেনা error-এ সাধারণ বাংলা
// message যায় (আসল error console-এ থাকে, যাতে debug করা যায়)।
const _STATUS_BN = { upcoming: 'শুরু হয়নি', ongoing: 'চলছে', completed: 'শেষ হয়ে গেছে' };
const _statusBn = s => _STATUS_BN[String(s || '').toLowerCase()] || String(s || '');
const _BN_ERROR_EXACT = {
    'Payment settings are unavailable. Payment is currently disabled.': 'পেমেন্টের তথ্য পাওয়া যায়নি। পেমেন্ট এখন বন্ধ আছে।',
    'Payment settings are incomplete. Payment is currently disabled.': 'পেমেন্টের তথ্য অসম্পূর্ণ। পেমেন্ট এখন বন্ধ আছে।',
    'Unable to load payment settings. Payment is currently disabled.': 'পেমেন্টের তথ্য লোড হয়নি। পেমেন্ট এখন বন্ধ আছে।',
    'Invalid payment amount.': 'পেমেন্টের পরিমাণ সঠিক নয়।',
    'Invalid team information.': 'টিমের তথ্য সঠিক নয়।',
    'Transaction ID is required.': 'Transaction ID দরকার।',
    'Tournament not found or has been removed': 'টুর্নামেন্ট পাওয়া যায়নি',
    'Tournament not found': 'টুর্নামেন্ট পাওয়া যায়নি',
    'This tournament is free and does not require payment': 'এটা ফ্রি টুর্নামেন্ট — পেমেন্ট লাগবে না।',
    'Team registration not found. Please register your team first.': 'টিমের রেজিস্ট্রেশন পাওয়া যায়নি। আগে টিম রেজিস্টার করো।',
    'Unauthorized: Only the team captain can submit payment.': 'শুধু টিমের ক্যাপ্টেন পেমেন্ট জমা দিতে পারবে।',
    'This team is already confirmed and paid for': 'এই টিম ইতিমধ্যে কনফার্ম ও পেমেন্ট করা হয়েছে।',
    'You already have a payment pending verification for this team': 'এই টিমের একটি পেমেন্ট ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে।',
    'You already have a wallet payment pending verification for this team': 'এই টিমের একটি wallet পেমেন্ট ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে।',
    'This team was rejected by the admin. Please join again via the new join flow to create a fresh request.': 'অ্যাডমিন এই টিমটি বাতিল করেছেন। নতুন করে জয়েন করো।',
    'Could not verify this Transaction ID. Please double-check it and try again.': 'এই Transaction ID যাচাই করা যায়নি। আবার দেখে চেষ্টা করো।',
    'This Transaction ID has already been submitted': 'এই Transaction ID আগেই জমা দেওয়া হয়েছে।',
    'You already have an active team registered in this tournament': 'এই টুর্নামেন্টে তোমার টিম ইতিমধ্যে রেজিস্টার করা আছে।',
    'Tournament is already full': 'টুর্নামেন্ট পূর্ণ হয়ে গেছে।',
    'Team ID collision detected. Please tap Confirm again': 'কিছু একটা গণ্ডগোল হয়েছে। আবার Confirm চাপো।',
    'Your profile has no Free Fire UID saved. Please save it in your profile first, then join.': 'তোমার প্রোফাইলে Free Fire UID সেভ করা নেই। আগে প্রোফাইলে UID সেভ করো, তারপর জয়েন করো।',
    'Captain Free Fire UID does not match your profile. Please check your profile and try again.': 'ক্যাপ্টেনের Free Fire UID প্রোফাইলের সঙ্গে মিলছে না। প্রোফাইল দেখে আবার চেষ্টা করো।',
    'Your profile could not be loaded. Please try again.': 'তোমার প্রোফাইল লোড হয়নি। আবার চেষ্টা করো।',
    'User account not found': 'অ্যাকাউন্ট পাওয়া যায়নি।',
    'Invalid deposit amount.': 'ডিপোজিটের পরিমাণ সঠিক নয়।',
    'Invalid withdrawal amount.': 'উত্তোলনের পরিমাণ সঠিক নয়।',
    'Unsupported withdrawal method.': 'এই উত্তোলনের মাধ্যমটি সমর্থিত নয়।',
    'Please enter a valid UPI ID (e.g. 9876543210@upi)': 'সঠিক UPI ID দাও (যেমন: 9876543210@upi)',
    'Please enter a valid alphanumeric Transaction / UTR ID (min 8 characters, no spaces)': 'সঠিক Transaction / UTR ID দাও (কমপক্ষে ৮ অক্ষর, space ছাড়া)',
    'You already have 3 pending deposit requests. Please wait for them to be reviewed.': 'তোমার ৩টি ডিপোজিট আবেদন ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে। যাচাই শেষ হলে আবার আবেদন করো।',
    'You already have 3 pending withdrawal requests. Please wait for them to be reviewed.': 'তোমার ৩টি উত্তোলনের আবেদন ইতিমধ্যে যাচাইয়ের অপেক্ষায় আছে। যাচাই শেষ হলে আবার আবেদন করো।',
    'Enter a valid 8–12 digit Free Fire UID': 'সঠিক ৮–১২ সংখ্যার Free Fire UID দাও',
    "You can't report yourself": 'নিজেকে রিপোর্ট করা যাবে না',
    'Please choose a valid reason': 'একটি সঠিক কারণ বেছে নাও',
    'Could not read this image. Please choose a JPG or PNG photo.': 'এই ছবিটি পড়া যায়নি। JPG বা PNG ছবি বেছে নাও।',
    'Could not process this image. Try a different photo.': 'এই ছবিটি প্রসেস করা যায়নি। অন্য ছবি চেষ্টা করো।',
    'Photo upload is not set up yet.': 'ছবি আপলোড এখনো চালু হয়নি।',
    'Please choose an image file.': 'একটি ছবির ফাইল বেছে নাও।',
    'Upload failed. Please try again.': 'আপলোড হয়নি। আবার চেষ্টা করো।',
    'Upload failed': 'আপলোড হয়নি। আবার চেষ্টা করো।',
    'Photo upload failed': 'ছবি আপলোড হয়নি। আবার চেষ্টা করো।',
    'Upload timed out. Check your connection and try again.': 'আপলোডের সময় শেষ হয়ে গেছে। ইন্টারনেট দেখে আবার চেষ্টা করো।',
    'Network error. Check your connection and try again.': 'নেটওয়ার্ক সমস্যা হয়েছে। ইন্টারনেট দেখে আবার চেষ্টা করো।',
    'Network error': 'নেটওয়ার্ক সমস্যা হয়েছে।',
    'network error': 'নেটওয়ার্ক সমস্যা হয়েছে।',
    'Please enter your Team Name': 'তোমার দলের নাম দাও',
    'Team Name must be 25 characters or less': 'দলের নাম ২৫ অক্ষরের বেশি হতে পারবে না',
    'Duplicate Free Fire UIDs detected in your team!': 'তোমার টিমে একই Free Fire UID দুইবার আছে!',
    'Please add at least Player 2 (DUO-এর জন্য Mate 1 আবশ্যক)': 'কমপক্ষে Player 2 যোগ করো (DUO-এর জন্য Mate 1 আবশ্যক)',
    'Could not submit the deposit request. Please try again.': 'ডিপোজিট আবেদন জমা হয়নি। আবার চেষ্টা করো।',
    'You do not have permission for this action. Please sign in again.': 'এই কাজের অনুমতি নেই। আবার সাইন ইন করো।',
    'Server issue. Please try again in a bit.': 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।',
    'Too many attempts. Please try again later.': 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করো।',
    'Could not send the reset link. Please try again.': 'রিসেট লিংক পাঠানো যায়নি। আবার চেষ্টা করো।',
    'Permission denied. Please sign in again — if this persists, contact support.': 'অনুমতি পাওয়া যায়নি। আবার সাইন ইন করো — সমস্যা থাকলে সাপোর্টের সঙ্গে যোগাযোগ করো।',
    'Unknown error': 'অজানা সমস্যা হয়েছে। আবার চেষ্টা করো।',
    'team': 'আগে My Team পেজে গিয়ে নিজের team বানাও।'
};
const _BN_ERROR_CODE = {
    'auth/wrong-password': 'ইমেইল বা পাসওয়ার্ড ভুল। আবার চেষ্টা করো।',
    'auth/invalid-credential': 'ইমেইল বা পাসওয়ার্ড ভুল। আবার চেষ্টা করো।',
    'auth/user-not-found': 'এই ইমেইল দিয়ে কোনো অ্যাকাউন্ট পাওয়া যায়নি।',
    'auth/email-already-in-use': 'এই ইমেইল দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে।',
    'auth/weak-password': 'পাসওয়ার্ড অনেক দুর্বল। আরও শক্ত পাসওয়ার্ড দাও।',
    'auth/invalid-email': 'ইমেইলের ঠিকানাটি সঠিক নয়।',
    'auth/too-many-requests': 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করো।',
    'auth/network-request-failed': 'নেটওয়ার্ক সমস্যা হয়েছে। ইন্টারনেট দেখে আবার চেষ্টা করো।',
    'auth/user-disabled': 'এই অ্যাকাউন্টটি বন্ধ করা হয়েছে। সাপোর্টের সঙ্গে যোগাযোগ করো।',
    'auth/requires-recent-login': 'আবার সাইন ইন করে চেষ্টা করো।',
    'auth/account-exists-with-different-credential': 'এই ইমেইল দিয়ে অন্য মাধ্যমে অ্যাকাউন্ট আছে।',
    'auth/popup-closed-by-user': 'সাইন ইন বাতিল হয়েছে। আবার চেষ্টা করো।',
    'auth/cancelled-popup-request': 'সাইন ইন বাতিল হয়েছে। আবার চেষ্টা করো।',
    'auth/operation-not-allowed': 'এই সাইন ইন পদ্ধতিটি এখন বন্ধ আছে।',
    'auth/missing-email': 'ইমেইল দাও।',
    'auth/missing-password': 'পাসওয়ার্ড দাও।',
    'auth/invalid-verification-code': 'ভেরিফিকেশন কোডটি সঠিক নয়।',
    'auth/invalid-verification-id': 'ভেরিফিকেশন কোডটি সঠিক নয়।',
    'auth/code-expired': 'কোডের মেয়াদ শেষ হয়ে গেছে। আবার পাঠাও।',
    'auth/quota-exceeded': 'অনেক অনুরোধ পাঠানো হয়েছে। পরে আবার চেষ্টা করো।',
    'auth/invalid-action-code': 'লিংকটির মেয়াদ শেষ হয়ে গেছে বা ভুল। আবার পাঠাও।',
    'auth/expired-action-code': 'লিংকটির মেয়াদ শেষ হয়ে গেছে বা ভুল। আবার পাঠাও।',
    'permission-denied': 'এই কাজের অনুমতি নেই। আবার সাইন ইন করো।',
    'unauthenticated': 'সেশন শেষ হয়ে গেছে। আবার সাইন ইন করো।',
    'unavailable': 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।',
    'resource-exhausted': 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।',
    'failed-precondition': 'এই কাজটি এখন করা যাবে না। আবার চেষ্টা করো।',
    'already-exists': 'এটি আগেই জমা দেওয়া হয়েছে।',
    'not-found': 'তথ্যটি পাওয়া যায়নি।',
    'deadline-exceeded': 'সময় শেষ হয়ে গেছে। আবার চেষ্টা করো।'
};
const _BN_ERROR_PATTERNS = [
    [/^Minimum deposit amount is ₹(.+)$/, m => `সর্বনিম্ন ডিপোজিট ₹${m[1]}`],
    [/^Maximum deposit amount is ₹(.+)$/, m => `সর্বোচ্চ ডিপোজিট ₹${m[1]}`],
    [/^Minimum withdrawal amount is ₹(.+)$/, m => `সর্বনিম্ন উত্তোলন ₹${m[1]}`],
    [/^Minimum withdrawal is ₹(.+)\. Your available balance is ₹(.+)$/, m => `সর্বনিম্ন উত্তোলন ₹${m[1]}। তোমার উপলব্ধ ব্যালেন্স ₹${m[2]}`],
    [/^Insufficient Deposit Balance: available ₹(.+), entry fee ₹(.+)\. Please add money to your wallet first\.$/, m => `Deposit Balance যথেষ্ট নয়: আছে ₹${m[1]}, এন্ট্রি ফি ₹${m[2]}। আগে Wallet-এ টাকা যোগ করো।`],
    [/^Insufficient Deposit Balance: available ₹(.+), entry fee ₹(.+)\.$/, m => `Deposit Balance যথেষ্ট নয়: আছে ₹${m[1]}, এন্ট্রি ফি ₹${m[2]}।`],
    [/^Insufficient Deposit Balance: you already have ₹(.+) pending, available is ₹(.+)\.$/, m => `Deposit Balance যথেষ্ট নয়: ₹${m[1]} ইতিমধ্যে pending আছে, উপলব্ধ ₹${m[2]}।`],
    [/^Insufficient balance: you already have ₹(.+) pending, available is ₹(.+)\.$/, m => `ব্যালেন্স যথেষ্ট নয়: ₹${m[1]} ইতিমধ্যে pending আছে, উপলব্ধ ₹${m[2]}।`],
    [/^Insufficient balance: Available ₹(.+)$/, m => `ব্যালেন্স যথেষ্ট নয়: উপলব্ধ ₹${m[1]}`],
    [/^Free Fire UID \((.+)\) is already registered in this tournament!?$/, m => `Free Fire UID (${m[1]}) এই টুর্নামেন্টে ইতিমধ্যে রেজিস্টার করা আছে!`],
    [/^Slot (\d+) is already booked — please choose another slot\.$/, m => `Slot ${m[1]} ইতিমধ্যে বুক হয়ে গেছে — অন্য Slot বেছে নাও।`],
    [/^Please choose a slot between 1 and (\d+)\.$/, m => `1 থেকে ${m[1]}-এর মধ্যে একটি Slot বেছে নাও।`],
    [/^Cannot submit payment\. Tournament is currently (.+)$/, m => `পেমেন্ট জমা দেওয়া যাবে না। টুর্নামেন্ট এখন ${_statusBn(m[1])} অবস্থায় আছে।`],
    [/^Cannot join\. Tournament is currently (.+)$/, m => `জয়েন করা যাবে না। টুর্নামেন্ট এখন ${_statusBn(m[1])} অবস্থায় আছে।`],
    [/^Image is too large\. Max (\d+) MB\.$/, m => `ছবিটি অনেক বড়। সর্বোচ্চ ${m[1]} MB।`],
    [/^Report limit reached \((\d+)\/day\)\. Try again tomorrow\.$/, m => `রিপোর্টের সীমা শেষ (${m[1]}/দিন)। আগামীকাল আবার চেষ্টা করো।`],
    [/^Please enter Player (\d+) Name$/, m => `Player ${m[1]}-এর নাম দাও`],
    [/^Player (\d+) Name must be 25 characters or less$/, m => `Player ${m[1]}-এর নাম ২৫ অক্ষরের বেশি হতে পারবে না`],
    [/^Please enter Player (\d+) Gaming UID$/, m => `Player ${m[1]}-এর Gaming UID দাও`],
    [/^Player (\d+) UID must be 8–12 digits$/, m => `Player ${m[1]}-এর UID ৮–১২ সংখ্যার হতে হবে`]
];
export function friendlyErrorMessage(err) {
    const code = String(err?.code || '');
    if (code && _BN_ERROR_CODE[code]) return _BN_ERROR_CODE[code];
    const raw = String(err?.message ?? err ?? '').trim();
    if (!raw) return 'কিছু একটা ভুল হয়েছে। আবার চেষ্টা করো।';
    if (/[\u0980-\u09FF]/.test(raw)) return raw;
    if (_BN_ERROR_EXACT[raw]) return _BN_ERROR_EXACT[raw];
    for (const [re, fn] of _BN_ERROR_PATTERNS) {
        const m = raw.match(re);
        if (m) return fn(m);
    }
    console.warn('[toast] unmapped error shown as generic Bengali:', code, raw);
    return 'কিছু একটা ভুল হয়েছে। আবার চেষ্টা করো।';
}

window.showToast = showToast;
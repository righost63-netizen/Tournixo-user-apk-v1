// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
// SLOT BOOKING (v8.3, 2026-11-11) — user picks their own slot number.
//
// SLOT MODEL — একটা slot = একটা team-এর জায়গা (SOLO-তে 1 player,
// DUO/SQUAD-তে 1 team)। Slot নম্বর 1..maxTeams (v8.8: SOLO 50 / DUO 24 /
// SQUAD 12 — SOLO default 48 → 50, rules v19 slot cap + admin default-এর
// সঙ্গে মিলিয়ে; tournament doc-এর maxTeams-ই authority)।
//
// TAKEN-SLOT SOURCE (picker display, txn-এর বাইরে):
//   1. tournamentTeams — status 'confirmed' বা 'pending' team-দের
//      roomSlot (পুরনো auto-assign করা team-দের slot-ও এখান থেকে আসে —
//      ওদের কোনো slot-lock doc নেই, তাই শুধু lock পড়লে ওদের slot ফাঁকা
//      দেখাত, যা ভুল হতো। pending team-ও seat ধরে রাখে।)
//   2. tournamentSlots — status 'confirmed' lock-দের slot, তবে শুধু
//      তখনই taken ধরা হয় যখন lock-এর team-টা এখনো confirmed/pending
//      আছে (team rejected/deleted হলে lock-টা মৃত — display-তেও ফাঁকা,
//      txn-এও squat-heal হবে; নিচে দেখো)।
//   Display ভুল হলে ক্ষতি নেই — আসল guard txn-এর ভেতরে (slot-lock
//   doc + squat check), display শুধু ভুল slot-এ click বাঁচায়। কোনো
//   slot display-তে ফাঁকা দেখিয়ে আসলে taken হলে txn 'slot-taken'
//   error দিয়ে ফেরত পাঠাবে, double-booking হবে না।
//
// ATOMICITY — Firestore txn-এর ভেতরে query করা যায় না, তাই slot-এর
// দখল একটা deterministic doc দিয়ে গার্ড করা হয়, ঠিক যেমন
// tournamentPlayerUIDs / tournamentCaptains lock-গুলো করে:
//   tournamentSlots/{tournamentId}_{slot}
// একই slot-এ দুটো txn একসঙ্গে লিখতে গেলে একটা retry-তে lock দেখে
// abort হবে — একই slot দুজন পাবে না।

import { db, collection, query, where, limit, getDocs } from '../firebase/firebase-init.js';

export const SLOT_TAKEN_CODE = 'slot-taken';
export const INSUFFICIENT_BALANCE_CODE = 'insufficient-balance';

// Slot নম্বর বৈধ কি না — 1..maxTeams-এর integer।
export function isValidSlot(slot, maxTeams) {
    const n = Number(slot);
    const max = Number(maxTeams || 0);
    return Number.isInteger(n) && n >= 1 && (max <= 0 || n <= max);
}

// Picker-এর জন্য taken slot-গুলোর Set + আটকে থাকা (stuck) slot-গুলো।
// v8.8 (item 4): teamId-হীন confirmed lock-ই একমাত্র সত্যিকারের
// stuck slot — txn-এ ওটা squat-heal করা যায় না (কোন team দেখবে
// তার প্রমাণ নেই), তাই picker-এ ওটা আর "খালি" দেখানো যাবে না:
// taken-এ ধরা হয় + stuck list-এ ফেরত যায়, যাতে picker বাংলায়
// জানাতে পারে "Slot X আটকে আছে — অ্যাডমিনকে জানাও"। teamId আছে
// কিন্তু team-টা map-এ নেই (rejected/deleted) → আগের মতোই ফাঁকা,
// txn ওটা squat-heal করবে (H7)।
export async function fetchSlotStates(tournamentId) {
    const taken = new Set();
    const stuck = [];
    if (!tournamentId) return { taken, stuck };

    // 1) Seat ধরে রাখা team-দের roomSlot (confirmed + legacy pending —
    // দুটোই seat ধরে রাখে)।
    // FIX (2026-11-20, A9): limit(50) ঠিক SOLO cap-এর গায়ে বসা ছিল —
    // legacy pending / admin-বানানো team মিলে 50 ছাড়ালে 51তম team-টা
    // query-তে কাটা পড়ত, আর তার দখল করা slot picker-এ খালি দেখাত
    // (txn backstop তখন 'slot-taken' দিয়ে ফেরত পাঠাত, কিন্তু display
    // ভুল থাকত)। limit(100) — lock query-র সমান; status filter থাকায়
    // আগের বিনা-filter limit(100)-এর churn-সমস্যা এখানে নেই।
    // teamStatusById: lock-এর team এখনো seat ধরে আছে কি না দেখার জন্য।
    const teamStatusById = new Map();
    try {
        const teamSnap = await getDocs(query(
            collection(db, 'tournamentTeams'),
            where('tournamentId', '==', tournamentId),
            where('status', 'in', ['confirmed', 'pending']),
            limit(100)
        ));
        teamSnap.forEach(d => {
            const tm = d.data() || {};
            teamStatusById.set(d.id, tm.status || '');
            // FIX (2026-11-11, H5): confirmed + pending দুটোরই roomSlot
            // taken — pending team-ও seat ধরে রাখে।
            if (tm.status === 'confirmed' || tm.status === 'pending') {
                const s = Number(tm.roomSlot);
                if (Number.isInteger(s) && s >= 1) taken.add(s);
            }
        });
    } catch (e) {
        // Team list না পেলে slot list-ই অবিশ্বাস্য — caller fail-closed
        // হবে (picker error দেখাবে, submit বন্ধ থাকবে)।
        throw new Error('Slot list load হয়নি: ' + (e?.message || 'নেটওয়ার্ক সমস্যা'));
    }

    // 2) Slot-lock doc-গুলো। Lock-এর team confirmed/pending না থাকলে
    // (kick / reject / delete) lock-টা মৃত — taken-এ ধরা হবে না।
    try {
        const lockSnap = await getDocs(query(
            collection(db, 'tournamentSlots'),
            where('tournamentId', '==', tournamentId),
            limit(100)
        ));
        lockSnap.forEach(d => {
            const lk = d.data() || {};
            const s = Number(lk.slot);
            if (!Number.isInteger(s) || s < 1) return;
            if (lk.status !== 'confirmed') return;
            // v8.8 (item 4): teamId-হীন confirmed lock — stuck। Picker-এ
            // Booked দেখাও + stuck list-এ রাখো (user-side delete নেই —
            // শুধু admin ছাড়াতে পারবে)।
            if (!lk.teamId) {
                taken.add(s);
                if (!stuck.includes(s)) stuck.push(s);
                return;
            }
            // FIX (2026-11-11, H7): lock-এর team map-এ নেই (rejected /
            // expired / deleted) → slot ফাঁকা দেখাও, txn arbitrate করবে
            // (squat-heal)। আগে unknown teamId-ও taken ধরা হতো, slot
            // চিরকাল Booked দেখাত।
            if (teamStatusById.has(lk.teamId)) {
                taken.add(s);
            }
            // team map-এ নেই → ফাঁকা, কিছু করো না।
        });
    } catch (e) {
        // tournamentSlots collection rules v17-এর আগে না থাকলে এই query
        // permission-denied দেবে — সেটাও fail-closed (picker error)।
        throw new Error('Slot list load হয়নি: ' + (e?.message || 'নেটওয়ার্ক সমস্যা'));
    }

    stuck.sort((a, b) => a - b);
    return { taken, stuck };
}

// Picker-এর জন্য taken slot-গুলোর Set (fetchSlotStates-এর wrapper)।
export async function fetchTakenSlots(tournamentId) {
    const { taken } = await fetchSlotStates(tournamentId);
    return taken;
}

// v8.8 (item 4): শুধু stuck slot নম্বরগুলো (teamId-হীন confirmed lock)।
export async function fetchStuckSlots(tournamentId) {
    const { stuck } = await fetchSlotStates(tournamentId);
    return stuck;
}

// ── Shared slot-picker grid (Free modal + Paid page দুটোতেই একই UI) ──
// container: খালি div; onSelect(slot): user কোনো available slot-এ tap
// করলে ডাকা হবে। taken: Set<number>। selected: এখন যেটা বেছে নেওয়া।
// Lime = selected, আবছা + কাটা = Booked — locked direction (একটাই lime
// #C7FF3E, dark neutral, কোনো gradient/glow নেই)।
export function renderSlotGrid(container, { maxTeams, taken, selected, onSelect }) {
    if (!container) return;
    const max = Number(maxTeams || 0);
    if (!(max > 0)) {
        container.innerHTML = '<div class="slot-picker-note">Slot list পাওয়া যায়নি।</div>';
        return;
    }
    const takenSet = taken instanceof Set ? taken : new Set(taken || []);
    // PREMIUM GRID (2026-11-13): panel wrapper + খালি count — শুধু markup,
    // button-এর class / data-slot / disabled / onSelect wiring একই আছে।
    let freeCount = 0;
    for (let n = 1; n <= max; n++) if (!takenSet.has(n)) freeCount++;
    let html = '<div class="slot-picker-panel">';
    html += '<div class="slot-picker-head"><div class="slot-picker-title">তোমার Slot বেছে নাও</div>'
        + `<span class="slot-picker-count">${freeCount} খালি / ${max}</span></div>`;
    html += '<div class="slot-picker-legend"><span><i class="slot-dot slot-dot-free"></i>খালি</span>'
        + '<span><i class="slot-dot slot-dot-taken"></i>Booked</span>'
        + '<span><i class="slot-dot slot-dot-selected"></i>তোমার Slot</span></div>';
    html += '<div class="slot-grid">';
    for (let n = 1; n <= max; n++) {
        const isTaken = takenSet.has(n);
        const isSel = Number(selected) === n;
        html += `<button type="button" class="slot-btn${isTaken ? ' slot-taken' : ''}${isSel ? ' slot-selected' : ''}" `
            + `data-slot="${n}" ${isTaken ? 'disabled' : ''} aria-label="Slot ${n}${isTaken ? ' (Booked)' : ''}">${n}</button>`;
    }
    html += '</div>';
    // PREMIUM GRID (2026-11-13): বাছা slot-এ note-টা lime status bar হয়।
    html += `<div class="slot-picker-note${selected ? ' slot-picker-note--selected' : ''}" data-slot-note>${selected
        ? `Slot ${selected} বেছে নিয়েছো — Confirm করলেই এই Slot তোমার।`
        : 'খালি Slot-এ tap করো — একই Slot দুজন নিতে পারবে না।'}</div>`;
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.slot-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            const n = Number(btn.dataset.slot);
            if (typeof onSelect === 'function') onSelect(n);
        });
    });
}

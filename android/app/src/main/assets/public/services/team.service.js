// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
// ── My Team (Profile) — v8.0 ─────────────────────────────────────────
// DUO / SQUAD join-এর আগে user-কে অবশ্যই Profile থেকে নিজের team বানিয়ে
// রাখতে হবে — এটাই v8.0-এর নিয়ম। SOLO-তে team লাগে না, profile FF UID-ই
// যথেষ্ট। এক user = এক team doc (teams/{uid})।
// Rule (firestore.rules v15, teams match): create-এ captainUid == uid এবং
// members.size() <= 3 হতে হবে — তাই doc-এ members array সবসময় থাকে
// (খালি mate বাদ দিয়ে, সর্বোচ্চ 3 জন)। Join-এর সময় roster আর হাতে
// টাইপ হয় না: submit-এর মুহূর্তে এই doc থেকেই players বানানো হয়, যাতে
// DOM বদলে অন্য UID ঢোকানো না যায়। পুরনো manual tournamentTeams entry
// গুলোতে এর কোনো প্রভাব নেই — gate শুধু নতুন join-এ।
import { db, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from '../firebase/firebase-init.js';
import { isNumeric } from '../utils/validators.js';

export function validateTeamInput(teamName, members, captainFFUID) {
    if (!String(teamName || '').trim()) return 'তোমার দলের নাম দাও';
    if (String(teamName).trim().length > 25) return 'দলের নাম ২৫ অক্ষরের বেশি হতে পারবে না';
    // v8.11.1 (K2/A7): captain-এর নিজের FF UID ছাড়া team save করা যাবে
    // না — captainFFUID '' হলে join-এর সময় roster-এ খালি UID যেত।
    // (my-team.js save-এর আগে fresh users doc থেকেও এটা যাচাই করে।)
    const captain = String(captainFFUID || '').trim();
    if (!captain) return 'তোমার নিজের Free Fire UID প্রোফাইলে নেই — আগে Profile থেকে FF UID যোগ করো, তারপর টিম সেভ করো';
    // v8.11.1 (K2): 1–3 জন mate — DUO-এর জন্য 1 জনই যথেষ্ট, SQUAD-এর
    // জন্য 3 জন লাগে (সেটা teamPlayersForFormat()-এ enforce হয়, এখানে
    // নয়)। খালি mate row (নাম + UID দুটোই খালি) = mate নেই, বাদ যাবে;
    // আধা-ভরা row (নাম ছাড়া UID, বা UID ছাড়া নাম) = ভুল, জানাতে হবে।
    // members[i].slot থাকলে (my-team.js readTeamForm দেয়) সেই Player
    // নম্বরটাই দেখানো হয়, নইলে index থেকে ধরা হয়।
    const seen = new Set([captain]);
    let mateCount = 0;
    for (let i = 0; i < (members || []).length; i++) {
        const m = members[i] || {};
        const label = m.slot ? `Player ${m.slot}` : `Player ${i + 2}`;
        const name = String(m.name || '').trim();
        const uid = String(m.ffUID || '').trim();
        if (!name && !uid) continue; // খালি row — mate নেই
        if (!name) return `${label}-এর নাম দাও`;
        if (name.length > 25) return `${label}-এর নাম ২৫ অক্ষরের বেশি হতে পারবে না`;
        if (!uid) return `${label}-এর Gaming UID দাও`;
        if (!isNumeric(uid) || !/^\d{8,12}$/.test(uid)) return `${label}-এর UID ৮–১২ সংখ্যার হতে হবে`;
        if (seen.has(uid)) return 'তোমার টিমে একই Free Fire UID দুইবার আছে!';
        seen.add(uid);
        mateCount++;
    }
    if (mateCount < 1) return 'DUO join-এর জন্য অন্তত Mate 1-এর নাম + Free Fire UID দাও';
    return null;
}

export async function getMyTeam(uid) {
    if (!uid) return null;
    try {
        const snap = await getDoc(doc(db, 'teams', uid));
        if (!snap.exists()) return null;
        const d = snap.data();
        return {
            teamName: d.teamName || '',
            captainUid: d.captainUid || uid,
            captainName: d.captainName || '',
            captainFFUID: d.captainFFUID || '',
            members: Array.isArray(d.members) ? d.members : []
        };
    } catch (e) {
        // v8.8 (item 7): read fail (network / permission-denied) আর
        // "team নেই" এক নয় — null ফেরত দিলে caller ভুল করে user-কে
        // "team বানাও" বলে My Team পেজে পাঠাত। এখন typed error throw
        // হয় — caller retry message দেখাবে, My Team-এ পাঠাবে না।
        // Genuinely-no-team এখনো null ফেরে (উপরের !snap.exists())।
        const err = new Error('টিম লোড হয়নি — ইন্টারনেট চেক করে আবার চেষ্টা করো');
        err.code = 'team-load-failed';
        err.cause = e;
        throw err;
    }
}

export async function saveMyTeam(uid, captain, teamName, members) {
    const clean = members
        .map(m => ({ name: String(m.name || '').trim(), ffUID: String(m.ffUID || '').trim() }))
        .filter(m => m.name && m.ffUID);
    await setDoc(doc(db, 'teams', uid), {
        captainUid: uid,
        captainName: captain.name || '',
        captainFFUID: captain.ffUID || '',
        teamName: String(teamName || '').trim(),
        members: clean,
        updatedAt: serverTimestamp()
    });
}

export async function deleteMyTeam(uid) {
    await deleteDoc(doc(db, 'teams', uid));
}

// format অনুযায়ী team doc থেকে players বানাও। ভুল থাকলে { error } ফেরে,
// ঠিক থাকলে { teamName, players }। captain সবসময় players[0]।
export function teamPlayersForFormat(team, captain, format) {
    const fmt = String(format || 'SOLO').toUpperCase();
    if (fmt === 'SOLO') {
        return { teamName: captain.name || 'Player', players: [{ userId: captain.uid, playerName: captain.name || 'Player', ffUID: String(captain.ffUID || '') }] };
    }
    if (!team || !team.teamName) {
        return { error: `${fmt} join-এর আগে My Team পেজে গিয়ে নিজের team বানাও।` };
    }
    const members = team.members || [];
        if (fmt === 'DUO') {
        const validMates = members.filter(m => m && m.ffUID && m.name);
        if (validMates.length === 0) return { error: 'DUO-এর জন্য My Team পেজে অন্তত Mate 1 (নাম + FF UID) যোগ করো, তারপর আবার join করো।' };
        // একাধিক mate থাকলে join-এর সময় select করা হবে (join-tournament.js)
        // এখানে শুধু validation — actual player list join flow-এ build হয়
        return { teamName: team.teamName, players: [
            { userId: captain.uid, playerName: captain.name || 'Captain', ffUID: String(captain.ffUID || '') },
            { userId: '', playerName: validMates[0].name, ffUID: String(validMates[0].ffUID) }
        ], validMates };
        }
    // SQUAD
    // FIX (2026-11-11, L13): UID-এর মতো name-ও বাধ্যতামূলক — নামহীন
    // mate নিয়ে join হলে "Player 2" fallback দেখাত।
    if (members.length < 3 || members.some(m => !m.ffUID || !String(m.name || '').trim())) {
        return { error: 'SQUAD-এর জন্য My Team পেজে 3 জন teammate-ই (নাম + FF UID) থাকতে হবে। বাকিদের যোগ করে আবার join করো।' };
    }
    return { teamName: team.teamName, players: [
        { userId: captain.uid, playerName: captain.name || 'Captain', ffUID: String(captain.ffUID || '') },
        ...members.slice(0, 3).map((m, i) => ({ userId: '', playerName: m.name || `Player ${i + 2}`, ffUID: String(m.ffUID) }))
    ] };
}

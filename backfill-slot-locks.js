// BACKFILL SLOT LOCKS — one-time Admin SDK script (H5, 2026-11-11)
//
// WHY: v8.3-এর আগে auto-assign হওয়া confirmed team-দের কোনো
// tournamentSlots lock doc নেই। Picker এখন team query দিয়ে ওদের slot
// taken দেখায়, কিন্তু txn শুধু lock doc পড়ে — তাই পুরনো team-দের slot-এ
// forged call-এ collision সম্ভব (UI দিয়ে নয়)। এই script একবার চালালে
// প্রতিটা confirmed/pending team-এর জন্য lock doc বানিয়ে দেবে, তারপর
// txn-ও ওদের slot গার্ড করবে।
//
// HOW (computer/Node থাকলে — Firebase Admin SDK rules bypass করে, তাই
// captain-check কোনো বাধা নয়):
//   1. npm install firebase-admin
//   2. Firebase Console → Project settings → Service accounts →
//      "Generate new private key" → serviceAccountKey.json download করো
//      (এই file কাউকে দেবে না, git-এ তুলবে না)।
//   3. এই script-এর পাশে serviceAccountKey.json রেখে চালাও:
//        node backfill-slot-locks.js
//   Script idempotent — lock doc থাকলে skip করবে, তাই দুইবার চালালেও
//   ক্ষতি নেই। শুধু upcoming টুর্নামেন্টের team-দের জন্য চালাবে (পুরনো
//   completed টুর্নামেন্টের দরকার নেই — নিচে DRY_RUN true রাখলে কিছু
//   লিখবে না, শুধু গুনে দেখাবে)।
//
// NOTE: এটা user panel-এর অংশ নয় — admin-এর একবারের tool।

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

const DRY_RUN = true; // প্রথমে true রেখে চালিয়ে দেখো কয়টা lock বানাবে; ঠিক থাকলে false করে আবার চালাও।

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const teamsSnap = await db.collection('tournamentTeams')
    .where('status', 'in', ['confirmed', 'pending']).get();
  console.log(`Found ${teamsSnap.size} confirmed/pending teams.`);
  let created = 0, skipped = 0;
  for (const d of teamsSnap.docs) {
    const t = d.data();
    const slot = Number(t.roomSlot);
    if (!Number.isInteger(slot) || slot < 1 || !t.tournamentId) { skipped++; continue; }
    const lockRef = db.doc(`tournamentSlots/${t.tournamentId}_${slot}`);
    const lockSnap = await lockRef.get();
    if (lockSnap.exists) { skipped++; continue; }
    if (DRY_RUN) { created++; continue; }
    await lockRef.set({
      tournamentId: t.tournamentId,
      slot,
      slotKey: String(slot),
      teamId: d.id,
      captainUserId: t.captainUserId || '',
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    created++;
  }
  console.log(DRY_RUN ? `[DRY RUN] Would create ${created} lock docs (${skipped} skipped).` : `Created ${created} lock docs (${skipped} skipped).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

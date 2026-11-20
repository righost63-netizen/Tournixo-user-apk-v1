// scripts/help-support.js
import { initPage } from './app.js';
import { db, doc, getDoc, collection, query, orderBy, limit, getDocs } from '../firebase/firebase-init.js';
import { cacheGet, cacheSet, cacheIsFresh } from './cache.js';
import { STORAGE_KEYS, CACHE_TTL } from '../utils/constants.js';
import { escHtml } from '../utils/escape.js';

/*
 * ─────────────────────────────────────────────────────────────
 * HELP & SUPPORT — fully dynamic.
 * Reads the `supportContacts` collection managed by the Admin Panel
 * (fields: appName, platform, value, icon (auto), order, createdAt).
 * Whatever the admin adds — WhatsApp, Telegram, Email, … — renders here.
 * Nothing is hard-coded. Falls back to the legacy settings/helpSupport
 * doc only if the collection is empty (older admin versions).
 * ─────────────────────────────────────────────────────────────
 */

const HELP_CACHE_KEY = STORAGE_KEYS.help;
const HELP_CACHE_MS  = CACHE_TTL.help;

// Platform metadata — mirrors the Admin Panel's HS_PLATFORMS list.
const PLATFORMS = {
    whatsapp:  { label: 'WhatsApp' },
    telegram:  { label: 'Telegram' },
    messenger: { label: 'Messenger' },
    email:     { label: 'Email' },
    phone:     { label: 'Phone' },
    facebook:  { label: 'Facebook' },
    instagram: { label: 'Instagram' },
    youtube:   { label: 'YouTube' },
    discord:   { label: 'Discord' },
    website:   { label: 'Website' },
    other:     { label: 'Link' },
};

// UNSLOP Group 4 (pass 3): contact icons are line SVGs (18px, 1.5 stroke,
// currentColor), keyed by platform — not the emoji the Admin Panel stores
// in data.icon, which is ignored here on purpose: the icon is
// presentation; the name/link/order still come from Firestore.
const _ic = inner => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const PLATFORM_ICONS = {
    whatsapp: _ic('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
    telegram: _ic('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
    messenger: _ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    email: _ic('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
    phone: _ic('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    facebook: _ic('<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>'),
    instagram: _ic('<rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>'),
    youtube: _ic('<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/>'),
    discord: _ic('<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'),
    website: _ic('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
    other: _ic('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
};
// Empty-state icons (same line-icon set).
const EMPTY_MSG_SVG = PLATFORM_ICONS.whatsapp;
const EMPTY_ALERT_SVG = _ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>');

// Build the outbound link for a contact — same rules as the Admin Panel.
function buildContactLink(platform, value) {
    const v = String(value || '').trim();
    if (!v) return '';
    // FIX (2026-11-19, v8.11): WhatsApp-এ Indian country code — 10-digit
    // নম্বরে 91 বসাও; 12-digit 91... দিয়ে শুরু হলে আগেই আছে, আর
    // 0 দিয়ে শুরু হলে (trunk 0) সেটা ফেলে 91 বসাও। ডবল prefix নয়।
    // FIX (2026-11-20, S-N2): phone contact wa.me নয় — tel: খোলে, নইলে
    // "Call" চাপলে WhatsApp খুলত, ফোনের dialer নয়।
    if (platform === 'phone') {
        const digits = v.replace(/[^0-9]/g, '');
        let num = digits;
        if (digits.length === 10) num = '91' + digits;
        else if (digits.length === 11 && digits.startsWith('0')) num = '91' + digits.slice(1);
        return 'tel:+' + num;
    }
    if (platform === 'whatsapp') {
        const digits = v.replace(/[^0-9]/g, '');
        let wa = digits;
        if (digits.length === 10) wa = '91' + digits;
        else if (digits.length === 11 && digits.startsWith('0')) wa = '91' + digits.slice(1);
        return 'https://wa.me/' + wa;
    }
    if (platform === 'telegram') return 'https://t.me/' + v.replace(/^@/, '');
    if (platform === 'messenger') return v.startsWith('http') ? v : 'https://m.me/' + v;
    if (platform === 'email') return 'mailto:' + v;
    if (platform === 'instagram') return 'https://instagram.com/' + v.replace(/^@/, '');
    return v; // website / facebook / youtube / discord / other — raw link
}

function toContactList(docs) {
    return docs
        .map(d => {
            const data = d.data ? d.data() : d;
            const platform = String(data.platform || 'other').toLowerCase();
            const meta = PLATFORMS[platform] || PLATFORMS.other;
            return {
                name: data.appName || meta.label,
                platform,
                link: buildContactLink(platform, data.value),
                order: Number(data.order || 0),
            };
        })
        .filter(c => c.link)
        .sort((a, b) => a.order - b.order);
}

async function fetchContacts() {
    let snap = null;
    try {
        snap = await getDocs(query(collection(db, 'supportContacts'), orderBy('order', 'asc'), limit(50)));
    } catch (e) {
        // orderBy needs no composite index, but be resilient anyway
        try {
            snap = await getDocs(query(collection(db, 'supportContacts'), limit(50)));
        } catch (e2) {
            console.warn('[Help] supportContacts fetch failed:', e2?.message || e2);
        }
    }
    if (snap && !snap.empty) return toContactList(snap.docs);

    // Legacy fallback: settings/helpSupport doc (whatsappNumber / telegramUsername / messengerUsername)
    try {
        const legacy = await getDoc(doc(db, 'settings', 'helpSupport'));
        if (legacy.exists()) {
            const d = legacy.data();
            const out = [];
            if (d.whatsappNumber) out.push({ name: 'WhatsApp', platform: 'whatsapp', link: buildContactLink('whatsapp', d.whatsappNumber), order: 0 });
            if (d.telegramUsername) out.push({ name: 'Telegram', platform: 'telegram', link: buildContactLink('telegram', d.telegramUsername), order: 1 });
            if (d.messengerUsername) out.push({ name: 'Messenger', platform: 'messenger', link: buildContactLink('messenger', d.messengerUsername), order: 2 });
            if (out.length) return out;
        }
    } catch (e) {
        console.warn('[Help] legacy fallback failed:', e?.message || e);
    }
    return [];
}

function renderHelpButtons(container, contacts) {
    container.innerHTML = '';
    if (!contacts.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">${EMPTY_MSG_SVG}</div>
                <div class="empty-title">Support is currently unavailable</div>
                <div class="empty-sub">Please check back later</div>
            </div>`;
        return;
    }
    const frag = document.createDocumentFragment();
    contacts.forEach(c => {
        const a = document.createElement('a');
        a.className = 'help-contact-btn';
        // FIX (2026-10-25, L7): admin-written link blind-trust নয় —
        // শুধু https/mailto/tel অনুমোদিত; javascript: সহ বাকি সব '#'
        // হবে (supportContacts লেখা admin-only হলেও user panel অন্ধভাবে
        // trust করবে না)।
        const _rawLink = (c.link || '').trim();
        a.href = /^(https:\/\/|mailto:|tel:)/i.test(_rawLink) ? _rawLink : '#';
        a.target = '_blank';
        a.rel = 'noopener';
        // UNSLOP (pass 3): the icon is our own static SVG by platform —
        // safe to inject raw. (c.name / c.link stay escaped / validated.)
        const iconKey = (c.platform || c.name || '').toLowerCase();
        a.innerHTML = `<span class="help-contact-ic">${PLATFORM_ICONS[iconKey] || PLATFORM_ICONS.other}</span><span>${escHtml(c.name)}</span><span class="help-contact-chev">›</span>`;
        frag.appendChild(a);
    });
    container.appendChild(frag);
}

async function loadHelpSupport() {
    const container = document.getElementById('help-buttons');
    if (!container) return;

    const cached = cacheGet(HELP_CACHE_KEY);
    if (cached && Array.isArray(cached.data)) renderHelpButtons(container, cached.data);
    if (cached && cacheIsFresh(cached, HELP_CACHE_MS)) return;

    try {
        const contacts = await fetchContacts();
        cacheSet(HELP_CACHE_KEY, contacts);
        renderHelpButtons(container, contacts);
    } catch (error) {
        if (!cached) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">${EMPTY_ALERT_SVG}</div>
                    <div class="empty-title">Unable to load support info</div>
                    <button class="btn btn-primary" style="margin-top:14px;" onclick="window.retryHelpSupport()">আবার চেষ্টা করো</button>
                </div>`;
        }
    }
}

// FIX (2026-11-19, v8.11): load fail-এ Retry — আবার load চলে, পুরো
// page reload লাগে না।
window.retryHelpSupport = () => { loadHelpSupport(); };

window.closeHelpSupport = function () {
    if (typeof window.goBack === 'function') window.goBack('profile');
    else history.back();
};

initPage({
    page: 'helpSupport',
    onReady: () => { loadHelpSupport(); }
});

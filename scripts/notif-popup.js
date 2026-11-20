// ════════════════════════════════════════════════════════════════
// PREMIUM IN-APP NOTIFICATION POPUP (foreground)
// When an admin notification arrives while the player is inside the
// app/website, a premium card slides down from the top (Android/iOS
// style) instead of only updating the bell badge silently.
// The same admin action usually ALSO sends a OneSignal push — the
// mobile notification shade copy — so this module de-dupes identical
// title+body within a few seconds.
// Self-contained: styles are injected once, no page CSS changes.
// ════════════════════════════════════════════════════════════════
// FIX (2026-10-25, F-21): dedupe window (6s) auto-dismiss (6.5s)-এর
// চেয়ে ছোট ছিল — 6.2s-এ একই notification দ্বিতীয় popup হয়ে stack হতো।
// এখন dedupe dismiss-এর চেয়ে বড়।
const DEDUPE_WINDOW_MS = 7000;
const AUTO_DISMISS_MS = 6500;
const _recent = new Map();

function ensureStyles() {
    if (document.getElementById('notif-popup-styles')) return;
    const style = document.createElement('style');
    style.id = 'notif-popup-styles';
    style.textContent = `
    #notif-popup-wrap{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);left:50%;transform:translateX(-50%);width:min(94vw,430px);z-index:999990;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:inherit;}
    .notif-popup{pointer-events:auto;display:flex;gap:12px;align-items:flex-start;background:var(--bg2,#0F1115);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:16px;padding:16px;box-shadow:0 18px 44px rgba(0,0,0,.55);cursor:pointer;position:relative;overflow:hidden;animation:np-in .45s cubic-bezier(.22,1,.36,1);}
    .notif-popup.leaving{animation:np-out .3s cubic-bezier(.22,1,.36,1) forwards;}
    .notif-popup .np-icon{flex:0 0 40px;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--text2,rgba(255,255,255,.7));background:var(--bg4,#161F33);border:1px solid var(--border,rgba(255,255,255,.08));}
    .notif-popup .np-icon svg{width:18px;height:18px;display:block;}
    .notif-popup .np-main{flex:1;min-width:0;}
    .notif-popup .np-title{font-size:14px;font-weight:600;color:#fff;line-height:1.3;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .notif-popup .np-body{font-size:13px;color:rgba(255,255,255,.72);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
    .notif-popup .np-app{font-size:10px;letter-spacing:0;color:var(--text3,rgba(255,255,255,.4));font-weight:600;margin-bottom:3px;}
    .notif-popup .np-close{flex:0 0 auto;background:none;border:none;color:rgba(255,255,255,.55);font-size:16px;line-height:1;cursor:pointer;padding:2px 2px 0 4px;}
    .notif-popup .np-bar{position:absolute;left:0;bottom:0;height:2px;background:var(--accent,#C7FF3E);animation:np-bar ${AUTO_DISMISS_MS}ms linear forwards;}
    @keyframes np-in{from{transform:translateY(-8px) scale(.97);opacity:0;}to{transform:translateY(0) scale(1);opacity:1;}}
    @keyframes np-out{to{transform:translateY(-8px);opacity:0;}}
    @keyframes np-bar{from{width:100%;}to{width:0%;}}
    `;
    document.head.appendChild(style);
}

function ensureWrap() {
    ensureStyles();
    let wrap = document.getElementById('notif-popup-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'notif-popup-wrap';
        document.body.appendChild(wrap);
    }
    return wrap;
}

// UNSLOP Group 4 (pass 3): popup icons are line SVGs (18px, 1.5 stroke,
// currentColor), not emoji. The card itself is flat now — no gold
// gradient, no gold border, no blur; the thin lime bar is the accent.
const _ic = inner => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const NP_ICONS = {
    payment: _ic('<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>'),
    prize: _ic('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
    withdraw: _ic('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M12 11v6"/><path d="m9 14 3 3 3-3"/>'),
    room: _ic('<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
    warning: _ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    success: _ic('<path d="M20 6 9 17l-5-5"/>'),
    tournament: _ic('<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'),
    default: _ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>')
};

function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('payment') || t.includes('join')) return NP_ICONS.payment;
    if (t.includes('prize') || t.includes('win') || t.includes('result')) return NP_ICONS.prize;
    if (t.includes('withdraw')) return NP_ICONS.withdraw;
    if (t.includes('room')) return NP_ICONS.room;
    if (t.includes('warn') || t.includes('reject')) return NP_ICONS.warning;
    if (t.includes('success') || t.includes('confirm') || t.includes('approv')) return NP_ICONS.success;
    if (t.includes('tournament') || t.includes('match')) return NP_ICONS.tournament;
    return NP_ICONS.default;
}

function escText(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

export function showNotifPopup({ icon, title, body, type, onTap } = {}) {
    try {
        const key = `${title || ''}|${body || ''}`;
        const now = Date.now();
        if (_recent.has(key) && now - _recent.get(key) < DEDUPE_WINDOW_MS) return;
        _recent.set(key, now);
        for (const [k, ts] of _recent) { if (now - ts > DEDUPE_WINDOW_MS) _recent.delete(k); }

        const wrap = ensureWrap();
        while (wrap.children.length >= 2) wrap.firstChild.remove();

        const card = document.createElement('div');
        card.className = 'notif-popup';
        card.setAttribute('role', 'alert');
        card.innerHTML = `
            <div class="np-icon">${icon || iconForType(type)}</div>
            <div class="np-main">
                <div class="np-app">Tournixo</div>
                <div class="np-title">${escText(title || 'Notification')}</div>
                <div class="np-body">${escText(body || '')}</div>
            </div>
            <button class="np-close" aria-label="Dismiss"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            <div class="np-bar"></div>`;

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            card.classList.add('leaving');
            setTimeout(() => card.remove(), 320);
        };
        // FIX (2026-10-25, F-21): manual dismiss-এ auto-dismiss timer-ও
        // clear হবে (আগে double remove চলত — harmless হলেও অপরিচ্ছন্ন)।
        let autoTimer = null;
        const dismissAndClear = () => { if (autoTimer) clearTimeout(autoTimer); dismiss(); };
        card.querySelector('.np-close').addEventListener('click', (e) => { e.stopPropagation(); dismissAndClear(); });
        card.addEventListener('click', () => { dismissAndClear(); if (typeof onTap === 'function') onTap(); });
        wrap.appendChild(card);
        autoTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
    } catch (e) { /* popup must never break the page */ }
}

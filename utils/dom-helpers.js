// v8.6 (G): toast / user-facing error message বাংলায় — English toast আর নেই।
import { assetUrl } from '../config/app-config.js';

// ── Spinner on a button (same as original setLoading) ──
export function setLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn._orig = btn.innerHTML;
        btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div>';
    } else {
        btn.disabled = false;
        if (btn._orig) btn.innerHTML = btn._orig;
    }
}

// ── Show/hide password (used by inline onclick in login/register) ──
// UNSLOP Group 4 (pass 3): real inline SVG eye / eye-off (16px, 1.5
// stroke, currentColor) instead of the eye emoji text. The Group 0
// login.css :has() workaround is removed with this.
const EYE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.59 9.59 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

export function togglePass(id, btn) {
    const inp = document.getElementById(id);
    if (!inp) return;
    if (inp.type === 'password') {
        inp.type = 'text';
        btn.innerHTML = EYE_OFF_SVG;
    } else {
        inp.type = 'password';
        btn.innerHTML = EYE_SVG;
    }
}

// ── Copy to clipboard (uses window.showToast, defined by scripts/toast.js) ──
export function copyText(text, label) {
    const done = () => window.showToast && window.showToast(`${label} কপি হয়েছে`, 'success', 1500);
    const fallback = () => {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        done();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
    else fallback();
}

// ── Shared HTML components (components/*.html) ──
const _componentCache = {};

export async function loadComponent(name) {
    if (!_componentCache[name]) {
        const res = await fetch(assetUrl(`components/${name}.html`));
        if (!res.ok) throw new Error(`Component "${name}" failed to load (${res.status})`);
        _componentCache[name] = await res.text();
    }
    return _componentCache[name];
}

// Inserts a component into the page. target = element or CSS selector.
export async function mountComponent(name, target = document.body, position = 'beforeend') {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return null;
    const html = await loadComponent(name);
    host.insertAdjacentHTML(position, html);
    return host;
}

// Inline onclick handlers in the HTML need these on window (same as original)
window.togglePass = togglePass;
window.copyText = copyText;

// UNSLOP Group 4 (pass 3): the toggle buttons ship empty in the HTML —
// draw the initial eye icon here (the Group 0 login.css ::after drew it
// before). Runs at module load; auth-ui.js imports this module on the
// login/register pages, so the DOM is parsed by then.
document.querySelectorAll('.input-toggle').forEach(b => { if (!b.innerHTML.trim()) b.innerHTML = EYE_SVG; });
import { state } from './state.js';
import { cacheGet, cacheSet, cacheIsFresh } from './cache.js';
import { fetchBanners } from '../services/banners.service.js';
import { STORAGE_KEYS, CACHE_TTL } from '../utils/constants.js';
import { APP_CONFIG } from '../config/app-config.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. `cacheIsFresh` unused import — confirmed not present here;
 *    we always fresh-fetch, so it is not needed.
 * 2. Cloudinary transform hard-coded `w_900` — now from
 *    APP_CONFIG.bannerImageWidth.
 * 3. imageUrl security: encoded before injecting into HTML,
 *    so attribute breaking is prevented.
 * ─────────────────────────────────────────────────────────────
 */

// Width now from config (was hard-coded 'w_900').
const BANNER_WIDTH = APP_CONFIG.bannerImageWidth || 900;

function optimizeBannerUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (!url.includes('res.cloudinary.com/') || !url.includes('/upload/')) return url;
    if (url.includes('/upload/f_auto,q_auto/')) return url;
    return url.replace('/upload/', `/upload/f_auto,q_auto,w_${BANNER_WIDTH}/`);
}

function clearBannerTimer() {
    if (state.bannerInterval) {
        clearInterval(state.bannerInterval);
        state.bannerInterval = null;
    }
}

// FIX (2026-10-25, F-04): in-flight guard + reload-pending —
// ff:cache-updated event-এর double-fetch বন্ধ হবে।
let _bannersLoading = false;
let _bannersReloadPending = false;
export async function loadBanners() {
    if (_bannersLoading) {
        _bannersReloadPending = true;
        return;
    }
    const CACHE_KEY = STORAGE_KEYS.banners;
    const cached = cacheGet(CACHE_KEY, localStorage);

    if (cached && cached.data) renderBanners(cached.data);

    // FIX (2026-10-25, F-04): আগে সবসময় fresh fetch হতো — 1h TTL
    // থাকা সত্ত্বেও প্রতি home open-এ N read + double render/flicker।
    // এখন TTL fresh হলে cache-ই final (invalidation appConfig touch
    // দিয়ে হয়, যেমন mode chips-এ হয়)।
    if (cached && cached.data && cacheIsFresh(cached, CACHE_TTL.banners)) {
        return;
    }

    _bannersLoading = true;
    try {
        const banners = await fetchBanners();
        cacheSet(CACHE_KEY, banners, localStorage);
        renderBanners(banners);
    } catch (e) {
        if (!cached) {
            const emptyEl = document.getElementById('banner-empty');
            const innerEl = document.getElementById('banner-slider-inner');
            if (emptyEl) emptyEl.style.display = 'flex';
            if (innerEl) innerEl.style.display = 'none';
        } else if (cached.data && cached.data.length) {
            // FIX (Home, 2026-11-19, F3): a stale cache was silently
            // shown as if it were fresh when the fresh fetch failed.
            // Say so, quietly — one small muted line under the slider.
            showBannerStaleNote();
        }
    } finally {
        _bannersLoading = false;
        if (_bannersReloadPending) {
            _bannersReloadPending = false;
            loadBanners();
        }
    }
}

// Encode URL before injecting into HTML attribute
function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// FIX (Home, 2026-11-19, F3): one small muted line under the slider
// when the banners on screen are stale (fresh fetch failed). Created
// at most once; removed by renderBanners() on the next fresh render.
function showBannerStaleNote() {
    const container = document.getElementById('banner-container');
    if (!container || container.querySelector('.banner-stale-note')) return;
    const note = document.createElement('div');
    note.className = 'banner-stale-note';
    note.textContent = 'Showing older banners';
    container.appendChild(note);
}

export function renderBanners(banners) {
    // FIX (Home, 2026-11-19, F3): fresh banners arrived — the stale
    // hint from a previous failed fetch no longer applies.
    document.querySelector('.banner-stale-note')?.remove();
    const emptyEl = document.getElementById('banner-empty'),
        innerEl = document.getElementById('banner-slider-inner');
    const track = document.getElementById('banner-track'),
        dots = document.getElementById('banner-dots');
    if (!emptyEl || !innerEl || !track || !dots) return;
    if (!banners || banners.length === 0) {
        emptyEl.style.display = 'flex';
        innerEl.style.display = 'none';
        return;
    }
    emptyEl.style.display = 'none';
    innerEl.style.display = 'block';
    track.innerHTML = '';
    dots.innerHTML = '';
    state.bannerCount = banners.length;
    banners.forEach((b, i) => {
        const slide = document.createElement('div');
        slide.className = 'banner-slide' + (i === 0 ? ' active' : '');
        // UNSLOP Group 4 (pass 3): empty-banner placeholder is a line
        // icon, not the fire emoji.
        const imageUrl = optimizeBannerUrl(b.imageUrl);
        slide.innerHTML = imageUrl
            ? `
                <div class="banner-card">
                    <img class="banner-img"
                         src="${escapeAttr(imageUrl)}"
                         alt="Banner"
                         loading="${i === 0 ? 'eager' : 'lazy'}"
                         ${i === 0 ? 'fetchpriority="high"' : ''}
                         decoding="async">
                </div>
              `
            : `
                <div class="banner-card banner-empty-card">
                    <div class="banner-img-placeholder"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>
                </div>
              `;
        // FIX (2026-10-25, BUILD 20 paired patch, dash L3): banner-এর
        // redirectLink আগে dead ছিল (কোনো click handler নেই) — এখন
        // https লিঙ্কে tap করলে নতুন ট্যাবে খুলবে। Swipe-এর সাথে click
        // গুলিয়ে না যায়, 12px-এর বেশি drag হলে click উপেক্ষা করা হয়।
        if (b.redirectLink && /^https:\/\//.test(b.redirectLink)) {
            slide.style.cursor = 'pointer';
            let _px = 0, _py = 0;
            slide.addEventListener('pointerdown', e => { _px = e.clientX; _py = e.clientY; });
            slide.addEventListener('click', e => {
                if (Math.abs(e.clientX - _px) > 12 || Math.abs(e.clientY - _py) > 12) return;
                window.open(b.redirectLink, '_blank', 'noopener');
            });
        }
        track.appendChild(slide);
        const dot = document.createElement('div');
        dot.className = 'banner-dot' + (i === 0 ? ' active' : '');
        dots.appendChild(dot);
    });
    clearBannerTimer();
    state.bannerIndex = 0;
    bindBannerSwipe();
    if (banners.length > 1 && !document.hidden) {
        state.bannerInterval = setInterval(
            () => goBanner((state.bannerIndex + 1) % state.bannerCount),
            APP_CONFIG.bannerIntervalMs
        );
    }
}

export function goBanner(idx) {
    state.bannerIndex = idx;
    const track = document.getElementById('banner-track'),
        dots = document.querySelectorAll('.banner-dot');
    if (track) {
        track.style.transform = `translateX(-${idx*100}%)`;
        // spotlight: mark the visible slide so CSS can pop it
        track.querySelectorAll('.banner-slide').forEach((s, i) => s.classList.toggle('active', i === idx));
    }
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
}

// ── Swipe gestures: drag left/right to change banner ──
let _swipeBound = false;
function bindBannerSwipe() {
    if (_swipeBound) return;
    const slider = document.getElementById('banner-container');
    if (!slider) return;
    _swipeBound = true;
    let startX = 0, touching = false;
    slider.addEventListener('touchstart', e => {
        touching = true;
        startX = e.touches[0].clientX;
        clearBannerTimer(); // pause autoplay while the user interacts
    }, { passive: true });
    slider.addEventListener('touchend', e => {
        if (!touching) return;
        touching = false;
        const dx = e.changedTouches[0].clientX - startX;
        if (Math.abs(dx) > 40 && state.bannerCount > 1) {
            if (dx < 0) goBanner((state.bannerIndex + 1) % state.bannerCount);
            else goBanner((state.bannerIndex - 1 + state.bannerCount) % state.bannerCount);
        }
        // resume autoplay after the swipe
        clearBannerTimer();
        if (state.bannerCount > 1 && !document.hidden) {
            state.bannerInterval = setInterval(
                () => goBanner((state.bannerIndex + 1) % state.bannerCount),
                APP_CONFIG.bannerIntervalMs
            );
        }
    }, { passive: true });
}

let _bannerEventsBound = false;
if (!_bannerEventsBound) {
    _bannerEventsBound = true;
    document.addEventListener('ff:cache-updated', e => {
        const fields = e.detail?.fields || [];
        if (fields.includes('banners')) loadBanners();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearBannerTimer();
        } else if (state.bannerCount > 1) {
            clearBannerTimer();
            state.bannerInterval = setInterval(
                () => goBanner((state.bannerIndex + 1) % state.bannerCount),
                APP_CONFIG.bannerIntervalMs
            );
        }
    });
}

window.goBanner = goBanner;
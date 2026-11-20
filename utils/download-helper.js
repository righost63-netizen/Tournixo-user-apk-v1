// FIX (2026-11-19, v8.11, APK-DOWNLOAD): Android WebView-তে <a download>,
// blob: বা data: URL চুপচাপ কিছুই করে না — Capacitor-এর Android
// package-এ কোনো DownloadListener নেই, তাই QR PNG-এর মতো canvas/blob
// ডাউনলোড APK-তে নীরবে হারিয়ে যেত। এই helper-ই সব image ডাউনলোডের
// একমাত্র রাস্তা:
//   1. Capacitor native + FileSharer (Capgo) / ImageDownloader plugin
//      থাকলে → সেটা (MediaStore → Downloads, Android 10+ এ আলাদা
//      storage permission লাগে না) — ফোনের Downloads/Gallery-তে যাবে।
//   2. না থাকলে browser-এর মতো anchor download (web/PWA-তে কাজ করে)।
//   3. native-এ plugin না থাকলে মিথ্যা success নয় — { ok:false } ফেরে,
//      caller error toast দেখাবে।

export function isCapacitorNative() {
    try {
        if (typeof window !== 'undefined' && window.Capacitor) {
            if (typeof window.Capacitor.isNativePlatform === 'function') return window.Capacitor.isNativePlatform();
            if (typeof window.Capacitor.getPlatform === 'function') return window.Capacitor.getPlatform() !== 'web';
            return true;
        }
    } catch (e) {}
    return false;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            // "data:image/png;base64,...." → শুধু base64 অংশ
            const s = String(r.result || '');
            resolve(s.includes(',') ? s.split(',')[1] : s);
        };
        r.onerror = () => reject(new Error('read-failed'));
        r.readAsDataURL(blob);
    });
}

function webAnchorDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function nativeSave(base64, filename, mimeType) {
    try {
        const Plugins = window.Capacitor?.Plugins;
        // পছন্দ ১: @capgo/capacitor-file-sharer (install করা থাকলে) —
        // Android-এ MediaStore/Downloads-এ সেভ করে, web-এ download করে।
        if (Plugins?.FileSharer?.save) {
            await Plugins.FileSharer.save({
                filename,
                contentType: mimeType || 'image/png',
                base64Data: base64,
                android: { saveDirectory: 'downloads' }
            });
            return true;
        }
        // পছন্দ ২: হাতে বানানো ImageDownloader plugin (apk-native zip-এ
        // দেওয়া ImageDownloaderPlugin.java) — একই MediaStore রাস্তা।
        if (Plugins?.ImageDownloader?.saveImage) {
            const res = await Plugins.ImageDownloader.saveImage({ base64, filename, mimeType: mimeType || 'image/png' });
            return !!res?.saved;
        }
    } catch (e) {}
    return false;
}

// blob / base64 / dataUrl / http(s) url — যেকোনো একটা দিলেই চলবে।
// ফেরত: { ok, method: 'native' | 'web' | 'none' }
export async function saveImageFile({ blob, base64, dataUrl, url, filename, mimeType }) {
    const name = filename || 'tournixo-image.png';
    const type = mimeType || 'image/png';
    try {
        if (isCapacitorNative()) {
            let b64 = base64 || '';
            if (!b64 && dataUrl) b64 = String(dataUrl).includes(',') ? String(dataUrl).split(',')[1] : String(dataUrl);
            if (!b64 && blob) b64 = await blobToBase64(blob);
            if (!b64 && url) {
                const res = await fetch(url);
                b64 = await blobToBase64(await res.blob());
            }
            if (b64 && await nativeSave(b64, name, type)) return { ok: true, method: 'native' };
            return { ok: false, method: 'none' };
        }
        // Web / PWA: আগের মতো anchor download।
        if (blob) { webAnchorDownload(blob, name); return { ok: true, method: 'web' }; }
        if (dataUrl) {
            const res = await fetch(dataUrl);
            webAnchorDownload(await res.blob(), name);
            return { ok: true, method: 'web' };
        }
        if (base64) {
            const res = await fetch(`data:${type};base64,${base64}`);
            webAnchorDownload(await res.blob(), name);
            return { ok: true, method: 'web' };
        }
        if (url) {
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            return { ok: true, method: 'web' };
        }
        return { ok: false, method: 'none' };
    } catch (e) {
        return { ok: false, method: 'none' };
    }
}

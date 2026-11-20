import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(__dirname, 'app', 'src', 'main', 'assets');
const PUBLIC_DIR = path.join(ASSETS_DIR, 'public');
const RES_DIR = path.join(__dirname, 'app', 'src', 'main', 'res');

const WEB_FILES = ['index.html', 'manifest.json', 'sw.js'];
const WEB_DIRS = ['components', 'config', 'firebase', 'pages', 'scripts', 'services', 'styles', 'utils'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Pure-JS PNG encoder for legacy Android mipmap launcher icons (API < 26 fallback)
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

function renderTournixoIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.25;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      // Normalized 0..96 coordinates matching splash-screen.html
      const u = ((x + 0.5) / size) * 96;
      const v = ((y + 0.5) / size) * 96;

      // Rounded rect alpha
      const dx = Math.max(0, Math.abs(x + 0.5 - size / 2) - (size / 2 - radius));
      const dy = Math.max(0, Math.abs(y + 0.5 - size / 2) - (size / 2 - radius));
      const dist = Math.hypot(dx, dy);
      if (dist > radius) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Lime gradient (#dcff6e -> #b4f01f)
      const t = (u + v) / 192;
      let r = Math.round(220 + (180 - 220) * t);
      let g = Math.round(255 + (240 - 255) * t);
      let b = Math.round(110 + (31 - 110) * t);

      // Trophy silhouette (#0a0f00)
      let inTrophy = false;
      // Cup body (24..72, 24..62)
      if (u >= 24 && u <= 72 && v >= 24 && v <= 38) inTrophy = true;
      if (v > 38 && v <= 62 && Math.hypot(u - 48, v - 38) <= 24) inTrophy = true;
      // Stem (41..55, 58..70)
      if (u >= 41 && u <= 55 && v >= 58 && v <= 70) inTrophy = true;
      // Base (27..69, 70..78 with rounded ends)
      if (v >= 70 && v <= 78 && ((u >= 31 && u <= 65) || Math.hypot(u - 31, v - 74) <= 4 || Math.hypot(u - 65, v - 74) <= 4)) {
        inTrophy = true;
      }
      // Inner cutout (36..60, 31..49)
      if (u >= 36 && u <= 60 && v >= 31 && v <= 37) inTrophy = false;
      if (v > 37 && v <= 49 && Math.hypot(u - 48, v - 37) <= 12) inTrophy = false;

      if (inTrophy) {
        r = 10;
        g = 15;
        b = 0;
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function generateLegacyMipmaps() {
  const densities = [
    ['mipmap-mdpi', 48],
    ['mipmap-hdpi', 72],
    ['mipmap-xhdpi', 96],
    ['mipmap-xxhdpi', 144],
    ['mipmap-xxxhdpi', 192]
  ];
  for (const [folder, px] of densities) {
    const dir = path.join(RES_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const png = renderTournixoIconPng(px);
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png);
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), png);
  }
}

function main() {
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  for (const file of WEB_FILES) {
    const src = path.join(ROOT_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(PUBLIC_DIR, file));
    }
  }

  for (const dir of WEB_DIRS) {
    const src = path.join(ROOT_DIR, dir);
    if (fs.existsSync(src)) {
      copyRecursive(src, path.join(PUBLIC_DIR, dir));
    }
  }

  const capConfigSrc = path.join(ROOT_DIR, 'capacitor.config.json');
  if (fs.existsSync(capConfigSrc)) {
    fs.copyFileSync(capConfigSrc, path.join(ASSETS_DIR, 'capacitor.config.json'));
  }

  // Plugins are registered directly in MainActivity.java
  fs.writeFileSync(path.join(ASSETS_DIR, 'capacitor.plugins.json'), '[]\n');

  generateLegacyMipmaps();
  console.log('Bundled web assets into android/app/src/main/assets/public and generated launcher mipmaps.');
}

main();

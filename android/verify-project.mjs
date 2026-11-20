import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const requiredFiles = [
  'index.html',
  'manifest.json',
  'sw.js',
  'server.js',
  'capacitor.config.json',
  'android/build.gradle',
  'android/settings.gradle',
  'android/app/build.gradle',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/assets/capacitor.config.json',
  'android/app/src/main/assets/capacitor.plugins.json',
  'android/app/src/main/assets/public/index.html',
  'android/app/src/main/assets/public/pages/home.html',
  'android/app/src/main/assets/public/scripts/app.js',
  'android/app/src/main/assets/public/services/onesignal.service.js',
  'android/app/src/main/java/com/tournixo/app/TournixoApplication.java',
  'android/app/src/main/java/com/tournixo/app/OneSignalManager.java',
  'android/app/src/main/java/com/tournixo/app/OneSignalPlugin.java',
  'android/app/src/main/java/com/tournixo/app/ImageDownloaderPlugin.java',
  'android/app/src/main/java/com/tournixo/app/MainActivity.java'
];

let missing = [];
for (const rel of requiredFiles) {
  if (!fs.existsSync(path.join(ROOT_DIR, rel))) {
    missing.push(rel);
  }
}

if (missing.length > 0) {
  console.error('Missing required files:\n' + missing.map((m) => ' - ' + m).join('\n'));
  process.exit(1);
}

console.log(`Verified ${requiredFiles.length} web and Android wrapper files.`);

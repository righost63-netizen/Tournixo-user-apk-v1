import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Block access to server/Android/config internals so only web app assets are served
app.use((req, res, next) => {
  const reqPath = req.path.toLowerCase();
  if (
    reqPath.startsWith('/android') ||
    reqPath.startsWith('/node_modules') ||
    reqPath.startsWith('/src') ||
    reqPath.startsWith('/.git') ||
    reqPath === '/server.js' ||
    reqPath === '/package.json' ||
    reqPath === '/package-lock.json' ||
    reqPath === '/capacitor.config.json' ||
    reqPath === '/metadata.json' ||
    reqPath.startsWith('/.env')
  ) {
    return res.status(404).end();
  }
  next();
});

// Headers matching netlify.toml behavior for HTML, SW, manifest, and assetlinks
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  } else if (req.path === '/sw.js') {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
  } else if (req.path === '/manifest.json') {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  } else if (req.path === '/.well-known/assetlinks.json') {
    res.setHeader('Content-Type', 'application/json');
  }
  next();
});

app.use(express.static(__dirname, { dotfiles: 'allow', index: 'index.html' }));

app.listen(PORT, HOST, () => {
  console.log(`Tournixo web server running on http://${HOST}:${PORT}`);
});

const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// RENDER + SECURITY SETUP
// --------------------------
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 56565;

// SECURE ENCRYPTION
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'StremioSimklSync_Render_2025!';
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'render_salt', 32);
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --------------------------
// PERSISTENT ENCRYPTED CONFIG
// --------------------------
const CONFIG_DIR = IS_PRODUCTION ? '/opt/render/config' : __dirname;
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.encrypted');

let APP_CONFIG = {
  simklClientId: '',
  simklClientSecret: '',
  watchThreshold: 80,
  syncWatchingNow: true,
  syncFullProgress: true,
  simklToken: ''
};

const Config = {
  load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const encrypted = fs.readFileSync(CONFIG_PATH, 'utf8');
        APP_CONFIG = JSON.parse(decrypt(encrypted));
      }
    } catch (e) { console.error('Config load failed:', e.message); }
  },
  save(newConfig) {
    APP_CONFIG = { ...APP_CONFIG, ...newConfig };
    const encrypted = encrypt(JSON.stringify(APP_CONFIG));
    fs.writeFileSync(CONFIG_PATH, encrypted, 'utf8');
  },
  get() { return { ...APP_CONFIG }; }
};
Config.load();

// --------------------------
// SIMKL OFFICIAL API ENDPOINTS
// --------------------------
const SIMKL_API = {
  AUTH: 'https://api.simkl.com/oauth/authorize',
  TOKEN: 'https://api.simkl.com/oauth/token',
  SCROBBLE: 'https://api.simkl.com/scrobble',
  WATCHING: 'https://api.simkl.com/watching',
  COMPLETE: 'https://api.simkl.com/complete'
};

// --------------------------
// STREMIO ADDON MANIFEST
// --------------------------
const manifest = {
  id: 'org.stremio.simklsync.render',
  version: '2.1.0',
  name: 'Stremio Simkl Sync',
  description: 'Sync Stremio watch progress to Simkl (Render Hosted)',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  background: '#1E1E2E',
  catalogs: [],
  resources: ['player'],
  types: ['movie', 'series'],
  idPrefixes: ['tt']
};

// --------------------------
// EXPRESS SERVER
// --------------------------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// --------------------------
// 🔥 WEB CONFIGURATION PAGE (AT /configure)
// --------------------------
app.get('/configure', (req, res) => {
  const cfg = Config.get();
  const host = req.hostname;
  const manifestUrl = `https://${host}/manifest.json`;
  const stremioProtocolUrl = `stremio://${host}/manifest.json`;
  const stremioWebUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
  const redirectUri = `https://${host}/auth/simkl/callback`;

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
      <meta charset="UTF-8">
      <title>Stremio Simkl Sync - Config</title>
      <style>
          * { box-sizing: border-box; font-family: Arial, sans-serif; }
          body { background: #121212; color: #fff; max-width: 600px; margin: 40px auto; padding: 20px; }
          .card { background: #1e1e2e; padding: 25px; border-radius: 12px; margin-bottom: 20px; }
          h1 { color: #7CB342; margin-top: 0; }
          label { display: block; margin: 12px 0 6px; font-weight: bold; }
          input, select, button { width: 100%; padding: 12px; border-radius: 6px; border: none; font-size: 16px; margin-bottom: 8px; }
          input, select { background: #2d2d3f; color: white; }
          button { background: #7CB342; color: white; cursor: pointer; font-weight: bold; }
          button.secondary { background: #444; }
          button.install { background: #2196F3; font-size: 18px; padding: 15px; }
          .info { color: #aaa; font-size: 14px; margin-top: -5px; margin-bottom: 10px; }
          .success { color: #4CAF50; padding: 10px; background: rgba(76,175,80,0.1); border-radius: 6px; }
          .line { margin: 20px 0; border-top: 1px solid #333; }
          .install-buttons { display: flex; gap: 10px; margin-top: 10px; }
          .install-buttons button { flex: 1; }
      </style>
  </head>
  <body>
      <div class="card">
          <h1>⚙️ Stremio Simkl Sync Config</h1>
          <p class="info">All settings are saved securely (encrypted)</p>

          <form method="POST" action="/save-config">
              <label>Simkl Client ID</label>
              <input type="text" name="simklClientId" value="${cfg.simklClientId || ''}" required>

              <label>Simkl Client Secret</label>
              <input type="password" name="simklClientSecret" value="${cfg.simklClientSecret || ''}" required>

              <div class="line"></div>

              <label>Auto-Mark Watched at %</label>
              <input type="number" name="watchThreshold" min="1" max="100" value="${cfg.watchThreshold}" required>
              <p class="info">Default: 80%</p>

              <label>Sync "Watching Now" to Simkl?</label>
              <select name="syncWatchingNow">
                  <option value="true" ${cfg.syncWatchingNow ? 'selected' : ''}>Yes</option>
                  <option value="false" ${!cfg.syncWatchingNow ? 'selected' : ''}>No</option>
              </select>

              <label>Sync Full Watch Progress?</label>
              <select name="syncFullProgress">
                  <option value="true" ${cfg.syncFullProgress ? 'selected' : ''}>Yes</option>
                  <option value="false" ${!cfg.syncFullProgress ? 'selected' : ''}>No</option>
              </select>

              <button type="submit">💾 Save Settings</button>
          </form>
      </div>

      <div class="card">
          <h2>🔐 Authenticate with Simkl</h2>
          <p class="info">Redirect URI for Simkl Dev Portal:</p>
          <input type="text" readonly value="${redirectUri}">
          <a href="/auth/simkl"><button class="secondary">🔗 Login to Simkl</button></a>
          ${cfg.simklToken ? '<p class="success">✅ Authenticated!</p>' : '<p class="info">Not authenticated yet</p>'}
      </div>

      <div class="card">
          <h2>📥 Install to Stremio</h2>
          <p class="info">Click to install directly to your Stremio app or web</p>
          
          <!-- Install Buttons -->
          <div class="install-buttons">
              <a href="${stremioProtocolUrl}"><button class="install">📦 Install (App)</button></a>
              <a href="${stremioWebUrl}" target="_blank"><button class="install">🌐 Install (Web)</button></a>
          </div>
          
          <p class="info">Or copy the URL for manual install:</p>
          <input type="text" readonly value="${manifestUrl}" id="manifestUrl">
          <button class="secondary" onclick="copyUrl()">📋 Copy URL</button>
      </div>

      <script>
          function copyUrl() {
              const input = document.getElementById('manifestUrl');
              input.select();
              document.execCommand('copy');
              alert('URL copied to clipboard!');
          }
      </script>
  </body>
  </html>
  `;
  res.send(html);
});

// Save config from web UI
app.post('/save-config', (req, res) => {
  const { simklClientId, simklClientSecret, watchThreshold, syncWatchingNow, syncFullProgress } = req.body;
  Config.save({
    simklClientId,
    simklClientSecret,
    watchThreshold: parseInt(watchThreshold),
    syncWatchingNow: syncWatchingNow === 'true',
    syncFullProgress: syncFullProgress === 'true'
  });
  res.redirect('/configure?saved=1');
});

// Manifest
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(manifest);
});

// Simkl OAuth Login
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklClientId) return res.status(400).send('Set Client ID first! Go to /configure');

  const redirectUri = `https://${req.hostname}/auth/simkl/callback`;
  const authUrl = new URL(SIMKL_API.AUTH);
  authUrl.searchParams.set('client_id', cfg.simklClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'scrobble');

  res.redirect(authUrl.toString());
});

// Simkl OAuth Callback
app.get('/auth/simkl/callback', async (req, res) => {
  const cfg = Config.get();
  const { code } = req.query;

  if (!code) return res.send('<h1>❌ Auth failed: No code</h1>');

  try {
    const redirectUri = `https://${req.hostname}/auth/simkl/callback`;
    const tokenRes = await fetch(SIMKL_API.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.simklClientId,
        client_secret: cfg.simklClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      Config.save({ simklToken: tokenData.access_token });
      res.send('<h1>✅ Authenticated! You can close this tab.</h1>');
    } else {
      res.send(`<h1>❌ Failed: ${tokenData.error || 'Unknown'}</h1>`);
    }
  } catch (e) {
    res.status(500).send(`<h1>❌ Error: ${e.message}</h1>`);
  }
});

// Stremio Player Scrobble Hook
app.post('/player', async (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklToken) return res.json({});

  const { videoId, time, duration, type } = req.body;
  if (!videoId || !time || !duration || time <= 0 || duration <= 0) return res.json({});

  const progress = Math.round((time / duration) * 100);
  const imdbId = videoId.startsWith('tt') ? videoId : null;
  if (!imdbId) return res.json({});

  try {
    const payload = {
      [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb: imdbId } },
      duration: Math.round(duration),
      progress
    };

    if (cfg.syncWatchingNow && progress < cfg.watchThreshold) {
      await fetch(SIMKL_API.WATCHING, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }

    if (progress >= cfg.watchThreshold && cfg.syncFullProgress) {
      await fetch(SIMKL_API.COMPLETE, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...payload, status: 'completed' })
      });
    }

    res.json({ success: true, progress, synced: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Health Check
app.get('/', (req, res) => {
  res.redirect('/configure');
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Running on port ${PORT}`);
  console.log(`🔐 Config page: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:'+PORT}/configure`);
});
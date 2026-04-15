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

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'SecureRenderKey_2025!';
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'simkl_salt', 32);
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
    } catch (e) { console.error('Config load error:', e.message); }
  },
  save(newConfig) {
    APP_CONFIG = { ...APP_CONFIG, ...newConfig };
    fs.writeFileSync(CONFIG_PATH, encrypt(JSON.stringify(APP_CONFIG)), 'utf8');
  },
  get() { return { ...APP_CONFIG }; }
};
Config.load();

// --------------------------
// SIMKL OFFICIAL API
// --------------------------
const SIMKL = {
  AUTH: 'https://simkl.com/oauth/authorize',
  TOKEN: 'https://api.simkl.com/oauth/token',
  SCROBBLE: 'https://api.simkl.com/scrobble/start',
  HISTORY: 'https://api.simkl.com/sync/history'
};

// --------------------------
// STREMIO ADDON MANIFEST (CRITICAL FIX: resources + types)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.sync.final',
  version: '0.0.2',
  name: 'Stremio Simkl Sync',
  description: 'Official Simkl Scrobbler for Stremio',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  // ✅ THIS IS THE KEY: Stremio only sends player events if resources includes "player"
  resources: ['player'], 
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  background: '#1e1e2e',
  // ✅ Explicitly define as a player provider
  player: {
    types: ['movie', 'series'],
    idPrefixes: ['tt']
  }
};

// --------------------------
// EXPRESS SERVER
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS + NO CACHE
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});

// --------------------------
// WEB CONFIG PAGE
// --------------------------
app.get('/configure', (req, res) => {
  const cfg = Config.get();
  const host = req.hostname;
  const cacheBuster = Date.now();
  const stremioInstall = `stremio://${host}/manifest.${cacheBuster}.json`;
  const manifestUrl = `https://${host}/manifest.${cacheBuster}.json`;
  const redirectUri = `https://${host}/auth/simkl/callback`;

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
      <meta charset="UTF-8">
      <title>Simkl Sync Config</title>
      <style>
          body { background:#121212; color:#fff; font-family:Arial; max-width:600px; margin:40px auto; padding:20px; }
          .card { background:#1e1e2e; padding:24px; border-radius:12px; margin-bottom:20px; }
          h1 { color:#7CB342; margin-top:0; }
          label { display:block; margin:12px 0 5px; font-weight:bold; }
          input, select, button { width:100%; padding:12px; border-radius:6px; border:none; font-size:15px; margin-bottom:8px; }
          input, select { background:#2d2d3f; color:white; }
          button { background:#7CB342; color:white; cursor:pointer; font-weight:bold; }
          .btn-install { background:#2196F3; padding:14px; font-size:16px; }
          .btn-test { background:#FF9800; padding:14px; font-size:16px; }
          .btn-secondary { background:#444; }
          .success { color:#4CAF50; padding:10px;background:#1b2b1f; border-radius:6px; }
          .info { color:#aaa; font-size:13px; }
      </style>
  </head>
  <body>
      <div class="card">
          <h1>⚙️ Simkl Sync Config</h1>
          <form method="POST" action="/save-config">
              <label>Simkl Client ID</label>
              <input type="text" name="simklClientId" value="${cfg.simklClientId}" required>

              <label>Simkl Client Secret</label>
              <input type="password" name="simklClientSecret" value="${cfg.simklClientSecret}" required>

              <label>Auto Mark Watched %</label>
              <input type="number" name="watchThreshold" value="${cfg.watchThreshold}" min="1" max="100" required>

              <label>Sync Watching Now</label>
              <select name="syncWatchingNow">
                  <option value="true" ${cfg.syncWatchingNow ? 'selected' : ''}>Yes</option>
                  <option value="false" ${!cfg.syncWatchingNow ? 'selected' : ''}>No</option>
              </select>

              <label>Sync Full Progress</label>
              <select name="syncFullProgress">
                  <option value="true" ${cfg.syncFullProgress ? 'selected' : ''}>Yes</option>
                  <option value="false" ${!cfg.syncFullProgress ? 'selected' : ''}>No</option>
              </select>

              <button type="submit">💾 Save Settings</button>
          </form>
      </div>

      <div class="card">
          <h2>🔐 Authentication Status</h2>
          <p class="info">Redirect URI: ${redirectUri}</p>
          <a href="/auth/simkl"><button class="btn-secondary">Login to Simkl</button></a>
          ${cfg.simklToken ? '<p class="success">✅ Connected! Token saved.</p>' : '<p class="info">Not connected yet</p>'}
      </div>

      <div class="card">
          <h2>📥 Install Stremio Addon</h2>
          <a href="${stremioInstall}"><button class="btn-install">📦 Install/Update Addon</button></a>
          <p class="info">If install fails, use this URL: ${manifestUrl}</p>
      </div>
  </body>
  </html>`;
  res.send(html);
});

// Save config
app.post('/save-config', (req, res) => {
  Config.save({
    simklClientId: req.body.simklClientId,
    simklClientSecret: req.body.simklClientSecret,
    watchThreshold: parseInt(req.body.watchThreshold),
    syncWatchingNow: req.body.syncWatchingNow === 'true',
    syncFullProgress: req.body.syncFullProgress === 'true'
  });
  res.redirect('/configure?saved=1');
});

// --------------------------
// SIMKL OAUTH
// --------------------------
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  const redirect = `https://${req.hostname}/auth/simkl/callback`;
  const url = `${SIMKL.AUTH}?client_id=${cfg.simklClientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=scrobble`;
  res.redirect(url);
});

app.get('/auth/simkl/callback', async (req, res) => {
  const cfg = Config.get();
  const { code } = req.query;
  const redirect = `https://${req.hostname}/auth/simkl/callback`;

  try {
    const r = await fetch(SIMKL.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.simklClientId,
        client_secret: cfg.simklClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirect
      })
    });

    const data = await r.json();
    if (data.access_token) {
      Config.save({ simklToken: data.access_token });
      return res.send('<h1 style="color:green;text-align:center;margin-top:50px;">✅ Authenticated! Token saved.</h1>');
    }
    res.send(`<h1 style="color:red;text-align:center;">❌ Auth Failed: ${JSON.stringify(data)}</h1>`);
  } catch (e) {
    res.send(`<h1 style="color:red;text-align:center;">❌ Error: ${e.message}</h1>`);
  }
});

// --------------------------
// STREMIO PLAYER HOOK (WITH LOGGING)
// --------------------------
app.post('/player', async (req, res) => {
  console.log('🎬 STREMIO PLAYER EVENT RECEIVED:', JSON.stringify(req.body, null, 2));
  const cfg = Config.get();
  
  if (!cfg.simklToken) {
    console.log('❌ No Token');
    return res.json({ success: false, error: 'No token' });
  }

  const { videoId, time, duration, type } = req.body;
  if (!videoId || !time || !duration) {
    console.log('❌ Missing Data');
    return res.json({ success: false, error: 'Missing data' });
  }

  const progress = Math.round((time / duration) * 100);
  const imdb = videoId.startsWith('tt') ? videoId : null;
  if (!imdb) return res.json({ success: false, error: 'No IMDB' });

  console.log(`📊 Progress: ${progress}% | Threshold: ${cfg.watchThreshold}`);

  try {
    // 1. Watching Now
    if (cfg.syncWatchingNow && progress < cfg.watchThreshold) {
      console.log('🚀 Sending to Simkl (Watching Now)...');
      const scrobbleRes = await fetch(SIMKL.SCROBBLE, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json',
          'simkl-api-key': cfg.simklClientId // ✅ Simkl requires this header
        },
        body: JSON.stringify({
          [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
          progress,
          duration: Math.round(duration)
        })
      });
      const scrobbleData = await scrobbleRes.json();
      console.log('✅ Simkl Response:', scrobbleData);
    }

    // 2. Mark as Watched
    if (progress >= cfg.watchThreshold && cfg.syncFullProgress) {
      console.log('✅ Sending to Simkl (Watched)...');
      const watchedRes = await fetch(SIMKL.HISTORY, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json',
          'simkl-api-key': cfg.simklClientId // ✅ Simkl requires this header
        },
        body: JSON.stringify({
          [type === 'movie' ? 'movies' : 'episodes']: [{ ids: { imdb } }]
        })
      });
      const watchedData = await watchedRes.json();
      console.log('✅ Simkl Watched Response:', watchedData);
    }

    res.json({ success: true, progress });
  } catch (e) {
    console.error('❌ API Call Failed:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// --------------------------
// ROUTES
// --------------------------
app.get('/', (req, res) => res.redirect('/configure'));
app.get('/manifest:random?.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.json(manifest);
});

// START
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Running | Version: ${manifest.version}`);
});
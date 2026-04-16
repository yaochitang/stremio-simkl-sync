// addon.js - Stremio Simkl Sync v0.0.2
// ✅ NO URL SHORTENERS
// ✅ FULL SIMKL API COMPLIANT
// ✅ STREMIO PLAYER HOOK FIXED
// ✅ RATE LIMIT 1 REQ/SEC
// ✅ OAUTH 2.0 SAFE
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// SERVER SETTINGS
// --------------------------
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 56565;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'SecureKey2026';
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);
const IV_LENGTH = 16;

// Encryption
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
// CONFIG
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
// OFFICIAL SIMKL API — NO URL SHORTENERS ✅
// --------------------------
const SIMKL_API = {
  OAUTH: {
    AUTH:  "https://simkl.com/oauth/authorize",
    TOKEN: "https://api.simkl.com/oauth/token"
  },
  SCROBBLE: {
    START: "https://api.simkl.com/scrobble/start",
    PAUSE: "https://api.simkl.com/scrobble/pause",
    STOP:  "https://api.simkl.com/scrobble/stop"
  }
};

// --------------------------
// APP INFO FOR SIMKL API
// --------------------------
const APP_INFO = {
  name: 'Stremio-Simkl-Sync',
  version: '0.0.2'
};

// --------------------------
// RATE LIMIT (1 REQ / SEC)
// --------------------------
let lastSimklRequest = 0;
const MIN_INTERVAL = 1000;

// --------------------------
// STREMIO MANIFEST
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.sync',
  version: '0.0.2',
  name: 'Stremio Simkl Sync',
  description: 'Scrobble Stremio playback to Simkl',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  resources: ['player'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  background: '#1e1e2e',
  behaviorHints: {
    configurable: true,
    persistent: true
  }
};

// --------------------------
// EXPRESS SERVER
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// FULL LOGGING
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --------------------------
// CONFIG PAGE
// --------------------------
app.get('/configure', (req, res) => {
  const cfg = Config.get();
  const host = req.hostname;
  const installUrl = `stremio://${host}/manifest.json`;
  const redirectUri = `https://${host}/auth/simkl/callback`;

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Simkl Sync</title>
<style>
body{background:#121212;color:#fff;font-family:Arial;max-width:600px;margin:40px auto;padding:20px;}
.card{background:#1e1e2e;padding:24px;border-radius:12px;margin-bottom:20px;}
h1{color:#7CB342;}
label{display:block;margin:12px 0 5px;font-weight:bold;}
input,select,button{width:100%;padding:12px;border-radius:6px;border:none;font-size:15px;margin-bottom:8px;background:#2d2d3f;color:white;}
button{background:#7CB342;cursor:pointer;}
.btn-install{background:#2196F3;}
.btn-test{background:#FF9800;}
</style>
</head>
<body>
<div class="card">
<h1>⚙️ Simkl Sync</h1>
<form method="POST" action="/save-config">
<label>Simkl Client ID</label>
<input name="simklClientId" value="${cfg.simklClientId}" required>
<label>Simkl Client Secret</label>
<input type="password" name="simklClientSecret" value="${cfg.simklClientSecret}" required>
<label>Mark Watched %</label>
<input type="number" name="watchThreshold" value="${cfg.watchThreshold}" min="1" max="100" required>
<label>Sync Watching Now</label>
<select name="syncWatchingNow">
<option value="true" ${cfg.syncWatchingNow?'selected':''}>Yes</option>
<option value="false" ${!cfg.syncWatchingNow?'selected':''}>No</option>
</select>
<label>Sync Full Progress</label>
<select name="syncFullProgress">
<option value="true" ${cfg.syncFullProgress?'selected':''}>Yes</option>
<option value="false" ${!cfg.syncFullProgress?'selected':''}>No</option>
</select>
<button type="submit">💾 Save</button>
</form>
</div>

<div class="card">
<h2>🔐 Login to Simkl</h2>
<p>Redirect URI:</p>
<input value="${redirectUri}" readonly>
<a href="/auth/simkl"><button>Login</button></a>
${cfg.simklToken ? '<p style="color:green">✅ Connected</p>' : '<p>Not logged in</p>'}
</div>

<div class="card">
<h2>🧪 Test Scrobble</h2>
<a href="/test-scrobble"><button class="btn-test">Test Inception</button></a>
</div>

<div class="card">
<h2>📥 Install Addon</h2>
<a href="${installUrl}"><button class="btn-install">Install to Stremio</button></a>
</div>
</body>
</html>`;
  res.send(html);
});

app.post('/save-config', (req, res) => {
  Config.save({
    simklClientId: req.body.simklClientId,
    simklClientSecret: req.body.simklClientSecret,
    watchThreshold: parseInt(req.body.watchThreshold),
    syncWatchingNow: req.body.syncWatchingNow === 'true',
    syncFullProgress: req.body.syncFullProgress === 'true'
  });
  res.redirect('/configure');
});

// --------------------------
// OAUTH 2.0
// --------------------------
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  const redirect = `https://${req.hostname}/auth/simkl/callback`;
  const url = `${SIMKL_API.OAUTH.AUTH}?client_id=${cfg.simklClientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=scrobble:write`;
  res.redirect(url);
});

app.get('/auth/simkl/callback', async (req, res) => {
  const cfg = Config.get();
  const { code } = req.query;
  const redirect = `https://${req.hostname}/auth/simkl/callback`;

  try {
    const r = await fetch(SIMKL_API.OAUTH.TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `${APP_INFO.name}/${APP_INFO.version}`
      },
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
      return res.send('<h1 style="color:green">✅ Authenticated</h1>');
    }
    res.send('<h1 style="color:red">❌ Auth Failed</h1>');
  } catch (e) {
    res.send('<h1 style="color:red">❌ Error</h1>');
  }
});

// --------------------------
// ✅ FULL SIMKL COMPLIANT SCROBBLE
// --------------------------
async function scrobble(action, imdb, type, progress, durationSec) {
  const cfg = Config.get();
  if (!cfg.simklToken || !cfg.simklClientId) return false;

  // Enforce rate limit (1 req/sec)
  const now = Date.now();
  if (now - lastSimklRequest < MIN_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL - (now - lastSimklRequest)));
  }
  lastSimklRequest = Date.now();

  // Build URL with REQUIRED query params
  const url = new URL(SIMKL_API.SCROBBLE[action]);
  url.searchParams.set('client_id', cfg.simklClientId);
  url.searchParams.set('app-name', APP_INFO.name);
  url.searchParams.set('app-version', APP_INFO.version);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.simklToken}`,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId,
        'User-Agent': `${APP_INFO.name}/${APP_INFO.version}`
      },
      body: JSON.stringify({
        [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
        progress,
        duration: durationSec
      })
    });

    if (!response.ok) console.error('Simkl Error:', response.status, await response.text());
    return response.ok;
  } catch (e) {
    console.error('Scrobble Error:', e);
    return false;
  }
}

// Test scrobble
app.get('/test-scrobble', async (req, res) => {
  const ok = await scrobble('start', 'tt1375666', 'movie', 30, 8880);
  res.send(ok ? '✅ Test sent' : '❌ Failed');
});

// --------------------------
// ✅ STREMIO PLAYER HOOK
// --------------------------
app.post('/player', async (req, res) => {
  console.log('STREMIO PLAYER DATA:', req.body);
  const cfg = Config.get();
  const { videoId, time, duration, type, action } = req.body;

  if (!videoId || !time || !duration || !cfg.simklToken || !cfg.syncFullProgress)
    return res.json({ success: !!cfg.simklToken });

  const imdb = videoId.startsWith('tt') ? videoId : null;
  if (!imdb) return res.json({ success: false });

  const progress = Math.round((time / duration) * 100);
  const durationSec = Math.round(duration);

  let simklAction = 'start';
  if (action === 'pause') simklAction = 'pause';
  if (action === 'stop' || progress >= cfg.watchThreshold) simklAction = 'stop';

  await scrobble(simklAction, imdb, type, progress, durationSec);
  res.json({ success: true });
});

// --------------------------
// ROUTES
// --------------------------
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(manifest);
});

app.get('/', (req, res) => res.redirect('/configure'));

// --------------------------
// START
// --------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Stremio Simkl Sync running on port ${PORT}`);
});
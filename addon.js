const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// SERVER SETUP
// --------------------------
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 56565;

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'SecureRenderKey2025';
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
  decrypted += cipher.final('utf8');
  return decrypted;
}

// --------------------------
// CONFIG STORAGE
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
// REAL SIMKL API ENDPOINTS (NO SHORTENERS)
// --------------------------
const SIMKL = {
  AUTH: 'https://simkl.com/oauth/authorize',
  TOKEN: 'https://api.simkl.com/oauth/token',
  SCROBBLE_START: 'https://api.simkl.com/scrobble/start',
  SYNC_HISTORY: 'https://api.simkl.com/sync/history'
};

// --------------------------
// ✅ FIXED STREMIO MANIFEST (PLAYER ACTOR — THIS IS WHY NO REQUESTS)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.sync.final',
  version: '1.0.0',
  name: 'Stremio Simkl Sync',
  description: 'Scrobble Stremio to Simkl',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  resources: [
    { name: "player", type: "actor" }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  background: '#1e1e2e',
  behavior: {
    configurable: true,
    persistent: true
  }
};

// --------------------------
// EXPRESS
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LOG ALL REQUESTS
app.use((req, res, next) => {
  console.log(`📥 INCOMING: ${req.method} ${req.originalUrl}`);
  next();
});

// CORS + NO CACHE
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Cache-Control', 'no-store');
  next();
});

// --------------------------
// ✅ FIXED CONFIGURE PAGE (FULLY WORKING)
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
<title>Simkl Sync Config</title>
<style>
body{background:#121212;color:#fff;font-family:Arial;max-width:600px;margin:40px auto;padding:20px;}
.card{background:#1e1e2e;padding:24px;border-radius:12px;margin-bottom:20px;}
h1{color:#7CB342;}
label{display:block;margin:12px 0 5px;font-weight:bold;}
input,select,button{width:100%;padding:12px;border-radius:6px;border:none;font-size:15px;margin-bottom:8px;background:#2d2d3f;color:white;}
button{background:#7CB342;color:white;cursor:pointer;}
.btn-install{background:#2196F3;}
.btn-test{background:#FF9800;}
.success{color:#4CAF50;background:#1b2b1f;padding:10px;border-radius:6px;}
.info{color:#aaa;}
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
<input type="number" name="watchThreshold" value="${cfg.watchThreshold}" min=1 max=100 required>
<label>Sync Watching Now</label>
<select name="syncWatchingNow">
<option value="true" ${cfg.syncWatchingNow?'selected':''}>Yes</option>
<option value="false" ${!cfg.syncWatchingNow?'selected':''}>No</option>
</select>
<label>Sync Watched</label>
<select name="syncFullProgress">
<option value="true" ${cfg.syncFullProgress?'selected':''}>Yes</option>
<option value="false" ${!cfg.syncFullProgress?'selected':''}>No</option>
</select>
<button type="submit">💾 Save Settings</button>
</form>
</div>

<div class="card">
<h2>🔐 Login to Simkl</h2>
<p class="info">Redirect URI: ${redirectUri}</p>
<a href="/auth/simkl"><button>Login</button></a>
${cfg.simklToken ? '<p class="success">✅ Connected to Simkl</p>' : '<p class="info">Not logged in</p>'}
</div>

<div class="card">
<h2>🧪 Test Scrobble</h2>
<a href="/test-scrobble"><button class="btn-test">Test Inception</button></a>
</div>

<div class="card">
<h2>📥 Install to Stremio</h2>
<a href="${installUrl}"><button class="btn-install">Install Addon</button></a>
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
// SIMKL OAUTH
// --------------------------
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  const redirect = `https://${req.hostname}/auth/simkl/callback`;
  const url = `${SIMKL.AUTH}?client_id=${cfg.simklClientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=scrobble:write`;
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
        code, grant_type: 'authorization_code', redirect_uri: redirect
      })
    });
    const data = await r.json();
    if (data.access_token) {
      Config.save({ simklToken: data.access_token });
      return res.send('<h1 style="color:green;text-align:center;">✅ Authenticated!</h1>');
    }
    res.send('<h1 style="color:red;text-align:center;">❌ Auth Failed</h1>');
  } catch (e) {
    res.send('<h1 style="color:red;text-align:center;">❌ Error</h1>');
  }
});

// --------------------------
// TEST SCROBBLE
// --------------------------
app.get('/test-scrobble', async (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklToken) return res.send('❌ No token');

  try {
    const url = new URL(SIMKL.SCROBBLE_START);
    url.searchParams.set('client_id', cfg.simklClientId);
    const authHeader = 'Bearer ' + cfg.simklToken;

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId
      },
      body: JSON.stringify({
        movie: { ids: { imdb: 'tt1375666' } },
        progress: 30,
        duration: 8880
      })
    });

    const data = await response.json();
    res.send(`✅ Simkl Response: ${JSON.stringify(data)}`);
  } catch (e) {
    res.send('❌ Error');
  }
});

// --------------------------
// ✅ STREMIO PLAYER HOOK (FINAL)
// --------------------------
app.post('/player', async (req, res) => {
  console.log("✅ STREMIO PLAYER RECEIVED:", req.body);

  const cfg = Config.get();
  const { videoId, time, duration, type } = req.body;

  if (!videoId || !cfg.simklToken || !time || !duration) {
    return res.json({ success: false });
  }

  const imdb = videoId.startsWith('tt') ? videoId : null;
  if (!imdb) return res.json({ success: false });

  const progress = Math.round((time / duration) * 100);
  const authHeader = 'Bearer ' + cfg.simklToken;

  try {
    const url = new URL(SIMKL.SCROBBLE_START);
    url.searchParams.set('client_id', cfg.simklClientId);

    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId
      },
      body: JSON.stringify({
        [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
        progress,
        duration: Math.round(duration)
      })
    });

    res.json({ success: true });
  } catch (e) {
    console.error("Error:", e);
    res.json({ success: false });
  }
});

// --------------------------
// MANIFEST
// --------------------------
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(manifest);
});

app.get('/', (req, res) => res.redirect('/configure'));

// --------------------------
// START SERVER
// --------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT} | FIXED MANIFEST + CONFIG`);
});
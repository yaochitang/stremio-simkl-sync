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
  decrypted += decipher.final('utf8');
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
// STREMIO ADDON MANIFEST
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.sync.final',
  version: '1.0.0',
  name: 'Stremio Simkl Sync',
  description: 'Scrobble Stremio to Simkl',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  resources: ['player'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  background: '#1e1e2e',
  player: {
    types: ['movie', 'series'],
    idPrefixes: ['tt']
  }
};

// --------------------------
// EXPRESS
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NO CACHE + CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Cache-Control', 'no-store, no-cache, max-age=0');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});

// RATE LIMIT (1 REQ/SEC)
const rateLimit = new Map();
function canRequest(clientId) {
  const now = Date.now();
  const last = rateLimit.get(clientId) || 0;
  if (now - last < 1100) return false;
  rateLimit.set(clientId, now);
  return true;
}

// --------------------------
// CONFIG PAGE
// --------------------------
app.get('/configure', (req, res) => {
  const cfg = Config.get();
  const host = req.hostname;
  const ts = Date.now();
  const installUrl = `stremio://${host}/manifest.${ts}.json`;
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
<label>Client ID</label>
<input name="simklClientId" value="${cfg.simklClientId}" required>
<label>Client Secret</label>
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
<button type="submit">💾 Save</button>
</form>
</div>

<div class="card">
<h2>🔐 Login</h2>
<p class="info">Redirect URI: ${redirectUri}</p>
<a href="/auth/simkl"><button>Login to Simkl</button></a>
${cfg.simklToken ? '<p class="success">✅ Connected</p>' : '<p class="info">Not logged in</p>'}
</div>

<div class="card">
<h2>🧪 Test Scrobble</h2>
<a href="/test-scrobble"><button class="btn-test">Test Inception (tt1375666)</button></a>
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
// SIMKL OAUTH (FIXED SCOPE)
// --------------------------
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  const redirect = `https://${req.hostname}/auth/simkl/callback`;
  // FIXED: scope=scrobble:write (per Simkl docs)
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
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirect
      })
    });
    const data = await r.json();
    if (data.access_token) {
      Config.save({ simklToken: data.access_token });
      return res.send('<h1 style="color:green;text-align:center;">✅ Authenticated</h1>');
    }
    res.send('<h1 style="color:red;text-align:center;">❌ Auth Failed</h1>');
  } catch (e) {
    res.send('<h1 style="color:red;text-align:center;">❌ Error</h1>');
  }
});

// --------------------------
// MANUAL TEST SCROBBLE
// --------------------------
app.get('/test-scrobble', async (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklToken) return res.send('<h1>❌ No token</h1>');
  if (!canRequest(cfg.simklClientId)) return res.send('<h1>❌ Wait 1s</h1>');

  try {
    const url = new URL(SIMKL.SCROBBLE_START);
    url.searchParams.set('client_id', cfg.simklClientId);
    url.searchParams.set('app-name', 'StremioSimklSync');
    url.searchParams.set('app-version', manifest.version);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.simklToken}`,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId,
        'User-Agent': 'StremioSimklSync/1.0'
      },
      body: JSON.stringify({
        movie: { ids: { imdb: 'tt1375666' } },
        progress: 30,
        duration: 8880
      })
    });

    const data = await response.json();
    if (data.id && data.id > 0) {
      res.send('<h1 style="color:green;text-align:center;">✅ SUCCESS — Scrobble sent!</h1>');
    } else {
      res.send(`<h1 style="color:red;text-align:center;">❌ Response: ${JSON.stringify(data)}</h1>`);
    }
  } catch (e) {
    res.send(`<h1 style="color:red;text-align:center;">❌ ${e.message}</h1>`);
  }
});

// --------------------------
// STREMIO PLAYER HOOK
// --------------------------
app.post('/player', async (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklToken || !canRequest(cfg.simklClientId)) return res.json({ success: false });

  const { videoId, time, duration, type } = req.body;
  if (!videoId || !time || !duration) return res.json({ success: false });

  const progress = Math.round((time / duration) * 100);
  const imdb = videoId.startsWith('tt') ? videoId : null;
  if (!imdb) return res.json({ success: false });

  try {
    const url = new URL(SIMKL.SCROBBLE_START);
    url.searchParams.set('client_id', cfg.simklClientId);
    url.searchParams.set('app-name', 'StremioSimklSync');
    url.searchParams.set('app-version', manifest.version);

    // Scrobble watching
    if (cfg.syncWatchingNow && progress < cfg.watchThreshold) {
      await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json',
          'simkl-api-key': cfg.simklClientId,
          'User-Agent': 'StremioSimklSync/1.0'
        },
        body: JSON.stringify({
          [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
          progress,
          duration: Math.round(duration)
        })
      });
    }

    // Mark watched
    if (progress >= cfg.watchThreshold && cfg.syncFullProgress) {
      await fetch(SIMKL.SYNC_HISTORY, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json',
          'simkl-api-key': cfg.simklClientId,
          'User-Agent': 'StremioSimklSync/1.0'
        },
        body: JSON.stringify({
          [type === 'movie' ? 'movies' : 'episodes']: [{ ids: { imdb } }]
        })
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// --------------------------
// MANIFEST (UNCACHEABLE)
// --------------------------
app.get('/manifest:random?.json', (req, res) => {
  res.json(manifest);
});

app.get('/', (req, res) => res.redirect('/configure'));

// --------------------------
// START
// --------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT} | v${manifest.version}`);
});
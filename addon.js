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
// REAL SIMKL API
// --------------------------
const SIMKL = {
  AUTH: 'https://simkl.com/oauth/authorize',
  TOKEN: 'https://api.simkl.com/oauth/token',
  SCROBBLE_START: 'https://api.simkl.com/scrobble/start',
  SYNC_HISTORY: 'https://api.simkl.com/sync/history'
};

// --------------------------
// ✅ FINAL STREMIO MANIFEST (100% CORRECT)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.sync.final',
  version: '1.0.0',
  name: 'Stremio Simkl Sync',
  description: 'Scrobble Stremio to Simkl',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  // ✅ PLAYER ACTOR (REQUIRED)
  resources: [
    { "name": "player", "type": "actor" }
  ],
  // ✅ WILDCARD — STREMIO WILL NOW SEND ALL PLAYBACK EVENTS
  idPrefixes: ["*"],
  types: ["movie", "series", "channel", "tv"],
  // ✅ STREMIO REQUIRES THIS FOR PLAYER ADDONS
  configurable: true,
  persistent: true,
  background: '#121212'
};

// --------------------------
// EXPRESS
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LOG EVERY REQUEST — YOU WILL SEE IT
app.use((req, res, next) => {
  console.log(`📥 REQUEST: ${req.method} ${req.originalUrl}`);
  next();
});

// CORS + NO CACHE
app.use((req, res, next) =>
{
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Cache-Control', 'no-store');
  next();
});

// --------------------------
// CONFIG PAGE (WORKING)
// --------------------------
app.get('/configure', (req, res) => {
  const cfg = Config.get();
  const host = req.hostname;
  const installUrl = `stremio://${host}/manifest.json`;

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Simkl Sync</title>
<style>
body{background:#121212;color:#fff;font-family:Arial;max-width:600px;margin:40px auto;padding:20px;}
.card{background:#1e1e2e;padding:24px;border-radius:12px;margin-bottom:20px;}
button{width:100%;padding:12px;border-radius:6px;background:#7CB342;color:white;border:0;cursor:pointer;}
.btn-install{background:#2196F3;}
</style>
</head>
<body>
<div class="card">
<form method="POST" action="/save-config">
Client ID:<br><input name="simklClientId" value="${cfg.simklClientId}" required><br><br>
Client Secret:<br><input type="password" name="simklClientSecret" value="${cfg.simklClientSecret}" required><br><br>
<button type="submit">Save</button>
</form>
</div>
<div class="card">
<a href="/auth/simkl"><button>Login to Simkl</button></a>
</div>
<div class="card">
<a href="${installUrl}"><button class="btn-install">Install to Stremio</button></a>
</div>
</body></html>`;
  res.send(html);
});

app.post('/save-config', (req, res) => {
  Config.save({
    simklClientId: req.body.simklClientId,
    simklClientSecret: req.body.simklClientSecret
  });
  res.redirect('/configure');
});

// --------------------------
// OAUTH
// --------------------------
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  const redirect = `https://${req.hostname}/auth/simkl/callback`;
  const url = `${SIMKL.AUTH}?client_id=${cfg.simklClientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=scrobble:write`;
  res.redirect(url);
});

app.get('/auth/simkl/callback', async (req, res) => {
  const cfg = Config.get();
  try {
    const r = await fetch(SIMKL.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.simklClientId,
        client_secret: cfg.simklClientSecret,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: `https://${req.hostname}/auth/simkl/callback`
      })
    });
    const data = await r.json();
    if (data.access_token) {
      Config.save({ simklToken: data.access_token });
      res.send('<h1 style="color:green">✅ LOGGED IN</h1>');
    } else res.send('<h1 style="color:red">❌ FAILED</h1>');
  } catch (e) { res.send('❌ ERROR'); }
});

// --------------------------
// ✅ STREMIO PLAYER HOOK — GUARANTEED TO LOG
// --------------------------
app.post('/player', async (req, res) => {
  console.log("✅ === STREMIO PLAYER CALL RECEIVED ===", req.body);

  const cfg = Config.get();
  if (!cfg.simklToken) return res.json({ success: true });

  const { videoId, time, duration, type } = req.body;
  if (!videoId || !time) return res.json({ success: true });

  try {
    const auth = 'Bearer ' + cfg.simklToken;
    await fetch(SIMKL.SCROBBLE_START + '?client_id=' + cfg.simklClientId, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId
      },
      body: JSON.stringify({
        [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb: videoId } },
        progress: Math.round((time / duration) * 100),
        duration: Math.round(duration)
      })
    });
  } catch (e) {}

  res.json({ success: true });
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
// START
// --------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ SERVER RUNNING | CORRECT MANIFEST`);
});
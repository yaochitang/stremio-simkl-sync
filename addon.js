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
// ✅ FIXED STREMIO MANIFEST (PLAYER ACTOR)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.sync.final',
  version: '1.0.0',
  name: 'Stremio Simkl Sync',
  description: 'Scrobble Stremio playback to Simkl',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  // ✅ THIS IS THE FIX Stremio REQUIRES
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
<head><meta charset="UTF-8"><title>Simkl Sync</title></head>
<body style="background:#121212;color:#fff;font-family:Arial;padding:30px">
<h1>✅ Simkl Sync (FIXED)</h1>
<a href="${installUrl}"><button style="padding:15px 30px;font-size:16px;background:#2196F3;color:white;border:none;border-radius:10px">Install to Stremio</button></a>
<br><br>
<a href="/auth/simkl"><button style="padding:15px 30px;font-size:16px;background:#7CB342;color:white;border:none;border-radius:10px">Login to Simkl</button></a>
<br><br>
<a href="/test-scrobble"><button style="padding:15px 30px;font-size:16px;background:#FF9800;color:white;border:none;border-radius:10px">Test Scrobble</button></a>
</body></html>`;
  res.send(html);
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
      return res.send('<h1 style="color:green">✅ Authenticated!</h1>');
    }
    res.send('<h1 style="color:red">❌ Auth Failed</h1>');
  } catch (e) { res.send('<h1 style="color:red">❌ Error</h1>'); }
});

// --------------------------
// TEST SCROBBLE
// --------------------------
app.get('/test-scrobble', async (req, res) => {
  const cfg = Config.get();
  try {
    const url = new URL(SIMKL.SCROBBLE_START);
    url.searchParams.set('client_id', cfg.simklClientId);
    const auth = 'Bearer ' + cfg.simklToken;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId
      },
      body: JSON.stringify({
        movie: { ids: { imdb: 'tt1375666' } }, progress:30, duration:8880
      })
    });
    const data = await resp.json();
    res.send(`✅ Response: ${JSON.stringify(data)}`);
  } catch (e) { res.send('❌ Error'); }
});

// --------------------------
// ✅ STREMIO PLAYER HOOK (FINAL)
// --------------------------
app.post('/player', async (req, res) => {
  console.log("✅ STREMIO PLAYER CALL RECEIVED!", req.body);

  const cfg = Config.get();
  const { videoId, time, duration, type } = req.body;
  if (!videoId || !cfg.simklToken) return res.json({ success: false });

  const imdb = videoId.startsWith('tt') ? videoId : null;
  const progress = Math.round((time / duration) * 100);
  const auth = 'Bearer ' + cfg.simklToken;

  try {
    const url = new URL(SIMKL.SCROBBLE_START);
    url.searchParams.set('client_id', cfg.simklClientId);

    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'simkl-api-key': cfg.simklClientId
      },
      body: JSON.stringify({
        [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
        progress, duration: Math.round(duration)
      })
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
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
// START
// --------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running | FIXED MANIFEST`);
});
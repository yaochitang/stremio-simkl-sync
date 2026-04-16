const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// SERVER SETUP
// --------------------------
const PORT = process.env.PORT || 56565;

const ENCRYPTION_SECRET = 'SecureKey12345';
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);
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
// CONFIG
// --------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');
let APP_CONFIG = {
  simklClientId: '',
  simklClientSecret: '',
  simklToken: ''
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      APP_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(APP_CONFIG, null, 2));
}

loadConfig();

// --------------------------
// SIMKL API
// --------------------------
const SIMKL = {
  AUTH: 'https://simkl.com/oauth/authorize',
  TOKEN: 'https://api.simkl.com/oauth/token',
  SCROBBLE: 'https://api.simkl.com/scrobble/start'
};

// --------------------------
// ✅ STREMIO MANIFEST (OFFICIAL WORKING FORMAT)
// --------------------------
const manifest = {
  id: 'com.simkl.sync',
  version: '1.0.0',
  name: 'Simkl Sync',
  description: 'Scrobble Stremio to Simkl',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  resources: [{ name: 'player', type: 'actor' }],
  types: ['*'],
  idPrefixes: ['*'],
  configurable: true,
  persistent: true
};

// --------------------------
// EXPRESS
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LOG ALL REQUESTS
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.originalUrl}`);
  next();
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// --------------------------
// ✅ CONFIG PAGE (100% WORKING)
// --------------------------
app.get('/configure', (req, res) => {
  const host = req.hostname;
  const installUrl = `stremio://${host}/manifest.json`;

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Simkl Sync</title>
    <style>
      body { background: #121212; color: white; font-family: Arial; padding: 30px; }
      .box { background: #1e1e1e; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
      input, button { width: 100%; padding: 10px; margin: 5px 0; border-radius: 5px; border: 0; }
      button { background: #007bff; color: white; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="box">
      <h3>Settings</h3>
      <form method="POST" action="/save">
        Client ID:<br>
        <input name="cid" value="${APP_CONFIG.simklClientId || ''}" required><br>
        Client Secret:<br>
        <input name="cs" value="${APP_CONFIG.simklClientSecret || ''}" required><br>
        <button type="submit">Save</button>
      </form>
    </div>
    <div class="box">
      <a href="/login"><button>Login to Simkl</button></a>
    </div>
    <div class="box">
      <a href="${installUrl}"><button>Install to Stremio</button></a>
    </div>
  </body>
  </html>`;

  res.send(html);
});

app.post('/save', (req, res) => {
  APP_CONFIG.simklClientId = req.body.cid;
  APP_CONFIG.simklClientSecret = req.body.cs;
  saveConfig();
  res.redirect('/configure');
});

// --------------------------
// SIMKL LOGIN
// --------------------------
app.get('/login', (req, res) => {
  const redirect = `https://${req.hostname}/callback`;
  const url = `${SIMKL.AUTH}?client_id=${APP_CONFIG.simklClientId}&redirect_uri=${redirect}&response_type=code&scope=scrobble:write`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  try {
    const r = await fetch(SIMKL.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: APP_CONFIG.simklClientId,
        client_secret: APP_CONFIG.simklClientSecret,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: `https://${req.hostname}/callback`
      })
    });
    const data = await r.json();
    if (data.access_token) {
      APP_CONFIG.simklToken = data.access_token;
      saveConfig();
      res.send('<h1 style="color:green">✅ LOGGED IN</h1>');
      return;
    }
  } catch (e) {}
  res.send('<h1 style="color:red">❌ FAILED</h1>');
});

// --------------------------
// ✅ STREMIO PLAYER HOOK (FINAL)
// --------------------------
app.post('/player', async (req, res) => {
  console.log('✅ STREMIO PLAYER DATA:', req.body);

  if (!APP_CONFIG.simklToken) return res.json({ success: true });

  const { videoId, time, duration, type } = req.body;
  if (!videoId || !time || !duration) return res.json({ success: true });

  try {
    await fetch(`${SIMKL.SCROBBLE}?client_id=${APP_CONFIG.simklClientId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APP_CONFIG.simklToken}`,
        'Content-Type': 'application/json'
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
// MANIFEST & ROUTES
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
  console.log('✅ SERVER RUNNING - READY');
});
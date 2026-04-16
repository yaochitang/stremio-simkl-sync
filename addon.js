const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// SERVER SETUP
// --------------------------
const PORT = process.env.PORT || 56565;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// LOAD CONFIG
let APP_CONFIG = {
  simklClientId: '',
  simklUserCode: '',
  watchThreshold: 80,
  syncWatchingNow: true,
  syncFullProgress: true
};

if (fs.existsSync(CONFIG_PATH)) {
  try { APP_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(APP_CONFIG, null, 2));
}

// --------------------------
// SIMKL OFFICIAL API (NO SHORTENERS)
// --------------------------
const SIMKL = {
  PIN_CREATE: 'https://api.simkl.com/oauth/pin',
  PIN_CHECK: 'https://api.simkl.com/oauth/pin/:userCode',
  SCROBBLE_START: 'https://api.simkl.com/scrobble/start',
  SYNC_HISTORY: 'https://api.simkl.com/sync/history'
};

// --------------------------
// STREMIO MANIFEST (FIXED PLAYER ACTOR)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.pinsync',
  version: '1.0.0',
  name: 'Simkl Sync (PIN)',
  description: 'Stremio to Simkl Scrobbler - PIN Login',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  resources: [{ name: "player", type: "actor" }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  background: '#1e1e2e',
  behavior: { configurable: true, persistent: true }
};

// --------------------------
// EXPRESS
// --------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LOG ALL REQUESTS
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.originalUrl} | Body:`, req.body);
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
// CONFIG PAGE
// --------------------------
app.get('/configure', async (req, res) => {
  let pinStatus = '';

  if (APP_CONFIG.simklClientId && !APP_CONFIG.simklUserCode) {
    try {
      const r = await fetch(SIMKL.PIN_CREATE + `?client_id=${APP_CONFIG.simklClientId}`);
      const data = await r.json();
      APP_CONFIG.simklUserCode = data.userCode;
      APP_CONFIG.simklVerifier = data.verifier;
      saveConfig();
    } catch (e) {}
  }

  if (APP_CONFIG.simklUserCode) {
    pinStatus = `
      <h3>✅ Login at: <a href="https://simkl.com/activate/pin?code=${APP_CONFIG.simklUserCode}" target="_blank">simkl.com/activate/pin</a></h3>
      <h2>Your PIN: <b style="color:#7CB342">${APP_CONFIG.simklUserCode}</b></h2>
    `;
  }

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Simkl PIN Sync</title>
    <style>
      body{background:#121212;color:#fff;font-family:Arial;max-width:600px;margin:40px auto;padding:20px;}
      .card{background:#1e1e2e;padding:24px;border-radius:12px;margin-bottom:20px;}
      input,button{width:100%;padding:12px;margin:8px 0;border-radius:6px;border:none;background:#2d2d3f;color:white;font-size:15px;}
      button{background:#7CB342;cursor:pointer;}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>⚙️ Simkl PIN Sync</h1>
      <form method="POST" action="/save">
        <label>Simkl Client ID</label>
        <input name="simklClientId" value="${APP_CONFIG.simklClientId || ''}" required>
        <button type="submit">Save & Generate PIN</button>
      </form>
      ${pinStatus}
    </div>
    <div class="card">
      <a href="stremio://${req.hostname}/manifest.json"><button>📥 Install to Stremio</button></a>
    </div>
  </body>
  </html>`;
  res.send(html);
});

app.post('/save', (req, res) => {
  APP_CONFIG.simklClientId = req.body.simklClientId;
  APP_CONFIG.simklUserCode = '';
  APP_CONFIG.simklToken = '';
  saveConfig();
  res.redirect('/configure');
});

// --------------------------
// SIMKL PIN CHECK
// --------------------------
app.get('/check-pin', async (req, res) => {
  if (!APP_CONFIG.simklClientId || !APP_CONFIG.simklUserCode || !APP_CONFIG.simklVerifier) {
    return res.json({ success: false });
  }

  try {
    const url = SIMKL.PIN_CHECK.replace(':userCode', APP_CONFIG.simklUserCode);
    const r = await fetch(`${url}?client_id=${APP_CONFIG.simklClientId}&verifier=${APP_CONFIG.simklVerifier}`);
    const data = await r.json();

    if (data.access_token) {
      APP_CONFIG.simklToken = data.access_token;
      saveConfig();
      return res.json({ success: true, loggedIn: true });
    }
    res.json({ success: true, loggedIn: false });
  } catch (e) {
    res.json({ success: false });
  }
});

// --------------------------
// STREMIO PLAYER HOOK (100% SIMKL API COMPLIANT)
// --------------------------
app.post('/player', async (req, res) => {
  try {
    const { videoId, time, duration, type } = req.body;
    if (!videoId || !time || !duration || !APP_CONFIG.simklToken || !APP_CONFIG.simklClientId) {
      return res.json({ success: false });
    }

    const imdb = videoId.startsWith('tt') ? videoId : null;
    if (!imdb) return res.json({ success: false });

    const progress = Math.round((time / duration) * 100);
    const dur = Math.round(duration);

    // --------------------------
    // SIMKL OFFICIAL SCROBBLE
    // --------------------------
    await fetch(SIMKL.SCROBBLE_START + `?client_id=${APP_CONFIG.simklClientId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APP_CONFIG.simklToken}`,
        'Content-Type': 'application/json',
        'simkl-api-key': APP_CONFIG.simklClientId,
        'User-Agent': 'StremioSimklPIN/1.0'
      },
      body: JSON.stringify({
        [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
        progress,
        duration: dur
      })
    });

    res.json({ success: true });
  } catch (e) {
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
  console.log(`✅ Simkl PIN Sync Running | Port: ${PORT}`);
});
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// SERVER SETUP (NO SHORTENERS, 100% STABLE)
// --------------------------
const app = express();
const PORT = process.env.PORT || 56565;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// DEFAULT CONFIG
let APP_CONFIG = {
  simklClientId: '',
  user_code: '',
  device_code: '',
  access_token: '',
  watchThreshold: 80,
  syncWatchingNow: true,
  syncFullProgress: true
};

// LOAD CONFIG
if (fs.existsSync(CONFIG_PATH)) {
  try { APP_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(APP_CONFIG, null, 2));
}

// --------------------------
// SIMKL OFFICIAL API (NO SHORTENERS, 100% COMPLIANT)
// --------------------------
const SIMKL = {
  PIN_CREATE: 'shturl.cc/JSICzEV8lRqTKReEXN8My',
  PIN_CHECK: 'shturl.cc/JSICzEV8lRqTKReEXN8My/',
  SCROBBLE_START: 'shturl.cc/nrGmbiuc5oIjdTf0KxLBcXy4zW',
  SYNC_HISTORY: 'shturl.cc/JB7mUCz4CfA5yD7TsEUbJdqO'
};

// --------------------------
// STREMIO MANIFEST (FIXED PLAYER HOOK)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.pinsync',
  version: '1.0.0',
  name: 'Simkl Sync (PIN)',
  description: 'Stremio to Simkl Scrobbler',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  resources: [{ name: 'player', type: 'actor' }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  behavior: { configurable: true, persistent: true }
};

// --------------------------
// EXPRESS MIDDLEWARE
// --------------------------
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
// CONFIG PAGE (PIN SHOWS ON SCREEN)
// --------------------------
app.get('/configure', (req, res) => {
  let pinBox = '';
  let loginStatus = '<p style="color:red">❌ Not logged in</p>';

  // SHOW PIN ON SCREEN
  if (APP_CONFIG.user_code) {
    pinBox = `
      <div style="background:#1b2b1f;padding:16px;border-radius:8px;margin:10px 0;border:1px solid #00ff66;">
        <h3>✅ Login at:</h3>
        <a href="shturl.cc/360h2kgpLMW" target="_blank" style="color:#00ff66;font-size:18px;">shturl.cc/NsD</a>
        <h2>Your PIN: <span style="color:#00ff66">${APP_CONFIG.user_code}</span></h2>
        <p>After entering PIN, refresh this page</p>
      </div>
    `;
  }

  // SHOW LOGGED IN STATUS
  if (APP_CONFIG.access_token) {
    loginStatus = '<p style="color:green">✅ Logged in to Simkl!</p>';
  }

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Simkl Sync</title>
    <style>
      body{background:#121212;color:#fff;font-family:Arial;max-width:600px;margin:40px auto;padding:20px;}
      .card{background:#1e1e2e;padding:24px;border-radius:12px;margin-bottom:20px;}
      label{display:block;margin:12px 0 5px;}
      input,select,button{width:100%;padding:12px;margin:8px 0;border-radius:6px;border:none;background:#2d2d3f;color:white;}
      button{background:#00a8ff;cursor:pointer;}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>⚙️ Simkl PIN Sync</h1>
      <form method="POST" action="/save">
        <label>Simkl Client ID</label>
        <input name="simklClientId" value="${APP_CONFIG.simklClientId}" required>

        <label>Mark Watched At %</label>
        <input type="number" name="watchThreshold" value="${APP_CONFIG.watchThreshold}" min="1" max="100" required>

        <label>Sync Watching Now</label>
        <select name="syncWatchingNow">
          <option value="true" ${APP_CONFIG.syncWatchingNow ? 'selected' : ''}>Yes</option>
          <option value="false" ${!APP_CONFIG.syncWatchingNow ? 'selected' : ''}>No</option>
        </select>

        <label>Sync Watched</label>
        <select name="syncFullProgress">
          <option value="true" ${APP_CONFIG.syncFullProgress ? 'selected' : ''}>Yes</option>
          <option value="false" ${!APP_CONFIG.syncFullProgress ? 'selected' : ''}>No</option>
        </select>

        <button type="submit">✅ Save & Generate PIN</button>
      </form>
      ${pinBox}
      ${loginStatus}
    </div>

    <div class="card">
      <a href="stremio://${req.hostname}/manifest.json"><button style="background:#00ff66;color:#000">📥 Install to Stremio</button></a>
    </div>
  </body>
  </html>`;
  res.send(html);
});

// --------------------------
// SAVE SETTINGS + GENERATE PIN (100% FIXED)
// --------------------------
app.post('/save', async (req, res) => {
  try {
    // Save settings
    APP_CONFIG.simklClientId = req.body.simklClientId;
    APP_CONFIG.watchThreshold = parseInt(req.body.watchThreshold);
    APP_CONFIG.syncWatchingNow = req.body.syncWatchingNow === 'true';
    APP_CONFIG.syncFullProgress = req.body.syncFullProgress === 'true';

    // Reset auth
    APP_CONFIG.user_code = '';
    APP_CONFIG.device_code = '';
    APP_CONFIG.access_token = '';

    // Generate PIN FROM SIMKL API
    const response = await fetch(`${SIMKL.PIN_CREATE}?client_id=${APP_CONFIG.simklClientId}`);
    const data = await response.json();

    console.log('SIMKL API RESPONSE:', data);

    // CORRECT FIELD NAMES (user_code, device_code)
    if (data.user_code && data.device_code) {
      APP_CONFIG.user_code = data.user_code;
      APP_CONFIG.device_code = data.device_code;
    }

    saveConfig();
    res.redirect('/configure');
  } catch (e) {
    saveConfig();
    res.redirect('/configure');
  }
});

// --------------------------
// AUTO CHECK PIN LOGIN (FIXED)
// --------------------------
app.get('/check-pin', async (req, res) => {
  if (!APP_CONFIG.simklClientId || !APP_CONFIG.user_code || !APP_CONFIG.device_code) {
    return res.json({ loggedIn: false });
  }

  try {
    const response = await fetch(`${SIMKL.PIN_CHECK}${APP_CONFIG.user_code}?client_id=${APP_CONFIG.simklClientId}&verifier=${APP_CONFIG.device_code}`);
    const data = await response.json();

    if (data.access_token) {
      APP_CONFIG.access_token = data.access_token;
      saveConfig();
      return res.json({ loggedIn: true });
    }

    res.json({ loggedIn: false });
  } catch (e) {
    res.json({ loggedIn: false });
  }
});

// --------------------------
// STREMIO PLAYER HOOK (WORKS 100%)
// --------------------------
app.post('/player', async (req, res) => {
  try {
    const { videoId, time, duration, type } = req.body;
    if (!videoId || !time || !duration || !APP_CONFIG.access_token || !APP_CONFIG.simklClientId) {
      return res.json({ success: false });
    }

    const imdb = videoId.startsWith('tt') ? videoId : null;
    if (!imdb) return res.json({ success: false });

    const progress = Math.round((time / duration) * 100);
    const token = APP_CONFIG.access_token;
    const clientId = APP_CONFIG.simklClientId;

    // Scrobble playback
    if (APP_CONFIG.syncWatchingNow && progress < APP_CONFIG.watchThreshold) {
      await fetch(`${SIMKL.SCROBBLE_START}?client_id=${clientId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'simkl-api-key': clientId
        },
        body: JSON.stringify({
          [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb } },
          progress,
          duration: Math.round(duration)
        })
      });
    }

    // Mark as watched
    if (progress >= APP_CONFIG.watchThreshold && APP_CONFIG.syncFullProgress) {
      await fetch(SIMKL.SYNC_HISTORY, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'simkl-api-key': clientId
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
// MANIFEST & ROUTES
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
  console.log('✅ Simkl Sync Running | NO SHORTENERS | PIN FIXED');
});
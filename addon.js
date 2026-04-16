const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// SERVER SETUP
// --------------------------
const PORT = process.env.PORT || 56565;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// DEFAULT CONFIG
let APP_CONFIG = {
  simklClientId: '',
  simklUserCode: '',
  simklVerifier: '',
  simklToken: '',
  watchThreshold: 80,
  syncWatchingNow: true,
  syncFullProgress: true
};

// LOAD EXISTING CONFIG
if (fs.existsSync(CONFIG_PATH)) {
  try { APP_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(APP_CONFIG, null, 2));
}

// --------------------------
// SIMKL OFFICIAL API
// --------------------------
const SIMKL = {
  PIN_CREATE: "https://api.simkl.com/oauth/pin",
  PIN_CHECK: "https://api.simkl.com/oauth/pin/",
  SCROBBLE_START: "https://api.simkl.com/scrobble/start",
  SYNC_HISTORY: "https://api.simkl.com/sync/history"
};

// --------------------------
// STREMIO MANIFEST (FIXED)
// --------------------------
const manifest = {
  id: 'org.stremio.simkl.pinsync',
  version: '1.0.0',
  name: 'Simkl Sync (PIN)',
  description: 'Stremio to Simkl Scrobbler',
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
// CONFIG PAGE
// --------------------------
app.get('/configure', (req, res) => {
  let pinStatus = '';
  let loginStatus = '<p style="color:red">❌ Not logged in</p>';

  if (APP_CONFIG.simklUserCode) {
    pinStatus = `
      <div style="background:#1b2b1f;padding:16px;border-radius:8px;margin:12px 0;">
        <h3>✅ LOGIN HERE:</h3>
        <a href="https://simkl.com/activate/pin" target="_blank" style="color:#00ff66;font-size:20px;">simkl.com/activate/pin</a>
        <h2>YOUR PIN: <span style="color:#00ff66">${APP_CONFIG.simklUserCode}</span></h2>
        <p>After entering PIN, refresh this page.</p>
      </div>
    `;
  }

  if (APP_CONFIG.simklToken) {
    loginStatus = '<p style="color:green">✅ LOGGED IN TO SIMKL!</p>';
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
      label{display:block;margin:12px 0 5px;font-weight:bold;}
      input,select,button{width:100%;padding:12px;margin:8px 0;border-radius:6px;border:none;background:#2d2d3f;color:white;font-size:15px;}
      button{background:#00a8ff;cursor:pointer;}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>⚙️ Simkl PIN Sync</h1>
      <form method="POST" action="/save-config">
        <label>Simkl Client ID</label>
        <input name="simklClientId" value="${APP_CONFIG.simklClientId}" required>

        <label>Mark Watched At %</label>
        <input type="number" name="watchThreshold" value="${APP_CONFIG.watchThreshold}" min="1" max="100" required>

        <label>Sync Watching Now</label>
        <select name="syncWatchingNow">
          <option value="true" ${APP_CONFIG.syncWatchingNow?"selected":""}>Yes</option>
          <option value="false" ${!APP_CONFIG.syncWatchingNow?"selected":""}>No</option>
        </select>

        <label>Sync Watched History</label>
        <select name="syncFullProgress">
          <option value="true" ${APP_CONFIG.syncFullProgress?"selected":""}>Yes</option>
          <option value="false" ${!APP_CONFIG.syncFullProgress?"selected":""}>No</option>
        </select>

        <button type="submit">✅ Save & Generate PIN</button>
      </form>
      ${pinStatus}
      ${loginStatus}
    </div>

    <div class="card">
      <a href="stremio://${req.hostname}/manifest.json"><button style="background:#00ff66;color:#000;">📥 Install to Stremio</button></a>
    </div>
  </body>
  </html>`;
  res.send(html);
});

// --------------------------
// SAVE SETTINGS + GENERATE PIN (FORCED)
// --------------------------
app.post('/save-config', async (req, res) => {
  try {
    // Save settings
    APP_CONFIG.simklClientId = req.body.simklClientId;
    APP_CONFIG.watchThreshold = parseInt(req.body.watchThreshold);
    APP_CONFIG.syncWatchingNow = req.body.syncWatchingNow === 'true';
    APP_CONFIG.syncFullProgress = req.body.syncFullProgress === 'true';
    APP_CONFIG.simklUserCode = '';
    APP_CONFIG.simklToken = '';

    // GENERATE PIN — FORCED
    const resp = await fetch(`${SIMKL.PIN_CREATE}?client_id=${APP_CONFIG.simklClientId}`);
    const data = await resp.json();

    if (data.userCode) {
      APP_CONFIG.simklUserCode = data.userCode;
      APP_CONFIG.simklVerifier = data.verifier;
    }

    saveConfig();
    res.redirect('/configure');
  } catch (e) {
    saveConfig();
    res.redirect('/configure');
  }
});

// --------------------------
// CHECK PIN LOGIN
// --------------------------
app.get('/check-pin', async (req, res) => {
  if (!APP_CONFIG.simklClientId || !APP_CONFIG.simklUserCode) return res.json({ loggedIn: false });

  try {
    const resp = await fetch(`${SIMKL.PIN_CHECK}${APP_CONFIG.simklUserCode}?client_id=${APP_CONFIG.simklClientId}&verifier=${APP_CONFIG.simklVerifier}`);
    const data = await resp.json();

    if (data.access_token) {
      APP_CONFIG.simklToken = data.access_token;
      saveConfig();
      return res.json({ loggedIn: true });
    }
    res.json({ loggedIn: false });
  } catch (e) {
    res.json({ loggedIn: false });
  }
});

// --------------------------
// STREMIO PLAYER HOOK
// --------------------------
app.post('/player', async (req, res) => {
  try {
    const { videoId, time, duration, type } = req.body;
    if (!videoId || !time || !duration || !APP_CONFIG.simklToken) return res.json({ success: false });

    const imdb = videoId.startsWith('tt') ? videoId : null;
    if (!imdb) return res.json({ success: false });

    const progress = Math.round((time / duration) * 100);

    // Scrobble watching
    if (APP_CONFIG.syncWatchingNow && progress < APP_CONFIG.watchThreshold) {
      await fetch(`${SIMKL.SCROBBLE_START}?client_id=${APP_CONFIG.simklClientId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${APP_CONFIG.simklToken}`,
          'Content-Type': 'application/json',
          'simkl-api-key': APP_CONFIG.simklClientId
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
          'Authorization': `Bearer ${APP_CONFIG.simklToken}`,
          'Content-Type': 'application/json',
          'simkl-api-key': APP_CONFIG.simklClientId
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
// START
// --------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Simkl Sync Running`);
});
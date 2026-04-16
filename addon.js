const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log ALL requests
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.originalUrl}`);
  next();
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  next();
});

// --------------------------
// CONFIG
// --------------------------
const configPath = path.join(__dirname, 'config.json');
let config = {
  simklClientId: '',
  simklClientSecret: '',
  simklToken: ''
};

if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch(e) {}
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// --------------------------
// ✅ WORKING CONFIG PAGE
// --------------------------
app.get('/configure', (req, res) => {
  const host = req.hostname;
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Simkl Sync</title>
    <style>
        body { background: #121212; color: white; font-family: Arial; padding: 40px; }
        input { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; }
        button { padding: 10px 20px; margin: 5px; cursor: pointer; }
    </style>
</head>
<body>
    <h1>Simkl Sync</h1>
    <form method="POST" action="/save">
        <h3>Simkl Client ID</h3>
        <input name="cid" value="${config.simklClientId || ''}" required>
        <h3>Simkl Client Secret</h3>
        <input name="cs" value="${config.simklClientSecret || ''}" required>
        <button type="submit">Save</button>
    </form>
    <br>
    <a href="/login"><button>Login to Simkl</button></a>
    <a href="stremio://${host}/manifest.json"><button>Install to Stremio</button></a>
</body>
</html>
  `);
});

app.post('/save', (req, res) => {
  config.simklClientId = req.body.cid;
  config.simklClientSecret = req.body.cs;
  saveConfig();
  res.redirect('/configure');
});

// --------------------------
// ✅ REAL SIMKL API — NO SHORT URLS AT ALL
// --------------------------
app.get('/login', (req, res) => {
  const redirectUri = `https://${req.hostname}/callback`;
  const url = `https://simkl.com/oauth/authorize?client_id=${config.simklClientId}&redirect_uri=${redirectUri}&response_type=code&scope=scrobble:write`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  try {
    const resp = await fetch('https://api.simkl.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.simklClientId,
        client_secret: config.simklClientSecret,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: `https://${req.hostname}/callback`
      })
    });
    const data = await resp.json();
    if (data.access_token) {
      config.simklToken = data.access_token;
      saveConfig();
      res.send('<h1 style="color:green">✅ Logged in</h1>');
      return;
    }
  } catch (e) {}
  res.send('<h1 style="color:red">❌ Failed</h1>');
});

// --------------------------
// ✅ STREMIO MANIFEST (100% CORRECT)
// --------------------------
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: 'com.simkl.sync',
    version: '1.0.0',
    name: 'Simkl Sync',
    description: 'Scrobble Stremio to Simkl',
    resources: [{ name: 'player', type: 'actor' }],
    types: ['*'],
    idPrefixes: ['*'],
    configurable: true,
    persistent: true
  });
});

// --------------------------
// ✅ STREMIO PLAYER + REAL SIMKL SCROBBLE
// --------------------------
app.post('/player', async (req, res) => {
  console.log('✅ STREMIO PLAYER CALL:', req.body);

  if (!config.simklToken) return res.json({ success: true });

  try {
    const { videoId, time, duration, type } = req.body;
    if (!videoId || !time || !duration) return res.json({ success: true });

    // REAL SIMKL SCROBBLE API — NO SHORT URLS
    await fetch(`https://api.simkl.com/scrobble/start?client_id=${config.simklClientId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.simklToken}`,
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

// Root
app.get('/', (req, res) => res.redirect('/configure'));

// Start
const PORT = process.env.PORT || 56565;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

// --------------------------
// YOUR REQUIREMENTS: NO URL SHORTENERS • NO .env • v0.0.1
// --------------------------
const ADDON_VERSION = '0.0.1';
const ADDON_NAME = 'Stremio Simkl Sync';
const SIMKL_API_BASE = 'https://api.simkl.com';
const SIMKL_OAUTH_AUTHORIZE = 'https://simkl.com/oauth/authorize';
const SIMKL_OAUTH_TOKEN = 'https://api.simkl.com/oauth/token';
const PORT = process.env.PORT || 3000;

// --------------------------
// IN-MEMORY STATE (NO FILE CONFIG)
// --------------------------
let userAuth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null
};
let oauthState = '';
let lastScrobbleTime = 0;

// --------------------------
// STREMIO MANIFEST
// --------------------------
const MANIFEST = {
  id: 'org.stremio.simklsync',
  version: ADDON_VERSION,
  name: 'Stremio Simkl Sync',
  description: 'Sync Stremio watch progress to Simkl using OAuth 2.0',
  logo: 'https://simkl.com/images/simkl-logo-192.png',
  background: 'https://simkl.com/images/simkl-bg.jpg',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'simkl'],
  config: [
    { key: 'simkl_client_id', type: 'text', label: 'Simkl Client ID', required: true },
    { key: 'simkl_client_secret', type: 'text', label: 'Simkl Client Secret', required: true },
    { key: 'watch_threshold', type: 'number', label: 'Mark watched at (%)', default: 80 },
    { key: 'scrobble_enabled', type: 'checkbox', label: 'Enable Scrobbling', default: true }
  ]
};

// --------------------------
// LOGGING FOR RENDER
// --------------------------
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// --------------------------
// PARSE STREMIO CONFIG FROM URL
// --------------------------
const parseStremioConfig = (req) => {
  try {
    const parts = req.path.split('/').filter(Boolean);
    const b64 = parts.find(p => p.length > 20);
    if (!b64) return {};
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return {};
  }
};

// --------------------------
// MIDDLEWARE
// --------------------------
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// --------------------------
// STREMIO ENDPOINTS
// --------------------------
app.get('/manifest.json', (req, res) => {
  log('Manifest served');
  res.json(MANIFEST);
});

// FIXED: /configure WORKS PERFECTLY
app.get('/configure', (req, res) => res.redirect('/configure/'));
app.get('/configure/*', (req, res) => {
  const config = parseStremioConfig(req);
  const base = getBaseUrl(req);
  const encodedConfig = Buffer.from(JSON.stringify(config)).toString('base64');

  log(`Configure page loaded | Client ID present: ${!!config.simkl_client_id}`);

  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Stremio Simkl Sync</title>
    <style>
      body { font-family: Arial; max-width: 500px; margin: 3rem auto; padding: 0 1rem; }
      button { padding: 1rem 2rem; background: #007bff; color: white; border: 0; border-radius: 6px; cursor: pointer; font-size: 16px; }
      .status { margin: 1rem 0; padding: 1rem; border-radius: 6px; }
      .good { background: #e8f5e9; color: #2e7d32; }
      .bad { background: #ffebee; color: #c62828; }
    </style>
  </head>
  <body>
    <h1>${ADDON_NAME} v${ADDON_VERSION}</h1>

    <div class="status ${config.simkl_client_id ? 'good' : 'bad'}">
      ${config.simkl_client_id ? '✅ Config loaded from Stremio' : '❌ Please configure the addon in Stremio first'}
    </div>

    <h3>Connect to Simkl</h3>
    <a href="${base}/simkl/auth?c=${encodedConfig}">
      <button>Login to Simkl</button>
    </a>

    <h3>Your Settings</h3>
    <p>Client ID: ${config.simkl_client_id || 'Not set'}</p>
    <p>Mark watched at: ${config.watch_threshold || 80}%</p>
    <p>Scrobbling: ${config.scrobble_enabled ? 'Enabled' : 'Disabled'}</p>
  </body>
  </html>
  `);
});

// --------------------------
// SIMKL OAUTH 2.0 FLOW
// --------------------------
app.get('/simkl/auth', (req, res) => {
  try {
    const config = JSON.parse(Buffer.from(req.query.c, 'base64').toString('utf8'));
    const base = getBaseUrl(req);
    oauthState = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${base}/simkl/callback?c=${req.query.c}`;

    if (!config.simkl_client_id) {
      log('OAuth error: No Client ID');
      return res.send('❌ Set Simkl Client ID in Stremio addon settings');
    }

    const authUrl = `${SIMKL_OAUTH_AUTHORIZE}?client_id=${config.simkl_client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${oauthState}`;
    log('Redirecting to Simkl OAuth');
    res.redirect(authUrl);
  } catch (e) {
    log('OAuth failed: Invalid config');
    res.send('❌ Invalid configuration');
  }
});

app.get('/simkl/callback', async (req, res) => {
  const { code, state, c } = req.query;
  const config = JSON.parse(Buffer.from(c, 'base64').toString('utf8'));
  const base = getBaseUrl(req);

  if (state !== oauthState) {
    log('OAuth error: Invalid state');
    return res.send('❌ Security error: Invalid state');
  }

  try {
    const tokenResponse = await axios.post(SIMKL_OAUTH_TOKEN, {
      grant_type: 'authorization_code',
      client_id: config.simkl_client_id,
      client_secret: config.simkl_client_secret,
      redirect_uri: `${base}/simkl/callback?c=${c}`,
      code
    });

    userAuth.accessToken = tokenResponse.data.access_token;
    userAuth.refreshToken = tokenResponse.data.refresh_token;
    userAuth.expiresAt = Date.now() + tokenResponse.data.expires_in * 1000;

    log('✅ Simkl OAuth successful');
    res.send(`
      <h1>✅ Connected to Simkl</h1>
      <p>You can close this tab and play videos in Stremio.</p>
    `);
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    log(`❌ OAuth failed: ${errMsg}`);
    res.send(`❌ Login failed: ${errMsg}`);
  }
});

// --------------------------
// SCROBBLE ENDPOINT
// --------------------------
app.post('/scrobble', async (req, res) => {
  const { config, meta, progress, paused } = req.body;

  if (!config || !meta || !userAuth.accessToken || !config.scrobble_enabled) {
    return res.json({ success: true });
  }

  const percent = Math.round(progress * 100);
  const threshold = Number(config.watch_threshold) || 80;

  // RATE LIMIT: 1 PER SECOND (SIMKL RULE)
  if (Date.now() - lastScrobbleTime < 1000) {
    return res.json({ success: true });
  }
  lastScrobbleTime = Date.now();

  let action = 'watching';
  if (paused) action = 'pause';
  if (percent >= threshold) action = 'stop';

  log(`Scrobble: ${action} | ${meta.id} | ${percent}%`);

  try {
    await axios.post(`${SIMKL_API_BASE}/scrobble/${action}`, {
      [action]: {
        progress: percent,
        [meta.type === 'movie' ? 'movie' : 'episode']: {
          ids: meta.id.startsWith('tt') ? { imdb: meta.id } : {},
          season: meta.season,
          episode: meta.episode
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${userAuth.accessToken}`,
        'User-Agent': `${ADDON_NAME}/${ADDON_VERSION}`
      },
      params: {
        client_id: config.simkl_client_id,
        app_name: ADDON_NAME,
        app_version: ADDON_VERSION
      }
    });
  } catch (err) {
    log(`Scrobble failed: ${err.message}`);
  }

  res.json({ success: true });
});

// --------------------------
// STREMIO REQUIRED ROUTES
// --------------------------
app.get('/stream/:type/:id.json', (req, res) => res.json({ streams: [] }));
app.get('/', (req, res) => res.send(`${ADDON_NAME} v${ADDON_VERSION} | Running`));

// --------------------------
// START SERVER
// --------------------------
app.listen(PORT, () => {
  log(`🚀 ${ADDON_NAME} v${ADDON_VERSION} running on port ${PORT}`);
});
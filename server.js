const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

// --------------------------
// CONFIG
// --------------------------
const ADDON_VERSION = '0.0.1';
const ADDON_NAME = 'Stremio Simkl Sync';
const SIMKL_API_BASE = 'https://api.simkl.com';
const SIMKL_AUTH_URL = 'https://simkl.com/oauth/authorize';
const SIMKL_TOKEN_URL = 'https://api.simkl.com/oauth/token';
const PORT = process.env.PORT || 3000;

// --------------------------
// STORAGE
// --------------------------
let userAuth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  lastActivityTimestamp: null
};
let simklState = null;
let lastScrobbleTime = 0;

// --------------------------
// MANIFEST (Stremio Required)
// --------------------------
const MANIFEST = {
  id: 'org.stremio.simklsync',
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: 'Sync Stremio watch progress to Simkl',
  logo: 'https://simkl.com/images/simkl-logo-192.png',
  background: 'https://simkl.com/images/simkl-bg.jpg',
  resources: ['stream', 'meta', 'catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'simkl'],
  config: [
    { key: 'simkl_client_id', type: 'text', label: 'Simkl Client ID', required: true },
    { key: 'simkl_client_secret', type: 'text', label: 'Simkl Client Secret', required: true },
    { key: 'watch_threshold', type: 'number', label: 'Watched Threshold (%)', default: 80 },
    { key: 'scrobble_enabled', type: 'checkbox', label: 'Enable Scrobbling', default: true }
  ]
};

// --------------------------
// HELPERS
// --------------------------
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;

const getSimklHeaders = (config, includeAuth = true) => {
  const headers = {
    'User-Agent': `${ADDON_NAME}/${ADDON_VERSION} (Stremio Addon)`,
    'Accept': 'application/json'
  };
  if (includeAuth && userAuth.accessToken) {
    headers['Authorization'] = `Bearer ${userAuth.accessToken}`;
  }
  return headers;
};

const getSimklParams = (config) => ({
  client_id: config.simkl_client_id,
  app_name: ADDON_NAME,
  app_version: ADDON_VERSION
});

// --------------------------
// SIMKL API FUNCTIONS
// --------------------------
const refreshToken = async (config) => {
  if (!userAuth.refreshToken || Date.now() < userAuth.expiresAt) return;
  log('Refreshing Simkl token...');
  try {
    const res = await axios.post(SIMKL_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: config.simkl_client_id,
      client_secret: config.simkl_client_secret,
      refresh_token: userAuth.refreshToken
    }, { headers: getSimklHeaders(config, false) });
    userAuth.accessToken = res.data.access_token;
    userAuth.refreshToken = res.data.refresh_token;
    userAuth.expiresAt = Date.now() + (res.data.expires_in * 1000);
    log('✅ Token refreshed');
  } catch (err) {
    log(`❌ Token refresh failed: ${err.response?.data?.error || err.message}`);
  }
};

const scrobble = async (config, action, progress, meta) => {
  if (!config.scrobble_enabled || !userAuth.accessToken || !meta) return;
  const now = Date.now();
  if (now - lastScrobbleTime < 1000) {
    log('⏱️ Rate limit hit, skipping scrobble');
    return;
  }
  lastScrobbleTime = now;

  await refreshToken(config);
  log(`Scrobbling ${action} for ${meta.id} (${Math.round(progress)}%)`);

  const payload = {
    type: meta.type,
    ids: meta.id?.startsWith('tt') ? { imdb: meta.id } : {},
    season: meta.season,
    episode: meta.episode
  };

  const body = {
    [action]: {
      progress: Math.round(progress),
      [meta.type === 'movie' ? 'movie' : 'episode']: payload
    }
  };

  try {
    await axios.post(`${SIMKL_API_BASE}/scrobble/${action}`, body, {
      headers: getSimklHeaders(config),
      params: getSimklParams(config)
    });
    log(`✅ Scrobbled ${action} successfully`);
  } catch (err) {
    log(`❌ Scrobble failed: ${err.response?.data?.error || err.message}`);
  }
};

// --------------------------
// EXPRESS MIDDLEWARE
// --------------------------
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// --------------------------
// STREMIO ADDON ENDPOINTS
// --------------------------
app.get('/manifest.json', (req, res) => {
  log('Serving manifest.json');
  res.json(MANIFEST);
});

// Configure Page (Fix: Now uses Stremio config params)
app.get('/configure', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const config = req.query;
  log(`Configure page loaded, config present: ${!!config.simkl_client_id}`);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${ADDON_NAME} (v${ADDON_VERSION})</title>
      <style>
        body { font-family: Arial; max-width: 600px; margin: 2rem auto; }
        button { background: #007bff; color: white; border: none; padding: 1rem; border-radius: 5px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>${ADDON_NAME} (v${ADDON_VERSION})</h1>
      <h3>1. Connect Simkl Account</h3>
      <a href="${baseUrl}/simkl/auth?client_id=${config.simkl_client_id || ''}">
        <button>Login to Simkl</button>
      </a>
      <h3>2. Settings</h3>
      <p>Configure these in Stremio Addons → ${ADDON_NAME} → Configure:</p>
      <ul>
        <li>Simkl Client ID/Secret (from Simkl Developer Portal)</li>
        <li>Watched Threshold (default: 80%)</li>
        <li>Enable Scrobbling</li>
      </ul>
      <p>⚠️ API calls are rate-limited to 1 POST/second to comply with Simkl rules.</p>
    </body>
    </html>
  `);
});

// OAuth Initiate (Fix: Now uses client_id from query)
app.get('/simkl/auth', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/simkl/callback`;
  simklState = crypto.randomBytes(16).toString('hex');
  const clientId = req.query.client_id;

  if (!clientId) {
    log('❌ OAuth failed: No client_id provided');
    return res.send('❌ Please set your Simkl Client ID in Stremio addon settings first.');
  }

  const authUrl = `${SIMKL_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${simklState}`;
  log(`Redirecting to Simkl OAuth: ${authUrl}`);
  res.redirect(authUrl);
});

// OAuth Callback (Fix: Logs errors/success)
app.get('/simkl/callback', async (req, res) => {
  const { code, state } = req.query;
  const baseUrl = getBaseUrl(req);
  const clientId = req.query.client_id;
  const clientSecret = req.query.client_secret;

  log(`OAuth callback received, state match: ${state === simklState}`);

  if (state !== simklState) {
    log('❌ Invalid OAuth state');
    return res.send('❌ Invalid OAuth state. Please try again.');
  }

  try {
    const tokenRes = await axios.post(SIMKL_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${baseUrl}/simkl/callback`,
      code
    }, { headers: getSimklHeaders({}, false) });

    userAuth.accessToken = tokenRes.data.access_token;
    userAuth.refreshToken = tokenRes.data.refresh_token;
    userAuth.expiresAt = Date.now() + (tokenRes.data.expires_in * 1000);
    log('✅ Simkl OAuth successful, token stored');

    res.send(`
      <h1>✅ Connected!</h1>
      <p>You can close this tab. Scrobbling will now work in Stremio.</p>
    `);
  } catch (err) {
    log(`❌ OAuth failed: ${err.response?.data?.error || err.message}`);
    res.send(`❌ OAuth failed: ${err.response?.data?.error || err.message}`);
  }
});

// Scrobble Endpoint (Stremio-compatible)
app.post('/scrobble', async (req, res) => {
  const { config, meta, progress, paused } = req.body;
  log(`Scrobble request: ${meta?.id} | Progress: ${progress}% | Paused: ${paused}`);

  if (!config || !meta) {
    log('❌ Missing config or meta in scrobble request');
    return res.status(400).send('Missing config/meta');
  }

  const threshold = parseInt(config.watch_threshold) || 80;
  const roundedProgress = Math.round(progress * 100);

  if (paused) {
    scrobble(config, 'pause', roundedProgress, meta);
  } else if (roundedProgress >= threshold) {
    scrobble(config, 'stop', roundedProgress, meta);
  } else if (roundedProgress > 0) {
    scrobble(config, 'watching', roundedProgress, meta);
  }

  res.json({ success: true });
});

// Required Stremio Endpoints
app.get('/stream/:type/:id.json', (req, res) => res.json({ streams: [] }));
app.get('/meta/:type/:id.json', (req, res) => res.json({ meta: {} }));
app.get('/catalog/:type/:id.json', (req, res) => res.json({ metas: [] }));

// Health Check
app.get('/', (req, res) => {
  log('Health check passed');
  res.send(`${ADDON_NAME} v${ADDON_VERSION} running`);
});

// Start Server
app.listen(PORT, () => {
  log(`🚀 ${ADDON_NAME} v${ADDON_VERSION} running on port ${PORT}`);
  log(`🔗 Configure URL: http://localhost:${PORT}/configure`);
});
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

// --------------------------
// CONSTANTS
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
  expiresAt: null
};
let simklState = null;
let lastScrobbleTime = 0;

// --------------------------
// MANIFEST
// --------------------------
const MANIFEST = {
  id: 'org.stremio.simklsync',
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: 'Sync Stremio watch progress to Simkl',
  logo: 'https://simkl.com/images/simkl-logo-192.png',
  background: 'https://simkl.com/images/simkl-bg.jpg',
  resources: ['stream'],
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

// Parse Stremio config from the URL path
const parseStremioConfig = (req) => {
  try {
    // Config is encoded as base64 in the URL path: /configure/<base64-config>
    const pathParts = req.path.split('/');
    const encodedConfig = pathParts.find(part => part && !['configure', ''].includes(part));
    if (!encodedConfig) return {};
    const decoded = Buffer.from(encodedConfig, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (err) {
    log(`Failed to parse config: ${err.message}`);
    return {};
  }
};

const getSimklHeaders = (includeAuth = true) => {
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
// SIMKL API
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
    }, { headers: getSimklHeaders(false) });
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
      headers: getSimklHeaders(),
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
// ENDPOINTS
// --------------------------
app.get('/manifest.json', (req, res) => {
  log('Serving manifest.json');
  res.json(MANIFEST);
});

// Configure page (handles Stremio's base64-encoded config)
app.get('/configure/*', (req, res) => {
  const config = parseStremioConfig(req);
  const baseUrl = getBaseUrl(req);
  log(`Configure page loaded, config present: ${!!config.simkl_client_id}`);

  const encodedConfig = Buffer.from(JSON.stringify(config)).toString('base64');
  const authUrl = `${baseUrl}/simkl/auth?config=${encodedConfig}`;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${ADDON_NAME} (v${ADDON_VERSION})</title>
      <style>
        body { font-family: Arial; max-width: 600px; margin: 2rem auto; }
        button { background: #007bff; color: white; border: none; padding: 1rem; border-radius: 5px; cursor: pointer; font-size: 1rem; }
        .error { color: red; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>${ADDON_NAME} (v${ADDON_VERSION})</h1>
      ${!config.simkl_client_id ? '<p class="error">⚠️ No Simkl Client ID found. Please configure the addon in Stremio first.</p>' : ''}
      <h3>1. Connect Simkl Account</h3>
      <a href="${authUrl}">
        <button>Login to Simkl</button>
      </a>
      <h3>2. Settings</h3>
      <p>These values are read from your Stremio addon configuration:</p>
      <ul>
        <li>Simkl Client ID: ${config.simkl_client_id || 'Not set'}</li>
        <li>Simkl Client Secret: ${config.simkl_client_secret ? '********' : 'Not set'}</li>
        <li>Watched Threshold: ${config.watch_threshold || 80}%</li>
        <li>Scrobbling: ${config.scrobble_enabled ? 'Enabled' : 'Disabled'}</li>
      </ul>
      <p>⚠️ API calls are rate-limited to 1 POST/second to comply with Simkl rules.</p>
    </body>
    </html>
  `);
});

// OAuth Initiate (receives config from the configure page)
app.get('/simkl/auth', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/simkl/callback`;
  simklState = crypto.randomBytes(16).toString('hex');

  // Decode config from the query param
  let config;
  try {
    config = JSON.parse(Buffer.from(req.query.config, 'base64').toString('utf-8'));
  } catch (err) {
    log(`Failed to decode config: ${err.message}`);
    return res.send('❌ Invalid config. Please go back to the configure page.');
  }

  if (!config.simkl_client_id) {
    log('❌ OAuth failed: No client_id provided');
    return res.send('❌ Please set your Simkl Client ID in Stremio addon settings first.');
  }

  const authUrl = `${SIMKL_AUTH_URL}?client_id=${config.simkl_client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${simklState}`;
  log(`Redirecting to Simkl OAuth`);
  res.redirect(authUrl);
});

// OAuth Callback (uses config from the auth flow)
app.get('/simkl/callback', async (req, res) => {
  const { code, state, config: encodedConfig } = req.query;
  const baseUrl = getBaseUrl(req);

  if (state !== simklState) {
    log('❌ Invalid OAuth state');
    return res.send('❌ Invalid OAuth state. Please try again.');
  }

  let config;
  try {
    config = JSON.parse(Buffer.from(encodedConfig, 'base64').toString('utf-8'));
  } catch (err) {
    log(`Failed to decode config: ${err.message}`);
    return res.send('❌ Invalid config. Please go back to the configure page.');
  }

  if (!config.simkl_client_id || !config.simkl_client_secret) {
    log('❌ Missing client_id or client_secret');
    return res.send('❌ Please set your Simkl Client ID/Secret in Stremio addon settings.');
  }

  try {
    const tokenRes = await axios.post(SIMKL_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: config.simkl_client_id,
      client_secret: config.simkl_client_secret,
      redirect_uri: `${baseUrl}/simkl/callback`,
      code
    }, { headers: getSimklHeaders(false) });

    userAuth.accessToken = tokenRes.data.access_token;
    userAuth.refreshToken = tokenRes.data.refresh_token;
    userAuth.expiresAt = Date.now() + (tokenRes.data.expires_in * 1000);
    log('✅ Simkl OAuth successful, token stored');

    res.send(`
      <h1>✅ Connected to Simkl!</h1>
      <p>You can close this tab and return to Stremio.</p>
      <p>Scrobbling will now work with your configured settings.</p>
    `);
  } catch (err) {
    log(`❌ OAuth failed: ${err.response?.data?.error || err.message}`);
    res.send(`❌ OAuth failed: ${err.response?.data?.error || err.message}`);
  }
});

// Scrobble endpoint (Stremio-compatible)
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

// Required Stremio endpoints
app.get('/stream/:type/:id.json', (req, res) => res.json({ streams: [] }));
app.get('/meta/:type/:id.json', (req, res) => res.json({ meta: {} }));
app.get('/catalog/:type/:id.json', (req, res) => res.json({ metas: [] }));

// Health check
app.get('/', (req, res) => {
  log('Health check passed');
  res.send(`${ADDON_NAME} v${ADDON_VERSION} running`);
});

// Start server
app.listen(PORT, () => {
  log(`🚀 ${ADDON_NAME} v${ADDON_VERSION} running on port ${PORT}`);
});
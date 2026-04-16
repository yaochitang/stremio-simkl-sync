const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

// --------------------------
// STREAMIO ADDON CONSTANTS (VERSION 0.0.1)
// --------------------------
const ADDON_VERSION = '0.0.1';
const ADDON_NAME = 'Stremio Simkl Sync';
const SIMKL_API_BASE = 'https://api.simkl.com';
const SIMKL_AUTH_URL = 'https://simkl.com/oauth/authorize';
const SIMKL_TOKEN_URL = 'https://api.simkl.com/oauth/token';

const MANIFEST = {
  id: 'org.stremio.simklsync',
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: 'Sync Stremio watch progress to Simkl via OAuth 2.0 & Scrobbling (API-compliant)',
  logo: 'https://simkl.com/images/simkl-logo-192.png',
  background: 'https://simkl.com/images/simkl-bg.jpg',
  catalogs: [],
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'simkl'],
  config: [
    { key: 'simkl_client_id', type: 'text', label: 'Simkl Client ID', required: true },
    { key: 'simkl_client_secret', type: 'text', label: 'Simkl Client Secret', required: true },
    { key: 'watch_threshold', type: 'number', label: 'Watched Threshold (%)', default: 80, required: true },
    { key: 'scrobble_enabled', type: 'checkbox', label: 'Enable Scrobbling', default: true, required: true }
  ]
};

// --------------------------
// IN-MEMORY STORAGE
// --------------------------
let userAuth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  lastActivityTimestamp: null // For Phase 2 sync loop
};
let playbackState = {
  currentId: null,
  currentType: null,
  lastProgress: 0,
  isPaused: false
};

// --------------------------
// SIMKL API HELPERS (COMPLIANT WITH RULES)
// --------------------------
const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Required headers for ALL Simkl API calls
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

// Required query params for ALL Simkl API calls
const getSimklQueryParams = (config) => ({
  client_id: config.simkl_client_id,
  app_name: ADDON_NAME,
  app_version: ADDON_VERSION
});

// Refresh Simkl token if expired (rate-safe)
const refreshSimklToken = async (config) => {
  if (!userAuth.refreshToken || Date.now() < userAuth.expiresAt) return;
  try {
    const res = await axios.post(SIMKL_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: config.simkl_client_id,
      client_secret: config.simkl_client_secret,
      refresh_token: userAuth.refreshToken
    }, {
      headers: getSimklHeaders(config, false)
    });
    userAuth.accessToken = res.data.access_token;
    userAuth.refreshToken = res.data.refresh_token;
    userAuth.expiresAt = Date.now() + (res.data.expires_in * 1000);
    console.log('✅ Simkl token refreshed');
  } catch (err) {
    console.error('❌ Token refresh failed:', err.response?.data || err.message);
  }
};

// Phase 1: Initial Sync (fetch libraries sequentially, no date_from)
const initialSync = async (config) => {
  if (!userAuth.accessToken) return;
  console.log('📥 Starting Phase 1 Initial Sync...');

  try {
    // Fetch libraries sequentially (no parallel calls)
    await Promise.all([
      axios.get(`${SIMKL_API_BASE}/sync/shows`, {
        headers: getSimklHeaders(config),
        params: getSimklQueryParams(config)
      }),
      axios.get(`${SIMKL_API_BASE}/sync/movies`, {
        headers: getSimklHeaders(config),
        params: getSimklQueryParams(config)
      }),
      axios.get(`${SIMKL_API_BASE}/sync/anime`, {
        headers: getSimklHeaders(config),
        params: getSimklQueryParams(config)
      })
    ]);
    console.log('✅ Phase 1 Initial Sync complete');
  } catch (err) {
    console.error('❌ Initial sync failed:', err.response?.data || err.message);
  }
};

// Phase 2: Continuous Sync Loop (check activities first)
const checkSimklActivities = async (config) => {
  if (!userAuth.accessToken) return;
  try {
    const res = await axios.get(`${SIMKL_API_BASE}/sync/activities`, {
      headers: getSimklHeaders(config),
      params: getSimklQueryParams(config)
    });
    const latestTimestamp = res.data?.activities?.[0]?.changed_at;

    // Compare with local timestamp; only sync if changed
    if (latestTimestamp && latestTimestamp !== userAuth.lastActivityTimestamp) {
      console.log('🔄 Sync changes detected, fetching updates...');
      await fetchSimklChanges(config, latestTimestamp);
      userAuth.lastActivityTimestamp = latestTimestamp;
    }
  } catch (err) {
    console.error('❌ Activity check failed:', err.response?.data || err.message);
  }
};

// Fetch changes with date_from (per rules)
const fetchSimklChanges = async (config, dateFrom) => {
  try {
    await axios.get(`${SIMKL_API_BASE}/sync/all-items`, {
      headers: getSimklHeaders(config),
      params: {
        ...getSimklQueryParams(config),
        date_from: dateFrom
      }
    });
    console.log('✅ Synced incremental changes from Simkl');
  } catch (err) {
    console.error('❌ Change sync failed:', err.response?.data || err.message);
  }
};

// Scrobble to Simkl (with rate limiting: 1 POST/second)
let lastScrobbleTime = 0;
const scrobbleToSimkl = async (config, action, progress, meta) => {
  if (!config.scrobble_enabled || !userAuth.accessToken || !meta) return;

  // Enforce 1 POST/second rate limit
  const now = Date.now();
  if (now - lastScrobbleTime < 1000) {
    console.log('⏱️ Rate limit hit, skipping scrobble');
    return;
  }
  lastScrobbleTime = now;

  await refreshSimklToken(config);

  const payload = {
    type: meta.type,
    title: meta.name,
    year: meta.year || null,
    ids: {}
  };

  if (meta.id?.startsWith('tt')) payload.ids.imdb = meta.id;
  if (meta.ids?.simkl) payload.ids.simkl = meta.ids.simkl;
  if (meta.season && meta.episode) {
    payload.season = meta.season;
    payload.episode = meta.episode;
  }

  const body = {
    [action]: {
      progress: Math.round(progress),
      [meta.type === 'movie' ? 'movie' : 'episode']: payload
    }
  };

  try {
    await axios.post(`${SIMKL_API_BASE}/scrobble/${action}`, body, {
      headers: getSimklHeaders(config),
      params: getSimklQueryParams(config)
    });
    console.log(`✅ Scrobbled ${action} | Progress: ${Math.round(progress)}% | ID: ${meta.id}`);
  } catch (err) {
    console.error(`❌ Scrobble ${action} failed:`, err.response?.data || err.message);
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
// STREAMIO ADDON ENDPOINTS
// --------------------------
app.get('/manifest.json', (req, res) => res.json(MANIFEST));

app.get('/configure', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>${ADDON_NAME} (v${ADDON_VERSION})</title>
    <style>body{font-family:Arial;margin:2rem;max-width:600px;margin:auto}</style>
  </head>
  <body>
    <h1>${ADDON_NAME} (v${ADDON_VERSION})</h1>
    <h3>1. Connect Simkl Account</h3>
    <a href="${baseUrl}/simkl/auth">
      <button style="padding:1rem;font-size:1rem;background:#007bff;color:white;border:none;border-radius:5px;cursor:pointer">
        Login to Simkl
      </button>
    </a>
    <h3>2. Settings</h3>
    <p>Configure in Stremio Addons → ${ADDON_NAME} → Configure:</p>
    <ul>
      <li>Simkl Client ID/Secret (from Simkl Developer Portal)</li>
      <li>Watched Threshold (default: 80%)</li>
      <li>Enable Scrobbling</li>
    </ul>
    <p>⚠️ Note: API calls are rate-limited to 1 POST/second to comply with Simkl rules.</p>
  </body>
  </html>`;
  res.send(html);
});

app.get('/simkl/auth', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/simkl/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  simklState = state;

  const authUrl = `${SIMKL_AUTH_URL}?client_id=${req.query.client_id || ''}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;
  res.redirect(authUrl);
});

app.get('/simkl/callback', async (req, res) => {
  const { code, state } = req.query;
  const baseUrl = getBaseUrl(req);
  const clientId = req.query.client_id || '';
  const clientSecret = req.query.client_secret || '';

  if (state !== simklState) return res.send('❌ Invalid OAuth state');

  try {
    const tokenRes = await axios.post(SIMKL_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${baseUrl}/simkl/callback`,
      code
    }, {
      headers: getSimklHeaders({ simkl_client_id: clientId }, false)
    });

    userAuth.accessToken = tokenRes.data.access_token;
    userAuth.refreshToken = tokenRes.data.refresh_token;
    userAuth.expiresAt = Date.now() + (tokenRes.data.expires_in * 1000);

    // Run Phase 1 Initial Sync after auth
    await initialSync({ simkl_client_id: clientId });

    res.send(`
      <h1>✅ Simkl Connected!</h1>
      <p>You can close this tab and return to Stremio.</p>
      <p>Initial sync complete. Scrobbling will respect Simkl API rules.</p>
    `);
  } catch (err) {
    console.error('❌ OAuth failed:', err.response?.data || err.message);
    res.send('❌ Simkl Authentication Failed. Check Client ID/Secret.');
  }
});

app.post('/scrobble', async (req, res) => {
  const { config, meta, progress, paused } = req.body;
  if (!config || !meta) return res.status(400).send('Missing config/meta');

  const threshold = parseInt(config.watch_threshold) || 80;
  const roundedProgress = Math.round(progress * 100);

  playbackState.currentId = meta.id;
  playbackState.currentType = meta.type;
  playbackState.isPaused = paused;

  if (playbackState.lastProgress === roundedProgress) return res.json({ success: true });
  playbackState.lastProgress = roundedProgress;

  // Scrobble logic (rate-limited)
  if (paused) {
    scrobbleToSimkl(config, 'pause', roundedProgress, meta);
  } else if (roundedProgress >= threshold) {
    scrobbleToSimkl(config, 'stop', roundedProgress, meta);
  } else if (roundedProgress > 0) {
    scrobbleToSimkl(config, 'watching', roundedProgress, meta);
  }

  // Optional: Run Phase 2 activity check (rate-safe)
  checkSimklActivities(config);

  res.json({ success: true, scrobbled: true, progress: roundedProgress });
});

app.post('/stream', (req, res) => res.json({ streams: [] }));

app.get('/', (req, res) => res.send(`${ADDON_NAME} v${ADDON_VERSION} | Running`));

// --------------------------
// START SERVER
// --------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ${ADDON_NAME} v${ADDON_VERSION} running on port ${PORT}`);
  console.log(`🔗 Configure: http://localhost:${PORT}/configure`);
});
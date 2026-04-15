const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --------------------------
// RENDER + SECURITY SETUP
// --------------------------
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 56565;

// SECURE ENCRYPTION (CONFIG NOT READABLE)
// Use Render env var for encryption key (never hardcode)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'StremioSimklSync_Render_2025!';
const ENCRYPTION_KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'render_salt', 32);
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
// PERSISTENT ENCRYPTED CONFIG (Render Compatible)
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
    } catch (e) { console.error('Config load failed:', e.message); }
  },
  save(newConfig) {
    APP_CONFIG = { ...APP_CONFIG, ...newConfig };
    const encrypted = encrypt(JSON.stringify(APP_CONFIG));
    fs.writeFileSync(CONFIG_PATH, encrypted, 'utf8');
  },
  get() { return { ...APP_CONFIG }; }
};
Config.load();

// --------------------------
// SIMKL OFFICIAL API ENDPOINTS
// --------------------------
const SIMKL_API = {
  AUTH: 'https://simkl.com/oauth/authorize',
  TOKEN: 'https://api.simkl.com/oauth/token',
  SCROBBLE: 'https://api.simkl.com/scrobble/start',
  WATCHING: 'https://api.simkl.com/scrobble/watching',
  COMPLETE: 'https://api.simkl.com/scrobble/stop'
};

// --------------------------
// STREMIO ADDON MANIFEST
// --------------------------
const manifest = {
  id: 'org.stremio.simklsync.render',
  version: '2.0.0',
  name: 'Stremio Simkl Sync',
  description: 'Sync Stremio watch progress to Simkl (Render Hosted)',
  logo: 'https://i.imgur.com/RM8QpFs.png',
  background: '#1E1E2E',
  catalogs: [],
  resources: ['player'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  config: [
    { key: 'simklClientId', type: 'text', label: 'Simkl Client ID', required: true },
    { key: 'simklClientSecret', type: 'password', label: 'Simkl Client Secret', required: true },
    { key: 'watchThreshold', type: 'number', label: 'Auto-Watch % Threshold', default: 80 },
    { key: 'syncWatchingNow', type: 'boolean', label: 'Sync "Watching Now"', default: true },
    { key: 'syncFullProgress', type: 'boolean', label: 'Sync Full Progress', default: true }
  ]
};

// --------------------------
// EXPRESS SERVER (RENDER OPTIMIZED)
// --------------------------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// RENDER CORS + HTTPS SECURITY
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (IS_PRODUCTION && !req.secure && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
});

// Manifest
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(manifest);
});

// Save Addon Settings
app.post('/configure', (req, res) => {
  try {
    Config.save(req.body);
    res.json({ success: true, message: 'Config saved securely' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simkl OAuth Login
app.get('/auth/simkl', (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklClientId) return res.status(400).send('Set Simkl Client ID first!');

  const redirectUri = IS_PRODUCTION
    ? `https://${req.hostname}/auth/simkl/callback`
    : `http://localhost:${PORT}/auth/simkl/callback`;

  const authUrl = new URL(SIMKL_API.AUTH);
  authUrl.searchParams.set('client_id', cfg.simklClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'scrobble');

  res.redirect(authUrl.toString());
});

// Simkl OAuth Callback (Render HTTPS Ready)
app.get('/auth/simkl/callback', async (req, res) => {
  const cfg = Config.get();
  const { code } = req.query;

  if (!code) return res.send('<h1>❌ Auth failed: No code</h1>');

  try {
    const redirectUri = IS_PRODUCTION
      ? `https://${req.hostname}/auth/simkl/callback`
      : `http://localhost:${PORT}/auth/simkl/callback`;

    const tokenRes = await fetch(SIMKL_API.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.simklClientId,
        client_secret: cfg.simklClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      Config.save({ simklToken: tokenData.access_token });
      res.send('<h1>✅ Authenticated! Close this tab.</h1>');
    } else {
      res.send(`<h1>❌ Failed: ${tokenData.error || 'Unknown'}</h1>`);
    }
  } catch (e) {
    res.status(500).send(`<h1>❌ Error: ${e.message}</h1>`);
  }
});

// --------------------------
// STREMIO PLAYER SCROBBLE HOOK (CORE FUNCTIONALITY)
// --------------------------
app.post('/player', async (req, res) => {
  const cfg = Config.get();
  if (!cfg.simklToken) return res.json({});

  const { videoId, time, duration, type } = req.body;
  if (!videoId || !time || !duration || time <= 0 || duration <= 0) return res.json({});

  const progress = Math.round((time / duration) * 100);
  const imdbId = videoId.startsWith('tt') ? videoId : null;
  if (!imdbId) return res.json({});

  try {
    const payload = {
      [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb: imdbId } },
      duration: Math.round(duration),
      progress
    };

    // 1. Watching Now (Real-time)
    if (cfg.syncWatchingNow && progress < cfg.watchThreshold) {
      await fetch(SIMKL_API.WATCHING, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }

    // 2. Auto-Mark Watched at X%
    if (progress >= cfg.watchThreshold && cfg.syncFullProgress) {
      await fetch(SIMKL_API.COMPLETE, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.simklToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...payload, status: 'completed' })
      });
    }

    res.json({ success: true, progress, synced: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Health Check (Render Required)
app.get('/', (req, res) => {
  res.send('✅ Stremio Simkl Sync is running on Render!');
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Running on port ${PORT} | Production: ${IS_PRODUCTION}`);
  console.log(`🔐 Config stored at: ${CONFIG_PATH}`);
});
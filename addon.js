const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --- Manifest (with PIN display) ---
const manifest = {
    id: 'org.stremio.simklsyncpro',
    version: '3.2.0',
    name: 'Stremio Simkl Sync Pro',
    description: 'Official Simkl Device Code OAuth flow',
    logo: 'https://i.imgur.com/2B6X79y.png',
    background: 'https://i.imgur.com/70zGZLo.png',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: true },
    config: [
        { key: 'simklClientId', type: 'text', title: 'Simkl Client ID', required: true },
        { key: 'simklUserCode', type: 'text', title: 'Your PIN (COPY THIS)', required: false },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token (Auto-filled)', required: true },
        { key: 'markWatchedAt', type: 'number', title: 'Mark as Watched at (%)', default: 80 },
        { key: 'syncInterval', type: 'number', title: 'Sync Interval (seconds)', default: 30 }
    ]
};

const builder = new addonBuilder(manifest);
const API_BASE = 'https://api.simkl.com';
const STATE_PATH = path.join(require('os').homedir(), 'simkl_state.json');

// --- Load/save state ---
let state = { deviceCode: null, userCode: null, token: null, pollInterval: 5 };
try { state = JSON.parse(fs.readFileSync(STATE_PATH)); } catch {}
function saveState() { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

// --- Step 1: Get Device Code (from your screenshot) ---
async function getDeviceCode(clientId) {
    const res = await fetch(`${API_BASE}/oauth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, scope: 'all' })
    });
    const data = await res.json();
    state.deviceCode = data.device_code;
    state.userCode = data.user_code; // This is the PIN shown to the user
    state.pollInterval = data.interval || 5;
    saveState();
    return data;
}

// --- Step 3: Poll for Token (from your screenshot) ---
async function pollForToken(clientId) {
    if (!state.deviceCode) return null;
    const res = await fetch(`${API_BASE}/oauth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: clientId,
            device_code: state.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
    });
    const data = await res.json();
    if (data.access_token) {
        state.token = data.access_token;
        saveState();
        return data.access_token;
    }
    return null;
}

// --- Stream Handler (with auto OAuth) ---
builder.defineStreamHandler(async (ctx) => {
    const cfg = ctx.config || {};
    const clientId = cfg.simklClientId;
    let token = cfg.simklAuthToken || state.token;

    // Step 1: If no PIN exists, generate it automatically
    if (clientId && !state.userCode) {
        await getDeviceCode(clientId);
    }

    // Step 2: If PIN exists, poll for token
    if (clientId && state.userCode && !token) {
        token = await pollForToken(clientId);
    }

    // Show the PIN in the config (this is what you wanted!)
    if (state.userCode) {
        ctx.config.simklUserCode = state.userCode;
    }

    // Your existing sync logic (with Simkl API rules)
    if (!token || !clientId || !ctx.id.startsWith('tt') || !ctx.state?.time) return { streams: [] };

    const imdbId = ctx.id;
    const duration = ctx.state.time.total || 0;
    const current = ctx.state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const markAt = +cfg.markWatchedAt || 80;

    // Simkl request helper (with required headers/params)
    async function simklRequest(endpoint, method, body) {
        const url = new URL(`${API_BASE}${endpoint}`);
        url.searchParams.append('client_id', clientId);
        url.searchParams.append('app-name', manifest.name);
        url.searchParams.append('app-version', manifest.version);
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': `${manifest.name}/${manifest.version}`,
            'Authorization': `Bearer ${token}`
        };
        const opts = { method, headers, body: body ? JSON.stringify(body) : undefined };
        if (method === 'POST') await new Promise(r => setTimeout(r, 1000)); // Rate limit
        const res = await fetch(url, opts);
        return res.ok ? await res.json() : null;
    }

    // Mark as watched if progress >= markAt
    if (ctx.state.paused === false && duration > 0) {
        if (progress >= markAt) {
            await simklRequest('/sync/history', 'POST', {
                watched_at: 'now',
                progress: 100,
                [ctx.type === 'movie' ? 'movie' : 'episode']: {
                    ids: { imdb: imdbId },
                    ...(ctx.type !== 'movie' && { season: ctx.state.season, number: ctx.state.episode })
                }
            });
            await simklRequest('/sync/watching', 'DELETE');
        } else {
            await simklRequest('/sync/watching', 'POST', {
                duration: Math.round(duration),
                progress: Math.min(Math.max(progress, 0), 100),
                [ctx.type === 'movie' ? 'movie' : 'episode']: {
                    ids: { imdb: imdbId },
                    ...(ctx.type !== 'movie' && { season: ctx.state.season, number: ctx.state.episode })
                }
            });
        }
    }

    return { streams: [] };
});

// --- Start Server ---
const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
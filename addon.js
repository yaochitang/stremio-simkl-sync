const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// --- Addon Manifest (fixed, no "player" resource) ---
const manifest = {
    id: 'org.stremio.simklsync',
    version: '2.2.0',
    name: 'Stremio Simkl Sync',
    description: 'Watching Now, progress sync, and configurable watched marker for Simkl',
    logo: 'https://simkl.com/images/logos/simkl_logo_white.svg',
    background: 'https://simkl.com/images/backgrounds/simkl_background.jpg',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'], // Only valid resource for playback events
    idPrefixes: ['tt'],
    config: [
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token', required: true },
        { key: 'markWatchedAt', type: 'number', title: 'Mark as Watched at (%)', default: 80, required: true },
        { key: 'syncInterval', type: 'number', title: 'Progress Sync Interval (seconds)', default: 30, required: true }
    ]
};

const builder = new addonBuilder(manifest);

// --- Simkl Config ---
const SIMKL_CLIENT_ID = 'e8a990a0e1b6c7d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const API_BASE = 'https://api.simkl.com';
const STORAGE_PATH = path.join('/opt/render/data', 'simkl_sync_state.json');

// --- State ---
const activeSessions = new Map();
let syncState = loadSyncState();

// --- Persistent Storage ---
function loadSyncState() {
    try {
        if (fs.existsSync(STORAGE_PATH)) return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
    } catch (e) {}
    return { lastActivityDate: null, lastFullSync: 0, isInitialSyncDone: false };
}
function saveSyncState() {
    try { fs.writeFileSync(STORAGE_PATH, JSON.stringify(syncState, null, 2)); } catch (e) {}
}

// --- Simkl API Helpers ---
async function simklRequest(endpoint, method = 'GET', body = null, token) {
    const headers = { 'Content-Type': 'application/json', 'simkl-api-key': SIMKL_CLIENT_ID };
    if (token) headers.Authorization = `Bearer ${token}`;
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, opts);
        return res.ok ? await res.json().catch(() => ({})) : null;
    } catch (e) { return null; }
}

async function runInitialSync(token) {
    if (syncState.isInitialSyncDone) return;
    await simklRequest('/sync/shows', 'GET', null, token);
    await simklRequest('/sync/movies', 'GET', null, token);
    await simklRequest('/sync/anime', 'GET', null, token);
    syncState.isInitialSyncDone = true;
    syncState.lastFullSync = Date.now();
    saveSyncState();
}

async function syncIfNeeded(token) {
    if (!token || Date.now() - syncState.lastFullSync < 15 * 60 * 1000) return;
    const activity = await simklRequest('/sync/activities', 'GET', null, token);
    if (!activity?.last_watched_at || syncState.lastActivityDate === activity.last_watched_at) return;
    await simklRequest(`/sync/all-items?date_from=${encodeURIComponent(activity.last_watched_at)}`, 'GET', null, token);
    syncState.lastActivityDate = activity.last_watched_at;
    syncState.lastFullSync = Date.now();
    saveSyncState();
}

async function setWatchingNow(token, imdbId, type, season, episode, duration, progress) {
    const payload = { duration: Math.round(duration), progress: Math.min(Math.max(progress, 0), 100) };
    type === 'movie' ? payload.movie = { ids: { imdb: imdbId } } : payload.episode = { ids: { imdb: imdbId }, season: +season || 1, number: +episode || 1 };
    await simklRequest('/sync/watching', 'POST', payload, token);
}

async function clearWatchingNow(token) { await simklRequest('/sync/watching', 'DELETE', null, token); }

async function markWatched(token, imdbId, type, season, episode) {
    const payload = { watched_at: 'now', progress: 100 };
    type === 'movie' ? payload.movie = { ids: { imdb: imdbId } } : payload.episode = { ids: { imdb: imdbId }, season: +season || 1, number: +episode || 1 };
    await simklRequest('/sync/history', 'POST', payload, token);
    await clearWatchingNow(token);
}

// --- Session Management ---
function startSession(sessionId, data) {
    stopSession(sessionId);
    const loop = setInterval(() => setWatchingNow(data.token, data.imdbId, data.type, data.season, data.episode, data.duration, data.progress), data.interval * 1000);
    activeSessions.set(sessionId, { ...data, loop });
    setWatchingNow(data.token, data.imdbId, data.type, data.season, data.episode, data.duration, data.progress);
}

function stopSession(sessionId) {
    if (activeSessions.has(sessionId)) {
        clearInterval(activeSessions.get(sessionId).loop);
        activeSessions.delete(sessionId);
    }
}

// --- Stremio Stream Handler (REPLACES definePlayerHandler) ---
builder.defineStreamHandler(async (ctx) => {
    const { id, type, config, state } = ctx;
    const token = config?.simklAuthToken;
    const markAt = +config?.markWatchedAt || 80;
    const interval = Math.max(10, +config?.syncInterval || 30);

    if (!token || !id.startsWith('tt') || !state?.time) return { streams: [] };

    const imdbId = id;
    const duration = state.time.total || 0;
    const current = state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const sessionId = imdbId;

    await runInitialSync(token);
    await syncIfNeeded(token);

    if (state.paused === false && duration > 0) {
        if (progress >= markAt) { stopSession(sessionId); await markWatched(token, imdbId, type, state.season, state.episode); }
        else { startSession(sessionId, { token, imdbId, type, season: state.season, episode: state.episode, duration, progress, interval }); }
    } else { stopSession(sessionId); await clearWatchingNow(token); }

    return { streams: [] };
});

// --- Server Startup ---
const addonInterface = builder.getInterface();
const PORT = process.env.PORT || 58694;
serveHTTP(addonInterface, { port: PORT });
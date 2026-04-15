const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsyncpro',
    version: '2.6.0',
    name: 'Stremio Simkl Sync Pro',
    description: 'Watching Now, progress sync, and auto-mark watched for Simkl',
    logo: 'https://simkl.com/images/logos/simkl_logo_white.svg',
    background: 'https://simkl.com/images/backgrounds/simkl_background.jpg',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],

    // This enables the "Configure" button in Stremio
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },

    // All settings you'll see in the Stremio config menu
    config: [
        { key: 'simklClientId', type: 'text', title: 'Simkl Client ID', required: true },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl User Auth Token', required: true },
        { key: 'redirectUri', type: 'text', title: 'Simkl Redirect URI', default: 'urn:ietf:wg:oauth:2.0:oob', required: true },
        { key: 'markWatchedAt', type: 'number', title: 'Mark as Watched at (%)', default: 80, required: true },
        { key: 'syncInterval', type: 'number', title: 'Progress Sync Interval (seconds)', default: 30, required: true }
    ]
};

const builder = new addonBuilder(manifest);
const API_BASE = 'https://api.simkl.com';
const STORAGE_PATH = path.join(require('os').homedir(), 'simkl_sync_state.json');

const activeSessions = new Map();
let syncState = loadSyncState();

function loadSyncState() {
    try {
        if (fs.existsSync(STORAGE_PATH))
            return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
    } catch (e) {}
    return { lastActivityDate: null, lastFullSync: 0, isInitialSyncDone: false };
}

function saveSyncState() {
    try { fs.writeFileSync(STORAGE_PATH, JSON.stringify(syncState, null, 2)); } catch (e) {}
}

async function simklRequest(endpoint, method = 'GET', body = null, clientId, token) {
    const headers = {
        'Content-Type': 'application/json',
        'simkl-api-key': clientId
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, opts);
        return res.ok ? await res.json().catch(() => ({})) : null;
    } catch (e) { return null; }
}

async function runInitialSync(token, clientId) {
    if (syncState.isInitialSyncDone) return;
    await simklRequest('/sync/shows', 'GET', null, clientId, token);
    await simklRequest('/sync/movies', 'GET', null, clientId, token);
    await simklRequest('/sync/anime', 'GET', null, clientId, token);
    syncState.isInitialSyncDone = true;
    syncState.lastFullSync = Date.now();
    saveSyncState();
}

async function syncIfNeeded(token, clientId) {
    if (!token || !clientId || Date.now() - syncState.lastFullSync < 15 * 60 * 1000) return;
    const activity = await simklRequest('/sync/activities', 'GET', null, clientId, token);
    if (!activity?.last_watched_at || syncState.lastActivityDate === activity.last_watched_at) return;
    await simklRequest(`/sync/all-items?date_from=${encodeURIComponent(activity.last_watched_at)}`, 'GET', null, clientId, token);
    syncState.lastActivityDate = activity.last_watched_at;
    syncState.lastFullSync = Date.now();
    saveSyncState();
}

async function setWatchingNow(token, clientId, imdbId, type, season, episode, duration, progress) {
    const payload = { duration: Math.round(duration), progress: Math.min(Math.max(progress, 0), 100) };
    if (type === 'movie') payload.movie = { ids: { imdb: imdbId } };
    else payload.episode = { ids: { imdb: imdbId }, season: +season || 1, number: +episode || 1 };
    await simklRequest('/sync/watching', 'POST', payload, clientId, token);
}

async function clearWatchingNow(token, clientId) {
    await simklRequest('/sync/watching', 'DELETE', null, clientId, token);
}

async function markWatched(token, clientId, imdbId, type, season, episode) {
    const payload = { watched_at: 'now', progress: 100 };
    if (type === 'movie') payload.movie = { ids: { imdb: imdbId } };
    else payload.episode = { ids: { imdb: imdbId }, season: +season || 1, number: +episode || 1 };
    await simklRequest('/sync/history', 'POST', payload, clientId, token);
    await clearWatchingNow(token, clientId);
}

function startSession(sessionId, data) {
    stopSession(sessionId);
    const loop = setInterval(() => setWatchingNow(
        data.token, data.clientId, data.imdbId, data.type, data.season, data.episode,
        data.duration, data.progress
    ), data.interval * 1000);
    activeSessions.set(sessionId, { ...data, loop });
    setWatchingNow(
        data.token, data.clientId, data.imdbId, data.type, data.season, data.episode,
        data.duration, data.progress
    );
}

function stopSession(sessionId) {
    if (activeSessions.has(sessionId)) {
        clearInterval(activeSessions.get(sessionId).loop);
        activeSessions.delete(sessionId);
    }
}

builder.defineStreamHandler(async (ctx) => {
    const { id, type, config, state } = ctx;
    const clientId = config?.simklClientId;
    const token = config?.simklAuthToken;
    const redirectUri = config?.redirectUri;
    const markAt = +config?.markWatchedAt || 80;
    const interval = Math.max(10, +config?.syncInterval || 30);

    if (!token || !clientId || !id.startsWith('tt') || !state?.time) return { streams: [] };

    const imdbId = id;
    const duration = state.time.total || 0;
    const current = state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const sessionId = imdbId;

    await runInitialSync(token, clientId);
    await syncIfNeeded(token, clientId);

    if (state.paused === false && duration > 0) {
        if (progress >= markAt) {
            stopSession(sessionId);
            await markWatched(token, clientId, imdbId, type, state.season, state.episode);
        } else {
            startSession(sessionId, {
                token, clientId, imdbId, type,
                season: state.season, episode: state.episode,
                duration, progress, interval
            });
        }
    } else {
        stopSession(sessionId);
        await clearWatchingNow(token, clientId);
    }

    return { streams: [] };
});

const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
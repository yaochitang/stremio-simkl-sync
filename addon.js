const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsyncpro',
    version: '2.0.0',
    name: 'Stremio Simkl Sync Pro',
    description: 'Watching Now, progress sync, and 80% watched marker for Simkl',
    logo: 'https://simkl.com/images/logos/simkl_logo_white.svg',
    background: 'https://simkl.com/images/backgrounds/simkl_background.jpg',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['player'],
    idPrefixes: ['tt'],
    config: [
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token', required: true },
        { key: 'markWatchedAt', type: 'number', title: 'Mark as Watched at (%)', default: 80, required: true },
        { key: 'syncInterval', type: 'number', title: 'Progress Sync Interval (seconds)', default: 30, required: true }
    ]
};

const builder = new addonBuilder(manifest);

const SIMKL_CLIENT_ID = 'e8a990a0e1b6c7d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const API_BASE = 'https://api.simkl.com';
const STORAGE_PATH = path.join('/opt/render/data', 'simkl_sync_state.json');

const activeSessions = new Map();
let syncState = loadSyncState();

function loadSyncState() {
    try {
        if (fs.existsSync(STORAGE_PATH)) return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
    } catch (e) {}
    return { lastActivityDate: null, lastFullSync: 0, isInitialSyncDone: false };
}

function saveSyncState() {
    try { fs.writeFileSync(STORAGE_PATH, JSON.stringify(syncState, null, 2)); } catch (e) {}
}

async function simklRequest(endpoint, method = 'GET', body = null, token) {
    const headers = {
        'Content-Type': 'application/json',
        'simkl-api-key': SIMKL_CLIENT_ID
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, opts);
        if (!res.ok) return null;
        return res.json().catch(() => ({}));
    } catch (e) {
        return null;
    }
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
    if (!token) return;
    if (Date.now() - syncState.lastFullSync < 15 * 60 * 1000) return;
    const activity = await simklRequest('/sync/activities', 'GET', null, token);
    if (!activity?.last_watched_at) return;
    const serverDate = activity.last_watched_at;
    if (syncState.lastActivityDate === serverDate) return;
    await simklRequest(`/sync/all-items?date_from=${encodeURIComponent(serverDate)}`, 'GET', null, token);
    syncState.lastActivityDate = serverDate;
    syncState.lastFullSync = Date.now();
    saveSyncState();
}

async function setWatchingNow(token, imdbId, type, season, episode, duration, progress) {
    const payload = { duration: Math.round(duration), progress: Math.min(Math.max(progress, 0), 100) };
    if (type === 'movie') payload.movie = { ids: { imdb: imdbId } };
    else payload.episode = { ids: { imdb: imdbId }, season: +season || 1, number: +episode || 1 };
    await simklRequest('/sync/watching', 'POST', payload, token);
}

async function clearWatchingNow(token) {
    await simklRequest('/sync/watching', 'DELETE', null, token);
}

async function markWatched(token, imdbId, type, season, episode) {
    const payload = { watched_at: 'now', progress: 100 };
    if (type === 'movie') payload.movie = { ids: { imdb: imdbId } };
    else payload.episode = { ids: { imdb: imdbId }, season: +season || 1, number: +episode || 1 };
    await simklRequest('/sync/history', 'POST', payload, token);
    await clearWatchingNow(token);
}

function startSession(sessionId, data) {
    stopSession(sessionId);
    const loop = setInterval(async () => {
        await setWatchingNow(data.token, data.imdbId, data.type, data.season, data.episode, data.duration, data.progress);
    }, data.interval * 1000);
    activeSessions.set(sessionId, { ...data, loop });
    setWatchingNow(data.token, data.imdbId, data.type, data.season, data.episode, data.duration, data.progress);
}

function stopSession(sessionId) {
    if (activeSessions.has(sessionId)) {
        clearInterval(activeSessions.get(sessionId).loop);
        activeSessions.delete(sessionId);
    }
}

builder.definePlayerHandler(async (ctx) => {
    const { videoId, type, season, episode, config, state } = ctx;
    const token = config?.simklAuthToken;
    const markAt = +config?.markWatchedAt || 80;
    const interval = Math.max(10, +config?.syncInterval || 30);

    if (!token || !videoId.startsWith('tt') || !state?.time) return { play: {} };

    const imdbId = videoId;
    const duration = state.time.total || 0;
    const current = state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const sessionId = imdbId;

    await runInitialSync(token);
    await syncIfNeeded(token);

    if (state.paused === false && duration > 0) {
        if (progress >= markAt) {
            stopSession(sessionId);
            await markWatched(token, imdbId, type, season, episode);
        } else {
            startSession(sessionId, { token, imdbId, type, season, episode, duration, progress, interval });
        }
    } else {
        stopSession(sessionId);
        await clearWatchingNow(token);
    }

    return { play: {} };
});

const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
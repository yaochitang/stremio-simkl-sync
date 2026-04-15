const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsyncpro',
    version: '3.0.0',
    name: 'Stremio Simkl Sync Pro',
    description: 'Auto OAuth, Watching Now, progress sync, 80% auto-mark',
    logo: 'https://i.imgur.com/2B6X79y.png',
    background: 'https://i.imgur.com/70zGZLo.png',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],

    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },

    config: [
        { key: 'simklClientId', type: 'text', title: 'Simkl Client ID', required: true },
        { key: 'simklPin', type: 'text', title: 'Simkl PIN (paste after login)', required: false },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token (auto-filled)', required: true },
        { key: 'redirectUri', type: 'text', title: 'Redirect URI', default: 'urn:ietf:wg:oauth:2.0:oob', required: true },
        { key: 'markWatchedAt', type: 'number', title: 'Mark as Watched at (%)', default: 80 },
        { key: 'syncInterval', type: 'number', title: 'Sync Interval (seconds)', default: 30 }
    ]
};

const builder = new addonBuilder(manifest);
const API_BASE = 'https://api.simkl.com';
const OAUTH_BASE = 'https://simkl.com';

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

// Auto-get token from PIN
async function getTokenFromPin(clientId, pin, redirectUri) {
    try {
        const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                code: pin,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            })
        });
        const data = await res.json();
        return data.access_token || null;
    } catch (e) {
        return null;
    }
}

async function simklRequest(endpoint, method, body, clientId, token) {
    const headers = {
        'Content-Type': 'application/json',
        'simkl-api-key': clientId
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return res.ok ? await res.json() : null;
    } catch (e) { return null; }
}

builder.defineStreamHandler(async (ctx) => {
    const { id, type, config, state } = ctx;
    let { simklClientId, simklPin, simklAuthToken, redirectUri, markWatchedAt, syncInterval } = config || {};

    // AUTO GET TOKEN FROM PIN
    if (simklClientId && simklPin && simklPin.length >= 4 && !simklAuthToken) {
        simklAuthToken = await getTokenFromPin(simklClientId, simklPin, redirectUri);
    }

    const token = simklAuthToken;
    const markAt = +markWatchedAt || 80;
    const interval = Math.max(10, +syncInterval || 30);

    if (!token || !simklClientId || !id.startsWith('tt') || !state?.time) return { streams: [] };

    const imdbId = id;
    const duration = state.time.total || 0;
    const current = state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const sessionId = imdbId;

    if (state.paused === false && duration > 0) {
        if (progress >= markAt) {
            stopSession(sessionId);
            await simklRequest('/sync/history', 'POST', {
                watched_at: 'now',
                progress: 100,
                [type === 'movie' ? 'movie' : 'episode']: { ids: { imdb: imdbId }, ...(type !== 'movie' && { season: state.season, number: state.episode }) }
            }, simklClientId, token);
            await simklRequest('/sync/watching', 'DELETE', null, simklClientId, token);
        } else {
            startSession(sessionId, { token, clientId: simklClientId, imdbId, type, season: state.season, episode: state.episode, duration, progress, interval });
        }
    } else {
        stopSession(sessionId);
        await simklRequest('/sync/watching', 'DELETE', null, simklClientId, token);
    }

    return { streams: [] };
});

function startSession(id, data) {
    stopSession(id);
    const loop = setInterval(() => {
        simklRequest('/sync/watching', 'POST', {
            duration: data.duration,
            progress: data.progress,
            [data.type === 'movie' ? 'movie' : 'episode']: { ids: { imdb: data.imdbId }, ...(data.type !== 'movie' && { season: data.season, number: data.episode }) }
        }, data.clientId, data.token);
    }, data.interval * 1000);
    activeSessions.set(id, loop);
}

function stopSession(id) {
    if (activeSessions.has(id)) {
        clearInterval(activeSessions.get(id));
        activeSessions.delete(id);
    }
}

const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
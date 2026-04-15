const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsyncpro',
    version: '4.1.0',
    name: 'Stremio Simkl Sync',
    description: 'Sync watching progress to Simkl',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],

    // ALLOWS INSTALL WITHOUT TOKEN — FIXED!
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    },

    config: [
        { key: 'simklClientId', type: 'text', title: 'Simkl Client ID', required: false },
        { key: 'simklPin', type: 'text', title: 'Your PIN (Auto Generated)', required: false },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token', required: false },
        { key: 'markWatchedAt', type: 'number', title: 'Mark Watched At %', default: 80 }
    ]
};

const builder = new addonBuilder(manifest);
const API_BASE = 'shturl.cc/cJM9O7fTm6Q';
const STATE_FILE = path.join(require('os').homedir(), 'simkl_auth.json');

// Load saved state
let appState = { deviceCode: null, userCode: null, accessToken: null };
try {
    appState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (e) {}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));
}

// Auto generate PIN when Client ID is entered & video plays
builder.defineStreamHandler(async (ctx) => {
    const config = ctx.config || {};
    const clientId = config.simklClientId;

    // AUTO GET PIN (DEVICE CODE)
    if (clientId && !appState.userCode && !appState.accessToken) {
        try {
            const resp = await fetch(`${API_BASE}/oauth/device/code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: clientId, scope: 'all' })
            });
            const data = await resp.json();
            if (data.device_code && data.user_code) {
                appState.deviceCode = data.device_code;
                appState.userCode = data.user_code;
                saveState();
            }
        } catch (e) {}
    }

    // AUTO GET TOKEN AFTER USER ENTERS PIN AT shturl.cc/lBo
    if (clientId && appState.deviceCode && !appState.accessToken) {
        try {
            const resp = await fetch(`${API_BASE}/oauth/device/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    device_code: appState.deviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                })
            });
            const data = await resp.json();
            if (data.access_token) {
                appState.accessToken = data.access_token;
                saveState();
            }
        } catch (e) {}
    }

    // Inject PIN & Token into config
    if (appState.userCode) ctx.config.simklPin = appState.userCode;
    if (appState.accessToken) ctx.config.simklAuthToken = appState.accessToken;

    return { streams: [] };
});

const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
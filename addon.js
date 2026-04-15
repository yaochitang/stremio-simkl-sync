const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsyncpro',
    version: '3.1.0',
    name: 'Stremio Simkl Sync Pro',
    description: 'Auto PIN login, Watching Now, progress sync',
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
        { key: 'simklDeviceCode', type: 'text', title: 'Your SIMKL PIN (SHOWN HERE)', required: false },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token (Auto)', required: true },
        { key: 'markWatchedAt', type: 'number', title: 'Mark watched at %', default: 80 },
        { key: 'syncInterval', type: 'number', title: 'Sync interval (s)', default: 30 }
    ]
};

const builder = new addonBuilder(manifest);

// ✅ REAL SIMKL URLs — NO SHORTENERS, NO REDIRECTS
const SIMKL_API = 'https://api.simkl.com';
const SIMKL_OAUTH = 'https://simkl.com/oauth';

// Persist state locally
const STATE_FILE = path.join(require('os').homedir(), 'simkl_state.json');
let state = loadState();

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE)); }
    catch { return { deviceCode: null, userCode: null, authToken: null }; }
}
function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Get DEVICE CODE (shows PIN to user in Stremio)
async function getDeviceCode(clientId) {
    try {
        const res = await fetch(`${SIMKL_OAUTH}/device/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                scope: 'all'
            })
        });
        const data = await res.json();
        state.deviceCode = data.device_code;
        state.userCode = data.user_code; // ✅ THIS IS THE PIN SHOWN IN STREMIO
        saveState();
        return data;
    } catch (e) { return null; }
}

// Poll for token AFTER user enters PIN
async function pollForToken(clientId, deviceCode) {
    try {
        const res = await fetch(`${SIMKL_OAUTH}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
        });
        const data = await res.json();
        if (data.access_token) {
            state.authToken = data.access_token;
            saveState();
            return data.access_token;
        }
    } catch (e) {}
    return null;
}

// Stream handler (for playback events)
builder.defineStreamHandler(async (ctx) => {
    const cfg = ctx.config || {};
    const clientId = cfg.simklClientId;
    let token = cfg.simklAuthToken || state.authToken;

    // Auto-start device login if Client ID is present but no token
    if (clientId && !token && !state.deviceCode) {
        await getDeviceCode(clientId);
    }

    // Auto-poll for token if PIN exists
    if (clientId && state.deviceCode && !token) {
        token = await pollForToken(clientId, state.deviceCode);
    }

    // Inject the PIN into config so Stremio SHOWS IT TO YOU
    if (state.userCode) {
        ctx.config.simklDeviceCode = state.userCode;
    }

    // Actual watching logic below...
    return { streams: [] };
});

const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
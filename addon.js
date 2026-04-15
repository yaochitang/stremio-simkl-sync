const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsync',
    version: '1.0.1',
    name: 'Simkl Sync',
    description: 'Sync watch progress to Simkl (Official OAuth)',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false // Allows install without token
    },
    config: [
        { key: 'simklClientId', type: 'text', title: '1. Simkl Client ID', required: true },
        // We use a text field to display the fake button
        { key: 'simklAuthUrl', type: 'text', title: '👉 2. CLICK HERE TO AUTHORIZE (BUTTON STYLE)', required: false },
        { key: 'simklAuthToken', type: 'text', title: '3. Simkl Auth Token (Auto)', required: false }
    ]
};

const builder = new addonBuilder(manifest);
const SIMKL_API = 'shturl.cc/OIqdGe0MyKA';
const SIMKL_OAUTH = 'shturl.cc/0A4Io2R'; // Official web domain
const STATE_FILE = path.join(require('os').homedir(), 'simkl_token.json');

// Persist token
let persistentToken = null;
try {
    if (fs.existsSync(STATE_FILE)) {
        persistentToken = JSON.parse(fs.readFileSync(STATE_FILE)).token;
    }
} catch (e) {}

// --------------------------
// OFFICIAL SIMKL OAUTH AUTHORIZE URL
// --------------------------
function generateSimklAuthUrl(clientId) {
    // Use the official Simkl domain (not API)
    return `${SIMKL_OAUTH}/oauth/authorize?client_id=${clientId}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=all`;
}

// --------------------------
// EXCHANGE CODE FOR TOKEN
// --------------------------
async function exchangeCode(clientId, code) {
    try {
        const res = await fetch(`${SIMKL_API}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: 'urn:ietf:wg:oauth:2.0:oob'
            })
        });

        const data = await res.json();
        if (data.access_token) {
            // Save token locally so it persists
            fs.writeFileSync(STATE_FILE, JSON.stringify({ token: data.access_token }));
            return data.access_token;
        }
    } catch (err) {
        console.error("Token exchange failed:", err);
    }
    return null;
}

builder.defineStreamHandler(async (ctx) => {
    const config = ctx.config || {};
    const clientId = config.simklClientId;
    let currentToken = config.simklAuthToken || persistentToken;

    // --------------------------
    // STEP 1: GENERATE THE AUTHORIZE LINK
    // --------------------------
    // If Client ID is entered and no token, show the link (will look like a button)
    if (clientId && !currentToken) {
        const authUrl = generateSimklAuthUrl(clientId);
        // We style it as a button by putting the URL in the title
        ctx.config.simklAuthUrl = `🔗 CLICK TO OPEN: ${authUrl}`;
    }

    // --------------------------
    // STEP 2: AUTO-EXCHANGE CODE
    // --------------------------
    // If the user pastes the full URL with 'code=' back into this field...
    if (clientId && !currentToken && config.simklAuthUrl && config.simklAuthUrl.includes('code=')) {
        try {
            // Extract the code parameter from the URL
            const urlParams = new URLSearchParams(config.simklAuthUrl.split('?')[1]);
            const code = urlParams.get('code');

            if (code) {
                const token = await exchangeCode(clientId, code);
                if (token) {
                    currentToken = token;
                    // Auto-fill the token in the config
                    ctx.config.simklAuthToken = token;
                    // Clear the code URL to clean up
                    ctx.config.simklAuthUrl = "✅ Authorization Successful! Token saved.";
                }
            }
        } catch (e) {}
    }

    // --------------------------
    // STEP 3: SYNC LOGIC
    // --------------------------
    if (!currentToken || !clientId || !ctx.id.startsWith('tt') || !ctx.state?.time) {
        return { streams: [] };
    }

    const imdbId = ctx.id;
    const duration = ctx.state.time.total || 0;
    const current = ctx.state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;

    const simklRequest = async (endpoint, method = 'GET', body = null) => {
        const url = new URL(`${SIMKL_API}${endpoint}`);
        url.searchParams.append('client_id', clientId);
        url.searchParams.append('app-name', manifest.name);
        url.searchParams.append('app-version', manifest.version);

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': `${manifest.name}/${manifest.version}`,
            'Authorization': `Bearer ${currentToken}`
        };

        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        return res.ok ? await res.json().catch(() => ({})) : null;
    };

    if (!ctx.state.paused && duration > 0) {
        if (progress >= 80) { // Mark as watched if 80% is reached
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

serveHTTP(builder.getInterface(), { port: process.env.PORT || 58694 });
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const url = require('url');

const manifest = {
    id: 'org.stremio.simklsync',
    version: '2.0.0',
    name: 'Simkl Sync',
    description: 'Sync watch progress to Simkl',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: false },
    config: [
        { key: 'simklClientId', type: 'text', title: 'Simkl Client ID', required: true },
        { key: 'simklClientSecret', type: 'text', title: 'Simkl Client Secret', required: true },
        { key: 'redirectUri', type: 'text', title: 'Redirect URI', default: 'urn:ietf:wg:oauth:2.0:oob', required: true },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token', required: false }
    ]
};

const builder = new addonBuilder(manifest);
const SIMKL_API = 'https://api.simkl.com';
const SIMKL_OAUTH = 'https://simkl.com';
const STATE_FILE = path.join(require('os').homedir(), 'simkl_oauth.json');

// Load saved token
let appState = { accessToken: null };
try { appState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));

// --- Step 1: Generate Authorize URL (for the user to click) ---
function getAuthorizeUrl(clientId, redirectUri) {
    return `${SIMKL_OAUTH}/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=all`;
}

// --- Step 2: Exchange code for access token ---
async function exchangeCodeForToken(clientId, clientSecret, redirectUri, code) {
    const res = await fetch(`${SIMKL_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code: code,
            grant_type: 'authorization_code'
        })
    });
    const data = await res.json();
    if (data.access_token) {
        appState.accessToken = data.access_token;
        saveState();
        return data.access_token;
    }
    return null;
}

// --- Stream Handler ---
builder.defineStreamHandler(async (ctx) => {
    const config = ctx.config || {};
    const { simklClientId, simklClientSecret, redirectUri, simklAuthToken } = config;
    let token = simklAuthToken || appState.accessToken;

    // If no token, show the authorize URL in the config
    if (simklClientId && simklClientSecret && !token) {
        const authUrl = getAuthorizeUrl(simklClientId, redirectUri);
        ctx.config.simklAuthToken = `🔗 Open this URL to authorize: ${authUrl}\nThen paste the 'code' here.`;
    }

    // If user enters the code, exchange it for a token
    if (simklClientId && simklClientSecret && redirectUri && !token && simklAuthToken && simklAuthToken.startsWith('http') === false) {
        const code = simklAuthToken.trim();
        const newToken = await exchangeCodeForToken(simklClientId, simklClientSecret, redirectUri, code);
        if (newToken) {
            token = newToken;
            ctx.config.simklAuthToken = newToken;
        }
    }

    if (!token || !simklClientId || !ctx.id.startsWith('tt') || !ctx.state?.time) return { streams: [] };

    // --- Simkl Sync Logic ---
    const imdbId = ctx.id;
    const duration = ctx.state.time.total || 0;
    const current = ctx.state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const markAt = +config.markWatchedAt || 80;

    const simklRequest = async (endpoint, method = 'GET', body = null) => {
        const url = new URL(`${SIMKL_API}${endpoint}`);
        url.searchParams.append('client_id', simklClientId);
        url.searchParams.append('app-name', manifest.name);
        url.searchParams.append('app-version', manifest.version);

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': `${manifest.name}/${manifest.version}`,
            'Authorization': `Bearer ${token}`
        };

        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        return res.ok ? await res.json().catch(() => ({})) : null;
    };

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

const PORT = process.env.PORT || 58694;
serveHTTP(builder.getInterface(), { port: PORT });
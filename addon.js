const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsync',
    version: '1.0.0',
    name: 'Simkl Sync',
    description: 'Sync watch progress to Simkl',
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
        // This field will display the clickable authorize link
        { key: 'authorizeLink', type: 'text', title: '2. CLICK HERE TO AUTHORIZE', required: false },
        { key: 'simklAuthToken', type: 'text', title: '3. Simkl Auth Token (Auto-filled)', required: false }
    ]
};

const builder = new addonBuilder(manifest);
const SIMKL_API = 'https://api.simkl.com';
const SIMKL_OAUTH = 'https://simkl.com';
const STATE_FILE = path.join(require('os').homedir(), 'simkl_token.json');

// Load saved token from local storage
let authState = { accessToken: null };
try {
    authState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (e) {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(authState, null, 2));

// Generate the official Simkl OAuth authorize URL
function getAuthorizeUrl(clientId) {
    return `${SIMKL_OAUTH}/oauth/authorize?client_id=${clientId}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=all`;
}

builder.defineStreamHandler(async (ctx) => {
    const config = ctx.config || {};
    const clientId = config.simklClientId;
    let token = config.simklAuthToken || authState.accessToken;

    // If no token, show the clickable authorize link in the config
    if (clientId && !token) {
        const authUrl = getAuthorizeUrl(clientId);
        // The link will appear in the "CLICK HERE TO AUTHORIZE" field
        ctx.config.authorizeLink = authUrl;
    }

    // If the user pastes the code from the authorize URL, exchange it for a token
    if (clientId && !token && config.authorizeLink && config.authorizeLink.includes('code=')) {
        const urlParams = new URLSearchParams(config.authorizeLink.split('?')[1]);
        const code = urlParams.get('code');
        
        if (code) {
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
                    token = data.access_token;
                    authState.accessToken = token;
                    saveState();
                    // Auto-fill the token in the config
                    ctx.config.simklAuthToken = token;
                }
            } catch (e) {
                console.error('Token exchange failed:', e);
            }
        }
    }

    // If token exists, auto-fill it in the config
    if (token) {
        ctx.config.simklAuthToken = token;
    }

    // --- Simkl watch progress sync logic ---
    if (!token || !clientId || !ctx.id.startsWith('tt') || !ctx.state?.time) {
        return { streams: [] };
    }

    const imdbId = ctx.id;
    const duration = ctx.state.time.total || 0;
    const current = ctx.state.time.current || 0;
    const progress = duration ? (current / duration) * 100 : 0;
    const markAt = +config.markWatchedAt || 80;

    // Helper function for Simkl API requests
    const simklRequest = async (endpoint, method = 'GET', body = null) => {
        const url = new URL(`${SIMKL_API}${endpoint}`);
        url.searchParams.append('client_id', clientId);
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

    // Sync watching progress or mark as watched
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
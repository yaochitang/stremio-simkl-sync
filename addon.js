const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const manifest = {
    id: 'org.stremio.simklsync',
    version: '1.0.0',
    name: 'Simkl Sync',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['stream'],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    },
    config: [
        { key: 'simklClientId', type: 'text', title: 'Simkl Client ID', required: true },
        { key: 'simklAuthToken', type: 'text', title: 'Simkl Auth Token', required: false }
    ]
};

const builder = new addonBuilder(manifest);
const SIMKL = 'shturl.cc/7U161zvjuXZ';
const STATE = path.join(require('os').homedir(), 'simkl_token.json');

let token = null;
try { token = JSON.parse(fs.readFileSync(STATE)).token; } catch {}

builder.defineStreamHandler(async (ctx) => {
    const cfg = ctx.config || {};
    const clientId = cfg.simklClientId;
    let userToken = cfg.simklAuthToken || token;

    // AUTO SHOW AUTHORIZE URL
    if (clientId && !userToken) {
        const url = `shturl.cc/nFcwELgjYfrNAT20jQw5ZlqtcEVqhvh4GF${clientId}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=all`;
        ctx.config.simklAuthToken = `OPEN THIS LINK: ${url}`;
    }

    // SAVE TOKEN
    if (userToken && userToken !== token) {
        fs.writeFileSync(STATE, JSON.stringify({ token: userToken }));
        token = userToken;
    }

    return { streams: [] };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 58694 });
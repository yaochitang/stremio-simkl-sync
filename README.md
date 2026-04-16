# Stremio Simkl Sync (v0.0.1)
Stremio addon to sync your playback to Simkl using OAuth 2.0

## Features
- Simkl OAuth 2.0 authentication
- Full scrobble: start / pause / stop
- Configurable auto-mark watched at 80%
- Web UI configuration
- Persistent settings
- Deployable to Render

## Setup
1. Create a Simkl app: https://simkl.com/settings/apps
   - Redirect URI: `https://your-render-url.onrender.com/auth/simkl/callback`
2. Copy `.env` file and fill your keys
3. Install dependencies: `npm install`
4. Run: `npm start`

## Stremio Installation
Add this URL to Stremio addons:
`https://your-render-url.onrender.com/manifest.json`

## Render Deployment
1. Push to GitHub
2. New Web Service on Render
3. Connect repo
4. Set environment variables from `.env`
5. Deploy

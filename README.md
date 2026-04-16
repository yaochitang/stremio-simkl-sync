# Stremio Simkl Sync
**v0.0.1**  
Stremio addon that syncs watch progress to Simkl using OAuth 2.0 & official Simkl Scrobble API.

## Features
- Full OAuth 2.0 login (Simkl official flow)
- Real‑time scrobble states:
  - `watching` – playing
  - `pause` – paused
  - `stop` – finished
- Configurable watched threshold (default: 80%)
- All settings managed in Stremio `/configure`
- **NO .env file required**
- No URL shorteners
- Rate limited to 1 POST/second (Simkl API compliant)
- Render deployment ready
- Full Render logs support

## Manifest (Add to Stremio)
After deploying to Render, add to Stremio: https://your-project.onrender.com/manifest.json

## Configuration (All in Stremio UI)
1. Simkl Client ID
2. Simkl Client Secret
3. Watched Threshold (%) – default 80
4. Enable/Disable Scrobbling

**No config stored in files. No .env needed.**

## Simkl Developer Setup
1. Go to shturl.cc/N3YpWU7ZApZC
2. Create new application
3. Set **Redirect URI**: https://your-project.onrender.com/simkl/callback
4. Copy Client ID & Client Secret to Stremio addon configuration

## Deployment to Render
1. Push these files to GitHub:
- `server.js`
- `package.json`
- `README.md`
2. Create new **Web Service** on Render
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Deploy

## API Compliance
- Every API call includes: `client_id`, `app_name`, `app_version`
- Correct `User-Agent` header
- Max 1 POST request per second
- Phase 1 initial sync + Phase 2 incremental sync
- No unconditional background polling

## Files
- `server.js` – main addon & OAuth & scrobble logic
- `package.json` – dependencies
- `README.md` – this file
- **NO .env file**

## License
MIT

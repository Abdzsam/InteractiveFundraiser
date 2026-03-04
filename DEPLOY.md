# Deploy Online

## Fastest: Render

1. Push this repo to GitHub.
2. Go to https://render.com and create account.
3. Click **New +** -> **Blueprint**.
4. Select your repo (it will auto-detect `render.yaml`).
5. Click **Apply**.
6. Open your live URL after deploy finishes.

Notes:
- The app is set to skip terminal prompts in cloud via `NO_START_PROMPT=1`.
- Health check endpoint is `/healthz`.
- Uploaded files and runtime state are stored on instance disk; on free hosting this can reset on redeploy/restart.

## Quick alternative: Railway

1. Push repo to GitHub.
2. Go to https://railway.app -> **New Project** -> **Deploy from GitHub repo**.
3. Set environment variable: `NO_START_PROMPT=1`.
4. Deploy.

Railway will detect `npm start` and set `PORT` automatically.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, 'campaign-state.json');
const CONFIG_FILE = path.join(__dirname, 'fundraiser.config.json');
const MAX_ASSET_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_ASSET_MIMES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};
const MEDIA_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp'];
const QR_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif'];

const uploadDefaultMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_UPLOAD_BYTES, files: 1 },
});

const DEFAULT_CONFIG = {
  campaign: {
    title: 'Help Sponsor Orphaned Children',
    organization: 'Orphans Around the World',
    donateUrl: 'https://www.launchgood.com/v4/campaign/sponsor_orphanschildren_from_gaza_w_msa_dalhousie',
    donateButtonText: 'Donate Now →',
    qrLabel: 'Scan to Donate',
    currency: 'CAD',
    locale: 'en-CA',
    goal: 5000,
  },
  display: {
    gifSpeed: 7,
    maxRecentDonors: 5,
    tierPreloadDelayMs: 3000,
    pollingIntervalMs: 30000,
  },
  donationExperience: {
    bannerLabel: 'NEW DONATION',
    bannerDurationMs: 6000,
    returnToDefaultMs: 13000,
    jackpotReturnToDefaultMs: 17000,
    jackpotDelayMs: 800,
  },
  jackpot: {
    secretAmount: 24,
    triggerTolerance: 0.5,
    hintLabel: '$19–$39',
    overlayTitle: "MASHA'ALLAH!",
    overlaySubtitle: 'Secret Prize Unlocked!',
    overlayDismissText: 'Press ESC or tap to continue',
    autoDismissMs: 15000,
  },
  assets: {
    qrImage: '/qr.png',
  },
  tiers: [
    { min: 40, tier: '5', label: '$40+', emoji: '👑', name: 'LEGENDARY' },
    { min: 30, tier: '4', label: '$30–$39', emoji: '🔥', name: 'EPIC' },
    { min: 20, tier: '3', label: '$20–$29', emoji: '⚡', name: 'GREAT' },
    { min: 15, tier: '2point5', label: '$15–$19', emoji: '💫', name: 'AWESOME' },
    { min: 10, tier: '2', label: '$10–$14', emoji: '✨', name: 'GOOD' },
    { min: 5, tier: '1point5', label: '$5–$9', emoji: '🎊', name: 'NICE' },
    { min: 1, tier: '1', label: '$1–$4', emoji: '🎉', name: 'THANKS' },
  ],
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override : base;
  }
  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const output = { ...base };
  if (!isPlainObject(override)) return output;

  for (const key of Object.keys(override)) {
    const baseValue = base[key];
    const overrideValue = override[key];
    output[key] = deepMerge(baseValue, overrideValue);
  }
  return output;
}

function numberOr(defaultValue, maybeNumber, min = null) {
  const parsed = Number(maybeNumber);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (min != null && parsed < min) return defaultValue;
  return parsed;
}

function sanitizeConfig(rawConfig) {
  const merged = deepMerge(DEFAULT_CONFIG, rawConfig);

  merged.campaign.goal = numberOr(DEFAULT_CONFIG.campaign.goal, merged.campaign.goal, 1);

  merged.display.gifSpeed = numberOr(DEFAULT_CONFIG.display.gifSpeed, merged.display.gifSpeed, 0.1);
  merged.display.maxRecentDonors = Math.round(numberOr(DEFAULT_CONFIG.display.maxRecentDonors, merged.display.maxRecentDonors, 1));
  merged.display.tierPreloadDelayMs = numberOr(DEFAULT_CONFIG.display.tierPreloadDelayMs, merged.display.tierPreloadDelayMs, 0);
  merged.display.pollingIntervalMs = numberOr(DEFAULT_CONFIG.display.pollingIntervalMs, merged.display.pollingIntervalMs, 5000);

  merged.donationExperience.bannerDurationMs = numberOr(DEFAULT_CONFIG.donationExperience.bannerDurationMs, merged.donationExperience.bannerDurationMs, 500);
  merged.donationExperience.returnToDefaultMs = numberOr(DEFAULT_CONFIG.donationExperience.returnToDefaultMs, merged.donationExperience.returnToDefaultMs, 500);
  merged.donationExperience.jackpotReturnToDefaultMs = numberOr(DEFAULT_CONFIG.donationExperience.jackpotReturnToDefaultMs, merged.donationExperience.jackpotReturnToDefaultMs, 500);
  merged.donationExperience.jackpotDelayMs = numberOr(DEFAULT_CONFIG.donationExperience.jackpotDelayMs, merged.donationExperience.jackpotDelayMs, 0);

  merged.jackpot.secretAmount = numberOr(DEFAULT_CONFIG.jackpot.secretAmount, merged.jackpot.secretAmount, 0.01);
  merged.jackpot.triggerTolerance = numberOr(DEFAULT_CONFIG.jackpot.triggerTolerance, merged.jackpot.triggerTolerance, 0.01);
  merged.jackpot.autoDismissMs = numberOr(DEFAULT_CONFIG.jackpot.autoDismissMs, merged.jackpot.autoDismissMs, 1000);
  merged.assets.qrImage = typeof merged.assets.qrImage === 'string' && merged.assets.qrImage.trim()
    ? merged.assets.qrImage.trim()
    : DEFAULT_CONFIG.assets.qrImage;

  const incomingTiers = Array.isArray(merged.tiers) ? merged.tiers : DEFAULT_CONFIG.tiers;
  const validatedTiers = incomingTiers
    .filter((t) => t && Number.isFinite(Number(t.min)) && t.tier != null)
    .map((t) => ({
      min: Number(t.min),
      tier: String(t.tier),
      label: String(t.label || `$${Number(t.min)}+`),
      emoji: t.emoji ? String(t.emoji) : '🎁',
      name: t.name ? String(t.name) : 'TIER',
    }))
    .sort((a, b) => b.min - a.min);

  merged.tiers = validatedTiers.length ? validatedTiers : [...DEFAULT_CONFIG.tiers];
  return merged;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log('Created fundraiser.config.json with default settings.');
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return sanitizeConfig(raw);
  } catch (err) {
    console.warn('Failed to parse fundraiser.config.json. Using defaults.');
    console.warn(err.message);
    return DEFAULT_CONFIG;
  }
}

let config = loadConfig();

function saveConfig(nextConfig) {
  config = sanitizeConfig(deepMerge(config, nextConfig));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

function getTier(amount) {
  for (const t of config.tiers) {
    if (amount >= t.min) return t.tier;
  }
  return config.tiers[config.tiers.length - 1].tier;
}

function isJackpot(amount) {
  return Math.abs(amount - config.jackpot.secretAmount) < config.jackpot.triggerTolerance;
}

function publicConfigPayload() {
  return {
    campaign: config.campaign,
    display: config.display,
    donationExperience: config.donationExperience,
    assets: config.assets,
    jackpot: {
      hintLabel: config.jackpot.hintLabel,
      overlayTitle: config.jackpot.overlayTitle,
      overlaySubtitle: config.jackpot.overlaySubtitle,
      overlayDismissText: config.jackpot.overlayDismissText,
      autoDismissMs: config.jackpot.autoDismissMs,
    },
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  raised: 0,
  goal: config.campaign.goal,
  donors: 0,
  lastDonation: 0,
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = {
      ...state,
      ...saved,
      goal: numberOr(config.campaign.goal, saved.goal, 1),
    };
    console.log(`Loaded saved state — $${state.raised} raised`);
  } catch (_) {}
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => res.json(state));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/api/public-config', (_req, res) => {
  res.json(publicConfigPayload());
});

app.get('/api/admin/config', (_req, res) => {
  res.json(config);
});

app.get('/api/tiers', (_req, res) => {
  res.json({
    tiers: [...config.tiers].reverse(),
    jackpotHint: config.jackpot.hintLabel,
  });
});

app.post('/api/admin/config', (req, res) => {
  try {
    const nextConfig = saveConfig(req.body || {});

    // Optional convenience: sync current display goal with campaign default goal.
    if (req.query.syncGoal === '1') {
      state.goal = nextConfig.campaign.goal;
      saveState();
    }

    broadcast({ type: 'config-updated' });
    broadcast({ type: 'update', ...state });
    res.json({ success: true, config: nextConfig });
  } catch (err) {
    res.status(400).json({ error: 'Invalid config payload', details: err.message });
  }
});

app.post('/api/admin/upload-default-media', (_req, res) => {
  res.status(400).json({
    error: 'Use /api/admin/upload-asset with multipart/form-data fields: file + target=default.',
    code: 'DEPRECATED_ENDPOINT',
  });
});

app.post('/api/admin/upload-asset', (req, res) => {
  uploadDefaultMedia.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'File too large. Maximum is 25 MB.',
          code: err.code,
          maxBytes: MAX_ASSET_UPLOAD_BYTES,
        });
      }
      return res.status(400).json({
        error: 'Upload failed.',
        code: err.code || 'UPLOAD_FAILED',
      });
    }

    if (req.is('application/json') && req.body?.dataUrl) {
      return res.status(400).json({
        error: 'Use multipart file upload.',
        code: 'UNSUPPORTED_UPLOAD_FORMAT',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded. Send multipart/form-data with field "file".',
        code: 'MISSING_FILE',
      });
    }

    const target = String(req.body?.target || req.query?.target || '').trim();
    if (!target) {
      return res.status(400).json({
        error: 'Missing upload target.',
        code: 'MISSING_TARGET',
      });
    }

    const mime = String(req.file.mimetype || '').toLowerCase();
    const ext = ALLOWED_ASSET_MIMES[mime];

    if (!ext) {
      return res.status(400).json({
        error: `Unsupported image type: ${mime || 'unknown'}`,
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }

    if (!req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        error: 'Uploaded file is empty.',
        code: 'EMPTY_FILE',
      });
    }

    let baseDir = path.join(__dirname, 'public', 'gif');
    let fileBase = 'default';
    let cleanups = MEDIA_EXTS.map((x) => `default.${x}`);
    let broadcastTarget = 'default';

    if (target === 'qr') {
      baseDir = path.join(__dirname, 'public');
      fileBase = 'qr';
      cleanups = QR_EXTS.map((x) => `qr.${x}`);
      broadcastTarget = 'qr';
    } else if (target === 'jackpot') {
      fileBase = 'jackpot';
      cleanups = MEDIA_EXTS.map((x) => `jackpot.${x}`);
      broadcastTarget = 'jackpot';
    } else if (target.startsWith('tier:')) {
      const tierKey = target.slice(5).trim();
      if (!tierKey) {
        return res.status(400).json({
          error: 'Invalid tier key.',
          code: 'INVALID_TIER_KEY',
        });
      }
      fileBase = `tier${tierKey}`;
      cleanups = MEDIA_EXTS.map((x) => `${fileBase}.${x}`);
      broadcastTarget = `tier:${tierKey}`;
    } else if (target !== 'default') {
      return res.status(400).json({
        error: `Unsupported upload target: ${target}`,
        code: 'UNSUPPORTED_TARGET',
      });
    }

    const targetName = `${fileBase}.${ext}`;
    const targetPath = path.join(baseDir, targetName);

    try {
      fs.writeFileSync(targetPath, req.file.buffer);
      for (const oldFile of cleanups) {
        if (oldFile === targetName) continue;
        const oldPath = path.join(baseDir, oldFile);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      if (target === 'qr') {
        saveConfig({ assets: { qrImage: `/${targetName}` } });
        broadcast({ type: 'config-updated' });
      }
    } catch (writeErr) {
      return res.status(500).json({
        error: 'Failed to save uploaded file.',
        code: 'WRITE_FAILED',
        details: writeErr.message,
      });
    }

    broadcast({ type: 'media-updated', target: broadcastTarget, version: Date.now() });
    return res.json({
      success: true,
      file: targetName,
      target: broadcastTarget,
      sizeBytes: req.file.size,
      mime,
    });
  });
});

// Manual donation entry — used at the event desk
app.post('/api/manual-donation', (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const jackpotHit = isJackpot(amount);
  state.raised = (state.raised || 0) + amount;
  state.lastDonation = amount;
  state.donors = (state.donors || 0) + 1;
  saveState();

  console.log(`🎉 $${amount.toFixed(2)} — tier ${getTier(amount)}${jackpotHit ? ' 🏆 JACKPOT!' : ''} | total $${state.raised.toFixed(2)}`);

  broadcast({
    type: 'donation',
    amount,
    total: state.raised,
    goal: state.goal,
    donors: state.donors,
    tier: getTier(amount),
    jackpot: jackpotHit,
  });

  res.json({ success: true, total: state.raised, jackpot: jackpotHit });
});

app.post('/api/reset', (_req, res) => {
  state.raised = 0;
  state.donors = 0;
  state.lastDonation = 0;
  saveState();
  console.log('🔄 State reset to zero');
  broadcast({ type: 'update', ...state });
  res.json({ success: true });
});

app.post('/api/set-state', (req, res) => {
  const { raised, goal } = req.body;
  if (raised !== undefined) state.raised = Math.max(0, parseFloat(raised) || 0);
  if (goal !== undefined) state.goal = Math.max(1, parseFloat(goal) || state.goal);
  saveState();
  console.log(`⚙️  State updated — raised: $${state.raised}, goal: $${state.goal}`);
  broadcast({ type: 'update', ...state });
  res.json({ success: true, state });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('Display connected');
  ws.send(JSON.stringify({ type: 'init', ...state }));
  ws.on('error', (err) => console.error('WS error:', err.message));
  ws.on('close', () => console.log('Display disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

function askStartingState() {
  // In cloud deploys (no TTY), skip interactive prompt and boot immediately.
  if (!process.stdin.isTTY || process.env.NO_START_PROMPT === '1') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((r) => rl.question(q, r));

    (async () => {
      console.log('\n──────────────────────────────────────────────────');
      console.log('  Starting state (press Enter to keep saved value)');
      console.log('──────────────────────────────────────────────────');

      const rAns = await ask(`  Raised so far (${config.campaign.currency}) [${state.raised}]: `);
      if (rAns.trim()) {
        const v = parseFloat(rAns);
        if (!isNaN(v) && v >= 0) state.raised = v;
      }

      const dAns = await ask(`  Donor count                         [${state.donors}]: `);
      if (dAns.trim()) {
        const v = parseInt(dAns, 10);
        if (!isNaN(v) && v >= 0) state.donors = v;
      }

      rl.close();
      if (rAns.trim() || dAns.trim()) saveState();
      console.log('──────────────────────────────────────────────────\n');
      resolve();
    })();
  });
}

const PORT = process.env.PORT || 3000;

wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Stop the existing process, then restart:`);
    console.error(`   kill $(lsof -tiTCP:${PORT} -sTCP:LISTEN) && npm start\n`);
    return;
  }
  console.error('\n❌ WebSocket server error:', err.message);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Stop the existing process, then restart:`);
    console.error(`   kill $(lsof -tiTCP:${PORT} -sTCP:LISTEN) && npm start\n`);
    process.exit(1);
  }

  console.error('\n❌ Server failed to start:', err.message);
  process.exit(1);
});

askStartingState().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Fundraiser display → http://localhost:${PORT}`);
    console.log('🛠  Admin routes:');
    console.log(`   GET  http://localhost:${PORT}/api/admin/config`);
    console.log(`   POST http://localhost:${PORT}/api/admin/config`);
    console.log(`   POST http://localhost:${PORT}/api/admin/upload-asset (multipart fields: file + target, max 25MB)`);
    console.log(`🏆 Jackpot secret loaded (${config.campaign.currency} ${config.jackpot.secretAmount})`);
    console.log(`🎯 Goal: ${config.campaign.currency} ${state.goal} | Raised: ${state.raised} | Donors: ${state.donors}`);
    console.log('⚙️  Edit fundraiser.config.json to customize this fundraiser.\n');
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down…');
  process.exit(0);
});

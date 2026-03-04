/* ═══════════════════════════════════════════════════════════════
   Interactive Fundraiser — Frontend
   ─ Multi-tier image system (tier1 → tier1point5 → tier2 → tier3 → tier4 → tier5 + jackpot)
   ─ Jackpot full-screen overlay with special meme
   ─ Tier strip shows audience what they unlock at each level
   ─ WebSocket client with polling fallback
   ─ Confetti & animated counter
   ═══════════════════════════════════════════════════════════════ */

// ── DOM references ──────────────────────────────────────────────
const gifCanvas      = document.getElementById('gif-canvas');
const gifCtx         = gifCanvas.getContext('2d');
const gifPlaceholder = document.getElementById('gif-placeholder');
const speedBadge     = document.getElementById('speed-badge');
const speedText      = document.getElementById('speed-text');
const confCanvas     = document.getElementById('confetti-canvas');
const confCtx        = confCanvas.getContext('2d');
const bgCanvas       = document.getElementById('bg-canvas');
const bgCtx          = bgCanvas.getContext('2d');
const raisedEl       = document.getElementById('raised-display');
const goalEl         = document.getElementById('goal-display');
const donorsEl       = document.getElementById('donors-display');
const progressFill   = document.getElementById('progress-fill');
const progressPct    = document.getElementById('progress-pct');
const bannerEl       = document.getElementById('donation-banner');
const bannerAmt      = document.getElementById('banner-amount');
const donorsListEl   = document.getElementById('donors-list');
const connStatus     = document.getElementById('conn-status');
const adminPanel     = document.getElementById('admin-panel');
const jackpotOverlay = document.getElementById('jackpot-overlay');
const jackpotCanvas  = document.getElementById('jackpot-canvas');
const jackpotCtx     = jackpotCanvas.getContext('2d');
const campaignTitleEl = document.getElementById('campaign-title');
const orgBadgeEl      = document.getElementById('org-badge');
const donateBtnEl     = document.getElementById('donate-btn');
const bannerLabelEl   = document.getElementById('banner-label');
const jackpotTitleEl  = document.getElementById('jackpot-title');
const jackpotSubEl    = document.getElementById('jackpot-subtitle');
const jackpotDismissEl = document.getElementById('jackpot-dismiss');
const qrLabelEls      = document.querySelectorAll('.qr-label');
const qrImageEls      = document.querySelectorAll('.qr-img');
const configJsonEl    = document.getElementById('config-json');
const adminStatusEl   = document.getElementById('admin-status');
const defaultMediaInputEl = document.getElementById('default-media-input');
const qrMediaInputEl  = document.getElementById('qr-media-input');
const jackpotMediaInputEl = document.getElementById('jackpot-media-input');
const tierMediaInputEl = document.getElementById('tier-media-input');
const tierMediaKeyEl = document.getElementById('tier-media-key');
const tiersEditorEl = document.getElementById('tiers-editor');
const cfgTitleEl = document.getElementById('cfg-title');
const cfgOrgEl = document.getElementById('cfg-org');
const cfgDonateUrlEl = document.getElementById('cfg-donate-url');
const cfgButtonTextEl = document.getElementById('cfg-button-text');
const cfgQrLabelEl = document.getElementById('cfg-qr-label');
const cfgGoalDefaultEl = document.getElementById('cfg-goal-default');
const cfgCurrencyEl = document.getElementById('cfg-currency');
const cfgLocaleEl = document.getElementById('cfg-locale');
const cfgJackpotHintEl = document.getElementById('cfg-jackpot-hint');

const APP_DEFAULTS = {
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
    hintLabel: '$19–$39',
    overlayTitle: "MASHA'ALLAH!",
    overlaySubtitle: 'Secret Prize Unlocked!',
    overlayDismissText: 'Press ESC or tap to continue',
    autoDismissMs: 15000,
  },
  assets: {
    qrImage: '/qr.png',
  },
};

let appConfig = JSON.parse(JSON.stringify(APP_DEFAULTS));
let currencyFormatter = new Intl.NumberFormat(APP_DEFAULTS.campaign.locale, {
  style: 'currency',
  currency: APP_DEFAULTS.campaign.currency,
  maximumFractionDigits: 0,
});
let smallCurrencyFormatter = new Intl.NumberFormat(APP_DEFAULTS.campaign.locale, {
  style: 'currency',
  currency: APP_DEFAULTS.campaign.currency,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function mergeConfig(base, incoming) {
  if (Array.isArray(base)) return Array.isArray(incoming) ? incoming : base;
  if (!base || typeof base !== 'object') return incoming === undefined ? base : incoming;
  const out = { ...base };
  if (!incoming || typeof incoming !== 'object') return out;
  for (const key of Object.keys(incoming)) {
    out[key] = mergeConfig(base[key], incoming[key]);
  }
  return out;
}

// ── App state ───────────────────────────────────────────────────
let currentRaised = 0;
let currentGoal   = APP_DEFAULTS.campaign.goal;
let currentDonors = 0;
let tierConfig    = [];   // populated from /api/tiers
let jackpotHint   = APP_DEFAULTS.jackpot.hintLabel;
let recentDonors  = [];   // [amount] newest first, max 5
let adminFullConfig = null;
let mediaVersion = Date.now();

// ══════════════════════════════════════════════════════════════════
// SECTION 1 – Multi-tier GIF engine
// ══════════════════════════════════════════════════════════════════

/*
  gifCache maps filename → decoded data object { frames, width, height }
  or the string 'loading' | 'failed' while in-flight / errored.
  Filenames: 'tier1', 'tier1point5', 'tier2'…'tier5', 'jackpot'
*/
const gifCache = {};

let activeTierFile = null;   // which tier is on the main canvas right now
let gifFrames      = [];     // alias into the active tier's frames array
let gifFrameIndex  = 0;
let gifRafId       = null;   // requestAnimationFrame handle
let gifNextFrameAt = 0;     // performance.now() timestamp for next frame draw
let gifSpeedMult   = 1;
let gifLoaded      = false;

let jackpotGifLoaded = false;
let jackpotFrames    = [];
let jackpotIndex     = 0;
let jackpotTimeout   = null;

let defaultImg             = null;   // static image (PNG/JPG) for default state
let defaultIsStatic        = false;
let returnToDefaultTimeout = null;

/**
 * Decode a GIF at the given URL and store result under `cacheKey`.
 * Returns the decoded data object or null on failure.
 */
async function fetchAndDecodeGIF(url, cacheKey) {
  if (gifCache[cacheKey] && gifCache[cacheKey] !== 'loading' && gifCache[cacheKey] !== 'failed') {
    return gifCache[cacheKey];
  }
  gifCache[cacheKey] = 'loading';

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    const parsed = gifuct.parseGIF(buffer);
    const frames = gifuct.decompressFrames(parsed, true);
    if (!frames || frames.length === 0) throw new Error('No frames decoded');

    const data = {
      frames: frames.map((f) => ({
        imageData: new ImageData(f.patch, f.dims.width, f.dims.height),
        delay:     (f.delay || 0) * 10,
        x:         f.dims.left,
        y:         f.dims.top,
        disposal:  f.disposalType,
        dims:      f.dims,
      })),
      width:  parsed.lsd.width,
      height: parsed.lsd.height,
    };

    gifCache[cacheKey] = data;
    console.log(`GIF cached: ${cacheKey} (${data.frames.length} frames, ${data.width}×${data.height})`);
    return data;
  } catch (err) {
    console.warn(`GIF load failed [${cacheKey}] ${url}:`, err.message);
    gifCache[cacheKey] = 'failed';
    return null;
  }
}

// Supported image formats to try for each tier (in order)
const TIER_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp'];

// Cache for static (non-GIF) tier images
const tierStaticCache = {};

/** Load a static image for a tier and draw it to the main canvas. */
function tryLoadTierStatic(src, key) {
  return new Promise((resolve) => {
    if (tierStaticCache[key]) {
      const img = tierStaticCache[key];
      if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }
      gifCanvas.width  = img.naturalWidth  || 400;
      gifCanvas.height = img.naturalHeight || 300;
      gifCtx.drawImage(img, 0, 0);
      gifPlaceholder.classList.add('hidden');
      gifCanvas.style.display = '';
      gifLoaded = false;
      activeTierFile = key;
      return resolve(true);
    }
    const img = new Image();
    img.onload = () => {
      tierStaticCache[key] = img;
      if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }
      gifCanvas.width  = img.naturalWidth  || 400;
      gifCanvas.height = img.naturalHeight || 300;
      gifCtx.drawImage(img, 0, 0);
      gifPlaceholder.classList.add('hidden');
      gifCanvas.style.display = '';
      gifLoaded = false;
      activeTierFile = key;
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

/**
 * Switch the main canvas to a tier image.
 * Tries tier{key}.gif (animated), then tier{key}.png/jpg/webp/… (static).
 * Falls back to tier1 on failure.
 */
async function loadGIFForTier(tierKey) {
  const key = `tier${tierKey}`;

  // Already in animated GIF cache?
  if (gifCache[key] && gifCache[key] !== 'loading' && gifCache[key] !== 'failed') {
    switchMainGIF(key);
    return;
  }
  // Already in static cache?
  if (tierStaticCache[key]) {
    tryLoadTierStatic(null, key);
    return;
  }

  // Try every extension in order
  for (const ext of TIER_EXTS) {
    const src = `/gif/${key}.${ext}`;
    if (ext === 'gif') {
      const data = await fetchAndDecodeGIF(src, key);
      if (data) { switchMainGIF(key); return; }
    } else {
      if (await tryLoadTierStatic(src, key)) return;
    }
  }

  // Fallback: try tier1
  if (String(tierKey) !== '1') {
    console.log(`Falling back to tier1 for tier ${tierKey}`);
    await loadGIFForTier('1');
    return;
  }

  // All failed — show placeholder
  gifPlaceholder.classList.remove('hidden');
  gifCanvas.style.display = 'none';
  gifLoaded = false;
}

/**
 * Point the animation loop at a cached GIF and restart playback.
 */
function switchMainGIF(cacheKey) {
  const data = gifCache[cacheKey];
  if (!data || data === 'loading' || data === 'failed') return;

  if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }

  activeTierFile      = cacheKey;
  gifFrames           = data.frames;
  gifFrameIndex       = 0;
  gifNextFrameAt      = 0;
  gifCanvas.width     = data.width;
  gifCanvas.height    = data.height;
  gifLoaded           = true;

  gifPlaceholder.classList.add('hidden');
  gifCanvas.style.display = '';

  gifRafId = requestAnimationFrame(scheduleNextFrame);
}

// ── Main GIF animation loop ──────────────────────────────────────

function drawMainFrame(index) {
  const frame = gifFrames[index];
  if (!frame) return;

  if (index > 0) {
    const prev = gifFrames[index - 1];
    if (prev.disposal === 2) {
      gifCtx.clearRect(prev.x, prev.y, prev.dims.width, prev.dims.height);
    }
  }

  gifCtx.putImageData(frame.imageData, frame.x, frame.y);
}

function scheduleNextFrame(timestamp) {
  if (!gifLoaded || gifFrames.length === 0) return;

  const now = timestamp || performance.now();

  if (now >= gifNextFrameAt) {
    drawMainFrame(gifFrameIndex);
    const frame    = gifFrames[gifFrameIndex];
    const speed    = Math.max(0.1, appConfig.display.gifSpeed * gifSpeedMult);
    gifNextFrameAt = now + frame.delay / speed;
    gifFrameIndex  = (gifFrameIndex + 1) % gifFrames.length;
  }

  gifRafId = requestAnimationFrame(scheduleNextFrame);
}

// ── Speed control ─────────────────────────────────────────────────

let decayInterval = null;

function burstThenDecay(peakSpeed, durationMs = 10000) {
  if (decayInterval) clearInterval(decayInterval);

  gifSpeedMult = peakSpeed;
  updateSpeedBadge(peakSpeed);

  const steps     = 80;
  const stepMs    = durationMs / steps;
  const decayRate = Math.pow(1 / peakSpeed, 1 / steps);

  decayInterval = setInterval(() => {
    gifSpeedMult = Math.max(1, gifSpeedMult * decayRate);
    updateSpeedBadge(gifSpeedMult);

    if (gifSpeedMult <= 1.05) {
      gifSpeedMult = 1;
      updateSpeedBadge(1);
      clearInterval(decayInterval);
      decayInterval = null;
      speedBadge.classList.add('hidden');
    }
  }, stepMs);
}

function updateSpeedBadge(speed) {
  speedBadge.classList.remove('hidden');
  speedText.textContent = speed.toFixed(1) + '×';
}

/** Logarithmic speed: $1→1×, $10→4×, $25→6×, $100→8×, $250+→10× */
function donationToSpeed(amount) {
  if (amount <= 0) return 1;
  return Math.min(10, 1 + Math.log2(Math.max(1, amount)));
}

// ── Default image helpers ─────────────────────────────────────────

function showStaticDefault() {
  if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }
  gifLoaded = false;
  activeTierFile = null;
  gifCanvas.width  = defaultImg.naturalWidth  || 400;
  gifCanvas.height = defaultImg.naturalHeight || 300;
  gifCtx.drawImage(defaultImg, 0, 0);
  gifPlaceholder.classList.add('hidden');
  gifCanvas.style.display = '';
}

function switchToDefault() {
  if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }
  gifSpeedMult = 1;
  if (gifCache['default'] && gifCache['default'] !== 'loading' && gifCache['default'] !== 'failed') {
    switchMainGIF('default');
  } else if (defaultIsStatic && defaultImg) {
    showStaticDefault();
  }
}

function scheduleReturnToDefault(delayMs) {
  if (returnToDefaultTimeout) clearTimeout(returnToDefaultTimeout);
  returnToDefaultTimeout = setTimeout(() => {
    returnToDefaultTimeout = null;
    switchToDefault();
  }, delayMs);
}

function tryLoadStaticImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      defaultImg      = img;
      defaultIsStatic = true;
      showStaticDefault();
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

async function loadDefaultContent() {
  // 1. Try animated GIF
  const data = await fetchAndDecodeGIF('/gif/default.gif', 'default');
  if (data) { switchMainGIF('default'); return; }

  // 2. Try static image formats
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    if (await tryLoadStaticImage(`/gif/default.${ext}`)) return;
  }

  // 3. Nothing found — show placeholder
  gifPlaceholder.classList.remove('hidden');
  gifCanvas.style.display = 'none';
}

// Load default on page load; silently pre-cache tier GIFs in background
function preloadTierGifs() {
  for (const t of tierConfig) {
    const k = String(t.tier);
    fetchAndDecodeGIF(`/gif/tier${k}.gif`, `tier${k}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// SECTION 2 – Jackpot overlay
// ══════════════════════════════════════════════════════════════════

let jackpotActive = false;

async function showJackpotOverlay() {
  if (jackpotActive) return;
  jackpotActive = true;

  jackpotOverlay.classList.add('active');

  // Load jackpot.gif if not yet cached
  if (!jackpotGifLoaded) {
    const data = await fetchAndDecodeGIF('/gif/jackpot.gif', 'jackpot');
    if (data) {
      jackpotFrames       = data.frames;
      jackpotCanvas.width  = data.width;
      jackpotCanvas.height = data.height;
      jackpotGifLoaded    = true;
      animateJackpotGIF();
    } else {
      jackpotCanvas.style.display = 'none'; // no jackpot.gif — show title only
    }
  } else if (jackpotGifLoaded) {
    jackpotIndex = 0;
    animateJackpotGIF();
  }

  spawnConfetti(500);

  setTimeout(hideJackpotOverlay, appConfig.jackpot.autoDismissMs);
}

function animateJackpotGIF() {
  if (!jackpotActive || jackpotFrames.length === 0) return;

  const frame = jackpotFrames[jackpotIndex];
  const imageData = frame.imageData;

  if (jackpotIndex > 0) {
    const prev = jackpotFrames[jackpotIndex - 1];
    if (prev.disposal === 2) {
      jackpotCtx.clearRect(prev.x, prev.y, prev.dims.width, prev.dims.height);
    }
  }
  jackpotCtx.putImageData(imageData, frame.x, frame.y);
  jackpotIndex = (jackpotIndex + 1) % jackpotFrames.length;

  const speed = Math.max(0.1, appConfig.display.gifSpeed * gifSpeedMult);
  jackpotTimeout = setTimeout(animateJackpotGIF, Math.max(16, frame.delay / speed));
}

function hideJackpotOverlay() {
  if (!jackpotActive) return;
  jackpotActive = false;
  jackpotOverlay.classList.remove('active');
  if (jackpotTimeout) clearTimeout(jackpotTimeout);
  // Return to default image
  switchToDefault();
}

// ESC or tap the overlay to dismiss
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideJackpotOverlay();
  if (e.key.toLowerCase && e.key.toLowerCase() === 'a') {
    const active = document.activeElement;
    const isControlFocused =
      active instanceof HTMLElement &&
      (
        active.matches('input, textarea, select, button, [contenteditable=""], [contenteditable="true"], [role="textbox"]') ||
        !!active.closest('#admin-panel')
      );
    if (isControlFocused) return;
    adminPanel.classList.toggle('visible');
    if (adminPanel.classList.contains('visible')) {
      adminLoadConfig();
    }
  }
});
jackpotOverlay.addEventListener('click', hideJackpotOverlay);

// ══════════════════════════════════════════════════════════════════
// SECTION 3 – Recent donors list
// ══════════════════════════════════════════════════════════════════

function addToDonorsList(amount) {
  recentDonors.unshift(amount);
  if (recentDonors.length > appConfig.display.maxRecentDonors) {
    recentDonors.length = appConfig.display.maxRecentDonors;
  }
  renderDonorsList();
}

function renderDonorsList() {
  donorsListEl.innerHTML = '';
  recentDonors.forEach((amount) => {
    const el = document.createElement('div');
    el.className = 'donor-entry';
    el.innerHTML = `<span class="donor-amount">${formatCurrency(amount)}</span>`;
    donorsListEl.appendChild(el);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setAdminStatus(message, isError = false) {
  if (!adminStatusEl) return;
  adminStatusEl.textContent = message;
  adminStatusEl.style.color = isError ? '#fca5a5' : '#bbf7d0';
}

function applyConfigToUI() {
  document.title = `${appConfig.campaign.organization} - Fundraiser`;
  campaignTitleEl.textContent = appConfig.campaign.title;
  orgBadgeEl.textContent = appConfig.campaign.organization;
  donateBtnEl.href = appConfig.campaign.donateUrl;
  donateBtnEl.textContent = appConfig.campaign.donateButtonText;
  bannerLabelEl.textContent = appConfig.donationExperience.bannerLabel;
  jackpotTitleEl.textContent = appConfig.jackpot.overlayTitle;
  jackpotSubEl.textContent = appConfig.jackpot.overlaySubtitle;
  jackpotDismissEl.textContent = appConfig.jackpot.overlayDismissText;
  qrLabelEls.forEach((el) => { el.textContent = appConfig.campaign.qrLabel; });
  const qrSrc = `${appConfig.assets.qrImage || '/qr.png'}?v=${mediaVersion}`;
  qrImageEls.forEach((img) => { img.src = qrSrc; });
}

function resetDefaultMediaCache() {
  gifCache.default = undefined;
  defaultImg = null;
  defaultIsStatic = false;
}

function refreshCurrencyFormatters() {
  try {
    currencyFormatter = new Intl.NumberFormat(appConfig.campaign.locale, {
      style: 'currency',
      currency: appConfig.campaign.currency,
      maximumFractionDigits: 0,
    });
    smallCurrencyFormatter = new Intl.NumberFormat(appConfig.campaign.locale, {
      style: 'currency',
      currency: appConfig.campaign.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch (_) {
    currencyFormatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
    smallCurrencyFormatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
}

async function fetchPublicConfig() {
  try {
    const r = await fetch('/api/public-config');
    const d = await r.json();
    appConfig = mergeConfig(APP_DEFAULTS, d || {});
  } catch (_) {
    appConfig = JSON.parse(JSON.stringify(APP_DEFAULTS));
  }

  currentGoal = appConfig.campaign.goal;
  jackpotHint = appConfig.jackpot.hintLabel;
  refreshCurrencyFormatters();
  applyConfigToUI();
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

function renderFriendlyTierRows(tiers) {
  if (!tiersEditorEl) return;
  tiersEditorEl.innerHTML = '';
  const sorted = [...(tiers || [])].sort((a, b) => Number(b.min) - Number(a.min));

  sorted.forEach((tier) => {
    const row = document.createElement('div');
    row.className = 'tier-edit-row';
    row.innerHTML =
      `<input type="number" step="0.01" min="0" class="tier-min" placeholder="Min amount" value="${Number(tier.min)}" />` +
      `<input type="text" class="tier-label" placeholder="Label shown (e.g. $10-$19)" value="${String(tier.label || '')}" />` +
      `<input type="text" class="tier-key" placeholder="Tier key (e.g. 1point5)" value="${String(tier.tier || '')}" />` +
      `<button type="button" class="tier-remove">Remove</button>`;
    row.querySelector('.tier-remove').addEventListener('click', () => row.remove());
    tiersEditorEl.appendChild(row);
  });
}

function collectFriendlyTierRows() {
  const rows = Array.from(tiersEditorEl?.querySelectorAll('.tier-edit-row') || []);
  const tiers = rows.map((row) => {
    const min = parseFloat(row.querySelector('.tier-min').value);
    const label = row.querySelector('.tier-label').value.trim();
    const tier = row.querySelector('.tier-key').value.trim();
    return { min, label, tier };
  }).filter((t) => Number.isFinite(t.min) && t.tier);

  return tiers.sort((a, b) => b.min - a.min);
}

function populateFriendlyConfigForm(config) {
  if (!config) return;
  if (cfgTitleEl) cfgTitleEl.value = config.campaign?.title || '';
  if (cfgOrgEl) cfgOrgEl.value = config.campaign?.organization || '';
  if (cfgDonateUrlEl) cfgDonateUrlEl.value = config.campaign?.donateUrl || '';
  if (cfgButtonTextEl) cfgButtonTextEl.value = config.campaign?.donateButtonText || '';
  if (cfgQrLabelEl) cfgQrLabelEl.value = config.campaign?.qrLabel || '';
  if (cfgGoalDefaultEl) cfgGoalDefaultEl.value = String(config.campaign?.goal ?? '');
  if (cfgCurrencyEl) cfgCurrencyEl.value = config.campaign?.currency || '';
  if (cfgLocaleEl) cfgLocaleEl.value = config.campaign?.locale || '';
  if (cfgJackpotHintEl) cfgJackpotHintEl.value = config.jackpot?.hintLabel || '';
  renderFriendlyTierRows(config.tiers || []);
  if (tierMediaKeyEl && !tierMediaKeyEl.value && Array.isArray(config.tiers) && config.tiers.length) {
    tierMediaKeyEl.value = String(config.tiers[config.tiers.length - 1].tier);
  }
}

async function adminSaveFriendlyConfig() {
  const tiers = collectFriendlyTierRows();

  const payload = {
    campaign: {
      title: cfgTitleEl?.value?.trim(),
      organization: cfgOrgEl?.value?.trim(),
      donateUrl: cfgDonateUrlEl?.value?.trim(),
      donateButtonText: cfgButtonTextEl?.value?.trim(),
      qrLabel: cfgQrLabelEl?.value?.trim(),
      goal: parseFloat(cfgGoalDefaultEl?.value || ''),
      currency: cfgCurrencyEl?.value?.trim(),
      locale: cfgLocaleEl?.value?.trim(),
    },
    jackpot: {
      hintLabel: cfgJackpotHintEl?.value?.trim(),
    },
  };
  if (tiers.length) payload.tiers = tiers;

  try {
    setAdminStatus('Saving settings…');
    const r = await fetch('/api/admin/config?syncGoal=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.status === 404) {
      setAdminStatus('Server is running an old build. Restart server to enable live admin features.', true);
      return;
    }
    const d = await parseJsonSafe(r);
    if (!r.ok || d?.error) throw new Error(d?.error || 'Failed to save settings');

    adminFullConfig = d.config;
    if (configJsonEl) configJsonEl.value = JSON.stringify(d.config, null, 2);
    populateFriendlyConfigForm(d.config);
    await fetchPublicConfig();
    await fetchTierConfig();
    setAdminStatus('Settings saved live');
  } catch (err) {
    setAdminStatus(`Save failed: ${err.message}`, true);
  }
}

function adminAddTierRow() {
  const tiers = collectFriendlyTierRows();
  tiers.push({ min: 1, label: '$1+', tier: `custom${tiers.length + 1}` });
  renderFriendlyTierRows(tiers);
}

async function adminLoadConfig() {
  try {
    const r = await fetch('/api/admin/config');
    if (r.status === 404) {
      setAdminStatus('Server is running an old build. Restart server to enable live admin features.', true);
      return;
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
    const d = await parseJsonSafe(r);
    if (!d) throw new Error('Invalid server response');
    adminFullConfig = d;
    if (configJsonEl) configJsonEl.value = JSON.stringify(d, null, 2);
    populateFriendlyConfigForm(d);
    setAdminStatus('Config loaded');
  } catch (err) {
    setAdminStatus(`Load failed: ${err.message}`, true);
  }
}

async function adminSaveConfig() {
  if (!configJsonEl) return;
  let payload;
  try {
    payload = JSON.parse(configJsonEl.value);
  } catch (err) {
    setAdminStatus(`Invalid JSON: ${err.message}`, true);
    return;
  }

  try {
    setAdminStatus('Saving config…');
    const r = await fetch('/api/admin/config?syncGoal=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.status === 404) {
      setAdminStatus('Server is running an old build. Restart server to enable live admin features.', true);
      return;
    }
    const d = await parseJsonSafe(r);
    if (!r.ok || d?.error) throw new Error(d?.error || 'Failed to save config');
    if (!d || !d.config) throw new Error('Invalid server response');

    adminFullConfig = d.config;
    configJsonEl.value = JSON.stringify(d.config, null, 2);
    populateFriendlyConfigForm(d.config);
    await fetchPublicConfig();
    await fetchTierConfig();
    setAdminStatus('Config saved live');
  } catch (err) {
    setAdminStatus(`Save failed: ${err.message}`, true);
  }
}

async function adminUploadAsset(target, file, clearInput) {
  if (!file) {
    setAdminStatus('Pick an image/GIF first', true);
    return;
  }
  if (!file.type.startsWith('image/')) {
    setAdminStatus('Only image files are allowed', true);
    return;
  }

  try {
    setAdminStatus('Uploading media…');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('target', target);

    const r = await fetch('/api/admin/upload-asset', {
      method: 'POST',
      body: formData,
    });

    if (r.status === 404) {
      setAdminStatus('Server is running an old build. Restart server to enable live admin features.', true);
      return;
    }

    const d = await parseJsonSafe(r);
    if (!r.ok) {
      if (r.status === 413 || d?.code === 'LIMIT_FILE_SIZE') {
        setAdminStatus('File too large. Max 25 MB.', true);
        return;
      }
      if (d?.code === 'UNSUPPORTED_MEDIA_TYPE') {
        setAdminStatus('Unsupported file type. Use PNG, JPG, WEBP, GIF, AVIF, or BMP.', true);
        return;
      }
      throw new Error(d?.error || `Upload failed (HTTP ${r.status})`);
    }

    resetDefaultMediaCache();
    if (target === 'default' && (!activeTierFile || activeTierFile === 'default')) {
      await loadDefaultContent();
    }
    if (target === 'jackpot') {
      jackpotGifLoaded = false;
      jackpotFrames = [];
      jackpotCanvas.style.display = '';
    }
    if (target === 'qr') {
      mediaVersion = Date.now();
      await fetchPublicConfig();
    }
    if (target.startsWith('tier:')) {
      const tierKey = target.slice(5);
      delete gifCache[`tier${tierKey}`];
      delete tierStaticCache[`tier${tierKey}`];
    }
    if (clearInput) clearInput.value = '';
    setAdminStatus(`Upload complete: ${d.file}`);
  } catch (err) {
    setAdminStatus(`Upload failed: ${err.message}`, true);
  }
}

async function adminUploadDefaultMedia() {
  const file = defaultMediaInputEl?.files?.[0];
  return adminUploadAsset('default', file, defaultMediaInputEl);
}

async function adminUploadQrMedia() {
  const file = qrMediaInputEl?.files?.[0];
  return adminUploadAsset('qr', file, qrMediaInputEl);
}

async function adminUploadJackpotMedia() {
  const file = jackpotMediaInputEl?.files?.[0];
  return adminUploadAsset('jackpot', file, jackpotMediaInputEl);
}

async function adminUploadTierMedia() {
  const tierKey = tierMediaKeyEl?.value?.trim();
  const file = tierMediaInputEl?.files?.[0];
  if (!tierKey) {
    setAdminStatus('Enter tier key first (example: 1point5).', true);
    return;
  }
  return adminUploadAsset(`tier:${tierKey}`, file, tierMediaInputEl);
}

async function fetchTierConfig() {
  try {
    const r = await fetch('/api/tiers');
    const d = await r.json();
    tierConfig  = d.tiers;
    jackpotHint = d.jackpotHint || appConfig.jackpot.hintLabel;
    renderTierStrip();
  } catch (_) {}
}

function renderTierStrip() {
  const strip = document.getElementById('tier-strip');
  if (!strip || !tierConfig.length) return;
  strip.innerHTML = '';

  // tierConfig arrives ascending (cheapest first)
  for (const t of tierConfig) {
    const card = document.createElement('div');
    card.className = 'tier-card';
    card.dataset.tier = String(t.tier);
    card.innerHTML =
      `<div class="tier-card-price">${t.label}</div>` +
      `<div class="tier-card-icon">${t.emoji || '🎁'}</div>` +
      `<div class="tier-card-mystery">${escapeHtml((t.name || 'Tier').slice(0, 12))}</div>` +
      `<div class="tier-card-reveal">REVEALED!</div>`;
    strip.appendChild(card);
  }

  // Secret prize card
  const secret = document.createElement('div');
  secret.className = 'tier-card tier-card--secret';
  secret.dataset.tier = 'jackpot';
  secret.innerHTML =
    `<div class="tier-card-price">${jackpotHint}</div>` +
    `<div class="tier-card-icon">🔮</div>` +
    `<div class="tier-card-mystery">SECRET</div>` +
    `<div class="tier-card-reveal">MASHA'ALLAH!</div>`;
  strip.appendChild(secret);
}

function highlightTierCard(tierKey, isJackpot = false) {
  const strip = document.getElementById('tier-strip');
  if (!strip) return;
  const key  = isJackpot ? 'jackpot' : String(tierKey);
  const card = strip.querySelector(`[data-tier="${key}"]`);
  if (!card) return;

  // Remove from any previously active card
  strip.querySelectorAll('.tier-card--active').forEach(c => c.classList.remove('tier-card--active'));

  card.classList.add('tier-card--active');
  setTimeout(() => card.classList.remove('tier-card--active'), 5000);
}

// ══════════════════════════════════════════════════════════════════
// SECTION 4 – Confetti
// ══════════════════════════════════════════════════════════════════

let confParticles = [];
let confAnimId    = null;

// MSA green + white confetti
const COLORS = ['#16a34a','#22c55e','#ffffff','#4ade80','#bbf7d0','#86efac','#f0fdf4'];

function spawnConfetti(count = 120) {
  confCanvas.width  = window.innerWidth;
  confCanvas.height = window.innerHeight;

  for (let i = 0; i < count; i++) {
    confParticles.push({
      x:     Math.random() * confCanvas.width,
      y:     Math.random() * -confCanvas.height * 0.5,
      vx:    (Math.random() - 0.5) * 4,
      vy:    2 + Math.random() * 4,
      w:     6 + Math.random() * 8,
      h:     3 + Math.random() * 5,
      angle: Math.random() * Math.PI * 2,
      spin:  (Math.random() - 0.5) * 0.2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: 1,
    });
  }

  if (!confAnimId) animateConfetti();
}

function animateConfetti() {
  confCtx.clearRect(0, 0, confCanvas.width, confCanvas.height);
  confParticles = confParticles.filter((p) => p.alpha > 0.02);

  for (const p of confParticles) {
    p.x     += p.vx;
    p.y     += p.vy;
    p.angle += p.spin;
    p.vy    += 0.08;
    if (p.y > confCanvas.height * 0.7) p.alpha -= 0.02;

    confCtx.save();
    confCtx.translate(p.x, p.y);
    confCtx.rotate(p.angle);
    confCtx.globalAlpha = p.alpha;
    confCtx.fillStyle   = p.color;
    confCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    confCtx.restore();
  }

  confAnimId = confParticles.length > 0
    ? requestAnimationFrame(animateConfetti)
    : (confCtx.clearRect(0, 0, confCanvas.width, confCanvas.height), null);
}

// ══════════════════════════════════════════════════════════════════
// SECTION 5 – Star background
// ══════════════════════════════════════════════════════════════════

// 80% white stars, 20% MSA green
const STAR_COLORS = [
  'rgba(255,255,255,ALPHA)','rgba(255,255,255,ALPHA)','rgba(255,255,255,ALPHA)',
  'rgba(255,255,255,ALPHA)','rgba(255,255,255,ALPHA)','rgba(255,255,255,ALPHA)',
  'rgba(255,255,255,ALPHA)','rgba(255,255,255,ALPHA)',
  'rgba(22,163,74,ALPHA)',  // MSA green
  'rgba(34,197,94,ALPHA)',  // MSA green (lighter)
];

const stars = Array.from({ length: 120 }, () => ({
  x:     Math.random(),
  y:     Math.random(),
  r:     0.4 + Math.random() * 1.4,
  a:     Math.random(),
  da:    0.003 + Math.random() * 0.006,
  color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
}));

function drawStars() {
  bgCanvas.width  = window.innerWidth;
  bgCanvas.height = window.innerHeight;
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

  // Dark MSA background — near-black with a faint green tint at the edges
  const grad = bgCtx.createRadialGradient(
    bgCanvas.width * 0.5, bgCanvas.height * 0.5, 0,
    bgCanvas.width * 0.5, bgCanvas.height * 0.5, bgCanvas.width * 0.7
  );
  grad.addColorStop(0,   '#0a1a0e');
  grad.addColorStop(0.6, '#080e09');
  grad.addColorStop(1,   '#060c07');
  bgCtx.fillStyle = grad;
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);

  for (const s of stars) {
    s.a += s.da;
    if (s.a > 1 || s.a < 0) s.da *= -1;
    bgCtx.beginPath();
    bgCtx.arc(s.x * bgCanvas.width, s.y * bgCanvas.height, s.r, 0, Math.PI * 2);
    bgCtx.fillStyle = s.color.replace('ALPHA', s.a.toFixed(2));
    bgCtx.fill();
  }

  requestAnimationFrame(drawStars);
}

drawStars();
window.addEventListener('resize', () => {
  bgCanvas.width  = window.innerWidth;
  bgCanvas.height = window.innerHeight;
});

// ══════════════════════════════════════════════════════════════════
// SECTION 6 – Animated money counter
// ══════════════════════════════════════════════════════════════════

function formatCurrency(n) {
  return currencyFormatter.format(Math.round(n));
}

function formatCurrencyExact(n) {
  return smallCurrencyFormatter.format(n);
}

function animateCounter(element, from, to, duration = 1200) {
  const start = performance.now();
  function tick(now) {
    const t     = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    element.textContent = formatCurrency(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
    else element.textContent = formatCurrency(to);
  }
  requestAnimationFrame(tick);
}

function updateStats({ raised, goal, donors }) {
  const prevRaised = currentRaised;
  if (raised  != null) currentRaised = raised;
  if (goal    != null) currentGoal   = goal;
  if (donors  != null) currentDonors = donors;

  animateCounter(raisedEl, prevRaised, currentRaised);
  goalEl.textContent   = formatCurrency(currentGoal);
  donorsEl.textContent = currentDonors.toLocaleString('en-US');

  const pct = currentGoal > 0 ? Math.min(100, (currentRaised / currentGoal) * 100) : 0;
  progressFill.style.width = pct.toFixed(1) + '%';
  progressPct.textContent  = pct.toFixed(0) + '%';
}

// ══════════════════════════════════════════════════════════════════
// SECTION 7 – Donation event handler
// ══════════════════════════════════════════════════════════════════

let bannerTimeout = null;

function onDonation({ amount, total, goal, donors, tier = 1, jackpot = false }) {
  console.log(`💰 $${amount.toFixed(2)} — tier ${tier}${jackpot ? ' 🏆 JACKPOT' : ''}`);

  // 1. Update stats with animated counter
  updateStats({ raised: total, goal, donors });

  // 2. Pulse the raised amount
  raisedEl.classList.remove('pulsing');
  void raisedEl.offsetWidth;
  raisedEl.classList.add('pulsing');
  setTimeout(() => raisedEl.classList.remove('pulsing'), 700);

  // 3. Donation banner
  bannerAmt.textContent = '+' + formatCurrencyExact(amount);
  bannerEl.classList.add('active');
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => bannerEl.classList.remove('active'), appConfig.donationExperience.bannerDurationMs);

  // 3b. Add to recent donors list
  addToDonorsList(amount);

  // 4. Highlight the mystery box and switch to the tier GIF
  highlightTierCard(tier, jackpot);
  loadGIFForTier(tier);

  // 5. Confetti burst (more for bigger donations)
  spawnConfetti(Math.min(300, 60 + Math.floor(amount / 2)));
  burstThenDecay(donationToSpeed(amount));

  // 6. Schedule return to default after the excitement fades
  //    Jackpot gets extra time to outlast auto-dismiss
  scheduleReturnToDefault(
    jackpot ? appConfig.donationExperience.jackpotReturnToDefaultMs : appConfig.donationExperience.returnToDefaultMs
  );

  // 7. Jackpot overlay (after a short delay so the banner is visible first)
  if (jackpot) {
    setTimeout(showJackpotOverlay, appConfig.donationExperience.jackpotDelayMs);
  }
}

// ══════════════════════════════════════════════════════════════════
// SECTION 8 – WebSocket connection
// ══════════════════════════════════════════════════════════════════

let ws;
let wsReconnectDelay = 2000;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    connStatus.textContent = '● Connected';
    connStatus.style.color = '#16a34a';
    wsReconnectDelay = 2000;
    fetchTierConfig(); // load tiers on (re)connect
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (_) { return; }

    if (msg.type === 'init' || msg.type === 'update') {
      updateStats(msg);
    } else if (msg.type === 'donation') {
      onDonation(msg);
    } else if (msg.type === 'config-updated') {
      fetchPublicConfig().then(fetchTierConfig);
      adminLoadConfig();
    } else if (msg.type === 'media-updated') {
      mediaVersion = msg.version || Date.now();
      if (msg.target === 'default') {
        resetDefaultMediaCache();
        if (!activeTierFile || activeTierFile === 'default') loadDefaultContent();
      } else if (msg.target === 'qr') {
        fetchPublicConfig();
      } else if (msg.target === 'jackpot') {
        jackpotGifLoaded = false;
        jackpotFrames = [];
      } else if (String(msg.target || '').startsWith('tier:')) {
        const tierKey = String(msg.target).slice(5);
        delete gifCache[`tier${tierKey}`];
        delete tierStaticCache[`tier${tierKey}`];
      }
    } else if (msg.type === 'status') {
      connStatus.textContent = '● ' + (msg.message || 'Live');
    }
  };

  ws.onclose = () => {
    connStatus.textContent = '● Reconnecting…';
    connStatus.style.color = '#facc15';
    setTimeout(connectWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
  };

  ws.onerror = () => ws.close();
}

async function pollStatusFallback() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    updateStats(d);
  } catch (_) {}
}

async function initApp() {
  await fetchPublicConfig();
  await fetchTierConfig();
  await adminLoadConfig();
  updateStats({ goal: appConfig.campaign.goal, raised: 0, donors: 0 });
  await loadDefaultContent();
  setTimeout(preloadTierGifs, appConfig.display.tierPreloadDelayMs);
  connectWS();
  setInterval(pollStatusFallback, appConfig.display.pollingIntervalMs);
}

initApp();

// ══════════════════════════════════════════════════════════════════
// SECTION 9 – Admin panel helpers
// ══════════════════════════════════════════════════════════════════

async function adminReset() {
  if (!confirm('Reset all donations to zero?')) return;
  try {
    await fetch('/api/reset', { method: 'POST' });
    recentDonors.length = 0;
    renderDonorsList();
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

async function adminSetState() {
  const raised = parseFloat(document.getElementById('set-raised').value);
  if (isNaN(raised) || raised < 0) return alert('Enter a valid amount');
  try {
    await fetch('/api/set-state', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ raised }),
    });
    document.getElementById('set-raised').value = '';
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

async function adminSetGoal() {
  const goal = parseFloat(document.getElementById('set-goal').value);
  if (!goal || goal <= 0) return alert('Enter a valid goal');
  try {
    await fetch('/api/set-state', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ goal }),
    });
    document.getElementById('set-goal').value = '';
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

async function manualDonation() {
  const amount = parseFloat(document.getElementById('manual-amount').value);
  if (!amount || amount <= 0) return alert('Enter a valid amount');

  try {
    const r = await fetch('/api/manual-donation', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ amount }),
    });
    const d = await r.json();
    if (!d.success) alert('Error: ' + (d.error || 'unknown'));

    // Fallback: if WS is disconnected, trigger the same UI event from HTTP response.
    if ((!ws || ws.readyState !== WebSocket.OPEN) && d.event) {
      onDonation(d.event);
    }

    document.getElementById('manual-amount').value = '';
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

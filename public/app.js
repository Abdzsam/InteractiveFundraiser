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

// ── GIF playback speed ─────────────────────────────────────────
// Increase to play faster (2 = twice as fast, 3 = three times, etc.)
const GIF_SPEED = 7;

// ── App state ───────────────────────────────────────────────────
let currentRaised = 0;
let currentGoal   = 10000;
let currentDonors = 0;
let tierConfig    = [];   // populated from /api/tiers
let jackpotHint   = '$29–$59';
let recentDonors  = [];   // [amount] newest first, max 5

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
    gifNextFrameAt = now + frame.delay / GIF_SPEED;
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
loadDefaultContent();
setTimeout(() => {
  for (const k of ['1', '1point5', '2', '2point5', '3', '4', '5']) {
    fetchAndDecodeGIF(`/gif/tier${k}.gif`, `tier${k}`);
  }
}, 3000);

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

  // Auto-dismiss after 15 s
  setTimeout(hideJackpotOverlay, 15000);
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

  jackpotTimeout = setTimeout(animateJackpotGIF, Math.max(16, frame.delay / GIF_SPEED));
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
  if (e.key === 'a' || e.key === 'A') adminPanel.classList.toggle('visible');
});
jackpotOverlay.addEventListener('click', hideJackpotOverlay);

// ══════════════════════════════════════════════════════════════════
// SECTION 3 – Recent donors list
// ══════════════════════════════════════════════════════════════════

function addToDonorsList(amount) {
  recentDonors.unshift(amount);
  if (recentDonors.length > 5) recentDonors.length = 5;
  renderDonorsList();
}

function renderDonorsList() {
  donorsListEl.innerHTML = '';
  recentDonors.forEach((amount) => {
    const el = document.createElement('div');
    el.className = 'donor-entry';
    el.innerHTML = `<span class="donor-amount">${formatUSD(amount)}</span>`;
    donorsListEl.appendChild(el);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function fetchTierConfig() {
  try {
    const r = await fetch('/api/tiers');
    const d = await r.json();
    tierConfig  = d.tiers;
    jackpotHint = d.jackpotHint;
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
      `<div class="tier-card-icon">🎁</div>` +
      `<div class="tier-card-mystery">??? meme</div>` +
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

function formatUSD(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function animateCounter(element, from, to, duration = 1200) {
  const start = performance.now();
  function tick(now) {
    const t     = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    element.textContent = formatUSD(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
    else element.textContent = formatUSD(to);
  }
  requestAnimationFrame(tick);
}

function updateStats({ raised, goal, donors }) {
  const prevRaised = currentRaised;
  if (raised  != null) currentRaised = raised;
  if (goal    != null) currentGoal   = goal;
  if (donors  != null) currentDonors = donors;

  animateCounter(raisedEl, prevRaised, currentRaised);
  goalEl.textContent   = formatUSD(currentGoal);
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
  bannerAmt.textContent = '+' + formatUSD(amount);
  bannerEl.classList.add('active');
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => bannerEl.classList.remove('active'), 6000);

  // 3b. Add to recent donors list
  addToDonorsList(amount);

  // 4. Highlight the mystery box and switch to the tier GIF
  highlightTierCard(tier, jackpot);
  loadGIFForTier(tier);

  // 5. Confetti burst (more for bigger donations)
  spawnConfetti(Math.min(300, 60 + Math.floor(amount / 2)));

  // 6. Schedule return to default after the excitement fades
  //    Jackpot gets extra time (17 s) to outlast the 15 s auto-dismiss
  scheduleReturnToDefault(jackpot ? 17000 : 13000);

  // 7. Jackpot overlay (after a short delay so the banner is visible first)
  if (jackpot) {
    setTimeout(showJackpotOverlay, 800);
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

connectWS();

// Polling fallback if WebSocket is down
setInterval(async () => {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    updateStats(d);
  } catch (_) {}
}, 30000);

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
    document.getElementById('manual-amount').value = '';
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

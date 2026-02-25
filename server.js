const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const path     = require('path');
const fs       = require('fs');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, 'campaign-state.json');

// ★ CHANGE THIS before your event — keep it secret from the audience!
const JACKPOT_AMOUNT = 24; // someone donating exactly $24 CAD wins the prize

// Donation tiers (sorted descending — first match wins)
// Each tier maps to public/gif/tier{name}.{gif|png|jpg|…}
const TIERS = [
  { min: 40, tier: '5',       label: '$40+',    emoji: '👑', name: 'LEGENDARY' },
  { min: 30, tier: '4',       label: '$30–$39', emoji: '🔥', name: 'EPIC'      },
  { min: 20, tier: '3',       label: '$20–$29', emoji: '⚡', name: 'GREAT'     },
  { min: 15, tier: '2point5', label: '$15–$19', emoji: '💫', name: 'AWESOME'   },
  { min: 10, tier: '2',       label: '$10–$14', emoji: '✨', name: 'GOOD'      },
  { min:  5, tier: '1point5', label: '$5–$9',   emoji: '🎊', name: 'NICE'      },
  { min:  1, tier: '1',       label: '$1–$4',   emoji: '🎉', name: 'THANKS'    },
];

function getTier(amount) {
  for (const t of TIERS) {
    if (amount >= t.min) return t.tier;
  }
  return 1;
}

function isJackpot(amount) {
  return Math.abs(amount - JACKPOT_AMOUNT) < 0.5;
}

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  raised: 0,
  goal: 5000,   // CAD
  donors: 0,
  lastDonation: 0,
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = { ...state, ...saved, goal: 5000 }; // always enforce goal
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

app.get('/api/tiers', (_req, res) => {
  res.json({
    tiers:       [...TIERS].reverse(),
    jackpotHint: '$19–$39',
  });
});

// Manual donation entry — used at the event desk
app.post('/api/manual-donation', (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const jackpotHit       = isJackpot(amount);
  state.raised           = (state.raised  || 0) + amount;
  state.lastDonation     = amount;
  state.donors           = (state.donors  || 0) + 1;
  saveState();

  console.log(`🎉 $${amount.toFixed(2)} — tier ${getTier(amount)}${jackpotHit ? ' 🏆 JACKPOT!' : ''} | total $${state.raised.toFixed(2)}`);

  broadcast({
    type:    'donation',
    amount,
    total:   state.raised,
    goal:    state.goal,
    donors:  state.donors,
    tier:    getTier(amount),
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
  if (goal   !== undefined) state.goal   = Math.max(1, parseFloat(goal)   || state.goal);
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
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    (async () => {
      console.log('\n──────────────────────────────────────────────────');
      console.log('  Starting state (press Enter to keep saved value)');
      console.log('──────────────────────────────────────────────────');

      const rAns = await ask(`  Raised so far (CAD) [${state.raised}]: `);
      if (rAns.trim()) {
        const v = parseFloat(rAns);
        if (!isNaN(v) && v >= 0) state.raised = v;
      }

      const dAns = await ask(`  Donor count         [${state.donors}]: `);
      if (dAns.trim()) {
        const v = parseInt(dAns);
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

askStartingState().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Fundraiser display → http://localhost:${PORT}`);
    console.log(`🏆 Jackpot: $${JACKPOT_AMOUNT} CAD (secret — hint shown is $19–$39)`);
    console.log(`🎯 Goal: $${state.goal} CAD | Raised: $${state.raised} | Donors: ${state.donors}\n`);
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down…');
  process.exit(0);
});

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const USERS_FILE = './users.json';
const lobbies = new Map();

// --- JSON-DATEI FÜR ACCOUNTS LADEN & SPEICHERN ---
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error("Fehler beim Laden von users.json:", e);
  }
  return {};
}

function saveUsers(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Fehler beim Speichern von users.json:", e);
  }
}

let dbUsers = loadUsers();

// Standard-Node.js crypto: Keine zusätzlichen npm-Pakete nötig!
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_foodmatch_salt_2026').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const activeTokens = new Map();

// --- AUTH ROUTEN (REGISTRIEREN, LOGIN, AUTO-LOGIN) ---

// 1. Registrieren
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Name und Passwort (mind. 4 Zeichen) eingeben.' });
  }

  const cleanName = username.trim();
  const key = cleanName.toLowerCase();

  if (dbUsers[key]) {
    return res.status(400).json({ error: 'Dieser Name ist bereits vergeben.' });
  }

  const newUser = {
    username: cleanName,
    passwordHash: hashPassword(password),
    friends: [],
    createdAt: new Date().toISOString()
  };

  dbUsers[key] = newUser;
  saveUsers(dbUsers);

  const token = generateToken();
  activeTokens.set(token, cleanName);

  res.json({ success: true, token, user: { username: cleanName, friends: [] } });
});

// 2. Anmelden
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Name und Passwort eingeben.' });
  }

  const key = username.trim().toLowerCase();
  const user = dbUsers[key];

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Ungültiger Name oder falsches Passwort.' });
  }

  const token = generateToken();
  activeTokens.set(token, user.username);

  res.json({ success: true, token, user: { username: user.username, friends: user.friends || [] } });
});

// 3. Auto-Login
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Kein Token' });

  const token = authHeader.replace('Bearer ', '').trim();
  const username = activeTokens.get(token);

  if (!username) {
    return res.status(401).json({ error: 'Sitzung abgelaufen' });
  }

  const key = username.toLowerCase();
  const user = dbUsers[key];
  if (!user) {
    return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  }

  res.json({ user: { username: user.username, friends: user.friends || [] } });
});

// --- USER SYNC & FREUNDE ---
app.post('/api/user/sync', (req, res) => {
  const { userName = 'Gast' } = req.body;
  const key = userName.toLowerCase();

  if (!dbUsers[key]) {
    dbUsers[key] = { username: userName, passwordHash: null, friends: [], activeInvite: null };
    saveUsers(dbUsers);
  }

  res.json({ user: dbUsers[key] });
});

app.get('/api/user/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const me = (req.query.me || '').toLowerCase();
  const matched = [];

  for (const [key, user] of Object.entries(dbUsers)) {
    if (key !== me && key.includes(q)) {
      matched.push(user.username);
    }
  }
  res.json({ users: matched.slice(0, 5) });
});

app.post('/api/user/add-friend', (req, res) => {
  const { userName, friendName } = req.body;
  const myKey = (userName || '').toLowerCase();

  const me = dbUsers[myKey];
  if (me && !me.friends.includes(friendName)) {
    me.friends.push(friendName);
    saveUsers(dbUsers);
  }

  res.json({ success: true, friends: me ? me.friends : [] });
});

// --- LOBBYS & AKINATOR ---
app.post('/api/lobby/create', (req, res) => {
  const { hostName, lat, lon, radiusKm = 5 } = req.body;
  const code = Math.floor(1000 + Math.random() * 9000).toString();

  const lobby = {
    code,
    hostName,
    lat,
    lon,
    radiusKm,
    participants: [{ name: hostName, ready: false, answers: [] }],
    status: 'waiting'
  };

  lobbies.set(code, lobby);
  res.json({ success: true, code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
  const { code, userName } = req.body;
  const lobby = lobbies.get(code);
  if (!lobby) return res.status(404).json({ error: 'Lobby nicht gefunden.' });

  if (!lobby.participants.find(p => p.name === userName)) {
    lobby.participants.push({ name: userName, ready: false, answers: [] });
  }
  res.json({ success: true, lobby });
});

app.get('/api/lobby/status/:code', (req, res) => {
  const lobby = lobbies.get(req.params.code);
  if (!lobby) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ lobby });
});

app.post('/api/lobby/start', (req, res) => {
  const lobby = lobbies.get(req.body.code);
  if (lobby) lobby.status = 'playing';
  res.json({ success: true });
});

app.post('/api/lobby/invite', (req, res) => {
  const friendKey = (req.body.friendName || '').toLowerCase();
  const f = dbUsers[friendKey];
  if (f) {
    f.activeInvite = { hostName: req.body.hostName, lobbyCode: req.body.lobbyCode, timestamp: Date.now() };
    saveUsers(dbUsers);
  }
  res.json({ success: true });
});

app.post('/api/lobby/respond-invite', (req, res) => {
  const myKey = (req.body.userName || '').toLowerCase();
  const u = dbUsers[myKey];
  if (!u || !u.activeInvite) return res.json({ accepted: false });

  const inv = u.activeInvite;
  u.activeInvite = null;
  saveUsers(dbUsers);

  const lobby = lobbies.get(inv.lobbyCode);
  if (req.body.accept && lobby) {
    if (!lobby.participants.find(p => p.name === u.username)) {
      lobby.participants.push({ name: u.username, ready: false, answers: [] });
    }
    return res.json({ accepted: true, lobbyCode: inv.lobbyCode, lobby });
  }
  res.json({ accepted: false });
});

app.post('/api/lobby/submit', (req, res) => {
  const lobby = lobbies.get(req.body.code);
  if (!lobby) return res.status(404).json({ error: 'Fehlt' });

  const p = lobby.participants.find(x => x.name === req.body.userName);
  if (p) { p.answers = req.body.answers; p.ready = true; }

  if (lobby.participants.every(x => x.ready)) {
    lobby.status = 'finished';
  }
  res.json({ success: true, lobby });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch läuft stabil auf Port ${PORT}`));

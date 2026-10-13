import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'foodmatch_secret_key_2026';
const USERS_FILE = './users.json';

// Persistente Benutzer-Datenbank via JSON-Datei
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
const lobbies = new Map();

// Hilfsfunktion: Distanzberechnung
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ================= AUTHENTIFIZIERUNG =================

// Registrieren
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 4) {
      return res.status(400).json({ error: 'Benutzername und Passwort (min. 4 Zeichen) erforderlich.' });
    }

    const cleanName = username.trim();
    const key = cleanName.toLowerCase();

    if (dbUsers[key]) {
      return res.status(400).json({ error: 'Dieser Benutzername ist bereits vergeben.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      username: cleanName,
      password: hashedPassword,
      friends: [],
      createdAt: new Date().toISOString()
    };

    dbUsers[key] = newUser;
    saveUsers(dbUsers);

    const token = jwt.sign({ username: cleanName }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ success: true, token, user: { username: cleanName, friends: [] } });
  } catch (err) {
    res.status(500).json({ error: 'Fehler bei der Registrierung.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const key = (username || '').trim().toLowerCase();

    const user = dbUsers[key];
    if (!user) {
      return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
    }

    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ success: true, token, user: { username: user.username, friends: user.friends || [] } });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Login.' });
  }
});

// Auto-Login / Sitzungsprüfung beim App-Start
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Kein Token vorhanden.' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const key = decoded.username.toLowerCase();
    const user = dbUsers[key];
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });

    res.json({ user: { username: user.username, friends: user.friends || [] } });
  } catch (e) {
    res.status(401).json({ error: 'Sitzung abgelaufen.' });
  }
});

// ================= USER & FREUNDE =================

app.post('/api/user/sync', (req, res) => {
  const { userName = 'Gast' } = req.body;
  const key = userName.trim().toLowerCase();

  // Falls der Nutzer im Auth-Speicher existiert
  if (dbUsers[key]) {
    return res.json({ user: dbUsers[key] });
  }

  // Fallback für unregistrierte Gäste
  res.json({ user: { username: userName, friends: [], activeInvite: null } });
});

app.get('/api/user/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const me = (req.query.me || '').toLowerCase();
  const matched = [];

  for (const [key, user] of Object.entries(dbUsers)) {
    if (key !== me && user.username.toLowerCase().includes(q)) {
      matched.push(user.username);
    }
  }
  res.json({ users: matched });
});

app.post('/api/user/add-friend', (req, res) => {
  const { userName, friendName } = req.body;
  const userKey = (userName || '').trim().toLowerCase();
  const friendKey = (friendName || '').trim().toLowerCase();

  if (dbUsers[userKey] && dbUsers[friendKey]) {
    if (!dbUsers[userKey].friends.includes(dbUsers[friendKey].username)) {
      dbUsers[userKey].friends.push(dbUsers[friendKey].username);
      saveUsers(dbUsers);
    }
    return res.json({ success: true, friends: dbUsers[userKey].friends });
  }

  res.json({ success: false, friends: [] });
});

// ================= LOBBY & MEHRSPIELER =================

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
    status: 'waiting',
    winner: null
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
  if (!lobby) return res.status(404).json({ error: 'Lobby nicht gefunden.' });
  res.json({ lobby });
});

app.post('/api/lobby/start', (req, res) => {
  const lobby = lobbies.get(req.body.code);
  if (lobby) lobby.status = 'playing';
  res.json({ success: true });
});

app.post('/api/lobby/invite', (req, res) => {
  const friendKey = (req.body.friendName || '').trim().toLowerCase();
  if (dbUsers[friendKey]) {
    dbUsers[friendKey].activeInvite = {
      hostName: req.body.hostName,
      lobbyCode: req.body.lobbyCode,
      timestamp: Date.now()
    };
  }
  res.json({ success: true });
});

app.post('/api/lobby/respond-invite', (req, res) => {
  const userKey = (req.body.userName || '').trim().toLowerCase();
  const u = dbUsers[userKey];
  if (!u || !u.activeInvite) return res.json({ accepted: false });

  const inv = u.activeInvite;
  u.activeInvite = null;
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
  if (!lobby) return res.status(404).json({ error: 'Lobby fehlt.' });
  const p = lobby.participants.find(x => x.name === req.body.userName);
  if (p) {
    p.answers = req.body.answers;
    p.ready = true;
  }
  if (lobby.participants.every(x => x.ready)) {
    lobby.status = 'finished';
  }
  res.json({ success: true, lobby });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch läuft stabil auf Port ${PORT}`));

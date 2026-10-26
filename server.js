import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

// --- MONGODB CLOUD-VERBINDUNG ---
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.warn("WARNUNG: Keine MONGO_URI Umgebungsvariable gefunden! Accounts können nicht persistent gespeichert werden.");
} else {
  mongoose.connect(MONGO_URI)
    .then(() => console.log("Erfolgreich mit MongoDB Atlas verbunden!"))
    .catch(err => console.error("MongoDB Verbindungsfehler:", err));
}

// --- MONGOOSE SCHEMA (ACCOUNT STRUKTUR) ---
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  usernameLower: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  xp: { type: Number, default: 0 }, // <-- HIER ERGÄNZEN
  friends: { type: [String], default: [] },
  friendRequests: { type: [String], default: [] },
  activeInvite: { type: Object, default: null }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// --- MONGOOSE SCHEMA (RESTAURANT STRUKTUR MIT GEOJSON) ---
const restaurantSchema = new mongoose.Schema({
  osmId: { type: String, unique: true, sparse: true },
  name: { type: String, required: true },
  brand: { type: String, default: '' },
  amenity: { type: String, default: 'restaurant' },
  cuisine: { type: String, default: '' },
  address: { type: String, default: '' },
  priceTier: { type: Number, default: 2 },
  rating: { type: Number, default: 4.3 },
  hasParking: { type: Boolean, default: false },
  openingHours: { type: String, default: '' },
  searchKeywords: { type: String, default: '' },
  customHours: {
    hoursText: { type: String, default: '' },
    proposedBy: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'verified', 'none'], default: 'none' },
    confirmations: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now }
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      required: true
    }
  }
}, { timestamps: true });

// 2dsphere-Index für Highspeed-Umkreissuche
restaurantSchema.index({ location: '2dsphere' });

const Restaurant = mongoose.model('Restaurant', restaurantSchema);

// In-Memory Token & Lobbies
const activeTokens = new Map();
const lobbies = new Map();

// Hilfsfunktionen für Auth
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_foodmatch_salt_2026').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ================= AUTH ROUTEN =================

// 1. Registrieren
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 4) {
      return res.status(400).json({ error: 'Name und Passwort (mind. 4 Zeichen) eingeben.' });
    }

    const cleanName = username.trim();
    const key = cleanName.toLowerCase();

    const existingUser = await User.findOne({ usernameLower: key });
    if (existingUser) {
      return res.status(400).json({ error: 'Dieser Name ist bereits vergeben.' });
    }

    const newUser = await User.create({
      username: cleanName,
      usernameLower: key,
      passwordHash: hashPassword(password),
      friends: [],
      friendRequests: []
    });

    const token = generateToken();
    activeTokens.set(token, newUser.username);

    res.json({
      success: true,
      token,
      user: { username: newUser.username, friends: [], friendRequests: [] }
    });
  } catch (err) {
    console.error("Registrierungsfehler:", err);
    res.status(500).json({ error: 'Serverfehler bei der Registrierung.' });
  }
});

// 2. Anmelden
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Name und Passwort eingeben.' });
    }

    const key = username.trim().toLowerCase();
    const user = await User.findOne({ usernameLower: key });

    if (!user || user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Ungültiger Name oder falsches Passwort.' });
    }

    const token = generateToken();
    activeTokens.set(token, user.username);

    res.json({
      success: true,
      token,
      user: {
        username: user.username,
        xp: user.xp || 0,
        friends: user.friends || [],
        friendRequests: user.friendRequests || []
      }
    });
  } catch (err) {
    console.error("Loginfehler:", err);
    res.status(500).json({ error: 'Serverfehler beim Login.' });
  }
});

// 3. Auto-Login (Session wiederherstellen)
app.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Kein Token' });

    const token = authHeader.replace('Bearer ', '').trim();
    const username = activeTokens.get(token);

    if (!username) {
      return res.status(401).json({ error: 'Sitzung abgelaufen' });
    }

    const user = await User.findOne({ usernameLower: username.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    }

    res.json({
      user: {
        username: user.username,
        xp: user.xp || 0,
        friends: user.friends || [],
        friendRequests: user.friendRequests || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Sitzungsabruf.' });
  }
});

// ================= USER & FREUNDSCHAFTEN =================

app.post('/api/user/sync', async (req, res) => {
  try {
    const { userName = 'Gast' } = req.body;
    const key = userName.toLowerCase();

    let user = await User.findOne({ usernameLower: key });

    if (!user) {
      return res.json({
        user: { username: userName, friends: [], friendRequests: [], activeInvite: null }
      });
    }

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Sync-Fehler' });
  }
});

app.get('/api/user/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const me = (req.query.me || '').toLowerCase().trim();

    if (!q) return res.json({ users: [] });

    const users = await User.find({
      usernameLower: { $regex: q,$ne: me }
    }).limit(5);

    res.json({ users: users.map(u => u.username) });
  } catch (err) {
    res.status(500).json({ error: 'Suchfehler' });
  }
});

// Freundschaftsanfrage senden
app.post('/api/user/request-friend', async (req, res) => {
  try {
    const { userName, friendName } = req.body;
    const myKey = (userName || '').toLowerCase().trim();
    const friendKey = (friendName || '').toLowerCase().trim();

    const me = await User.findOne({ usernameLower: myKey });
    const friend = await User.findOne({ usernameLower: friendKey });

    if (!me || !friend) {
      return res.status(404).json({ error: 'Spieler nicht gefunden.' });
    }

    if (me.friends.includes(friend.username)) {
      return res.status(400).json({ error: `${friend.username} ist bereits dein Freund!` });
    }

    if (friend.friendRequests.includes(me.username)) {
      return res.status(400).json({ error: 'Anfrage wurde bereits gesendet.' });
    }

    friend.friendRequests.push(me.username);
    await friend.save();

    res.json({ success: true, message: `Anfrage an ${friend.username} gesendet!` });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Senden der Anfrage.' });
  }
});

// Freundschaftsanfrage beantworten
app.post('/api/user/respond-friend-request', async (req, res) => {
  try {
    const { userName, requesterName, accept } = req.body;
    const myKey = (userName || '').toLowerCase().trim();
    const requesterKey = (requesterName || '').toLowerCase().trim();

    const me = await User.findOne({ usernameLower: myKey });
    const requester = await User.findOne({ usernameLower: requesterKey });

    if (!me) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    me.friendRequests = me.friendRequests.filter(name => name.toLowerCase() !== requesterKey);

    if (accept && requester) {
      if (!me.friends.includes(requester.username)) {
        me.friends.push(requester.username);
      }
      if (!requester.friends.includes(me.username)) {
        requester.friends.push(me.username);
        await requester.save();
      }
    }

    await me.save();

    res.json({
      success: true,
      friends: me.friends || [],
      friendRequests: me.friendRequests || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Bearbeiten der Anfrage.' });
  }
});

// ================= LOBBYS & ECHTZEIT =================

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

app.post('/api/lobby/invite', async (req, res) => {
  try {
    const friendKey = (req.body.friendName || '').toLowerCase().trim();
    const friend = await User.findOne({ usernameLower: friendKey });
    if (friend) {
      friend.activeInvite = { hostName: req.body.hostName, lobbyCode: req.body.lobbyCode, timestamp: Date.now() };
      await friend.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Einladungsfehler' });
  }
});

app.post('/api/lobby/respond-invite', async (req, res) => {
  try {
    const myKey = (req.body.userName || '').toLowerCase().trim();
    const user = await User.findOne({ usernameLower: myKey });
    if (!user || !user.activeInvite) return res.json({ accepted: false });

    const inv = user.activeInvite;
    user.activeInvite = null;
    await user.save();

    const lobby = lobbies.get(inv.lobbyCode);
    if (req.body.accept && lobby) {
      if (!lobby.participants.find(p => p.name === user.username)) {
        lobby.participants.push({ name: user.username, ready: false, answers: [] });
      }
      return res.json({ accepted: true, lobbyCode: inv.lobbyCode, lobby });
    }
    res.json({ accepted: false });
  } catch (err) {
    res.status(500).json({ error: 'Fehler bei Einladungsantwort' });
  }
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

// ==========================================
// RESTAURANTS & PLACES (MONGODB ATLAS CLOUD)
// ==========================================

app.get('/api/places', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radiusMeters = Math.min(parseInt(req.query.radius, 10) || 5000, 25000);

    if (!lat || !lon) {
      return res.status(400).json({ error: 'lat und lon sind erforderlich.' });
    }

    // 2dsphere-Umkreissuche über deine importierten Daten
    const docs = await Restaurant.find({
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [lon, lat] },$maxDistance: radiusMeters
        }
      }
    }).limit(1000);

    // Format identisch für das Frontend aufbereiten
    // Format identisch für das Frontend aufbereiten
    const elements = docs.map(d => {
      // Wenn die Community-Zeiten verifiziert sind (>= 3 Bestätigungen), überschreiben sie den OSM-Wert
      const isVerified = d.customHours && d.customHours.status === 'verified';
      const effectiveHours = isVerified ? d.customHours.hoursText : (d.openingHours || '');

      return {
        id: d.osmId || d._id.toString(),
        lat: d.location.coordinates[1],
        lon: d.location.coordinates[0],
        customHours: d.customHours && d.customHours.status !== 'none' ? d.customHours : null,
        tags: {
          name: d.name,
          brand: d.brand || '',
          amenity: d.amenity || 'restaurant',
          cuisine: d.cuisine || '',
          'addr:street': d.address || '',
          opening_hours: effectiveHours,
          parking: d.hasParking ? 'yes' : undefined
        }
      };
    });

    res.json({ elements, count: elements.length });
  } catch (error) {
    console.error('[MongoDB Places Fehler]:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Orte aus der Datenbank.' });
  }
});
// ==========================================
// COMMUNITY CROWDSOURCING: ÖFFNUNGSZEITEN
// ==========================================

// 1. Öffnungszeit vorschlagen / bearbeiten
app.post('/api/places/propose-hours', async (req, res) => {
  try {
    const { placeId, placeName, hoursText, userName, lat, lon } = req.body;
    if (!userName || !placeId || !hoursText || hoursText.trim().length < 4) {
      return res.status(400).json({ error: 'Ungültige Eingaben.' });
    }

    const cleanHours = hoursText.trim();
    const newProposal = {
      hoursText: cleanHours,
      proposedBy: userName,
      status: 'pending',
      confirmations: [], // Benötigt noch 3 fremde Stimmen
      updatedAt: new Date()
    };

    // Suche über osmId ODER MongoDB ObjectId
    const query = mongoose.Types.ObjectId.isValid(placeId)
      ? { $or: [{ osmId: String(placeId) }, { _id: placeId }] }
      : { osmId: String(placeId) };

    let restaurant = await Restaurant.findOne(query);

    if (restaurant) {
      restaurant.customHours = newProposal;
      await restaurant.save();
    } else if (lat && lon) {
      // Falls Restaurant noch nicht in MongoDB existiert
      restaurant = await Restaurant.create({
        osmId: String(placeId),
        name: placeName || 'Restaurant',
        customHours: newProposal,
        location: {
          type: 'Point',
          coordinates: [parseFloat(lon), parseFloat(lat)]
        }
      });
    } else {
      return res.status(404).json({ error: 'Lokal nicht gefunden.' });
    }
    // Dem Einreicher 20 XP gutschreiben
    await User.updateOne({ usernameLower: userName.toLowerCase() }, { $inc: { xp: 20 } });

    res.json({ success: true, message: 'Vorschlag eingereicht! Benötigt 3 Bestätigungen anderer Nutzer.' });
  } catch (err) {
    console.error('[Propose Hours Fehler]:', err);
    res.status(500).json({ error: 'Fehler beim Speichern des Vorschlags.' });
  }
});

// 2. Öffnungszeit bestätigen (Upvote durch fremde Nutzer)
// 2. Öffnungszeit bestätigen (Upvote durch fremde Nutzer)
app.post('/api/places/confirm-hours', async (req, res) => {
  try {
    const { placeId, userName } = req.body;
    if (!userName || !placeId) {
      return res.status(400).json({ error: 'Fehlende Angaben.' });
    }

    const query = mongoose.Types.ObjectId.isValid(placeId)
      ? { $or: [{ osmId: String(placeId) }, { _id: placeId }] }
      : { osmId: String(placeId) };

    const restaurant = await Restaurant.findOne(query);

    if (!restaurant || !restaurant.customHours || restaurant.customHours.status === 'none') {
      return res.status(404).json({ error: 'Kein offener Vorschlag für dieses Lokal vorhanden.' });
    }

    // Regel 1: Eigener Vorschlag darf nicht bestätigt werden
    if (restaurant.customHours.proposedBy.toLowerCase() === userName.toLowerCase()) {
      return res.status(400).json({ error: 'Du kannst deinen eigenen Vorschlag nicht bestätigen!' });
    }

    // Regel 2: Jeder Account darf nur 1x abstimmen
    const alreadyVoted = restaurant.customHours.confirmations.some(
      u => u.toLowerCase() === userName.toLowerCase()
    );
    if (alreadyVoted) {
      return res.status(400).json({ error: 'Du hast diesen Vorschlag bereits bestätigt.' });
    }

    restaurant.customHours.confirmations.push(userName);

    // Dem Bestätiger 10 XP gutschreiben
    await User.updateOne({ usernameLower: userName.toLowerCase() }, { $inc: { xp: 10 } });

    // Regel 3: Ab 3 Bestätigungen wird verifiziert -> 50 XP Bonus für den Ersteller
    if (restaurant.customHours.confirmations.length >= 3) {
      restaurant.customHours.status = 'verified';
      restaurant.openingHours = restaurant.customHours.hoursText;

      await User.updateOne(
        { usernameLower: restaurant.customHours.proposedBy.toLowerCase() },
        { $inc: { xp: 50 } }
      );
    }

    await restaurant.save();

    res.json({
      success: true,
      confirmationsCount: restaurant.customHours.confirmations.length,
      isVerified: restaurant.customHours.status === 'verified',
      hoursText: restaurant.customHours.hoursText
    });
  } catch (err) {
    console.error('[Confirm Hours Fehler]:', err);
    res.status(500).json({ error: 'Fehler beim Bestätigen der Öffnungszeit.' });
  }
});

// ================= SERVER START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch läuft stabil auf Port ${PORT}`));

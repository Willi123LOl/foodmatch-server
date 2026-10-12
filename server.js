import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const lobbies = new Map();
const users = new Map();

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

// 1. ECHTE LIVE-ORTSSUCHE (Kostenlos via OpenStreetMap Nominatim)
app.post('/api/autocomplete', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || input.trim().length < 2) return res.json({ predictions: [] });

    const q = encodeURIComponent(input.trim());
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&addressdetails=1&countrycodes=de&limit=6`;
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'FoodMatchApp/2.0 (contact@foodmatch.app)' }
    });
    const data = await response.json();

    const predictions = (data || []).map(item => {
      const city = item.address?.city || item.address?.town || item.address?.village || item.address?.municipality || item.display_name.split(',')[0];
      const state = item.address?.state || item.address?.county || '';
      return {
        mainText: city,
        secondaryText: item.display_name,
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon)
      };
    });

    res.json({ predictions });
  } catch (err) {
    res.json({ predictions: [] });
  }
});

// 2. RESTAURANTS IM ECHTEN UMKREIS DES GEWÄHLTEN ORTES
app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 20 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Keine Koordinaten angegeben.' });

    const reqRadius = parseFloat(radiusKm) || 20;
    const radiusMeters = Math.min(Math.round(reqRadius * 1000), 25000);

    // Overpass API Query exakt um den gewählten Standort
    const query = `[out:json][timeout:6];(node["amenity"~"restaurant|fast_food|cafe|pizza"](around:${radiusMeters},${lat},${lon}););out center 80;`;
    const osmRes = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'FoodMatchApp/2.0' },
      signal: AbortSignal.timeout(5000)
    });
    const data = await osmRes.json();

    const results = (data.elements || [])
      .filter(e => e.tags && (e.tags.name || e.tags['name:de']))
      .map(e => {
        const eLat = e.lat || e.center?.lat || lat;
        const eLon = e.lon || e.center?.lon || lon;
        const t = e.tags;
        const name = t.name || t['name:de'];
        const cuisine = t.cuisine ? (t.cuisine.charAt(0).toUpperCase() + t.cuisine.slice(1)).replace(/;/g, ', ') : (t.amenity === 'fast_food' ? 'Fast Food' : 'Restaurant');
        const isFastFood = t.amenity === 'fast_food' || (t.cuisine || '').includes('kebab') || (t.cuisine || '').includes('pizza');

        return {
          id: `osm_${e.id}`,
          name: name,
          cuisine: cuisine,
          price: isFastFood ? '€' : '€€',
          numericPrice: isFastFood ? 1 : 2,
          rating: (4.2 + (name.length % 7) / 10).toFixed(1),
          address: t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] || ''}` : 'In deiner Nähe',
          dist: calculateDistance(lat, lon, eLat, eLon),
          lat: eLat,
          lon: eLon,
          isOpenNow: true,
          openMinutesRemaining: 180,
          hasParking: true,
          features: {
            isFingerfood: isFastFood || (t.cuisine || '').includes('burger'),
            isAsian: (t.cuisine || '').includes('asian') || (t.cuisine || '').includes('sushi') || name.toLowerCase().includes('sushi'),
            isItalian: (t.cuisine || '').includes('italian') || (t.cuisine || '').includes('pizza'),
            isHeavyMeat: (t.cuisine || '').includes('kebab') || (t.cuisine || '').includes('burger') || (t.cuisine || '').includes('steak'),
            isLightHealthy: (t.cuisine || '').includes('salad') || (t.cuisine || '').includes('asian'),
            isCozySitDown: t.amenity !== 'fast_food'
          }
        };
      });

    // Nach Entfernung sortieren
    results.sort((a, b) => a.dist - b.dist);
    res.json({ restaurants: results });
  } catch (err) {
    res.json({ restaurants: [] });
  }
});

// User & Freunde
app.post('/api/user/sync', (req, res) => {
  const { userName = 'Player' } = req.body;
  if (!users.has(userName)) users.set(userName, { name: userName, friends: [], activeInvite: null });
  res.json({ user: users.get(userName) });
});

app.get('/api/user/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const matched = [];
  for (const [name] of users.entries()) {
    if (name.toLowerCase().includes(q)) matched.push(name);
  }
  res.json({ users: matched });
});

app.post('/api/user/add-friend', (req, res) => {
  const { userName, friendName } = req.body;
  if (!users.has(friendName)) users.set(friendName, { name: friendName, friends: [], activeInvite: null });
  const u = users.get(userName);
  if (u && !u.friends.includes(friendName)) u.friends.push(friendName);
  res.json({ success: true, friends: u ? u.friends : [] });
});

app.post('/api/lobby/create', (req, res) => {
  const { hostName, lat, lon, radiusKm = 5 } = req.body;
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const lobby = {
    code, hostName, lat, lon, radiusKm,
    participants: [{ name: hostName, ready: false, answers: [] }],
    status: 'waiting', winner: null,
    questions: [
      { id: 'asian', title: "Lust auf Asiatisch oder Sushi?", subtitle: "Sushi, Wok, Ramen", options: [{ text: "🥢 Ja, definitiv Asiatisch / Sushi", feature: 'isAsian', targetVal: true, isHard: true }, { text: "🥖 Nein, lieber europäisch", feature: 'isAsian', targetVal: false }, { text: "🤷 Egal", feature: null }] },
      { id: 'fingerfood', title: "Auf die Hand oder Besteck?", subtitle: "Ess-Erlebnis", options: [{ text: "🍔 Auf die Faust (Burger, Pizza, Döner)", feature: 'isFingerfood', targetVal: true }, { text: "🍽️ Mit Besteck", feature: 'isFingerfood', targetVal: false }, { text: "🤷 Egal", feature: null }] }
    ]
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
  const f = users.get(req.body.friendName);
  if (f) f.activeInvite = { hostName: req.body.hostName, lobbyCode: req.body.lobbyCode, timestamp: Date.now() };
  res.json({ success: true });
});

app.post('/api/lobby/respond-invite', (req, res) => {
  const u = users.get(req.body.userName);
  if (!u || !u.activeInvite) return res.json({ accepted: false });
  const inv = u.activeInvite;
  u.activeInvite = null;
  const lobby = lobbies.get(inv.lobbyCode);
  if (req.body.accept && lobby) {
    if (!lobby.participants.find(p => p.name === u.name)) lobby.participants.push({ name: u.name, ready: false, answers: [] });
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
app.listen(PORT, () => console.log(`FoodMatch läuft auf Port ${PORT}`));

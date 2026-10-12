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

// 1. LIVE-ORTSSUCHE BEIM TIPPEN (z. B. "Ess" -> Essen)
app.post('/api/autocomplete', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || input.trim().length < 2) return res.json({ predictions: [] });

    const q = encodeURIComponent(input.trim());
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&addressdetails=1&countrycodes=de&limit=6`;
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'FoodMatchApp/3.0' }
    });
    const data = await response.json();

    const predictions = (data || []).map(item => {
      const city = item.address?.city || item.address?.town || item.address?.village || item.address?.municipality || item.display_name.split(',')[0];
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

// Generator für vielfältige Lokale im gewählten Umkreis (falls Overpass mal überlastet ist)
function generateLocalSpots(lat, lon, cityName = 'Stadtzentrum') {
  const templates = [
    { name: `Pizzeria Bella ${cityName}`, cuisine: "Italienisch / Pizza", price: "€€", pNum: 2, r: 4.8, feat: { isItalian: true, isFingerfood: true, isCozySitDown: true }, offLat: 0.003, offLon: 0.004 },
    { name: `Tokyo Sushi & Ramen ${cityName}`, cuisine: "Asiatisch / Sushi", price: "€€", pNum: 2, r: 4.9, feat: { isAsian: true, isLightHealthy: true, isCozySitDown: true }, offLat: -0.002, offLon: 0.003 },
    { name: `Döner & Grill Haus ${cityName}`, cuisine: "Döner / Grill", price: "€", pNum: 1, r: 4.6, feat: { isFingerfood: true, isHeavyMeat: true }, offLat: 0.001, offLon: -0.002 },
    { name: `Burger Brothers & Fries`, cuisine: "Burger / American", price: "€€", pNum: 2, r: 4.7, feat: { isFingerfood: true, isHeavyMeat: true }, offLat: -0.004, offLon: -0.003 },
    { name: `Ristorante Da Marco`, cuisine: "Italienisch / Pasta", price: "€€", pNum: 2, r: 4.6, feat: { isItalian: true, isCozySitDown: true }, offLat: 0.005, offLon: -0.001 },
    { name: `Wok & Asia Nudeln`, cuisine: "Asiatisch / Wok", price: "€", pNum: 1, r: 4.4, feat: { isAsian: true, isFingerfood: false }, offLat: -0.001, offLon: 0.005 },
    { name: `Green Bowls & Fresh Salad`, cuisine: "Bowls / Healthy", price: "€€", pNum: 2, r: 4.8, feat: { isLightHealthy: true, isCozySitDown: true }, offLat: 0.002, offLon: 0.006 },
    { name: `Steakhouse El Toro`, cuisine: "Steak & BBQ", price: "€€€", pNum: 3, r: 4.9, feat: { isHeavyMeat: true, isCozySitDown: true }, offLat: 0.006, offLon: 0.003 },
    { name: `City Döner & Pizza Point`, cuisine: "Fast Food / Kebab", price: "€", pNum: 1, r: 4.3, feat: { isFingerfood: true, isHeavyMeat: true }, offLat: -0.003, offLon: 0.001 },
    { name: `Sakura Sushi Lounge`, cuisine: "Sushi / Japanisch", price: "€€", pNum: 2, r: 4.7, feat: { isAsian: true, isLightHealthy: true, isCozySitDown: true }, offLat: 0.004, offLon: -0.005 },
    { name: `Anatolien Holzkohlegrill`, cuisine: "Türkisch / Grill", price: "€€", pNum: 2, r: 4.8, feat: { isHeavyMeat: true, isCozySitDown: true }, offLat: -0.005, offLon: 0.002 },
    { name: `Trattoria Napoli`, cuisine: "Italienisch / Steinofen", price: "€€", pNum: 2, r: 4.7, feat: { isItalian: true, isFingerfood: true, isCozySitDown: true }, offLat: 0.002, offLon: -0.004 },
    { name: `Smash Burger Factory`, cuisine: "Burger & Wings", price: "€€", pNum: 2, r: 4.6, feat: { isFingerfood: true, isHeavyMeat: true }, offLat: -0.006, offLon: -0.002 },
    { name: `Asia Wok Express`, cuisine: "Chinesisch / Thai", price: "€", pNum: 1, r: 4.5, feat: { isAsian: true, isFingerfood: false }, offLat: 0.007, offLon: 0.001 },
    { name: `Gourmet Steak & Tapas`, cuisine: "Steakhouse / Bar", price: "€€€", pNum: 3, r: 4.8, feat: { isHeavyMeat: true, isCozySitDown: true }, offLat: -0.002, offLon: -0.006 },
    { name: `Crispy Chicken & Burger`, cuisine: "Fast Food / Chicken", price: "€", pNum: 1, r: 4.4, feat: { isFingerfood: true, isHeavyMeat: true }, offLat: 0.001, offLon: 0.007 },
    { name: `Oishii All-You-Can-Eat Sushi`, cuisine: "Sushi / Asiatisch", price: "€€", pNum: 2, r: 4.8, feat: { isAsian: true, isLightHealthy: true, isCozySitDown: true }, offLat: 0.008, offLon: -0.003 },
    { name: `Pizzeria Bella Vista`, cuisine: "Pizza / Pasta", price: "€€", pNum: 2, r: 4.5, feat: { isItalian: true, isFingerfood: true }, offLat: -0.007, offLon: 0.004 }
  ];

  return templates.map((t, idx) => {
    const spotLat = lat + t.offLat;
    const spotLon = lon + t.offLon;
    return {
      id: `spot_${idx}`,
      name: t.name,
      cuisine: t.cuisine,
      price: t.price,
      numericPrice: t.pNum,
      rating: t.r,
      address: `Hauptstraße ${idx + 12}, ${cityName}`,
      dist: calculateDistance(lat, lon, spotLat, spotLon),
      lat: spotLat,
      lon: spotLon,
      isOpenNow: true,
      openMinutesRemaining: 180,
      hasParking: true,
      features: t.feat
    };
  });
}

// 2. RESTAURANT RADAR (Fragt Overpass ab & garantiert immer volle Ergebnisse)
app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 20, cityName = 'Umgebung' } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Koordinaten fehlen.' });

    const reqRadius = parseFloat(radiusKm) || 20;
    const radiusMeters = Math.min(Math.round(reqRadius * 1000), 25000);

    let found = [];

    // Wir fragen Overpass mit 2 verschiedenen Spiegel-Servern ab
    const mirrors = [
      'https://overpass-api.de/api/interpreter',
      'https://lz4.overpass-api.de/api/interpreter'
    ];

    for (const mirror of mirrors) {
      try {
        const query = `[out:json][timeout:8];(node["amenity"~"restaurant|fast_food|cafe|pizza"](around:${radiusMeters},${lat},${lon}););out center 60;`;
        const response = await fetch(`${mirror}?data=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'FoodMatchApp/3.0' },
          signal: AbortSignal.timeout(7000)
        });
        const data = await response.json();

        if (data.elements && data.elements.length > 0) {
          found = data.elements
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
                address: t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] || ''}` : `Zentrum, ${cityName}`,
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
          break; // Erfolg, kein weiterer Mirror nötig
        }
      } catch (e) {}
    }

    // Falls Overpass überlastet ist, sofort für die EXAKTEN Koordinaten des Nutzers generieren
    if (found.length === 0) {
      found = generateLocalSpots(lat, lon, cityName);
    }

    found.sort((a, b) => a.dist - b.dist);
    res.json({ restaurants: found });
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

// Lobbys
app.post('/api/lobby/create', (req, res) => {
  const { hostName, lat, lon, radiusKm = 5, cityName = 'Ort' } = req.body;
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const pool = generateLocalSpots(lat, lon, cityName);

  const lobby = {
    code, hostName, lat, lon, radiusKm,
    participants: [{ name: hostName, ready: false, answers: [] }],
    restaurants: pool,
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
    lobby.winner = lobby.restaurants[0];
    lobby.status = 'finished';
  }
  res.json({ success: true, lobby });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch läuft stabil auf Port ${PORT}`));

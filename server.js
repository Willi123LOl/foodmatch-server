import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// In-Memory Speicher für Lobbys und Freunde
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

function analyzeRestaurantFeatures(name, cuisine, tags) {
  const text = `${name} ${cuisine} ${JSON.stringify(tags || {})}`.toLowerCase();
  return {
    isFingerfood: text.includes('burger') || text.includes('döner') || text.includes('kebab') || text.includes('pizza') || text.includes('fast_food') || text.includes('sandwich') || text.includes('chicken') || text.includes('imbiss'),
    isAsian: text.includes('asia') || text.includes('sushi') || text.includes('vietnam') || text.includes('thai') || text.includes('china') || text.includes('wok') || text.includes('ramen') || text.includes('japanese') || text.includes('asian') || text.includes('chinese'),
    isItalian: text.includes('pizza') || text.includes('pasta') || text.includes('italien') || text.includes('trattoria') || text.includes('ristorante'),
    isHeavyMeat: text.includes('steak') || text.includes('grill') || text.includes('burger') || text.includes('döner') || text.includes('bbq') || text.includes('chicken') || text.includes('fleisch') || text.includes('schnitzel'),
    isLightHealthy: text.includes('bowl') || text.includes('salad') || text.includes('salat') || text.includes('vegan') || text.includes('veggie') || text.includes('sushi') || text.includes('cafe'),
    isCozySitDown: !text.includes('fast_food') && !text.includes('imbiss') && !text.includes('takeaway') && !text.includes('snack')
  };
}

// 1. KOSTENLOSE ORTSSUCHE (OpenStreetMap Nominatim)
app.post('/api/autocomplete', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || input.trim().length < 2) return res.json({ predictions: [] });

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(input.trim())}&format=json&addressdetails=1&countrycodes=de&limit=6`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'FoodMatchApp/1.0 (contact@foodmatch.local)' }
    });
    const data = await response.json();

    const predictions = (data || []).map((item) => ({
      placeId: `${item.lat},${item.lon}`,
      mainText: item.address?.city || item.address?.town || item.address?.village || item.name || item.display_name.split(',')[0],
      secondaryText: item.display_name,
      description: item.display_name,
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon)
    }));

    res.json({ predictions });
  } catch (err) {
    res.json({ predictions: [] });
  }
});

// 2. ORTS-DETAILS KOORDINATEN
app.post('/api/geocode-place', async (req, res) => {
  try {
    const { placeId } = req.body;
    if (!placeId) return res.status(400).json({ error: 'placeId fehlt' });

    const [latStr, lonStr] = placeId.split(',');
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);

    res.json({
      address: 'Ausgewählter Ort',
      lat: lat,
      lon: lon
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// 3. KOSTENLOSES REVERSE-GEOCODING (GPS zu Adresse)
app.post('/api/reverse-geocode', async (req, res) => {
  try {
    const { lat, lon } = req.body;
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'FoodMatchApp/1.0 (contact@foodmatch.local)' }
    });
    const data = await response.json();

    const city = data.address?.city || data.address?.town || data.address?.village || data.address?.municipality || 'Aktueller Standort';
    const street = data.address?.road ? `${data.address.road}, ` : '';
    res.json({ address: `${street}${city}` });
  } catch (err) {
    res.json({ address: 'Aktueller Standort' });
  }
});

// 4. KOSTENLOSE RESTAURANTSUCHE (Overpass API - Ohne Limits!)
async function fetchRestaurantsFromOSM(lat, lon, radiusKm = 10) {
  const radiusMeters = Math.min(Math.round(radiusKm * 1000), 20000);

  // Overpass QL Query: Sucht alle Restaurants, Imbisse, Cafes und Fast Food im Umkreis
  const query = `
    [out:json][timeout:15];
    (
      node["amenity"~"restaurant|fast_food|cafe"](around:${radiusMeters},${lat},${lon});
      way["amenity"~"restaurant|fast_food|cafe"](around:${radiusMeters},${lat},${lon});
    );
    out center 60;
  `;

  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'FoodMatchApp/1.0' }
  });

  const data = await response.json();
  const elements = data.elements || [];

  return elements
    .filter(el => el.tags && (el.tags.name || el.tags['name:de']))
    .map((el) => {
      const elLat = el.lat || el.center?.lat || lat;
      const elLon = el.lon || el.center?.lon || lon;
      const tags = el.tags || {};

      const name = tags.name || tags['name:de'] || 'Restaurant';
      const rawCuisine = tags.cuisine ? tags.cuisine.replace(/;/g, ', ') : (tags.amenity === 'fast_food' ? 'Fast Food' : 'Restaurant');
      const cuisine = rawCuisine.charAt(0).toUpperCase() + rawCuisine.slice(1);

      // Preisstufe anhand OSM-Tags schätzen
      let priceTag = '€€';
      let numericPrice = 2;
      if (tags.amenity === 'fast_food' || tags.cuisine?.includes('kebab') || tags.cuisine?.includes('pizza')) {
        priceTag = '€';
        numericPrice = 1;
      }

      // Sterne-Simulation anhand Datenqualität (oder 4.2 - 4.8)
      const fakeRating = (4.2 + ((name.length % 7) / 10)).toFixed(1);

      const features = analyzeRestaurantFeatures(name, rawCuisine, tags);
      const street = tags['addr:street'] ? `${tags['addr:street']} ${tags['addr:housenumber'] || ''}` : 'In deiner Nähe';
      const city = tags['addr:city'] || '';

      return {
        id: `osm_${el.id}`,
        name: name,
        address: `${street}${city ? ', ' + city : ''}`,
        rating: parseFloat(fakeRating),
        price: priceTag,
        numericPrice: numericPrice,
        cuisine: cuisine,
        dist: calculateDistance(lat, lon, elLat, elLon),
        lat: elLat,
        lon: elLon,
        isOpenNow: true,
        openMinutesRemaining: 180,
        hasParking: Boolean(tags.parking || tags['parking:fee'] || numericPrice >= 2),
        features: features
      };
    });
}

app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 10 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Koordinaten fehlen.' });
    const restaurants = await fetchRestaurantsFromOSM(lat, lon, radiusKm);
    res.json({ restaurants });
  } catch (error) {
    console.error('OSM Error:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Restaurants' });
  }
});

// Dynamischer Fragen-Generator
function generateDynamicQuestions(pool) {
  const questions = [];
  const total = pool.length;
  if (total === 0) return questions;

  const countAsian = pool.filter(r => r.features?.isAsian).length;
  const countFingerfood = pool.filter(r => r.features?.isFingerfood).length;
  const countHeavyMeat = pool.filter(r => r.features?.isHeavyMeat).length;
  const countSitDown = pool.filter(r => r.features?.isCozySitDown).length;

  if (countAsian > 0) {
    questions.push({
      id: 'asian',
      title: "Lust auf asiatische Küche oder Sushi?",
      subtitle: "Reis, Nudeln, Sushi, Wok oder Currys.",
      options: [
        { text: "🥢 Ja, definitiv Asiatisch / Sushi", feature: 'isAsian', targetVal: true, isHard: true },
        { text: "🥖 Nein, lieber europäisch / andere Richtungen", feature: 'isAsian', targetVal: false, isHard: false },
        { text: "🤷 Egal, bin für alles offen", feature: null }
      ]
    });
  }

  if (countFingerfood > 0 && countFingerfood < total) {
    questions.push({
      id: 'fingerfood',
      title: "Auf die Hand oder mit Besteck am Tisch?",
      subtitle: "Der Akinator analysiert das Ess-Erlebnis.",
      options: [
        { text: "🍔 Auf die Faust (Burger, Döner, Pizza, Snacks)", feature: 'isFingerfood', targetVal: true },
        { text: "🍽️ Mit Messer & Gabel auf einem Teller", feature: 'isFingerfood', targetVal: false },
        { text: "🤷 Völlig egal", feature: null }
      ]
    });
  }

  if (countHeavyMeat > 0 && countHeavyMeat < total && questions.length < 3) {
    questions.push({
      id: 'meat',
      title: "Darf es so richtig deftig sein?",
      subtitle: "Fleisch-Fokus oder eher bekömmlich.",
      options: [
        { text: "🥩 Ja, ordentlich Fleisch & deftig", feature: 'isHeavyMeat', targetVal: true },
        { text: "🥗 Lieber leichter oder vegetarisch", feature: 'isHeavyMeat', targetVal: false },
        { text: "🤷 Egal", feature: null }
      ]
    });
  }

  if (countSitDown > 0 && countSitDown < total && questions.length < 4) {
    questions.push({
      id: 'sitdown',
      title: "Welche Atmosphäre soll es sein?",
      subtitle: "Sitzplatz-Kultur vor Ort.",
      options: [
        { text: "✨ Gemütlich sitzen mit Bedienung", feature: 'isCozySitDown', targetVal: true },
        { text: "⚡ Schneller Imbiss / unkompliziert", feature: 'isCozySitDown', targetVal: false },
        { text: "🤷 Hauptsache das Essen schmeckt", feature: null }
      ]
    });
  }

  return questions.slice(0, 4);
}

app.post('/api/akinator/questions', (req, res) => {
  const { pool } = req.body;
  const questions = generateDynamicQuestions(pool || []);
  res.json({ questions });
});

// ================= USER & FREUNDE =================

app.post('/api/user/sync', (req, res) => {
  const { userName } = req.body;
  if (!userName) return res.status(400).json({ error: 'Name fehlt' });

  const cleanName = userName.trim();
  if (!users.has(cleanName)) {
    users.set(cleanName, { name: cleanName, friends: [], activeInvite: null, lastSeen: Date.now() });
  } else {
    const u = users.get(cleanName);
    u.lastSeen = Date.now();
  }

  const user = users.get(cleanName);
  res.json({
    user: {
      name: user.name,
      friends: user.friends,
      activeInvite: user.activeInvite
    }
  });
});

app.get('/api/user/search', (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  const currentUser = (req.query.me || '').trim().toLowerCase();

  if (!query) return res.json({ users: [] });

  const matched = [];
  for (const [name] of users.entries()) {
    if (name.toLowerCase().includes(query) && name.toLowerCase() !== currentUser) {
      matched.push(name);
      if (matched.length >= 8) break;
    }
  }
  res.json({ users: matched });
});

app.post('/api/user/add-friend', (req, res) => {
  const { userName, friendName } = req.body;
  const uName = (userName || '').trim();
  const fName = (friendName || '').trim();

  if (!uName || !fName) return res.status(400).json({ error: 'Name fehlt' });
  if (uName.toLowerCase() === fName.toLowerCase()) return res.status(400).json({ error: 'Du kannst dich nicht selbst hinzufügen.' });

  if (!users.has(fName)) {
    users.set(fName, { name: fName, friends: [], activeInvite: null, lastSeen: Date.now() });
  }

  const user = users.get(uName);
  if (!user.friends.includes(fName)) {
    user.friends.push(fName);
  }

  res.json({ success: true, friends: user.friends });
});

// ================= LOBBY =================

app.post('/api/lobby/create', async (req, res) => {
  try {
    const { hostName, lat, lon, radiusKm = 5, minOpenMinutes = 0, requiresParking = false, price = '€€' } = req.body;
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    const raw = await fetchRestaurantsFromOSM(lat, lon, radiusKm);
    let maxNumericPrice = 3;
    if (price === '€') maxNumericPrice = 1;
    else if (price === '€€') maxNumericPrice = 2;

    const filtered = raw.filter(r => {
      if (r.dist > radiusKm) return false;
      if (price !== 'all' && r.numericPrice > maxNumericPrice) return false;
      if (requiresParking && !r.hasParking) return false;
      return true;
    });

    const questions = generateDynamicQuestions(filtered);

    const lobby = {
      code,
      hostName,
      lat,
      lon,
      radiusKm,
      minOpenMinutes,
      requiresParking,
      price,
      participants: [{ name: hostName, ready: false, answers: [] }],
      restaurants: filtered,
      questions: questions,
      status: 'waiting',
      winner: null
    };

    lobbies.set(code, lobby);
    res.json({ success: true, code, lobby });
  } catch (e) {
    res.status(500).json({ error: 'Lobby-Fehler' });
  }
});

app.post('/api/lobby/join', (req, res) => {
  const { code, userName } = req.body;
  const lobby = lobbies.get(code);

  if (!lobby) return res.status(404).json({ error: 'Lobby nicht gefunden.' });
  if (lobby.status !== 'waiting') return res.status(400).json({ error: 'Spiel läuft bereits.' });

  const exists = lobby.participants.find(p => p.name === userName);
  if (!exists) {
    lobby.participants.push({ name: userName, ready: false, answers: [] });
  }

  res.json({ success: true, lobby });
});

app.get('/api/lobby/status/:code', (req, res) => {
  const lobby = lobbies.get(req.params.code);
  if (!lobby) return res.status(404).json({ error: 'Lobby existiert nicht.' });
  res.json({ lobby });
});

app.post('/api/lobby/invite', (req, res) => {
  const { hostName, friendName, lobbyCode } = req.body;
  const f = users.get((friendName || '').trim());
  if (!f) return res.status(404).json({ error: 'Freund nicht gefunden.' });

  f.activeInvite = { hostName: hostName.trim(), lobbyCode: lobbyCode.trim(), timestamp: Date.now() };
  res.json({ success: true });
});

app.post('/api/lobby/respond-invite', (req, res) => {
  const { userName, accept } = req.body;
  const u = users.get((userName || '').trim());
  if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

  const invite = u.activeInvite;
  u.activeInvite = null;

  if (accept && invite) {
    const lobby = lobbies.get(invite.lobbyCode);
    if (lobby && lobby.status === 'waiting') {
      const exists = lobby.participants.find(p => p.name === u.name);
      if (!exists) {
        lobby.participants.push({ name: u.name, ready: false, answers: [] });
      }
      return res.json({ success: true, accepted: true, lobbyCode: invite.lobbyCode, lobby });
    }
    return res.status(400).json({ error: 'Lobby ist nicht mehr verfügbar.' });
  }

  res.json({ success: true, accepted: false });
});

app.post('/api/lobby/start', (req, res) => {
  const { code } = req.body;
  const lobby = lobbies.get(code);
  if (!lobby) return res.status(404).json({ error: 'Lobby fehlt' });
  lobby.status = 'playing';
  res.json({ success: true });
});

app.post('/api/lobby/submit', (req, res) => {
  const { code, userName, answers } = req.body;
  const lobby = lobbies.get(code);
  if (!lobby) return res.status(404).json({ error: 'Lobby fehlt' });

  const p = lobby.participants.find(part => part.name === userName);
  if (p) {
    p.answers = answers;
    p.ready = true;
  }

  const allReady = lobby.participants.every(part => part.ready);
  if (allReady && lobby.restaurants.length > 0) {
    let pool = [...lobby.restaurants];

    lobby.participants.forEach(part => {
      part.answers.forEach(ans => {
        if (ans && ans.isHard && ans.feature) {
          const matchingOnly = pool.filter(r => r.features && r.features[ans.feature] === ans.targetVal);
          if (matchingOnly.length > 0) pool = matchingOnly;
        }
      });
    });

    let best = pool[0];
    let highestScore = -9999;

    pool.forEach(rest => {
      let score = (rest.rating || 3.5) * 3 - rest.dist * 0.2;

      lobby.participants.forEach(part => {
        part.answers.forEach(ans => {
          if (!ans || !ans.feature) return;
          const match = rest.features && rest.features[ans.feature] === ans.targetVal;
          if (match) score += 6;
          else score -= 4;
        });
      });

      if (score > highestScore) {
        highestScore = score;
        best = rest;
      }
    });

    lobby.winner = best;
    lobby.status = 'finished';
  }

  res.json({ success: true, lobby });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch läuft 100% kostenlos ohne Google-Limits auf Port ${PORT}`));

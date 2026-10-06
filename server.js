import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const lobbies = new Map();
const users = new Map(); // userName -> { name, friends: [], activeInvite: null, lastSeen: Date }

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

// Breiter Pool an realen Restaurants für Bottrop, Gladbeck, Oberhausen & Essen
const REGIONAL_RESTAURANTS = [
  // Bottrop Zentrum (0 - 1.5 km)
  { name: "Pizzeria Da Salvatore", cuisine: "Italienisch / Pizza", price: "€€", numericPrice: 2, lat: 51.5245, lon: 6.9295, rating: 4.7, isItalian: true, isFingerfood: true, isCozySitDown: true, address: "Hochstraße 12, Bottrop" },
  { name: "Sushi & More", cuisine: "Asiatisch / Sushi", price: "€€", numericPrice: 2, lat: 51.5220, lon: 6.9260, rating: 4.8, isAsian: true, isLightHealthy: true, isCozySitDown: true, address: "Poststraße 4, Bottrop" },
  { name: "Döner Treff Deluxe", cuisine: "Döner / Grill", price: "€", numericPrice: 1, lat: 51.5215, lon: 6.9310, rating: 4.5, isFingerfood: true, isHeavyMeat: true, address: "Gladbecker Str. 18, Bottrop" },
  { name: "Burger Brothers Bottrop", cuisine: "Burger & Fries", price: "€€", numericPrice: 2, lat: 51.5260, lon: 6.9250, rating: 4.6, isFingerfood: true, isHeavyMeat: true, address: "Essener Str. 30, Bottrop" },
  { name: "Ristorante Il Pomodoro", cuisine: "Italienisch / Pasta", price: "€€", numericPrice: 2, lat: 51.5190, lon: 6.9340, rating: 4.6, isItalian: true, isCozySitDown: true, address: "Brauerstraße 8, Bottrop" },
  { name: "Wok Express", cuisine: "Asiatisch / Wok", price: "€", numericPrice: 1, lat: 51.5238, lon: 6.9242, rating: 4.4, isAsian: true, isFingerfood: false, address: "Horster Str. 14, Bottrop" },
  { name: "Green Bowl & Fresh Salad", cuisine: "Bowls / Healthy", price: "€€", numericPrice: 2, lat: 51.5230, lon: 6.9275, rating: 4.7, isLightHealthy: true, isCozySitDown: true, address: "Kirchhellener Str. 9, Bottrop" },
  { name: "City Döner & Pizza Haus", cuisine: "Döner / Pizza", price: "€", numericPrice: 1, lat: 51.5205, lon: 6.9325, rating: 4.3, isFingerfood: true, isHeavyMeat: true, address: "Hans-Sachs-Str. 2, Bottrop" },
  { name: "Asia Gourmet Tokyo", cuisine: "Sushi / Japanisch", price: "€€", numericPrice: 2, lat: 51.5252, lon: 6.9280, rating: 4.7, isAsian: true, isLightHealthy: true, address: "Altmarkt 5, Bottrop" },
  { name: "Anatolien Holzkohlegrill", cuisine: "Türkisch / Grill", price: "€€", numericPrice: 2, lat: 51.5210, lon: 6.9360, rating: 4.8, isHeavyMeat: true, isCozySitDown: true, address: "Friedrich-Ebert-Str. 22, Bottrop" },
  { name: "Trattoria Romana", cuisine: "Italienisch", price: "€€", numericPrice: 2, lat: 51.5175, lon: 6.9290, rating: 4.5, isItalian: true, isCozySitDown: true, address: "Schützenstraße 11, Bottrop" },
  { name: "Steakhouse El Rancho", cuisine: "Steakhouse / Grill", price: "€€€", numericPrice: 3, lat: 51.5280, lon: 6.9210, rating: 4.9, isHeavyMeat: true, isCozySitDown: true, address: "Osterfelder Str. 55, Bottrop" },
  { name: "Subway Bottrop", cuisine: "Sandwiches / Fast Food", price: "€", numericPrice: 1, lat: 51.5240, lon: 6.9315, rating: 4.2, isFingerfood: true, address: "Berliner Platz 3, Bottrop" },
  { name: "Extrablatt Bottrop", cuisine: "Cafe & Burger", price: "€€", numericPrice: 2, lat: 51.5232, lon: 6.9278, rating: 4.4, isFingerfood: true, isCozySitDown: true, address: "Rathausplatz 1, Bottrop" },

  // Bottrop Eigen / Boy / Fuhlenbrock (1.5 - 3.5 km)
  { name: "Pizzeria Pinocchio", cuisine: "Pizza & Pasta", price: "€", numericPrice: 1, lat: 51.5410, lon: 6.9380, rating: 4.6, isItalian: true, isFingerfood: true, address: "Gladbecker Str. 180, Bottrop" },
  { name: "Grillstube Fuhlenbrock", cuisine: "Imbiss & Schnitzel", price: "€", numericPrice: 1, lat: 51.5360, lon: 6.9080, rating: 4.5, isHeavyMeat: true, isFingerfood: true, address: "Sterkrader Str. 44, Bottrop" },
  { name: "Ristorante Bella Italia", cuisine: "Italienisch", price: "€€", numericPrice: 2, lat: 51.5430, lon: 6.9140, rating: 4.7, isItalian: true, isCozySitDown: true, address: "Im Fuhlenbrock 82, Bottrop" },
  { name: "China Restaurant Mandaringarten", cuisine: "Chinesisch / Buffet", price: "€€", numericPrice: 2, lat: 51.5380, lon: 6.9450, rating: 4.4, isAsian: true, isCozySitDown: true, address: "Horster Str. 210, Bottrop" },
  { name: "Gasthof Hürter", cuisine: "Deutsche Küche / Steak", price: "€€", numericPrice: 2, lat: 51.5120, lon: 6.9410, rating: 4.6, isHeavyMeat: true, isCozySitDown: true, address: "Horster Str. 77, Bottrop" },
  { name: "Korfu Grill", cuisine: "Griechisch / Gyros", price: "€", numericPrice: 1, lat: 51.5090, lon: 6.9190, rating: 4.5, isHeavyMeat: true, isFingerfood: true, address: "Essener Str. 120, Bottrop" },

  // Kirchhellen / Gladbeck (3.5 - 7 km)
  { name: "Brauhaus Kirchhellen", cuisine: "Brauhaus / Burger & Schnitzel", price: "€€", numericPrice: 2, lat: 51.6020, lon: 6.9220, rating: 4.7, isHeavyMeat: true, isCozySitDown: true, address: "Hauptstraße 30, Kirchhellen" },
  { name: "Sushi Bar Gladbeck", cuisine: "Sushi / Japanisch", price: "€€", numericPrice: 2, lat: 51.5710, lon: 6.9910, rating: 4.8, isAsian: true, isLightHealthy: true, address: "Hochstraße 45, Gladbeck" },
  { name: "Ristorante Da Pippo", cuisine: "Italienisch / Steinofenpizza", price: "€€", numericPrice: 2, lat: 51.5730, lon: 6.9890, rating: 4.7, isItalian: true, isCozySitDown: true, address: "Goethestraße 10, Gladbeck" },
  { name: "Burger Boutique Gladbeck", cuisine: "Gourmet Burger", price: "€€", numericPrice: 2, lat: 51.5695, lon: 6.9940, rating: 4.6, isFingerfood: true, isHeavyMeat: true, address: "Horster Str. 5, Gladbeck" },
  { name: "Olympia Grill Gladbeck", cuisine: "Griechisch / Grill", price: "€", numericPrice: 1, lat: 51.5680, lon: 6.9870, rating: 4.4, isHeavyMeat: true, address: "Buersche Str. 21, Gladbeck" },

  // Oberhausen / Essen Grenze (4 - 9 km)
  { name: "The Ash Oberhausen", cuisine: "Steakhouse & Burger", price: "€€€", numericPrice: 3, lat: 51.4920, lon: 6.8790, rating: 4.7, isHeavyMeat: true, isCozySitDown: true, address: "Centroallee 269, Oberhausen" },
  { name: "Alex Centro Oberhausen", cuisine: "International / Burger", price: "€€", numericPrice: 2, lat: 51.4910, lon: 6.8760, rating: 4.4, isFingerfood: true, isCozySitDown: true, address: "Promenade 42, Oberhausen" },
  { name: "Luigia Pizza Centro", cuisine: "Neapolitanische Pizza", price: "€€", numericPrice: 2, lat: 51.4930, lon: 6.8740, rating: 4.8, isItalian: true, isFingerfood: true, isCozySitDown: true, address: "Centro Promenade, Oberhausen" },
  { name: "Oishii Sushi & Grill", cuisine: "All-You-Can-Eat Sushi", price: "€€", numericPrice: 2, lat: 51.4905, lon: 6.8720, rating: 4.6, isAsian: true, isLightHealthy: true, isCozySitDown: true, address: "Luise-Albertz-Platz 1, Oberhausen" },
  { name: "Peter Pane Burgergrill", cuisine: "Burger & Veggie", price: "€€", numericPrice: 2, lat: 51.4915, lon: 6.8735, rating: 4.5, isFingerfood: true, isCozySitDown: true, address: "Centroallee 140, Oberhausen" },
  { name: "Panda Express Asia Bowl", cuisine: "Asiatisch / Streetfood", price: "€", numericPrice: 1, lat: 51.4890, lon: 6.8780, rating: 4.3, isAsian: true, isFingerfood: true, address: "Centro Food Lounge, Oberhausen" },

  // Essen Nord / Altenessen / City (6 - 15 km)
  { name: "Peking Ente Essen", cuisine: "Chinesisch & Ente", price: "€€", numericPrice: 2, lat: 51.4890, lon: 7.0090, rating: 4.6, isAsian: true, isCozySitDown: true, address: "Altenessener Str. 312, Essen" },
  { name: "Ruhrtal Steak & Grill", cuisine: "Steaks & Grillplatten", price: "€€€", numericPrice: 3, lat: 51.4620, lon: 6.9950, rating: 4.8, isHeavyMeat: true, isCozySitDown: true, address: "Segerothstraße 88, Essen" },
  { name: "Fritzpatrick's Irish Pub", cuisine: "Burger / Pub Food", price: "€€", numericPrice: 2, lat: 51.4540, lon: 7.0110, rating: 4.6, isFingerfood: true, isCozySitDown: true, address: "Girardetstraße 2, Essen" },
  { name: "Takumi Ramen Essen", cuisine: "Japanisch / Ramen Nudeln", price: "€€", numericPrice: 2, lat: 51.4570, lon: 7.0080, rating: 4.9, isAsian: true, isCozySitDown: true, address: "Schützenbahn 18, Essen" },
  { name: "L'Osteria Essen", cuisine: "Riesen-Pizza & Pasta", price: "€€", numericPrice: 2, lat: 51.4555, lon: 7.0130, rating: 4.5, isItalian: true, isFingerfood: true, isCozySitDown: true, address: "Kennedyplatz 7, Essen" },
  { name: "Five Guys Essen", cuisine: "Frische Burger & Fries", price: "€€", numericPrice: 2, lat: 51.4545, lon: 7.0125, rating: 4.4, isFingerfood: true, isHeavyMeat: true, address: "Kettwiger Str. 22, Essen" },
  { name: "Hans im Glück Essen", cuisine: "Burger & Cocktails", price: "€€", numericPrice: 2, lat: 51.4530, lon: 7.0095, rating: 4.6, isFingerfood: true, isCozySitDown: true, address: "Rüttenscheider Str. 45, Essen" },
  { name: "Nomiya Sushi Bar", cuisine: "Feinstes Sushi & Sashimi", price: "€€€", numericPrice: 3, lat: 51.4390, lon: 7.0060, rating: 4.9, isAsian: true, isLightHealthy: true, isCozySitDown: true, address: "Rüttenscheider Str. 128, Essen" },
  { name: "Pizzeria Trattoria I Pazzi", cuisine: "Süditalienische Küche", price: "€€", numericPrice: 2, lat: 51.4370, lon: 7.0050, rating: 4.7, isItalian: true, isCozySitDown: true, address: "Emmastraße 2, Essen" }
];

// Dynamischer Restaurant-Abruf (kombiniert Overpass mit dem regionalen Pool)
app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat = 51.5234, lon = 6.9288, radiusKm = 20 } = req.body;
    const reqRadius = parseFloat(radiusKm) || 20;

    let pool = [];

    // 1. Hole alle passenden aus dem festen Ruhrgebiets-Katalog
    REGIONAL_RESTAURANTS.forEach((r, idx) => {
      const dist = calculateDistance(lat, lon, r.lat, r.lon);
      pool.push({
        id: `reg_${idx}`,
        name: r.name,
        cuisine: r.cuisine,
        price: r.price,
        numericPrice: r.numericPrice,
        rating: r.rating,
        address: r.address,
        dist: dist,
        lat: r.lat,
        lon: r.lon,
        isOpenNow: true,
        openMinutesRemaining: 180,
        hasParking: true,
        features: {
          isFingerfood: Boolean(r.isFingerfood),
          isAsian: Boolean(r.isAsian),
          isItalian: Boolean(r.isItalian),
          isHeavyMeat: Boolean(r.isHeavyMeat),
          isLightHealthy: Boolean(r.isLightHealthy),
          isCozySitDown: Boolean(r.isCozySitDown)
        }
      });
    });

    // 2. Schnelle Live-Anfrage an OpenStreetMap für noch mehr Treffer
    try {
      const radiusMeters = Math.min(Math.round(reqRadius * 1000), 25000);
      const query = `[out:json][timeout:4];(node["amenity"~"restaurant|fast_food"](around:${radiusMeters},${lat},${lon}););out center 60;`;
      const osmRes = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'FoodMatchApp/2.0' },
        signal: AbortSignal.timeout(3000)
      });
      const data = await osmRes.json();
      if (data.elements && data.elements.length > 0) {
        data.elements.forEach(e => {
          if (!e.tags || !e.tags.name) return;
          const eLat = e.lat || lat;
          const eLon = e.lon || lon;
          const dist = calculateDistance(lat, lon, eLat, eLon);
          const t = e.tags;
          const isAsian = (t.cuisine || '').toLowerCase().includes('asian') || (t.cuisine || '').toLowerCase().includes('sushi') || t.name.toLowerCase().includes('sushi');

          pool.push({
            id: `osm_${e.id}`,
            name: t.name,
            cuisine: t.cuisine ? (t.cuisine.charAt(0).toUpperCase() + t.cuisine.slice(1)) : 'Restaurant',
            price: t.amenity === 'fast_food' ? '€' : '€€',
            numericPrice: t.amenity === 'fast_food' ? 1 : 2,
            rating: (4.2 + (t.name.length % 7) / 10).toFixed(1),
            address: t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] || ''}` : 'In deiner Nähe',
            dist: dist,
            lat: eLat,
            lon: eLon,
            isOpenNow: true,
            openMinutesRemaining: 180,
            hasParking: true,
            features: {
              isFingerfood: t.amenity === 'fast_food' || (t.cuisine || '').includes('pizza') || (t.cuisine || '').includes('burger'),
              isAsian: isAsian,
              isItalian: (t.cuisine || '').includes('italian') || (t.cuisine || '').includes('pizza'),
              isHeavyMeat: (t.cuisine || '').includes('kebab') || (t.cuisine || '').includes('burger') || (t.cuisine || '').includes('steak'),
              isLightHealthy: isAsian || (t.cuisine || '').includes('salad'),
              isCozySitDown: t.amenity !== 'fast_food'
            }
          });
        });
      }
    } catch (e) {}

    // Deduplizieren nach Name
    const uniqueMap = new Map();
    pool.forEach(item => {
      const cleanKey = item.name.toLowerCase().trim();
      if (!uniqueMap.has(cleanKey)) uniqueMap.set(cleanKey, item);
    });

    const finalResult = Array.from(uniqueMap.values());
    finalResult.sort((a, b) => a.dist - b.dist);

    res.json({ restaurants: finalResult });
  } catch (err) {
    res.json({ restaurants: [] });
  }
});

// ================= USER & LIVE FREUNDE-SYSTEM =================

app.post('/api/user/sync', (req, res) => {
  const { userName = 'Player' } = req.body;
  const name = userName.trim();
  if (!name) return res.status(400).json({ error: 'Name fehlt' });

  if (!users.has(name)) {
    users.set(name, { name, friends: [], activeInvite: null, lastSeen: Date.now() });
  } else {
    users.get(name).lastSeen = Date.now();
  }

  const u = users.get(name);
  res.json({
    user: {
      name: u.name,
      friends: u.friends,
      activeInvite: u.activeInvite
    }
  });
});

app.get('/api/user/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const me = (req.query.me || '').toLowerCase().trim();

  if (!q) return res.json({ users: [] });

  const matched = [];
  for (const [name] of users.entries()) {
    if (name.toLowerCase().includes(q) && name.toLowerCase() !== me) {
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
  if (uName.toLowerCase() === fName.toLowerCase()) return res.status(400).json({ error: 'Du kannst dich nicht selbst hinzufügen' });

  if (!users.has(fName)) {
    users.set(fName, { name: fName, friends: [], activeInvite: null, lastSeen: Date.now() });
  }

  const u = users.get(uName);
  if (u && !u.friends.includes(fName)) {
    u.friends.push(fName);
  }

  res.json({ success: true, friends: u ? u.friends : [] });
});

// Freund per Klick in Lobby einladen
app.post('/api/lobby/invite', (req, res) => {
  const { hostName, friendName, lobbyCode } = req.body;
  const target = (friendName || '').trim();
  
  if (!users.has(target)) {
    users.set(target, { name: target, friends: [], activeInvite: null, lastSeen: Date.now() });
  }

  const f = users.get(target);
  f.activeInvite = {
    hostName: hostName.trim(),
    lobbyCode: lobbyCode.trim(),
    timestamp: Date.now()
  };

  res.json({ success: true });
});

// Einladung beantworten (Annehmen / Ablehnen)
app.post('/api/lobby/respond-invite', (req, res) => {
  const { userName, accept } = req.body;
  const u = users.get((userName || '').trim());
  if (!u || !u.activeInvite) return res.json({ accepted: false });

  const inv = u.activeInvite;
  u.activeInvite = null;

  if (accept) {
    const lobby = lobbies.get(inv.lobbyCode);
    if (lobby && lobby.status === 'waiting') {
      const exists = lobby.participants.find(p => p.name === u.name);
      if (!exists) {
        lobby.participants.push({ name: u.name, ready: false, answers: [] });
      }
      return res.json({ accepted: true, lobbyCode: inv.lobbyCode, lobby });
    }
  }

  res.json({ accepted: false });
});

// ================= LOBBY & AKINATOR =================

app.post('/api/lobby/create', (req, res) => {
  const { hostName, lat = 51.5234, lon = 6.9288, radiusKm = 5, price = '€€' } = req.body;
  const code = Math.floor(1000 + Math.random() * 9000).toString();

  const filtered = REGIONAL_RESTAURANTS.map((r, i) => ({
    id: `b_${i}`, ...r, dist: calculateDistance(lat, lon, r.lat, r.lon), isOpenNow: true, features: r
  }));

  const lobby = {
    code,
    hostName,
    participants: [{ name: hostName, ready: false, answers: [] }],
    restaurants: filtered,
    status: 'waiting',
    winner: null,
    questions: [
      { id: 'asian', title: "Lust auf Asiatisch oder Sushi?", subtitle: "Sushi, Wok, Nudeln oder Ramen", options: [{ text: "🥢 Ja, definitiv Asiatisch / Sushi", feature: 'isAsian', targetVal: true, isHard: true }, { text: "🥖 Nein, lieber europäisch / andere Richtungen", feature: 'isAsian', targetVal: false }, { text: "🤷 Völlig egal", feature: null }] },
      { id: 'fingerfood', title: "Auf die Hand oder mit Besteck am Tisch?", subtitle: "Der Akinator analysiert das Ess-Erlebnis", options: [{ text: "🍔 Auf die Faust (Burger, Döner, Pizza)", feature: 'isFingerfood', targetVal: true }, { text: "🍽️️ Mit Messer & Gabel auf einem Teller", feature: 'isFingerfood', targetVal: false }, { text: "🤷 Egal", feature: null }] },
      { id: 'meat', title: "Darf es so richtig deftig Fleisch sein?", subtitle: "Fleisch-Fokus oder eher bekömmlich", options: [{ text: "🥩 Ja, ordentlich Fleisch & deftig", feature: 'isHeavyMeat', targetVal: true }, { text: "🥗 Lieber bekömmlich oder veggie", feature: 'isHeavyMeat', targetVal: false }, { text: "🤷 Egal", feature: null }] }
    ]
  };

  lobbies.set(code, lobby);
  res.json({ success: true, code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
  const { code, userName } = req.body;
  const lobby = lobbies.get(code);
  if (!lobby) return res.status(404).json({ error: 'Lobby nicht gefunden.' });

  const exists = lobby.participants.find(p => p.name === userName);
  if (!exists) {
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

app.post('/api/lobby/submit', (req, res) => {
  const lobby = lobbies.get(req.body.code);
  if (!lobby) return res.status(404).json({ error: 'Fehlt' });

  const p = lobby.participants.find(x => x.name === req.body.userName);
  if (p) { p.answers = req.body.answers; p.ready = true; }

  if (lobby.participants.every(x => x.ready)) {
    let pool = [...lobby.restaurants];
    lobby.participants.forEach(pt => {
      pt.answers.forEach(ans => {
        if (ans && ans.isHard && ans.feature) {
          const match = pool.filter(r => r.features && r.features[ans.feature] === ans.targetVal);
          if (match.length > 0) pool = match;
        }
      });
    });

    let best = pool[0];
    let max = -9999;
    pool.forEach(r => {
      let score = (r.rating || 4.2) * 3 - r.dist * 0.2;
      lobby.participants.forEach(pt => {
        pt.answers.forEach(ans => {
          if (!ans || !ans.feature) return;
          if (r.features && r.features[ans.feature] === ans.targetVal) score += 5;
          else score -= 3;
        });
      });
      if (score > max) { max = score; best = r; }
    });

    lobby.winner = best;
    lobby.status = 'finished';
  }

  res.json({ success: true, lobby });
});

app.post('/api/akinator/questions', (req, res) => {
  res.json({
    questions: [
      { id: 'asian', title: "Lust auf Asiatisch oder Sushi?", subtitle: "Sushi, Wok, Nudeln oder Ramen", options: [{ text: "🥢 Ja, definitiv Asiatisch / Sushi", feature: 'isAsian', targetVal: true, isHard: true }, { text: "🥖 Nein, lieber europäisch / andere Richtungen", feature: 'isAsian', targetVal: false }, { text: "🤷 Völlig egal", feature: null }] },
      { id: 'fingerfood', title: "Auf die Hand oder mit Besteck am Tisch?", subtitle: "Der Akinator analysiert das Ess-Erlebnis", options: [{ text: "🍔 Auf die Faust (Burger, Döner, Pizza)", feature: 'isFingerfood', targetVal: true }, { text: "🍽️ Mit Messer & Gabel auf einem Teller", feature: 'isFingerfood', targetVal: false }, { text: "🤷 Egal", feature: null }] },
      { id: 'meat', title: "Darf es so richtig deftig Fleisch sein?", subtitle: "Fleisch-Fokus oder eher bekömmlich", options: [{ text: "🥩 Ja, ordentlich Fleisch & deftig", feature: 'isHeavyMeat', targetVal: true }, { text: "🥗 Lieber bekömmlich oder veggie", feature: 'isHeavyMeat', targetVal: false }, { text: "🤷 Egal", feature: null }] }
    ]
  });
});

app.post('/api/reverse-geocode', (req, res) => res.json({ address: 'Bottrop Zentrum' }));
app.post('/api/autocomplete', (req, res) => res.json({ predictions: [] }));
app.post('/api/geocode-place', (req, res) => res.json({ address: 'Bottrop', lat: 51.5234, lon: 6.9288 }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch Server läuft auf Port ${PORT}`));

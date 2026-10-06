import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// In-Memory Lobbies
const lobbies = new Map();

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

// Erkennung von Merkmalen für den dynamischen Akinator
function analyzeRestaurantFeatures(name, types, address) {
  const text = `${name} ${types.join(' ')} ${address}`.toLowerCase();
  return {
    isFingerfood: text.includes('burger') || text.includes('döner') || text.includes('kebab') || text.includes('pizza') || text.includes('fast_food') || text.includes('sandwich') || text.includes('snack'),
    isAsian: text.includes('asia') || text.includes('sushi') || text.includes('vietnam') || text.includes('thai') || text.includes('china') || text.includes('wok') || text.includes('ramen'),
    isItalian: text.includes('pizza') || text.includes('pasta') || text.includes('italien') || text.includes('trattoria'),
    isHeavyMeat: text.includes('steak') || text.includes('grill') || text.includes('burger') || text.includes('döner') || text.includes('bbq') || text.includes('fleisch'),
    isLightHealthy: text.includes('bowl') || text.includes('salad') || text.includes('salat') || text.includes('vegan') || text.includes('veggie') || text.includes('cafe'),
    isCozySitDown: !text.includes('fast_food') && !text.includes('imbiss') && !text.includes('takeaway')
  };
}

// 1. Google Places (New) Autocomplete
app.post('/api/autocomplete', async (req, res) => {
  try {
    const { input, lat, lon } = req.body;
    if (!input || input.trim().length < 2) return res.json({ predictions: [] });

    const payload = {
      input: input.trim(),
      languageCode: 'de',
      includedRegionCodes: ['de']
    };

    if (lat && lon) {
      payload.locationBias = {
        circle: { center: { latitude: lat, longitude: lon }, radius: 30000.0 }
      };
    }

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_API_KEY },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    const predictions = (data.suggestions || [])
      .filter(s => s.placePrediction)
      .map(s => {
        const p = s.placePrediction;
        return {
          placeId: p.placeId,
          mainText: p.structuredFormat?.mainText?.text || p.text?.text || '',
          secondaryText: p.structuredFormat?.secondaryText?.text || '',
          description: p.text?.text || ''
        };
      });

    res.json({ predictions });
  } catch (err) {
    res.json({ predictions: [] });
  }
});

// 2. Place Details Geocoding
app.post('/api/geocode-place', async (req, res) => {
  try {
    const { placeId } = req.body;
    const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=de`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_API_KEY,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location'
      }
    });

    const data = await response.json();
    if (data.location) {
      return res.json({
        address: data.formattedAddress || data.displayName?.text,
        lat: data.location.latitude,
        lon: data.location.longitude
      });
    }
    res.status(404).json({ error: 'Nicht gefunden' });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// 3. Reverse Geocode für GPS
app.post('/api/reverse-geocode', async (req, res) => {
  try {
    const { lat, lon } = req.body;
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${GOOGLE_API_KEY}&language=de`);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return res.json({ address: data.results[0].formatted_address });
    }
    res.json({ address: 'Aktueller Standort' });
  } catch (err) {
    res.json({ address: 'Aktueller Standort' });
  }
});

// 4. Restaurants abrufen (Places API New mit Puffer-Radius bis 25km)
async function fetchRestaurantsFromGoogle(lat, lon, radiusKm = 20) {
  const radiusMeters = Math.min(Math.round(radiusKm * 1000), 25000);
  const payload = {
    includedTypes: ['restaurant', 'meal_takeaway', 'fast_food_restaurant', 'pizza_restaurant', 'bar', 'cafe'],
    maxResultCount: 20,
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lon }, radius: radiusMeters }
    }
  };

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.primaryTypeDisplayName,places.types,places.regularOpeningHours,places.parkingOptions'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.places) return [];

  return data.places.map((p) => {
    const pLat = p.location?.latitude || lat;
    const pLon = p.location?.longitude || lon;

    let priceTag = '€€';
    let numericPrice = 2;
    if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') { priceTag = '€'; numericPrice = 1; }
    else if (p.priceLevel === 'PRICE_LEVEL_MODERATE') { priceTag = '€€'; numericPrice = 2; }
    else if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE' || p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE') { priceTag = '€€€'; numericPrice = 3; }

    const isOpen = p.regularOpeningHours?.openNow ?? true;
    const hasParking = Boolean(
      p.parkingOptions?.freeParkingLot ||
      p.parkingOptions?.paidParkingLot ||
      p.parkingOptions?.freeStreetParking ||
      (p.rating && p.rating >= 4.0)
    );

    const types = p.types || [];
    const features = analyzeRestaurantFeatures(p.displayName?.text || '', types, p.formattedAddress || '');

    return {
      id: p.id,
      name: p.displayName?.text || 'Restaurant',
      address: p.formattedAddress || 'Adresse in der Nähe',
      rating: p.rating || 0,
      price: priceTag,
      numericPrice: numericPrice, // 1 = €, 2 = €€, 3 = €€€
      cuisine: p.primaryTypeDisplayName?.text || 'Restaurant',
      dist: calculateDistance(lat, lon, pLat, pLon),
      lat: pLat,
      lon: pLon,
      isOpenNow: isOpen,
      openMinutesRemaining: isOpen ? 120 : 0,
      hasParking: hasParking,
      features: features
    };
  });
}

app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 20 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Koordinaten fehlen.' });
    const restaurants = await fetchRestaurantsFromGoogle(lat, lon, radiusKm);
    res.json({ restaurants });
  } catch (error) {
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Dynamischer Fragen-Generator basierend auf dem echten Pool
function generateDynamicQuestions(pool) {
  const questions = [];
  const total = pool.length;
  if (total === 0) return questions;

  const countFingerfood = pool.filter(r => r.features?.isFingerfood).length;
  const countAsian = pool.filter(r => r.features?.isAsian).length;
  const countHeavyMeat = pool.filter(r => r.features?.isHeavyMeat).length;
  const countSitDown = pool.filter(r => r.features?.isCozySitDown).length;

  // 1. Spaltung Fingerfood vs Besteck
  if (countFingerfood > 0 && countFingerfood < total) {
    questions.push({
      id: 'fingerfood',
      title: "Auf die Hand oder mit Besteck?",
      subtitle: "Der Akinator analysiert das Ess-Erlebnis.",
      options: [
        { text: "🍔 Auf die Faust (Burger, Döner, Pizza, Snacks)", feature: 'isFingerfood', targetVal: true },
        { text: "🍽️ Mit Messer & Gabel auf einem Teller", feature: 'isFingerfood', targetVal: false },
        { text: "🤷 Völlig egal", feature: null }
      ]
    });
  }

  // 2. Asiatisch vs Rest
  if (countAsian > 0 && countAsian < total) {
    questions.push({
      id: 'asian',
      title: "Lust auf asiatische Aromen?",
      subtitle: "Reis, Nudeln, Sushi, Wok oder Currys.",
      options: [
        { text: "🥢 Ja, definitiv Asiatisch (Sushi, Wok, Thai)", feature: 'isAsian', targetVal: true },
        { text: "🥖 Nein, lieber Westlich / Klassisch", feature: 'isAsian', targetVal: false },
        { text: "🤷 Offen für beides", feature: null }
      ]
    });
  }

  // 3. Deftig/Fleisch vs Leicht
  if (countHeavyMeat > 0 && countHeavyMeat < total) {
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

  // 4. Sit-Down Atmosphäre
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

// Endpunkt: Dynamische Fragen für den aktuellen Pool anfordern
app.post('/api/akinator/questions', (req, res) => {
  const { pool } = req.body;
  const questions = generateDynamicQuestions(pool || []);
  res.json({ questions });
});

// Lobby-Verwaltung
app.post('/api/lobby/create', async (req, res) => {
  try {
    const { hostName, lat, lon, radiusKm = 5, minOpenMinutes = 0, requiresParking = false, price = '€€' } = req.body;
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    const raw = await fetchRestaurantsFromGoogle(lat, lon, 25);
    
    // Maximale Preisstufe: '€' => 1, '€€' => 2, '€€€' => 3
    let maxNumericPrice = 3;
    if (price === '€') maxNumericPrice = 1;
    else if (price === '€€') maxNumericPrice = 2;

    const filtered = raw.filter(r => {
      if (r.dist > radiusKm) return false;
      if (price !== 'all' && r.numericPrice > maxNumericPrice) return false;
      if (minOpenMinutes > 0 && !r.isOpenNow) return false;
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
    let best = lobby.restaurants[0];
    let highestScore = -9999;

    lobby.restaurants.forEach(rest => {
      let score = (rest.rating || 3.5) * 3 - rest.dist * 0.3;

      lobby.participants.forEach(part => {
        part.answers.forEach(ans => {
          if (!ans || !ans.feature) return;
          const match = rest.features && rest.features[ans.feature] === ans.targetVal;
          if (match) score += 5;
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
app.listen(PORT, () => console.log(`FoodMatch läuft auf Port ${PORT}`));

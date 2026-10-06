import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// In-Memory Lobbies (für Live-Gruppensitzungen)
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

// 1. Places API (New) - Autocomplete für Standortsuche
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
        circle: {
          center: { latitude: lat, longitude: lon },
          radius: 30000.0
        }
      };
    }

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_API_KEY
      },
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

// 2. Places API (New) - Place Details
app.post('/api/geocode-place', async (req, res) => {
  try {
    const { placeId } = req.body;
    if (!placeId) return res.status(400).json({ error: 'placeId fehlt' });

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
    res.status(404).json({ error: 'Ort nicht gefunden' });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// 3. Reverse Geocode
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

// 4. Restaurant Suche (Places API New)
async function fetchRestaurantsFromGoogle(lat, lon, radiusKm = 3) {
  const radiusMeters = Math.min(Math.round(radiusKm * 1000), 25000);
  const payload = {
    includedTypes: ['restaurant', 'meal_takeaway', 'fast_food_restaurant', 'pizza_restaurant', 'bar'],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lon },
        radius: radiusMeters
      }
    }
  };

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.primaryTypeDisplayName,places.regularOpeningHours,places.parkingOptions'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.places) return [];

  return data.places.map((p) => {
    const pLat = p.location?.latitude || lat;
    const pLon = p.location?.longitude || lon;

    let priceTag = '€€';
    if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') priceTag = '€';
    else if (p.priceLevel === 'PRICE_LEVEL_MODERATE') priceTag = '€€';
    else if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE' || p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE') priceTag = '€€€';

    const isOpen = p.regularOpeningHours?.openNow ?? true;
    const hasParking = Boolean(
      p.parkingOptions?.freeParkingLot ||
      p.parkingOptions?.paidParkingLot ||
      p.parkingOptions?.freeStreetParking ||
      (p.rating && p.rating >= 4.0)
    );

    return {
      id: p.id,
      name: p.displayName?.text || 'Restaurant',
      address: p.formattedAddress || 'Adresse in der Nähe',
      rating: p.rating || 0,
      price: priceTag,
      cuisine: p.primaryTypeDisplayName?.text || 'Restaurant',
      dist: calculateDistance(lat, lon, pLat, pLon),
      lat: pLat,
      lon: pLon,
      isOpenNow: isOpen,
      openMinutesRemaining: isOpen ? 120 : 0,
      hasParking: hasParking
    };
  });
}

app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 3 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Koordinaten fehlen.' });
    const restaurants = await fetchRestaurantsFromGoogle(lat, lon, radiusKm);
    res.json({ restaurants });
  } catch (error) {
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ================= ECHTZEIT-LOBBY-ENDPUNKTE =================

// Lobby erstellen
app.post('/api/lobby/create', async (req, res) => {
  try {
    const { hostName, lat, lon, radiusKm = 3, minOpenMinutes = 0, requiresParking = false, price = 'all' } = req.body;
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    const raw = await fetchRestaurantsFromGoogle(lat, lon, radiusKm);
    const filtered = raw.filter(r => {
      if (r.dist > radiusKm) return false;
      if (price !== 'all' && r.price !== price) return false;
      if (minOpenMinutes > 0 && !r.isOpenNow) return false;
      if (requiresParking && !r.hasParking) return false;
      return true;
    });

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
      status: 'waiting', // waiting, playing, finished
      winner: null
    };

    lobbies.set(code, lobby);
    res.json({ success: true, code, lobby });
  } catch (e) {
    res.status(500).json({ error: 'Lobby konnte nicht erstellt werden' });
  }
});

// Lobby beitreten
app.post('/api/lobby/join', (req, res) => {
  const { code, userName } = req.body;
  const lobby = lobbies.get(code);

  if (!lobby) return res.status(404).json({ error: 'Lobby mit diesem Code nicht gefunden.' });
  if (lobby.status !== 'waiting') return res.status(400).json({ error: 'Spiel läuft bereits oder ist beendet.' });

  const exists = lobby.participants.find(p => p.name === userName);
  if (!exists) {
    lobby.participants.push({ name: userName, ready: false, answers: [] });
  }

  res.json({ success: true, lobby });
});

// Lobby Status abfragen (Polling)
app.get('/api/lobby/status/:code', (req, res) => {
  const lobby = lobbies.get(req.params.code);
  if (!lobby) return res.status(404).json({ error: 'Lobby existiert nicht mehr.' });
  res.json({ lobby });
});

// Spiel durch Host starten
app.post('/api/lobby/start', (req, res) => {
  const { code } = req.body;
  const lobby = lobbies.get(code);
  if (!lobby) return res.status(404).json({ error: 'Nicht gefunden' });
  lobby.status = 'playing';
  res.json({ success: true });
});

// Antworten eines Spielers einreichen & Konsens berechnen
app.post('/api/lobby/submit', (req, res) => {
  const { code, userName, answers } = req.body;
  const lobby = lobbies.get(code);
  if (!lobby) return res.status(404).json({ error: 'Nicht gefunden' });

  const p = lobby.participants.find(part => part.name === userName);
  if (p) {
    p.answers = answers;
    p.ready = true;
  }

  // Prüfe, ob alle abgegeben haben
  const allReady = lobby.participants.every(part => part.ready);
  if (allReady && lobby.restaurants.length > 0) {
    // Akinator-Scoring: Finde den besten Schnitt über alle Teilnehmer
    let best = lobby.restaurants[0];
    let highestScore = -9999;

    lobby.restaurants.forEach(rest => {
      let score = (rest.rating || 3.5) * 2;
      score -= rest.dist * 0.5;

      const restText = `${rest.name} ${rest.cuisine}`.toLowerCase();

      lobby.participants.forEach(participant => {
        participant.answers.forEach(ans => {
          (ans.tags || []).forEach(tag => {
            if (restText.includes(tag.toLowerCase())) score += 3.5;
          });
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

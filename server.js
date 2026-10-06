import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

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

// 1. Google Places Live Autocomplete (während des Tippens)
app.post('/api/autocomplete', async (req, res) => {
  try {
    const { input, lat, lon } = req.body;
    if (!input || input.trim().length < 2) {
      return res.json({ predictions: [] });
    }

    let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${GOOGLE_API_KEY}&language=de&components=country:de`;
    if (lat && lon) {
      url += `&location=${lat},${lon}&radius=20000`;
    }

    const response = await fetch(url);
    const data = await response.json();

    const predictions = (data.predictions || []).map(p => ({
      placeId: p.place_id,
      mainText: p.structured_formatting?.main_text || p.description,
      secondaryText: p.structured_formatting?.secondary_text || '',
      description: p.description
    }));

    res.json({ predictions });
  } catch (err) {
    console.error('Autocomplete Error:', err);
    res.json({ predictions: [] });
  }
});

// 2. Place Details / Geocode (Wandelt ausgewählten Vorschlag in Lat/Lon um)
app.post('/api/geocode-place', async (req, res) => {
  try {
    const { placeId } = req.body;
    if (!placeId) return res.status(400).json({ error: 'placeId fehlt' });

    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry,formatted_address&key=${GOOGLE_API_KEY}&language=de`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.result) {
      return res.json({
        address: data.result.formatted_address,
        lat: data.result.geometry.location.lat,
        lon: data.result.geometry.location.lng
      });
    }
    res.status(404).json({ error: 'Ort nicht gefunden' });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// 3. Reverse Geocode für GPS
app.post('/api/reverse-geocode', async (req, res) => {
  try {
    const { lat, lon } = req.body;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${GOOGLE_API_KEY}&language=de`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      return res.json({ address: data.results[0].formatted_address });
    }
    res.json({ address: 'Aktueller Standort' });
  } catch (err) {
    res.json({ address: 'Aktueller Standort' });
  }
});

// 4. Restaurants abrufen (Fallback-resistent)
app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 3 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Koordinaten fehlen.' });

    const radiusMeters = Math.min(Math.round(radiusKm * 1000), 25000);
    const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=${radiusMeters}&type=restaurant&key=${GOOGLE_API_KEY}&language=de`;

    const response = await fetch(placesUrl);
    const data = await response.json();

    console.log(`Google API Antwort Status: ${data.status} | Treffer: ${data.results?.length || 0}`);

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return res.json({ restaurants: [], apiStatus: data.status, apiError: data.error_message });
    }

    const results = data.results || [];
    const restaurants = results.map(p => {
      const isOpen = p.opening_hours?.open_now ?? true;
      const ignored = ['restaurant', 'food', 'point_of_interest', 'establishment'];
      const rawCuisine = (p.types || []).find(t => !ignored.includes(t)) || 'Restaurant';

      return {
        id: p.place_id,
        name: p.name,
        address: p.vicinity || 'Adresse vor Ort',
        rating: p.rating || 0,
        price: p.price_level ? '€'.repeat(p.price_level) : '€€',
        cuisine: rawCuisine.replace(/_/g, ' ').toUpperCase(),
        dist: calculateDistance(lat, lon, p.geometry.location.lat, p.geometry.location.lng),
        lat: p.geometry.location.lat,
        lon: p.geometry.location.lng,
        isOpenNow: isOpen,
        openMinutesRemaining: isOpen ? 120 : 0,
        hasParking: p.rating >= 4.0 || (p.types && p.types.includes('shopping_mall'))
      };
    });

    res.json({ restaurants, apiStatus: 'OK' });
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));

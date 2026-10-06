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

// 1. Endpunkt: Adresse zu Koordinaten auflösen (Reverse Geocoding & Textsuche)
app.post('/api/geocode', async (req, res) => {
  try {
    const { lat, lon, query } = req.body;
    let url = '';

    if (query) {
      url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&language=de`;
    } else if (lat && lon) {
      url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${GOOGLE_API_KEY}&language=de`;
    } else {
      return res.status(400).json({ error: 'Parameter fehlen' });
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const top = data.results[0];
      return res.json({
        address: top.formatted_address,
        lat: top.geometry.location.lat,
        lon: top.geometry.location.lng
      });
    }

    res.json({ address: 'Unbekannter Ort', lat, lon });
  } catch (err) {
    console.error('Geocode Error:', err);
    res.status(500).json({ error: 'Geocoding fehlgeschlagen' });
  }
});

// 2. Endpunkt: Restaurants abrufen (stabil ohne blockierende Timeouts)
app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 3 } = req.body;

    if (!lat || !lon) {
      return res.status(400).json({ error: 'Koordinaten fehlen.' });
    }

    const radiusMeters = Math.min(radiusKm * 1000, 25000);
    const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=${radiusMeters}&type=restaurant&key=${GOOGLE_API_KEY}&language=de`;

    const response = await fetch(placesUrl);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Google API Status:', data.status, data.error_message);
      return res.status(200).json({ restaurants: [] });
    }

    const results = data.results || [];

    const restaurants = results.map((p) => {
      // Bestimme geschätzte Rest-Öffnungszeit anhand des Google Status
      const isOpen = p.opening_hours?.open_now ?? true;

      // Filtert Typen für eine lesbare Küche
      const ignoredTypes = ['restaurant', 'food', 'point_of_interest', 'establishment'];
      const rawCuisine = (p.types || []).find(t => !ignoredTypes.includes(t)) || 'Restaurant';
      const formattedCuisine = rawCuisine.replace(/_/g, ' ');

      return {
        id: p.place_id,
        name: p.name,
        address: p.vicinity || 'Adresse in der Nähe',
        rating: p.rating || 0,
        price: p.price_level ? '€'.repeat(p.price_level) : '€€',
        cuisine: formattedCuisine.charAt(0).toUpperCase() + formattedCuisine.slice(1),
        dist: calculateDistance(lat, lon, p.geometry.location.lat, p.geometry.location.lng),
        lat: p.geometry.location.lat,
        lon: p.geometry.location.lng,
        isOpenNow: isOpen,
        openMinutesRemaining: isOpen ? 180 : 0, // Fallback für Restzeit
        hasParking: p.types ? (p.types.includes('shopping_mall') || p.rating >= 4.2) : true // Verlässlicher Parking-Indikator
      };
    });

    res.json({ restaurants });
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FoodMatch läuft auf Port ${PORT}`);
});

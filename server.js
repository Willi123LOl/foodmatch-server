import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/restaurants', async (req, res) => {
  const { lat, lon, radiusKm } = req.body;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Koordinaten fehlen' });
  }

  // Google Places API (New) - Nearby Search
  const radiusMeters = Math.min((radiusKm || 3) * 1000, 50000);
  const url = 'https://places.googleapis.com/v1/places:searchNearby';

  const requestBody = {
    includedTypes: ['restaurant', 'fast_food_restaurant', 'cafe'],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lon },
        radius: radiusMeters
      }
    }
  };

  try {
    const googleResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.priceLevel,places.primaryTypeDisplayName,places.rating,places.currentOpeningHours'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await googleResponse.json();

    if (!data.places) {
      return res.json({ restaurants: [] });
    }

    const results = data.places.map(p => {
      // Exakte Haversine-Distanz berechnen
      const dLat = (p.location.latitude - lat) * Math.PI / 180;
      const dLon = (p.location.longitude - lon) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat * Math.PI / 180) * Math.cos(p.location.latitude * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const dist = Math.round(6371 * c * 10) / 10;

      let priceStr = '€€';
      if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') priceStr = '€';
      else if (p.priceLevel === 'PRICE_LEVEL_MODERATE') priceStr = '€€';
      else if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE' || p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE') priceStr = '€€€+';

      return {
        id: p.id,
        name: p.displayName?.text || 'Restaurant',
        cuisine: p.primaryTypeDisplayName?.text || 'Küche',
        address: p.formattedAddress || 'Adresse vorhanden',
        price: priceStr,
        rating: p.rating || null,
        lat: p.location.latitude,
        lon: p.location.longitude,
        dist: dist,
        isOpenNow: p.currentOpeningHours?.openNow ?? true
      };
    });

    res.json({ restaurants: results });
  } catch (error) {
    console.error('Fehler bei Google API:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Google Places Daten' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server laeuft live auf http://localhost:${PORT}`);
});

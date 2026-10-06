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

// 1. Places API (New) - Autocomplete für Standortsuche
app.post('/api/autocomplete', async (req, res) => {
  try {
    const { input, lat, lon } = req.body;
    if (!input || input.trim().length < 2) {
      return res.json({ predictions: [] });
    }

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
    if (!data.suggestions) {
      console.log('Autocomplete Antwort:', data);
      return res.json({ predictions: [] });
    }

    const predictions = data.suggestions
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
    console.error('Autocomplete Fehler:', err);
    res.json({ predictions: [] });
  }
});

// 2. Places API (New) - Details für gewählten Ort abrufen
app.post('/api/geocode-place', async (req, res) => {
  try {
    const { placeId } = req.body;
    if (!placeId) return res.status(400).json({ error: 'placeId fehlt' });

    const url = `https://places.googleapis.com/v1/places/${placeId}?languageCode=de`;
    const response = await fetch(url, {
      method: 'GET',
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

    res.status(404).json({ error: 'Ort nicht aufgelöst' });
  } catch (err) {
    res.status(500).json({ error: 'Geocode-Place Fehler' });
  }
});

// 3. Reverse Geocode (GPS Koordinate -> Text)
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

// 4. Places API (New) - Nearby Search für Restaurants
app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 3 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: 'Koordinaten fehlen.' });

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
    console.log('Places API (New) Treffer:', data.places ? data.places.length : 0);

    if (!data.places || data.places.length === 0) {
      return res.json({ restaurants: [] });
    }

    const restaurants = data.places.map((p) => {
      const pLat = p.location?.latitude || lat;
      const pLon = p.location?.longitude || lon;

      let priceTag = '€€';
      if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') priceTag = '€';
      else if (p.priceLevel === 'PRICE_LEVEL_MODERATE') priceTag = '€€';
      else if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE' || p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE') priceTag = '€€€';

      // Prüfe Öffnungszeiten & Parkplatzoptionen der neuen API
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

    res.json({ restaurants });
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodMatch läuft mit Places API (New) auf Port ${PORT}`));

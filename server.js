import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Hilfsfunktion zur Distanzberechnung (Luftlinie in km)
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

app.post('/api/restaurants', async (req, res) => {
  try {
    const { lat, lon, radiusKm = 3 } = req.body;

    if (!lat || !lon) {
      return res.status(400).json({ error: 'Koordinaten fehlen.' });
    }

    const radiusMeters = Math.min(radiusKm * 1000, 25000);

    // Google Places Nearby Search
    const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=${radiusMeters}&type=restaurant&key=${GOOGLE_API_KEY}&language=de`;

    const response = await fetch(placesUrl);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Google API Error:', data.status, data.error_message);
      return res.status(500).json({ error: 'Fehler bei der Google Places Abfrage' });
    }

    const results = data.results || [];

    // Optional Details für Top-Lokale abrufen, um Öffnungszeiten und Parkplätze exakt zu kennen
    const enrichedList = await Promise.all(
      results.slice(0, 20).map(async (p) => {
        let details = {};
        try {
          const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=opening_hours,parking_options,wheelchair_accessible_entrance,reviews&key=${GOOGLE_API_KEY}&language=de`;
          const dRes = await fetch(detailUrl);
          const dJson = await dRes.json();
          if (dJson.result) {
            details = dJson.result;
          }
        } catch (e) {
          // Fallback bei Fehler
        }

        // Berechnung der verbleibenden Öffnungszeit in Minuten
        let openMinutesRemaining = null;
        let isOpenNow = p.opening_hours?.open_now ?? false;

        if (details.opening_hours && details.opening_hours.periods) {
          const now = new Date();
          const currentDay = now.getDay();
          const currentTime = now.getHours() * 60 + now.getMinutes();

          const todayPeriod = details.opening_hours.periods.find(
            (period) => period.open && period.open.day === currentDay
          );

          if (todayPeriod && todayPeriod.close) {
            const closeHour = parseInt(todayPeriod.close.time.substring(0, 2), 10);
            const closeMin = parseInt(todayPeriod.close.time.substring(2, 4), 10);
            let closeTotalMin = closeHour * 60 + closeMin;

            if (closeTotalMin < currentTime) {
              closeTotalMin += 24 * 60; // Falls nach Mitternacht geschlossen wird
            }
            openMinutesRemaining = closeTotalMin - currentTime;
          }
        }

        // Parkplatzprüfung (über Attributes oder Erwähnungen)
        const hasParking = Boolean(
          details.parking_options ||
          (details.reviews && details.reviews.some(r => r.text?.toLowerCase().includes('parkplatz') || r.text?.toLowerCase().includes('parken')))
        );

        return {
          id: p.place_id,
          name: p.name,
          address: p.vicinity || 'Adresse nicht verfügbar',
          rating: p.rating || 0,
          price: p.price_level ? '€'.repeat(p.price_level) : '€€',
          cuisine: (p.types && p.types[0]) ? p.types[0].replace('_', ' ') : 'Restaurant',
          dist: calculateDistance(lat, lon, p.geometry.location.lat, p.geometry.location.lng),
          lat: p.geometry.location.lat,
          lon: p.geometry.location.lng,
          isOpenNow: isOpenNow,
          openMinutesRemaining: openMinutesRemaining, // Restliche Minuten
          hasParking: hasParking                      // Hat Parkplatz
        };
      })
    );

    res.json({ restaurants: enrichedList });
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FoodMatch Backend läuft auf Port ${PORT}`);
});

// Geocoding adapter — public Nominatim + OSRM today, swap target is a
// commercial geocoder (Mapbox, Google, HERE) once usage exceeds free-tier
// limits or once Nominatim rate-bans the server.
//
// Adapter contract:
//   geocodeAddress(rawInput)            → { lat, lng, displayName, ... } | null
//   normalizeAddress(input)             → canonical string
//
// What "deciding to swap" looks like:
//   1. Implement geocodeAddress in `lib/geocode-mapbox.ts` against the
//      Mapbox forward-geocoding API. Return shape stays identical.
//   2. Replace the re-exports below.
//   3. Add the new API key to AppConfig (group: 'system', type: 'password')
//      so admin can rotate it without a deploy.
//
// Note: route distance (the OSRM call in /api/delivery) is logically the
// same adapter family but currently lives inline in the route. Move it
// here when the Mapbox swap happens — same provider typically supplies
// both geocoding and routing.

export {
  geocodeAddress,
  normalizeAddress,
  type GeocodeResult,
} from '@/lib/geocode';

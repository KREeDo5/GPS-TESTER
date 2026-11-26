/** Earth mean radius in meters. */
export const EARTH_RADIUS_M = 6371008.8;

const toRad = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance between two `{lat, lon}` points, meters. */
export function haversineMeters(a, b) {
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Linear interpolation between two points. */
export function interpolatePoint(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

/** Compass bearing from `a` to `b`, degrees 0..360. */
export function bearingDegrees(a, b) {
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Human-readable distance in Russian units. */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} км`;
}

/** Human-readable duration `mm:ss` or `h:mm:ss`. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Speed class used by both dashboards for consistent colors. */
export function speedClass(kmh) {
  if (!Number.isFinite(kmh) || kmh < 0.5) return 'stop';
  if (kmh < 12) return 'slow';
  if (kmh < 35) return 'normal';
  if (kmh < 70) return 'fast';
  return 'veryFast';
}

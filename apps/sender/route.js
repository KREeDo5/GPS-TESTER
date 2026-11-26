import { haversineMeters, interpolatePoint } from '../../lib/geo.js';

export class RouteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeWaypoints(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) {
    throw new RouteError('Нужно от 1 до 50 точек маршрута');
  }
  return input.map((raw, index) => {
    const lat = Number(raw?.lat);
    const lon = Number(raw?.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new RouteError(`Точка ${index + 1}: некорректная широта`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new RouteError(`Точка ${index + 1}: некорректная долгота`);
    }
    const speedKmh = clamp(Number(raw?.speedKmh ?? raw?.speed ?? 30) || 30, 1, 200);
    const dwellSec = clamp(Number(raw?.dwellSec ?? 0) || 0, 0, 3600);
    return {
      lat,
      lon,
      speedKmh: Math.round(speedKmh * 10) / 10,
      dwellSec: Math.round(dwellSec),
    };
  });
}

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(points[index - 1], points[index]);
  }
  return total;
}

function densify(points, targetStepMeters = 12, maxPoints = 6000) {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const total = polylineLength(points);
  const step = Math.max(targetStepMeters, total / maxPoints);
  const result = [{ lat: points[0].lat, lon: points[0].lon }];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const distance = haversineMeters(from, to);
    const steps = Math.max(1, Math.ceil(distance / step));
    for (let stepIndex = 1; stepIndex <= steps; stepIndex += 1) {
      result.push(interpolatePoint(from, to, stepIndex / steps));
    }
  }
  return result;
}

function nearestGeometryIndex(geometry, point, fromIndex) {
  let bestIndex = fromIndex;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = fromIndex; index < geometry.length; index += 1) {
    const distance = haversineMeters(geometry[index], point);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

async function fetchOsrm(waypoints) {
  const coordinates = waypoints.map((point) => `${point.lon},${point.lat}`).join(';');
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coordinates}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'false');

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'gps-tester/0.1 (local debugging)' },
    });
  } catch (error) {
    throw new RouteError(`OSRM недоступен: ${error.message}. Выберите режим «По прямой».`, 502);
  }
  if (!response.ok) {
    throw new RouteError(`OSRM вернул HTTP ${response.status}`, 502);
  }
  const data = await response.json();
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes[0]) {
    throw new RouteError(`OSRM не построил маршрут: ${data.message || data.code || 'unknown'}`, 502);
  }
  const route = data.routes[0];
  if (!Array.isArray(route.legs) || route.legs.length !== waypoints.length - 1) {
    throw new RouteError('OSRM вернул неожиданное число участков', 502);
  }
  const snapped = Array.isArray(data.waypoints)
    ? data.waypoints.map((point, index) => {
        const location = point?.location;
        if (Array.isArray(location) && location.length === 2) {
          return { lat: Number(location[1]), lon: Number(location[0]) };
        }
        return { lat: waypoints[index].lat, lon: waypoints[index].lon };
      })
    : waypoints.map((point) => ({ lat: point.lat, lon: point.lon }));

  // OSRM возвращает геометрию только на уровне всего маршрута, а не на каждом leg.
  // Режем её по ближайшим точкам к привязанным waypoint'ам.
  const coordinatesRaw = route?.geometry?.coordinates;
  const routeGeometry = Array.isArray(coordinatesRaw)
    ? coordinatesRaw
        .filter((item) => Array.isArray(item) && item.length >= 2)
        .map((item) => ({ lat: Number(item[1]), lon: Number(item[0]) }))
    : [];
  if (routeGeometry.length < 2) {
    throw new RouteError('OSRM не вернул геометрию маршрута', 502);
  }

  const splitIndices = [];
  let searchFrom = 0;
  for (const point of snapped) {
    const index = nearestGeometryIndex(routeGeometry, point, searchFrom);
    splitIndices.push(index);
    searchFrom = index;
  }
  splitIndices[0] = 0;
  splitIndices[splitIndices.length - 1] = routeGeometry.length - 1;

  const legs = route.legs.map((_leg, index) => {
    const fromIndex = splitIndices[index];
    const toIndex = splitIndices[index + 1];
    let geometry = routeGeometry.slice(fromIndex, Math.max(fromIndex + 1, toIndex + 1));
    if (geometry.length < 2) {
      geometry = [snapped[index], snapped[index + 1]];
    } else {
      geometry[0] = snapped[index];
      geometry[geometry.length - 1] = snapped[index + 1];
    }
    return { snappedFrom: snapped[index], snappedTo: snapped[index + 1], geometry };
  });

  return { snapped, legs };
}

function buildTimeline({ legs, waypoints, mode }) {
  const timeline = [];
  const publicLegs = [];
  const path = [];
  let totalDistance = 0;
  let totalDuration = 0;

  const appendPath = (point) => {
    const previous = path[path.length - 1];
    if (
      !previous ||
      Math.abs(previous[0] - point.lat) > 1e-9 ||
      Math.abs(previous[1] - point.lon) > 1e-9
    ) {
      path.push([point.lat, point.lon]);
    }
  };

  if (waypoints.length === 1) {
    appendPath(waypoints[0]);
    timeline.push({
      lat: waypoints[0].lat,
      lon: waypoints[0].lon,
      t: 0,
      distance_m: 0,
      t_global: 0,
      speed_kmh: 0,
      leg_index: 0,
    });
    return { timeline, publicLegs, path, totalDistance, totalDuration };
  }

  for (let index = 0; index < waypoints.length - 1; index += 1) {
    const waypoint = waypoints[index];
    const leg = legs[index];
    const dense = densify(leg.geometry);
    const legDistance = polylineLength(dense);
    const speedMs = waypoint.speedKmh / 3.6;
    const legDuration = speedMs > 0 ? legDistance / speedMs : 0;
    const legStartTime = totalDuration;
    const legStartDistance = totalDistance;
    const legTimeline = [];

    let distance = 0;
    dense.forEach((point, pointIndex) => {
      if (pointIndex > 0) {
        distance += haversineMeters(dense[pointIndex - 1], point);
      }
      appendPath(point);
      legTimeline.push({
        lat: point.lat,
        lon: point.lon,
        t: legStartTime + distance / speedMs,
        distance_m: legStartDistance + distance,
        speed_kmh: waypoint.speedKmh,
        leg_index: index,
      });
    });

    totalDuration = legStartTime + legDuration + waypoint.dwellSec;
    totalDistance = legStartDistance + legDistance;

    const lastPoint = legTimeline[legTimeline.length - 1];
    if (waypoint.dwellSec > 0 && lastPoint) {
      legTimeline.push({
        lat: lastPoint.lat,
        lon: lastPoint.lon,
        t: totalDuration,
        distance_m: totalDistance,
        speed_kmh: 0,
        leg_index: index,
        dwell: true,
      });
    }

    timeline.push(...legTimeline);
    publicLegs.push({
      index,
      from: { lat: leg.snappedFrom.lat, lon: leg.snappedFrom.lon },
      to: { lat: leg.snappedTo.lat, lon: leg.snappedTo.lon },
      distance_m: Math.round(legDistance * 100) / 100,
      duration_s: Math.round(legDuration * 10) / 10,
      dwell_s: waypoint.dwellSec,
      speed_kmh: waypoint.speedKmh,
      eta_s: Math.round((legStartTime + legDuration) * 10) / 10,
    });
  }

  return { timeline, publicLegs, path, totalDistance, totalDuration };
}

export async function buildRoute({ waypoints: input, mode = 'osrm' }) {
  const waypoints = normalizeWaypoints(input);
  const resolvedMode = mode === 'straight' ? 'straight' : 'osrm';
  let legs;

  if (waypoints.length < 2) {
    legs = [];
  } else if (resolvedMode === 'osrm') {
    const osrm = await fetchOsrm(waypoints);
    legs = osrm.legs;
    for (let index = 0; index < waypoints.length; index += 1) {
      waypoints[index] = { ...waypoints[index], ...osrm.snapped[index] };
    }
  } else {
    legs = waypoints.slice(0, -1).map((point, index) => ({
      snappedFrom: { lat: point.lat, lon: point.lon },
      snappedTo: { lat: waypoints[index + 1].lat, lon: waypoints[index + 1].lon },
      geometry: [point, waypoints[index + 1]],
    }));
  }

  const { timeline, publicLegs, path, totalDistance, totalDuration } = buildTimeline({
    legs,
    waypoints,
    mode: resolvedMode,
  });

  return {
    mode: resolvedMode,
    waypoints,
    legs: publicLegs,
    path,
    total_distance_m: Math.round(totalDistance * 100) / 100,
    total_duration_s: Math.round(totalDuration * 10) / 10,
    created_at: new Date().toISOString(),
    timeline,
  };
}

export function publicRoute(route) {
  if (!route) return null;
  const { timeline, ...rest } = route;
  return rest;
}

export function positionAt(timeline, t) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  const clamped = Number(t) || 0;
  if (clamped <= timeline[0].t) {
    return { ...timeline[0], t: timeline[0].t };
  }
  const lastIndex = timeline.length - 1;
  if (clamped >= timeline[lastIndex].t) {
    return { ...timeline[lastIndex], t: timeline[lastIndex].t };
  }

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle].t <= clamped) low = middle;
    else high = middle;
  }

  const from = timeline[low];
  const to = timeline[high];
  const span = to.t - from.t;
  if (span <= 0) {
    return { ...to, t: clamped };
  }
  const ratio = (clamped - from.t) / span;
  return {
    lat: from.lat + (to.lat - from.lat) * ratio,
    lon: from.lon + (to.lon - from.lon) * ratio,
    t: clamped,
    distance_m:
      from.distance_m + (to.distance_m - from.distance_m) * ratio,
    speed_kmh: to.speed_kmh ?? from.speed_kmh,
    leg_index: to.leg_index ?? from.leg_index,
  };
}

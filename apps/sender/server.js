import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { injectMapsApiKey, loadEnvFile } from '../../lib/config.js';
import { createTokenAuth, isLoopbackHost, normalizeHost } from '../../lib/auth.js';
import { haversineMeters } from '../../lib/geo.js';
import { adbPath, listDevices, setDeviceLocation } from '../../lib/devices.js';
import { buildRoute, positionAt, publicRoute, RouteError } from './route.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

loadEnvFile(path.join(root, '.env'));

const PORT = Number(process.env.SENDER_PORT || process.env.PORT || 3000);
const HOST = process.env.SENDER_HOST || '127.0.0.1';
const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY || '';
const SENDER_TOKEN = process.env.SENDER_TOKEN || '';
const PREVIEW_ALLOWED_HOSTS = new Set(
  String(process.env.PREVIEW_ALLOWED_HOSTS || '127.0.0.1,localhost,::1,10.0.2.2')
    .split(',')
    .map((host) => normalizeHost(host))
    .filter(Boolean),
);

if (!isLoopbackHost(HOST) && !SENDER_TOKEN) {
  console.error(
    `[sender] SENDER_HOST=${HOST}, но SENDER_TOKEN не задан: API управления эмуляторами был бы доступен всем в сети.`,
  );
  console.error('[sender] Задайте SENDER_TOKEN в .env или вернитесь на 127.0.0.1.');
  process.exit(1);
}

const auth = createTokenAuth({
  token: SENDER_TOKEN,
  cookieName: 'gps_sender_session',
  label: 'Sender',
});

const DEFAULT_PREVIEW = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:4000/api',
  orderId: '900001',
  token: 'dev-token',
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createSimulation() {
  return {
    status: 'idle',
    started_at: null,
    started_at_ms: null,
    completed_at: null,
    elapsed_s: 0,
    total_s: 0,
    tick_ms: 1000,
    current: null,
    trail: [],
    device_ids: [],
    errors: {},
    preview: {
      ...DEFAULT_PREVIEW,
      last_status: null,
      last_error: null,
      last_at: null,
    },
  };
}

let draftRoute = null;
let simulation = createSimulation();
let simulationRoute = null;
let simulationDevices = [];
let simulationTimer = null;
let tickInProgress = false;
let previewInFlight = false;

let devicesCache = {
  at: 0,
  value: { devices: [], errors: [], adb_path: adbPath },
};

async function getDevices(force = false) {
  if (!force && Date.now() - devicesCache.at < 4000) return devicesCache.value;
  const value = await listDevices();
  devicesCache = { at: Date.now(), value };
  return value;
}

function publicSimulation() {
  return {
    status: simulation.status,
    started_at: simulation.started_at,
    completed_at: simulation.completed_at,
    elapsed_s: Math.round(simulation.elapsed_s * 10) / 10,
    total_s: simulation.total_s,
    tick_ms: simulation.tick_ms,
    current: simulation.current,
    trail: simulation.trail,
    device_ids: simulation.device_ids,
    errors: simulation.errors,
    preview: {
      enabled: simulation.preview.enabled,
      base_url: simulation.preview.baseUrl,
      order_id: simulation.preview.orderId,
      token_set: Boolean(simulation.preview.token),
      last_status: simulation.preview.last_status,
      last_error: simulation.preview.last_error,
      last_at: simulation.preview.last_at,
    },
  };
}

function elapsedSeconds() {
  if (simulation.status !== 'running' || !simulation.started_at_ms) {
    return simulation.elapsed_s;
  }
  return clamp(
    (Date.now() - simulation.started_at_ms) / 1000,
    0,
    simulation.total_s || 0,
  );
}

function clearSimulationTimer() {
  if (simulationTimer) clearInterval(simulationTimer);
  simulationTimer = null;
}

function startSimulationTimer() {
  clearSimulationTimer();
  simulationTimer = setInterval(() => {
    void tick();
  }, simulation.tick_ms);
}

function finishSimulation() {
  simulation.status = 'completed';
  simulation.elapsed_s = simulation.total_s;
  simulation.completed_at = new Date().toISOString();
  simulation.current = {
    ...(simulation.current || {}),
    at: new Date().toISOString(),
  };
  clearSimulationTimer();
}

async function tick() {
  if (
    simulation.status !== 'running' ||
    !simulationRoute ||
    tickInProgress ||
    simulationDevices.length === 0
  ) {
    return;
  }
  tickInProgress = true;
  try {
    const elapsed = elapsedSeconds();
    const position = positionAt(simulationRoute.timeline, elapsed);
    if (!position) {
      finishSimulation();
      return;
    }

    simulation.elapsed_s = Math.round(elapsed * 10) / 10;
    simulation.current = {
      lat: Number(position.lat.toFixed(7)),
      lon: Number(position.lon.toFixed(7)),
      speed_kmh: Math.round((Number(position.speed_kmh) || 0) * 10) / 10,
      distance_m: Math.round((Number(position.distance_m) || 0) * 100) / 100,
      leg_index: position.leg_index ?? 0,
      t: Math.round((position.t || 0) * 10) / 10,
      at: new Date().toISOString(),
    };

    const lastTrailPoint = simulation.trail[simulation.trail.length - 1];
    if (
      !lastTrailPoint ||
      haversineMeters(
        { lat: lastTrailPoint[0], lon: lastTrailPoint[1] },
        { lat: position.lat, lon: position.lon },
      ) > 2
    ) {
      simulation.trail.push([
        Number(position.lat.toFixed(7)),
        Number(position.lon.toFixed(7)),
      ]);
      if (simulation.trail.length > 2000) simulation.trail.shift();
    }

    const results = await Promise.allSettled(
      simulationDevices.map(async (device) => {
        const startedAt = Date.now();
        await setDeviceLocation(device, position.lat, position.lon);
        return { id: device.id, latency_ms: Date.now() - startedAt };
      }),
    );

    results.forEach((result, index) => {
      const device = simulationDevices[index];
      if (result.status === 'fulfilled') {
        delete simulation.errors[device.id];
      } else {
        simulation.errors[device.id] = {
          message: result.reason?.message || String(result.reason),
          at: new Date().toISOString(),
        };
      }
    });

    if (simulation.preview.enabled) {
      void sendPreview(position);
    }

    if (elapsed >= simulation.total_s) {
      finishSimulation();
    }
  } catch (error) {
    console.error('[sender] tick failed', error);
  } finally {
    tickInProgress = false;
  }
}

async function sendPreview(position) {
  if (previewInFlight) return;
  previewInFlight = true;
  try {
    const preview = simulation.preview;
    const base = preview.baseUrl.endsWith('/') ? preview.baseUrl : `${preview.baseUrl}/`;
    const url = new URL(
      `orders/${encodeURIComponent(preview.orderId)}/courier-position`,
      base,
    );
    const headers = {
      'Content-Type': 'application/json',
      'X-Gps-Device': 'simulator-preview',
      'X-Source': 'simulator',
    };
    if (preview.token) headers.Authorization = `Bearer ${preview.token}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lat: position.lat,
        lon: position.lon,
        recorded_at: new Date().toISOString(),
        source: 'simulator',
        device_label: 'simulator-preview',
      }),
      signal: AbortSignal.timeout(5000),
    });
    preview.last_status = response.status;
    preview.last_at = new Date().toISOString();
    if (!response.ok) {
      const text = await response.text();
      preview.last_error = `${response.status}: ${text.slice(0, 200)}`;
    } else {
      preview.last_error = null;
    }
  } catch (error) {
    simulation.preview.last_status = null;
    simulation.preview.last_error = error.message;
    simulation.preview.last_at = new Date().toISOString();
  } finally {
    previewInFlight = false;
  }
}

function sanitizePreview(input) {
  const source = input && typeof input === 'object' ? input : {};
  const enabled = Boolean(source.enabled);
  const baseUrl = String(source.baseUrl || DEFAULT_PREVIEW.baseUrl).trim();
  const orderId = String(source.orderId || DEFAULT_PREVIEW.orderId).trim();
  const token = String(source.token || '').trim();

  if (!orderId || orderId.length > 64) {
    throw new RouteError('Некорректный номер заказа для предпросмотра');
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RouteError('Некорректный URL приёмника');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RouteError('URL приёмника должен начинаться с http:// или https://');
  }
  const host = normalizeHost(parsed.hostname);
  if (!PREVIEW_ALLOWED_HOSTS.has(host)) {
    throw new RouteError(
      `Хост ${host} не разрешён для preview. Добавьте его в PREVIEW_ALLOWED_HOSTS.`,
    );
  }
  return { enabled, baseUrl, orderId, token };
}

async function resolveDevices(deviceIds) {
  const { devices, errors } = await getDevices(true);
  const ids = Array.isArray(deviceIds) && deviceIds.length > 0
    ? deviceIds.map((id) => String(id))
    : devices.map((device) => device.id);
  const selected = devices.filter((device) => ids.includes(String(device.id)));
  if (selected.length === 0) {
    throw new RouteError(
      `Устройства не найдены${errors.length ? `: ${errors.join('; ')}` : ''}`,
      400,
    );
  }
  return selected;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Токен (Bearer) или HttpOnly-сессия UI обязательны для всех API.
app.use('/api', auth.middleware);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    adb_path: adbPath,
    devices: devicesCache.value.devices.length,
    simulation: simulation.status,
    time: new Date().toISOString(),
  });
});

app.get(
  '/api/devices',
  asyncHandler(async (req, res) => {
    const value = await getDevices(req.query.refresh === '1');
    res.json(value);
  }),
);

app.post(
  '/api/devices/location',
  asyncHandler(async (req, res) => {
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new RouteError('Некорректная широта');
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new RouteError('Некорректная долгота');
    }
    const devices = await resolveDevices(req.body?.deviceIds);
    const results = await Promise.allSettled(
      devices.map(async (device) => {
        await setDeviceLocation(device, lat, lon);
        return device.id;
      }),
    );
    res.json({
      location: { lat, lon },
      results: results.map((result, index) => ({
        id: devices[index].id,
        ok: result.status === 'fulfilled',
        error: result.status === 'rejected' ? String(result.reason?.message || result.reason) : null,
      })),
    });
  }),
);

app.post(
  '/api/route',
  asyncHandler(async (req, res) => {
    if (simulation.status === 'running' || simulation.status === 'paused') {
      throw new RouteError('Остановите текущую симуляцию перед построением маршрута', 409);
    }
    const route = await buildRoute({
      waypoints: req.body?.waypoints,
      mode: req.body?.mode,
    });
    draftRoute = route;
    simulation = createSimulation();
    simulationRoute = null;
    simulationDevices = [];
    res.json({ route: publicRoute(route) });
  }),
);

app.post(
  '/api/route/clear',
  asyncHandler(async (_req, res) => {
    if (simulation.status === 'running' || simulation.status === 'paused') {
      throw new RouteError('Остановите текущую симуляцию перед очисткой маршрута', 409);
    }
    draftRoute = null;
    simulation = createSimulation();
    simulationRoute = null;
    simulationDevices = [];
    res.json({ route: null });
  }),
);

app.post(
  '/api/simulation/start',
  asyncHandler(async (req, res) => {
    if (simulation.status === 'running' || simulation.status === 'paused') {
      throw new RouteError('Симуляция уже запущена. Остановите её или снимите с паузы', 409);
    }
    if (!draftRoute) {
      throw new RouteError('Сначала постройте маршрут');
    }
    const tickMs = clamp(Number(req.body?.tickMs) || 1000, 250, 10000);
    const preview = sanitizePreview(req.body?.preview);
    const devices = await resolveDevices(req.body?.deviceIds);

    simulationRoute = draftRoute;
    simulationDevices = devices;
    simulation = {
      status: 'running',
      started_at: new Date().toISOString(),
      started_at_ms: Date.now(),
      completed_at: null,
      elapsed_s: 0,
      total_s: draftRoute.total_duration_s,
      tick_ms: tickMs,
      current: null,
      trail: [],
      device_ids: devices.map((device) => device.id),
      errors: {},
      preview: {
        ...preview,
        last_status: null,
        last_error: null,
        last_at: null,
      },
    };
    startSimulationTimer();
    void tick();
    res.json({ simulation: publicSimulation() });
  }),
);

app.post('/api/simulation/pause', (_req, res) => {
  if (simulation.status !== 'running') {
    res.status(409).json({
      data: null,
      meta: { success: false, error: 'Симуляция не запущена' },
    });
    return;
  }
  simulation.elapsed_s = elapsedSeconds();
  simulation.status = 'paused';
  clearSimulationTimer();
  res.json({ simulation: publicSimulation() });
});

app.post('/api/simulation/resume', (_req, res) => {
  if (simulation.status !== 'paused') {
    res.status(409).json({
      data: null,
      meta: { success: false, error: 'Симуляция не на паузе' },
    });
    return;
  }
  simulation.started_at_ms = Date.now() - simulation.elapsed_s * 1000;
  simulation.status = 'running';
  startSimulationTimer();
  void tick();
  res.json({ simulation: publicSimulation() });
});

app.post('/api/simulation/stop', (_req, res) => {
  if (simulation.status === 'running') {
    simulation.elapsed_s = elapsedSeconds();
  }
  simulation.status = 'stopped';
  clearSimulationTimer();
  res.json({ simulation: publicSimulation() });
});

app.get(
  '/api/state',
  asyncHandler(async (_req, res) => {
    const devices = await getDevices();
    res.json({
      devices: devices.devices,
      device_errors: devices.errors,
      adb_path: devices.adb_path,
      route: publicRoute(draftRoute),
      simulation: publicSimulation(),
    });
  }),
);

app.get(['/', '/index.html'], (req, res) => {
  if (auth.handleTokenQuery(req, res)) return;
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').send(injectMapsApiKey(html, YANDEX_MAPS_API_KEY));
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ data: null, meta: { success: false, error: 'Not found' } });
    return;
  }
  res.status(404).send('Not found');
});

app.use((error, _req, res, _next) => {
  const status = error instanceof RouteError ? error.status : 500;
  if (status >= 500) console.error('[sender] request failed', error);
  res.status(status).json({
    data: null,
    meta: { success: false, error: error.message || 'Internal error' },
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[sender] http://localhost:${PORT}`);
  console.log(`[sender] adb: ${adbPath}`);
  console.log(`[sender] auth: ${SENDER_TOKEN ? 'Bearer + UI session' : 'off (loopback only)'}`);
  if (SENDER_TOKEN) {
    console.log(
      `[sender] UI: откройте http://localhost:${PORT}/?token=<SENDER_TOKEN> один раз для входа`,
    );
  }
  console.log(`[sender] preview hosts: ${[...PREVIEW_ALLOWED_HOSTS].join(', ')}`);
  if (!YANDEX_MAPS_API_KEY) {
    console.warn('[sender] YANDEX_MAPS_API_KEY не задан: карта не загрузится. Укажите ключ в .env');
  }
});

process.on('SIGINT', () => {
  clearSimulationTimer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearSimulationTimer();
  process.exit(0);
});

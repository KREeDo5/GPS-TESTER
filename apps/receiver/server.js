import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { haversineMeters } from '../../lib/geo.js';
import { injectMapsApiKey, loadEnvFile } from '../../lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

loadEnvFile(path.join(root, '.env'));

const PORT = Number(process.env.RECEIVER_PORT || process.env.PORT || 4000);
const HOST = process.env.RECEIVER_HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const DATA_FILE = path.join(DATA_DIR, 'positions.jsonl');
const REQUIRED_TOKEN = process.env.RECEIVER_TOKEN || '';
const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY || '';
const DEFAULT_LIMIT = 20000;
const MAX_LIMIT = 50000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Array<Record<string, any>>} */
const positions = [];
/** @type {Map<string, Record<string, any>>} */
const lastByOrder = new Map();
/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function loadPositions() {
  if (!fs.existsSync(DATA_FILE)) return;
  const lines = fs.readFileSync(DATA_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const point = JSON.parse(line);
      if (!Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon))) {
        continue;
      }
      point.order_id = String(point.order_id ?? '');
      positions.push(point);
    } catch {
      // Skip corrupt line, keep the rest of the history usable.
    }
  }
  positions.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  for (const point of positions) {
    lastByOrder.set(String(point.order_id), point);
  }
}

function persistPoint(point) {
  fs.appendFileSync(DATA_FILE, `${JSON.stringify(point)}\n`, 'utf8');
}

function rewriteFile() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(
    tmp,
    positions.map((point) => `${JSON.stringify(point)}\n`).join(''),
    'utf8',
  );
  fs.renameSync(tmp, DATA_FILE);
}

function rebuildLastByOrder() {
  lastByOrder.clear();
  for (const point of positions) {
    lastByOrder.set(String(point.order_id), point);
  }
}

function broadcast(payload) {
  const data = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function tokenTail(header) {
  const value = typeof header === 'string' ? header : '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = match ? match[1] : value;
  return token ? token.slice(-6) : null;
}

function normalizeCoordinate(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return Number(value);
}

function parsePoint(body, orderIdFromPath) {
  const source = body && typeof body === 'object' ? body : {};
  const orderId = String(orderIdFromPath ?? source.order_id ?? source.orderId ?? '').trim();
  const lat = normalizeCoordinate(source.lat ?? source.latitude);
  const lon = normalizeCoordinate(source.lon ?? source.lng ?? source.longitude);
  if (!orderId || orderId.length > 64) {
    return { error: 'Не задан order_id' };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'Некорректная широта (lat)' };
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'Некорректная долгота (lon)' };
  }
  return { orderId, lat, lon, source };
}

function recordPoint(req, orderId, lat, lon, source) {
  const now = new Date();
  const key = String(orderId);
  const previous = lastByOrder.get(key) || null;
  const receivedAt = now.toISOString();

  let distanceM = 0;
  let dtS = 0;
  let speedKmh = 0;
  let duplicate = false;

  if (previous) {
    distanceM = haversineMeters(previous, { lat, lon });
    dtS = Math.max(0, (now.getTime() - Date.parse(previous.received_at)) / 1000);
    duplicate = distanceM < 1 && dtS < 10;
    if (!duplicate && dtS > 0.2) {
      speedKmh = (distanceM / dtS) * 3.6;
    }
  }

  const clientRecordedAt = source.recorded_at ?? source.recordedAt ?? source.timestamp;
  let clientRecordedIso = null;
  if (typeof clientRecordedAt === 'string' || typeof clientRecordedAt === 'number') {
    const parsed = new Date(clientRecordedAt);
    if (!Number.isNaN(parsed.getTime())) clientRecordedIso = parsed.toISOString();
  }

  const point = {
    id: crypto.randomUUID(),
    order_id: key,
    lat,
    lon,
    received_at: receivedAt,
    client_recorded_at: clientRecordedIso,
    device_label:
      (typeof req.get('x-gps-device') === 'string' && req.get('x-gps-device').trim()) ||
      (typeof source.device_label === 'string' && source.device_label.trim()) ||
      (typeof source.device === 'string' && source.device.trim()) ||
      null,
    source:
      (typeof req.get('x-source') === 'string' && req.get('x-source').trim()) ||
      (typeof source.source === 'string' && source.source.trim()) ||
      'mobile',
    token_tail: tokenTail(req.get('authorization')),
    ip: req.ip,
    user_agent: req.get('user-agent') || '',
    duplicate,
    distance_m: Math.round(distanceM * 100) / 100,
    dt_s: Math.round(dtS * 100) / 100,
    speed_kmh: Math.round(speedKmh * 10) / 10,
    raw: source,
  };

  positions.push(point);
  lastByOrder.set(key, point);
  persistPoint(point);
  broadcast({ type: 'position', position: point });
  return point;
}

function orderSummaries() {
  const map = new Map();
  for (const point of positions) {
    const key = String(point.order_id);
    let item = map.get(key);
    if (!item) {
      item = {
        order_id: key,
        points: 0,
        distance_m: 0,
        first_at: point.received_at,
        last_at: point.received_at,
        devices: new Set(),
        last: null,
      };
      map.set(key, item);
    }
    item.points += 1;
    item.distance_m += Number(point.distance_m) || 0;
    item.first_at = point.received_at;
    item.last_at = point.received_at;
    item.last = point;
    if (point.device_label) item.devices.add(point.device_label);
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      devices: [...item.devices],
      distance_m: Math.round(item.distance_m * 100) / 100,
    }))
    .sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));
}

function filteredPositions(query) {
  const orderId = query.order_id ? String(query.order_id) : '';
  const device = query.device_label ? String(query.device_label) : '';
  const since = query.since ? Date.parse(String(query.since)) : Number.NaN;
  let list = positions;
  if (orderId) list = list.filter((point) => String(point.order_id) === orderId);
  if (device) list = list.filter((point) => String(point.device_label ?? '') === device);
  if (Number.isFinite(since)) {
    list = list.filter((point) => Date.parse(point.received_at) >= since);
  }
  return list;
}

function ingestionResponse(res, point) {
  res.json({
    data: { id: point.id, order_id: point.order_id, accepted_at: point.received_at },
    meta: { success: true },
  });
}

function invalidResponse(res, message) {
  res.status(422).json({ data: null, meta: { success: false, error: message } });
}

function handleCourierPosition(req, res) {
  if (REQUIRED_TOKEN) {
    const header = req.get('authorization') || '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] || '';
    if (token !== REQUIRED_TOKEN) {
      res.status(401).json({ data: null, meta: { success: false, error: 'Unauthorized' } });
      return;
    }
  }

  const parsed = parsePoint(req.body, req.params.orderId);
  if (parsed.error) {
    invalidResponse(res, parsed.error);
    return;
  }

  const point = recordPoint(req, parsed.orderId, parsed.lat, parsed.lon, parsed.source);
  console.log(
    `[receiver] #${point.order_id} ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)} ` +
      `${point.speed_kmh} km/h device=${point.device_label ?? '-'} source=${point.source}`,
  );
  ingestionResponse(res, point);
}

loadPositions();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '128kb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Gps-Device, X-Source',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    points: positions.length,
    orders: lastByOrder.size,
    token_required: Boolean(REQUIRED_TOKEN),
    time: new Date().toISOString(),
  });
});

// Mobile app contract: POST /api/orders/{id}/courier-position with {lat, lon}.
app.post('/api/orders/:orderId/courier-position', handleCourierPosition);
app.post('/orders/:orderId/courier-position', handleCourierPosition);
// Flexible aliases for manual tests and the simulator preview.
app.post('/api/courier-position', handleCourierPosition);
app.post('/api/ingest', handleCourierPosition);

app.get('/api/positions', (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const list = filteredPositions(req.query);
  res.json({
    positions: list.slice(-limit),
    total: list.length,
    limit,
  });
});

app.get('/api/orders', (_req, res) => {
  res.json({ orders: orderSummaries() });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', points: positions.length })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/api/export.geojson', (req, res) => {
  const list = filteredPositions(req.query);
  const byOrder = new Map();
  for (const point of list) {
    const key = String(point.order_id);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push([point.lon, point.lat]);
  }
  const features = [...byOrder.entries()].map(([orderId, coordinates]) => ({
    type: 'Feature',
    properties: { order_id: orderId, points: coordinates.length },
    geometry: { type: 'LineString', coordinates },
  }));
  for (const point of list) {
    features.push({
      type: 'Feature',
      properties: {
        order_id: point.order_id,
        received_at: point.received_at,
        speed_kmh: point.speed_kmh,
        device_label: point.device_label,
        source: point.source,
      },
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    });
  }
  res.setHeader('Content-Disposition', 'attachment; filename="gps-positions.geojson"');
  res.json({ type: 'FeatureCollection', features });
});

app.get('/api/export.csv', (req, res) => {
  const list = filteredPositions(req.query);
  const header = [
    'received_at',
    'order_id',
    'lat',
    'lon',
    'speed_kmh',
    'distance_m',
    'dt_s',
    'duplicate',
    'device_label',
    'source',
  ];
  const rows = list.map((point) =>
    header
      .map((key) => {
        const value = point[key];
        if (value === null || value === undefined) return '';
        const text = String(value);
        return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      })
      .join(','),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gps-positions.csv"');
  res.send([header.join(','), ...rows].join('\n'));
});

app.delete('/api/positions', (req, res) => {
  const confirmed = req.query.confirm === 'yes' || req.get('x-confirm') === 'yes';
  if (!confirmed) {
    res.status(400).json({
      data: null,
      meta: { success: false, error: 'Добавьте confirm=yes для удаления истории' },
    });
    return;
  }
  const orderId = req.query.order_id ? String(req.query.order_id) : '';
  const before = positions.length;
  if (orderId) {
    for (let index = positions.length - 1; index >= 0; index -= 1) {
      if (String(positions[index].order_id) === orderId) positions.splice(index, 1);
    }
  } else {
    positions.length = 0;
  }
  rebuildLastByOrder();
  rewriteFile();
  broadcast({ type: 'reset', order_id: orderId || null });
  res.json({
    data: { removed: before - positions.length },
    meta: { success: true },
  });
});

app.get(['/', '/index.html'], (_req, res) => {
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
  console.error('[receiver] request failed', error);
  res.status(500).json({ data: null, meta: { success: false, error: 'Internal error' } });
});

app.listen(PORT, HOST, () => {
  console.log(`[receiver] http://localhost:${PORT}`);
  console.log(`[receiver] data file: ${DATA_FILE} (${positions.length} points)`);
  if (!YANDEX_MAPS_API_KEY) {
    console.warn('[receiver] YANDEX_MAPS_API_KEY не задан: карта не загрузится. Укажите ключ в .env');
  }
  console.log(
    `[receiver] Android emulator base URL: http://10.0.2.2:${PORT}/api | iOS simulator: http://127.0.0.1:${PORT}/api`,
  );
});

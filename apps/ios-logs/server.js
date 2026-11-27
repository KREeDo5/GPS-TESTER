import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../../lib/config.js';
import { isLoopbackHost } from '../../lib/auth.js';
import { renderPage } from './page.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

loadEnvFile(path.join(root, '.env'));

const PORT = Number(process.env.IOS_LOGS_PORT || 8899);
const HOST = process.env.IOS_LOGS_HOST || '127.0.0.1';
const BUNDLE_ID = process.env.IOS_APP_BUNDLE_ID || 'com.whitetigersoft.ru.fabric.bo';
const LOG_FILENAME = path.basename(
  process.env.IOS_LOG_FILENAME || 'courier_tracking.log',
);
const MAX_LOG_BYTES = 1024 * 1024;
const CONTAINER_CACHE_MS = 2000;
const SAFE_UDID = /^[A-Za-z0-9-]+$/;

if (!isLoopbackHost(HOST)) {
  console.error(
    `[ios-logs] IOS_LOGS_HOST=${HOST}: приложение читает файлы симулятора и работает только на loopback.`,
  );
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

/** @type {Map<string, {dataDir: string, logPath: string|null, error: string|null, at: number}>} */
const containerCache = new Map();

async function run(command, args, timeout = 8000) {
  const result = await execFileAsync(command, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runtimeLabel(runtime) {
  return String(runtime)
    .replace('com.apple.CoreSimulator.SimRuntime.', '')
    .replace(/^([A-Za-z]+)-/, '$1 ')
    .replaceAll('-', '.');
}

async function listBootedDevices() {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    const data = JSON.parse(stdout);
    const devices = [];
    for (const [runtime, entries] of Object.entries(data.devices || {})) {
      for (const device of entries || []) {
        if (device.state !== 'Booted') continue;
        devices.push({
          udid: device.udid,
          name: device.name,
          runtime: runtimeLabel(runtime),
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

async function resolveContainer(udid) {
  const cached = containerCache.get(udid);
  if (cached && Date.now() - cached.at < CONTAINER_CACHE_MS) return cached;

  let dataDir = '';
  let error = null;
  try {
    const { stdout } = await run('xcrun', ['simctl', 'get_app_container', udid, BUNDLE_ID, 'data']);
    dataDir = stdout.trim();
    if (!dataDir) error = 'simctl не вернул путь контейнера';
  } catch (cause) {
    const message = String(cause?.stderr || cause?.message || cause).trim();
    error = message || 'Приложение не установлено в симуляторе';
  }

  const entry = {
    dataDir,
    logPath: dataDir ? path.join(dataDir, 'Documents', LOG_FILENAME) : null,
    error,
    at: Date.now(),
  };
  containerCache.set(udid, entry);
  return entry;
}

function readLogFile(logPath) {
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return { exists: false, text: '', size: 0, updated_at: null, truncated: false };
  }
  if (!stat.isFile()) {
    return { exists: false, text: '', size: 0, updated_at: null, truncated: false };
  }

  const start = Math.max(0, stat.size - MAX_LOG_BYTES);
  const length = stat.size - start;
  let text = '';
  if (length > 0) {
    const descriptor = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  return {
    exists: true,
    text,
    size: stat.size,
    updated_at: stat.mtime.toISOString(),
    truncated: start > 0,
  };
}

async function deviceStatus(device) {
  const container = await resolveContainer(device.udid);
  const log = container.logPath
    ? readLogFile(container.logPath)
    : { exists: false, text: '', size: 0, updated_at: null, truncated: false };

  return {
    ...device,
    bundle_id: BUNDLE_ID,
    log_path: container.logPath,
    has_log: log.exists,
    log_size: log.size,
    log_updated_at: log.updated_at,
    container_error: container.error,
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'ios-logs',
    platform: process.platform,
    bundle_id: BUNDLE_ID,
    log_filename: LOG_FILENAME,
  });
});

app.get('/api/status', async (req, res) => {
  const devices = await listBootedDevices();
  const enriched = await Promise.all(devices.map(deviceStatus));
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    platform: process.platform,
    bundle_id: BUNDLE_ID,
    log_filename: LOG_FILENAME,
    devices: enriched,
  });
});

app.get('/api/log', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  let udid = String(req.query.udid || '').trim();
  if (!udid) {
    const devices = await listBootedDevices();
    if (!devices.length) {
      res.status(404).json({
        ok: false,
        error: 'Нет запущенных iOS Simulator',
        log_path: null,
      });
      return;
    }
    udid = devices[0].udid;
  }
  if (!SAFE_UDID.test(udid)) {
    res.status(400).json({ ok: false, error: 'Некорректный UDID', log_path: null });
    return;
  }

  const devices = await listBootedDevices();
  const device = devices.find((item) => item.udid === udid);
  if (!device) {
    res.status(404).json({
      ok: false,
      error: 'iOS Simulator не запущен',
      log_path: null,
    });
    return;
  }

  const container = await resolveContainer(udid);
  if (!container.logPath) {
    res.json({
      ok: true,
      udid,
      name: device.name,
      bundle_id: BUNDLE_ID,
      log_path: null,
      container_error: container.error,
      exists: false,
      text: '',
      size: 0,
      updated_at: null,
      truncated: false,
    });
    return;
  }

  const log = readLogFile(container.logPath);
  res.json({
    ok: true,
    udid,
    name: device.name,
    bundle_id: BUNDLE_ID,
    log_path: container.logPath,
    container_error: container.error,
    ...log,
  });
});

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderPage({ bundleId: BUNDLE_ID, logFilename: LOG_FILENAME }));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error('[ios-logs]', error);
  res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, HOST, () => {
  console.log(`[ios-logs] http://${HOST}:${PORT}`);
  console.log(`[ios-logs] bundle: ${BUNDLE_ID}`);
  console.log(`[ios-logs] file:   Documents/${LOG_FILENAME}`);
});

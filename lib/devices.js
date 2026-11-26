import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

function resolveAdbPath() {
  const candidates = [
    process.env.ADB_PATH,
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    'adb',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate === 'adb' || fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return 'adb';
}

export const adbPath = resolveAdbPath();

async function run(command, args, timeout = 10000) {
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

async function listAndroidDevices() {
  const { stdout } = await run(adbPath, ['devices', '-l']);
  const devices = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices')) continue;
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || state !== 'device') continue;
    if (!serial.startsWith('emulator-')) continue;
    const meta = {};
    for (const part of parts.slice(2)) {
      const separator = part.indexOf(':');
      if (separator > 0) meta[part.slice(0, separator)] = part.slice(separator + 1);
    }
    let avdName = '';
    try {
      const response = await run(adbPath, ['-s', serial, 'emu', 'avd', 'name']);
      avdName =
        response.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && line !== 'OK')
          .pop() || '';
    } catch {
      // Keep a generic name when the emulator console is unavailable.
    }
    devices.push({
      id: serial,
      type: 'android',
      name: avdName || meta.model || serial,
      detail: `Android · ${meta.product || meta.device || 'emulator'}`,
      ready: true,
    });
  }
  return devices;
}

async function listIosDevices() {
  if (process.platform !== 'darwin') return [];
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  const data = JSON.parse(stdout);
  const devices = [];
  for (const [runtime, entries] of Object.entries(data.devices || {})) {
    const runtimeLabel = runtime
      .replace('com.apple.CoreSimulator.SimRuntime.', '')
      .replace(/^([A-Za-z]+)-/, '$1 ')
      .replaceAll('-', '.');
    for (const device of entries || []) {
      if (device.state !== 'Booted') continue;
      devices.push({
        id: device.udid,
        type: 'ios',
        name: device.name,
        detail: runtimeLabel,
        ready: true,
      });
    }
  }
  return devices;
}

export async function listDevices() {
  const results = await Promise.allSettled([listAndroidDevices(), listIosDevices()]);
  const devices = [];
  const errors = [];
  if (results[0].status === 'fulfilled') devices.push(...results[0].value);
  else errors.push(`Android: ${results[0].reason?.message || results[0].reason}`);
  if (results[1].status === 'fulfilled') devices.push(...results[1].value);
  else errors.push(`iOS: ${results[1].reason?.message || results[1].reason}`);

  return {
    devices,
    errors,
    adb_path: adbPath,
  };
}

export async function setDeviceLocation(device, lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error('Некорректная широта');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Некорректная долгота');
  }
  if (!device || !SAFE_ID.test(String(device.id))) {
    throw new Error('Некорректный идентификатор устройства');
  }

  if (device.type === 'android') {
    // Android emulator console expects longitude first.
    const { stdout, stderr } = await run(
      adbPath,
      ['-s', device.id, 'emu', 'geo', 'fix', String(longitude), String(latitude)],
      8000,
    );
    const output = `${stdout}\n${stderr}`.trim();
    if (/\bKO\b/i.test(output)) {
      throw new Error(output.split(/\r?\n/).find((line) => /\bKO\b/i.test(line)) || output);
    }
    return;
  }

  if (device.type === 'ios') {
    await run('xcrun', ['simctl', 'location', device.id, 'set', `${latitude},${longitude}`], 8000);
    return;
  }

  throw new Error(`Неизвестный тип устройства: ${device.type}`);
}

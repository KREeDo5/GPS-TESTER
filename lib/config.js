import fs from 'node:fs';

const MAPS_KEY_PLACEHOLDER = '__YANDEX_MAPS_API_KEY__';

/**
 * Load KEY=VALUE pairs from a dotenv-style file without overriding
 * variables that are already present in the environment.
 * @param {string} filePath
 */
export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Replace the maps API key placeholder in the served HTML.
 * @param {string} html
 * @param {string} apiKey
 */
export function injectMapsApiKey(html, apiKey) {
  return html.replaceAll(MAPS_KEY_PLACEHOLDER, encodeURIComponent(apiKey || ''));
}

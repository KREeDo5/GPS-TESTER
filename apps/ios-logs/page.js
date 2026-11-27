function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderPage({ bundleId, logFilename }) {
  const config = escapeScriptJson({ bundleId, logFilename });
  const bundleHtml = escapeHtml(bundleId);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iOS logs — GPS-TESTER</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d0f12;
    --panel: #15181d;
    --panel-2: #1b1f26;
    --border: #2a3039;
    --text: #e6e9ee;
    --muted: #8b95a5;
    --accent: #4da3ff;
    --ok: #5fd38d;
    --warn: #f0c15c;
    --error: #ff6b6b;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: 0.01em; }
  h1 span { color: var(--muted); font-weight: 450; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button, select {
    height: 34px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    padding: 0 10px;
    font: inherit;
  }
  button { cursor: pointer; }
  button:hover { border-color: #3d4652; }
  button.active { border-color: var(--accent); color: var(--accent); }
  select { max-width: 360px; }
  main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: calc(100vh - 63px);
    padding: 14px 20px 20px;
    gap: 12px;
  }
  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }
  .card {
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
  }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
  .card .value {
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12px;
  }
  .status { display: inline-flex; align-items: center; gap: 7px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--ok); box-shadow: 0 0 0 3px rgba(95, 211, 141, 0.14); }
  .dot.wait { background: var(--warn); }
  .dot.error { background: var(--error); }
  .log-wrap {
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #0a0c0f;
    overflow: hidden;
  }
  #log {
    height: 100%;
    margin: 0;
    padding: 14px 16px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: #c9d1dc;
    tab-size: 2;
  }
  .line { display: block; }
  .line.error { color: var(--error); }
  .line.warn { color: var(--warn); }
  .line.ok { color: var(--ok); }
  .line.muted { color: var(--muted); }
  .empty {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 24px;
    color: var(--muted);
    text-align: center;
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .hint { color: var(--muted); font-size: 12px; }
  @media (max-width: 720px) {
    header { align-items: flex-start; }
    main { padding: 10px; height: calc(100vh - 103px); }
    .meta { grid-template-columns: 1fr; }
    select { max-width: 100%; width: 100%; }
  }
</style>
</head>
<body>
<header>
  <h1>iOS logs <span>· фоновый сервис курьера</span></h1>
  <div class="toolbar">
    <select id="device" aria-label="iOS Simulator"></select>
    <button id="pause" type="button" title="Остановить обновление">Пауза</button>
    <button id="follow" type="button" class="active" title="Прокручивать к последней строке">Следовать</button>
  </div>
</header>
<main>
  <section class="meta">
    <div class="card">
      <div class="label">Статус</div>
      <div class="value"><span class="status"><span id="dot" class="dot"></span><span id="status">Поиск симулятора…</span></span></div>
    </div>
    <div class="card">
      <div class="label">Файл</div>
      <div class="value" id="file" title="">—</div>
    </div>
    <div class="card">
      <div class="label">Размер · строки</div>
      <div class="value" id="size">—</div>
    </div>
    <div class="card">
      <div class="label">Bundle ID</div>
      <div class="value" id="bundle" title="${bundleHtml}">${bundleHtml}</div>
    </div>
  </section>
  <section class="log-wrap">
    <div id="log"><div class="empty">Загрузка…</div></div>
  </section>
</main>
<script>
const CONFIG = ${config};
const state = {
  udid: null,
  paused: false,
  follow: true,
  lastText: null,
  lastSize: 0,
  timer: null,
  deviceTimer: null,
  requestSeq: 0,
};

const el = {
  device: document.getElementById('device'),
  pause: document.getElementById('pause'),
  follow: document.getElementById('follow'),
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  file: document.getElementById('file'),
  size: document.getElementById('size'),
  log: document.getElementById('log'),
};

function setStatus(text, kind) {
  el.status.textContent = text;
  el.dot.className = 'dot' + (kind ? ' ' + kind : '');
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 1024) return value + ' Б';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' КБ';
  return (value / 1024 / 1024).toFixed(1) + ' МБ';
}

function lineClass(line) {
  const text = line.toLowerCase();
  if (/error|failed|failure|fatal|ошибк|не удалось|сбой/.test(text)) return 'error';
  if (/warn|warning|предуп|приостанов|ожидан/.test(text)) return 'warn';
  if (/success|ok|успеш|отправлен|запущен|старт/.test(text)) return 'ok';
  if (/^\\d{4}-\\d{2}-\\d{2}t/.test(text)) return 'muted';
  return '';
}

function renderLog(text, info) {
  const normalized = (text || '').replace(/\\r\\n/g, '\\n');
  if (normalized === state.lastText) return;
  state.lastText = normalized;
  el.log.replaceChildren();

  if (!normalized.trim()) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (info && info.container_error) {
      empty.textContent = 'Приложение не найдено в симуляторе.\\n' + info.container_error;
    } else if (info && info.exists) {
      empty.textContent = 'Файл создан, но пока пуст.\\n\\n' + info.log_path;
    } else if (info && info.log_path) {
      empty.textContent = 'Файл ещё не создан.\\n\\n' + info.log_path +
        '\\n\\nЗапустите debug-сборку iOS и возьмите заказ в работу.';
    } else {
      empty.textContent = 'Нет запущенных iOS Simulator.';
    }
    el.log.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const line of normalized.split('\\n')) {
    const span = document.createElement('span');
    span.className = 'line ' + lineClass(line);
    span.textContent = line || ' ';
    fragment.append(span);
  }
  el.log.append(fragment);
  if (state.follow) el.log.scrollTop = el.log.scrollHeight;
}

function selectDevice(udid) {
  if (state.udid === udid) return;
  state.udid = udid;
  state.lastText = null;
  if (udid) localStorage.setItem('gpsTesterIosLogUdid', udid);
  void loadLog();
}

async function loadDevices() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const data = await response.json();
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const previous = state.udid || localStorage.getItem('gpsTesterIosLogUdid');

    el.device.replaceChildren();
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.udid;
      option.textContent = device.name + (device.has_log ? '' : ' · нет лога');
      el.device.append(option);
    }

    if (!devices.length) {
      state.udid = null;
      el.device.disabled = true;
      setStatus('Нет запущенных iOS Simulator', 'wait');
      el.file.textContent = '—';
      el.file.title = '';
      el.size.textContent = '—';
      renderLog('', null);
      return;
    }

    el.device.disabled = false;
    const next = devices.some((device) => device.udid === previous) ? previous : devices[0].udid;
    el.device.value = next;
    selectDevice(next);
  } catch (error) {
    setStatus('Сервер недоступен: ' + error.message, 'error');
  }
}

async function loadLog() {
  if (!state.udid || state.paused) return;
  const seq = ++state.requestSeq;
  const udid = state.udid;
  try {
    const response = await fetch('/api/log?udid=' + encodeURIComponent(udid) + '&t=' + Date.now(), {
      cache: 'no-store',
    });
    const data = await response.json();
    if (seq !== state.requestSeq || udid !== state.udid) return;

    if (!data.ok) {
      setStatus(data.error || 'Ошибка чтения', 'error');
      el.file.textContent = data.log_path || '—';
      el.file.title = data.log_path || '';
      el.size.textContent = '—';
      renderLog('', data);
      return;
    }

    if (data.exists) {
      const lines = data.text ? data.text.split('\\n').filter((line, index, all) => index < all.length - 1 || line).length : 0;
      setStatus('Обновляется', 'live');
      el.size.textContent = formatBytes(data.size) + ' · ' + lines;
    } else if (data.container_error) {
      setStatus('Приложение не найдено', 'error');
      el.size.textContent = '—';
    } else {
      setStatus('Ожидание файла', 'wait');
      el.size.textContent = '—';
    }
    el.file.textContent = data.log_path || '—';
    el.file.title = data.log_path || '';
    el.size.title = data.updated_at ? 'Изменён: ' + data.updated_at : '';
    renderLog(data.text || '', data);
  } catch (error) {
    if (seq === state.requestSeq) setStatus('Сервер недоступен: ' + error.message, 'error');
  }
}

el.pause.addEventListener('click', () => {
  state.paused = !state.paused;
  el.pause.classList.toggle('active', state.paused);
  el.pause.textContent = state.paused ? 'Продолжить' : 'Пауза';
  if (!state.paused) void loadLog();
});

el.follow.addEventListener('click', () => {
  state.follow = !state.follow;
  el.follow.classList.toggle('active', state.follow);
  if (state.follow) el.log.scrollTop = el.log.scrollHeight;
});

el.device.addEventListener('change', () => {
  selectDevice(el.device.value);
});

void loadDevices();
void loadLog();
state.deviceTimer = setInterval(loadDevices, 5000);
state.timer = setInterval(loadLog, 1000);
</script>
</body>
</html>`;
}

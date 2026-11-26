(() => {
  'use strict';

  const GAP_SECONDS = 90;
  const MAX_POSITIONS = 60000;
  const MAX_HISTORY_ROWS = 400;
  const SPEED_COLORS = {
    stop: '#94a3b8',
    slow: '#3b82f6',
    normal: '#22c55e',
    fast: '#f59e0b',
    veryFast: '#ef4444',
    gap: '#94a3b8',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    connection: $('connection'),
    connectionText: $('connectionText'),
    orderSelect: $('orderSelect'),
    deviceSelect: $('deviceSelect'),
    followToggle: $('followToggle'),
    refreshButton: $('refreshButton'),
    clearButton: $('clearButton'),
    exportGeoJson: $('exportGeoJson'),
    exportCsv: $('exportCsv'),
    statPoints: $('statPoints'),
    statDistance: $('statDistance'),
    statSpeed: $('statSpeed'),
    statDuration: $('statDuration'),
    statGap: $('statGap'),
    statDevices: $('statDevices'),
    lastSeen: $('lastSeen'),
    replayRange: $('replayRange'),
    replayPlay: $('replayPlay'),
    replaySpeed: $('replaySpeed'),
    replayCounter: $('replayCounter'),
    replayInfo: $('replayInfo'),
    historyList: $('historyList'),
    historyEmpty: $('historyEmpty'),
    historyCount: $('historyCount'),
    mapEmpty: $('mapEmpty'),
    mapMeta: $('mapMeta'),
    pointDialog: $('pointDialog'),
    pointDialogBody: $('pointDialogBody'),
  };

  const state = {
    positions: [],
    orders: [],
    selectedOrder: localStorage.getItem('receiver.order') || '',
    selectedDevice: localStorage.getItem('receiver.device') || '',
    follow: localStorage.getItem('receiver.follow') !== '0',
    selectedPointId: null,
    fittedKey: null,
    replay: { index: 0, playing: false, timer: null, speed: 1 },
    lastRenderAt: 0,
  };

  let map = null;
  let authError = false;
  let routeLayer = null;
  let pointsLayer = null;
  let replayLayer = null;
  let endMarkerLayer = null;
  let replayMarker = null;
  let pulseLayout = null;
  let replayLayout = null;

  function initMap() {
    map = new ymaps.Map('map', {
      center: [55.7558, 37.6173],
      zoom: 12,
      controls: ['zoomControl'],
    });
    routeLayer = new ymaps.GeoObjectCollection();
    pointsLayer = new ymaps.GeoObjectCollection();
    replayLayer = new ymaps.GeoObjectCollection();
    endMarkerLayer = new ymaps.GeoObjectCollection();
    map.geoObjects.add(routeLayer);
    map.geoObjects.add(pointsLayer);
    map.geoObjects.add(replayLayer);
    map.geoObjects.add(endMarkerLayer);

    pulseLayout = ymaps.templateLayoutFactory.createClass(
      '<div class="map-pulse"></div>',
    );
    replayLayout = ymaps.templateLayoutFactory.createClass(
      '<div class="replay-dot"></div>',
    );
  }

  function dotPlacemark(coords, size, color, hint, zIndex = 200) {
    const layout = ymaps.templateLayoutFactory.createClass(
      `<div class="map-dot" style="width:${size}px;height:${size}px;background:${color};border-color:${color}"></div>`,
    );
    return new ymaps.Placemark(
      coords,
      { hintContent: hint },
      {
        iconLayout: layout,
        iconShape: {
          type: 'Circle',
          coordinates: [0, 0],
          radius: Math.ceil(size / 2) + 2,
        },
        hasBalloon: false,
        zIndex,
      },
    );
  }

  els.followToggle.checked = state.follow;

  // ------------------------------------------------------------------ utils

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (response.status === 401) {
      authError = true;
      throw new Error('нужен токен: откройте /?token=<RECEIVER_TOKEN>');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text.slice(0, 200)}`);
    }
    authError = false;
    return response.json();
  }

  function formatTime(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  }

  function formatNumber(value, digits = 1) {
    return new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '—';
    if (meters < 1000) return `${Math.round(meters)} м`;
    return `${formatNumber(meters / 1000, meters < 10000 ? 2 : 1)} км`;
  }

  function formatDuration(seconds) {
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

  function timeAgo(iso) {
    if (!iso) return '—';
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 3) return 'только что';
    if (seconds < 60) return `${seconds} с назад`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч ${minutes % 60} мин назад`;
    return formatDateTime(iso);
  }

  function haversine(a, b) {
    const radius = 6371008.8;
    const toRad = (value) => (value * Math.PI) / 180;
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const dLat = lat2 - lat1;
    const dLon = toRad(b[1] - a[1]);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function speedClass(kmh) {
    if (!Number.isFinite(kmh) || kmh < 0.5) return 'stop';
    if (kmh < 12) return 'slow';
    if (kmh < 35) return 'normal';
    if (kmh < 70) return 'fast';
    return 'veryFast';
  }

  function speedLabel(kmh) {
    const value = Number(kmh) || 0;
    return `${formatNumber(value, value < 10 ? 1 : 0)} км/ч`;
  }

  function sortPoints(points) {
    return [...points].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  }

  function filteredPoints() {
    if (!state.selectedOrder) return [];
    const order = String(state.selectedOrder);
    const device = state.selectedDevice;
    return state.positions.filter((point) => {
      if (String(point.order_id) !== order) return false;
      if (device && String(point.device_label ?? '') !== device) return false;
      return true;
    });
  }

  function availableDevices(points) {
    const labels = new Set();
    for (const point of points) {
      labels.add(String(point.device_label ?? ''));
    }
    return [...labels].sort((a, b) => a.localeCompare(b, 'ru'));
  }

  // ------------------------------------------------------------- selection

  function ensureSelection() {
    if (!state.selectedOrder && state.orders.length > 0) {
      state.selectedOrder = String(state.orders[0].order_id);
      localStorage.setItem('receiver.order', state.selectedOrder);
    }
    if (
      state.selectedOrder &&
      state.orders.length > 0 &&
      !state.orders.some((order) => String(order.order_id) === state.selectedOrder)
    ) {
      state.selectedOrder = String(state.orders[0].order_id);
      localStorage.setItem('receiver.order', state.selectedOrder);
    }
    if (!state.selectedOrder && state.orders.length === 0) {
      state.selectedOrder = '';
    }
    if (state.selectedDevice) {
      const devices = availableDevices(filteredPoints());
      if (!devices.includes(state.selectedDevice)) {
        state.selectedDevice = '';
        localStorage.removeItem('receiver.device');
      }
    }
  }

  function renderOrderSelect() {
    const options = [];
    if (state.orders.length === 0) {
      options.push('<option value="">— нет заказов —</option>');
    } else {
      for (const order of state.orders) {
        const id = String(order.order_id);
        const selected = id === state.selectedOrder ? ' selected' : '';
        const time = formatTime(order.last_at);
        options.push(
          `<option value="${escapeHtml(id)}"${selected}>#${escapeHtml(id)} · ${order.points} т. · ${time}</option>`,
        );
      }
    }
    els.orderSelect.innerHTML = options.join('');
    els.orderSelect.value = state.selectedOrder;
  }

  function renderDeviceSelect(points) {
    const devices = availableDevices(points);
    const options = ['<option value="">Все устройства</option>'];
    for (const device of devices) {
      if (!device) continue;
      const selected = device === state.selectedDevice ? ' selected' : '';
      options.push(`<option value="${escapeHtml(device)}"${selected}>${escapeHtml(device)}</option>`);
    }
    els.deviceSelect.innerHTML = options.join('');
    els.deviceSelect.value = state.selectedDevice;
    els.deviceSelect.disabled = devices.filter(Boolean).length === 0;
  }

  // ------------------------------------------------------------------ stats

  function computeStats(points) {
    if (points.length === 0) {
      return {
        points: 0,
        distance: 0,
        duration: 0,
        avgSpeed: 0,
        maxGap: 0,
        devices: new Set(),
        firstAt: null,
        lastAt: null,
      };
    }
    let distance = 0;
    let maxGap = 0;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      distance += haversine(
        [Number(previous.lat), Number(previous.lon)],
        [Number(current.lat), Number(current.lon)],
      );
      const gap =
        (Date.parse(current.received_at) - Date.parse(previous.received_at)) / 1000;
      if (gap > maxGap) maxGap = gap;
    }
    const duration =
      (Date.parse(points[points.length - 1].received_at) - Date.parse(points[0].received_at)) /
      1000;
    const devices = new Set(points.map((point) => String(point.device_label ?? '')));
    return {
      points: points.length,
      distance,
      duration,
      avgSpeed: duration > 0 ? (distance / duration) * 3.6 : 0,
      maxGap,
      devices,
      firstAt: points[0].received_at,
      lastAt: points[points.length - 1].received_at,
    };
  }

  function renderStats(points) {
    const stats = computeStats(points);
    els.statPoints.textContent = String(stats.points);
    els.statDistance.textContent = formatDistance(stats.distance);
    els.statSpeed.textContent = stats.avgSpeed > 0 ? speedLabel(stats.avgSpeed) : '0 км/ч';
    els.statDuration.textContent = formatDuration(stats.duration);
    els.statGap.textContent = stats.maxGap > 0 ? formatDuration(stats.maxGap) : '—';
    els.statGap.style.color = stats.maxGap > GAP_SECONDS ? '#f59e0b' : '';
    els.statDevices.textContent = stats.devices.size > 0 ? String(stats.devices.size) : '—';
    const names = [...stats.devices].map((name) => name || 'без метки').join(', ');
    els.statDevices.title = names;

    if (stats.lastAt) {
      els.lastSeen.dataset.ts = stats.lastAt;
      els.lastSeen.textContent = `${formatTime(stats.lastAt)} · ${timeAgo(stats.lastAt)}`;
      els.lastSeen.title = formatDateTime(stats.lastAt);
    } else {
      els.lastSeen.removeAttribute('data-ts');
      els.lastSeen.textContent = 'нет данных';
      els.lastSeen.title = '';
    }
  }

  // ---------------------------------------------------------------- history

  function renderHistory(points) {
    const reversed = [...points].reverse().slice(0, MAX_HISTORY_ROWS);
    els.historyCount.textContent = String(points.length);
    els.historyEmpty.style.display = points.length === 0 ? 'block' : 'none';
    if (points.length === 0) {
      els.historyList.innerHTML = '';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const point of reversed) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'entry';
      button.dataset.id = point.id;
      if (point.id === state.selectedPointId) button.classList.add('is-selected');
      if (point.duplicate) button.classList.add('is-duplicate');
      const cls = speedClass(Number(point.speed_kmh) || 0);
      const coords = `${Number(point.lat).toFixed(5)}, ${Number(point.lon).toFixed(5)}`;
      const distance =
        Number(point.distance_m) > 0 ? `+${formatDistance(Number(point.distance_m))}` : '0 м';
      const device = point.device_label
        ? `<span class="badge device">${escapeHtml(point.device_label)}</span>`
        : '';
      const duplicate = point.duplicate ? '<span class="badge duplicate">дубль</span>' : '';
      button.innerHTML = `
        <span class="entry-top">
          <span class="entry-time">${formatTime(point.received_at)}</span>
          <span class="badge ${cls}">${speedLabel(point.speed_kmh)}</span>
          <span class="muted">${distance}</span>
          ${device}
          ${duplicate}
        </span>
        <span class="entry-coords">${escapeHtml(coords)}</span>
        <span class="entry-sub">
          <span class="ago" data-ts="${escapeHtml(point.received_at)}">${timeAgo(point.received_at)}</span>
          <span>Δt ${formatNumber(Number(point.dt_s) || 0, 1)} с</span>
          <span>${escapeHtml(point.source || 'mobile')}</span>
        </span>
      `;
      item.appendChild(button);
      fragment.appendChild(item);
    }
    const list = els.historyList;
    const nearTop = list.scrollTop <= 40;
    list.innerHTML = '';
    list.appendChild(fragment);
    if (nearTop) list.scrollTop = 0;
  }

  function setSelectedPoint(pointId) {
    state.selectedPointId = pointId;
    for (const entry of els.historyList.querySelectorAll('.entry')) {
      entry.classList.toggle('is-selected', entry.dataset.id === pointId);
    }
  }

  function openPointDialog(point) {
    if (!point) return;
    const cls = speedClass(Number(point.speed_kmh) || 0);
    els.pointDialogBody.innerHTML = `
      <dl class="detail-grid">
        <div><dt>Заказ</dt><dd>#${escapeHtml(point.order_id)}</dd></div>
        <div><dt>Время сервера</dt><dd>${escapeHtml(formatDateTime(point.received_at))}</dd></div>
        <div><dt>Широта</dt><dd>${Number(point.lat).toFixed(6)}</dd></div>
        <div><dt>Долгота</dt><dd>${Number(point.lon).toFixed(6)}</dd></div>
        <div><dt>Скорость</dt><dd><span class="badge ${cls}">${speedLabel(point.speed_kmh)}</span></dd></div>
        <div><dt>От предыдущей</dt><dd>${formatDistance(Number(point.distance_m) || 0)} · ${formatNumber(Number(point.dt_s) || 0, 1)} с</dd></div>
        <div><dt>Устройство</dt><dd>${escapeHtml(point.device_label || 'без метки')}</dd></div>
        <div><dt>Источник</dt><dd>${escapeHtml(point.source || 'mobile')}</dd></div>
        <div><dt>Дубль</dt><dd>${point.duplicate ? 'да' : 'нет'}</dd></div>
        ${
          point.ip !== undefined
            ? `<div><dt>IP</dt><dd>${escapeHtml(point.ip || '—')}</dd></div>`
            : ''
        }
        ${
          point.user_agent !== undefined
            ? `<div><dt>User-Agent</dt><dd>${escapeHtml(point.user_agent || '—')}</dd></div>`
            : ''
        }
      </dl>
      ${
        point.raw !== undefined
          ? `<pre class="raw">${escapeHtml(JSON.stringify(point.raw ?? {}, null, 2))}</pre>`
          : ''
      }
    `;
    els.pointDialog.showModal();
  }

  // -------------------------------------------------------------------- map

  function renderRoute(points) {
    if (!map) return;
    routeLayer.removeAll();
    pointsLayer.removeAll();
    endMarkerLayer.removeAll();

    const sorted = sortPoints(points);
    if (sorted.length === 0) {
      els.mapEmpty.style.display = 'flex';
      els.mapMeta.textContent = '—';
      return;
    }
    els.mapEmpty.style.display = 'none';

    const groups = [];
    let currentGroup = null;

    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const point = sorted[index];
      const gap =
        (Date.parse(point.received_at) - Date.parse(previous.received_at)) / 1000 >
        GAP_SECONDS;
      const cls = gap ? 'gap' : speedClass(Number(point.speed_kmh) || 0);
      const from = [Number(previous.lat), Number(previous.lon)];
      const to = [Number(point.lat), Number(point.lon)];
      if (!currentGroup || currentGroup.cls !== cls) {
        currentGroup = { cls, coords: [from] };
        groups.push(currentGroup);
      }
      currentGroup.coords.push(to);
    }

    for (const group of groups) {
      if (group.coords.length < 2) continue;
      routeLayer.add(
        new ymaps.Polyline(
          group.coords,
          {},
          {
            strokeColor: SPEED_COLORS[group.cls],
            strokeWidth: group.cls === 'gap' ? 2 : 4,
            strokeOpacity: group.cls === 'gap' ? 0.75 : 0.95,
            strokeStyle: group.cls === 'gap' ? 'dash' : 'solid',
          },
        ),
      );
    }

    const first = sorted[0];
    const startMarker = dotPlacemark(
      [Number(first.lat), Number(first.lon)],
      8,
      '#22c55e',
      `Старт · ${formatTime(first.received_at)}`,
    );
    startMarker.properties.set(
      'balloonContentBody',
      `<strong>Старт</strong><br>${formatTime(first.received_at)}`,
    );
    pointsLayer.add(startMarker);

    const last = sorted[sorted.length - 1];
    const endMarker = new ymaps.Placemark(
      [Number(last.lat), Number(last.lon)],
      {
        hintContent: `Текущая точка · ${formatTime(last.received_at)}`,
        balloonContentBody: `<strong>Текущая точка</strong><br>${formatTime(last.received_at)}<br>${speedLabel(last.speed_kmh)}`,
      },
      {
        iconLayout: pulseLayout,
        iconShape: { type: 'Circle', coordinates: [0, 0], radius: 12 },
        hasBalloon: true,
        zIndex: 1000,
      },
    );
    endMarkerLayer.add(endMarker);

    if (sorted.length <= 250) {
      for (const point of sorted) {
        pointsLayer.add(
          dotPlacemark(
            [Number(point.lat), Number(point.lon)],
            5,
            SPEED_COLORS[speedClass(Number(point.speed_kmh) || 0)],
            `${formatTime(point.received_at)} · ${speedLabel(point.speed_kmh)}`,
            100,
          ),
        );
      }
    }

    const key = `${state.selectedOrder}|${state.selectedDevice}`;
    if (state.fittedKey !== key) {
      state.fittedKey = key;
      if (sorted.length === 1) {
        map.setCenter([Number(first.lat), Number(first.lon)], 16);
      } else {
        map
          .setBounds(
            ymaps.util.bounds.fromPoints(
              sorted.map((point) => [Number(point.lat), Number(point.lon)]),
            ),
            { checkZoomRange: true, zoomMargin: 40, duration: 250 },
          )
          .then(() => {
            if (map.getZoom() > 17) map.setZoom(17);
          });
      }
    } else if (state.follow) {
      map.panTo([Number(last.lat), Number(last.lon)], { duration: 400 });
    }

    const deviceText = state.selectedDevice || 'все устройства';
    els.mapMeta.textContent = `#${state.selectedOrder} · ${sorted.length} т. · ${deviceText} · ${formatTime(last.received_at)}`;
  }

  // ----------------------------------------------------------------- replay

  function replayPoints() {
    return sortPoints(filteredPoints());
  }

  function syncReplayRange() {
    const points = replayPoints();
    const max = Math.max(0, points.length - 1);
    els.replayRange.max = String(max);
    if (state.replay.index > max) state.replay.index = max;
    els.replayRange.value = String(state.replay.index);
    els.replayPlay.disabled = points.length === 0;
    els.replayRange.disabled = points.length === 0;
    els.replayCounter.textContent = points.length
      ? `${Math.min(state.replay.index + 1, points.length)} / ${points.length}`
      : '0 / 0';
    if (points.length === 0) {
      els.replayInfo.textContent = '—';
      replayLayer.removeAll();
      replayMarker = null;
      return;
    }
    if (!replayMarker) {
      replayMarker = new ymaps.Placemark(
        [Number(points[0].lat), Number(points[0].lon)],
        { hintContent: 'Проигрывание' },
        {
          iconLayout: replayLayout,
          iconShape: { type: 'Circle', coordinates: [0, 0], radius: 10 },
          hasBalloon: true,
          zIndex: 1200,
        },
      );
      replayLayer.add(replayMarker);
    }
    updateReplayMarker(false);
  }

  function updateReplayMarker(center) {
    const points = replayPoints();
    if (!replayMarker || points.length === 0) return;
    const index = Math.min(state.replay.index, points.length - 1);
    const point = points[index];
    const coords = [Number(point.lat), Number(point.lon)];
    replayMarker.geometry.setCoordinates(coords);
    replayMarker.properties.set(
      'hintContent',
      `Проигрывание · ${formatTime(point.received_at)}`,
    );
    replayMarker.properties.set(
      'balloonContentBody',
      `<strong>Проигрывание</strong><br>${formatTime(point.received_at)}<br>${speedLabel(point.speed_kmh)}`,
    );
    els.replayRange.value = String(index);
    els.replayCounter.textContent = `${index + 1} / ${points.length}`;
    els.replayInfo.textContent = `${formatTime(point.received_at)} · ${speedLabel(point.speed_kmh)} · ${Number(point.lat).toFixed(5)}, ${Number(point.lon).toFixed(5)}`;
    if (center) map.panTo(coords, { duration: 250 });
  }

  function stopReplay() {
    if (state.replay.timer) clearInterval(state.replay.timer);
    state.replay.timer = null;
    state.replay.playing = false;
    els.replayPlay.textContent = '▶';
  }

  function startReplay() {
    const points = replayPoints();
    if (points.length === 0) return;
    if (state.replay.playing) {
      stopReplay();
      return;
    }
    if (state.replay.index >= points.length - 1) state.replay.index = 0;
    state.replay.playing = true;
    els.replayPlay.textContent = '⏸';
    const interval = Math.max(40, Math.round(250 / state.replay.speed));
    state.replay.timer = setInterval(() => {
      const list = replayPoints();
      if (list.length === 0) {
        stopReplay();
        return;
      }
      if (state.replay.index >= list.length - 1) {
        stopReplay();
        return;
      }
      state.replay.index += 1;
      updateReplayMarker(true);
    }, interval);
  }

  // ------------------------------------------------------------------ render

  function renderAll() {
    ensureSelection();
    renderOrderSelect();
    const points = sortPoints(filteredPoints());
    renderDeviceSelect(points);
    renderStats(points);
    renderHistory(points);
    renderRoute(points);
    syncReplayRange();
    updateExportLinks();
  }

  function updateExportLinks() {
    const params = new URLSearchParams();
    if (state.selectedOrder) params.set('order_id', state.selectedOrder);
    if (state.selectedDevice) params.set('device_label', state.selectedDevice);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    els.exportGeoJson.href = `/api/export.geojson${suffix}`;
    els.exportCsv.href = `/api/export.csv${suffix}`;
  }

  function updateRelativeTimes() {
    if (els.lastSeen.dataset.ts) {
      els.lastSeen.textContent = `${formatTime(els.lastSeen.dataset.ts)} · ${timeAgo(els.lastSeen.dataset.ts)}`;
    }
    for (const node of document.querySelectorAll('.ago[data-ts]')) {
      node.textContent = timeAgo(node.dataset.ts);
    }
  }

  // -------------------------------------------------------------------- data

  async function loadOrders() {
    const data = await fetchJson('/api/orders');
    state.orders = data.orders || [];
  }

  async function loadPositions() {
    const data = await fetchJson('/api/positions?limit=50000');
    state.positions = data.positions || [];
  }

  async function loadAll() {
    await Promise.all([loadOrders(), loadPositions()]);
    ensureSelection();
    const devices = availableDevices(filteredPoints());
    if (state.selectedDevice && !devices.includes(state.selectedDevice)) {
      state.selectedDevice = '';
      localStorage.removeItem('receiver.device');
    }
    state.fittedKey = null;
    state.selectedPointId = null;
    renderAll();
  }

  let ordersRefreshTimer = null;
  function scheduleOrdersRefresh() {
    if (ordersRefreshTimer) clearTimeout(ordersRefreshTimer);
    ordersRefreshTimer = setTimeout(async () => {
      try {
        const previousKey = state.orders.map((order) => String(order.order_id)).join(',');
        await loadOrders();
        const nextKey = state.orders.map((order) => String(order.order_id)).join(',');
        ensureSelection();
        if (previousKey !== nextKey) {
          renderOrderSelect();
        }
      } catch (error) {
        console.warn('orders refresh failed', error);
      }
    }, 500);
  }

  function onPosition(point) {
    if (!point || !point.id) return;
    if (state.positions.some((existing) => existing.id === point.id)) return;

    const isSelectedOrder = String(point.order_id) === state.selectedOrder;
    const devicesBefore = isSelectedOrder
      ? availableDevices(filteredPoints()).join('|')
      : '';

    state.positions.push(point);
    if (state.positions.length > MAX_POSITIONS) {
      state.positions.splice(0, state.positions.length - MAX_POSITIONS);
    }

    if (!state.selectedOrder) {
      state.selectedOrder = String(point.order_id);
      localStorage.setItem('receiver.order', state.selectedOrder);
      state.fittedKey = null;
    }

    if (String(point.order_id) === state.selectedOrder) {
      const points = sortPoints(filteredPoints());
      const devicesAfter = availableDevices(points).join('|');
      if (devicesBefore !== devicesAfter) renderDeviceSelect(points);

      renderStats(points);
      renderHistory(points);
      renderRoute(points);
      syncReplayRange();
      updateExportLinks();
    }

    scheduleOrdersRefresh();
  }

  // -------------------------------------------------------------------- SSE

  let eventSource = null;

  function setConnection(mode, text) {
    els.connection.classList.remove('is-live', 'is-retry', 'is-offline');
    if (mode === 'live') els.connection.classList.add('is-live');
    else if (mode === 'retry') els.connection.classList.add('is-retry');
    else els.connection.classList.add('is-offline');
    els.connectionText.textContent = text;
  }

  function connectEvents() {
    if (eventSource) eventSource.close();
    setConnection('retry', 'подключение…');
    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => setConnection('live', 'в эфире');
    eventSource.onerror = () =>
      setConnection('retry', authError ? 'нужен токен' : 'переподключение…');

    eventSource.addEventListener('hello', () => setConnection('live', 'в эфире'));

    eventSource.addEventListener('position', (event) => {
      try {
        const payload = JSON.parse(event.data);
        onPosition(payload.position);
      } catch (error) {
        console.warn('bad position event', error);
      }
    });

    eventSource.addEventListener('reset', () => {
      void loadAll();
    });
  }

  // ----------------------------------------------------------------- events

  els.orderSelect.addEventListener('change', () => {
    state.selectedOrder = els.orderSelect.value;
    localStorage.setItem('receiver.order', state.selectedOrder);
    state.selectedDevice = '';
    localStorage.removeItem('receiver.device');
    state.selectedPointId = null;
    state.fittedKey = null;
    stopReplay();
    state.replay.index = 0;
    renderAll();
  });

  els.deviceSelect.addEventListener('change', () => {
    state.selectedDevice = els.deviceSelect.value;
    if (state.selectedDevice) localStorage.setItem('receiver.device', state.selectedDevice);
    else localStorage.removeItem('receiver.device');
    state.selectedPointId = null;
    state.fittedKey = null;
    stopReplay();
    state.replay.index = 0;
    renderAll();
  });

  els.followToggle.addEventListener('change', () => {
    state.follow = els.followToggle.checked;
    localStorage.setItem('receiver.follow', state.follow ? '1' : '0');
    if (state.follow) {
      const points = replayPoints();
      if (points.length > 0) {
        map.panTo(
          [Number(points[points.length - 1].lat), Number(points[points.length - 1].lon)],
          { duration: 300 },
        );
      }
    }
  });

  function bindMapEvents() {
    map.events.add('actionbegin', () => {
      if (!state.follow) return;
      state.follow = false;
      els.followToggle.checked = false;
      localStorage.setItem('receiver.follow', '0');
    });
  }

  els.historyList.addEventListener('click', (event) => {
    const button = event.target.closest('.entry');
    if (!button) return;
    const point = state.positions.find((item) => item.id === button.dataset.id);
    if (!point) return;
    setSelectedPoint(point.id);
    map.panTo([Number(point.lat), Number(point.lon)], { duration: 300 });
    if (map.getZoom() < 14) map.setZoom(15);
    openPointDialog(point);
  });

  els.replayRange.addEventListener('input', () => {
    stopReplay();
    state.replay.index = Number(els.replayRange.value) || 0;
    updateReplayMarker(true);
  });

  els.replayPlay.addEventListener('click', startReplay);

  els.replaySpeed.addEventListener('change', () => {
    state.replay.speed = Number(els.replaySpeed.value) || 1;
    if (state.replay.playing) {
      stopReplay();
      startReplay();
    }
  });

  els.refreshButton.addEventListener('click', async () => {
    const original = els.refreshButton.textContent;
    els.refreshButton.disabled = true;
    els.refreshButton.textContent = '…';
    try {
      await loadAll();
    } catch (error) {
      console.error(error);
      setConnection('retry', authError ? 'нужен токен' : 'ошибка загрузки');
    } finally {
      els.refreshButton.disabled = false;
      els.refreshButton.textContent = original;
    }
  });

  els.clearButton.addEventListener('click', async () => {
    const scope = state.selectedOrder ? `заказ #${state.selectedOrder}` : 'всю историю';
    if (!window.confirm(`Удалить ${scope}? Действие необратимо.`)) return;
    const params = new URLSearchParams({ confirm: 'yes' });
    if (state.selectedOrder) params.set('order_id', state.selectedOrder);
    try {
      await fetchJson(`/api/positions?${params.toString()}`, { method: 'DELETE' });
      stopReplay();
      state.replay.index = 0;
      state.fittedKey = null;
      await loadAll();
    } catch (error) {
      console.error(error);
      window.alert(`Не удалось очистить историю: ${error.message}`);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateRelativeTimes();
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        connectEvents();
      }
    }
  });

  setInterval(updateRelativeTimes, 1000);

  // ------------------------------------------------------------------- boot

  ymaps.ready(() => {
    initMap();
    bindMapEvents();
    connectEvents();
    void loadAll()
      .then(() => setConnection('live', 'в эфире'))
      .catch((error) => {
        console.error(error);
        setConnection('retry', authError ? 'нужен токен' : 'нет данных');
      });
  });
})();

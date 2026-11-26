(() => {
  'use strict';

  const STORAGE = {
    waypoints: 'sender.waypoints',
    mode: 'sender.mode',
    devices: 'sender.devices',
    preview: 'sender.preview',
    tick: 'sender.tick',
    routeSignature: 'sender.routeSignature',
  };

  const DEFAULT_PREVIEW = {
    enabled: false,
    baseUrl: 'http://127.0.0.1:4000/api',
    orderId: '900001',
    token: 'dev-token',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    simBadge: $('simBadge'),
    deviceCount: $('deviceCount'),
    refreshDevices: $('refreshDevices'),
    deviceList: $('deviceList'),
    deviceHint: $('deviceHint'),
    deviceErrors: $('deviceErrors'),
    routeModeInputs: [...document.querySelectorAll('input[name="routeMode"]')],
    waypointCount: $('waypointCount'),
    buildRoute: $('buildRoute'),
    clearRoute: $('clearRoute'),
    routeSummary: $('routeSummary'),
    waypointList: $('waypointList'),
    tickSelect: $('tickSelect'),
    startSimulation: $('startSimulation'),
    pauseSimulation: $('pauseSimulation'),
    resumeSimulation: $('resumeSimulation'),
    stopSimulation: $('stopSimulation'),
    simClock: $('simClock'),
    progressBar: $('progressBar'),
    livePosition: $('livePosition'),
    liveSpeed: $('liveSpeed'),
    liveDistance: $('liveDistance'),
    liveLeg: $('liveLeg'),
    simErrors: $('simErrors'),
    previewDetails: document.querySelector('.preview-details'),
    previewEnabled: $('previewEnabled'),
    previewUrl: $('previewUrl'),
    previewOrder: $('previewOrder'),
    previewToken: $('previewToken'),
    previewStatus: $('previewStatus'),
    mapMeta: $('mapMeta'),
    toasts: $('toasts'),
  };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  const savedWaypoints = readJson(STORAGE.waypoints, null);
  const savedSelection = readJson(STORAGE.devices, null);
  const savedPreview = readJson(STORAGE.preview, {}) || {};
  // Токен приёмника не храним в localStorage: только в памяти вкладки.
  if (savedPreview && typeof savedPreview === 'object' && 'token' in savedPreview) {
    writeJson(STORAGE.preview, {
      enabled: Boolean(savedPreview.enabled),
      baseUrl: String(savedPreview.baseUrl || DEFAULT_PREVIEW.baseUrl),
      orderId: String(savedPreview.orderId || DEFAULT_PREVIEW.orderId),
    });
  }
  const savedTick = Number(localStorage.getItem(STORAGE.tick) || 1000);

  const state = {
    devices: [],
    deviceErrors: [],
    selectedDeviceIds: new Set(
      Array.isArray(savedSelection) ? savedSelection.map((id) => String(id)) : [],
    ),
    deviceSelectionInitialized: Array.isArray(savedSelection),
    waypoints: Array.isArray(savedWaypoints) ? sanitizeSavedWaypoints(savedWaypoints) : [],
    mode: localStorage.getItem(STORAGE.mode) === 'straight' ? 'straight' : 'osrm',
    route: null,
    routeDirty: true,
    simulation: {
      status: 'idle',
      elapsed_s: 0,
      total_s: 0,
      current: null,
      trail: [],
      errors: {},
      preview: {},
    },
    preview: {
      enabled: Boolean(savedPreview.enabled),
      baseUrl: String(savedPreview.baseUrl || DEFAULT_PREVIEW.baseUrl),
      orderId: String(savedPreview.orderId || DEFAULT_PREVIEW.orderId),
      token: String(DEFAULT_PREVIEW.token),
    },
    tickMs: [500, 1000, 2000, 5000].includes(savedTick) ? savedTick : 1000,
    devicesSignature: '',
    simInitialized: false,
    pollInFlight: false,
    pollTimer: null,
    buildInFlight: false,
    currentMarker: null,
    fitPending: true,
  };

  function sanitizeSavedWaypoints(input) {
    const result = [];
    for (const raw of input) {
      const lat = Number(raw?.lat);
      const lon = Number(raw?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      result.push({
        lat,
        lon,
        speedKmh: clamp(Number(raw?.speedKmh) || 30, 1, 200),
        dwellSec: clamp(Number(raw?.dwellSec) || 0, 0, 3600),
      });
    }
    return result;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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

  function formatTime(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  }

  // -------------------------------------------------------------------- toast

  function toast(message, kind = 'info') {
    const node = document.createElement('div');
    node.className = `toast${kind === 'error' ? ' error' : kind === 'success' ? ' success' : ''}`;
    node.textContent = message;
    els.toasts.appendChild(node);
    setTimeout(() => node.remove(), 4500);
  }

  // --------------------------------------------------------------------- api

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // keep null
    }
    if (!response.ok) {
      const message =
        payload?.meta?.error || payload?.error || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  }

  // ---------------------------------------------------------------------- map

  let map = null;
  let plannedLayer = null;
  let traveledLayer = null;
  let waypointLayer = null;
  let currentLayer = null;
  let waypointLayout = null;
  let simLayout = null;

  function initMap() {
    map = new ymaps.Map('map', {
      center: [55.7558, 37.6173],
      zoom: 12,
      controls: ['zoomControl'],
    });
    plannedLayer = new ymaps.GeoObjectCollection();
    traveledLayer = new ymaps.GeoObjectCollection();
    waypointLayer = new ymaps.GeoObjectCollection();
    currentLayer = new ymaps.GeoObjectCollection();
    map.geoObjects.add(plannedLayer);
    map.geoObjects.add(traveledLayer);
    map.geoObjects.add(waypointLayer);
    map.geoObjects.add(currentLayer);

    waypointLayout = ymaps.templateLayoutFactory.createClass(
      '<div class="wp-marker $[properties.finishClass]">$[properties.iconContent]</div>',
    );
    simLayout = ymaps.templateLayoutFactory.createClass(
      '<div class="sim-marker"></div>',
    );
  }

  // ----------------------------------------------------------------- rendering

  function renderDevices() {
    if (state.devices.length === 0) {
      els.deviceList.innerHTML =
        '<div class="empty">Эмуляторы не найдены.<br>Запустите Android Emulator или iOS Simulator.</div>';
      els.deviceCount.textContent = '0 устройств';
      els.deviceHint.textContent = '—';
    } else {
      const active = isSimulationActive();
      const fragment = document.createDocumentFragment();
      for (const device of state.devices) {
        const checked = state.selectedDeviceIds.has(String(device.id));
        const label = document.createElement('label');
        label.className = 'device';
        label.innerHTML = `
          <input type="checkbox" value="${escapeHtml(device.id)}" ${checked ? 'checked' : ''} ${active ? 'disabled' : ''} />
          <span class="device-main">
            <span class="device-name">
              <span class="platform ${escapeHtml(device.type)}">${device.type === 'android' ? 'Android' : 'iOS'}</span>
              <span>${escapeHtml(device.name)}</span>
            </span>
            <span class="device-sub">${escapeHtml(device.detail)} · ${escapeHtml(device.id)}</span>
          </span>
        `;
        fragment.appendChild(label);
      }
      els.deviceList.innerHTML = '';
      els.deviceList.appendChild(fragment);
      els.deviceCount.textContent = `${state.devices.length} устр.`;
      els.deviceHint.textContent = `${state.selectedDeviceIds.size} выбрано`;
    }

    if (state.deviceErrors.length > 0) {
      els.deviceErrors.classList.remove('hidden');
      els.deviceErrors.textContent = state.deviceErrors.join(' · ');
    } else {
      els.deviceErrors.classList.add('hidden');
      els.deviceErrors.textContent = '';
    }
  }

  function renderWaypoints() {
    els.waypointCount.textContent = `${state.waypoints.length} ${pluralPoints(state.waypoints.length)}`;
    if (state.waypoints.length === 0) {
      els.waypointList.innerHTML =
        '<div class="empty">Добавьте минимум две точки на карте.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    state.waypoints.forEach((waypoint, index) => {
      const isLast = index === state.waypoints.length - 1;
      const row = document.createElement('div');
      row.className = 'waypoint';
      row.dataset.index = String(index);
      row.innerHTML = `
        <div class="waypoint-head">
          <span class="wp-index">${index + 1}</span>
          <span class="wp-coords">${waypoint.lat.toFixed(6)}, ${waypoint.lon.toFixed(6)}</span>
          <button class="icon-button wp-set" type="button" title="Поставить выбранные устройства в эту точку">⌖</button>
          <button class="icon-button danger wp-remove" type="button" title="Удалить точку">×</button>
        </div>
        <div class="wp-fields">
          <label class="field">
            <span>${isLast ? 'Финиш' : 'Скорость до след., км/ч'}</span>
            <input class="wp-speed" type="number" min="1" max="200" step="1"
              value="${waypoint.speedKmh}" ${isLast ? 'disabled' : ''} />
          </label>
          <label class="field">
            <span>Стоянка, с</span>
            <input class="wp-dwell" type="number" min="0" max="600" step="1"
              value="${waypoint.dwellSec}" />
          </label>
          <button class="wp-set wp-set-button" type="button">${isLast ? 'Поставить' : 'Поставить'}</button>
        </div>
      `;
      fragment.appendChild(row);
    });
    els.waypointList.innerHTML = '';
    els.waypointList.appendChild(fragment);
  }

  function pluralPoints(count) {
    if (count % 10 === 1 && count % 100 !== 11) return 'точка';
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'точки';
    return 'точек';
  }

  function renderWaypointMarkers() {
    if (!waypointLayer) return;
    waypointLayer.removeAll();
    const active = isSimulationActive();
    state.waypoints.forEach((waypoint, index) => {
      const isLast = index === state.waypoints.length - 1;
      const marker = new ymaps.Placemark(
        [waypoint.lat, waypoint.lon],
        {
          iconContent: String(index + 1),
          finishClass: isLast ? 'finish' : '',
          hintContent: `#${index + 1} · ${waypoint.lat.toFixed(5)}, ${waypoint.lon.toFixed(5)}`,
        },
        {
          iconLayout: waypointLayout,
          iconShape: { type: 'Circle', coordinates: [0, 0], radius: 16 },
          draggable: !active,
          hasBalloon: false,
          zIndex: 100,
        },
      );
      marker.events.add('dragend', () => {
        const coords = marker.geometry.getCoordinates();
        state.waypoints[index] = {
          ...state.waypoints[index],
          lat: Number(Number(coords[0]).toFixed(7)),
          lon: Number(Number(coords[1]).toFixed(7)),
        };
        persistWaypoints();
        markRouteDirty();
        renderWaypoints();
        renderRoutePreview();
      });
      waypointLayer.add(marker);
    });
  }

  function renderRoutePreview() {
    if (!plannedLayer) return;
    plannedLayer.removeAll();
    if (state.route) {
      plannedLayer.add(
        new ymaps.Polyline(
          state.route.path.map(([lat, lon]) => [lat, lon]),
          {},
          {
            strokeColor: state.routeDirty ? '#64748b' : '#38bdf8',
            strokeWidth: 4,
            strokeOpacity: state.routeDirty ? 0.6 : 0.95,
            strokeStyle: state.routeDirty ? 'dash' : 'solid',
          },
        ),
      );
    } else if (state.waypoints.length >= 2) {
      plannedLayer.add(
        new ymaps.Polyline(
          state.waypoints.map((point) => [point.lat, point.lon]),
          {},
          {
            strokeColor: '#64748b',
            strokeWidth: 2,
            strokeOpacity: 0.7,
            strokeStyle: 'dash',
          },
        ),
      );
    }
  }

  function renderTraveled() {
    if (!traveledLayer) return;
    traveledLayer.removeAll();
    const trail = state.simulation.trail || [];
    if (trail.length >= 2) {
      traveledLayer.add(
        new ymaps.Polyline(
          trail.map(([lat, lon]) => [lat, lon]),
          {},
          { strokeColor: '#22c55e', strokeWidth: 4, strokeOpacity: 0.92 },
        ),
      );
    }
  }

  function renderCurrent() {
    if (!currentLayer) return;
    const current = state.simulation.current;
    if (!current) {
      currentLayer.removeAll();
      state.currentMarker = null;
      return;
    }
    const coords = [Number(current.lat), Number(current.lon)];
    const hint = `${formatNumber(current.speed_kmh, 1)} км/ч · ${formatTime(current.at)}`;
    if (!state.currentMarker) {
      state.currentMarker = new ymaps.Placemark(
        coords,
        { hintContent: hint },
        {
          iconLayout: simLayout,
          iconShape: { type: 'Circle', coordinates: [0, 0], radius: 12 },
          hasBalloon: false,
          zIndex: 2000,
        },
      );
      currentLayer.add(state.currentMarker);
    } else {
      state.currentMarker.geometry.setCoordinates(coords);
      state.currentMarker.properties.set('hintContent', hint);
    }
    const [southWest, northEast] = map.getBounds();
    if (
      coords[0] < southWest[0] ||
      coords[0] > northEast[0] ||
      coords[1] < southWest[1] ||
      coords[1] > northEast[1]
    ) {
      map.panTo(coords, { duration: 400 });
    }
  }

  function renderRouteSummary() {
    if (!state.route) {
      els.routeSummary.classList.add('hidden');
      els.routeSummary.innerHTML = '';
      return;
    }
    els.routeSummary.classList.remove('hidden');
    const legs = (state.route.legs || []).map((leg, index) => {
      const dwell = leg.dwell_s > 0 ? ` · стоянка ${leg.dwell_s} с` : '';
      return `
        <div class="leg">
          <span class="leg-index">${index + 1}</span>
          <span class="leg-text">${formatDistance(leg.distance_m)} · ${formatNumber(leg.speed_kmh, 0)} км/ч${dwell}</span>
          <span class="leg-time">${formatDuration(leg.duration_s)}</span>
        </div>
      `;
    });
    const stale = state.routeDirty
      ? '<div class="hint" style="color:#f59e0b">Точки изменены — постройте маршрут заново.</div>'
      : '';
    els.routeSummary.innerHTML = `
      ${legs.join('')}
      <div class="total-row">
        <span>Итого</span>
        <span>${formatDistance(state.route.total_distance_m)} · ${formatDuration(state.route.total_duration_s)}</span>
      </div>
      ${stale}
    `;
  }

  function renderSimulation() {
    const sim = state.simulation;
    const status = sim.status || 'idle';
    const labels = {
      idle: 'ожидание',
      running: 'в пути',
      paused: 'пауза',
      completed: 'завершено',
      stopped: 'остановлено',
    };
    els.simBadge.className = `status-badge is-${status === 'stopped' ? 'idle' : status}`;
    els.simBadge.textContent = labels[status] || status;

    const elapsed = Number(sim.elapsed_s) || 0;
    const total = Number(sim.total_s) || 0;
    els.simClock.textContent = `${formatDuration(elapsed)} / ${formatDuration(total)}`;
    const percent = total > 0 ? clamp((elapsed / total) * 100, 0, 100) : 0;
    els.progressBar.style.width = `${percent}%`;

    const current = sim.current;
    if (current) {
      els.livePosition.textContent = `${Number(current.lat).toFixed(5)}, ${Number(current.lon).toFixed(5)}`;
      els.liveSpeed.textContent = `${formatNumber(Number(current.speed_kmh) || 0, 1)} км/ч`;
      els.liveDistance.textContent = formatDistance(Number(current.distance_m) || 0);
      els.liveLeg.textContent =
        Number(sim.total_s) > 0
          ? `#${(Number(current.leg_index) || 0) + 1} из ${Math.max(1, (state.route?.legs?.length || 0) || 1)}`
          : '—';
    } else {
      els.livePosition.textContent = '—';
      els.liveSpeed.textContent = '—';
      els.liveDistance.textContent = '—';
      els.liveLeg.textContent = '—';
    }

    const errors = Object.entries(sim.errors || {});
    if (errors.length > 0) {
      els.simErrors.classList.remove('hidden');
      els.simErrors.innerHTML = errors
        .map(([id, value]) => `<div>${escapeHtml(id)}: ${escapeHtml(value.message)}</div>`)
        .join('');
    } else {
      els.simErrors.classList.add('hidden');
      els.simErrors.textContent = '';
    }

    const preview = sim.preview || {};
    if (!state.preview.enabled) {
      els.previewStatus.textContent = 'выключено';
    } else if (preview.last_status) {
      els.previewStatus.textContent = `HTTP ${preview.last_status} · ${formatTime(preview.last_at)}`;
    } else if (preview.last_error) {
      els.previewStatus.textContent = `ошибка: ${preview.last_error}`;
    } else if (status === 'running') {
      els.previewStatus.textContent = 'отправка…';
    } else {
      els.previewStatus.textContent = 'ожидание запуска';
    }

    els.mapMeta.textContent = state.route
      ? `${formatDistance(state.route.total_distance_m)} · ${formatDuration(state.route.total_duration_s)} · ${labels[status] || status}`
      : 'маршрут не построен';

    updateActionButtons();
  }

  function isSimulationActive() {
    return state.simulation.status === 'running' || state.simulation.status === 'paused';
  }

  function updateActionButtons() {
    const active = isSimulationActive();
    const status = state.simulation.status;
    els.buildRoute.disabled =
      state.waypoints.length < 2 || active || state.buildInFlight;
    els.clearRoute.disabled = active;
    els.startSimulation.disabled =
      active ||
      state.waypoints.length < 2 ||
      state.selectedDeviceIds.size === 0;
    els.pauseSimulation.disabled = status !== 'running';
    els.resumeSimulation.disabled = status !== 'paused';
    els.stopSimulation.disabled = status !== 'running' && status !== 'paused';
    els.tickSelect.disabled = active;
    for (const input of [
      els.previewEnabled,
      els.previewUrl,
      els.previewOrder,
      els.previewToken,
    ]) {
      input.disabled = active;
    }
    els.waypointList
      .querySelectorAll('.wp-speed, .wp-dwell')
      .forEach((input) => {
        if (input.classList.contains('wp-speed') && input.disabled) return;
        input.disabled = active;
      });
    els.deviceList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.disabled = active;
    });
  }

  function renderAll() {
    renderDevices();
    renderWaypoints();
    renderWaypointMarkers();
    renderRoutePreview();
    renderRouteSummary();
    renderTraveled();
    renderCurrent();
    renderSimulation();
  }

  function fitAll() {
    if (!map) return;
    const coordinates = state.route
      ? state.route.path.map(([lat, lon]) => [lat, lon])
      : state.waypoints.map((point) => [point.lat, point.lon]);
    if (coordinates.length === 0) return;
    if (coordinates.length === 1) {
      map.setCenter(coordinates[0], 15);
      return;
    }
    map
      .setBounds(ymaps.util.bounds.fromPoints(coordinates), {
        checkZoomRange: true,
        zoomMargin: 40,
        duration: 250,
      })
      .then(() => {
        if (map.getZoom() > 17) map.setZoom(17);
      });
  }

  // ---------------------------------------------------------------- persistence

  function persistWaypoints() {
    writeJson(STORAGE.waypoints, state.waypoints);
  }

  function persistSelection() {
    writeJson(STORAGE.devices, [...state.selectedDeviceIds]);
  }

  function persistPreview() {
    // Токен не персистим: держим его только в памяти вкладки.
    writeJson(STORAGE.preview, {
      enabled: state.preview.enabled,
      baseUrl: state.preview.baseUrl,
      orderId: state.preview.orderId,
    });
  }

  function persistMode() {
    localStorage.setItem(STORAGE.mode, state.mode);
  }

  function currentRouteSignature() {
    return JSON.stringify({ waypoints: state.waypoints, mode: state.mode });
  }

  function saveRouteSignature() {
    localStorage.setItem(STORAGE.routeSignature, currentRouteSignature());
  }

  function routeSignatureMatches() {
    const saved = localStorage.getItem(STORAGE.routeSignature);
    return saved === currentRouteSignature();
  }

  function markRouteDirty() {
    localStorage.removeItem(STORAGE.routeSignature);
    if (state.routeDirty) {
      renderRoutePreview();
      renderRouteSummary();
      updateActionButtons();
      return;
    }
    state.routeDirty = true;
    renderRoutePreview();
    renderRouteSummary();
    updateActionButtons();
  }

  // -------------------------------------------------------------------- route

  async function buildRoute() {
    if (state.waypoints.length < 2 || state.buildInFlight) return false;
    if (isSimulationActive()) {
      toast('Остановите симуляцию перед построением маршрута', 'error');
      return false;
    }
    state.buildInFlight = true;
    const original = els.buildRoute.textContent;
    els.buildRoute.textContent = 'Строим…';
    els.buildRoute.disabled = true;
    try {
      const payload = await fetchJson('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          waypoints: state.waypoints,
          mode: state.mode,
        }),
      });
      state.route = payload.route;
      state.routeDirty = false;
      saveRouteSignature();
      renderRouteSummary();
      renderRoutePreview();
      renderSimulation();
      fitAll();
      toast(
        `Маршрут готов: ${formatDistance(payload.route.total_distance_m)} · ${formatDuration(payload.route.total_duration_s)}`,
        'success',
      );
      return true;
    } catch (error) {
      toast(`Не удалось построить маршрут: ${error.message}`, 'error');
      return false;
    } finally {
      state.buildInFlight = false;
      els.buildRoute.textContent = original;
      updateActionButtons();
    }
  }

  async function teleportWaypoint(index, sourceElement) {
    const waypoint = state.waypoints[index];
    if (!waypoint) return;
    const deviceIds = [...state.selectedDeviceIds];
    if (deviceIds.length === 0) {
      toast('Выберите хотя бы одно устройство', 'error');
      return;
    }
    const button = sourceElement;
    if (button) button.disabled = true;
    try {
      const payload = await fetchJson('/api/devices/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: waypoint.lat,
          lon: waypoint.lon,
          deviceIds,
        }),
      });
      const ok = payload.results.filter((result) => result.ok).length;
      if (ok === payload.results.length) {
        toast(`Точка ${index + 1} установлена на ${ok} устр.`, 'success');
      } else {
        const errors = payload.results
          .filter((result) => !result.ok)
          .map((result) => `${result.id}: ${result.error}`)
          .join(' · ');
        toast(`Установлено ${ok}/${payload.results.length}. ${errors}`, 'error');
      }
    } catch (error) {
      toast(`Не удалось установить точку: ${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  // --------------------------------------------------------------------- state

  function applyDevices(devices, errors) {
    const list = Array.isArray(devices) ? devices : [];
    const signature = JSON.stringify(
      list.map((device) => [device.id, device.name, device.detail, device.type]),
    );
    const errorsChanged = JSON.stringify(errors || []) !== JSON.stringify(state.deviceErrors);
    if (signature === state.devicesSignature && !errorsChanged) return;

    state.devices = list;
    state.deviceErrors = Array.isArray(errors) ? errors : [];
    state.devicesSignature = signature;

    const available = new Set(list.map((device) => String(device.id)));
    for (const id of [...state.selectedDeviceIds]) {
      if (!available.has(id)) state.selectedDeviceIds.delete(id);
    }
    if (!state.deviceSelectionInitialized) {
      state.deviceSelectionInitialized = true;
      for (const device of list) state.selectedDeviceIds.add(String(device.id));
      persistSelection();
    }
    renderDevices();
    updateActionButtons();
  }

  function applySimulation(simulation) {
    const previousStatus = state.simulation.status;
    const previousCompletedAt = state.simulation.completed_at;
    state.simulation = simulation;

    if (!state.simInitialized) {
      state.simInitialized = true;
    } else {
      if (
        simulation.status === 'completed' &&
        previousStatus !== 'completed' &&
        simulation.completed_at !== previousCompletedAt
      ) {
        toast('Симуляция завершена: курьер доехал до финиша', 'success');
      }
    }

    if (previousStatus !== simulation.status) {
      renderWaypointMarkers();
    }

    renderSimulation();
    renderTraveled();
    renderCurrent();
  }

  function applyState(payload) {
    applyDevices(payload.devices, payload.device_errors);
    if (payload.route) {
      if (!state.route || payload.route.created_at !== state.route.created_at) {
        const hadRoute = Boolean(state.route);
        state.route = payload.route;
        state.routeDirty = !routeSignatureMatches();
        renderRouteSummary();
        renderRoutePreview();
        if (!hadRoute) fitAll();
      }
    } else if (state.route && !state.buildInFlight) {
      state.route = null;
      state.routeDirty = true;
      renderRouteSummary();
      renderRoutePreview();
    }
    if (payload.simulation) applySimulation(payload.simulation);
    updateActionButtons();
  }

  async function pollState({ silent = true } = {}) {
    if (state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      const payload = await fetchJson('/api/state');
      applyState(payload);
    } catch (error) {
      if (!silent) toast(`Нет связи с сервером симулятора: ${error.message}`, 'error');
      els.simBadge.className = 'status-badge is-error';
      els.simBadge.textContent = 'нет связи';
    } finally {
      state.pollInFlight = false;
    }
  }

  // ------------------------------------------------------------------- events

  els.refreshDevices.addEventListener('click', async () => {
    const original = els.refreshDevices.textContent;
    els.refreshDevices.disabled = true;
    els.refreshDevices.textContent = 'Обновляем…';
    try {
      const payload = await fetchJson('/api/devices?refresh=1');
      applyDevices(payload.devices, payload.errors);
      toast(`Устройств найдено: ${payload.devices.length}`, 'success');
    } catch (error) {
      toast(`Не удалось получить устройства: ${error.message}`, 'error');
    } finally {
      els.refreshDevices.disabled = false;
      els.refreshDevices.textContent = original;
    }
  });

  els.deviceList.addEventListener('change', (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) state.selectedDeviceIds.add(String(input.value));
    else state.selectedDeviceIds.delete(String(input.value));
    state.deviceSelectionInitialized = true;
    persistSelection();
    els.deviceHint.textContent = `${state.selectedDeviceIds.size} выбрано`;
    updateActionButtons();
  });

  for (const input of els.routeModeInputs) {
    input.checked = input.value === state.mode;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.mode = input.value;
      persistMode();
      if (state.route) markRouteDirty();
    });
  }

  function bindMapEvents() {
    map.events.add('click', (event) => {
      if (isSimulationActive()) {
        toast('Остановите симуляцию, чтобы менять маршрут', 'error');
        return;
      }
      const coords = event.get('coords');
      const lat = Number(Number(coords[0]).toFixed(7));
      const lon = Number(Number(coords[1]).toFixed(7));
      state.waypoints.push({ lat, lon, speedKmh: 30, dwellSec: 0 });
      persistWaypoints();
      markRouteDirty();
      renderWaypoints();
      renderWaypointMarkers();
      if (state.waypoints.length === 1) fitAll();
    });
  }

  els.waypointList.addEventListener('change', (event) => {
    const row = event.target.closest('.waypoint');
    if (!row) return;
    const index = Number(row.dataset.index);
    const waypoint = state.waypoints[index];
    if (!waypoint) return;
    if (event.target.classList.contains('wp-speed')) {
      waypoint.speedKmh = clamp(Number(event.target.value) || 30, 1, 200);
      event.target.value = String(waypoint.speedKmh);
      persistWaypoints();
      markRouteDirty();
    } else if (event.target.classList.contains('wp-dwell')) {
      waypoint.dwellSec = clamp(Number(event.target.value) || 0, 0, 600);
      event.target.value = String(waypoint.dwellSec);
      persistWaypoints();
      markRouteDirty();
    }
  });

  els.waypointList.addEventListener('click', (event) => {
    const row = event.target.closest('.waypoint');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (event.target.closest('.wp-remove')) {
      if (isSimulationActive()) {
        toast('Остановите симуляцию, чтобы менять маршрут', 'error');
        return;
      }
      state.waypoints.splice(index, 1);
      persistWaypoints();
      markRouteDirty();
      renderWaypoints();
      renderWaypointMarkers();
      renderRoutePreview();
      return;
    }
    if (event.target.closest('.wp-set')) {
      void teleportWaypoint(index, event.target.closest('button'));
    }
  });

  els.buildRoute.addEventListener('click', () => {
    void buildRoute();
  });

  els.clearRoute.addEventListener('click', async () => {
    if (isSimulationActive()) return;
    if (state.waypoints.length === 0 && !state.route) return;
    state.waypoints = [];
    state.route = null;
    state.routeDirty = true;
    persistWaypoints();
    localStorage.removeItem(STORAGE.routeSignature);
    renderWaypoints();
    renderWaypointMarkers();
    renderRoutePreview();
    renderRouteSummary();
    renderSimulation();
    try {
      await fetchJson('/api/route/clear', { method: 'POST' });
      toast('Маршрут очищен');
    } catch (error) {
      toast(`Маршрут очищен локально, сервер не ответил: ${error.message}`, 'error');
    }
  });

  els.tickSelect.addEventListener('change', () => {
    state.tickMs = Number(els.tickSelect.value) || 1000;
    localStorage.setItem(STORAGE.tick, String(state.tickMs));
  });

  els.startSimulation.addEventListener('click', async () => {
    if (isSimulationActive()) return;
    if (state.selectedDeviceIds.size === 0) {
      toast('Выберите хотя бы одно устройство', 'error');
      return;
    }
    if (state.waypoints.length < 2) {
      toast('Добавьте минимум две точки маршрута', 'error');
      return;
    }
    if (!state.route || state.routeDirty) {
      const ok = await buildRoute();
      if (!ok) return;
    }
    const original = els.startSimulation.textContent;
    els.startSimulation.disabled = true;
    els.startSimulation.textContent = 'Запуск…';
    try {
      const payload = await fetchJson('/api/simulation/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [...state.selectedDeviceIds],
          tickMs: state.tickMs,
          preview: state.preview,
        }),
      });
      applySimulation(payload.simulation);
      state.simInitialized = true;
      fitAll();
      toast('Симуляция запущена', 'success');
    } catch (error) {
      toast(`Не удалось запустить: ${error.message}`, 'error');
    } finally {
      els.startSimulation.textContent = original;
      updateActionButtons();
    }
  });

  els.pauseSimulation.addEventListener('click', async () => {
    try {
      const payload = await fetchJson('/api/simulation/pause', { method: 'POST' });
      applySimulation(payload.simulation);
    } catch (error) {
      toast(`Пауза не удалась: ${error.message}`, 'error');
    }
  });

  els.resumeSimulation.addEventListener('click', async () => {
    try {
      const payload = await fetchJson('/api/simulation/resume', { method: 'POST' });
      applySimulation(payload.simulation);
    } catch (error) {
      toast(`Продолжить не удалось: ${error.message}`, 'error');
    }
  });

  els.stopSimulation.addEventListener('click', async () => {
    try {
      const payload = await fetchJson('/api/simulation/stop', { method: 'POST' });
      applySimulation(payload.simulation);
      toast('Симуляция остановлена');
    } catch (error) {
      toast(`Стop не удался: ${error.message}`, 'error');
    }
  });

  function syncPreviewFromInputs() {
    state.preview = {
      enabled: els.previewEnabled.checked,
      baseUrl: els.previewUrl.value.trim() || DEFAULT_PREVIEW.baseUrl,
      orderId: els.previewOrder.value.trim() || DEFAULT_PREVIEW.orderId,
      token: els.previewToken.value.trim(),
    };
    persistPreview();
    renderSimulation();
  }

  for (const input of [
    els.previewEnabled,
    els.previewUrl,
    els.previewOrder,
    els.previewToken,
  ]) {
    input.addEventListener('change', syncPreviewFromInputs);
  }

  // --------------------------------------------------------------------- boot

  ymaps.ready(() => {
    initMap();
    bindMapEvents();

    els.tickSelect.value = String(state.tickMs);
    els.previewEnabled.checked = state.preview.enabled;
    els.previewUrl.value = state.preview.baseUrl;
    els.previewOrder.value = state.preview.orderId;
    els.previewToken.value = state.preview.token;

    renderWaypoints();
    renderWaypointMarkers();
    renderRouteSummary();
    renderRoutePreview();
    renderSimulation();
    if (state.waypoints.length > 0) fitAll();

    void pollState({ silent: false }).then(() => {
      if (state.simulation.status === 'running') fitAll();
    });
    state.pollTimer = setInterval(() => {
      void pollState();
    }, 1000);
  });
})();

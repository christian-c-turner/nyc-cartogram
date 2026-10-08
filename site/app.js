const DATA_URL = new URL("./data/commute_map_data.json", import.meta.url).toString();
const GRAPH_URL = new URL("./data/street_graph.bin", import.meta.url).toString();
const DEFAULT_MAX_TIME_MINUTES = 60;
const MIN_VIEWPORT_SCALE = 1;
const MAX_VIEWPORT_SCALE = 16;
const VIEWPORT_ZOOM_STEP = 1.4;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const MAP_PADDING = 24;
const ROUTE_LINE_WIDTH = 2.2;
const PIN_HIT_RADIUS = 16;
const CLICK_SLOP_PX = 4;
const HEATMAP_ALPHA = 0.8;
const HEATMAP_SHORE_SPREAD_CELLS = 2;
const MINOR_STREET_MAX_METERS_PER_PX = 8;
const STREET_LAYER_MARGIN = 0.3;
const STREET_BUCKET_METERS = 100;
const ORIGIN_SNAP_CANDIDATES = 3;
// Stop expanding the search this many minutes past the colour scale's maximum.
const SEARCH_CUTOFF_EXTRA_MINUTES = 30;
const REACHABILITY_THRESHOLD_MINUTES = 60;
const DEFAULT_DISABLED_MODES = ["bike"];
const SHARE_COORDINATE_DECIMALS = 5;
const METERS_PER_MINUTE_PER_KMH = 1000 / 60;
const SETTINGS_STORAGE_KEY = "cph-cartogram-settings-v1";
const MODES_STORAGE_KEY = "cph-cartogram-modes-v1";
const DISABLED_ROUTE_ALPHA = 0.16;
const WATER_COLOR = "#d9e6ee";
const BIKE_ROUTE_COLOR = "#2E8B57";
const ROUTE_SHAPE_SNAP_METERS = 400;
const SHORT_STREET_LEG_METERS = 150;

const state = {
  data: null,
  graph: null,
  ready: false,
  showHeatmap: true,
  showReachOutline: false,
  showRoute: false,
  routeCache: null,
  routeStepsKey: "",
  shapesByRoute: null,
  canvasSize: null,
  viewportScale: 1,
  viewportCenter: null,
  viewIsInitial: true,
  transform: null,
  originPoint: null,
  originLabel: null,
  probePoint: null,
  drag: null,
  hoverPin: null,
  spaceHeld: false,
  currentRender: null,
  travelSettings: null,
  travelSettingsDefaults: null,
  fieldCache: null,
  streetLayerCache: null,
  heatLayer: null,
  enabledModes: null,
  routeStateEnabled: null,
  stationEnabled: null,
  enabledStationIndexes: null,
  dirty: true,
};

const mapCanvas = document.getElementById("mapCanvas");
const ctx = mapCanvas.getContext("2d");
const statusText = document.getElementById("statusText");
const searchForm = document.getElementById("searchForm");
const addressInput = document.getElementById("addressInput");
const searchButton = document.getElementById("searchButton");
const searchMeta = document.getElementById("searchMeta");
const searchResults = document.getElementById("searchResults");
const locateButton = document.getElementById("locateButton");
const clearButton = document.getElementById("clearButton");
const reachScore = document.getElementById("reachScore");
const routeSteps = document.getElementById("routeSteps");
const routeButton = document.getElementById("routeButton");
const modeToggleContainer = document.querySelector("[data-mode-toggles]");
const settingsInputs = Array.from(document.querySelectorAll("[data-setting-key]"));
const settingsValueLabels = Array.from(document.querySelectorAll("[data-setting-value]"));
const resetSettingsButton = document.getElementById("resetSettingsButton");
const heatmapToggle = document.getElementById("heatmapToggle");
const outlineToggle = document.getElementById("outlineToggle");
const hintBar = document.getElementById("hintBar");
const heatmapLegend = document.getElementById("heatmapLegend");
const heatmapLegendMin = document.getElementById("heatmapLegendMin");
const heatmapLegendMax = document.getElementById("heatmapLegendMax");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const resetViewButton = document.getElementById("resetViewButton");
const copyLinkButton = document.getElementById("copyLinkButton");
const saveImageButton = document.getElementById("saveImageButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const toast = document.getElementById("toast");

// ---------- settings ----------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function metersPerMinuteToKmh(value) {
  return value / METERS_PER_MINUTE_PER_KMH;
}

function kmhToMetersPerMinute(value) {
  return value * METERS_PER_MINUTE_PER_KMH;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function getTravelSettingsDefaults() {
  const meta = state.data?.meta ?? {};
  return {
    walkingSpeed: meta.walkMetersPerMinute ?? 80,
    cyclingSpeed: meta.bikeMetersPerMinute ?? kmhToMetersPerMinute(16),
    maxTransitTime: DEFAULT_MAX_TIME_MINUTES,
  };
}

function sanitizeTravelSettings(rawSettings, defaults = state.travelSettingsDefaults || getTravelSettingsDefaults()) {
  const raw = rawSettings ?? {};
  const pick = (key) => (Number.isFinite(raw[key]) ? raw[key] : defaults[key]);
  // Walking and cycling speeds are fixed at the usual journey-planner assumptions
  // (4.8 km/h and 16 km/h, as Google Maps uses); only the colour scale is adjustable.
  return {
    walkingSpeed: defaults.walkingSpeed,
    cyclingSpeed: defaults.cyclingSpeed,
    maxTransitTime: clamp(pick("maxTransitTime"), 10, 120),
  };
}

function currentTravelSettings() {
  return state.travelSettings || state.travelSettingsDefaults || getTravelSettingsDefaults();
}

function loadStoredTravelSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.error(error);
    return null;
  }
}

function persistTravelSettings() {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(currentTravelSettings()));
  } catch (error) {
    console.error(error);
  }
}

function settingToInputValue(key, value) {
  if (key === "walkingSpeed" || key === "cyclingSpeed") {
    return String(roundToStep(metersPerMinuteToKmh(value), key === "walkingSpeed" ? 0.1 : 0.5).toFixed(1));
  }
  const step = key === "maxTransitTime" ? 5 : 0.5;
  const digits = step < 1 ? 1 : 0;
  return String(roundToStep(value, step).toFixed(digits));
}

function formatSettingLabel(key, value) {
  if (key === "walkingSpeed" || key === "cyclingSpeed") {
    return `${Number(value).toFixed(1)} km/h`;
  }
  return `${Number(value) % 1 === 0 ? Number(value).toFixed(0) : Number(value).toFixed(1)} min`;
}

function syncTravelSettingsInputs() {
  const settings = currentTravelSettings();
  for (const input of settingsInputs) {
    const key = input.dataset.settingKey;
    if (!key || !(key in settings)) continue;
    input.value = settingToInputValue(key, settings[key]);
  }
  for (const label of settingsValueLabels) {
    const key = label.dataset.settingValue;
    if (!key || !(key in settings)) continue;
    label.textContent = formatSettingLabel(key, Number(settingToInputValue(key, settings[key])));
  }
}

function applyTravelSettings(nextSettings, { persist = true } = {}) {
  state.travelSettings = sanitizeTravelSettings(nextSettings);
  syncTravelSettingsInputs();
  syncHeatmapLegend();
  if (persist) persistTravelSettings();
  state.fieldCache = null;
  state.dirty = true;
  requestDraw();
}

function syncHeatmapLegend() {
  const maxTransitTime = currentTravelSettings().maxTransitTime;
  heatmapLegend.hidden = !state.showHeatmap;
  heatmapLegendMin.textContent = "0m";
  heatmapLegendMax.textContent = `${Math.round(maxTransitTime)}m`;
}

// ---------- geometry, formatting, URLs ----------

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "unreachable";
  if (minutes < 1) return "<1 min";
  return `${Math.round(minutes)} min`;
}

function formatDistanceLabel(minutes) {
  const label = formatMinutes(minutes);
  return label === "unreachable" ? label : `${label} away`;
}

function worldToLonLat(point) {
  const metersPerDegLat = 111_320.0;
  const metersPerDegLon = metersPerDegLat * Math.cos((state.data.meta.lat0 * Math.PI) / 180);
  return {
    lon: point[0] / metersPerDegLon,
    lat: point[1] / metersPerDegLat,
  };
}

function lonLatToWorld(lon, lat) {
  const metersPerDegLat = 111_320.0;
  const metersPerDegLon = metersPerDegLat * Math.cos((state.data.meta.lat0 * Math.PI) / 180);
  return [lon * metersPerDegLon, lat * metersPerDegLat];
}

function withinBounds(point) {
  const [minX, minY, maxX, maxY] = state.data.meta.bounds;
  return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY;
}

function formatCoordinate(value) {
  return Number(value).toFixed(SHARE_COORDINATE_DECIMALS);
}

function formatCoordinatePair(point) {
  const { lat, lon } = worldToLonLat(point);
  return `${formatCoordinate(lat)},${formatCoordinate(lon)}`;
}

function parseCoordinatePair(value) {
  if (!value) return null;
  const match = value.match(/^@?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function parseOriginPath(pathname = window.location.pathname) {
  const match = pathname.match(/\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\/?$/);
  return match ? parseCoordinatePair(`${match[1]},${match[2]}`) : null;
}

function getBasePath() {
  return window.__ASSET_BASE__ || "/";
}

function isLocalStaticDev() {
  return (
    ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    getBasePath().startsWith("/site/")
  );
}

function replaceBrowserUrl(pathOrQuery = "") {
  const nextUrl = new URL(pathOrQuery, window.location.origin + getBasePath());
  window.history.replaceState(null, "", nextUrl);
}

function syncBrowserUrl() {
  replaceBrowserUrl(buildViewUrlFragment());
}

function getShareUrl() {
  const pathOrQuery = buildViewUrlFragment();
  return new URL(pathOrQuery, window.location.origin + getBasePath()).toString();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortOriginLabel(label) {
  if (!label) return "";
  if (label === "My location") return label;
  const primary = label.split(",")[0].trim();
  if (/^\d/.test(primary)) return primary;
  return primary.toLowerCase().startsWith("near ") ? primary : `Near ${primary}`;
}

function currentOriginSummary(nearestStationName = null) {
  if (state.originLabel) return shortOriginLabel(state.originLabel);
  return nearestStationName ? `Near ${nearestStationName}` : "Pinned origin";
}

// ---------- basemap rendering ----------

function heatmapRgb(minutes) {
  const t = clamp(minutes / currentTravelSettings().maxTransitTime, 0, 1);
  const stops = [
    { t: 0, color: [220, 69, 37] },
    { t: 0.2, color: [244, 127, 46] },
    { t: 0.4, color: [255, 196, 79] },
    { t: 0.62, color: [248, 232, 156] },
    { t: 0.8, color: [149, 188, 211] },
    { t: 1, color: [74, 103, 141] },
  ];
  let left = stops[0];
  let right = stops[stops.length - 1];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (t >= stops[index].t && t <= stops[index + 1].t) {
      left = stops[index];
      right = stops[index + 1];
      break;
    }
  }
  const mix = (t - left.t) / ((right.t - left.t) || 1);
  return left.color.map((value, index) => Math.round(value + (right.color[index] - value) * mix));
}

function defaultMapCenter(bounds = state.data?.meta?.bounds) {
  if (!bounds) return [0, 0];
  const [minX, minY, maxX, maxY] = bounds;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function buildTransform(bounds, width, height, padding = PANEL_PADDING, zoom = 1, centerPoint = null) {
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const baseScale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const scale = baseScale * zoom;
  const [rawCenterX, rawCenterY] = centerPoint || defaultMapCenter(bounds);
  const centerX = clamp(rawCenterX, minX, maxX);
  const centerY = clamp(rawCenterY, minY, maxY);
  const offsetX = width / 2;
  const offsetY = height / 2;

  return {
    scale,
    baseScale,
    center: [centerX, centerY],
    cacheKey: `${width}:${height}:${scale}:${centerX}:${centerY}`,
    toScreen(point) {
      const [x, y] = point;
      return [offsetX + (x - centerX) * scale, offsetY - (y - centerY) * scale];
    },
    toWorld(x, y) {
      return [centerX + (x - offsetX) / scale, centerY - (y - offsetY) / scale];
    },
  };
}

function createCanvasBacking(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function createCanvasSurface(width, height) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, context, width, height };
}

function drawPanelBackground(drawCtx, width, height) {
  drawCtx.clearRect(0, 0, width, height);
  drawCtx.fillStyle = WATER_COLOR;
  drawCtx.fillRect(0, 0, width, height);
}

function tracePolygonPath(drawCtx, polygon, projectPoint) {
  for (const ring of polygon) {
    ring.forEach((point, index) => {
      const [sx, sy] = projectPoint(point);
      if (index === 0) drawCtx.moveTo(sx, sy);
      else drawCtx.lineTo(sx, sy);
    });
    drawCtx.closePath();
  }
}

function drawPolygonPath(drawCtx, polygon, projectPoint) {
  drawCtx.beginPath();
  tracePolygonPath(drawCtx, polygon, projectPoint);
}

function landMaskPolygons() {
  if (state.data.landMask?.length) return state.data.landMask;
  return state.data.municipalities.flatMap((municipality) => municipality.polygons);
}

function traceLandMaskPath(drawCtx, projectPoint) {
  drawCtx.beginPath();
  for (const polygon of landMaskPolygons()) {
    tracePolygonPath(drawCtx, polygon, projectPoint);
  }
}

function fillLandMask(drawCtx, projectPoint) {
  traceLandMaskPath(drawCtx, projectPoint);
  drawCtx.fillStyle = "#f3f6fa";
  drawCtx.fill("evenodd");
}

function drawExternalLand(drawCtx, projectPoint) {
  const polygons = state.data.externalLand || [];
  if (!polygons.length) return;
  drawCtx.save();
  // Land outside the modelled municipalities: drawn as muted context.
  drawCtx.fillStyle = "#e8ebe7";
  drawCtx.strokeStyle = "rgba(79, 105, 135, 0.25)";
  drawCtx.lineWidth = 0.75;
  drawCtx.lineJoin = "round";
  for (const polygon of polygons) {
    drawPolygonPath(drawCtx, polygon, projectPoint);
    drawCtx.fill();
    drawCtx.stroke();
  }
  drawCtx.restore();
}

function drawPolyline(drawCtx, points, projectPoint) {
  if (!points.length) return;
  drawCtx.beginPath();
  const [startX, startY] = projectPoint(points[0]);
  drawCtx.moveTo(startX, startY);
  for (let index = 1; index < points.length; index += 1) {
    const [x, y] = projectPoint(points[index]);
    drawCtx.lineTo(x, y);
  }
  drawCtx.stroke();
}

function drawCityBasemap(drawCtx, projectPoint, transform) {
  fillLandMask(drawCtx, projectPoint);

  for (const polygon of state.data.parks) {
    drawPolygonPath(drawCtx, polygon, projectPoint);
    drawCtx.fillStyle = "#dbeacd";
    drawCtx.strokeStyle = "#a7c39b";
    drawCtx.lineWidth = 0.45;
    drawCtx.fill();
    drawCtx.stroke();
  }

  for (const polygon of state.data.water || []) {
    drawPolygonPath(drawCtx, polygon, projectPoint);
    drawCtx.fillStyle = WATER_COLOR;
    drawCtx.fill("evenodd");
  }

  drawMinorStreets(drawCtx, transform);

  for (const street of state.data.streets) {
    drawCtx.strokeStyle = "rgba(193, 202, 212, 0.92)";
    drawCtx.lineWidth = streetWidth(street.kind);
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawPolyline(drawCtx, street.points, projectPoint);
  }

  // Lines for switched-off modes stay as faint context underneath the active network.
  const disabledRoutes = state.data.routes.filter((route) => !isRouteEnabled(route.routeId));
  const enabledRoutes = state.data.routes.filter((route) => isRouteEnabled(route.routeId));
  for (const route of [...disabledRoutes, ...enabledRoutes]) {
    drawCtx.save();
    if (!isRouteEnabled(route.routeId)) drawCtx.globalAlpha = DISABLED_ROUTE_ALPHA;
    drawCtx.strokeStyle = route.color;
    drawCtx.lineWidth = ROUTE_LINE_WIDTH;
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawPolyline(drawCtx, route.points, projectPoint);
    drawCtx.restore();
  }

  for (const municipality of state.data.municipalities) {
    for (const polygon of municipality.polygons) {
      drawPolygonPath(drawCtx, polygon, projectPoint);
      drawCtx.strokeStyle = "#4f6987";
      drawCtx.lineWidth = 1.05;
      drawCtx.stroke();
    }
  }
}

function drawStations(drawCtx, projectPoint) {
  for (const [index, station] of state.data.stations.entries()) {
    const [sx, sy] = projectPoint(station.point);
    drawCtx.globalAlpha = state.stationEnabled?.[index] === false ? DISABLED_ROUTE_ALPHA * 2 : 1;
    drawCtx.beginPath();
    drawCtx.arc(sx, sy, 1.35, 0, Math.PI * 2);
    drawCtx.fillStyle = "#ffffff";
    drawCtx.fill();
    drawCtx.lineWidth = 0.55;
    drawCtx.strokeStyle = "#5a6e84";
    drawCtx.stroke();
  }
  drawCtx.globalAlpha = 1;
}

function drawMunicipalityLabels(drawCtx, projectPoint) {
  drawCtx.font = '700 12px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  drawCtx.textAlign = "center";
  drawCtx.textBaseline = "middle";
  drawCtx.fillStyle = "#17304d";
  drawCtx.strokeStyle = "rgba(255,252,247,0.95)";
  drawCtx.lineWidth = 5;
  drawCtx.lineJoin = "round";
  for (const municipality of state.data.municipalities) {
    if (!municipality.label) continue;
    const [lx, ly] = projectPoint(municipality.label);
    drawCtx.strokeText(municipality.name, lx, ly);
    drawCtx.fillText(municipality.name, lx, ly);
  }
}

function streetWidth(kind) {
  if (kind === "motorway") return 1.8;
  if (kind === "trunk") return 1.5;
  return 1.1;
}

// ---------- transit modes ----------

function allModeIds() {
  return (state.data?.modes || []).map((mode) => mode.id);
}

function isRouteEnabled(routeId) {
  const mode = state.data.routeStyles?.[routeId]?.mode;
  return !mode || !state.enabledModes || state.enabledModes.has(mode);
}

function defaultModeIds() {
  return allModeIds().filter((mode) => !DEFAULT_DISABLED_MODES.includes(mode));
}

function sanitizeModes(rawModes) {
  if (!Array.isArray(rawModes)) return new Set(defaultModeIds());
  return new Set(allModeIds().filter((mode) => rawModes.includes(mode)));
}

function bikeEnabled() {
  return Boolean(state.enabledModes?.has("bike"));
}

function loadStoredModes() {
  try {
    const raw = window.localStorage.getItem(MODES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function persistModes() {
  try {
    window.localStorage.setItem(MODES_STORAGE_KEY, JSON.stringify([...state.enabledModes]));
  } catch (error) {
    console.error(error);
  }
}

function nearestEnabledStations(point, count) {
  const best = [];
  for (const index of state.enabledStationIndexes) {
    const meters = distance(point, state.data.stations[index].point);
    if (best.length === count && meters >= best[best.length - 1].distance) continue;
    let insertAt = best.length;
    while (insertAt > 0 && best[insertAt - 1].distance > meters) insertAt -= 1;
    best.splice(insertAt, 0, { index, distance: meters });
    if (best.length > count) best.pop();
  }
  return best;
}

function rebuildModeAvailability() {
  const { routeStates, stationStates, stations } = state.data;
  state.routeStateEnabled = routeStates.map((routeState) => isRouteEnabled(routeState.routeId));
  state.stationEnabled = stations.map((_, index) =>
    (stationStates[index] || []).some((stateIndex) => state.routeStateEnabled[stateIndex]),
  );
  state.enabledStationIndexes = stations.map((_, index) => index).filter((index) => state.stationEnabled[index]);
  state.fieldCache = null;
}

function modeSwatchBackground(modeId) {
  const colors = [
    ...new Set(
      Object.values(state.data.routeStyles || {})
        .filter((route) => route.mode === modeId)
        .map((route) => route.color),
    ),
  ];
  const modeColor = state.data.modes?.find((mode) => mode.id === modeId)?.color;
  if (colors.length <= 1) return colors[0] || modeColor || "#808183";
  const step = 100 / colors.length;
  return `linear-gradient(135deg, ${colors
    .map((color, index) => `${color} ${(index * step).toFixed(1)}% ${((index + 1) * step).toFixed(1)}%`)
    .join(", ")})`;
}

function syncModeToggles() {
  for (const input of document.querySelectorAll("[data-mode-toggle]")) {
    input.checked = state.enabledModes.has(input.dataset.modeToggle);
  }
}

function applyEnabledModes(nextModes, { persist = true } = {}) {
  state.enabledModes = sanitizeModes(nextModes);
  rebuildModeAvailability();
  syncModeToggles();
  if (persist) persistModes();
  state.dirty = true;
  requestDraw();
}

function nearestStations(point, count) {
  const settings = currentTravelSettings();
  return nearestEnabledStations(point, count).map(({ index, distance: meters }) => ({
    index,
    name: state.data.stations[index].name,
    walkMinutes: meters / settings.walkingSpeed,
  }));
}

// ---------- street graph + multimodal routing ----------

function loadStreetGraph(buffer) {
  const arrayTypes = { f: Float32Array, I: Uint32Array, i: Int32Array, H: Uint16Array, B: Uint8Array };
  const graph = {};
  for (const [name, [type, offset, length]] of Object.entries(state.data.meta.binary)) {
    graph[name] = new arrayTypes[type](buffer, offset, length);
  }
  const [minX, minY] = state.data.meta.bounds;
  graph.originX = minX;
  graph.originY = minY;
  graph.nodeCount = graph.nodeX.length;

  // Bucket nodes for nearest-node lookups (CSR layout).
  let lowX = Infinity;
  let lowY = Infinity;
  let highX = -Infinity;
  let highY = -Infinity;
  for (let node = 0; node < graph.nodeCount; node += 1) {
    lowX = Math.min(lowX, graph.nodeX[node]);
    lowY = Math.min(lowY, graph.nodeY[node]);
    highX = Math.max(highX, graph.nodeX[node]);
    highY = Math.max(highY, graph.nodeY[node]);
  }
  graph.bucketMinX = lowX;
  graph.bucketMinY = lowY;
  graph.bucketCols = Math.floor((highX - lowX) / STREET_BUCKET_METERS) + 1;
  graph.bucketRows = Math.floor((highY - lowY) / STREET_BUCKET_METERS) + 1;
  const bucketOf = (node) =>
    Math.floor((graph.nodeY[node] - lowY) / STREET_BUCKET_METERS) * graph.bucketCols +
    Math.floor((graph.nodeX[node] - lowX) / STREET_BUCKET_METERS);
  graph.bucketStart = new Uint32Array(graph.bucketCols * graph.bucketRows + 1);
  for (let node = 0; node < graph.nodeCount; node += 1) graph.bucketStart[bucketOf(node) + 1] += 1;
  for (let bucket = 0; bucket < graph.bucketCols * graph.bucketRows; bucket += 1) {
    graph.bucketStart[bucket + 1] += graph.bucketStart[bucket];
  }
  const fill = graph.bucketStart.slice(0, -1);
  graph.bucketNodes = new Uint32Array(graph.bucketStart[graph.bucketCols * graph.bucketRows]);
  for (let node = 0; node < graph.nodeCount; node += 1) graph.bucketNodes[fill[bucketOf(node)]++] = node;

  // Street node -> route states you can board there.
  const routeStates = state.data.routeStates;
  graph.boardStart = new Uint32Array(graph.nodeCount + 1);
  for (const routeState of routeStates) if (routeState.node >= 0) graph.boardStart[routeState.node + 1] += 1;
  for (let node = 0; node < graph.nodeCount; node += 1) graph.boardStart[node + 1] += graph.boardStart[node];
  const boardFill = graph.boardStart.slice(0, -1);
  graph.boardStates = new Uint32Array(graph.boardStart[graph.nodeCount]);
  routeStates.forEach((routeState, index) => {
    if (routeState.node >= 0) graph.boardStates[boardFill[routeState.node]++] = index;
  });
  return graph;
}

function nearestStreetNodes(point, count = 1, maxMeters = 3000) {
  const g = state.graph;
  const px = point[0] - g.originX;
  const py = point[1] - g.originY;
  const bx = Math.floor((px - g.bucketMinX) / STREET_BUCKET_METERS);
  const by = Math.floor((py - g.bucketMinY) / STREET_BUCKET_METERS);
  const best = [];
  for (let ring = 0; ring * STREET_BUCKET_METERS <= maxMeters + STREET_BUCKET_METERS; ring += 1) {
    for (let iy = by - ring; iy <= by + ring; iy += 1) {
      if (iy < 0 || iy >= g.bucketRows) continue;
      for (let ix = bx - ring; ix <= bx + ring; ix += 1) {
        if (ix < 0 || ix >= g.bucketCols) continue;
        if (Math.max(Math.abs(ix - bx), Math.abs(iy - by)) !== ring) continue;
        const bucket = iy * g.bucketCols + ix;
        for (let k = g.bucketStart[bucket]; k < g.bucketStart[bucket + 1]; k += 1) {
          const node = g.bucketNodes[k];
          // Only nodes in the main walkable network are snap targets (some are reachable only by bike).
          if (!g.nodeSnappable[node]) continue;
          const meters = Math.hypot(g.nodeX[node] - px, g.nodeY[node] - py);
          if (best.length === count && meters >= best[best.length - 1].meters) continue;
          let insertAt = best.length;
          while (insertAt > 0 && best[insertAt - 1].meters > meters) insertAt -= 1;
          best.splice(insertAt, 0, { node, meters });
          if (best.length > count) best.pop();
        }
      }
    }
    // Buckets in the next ring are at least `ring` bucket-widths away.
    if (best.length === count && best[count - 1].meters <= ring * STREET_BUCKET_METERS) break;
  }
  return best;
}

class MinHeap {
  constructor(capacity = 1 << 16) {
    this.keys = new Float64Array(capacity);
    this.values = new Int32Array(capacity);
    this.size = 0;
  }

  push(value, key) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.keys.length * 2);
      const values = new Int32Array(this.values.length * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    let index = this.size;
    this.size += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[index] = this.keys[parent];
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.keys[index] = key;
    this.values[index] = value;
  }

  // Returns the value with the smallest key; the key is left in this.lastKey.
  pop() {
    const value = this.values[0];
    this.lastKey = this.keys[0];
    this.size -= 1;
    const key = this.keys[this.size];
    const last = this.values[this.size];
    let index = 0;
    while (true) {
      let child = 2 * index + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child += 1;
      if (this.keys[child] >= key) break;
      this.keys[index] = this.keys[child];
      this.values[index] = this.values[child];
      index = child;
    }
    this.keys[index] = key;
    this.values[index] = last;
    return value;
  }
}

function travelFieldKey(originPoint) {
  const settings = currentTravelSettings();
  return [
    originPoint[0].toFixed(1),
    originPoint[1].toFixed(1),
    settings.walkingSpeed.toFixed(2),
    settings.cyclingSpeed.toFixed(2),
    settings.maxTransitTime,
    [...state.enabledModes].sort().join(","),
  ].join("|");
}

function computeTravelField(originPoint) {
  const key = travelFieldKey(originPoint);
  if (state.fieldCache?.key === key) return state.fieldCache;

  const g = state.graph;
  const { meta, routeStates, adjacency, routeWaits, stations } = state.data;
  const settings = currentTravelSettings();
  const bike = bikeEnabled();
  const walkSpeed = settings.walkingSpeed;
  const streetSpeed = bike ? settings.cyclingSpeed : walkSpeed;
  const nodeCount = g.nodeCount;
  const times = new Float64Array(nodeCount + routeStates.length).fill(Infinity);
  // Predecessor of each node on its fastest path, for drawing routes.
  const previous = new Int32Array(nodeCount + routeStates.length).fill(-1);
  const cutoff = Math.max(REACHABILITY_THRESHOLD_MINUTES, settings.maxTransitTime) + SEARCH_CUTOFF_EXTRA_MINUTES;

  const boardCost = new Float32Array(routeStates.length);
  const alightCost = new Float32Array(routeStates.length);
  routeStates.forEach((routeState, index) => {
    const platform =
      (meta.stationAccessMinutes[routeState.mode] ?? 1.5) + (bike ? meta.bikeStationExtraMinutes[routeState.mode] ?? 1 : 0);
    alightCost[index] = routeState.linkMeters / streetSpeed + platform;
    boardCost[index] = alightCost[index] + (routeWaits[routeState.routeId] ?? 4);
  });

  const heap = new MinHeap();
  let current = -1;
  const relax = (index, time) => {
    if (time < times[index]) {
      times[index] = time;
      previous[index] = current;
      heap.push(index, time);
    }
  };
  for (const { node, meters } of nearestStreetNodes(originPoint, ORIGIN_SNAP_CANDIDATES)) {
    relax(node, meters / walkSpeed);
  }

  const { walkFlag, bikeFlag } = meta;
  const bikeMetersPerMinute = settings.cyclingSpeed;
  while (heap.size) {
    current = heap.pop();
    const time = heap.lastKey;
    if (time > times[current]) continue;
    if (time > cutoff) break;
    if (current < nodeCount) {
      for (let edge = g.edgeOffsets[current]; edge < g.edgeOffsets[current + 1]; edge += 1) {
        const flags = g.edgeFlags[edge];
        let speed;
        if (bike && flags & bikeFlag) speed = bikeMetersPerMinute;
        else if (flags & walkFlag) speed = walkSpeed;
        else continue;
        relax(g.edgeTargets[edge], time + g.edgeLengthDm[edge] / 10 / speed);
      }
      for (let k = g.boardStart[current]; k < g.boardStart[current + 1]; k += 1) {
        const routeStateIndex = g.boardStates[k];
        if (state.routeStateEnabled[routeStateIndex]) relax(nodeCount + routeStateIndex, time + boardCost[routeStateIndex]);
      }
    } else {
      const routeStateIndex = current - nodeCount;
      for (const [target, weight] of adjacency[routeStateIndex]) {
        if (state.routeStateEnabled[target]) relax(nodeCount + target, time + weight);
      }
      const exitNode = routeStates[routeStateIndex].node;
      if (exitNode >= 0) relax(exitNode, time + alightCost[routeStateIndex]);
    }
  }

  // Heatmap grid: each land cell is reached from its nearest street node on foot.
  const cellCount = meta.gridCols * meta.gridRows;
  const minutes = new Float32Array(cellCount).fill(Infinity);
  for (let cell = 0; cell < cellCount; cell += 1) {
    const node = g.cellNode[cell];
    if (node >= 0) minutes[cell] = times[node] + g.cellSnapDm[cell] / 10 / walkSpeed;
  }

  // 60-minute reach: enabled stations inside the map, timed at their street entrance.
  let totalStations = 0;
  let reachableStations = 0;
  for (const stationIndex of state.enabledStationIndexes) {
    if (!stations[stationIndex].inView) continue;
    let best = Infinity;
    for (const routeStateIndex of state.data.stationStates[stationIndex]) {
      const node = routeStates[routeStateIndex].node;
      if (node >= 0) best = Math.min(best, times[node]);
    }
    if (best === Infinity && !state.data.stationStates[stationIndex].some((index) => routeStates[index].node >= 0)) continue;
    totalStations += 1;
    if (best <= REACHABILITY_THRESHOLD_MINUTES) reachableStations += 1;
  }

  const nearest = nearestEnabledStations(originPoint, 1)[0];
  state.fieldCache = {
    key,
    times,
    previous,
    bike,
    minutes,
    heatImage: null,
    nearestStationIndex: nearest ? nearest.index : null,
    reachability: {
      reachableStations,
      totalStations,
      ratio: totalStations ? reachableStations / totalStations : 0,
    },
  };
  return state.fieldCache;
}

function measureProbe(field, probePoint) {
  if (!field || !probePoint) return null;
  const walkSpeed = currentTravelSettings().walkingSpeed;
  let best = Infinity;
  for (const { node, meters } of nearestStreetNodes(probePoint, ORIGIN_SNAP_CANDIDATES)) {
    best = Math.min(best, field.times[node] + meters / walkSpeed);
  }
  return best;
}

// ---------- route from the start pin to the measure pin ----------

function streetNodePoint(node) {
  const g = state.graph;
  return [g.nodeX[node] + g.originX, g.nodeY[node] + g.originY];
}

function streetEdgeIsBike(field, from, to) {
  if (!field.bike) return false;
  const g = state.graph;
  for (let edge = g.edgeOffsets[from]; edge < g.edgeOffsets[from + 1]; edge += 1) {
    if (g.edgeTargets[edge] === to) return Boolean(g.edgeFlags[edge] & state.data.meta.bikeFlag);
  }
  return false;
}

function projectOntoPolyline(points, point) {
  let best = { distance: Infinity, segment: 0, t: 0, point: points[0] };
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? clamp(((point[0] - x1) * dx + (point[1] - y1) * dy) / lengthSq, 0, 1) : 0;
    const projected = [x1 + dx * t, y1 + dy * t];
    const meters = distance(point, projected);
    if (meters < best.distance) best = { distance: meters, segment: index, t, point: projected };
  }
  return best;
}

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

// The stretch of a line's GTFS shape between two stations; a straight hop if no shape fits.
function routeSubpath(routeId, from, to) {
  if (!state.shapesByRoute) {
    state.shapesByRoute = new Map();
    for (const shape of state.data.routes) {
      if (!state.shapesByRoute.has(shape.routeId)) state.shapesByRoute.set(shape.routeId, []);
      state.shapesByRoute.get(shape.routeId).push(shape.points);
    }
  }
  const straight = distance(from, to);
  let best = null;
  for (const points of state.shapesByRoute.get(routeId) || []) {
    const a = projectOntoPolyline(points, from);
    const b = projectOntoPolyline(points, to);
    if (a.distance > ROUTE_SHAPE_SNAP_METERS || b.distance > ROUTE_SHAPE_SNAP_METERS) continue;
    const forward = a.segment + a.t <= b.segment + b.t;
    const [start, end] = forward ? [a, b] : [b, a];
    const path = [start.point, ...points.slice(start.segment + 1, end.segment + 1), end.point];
    if (!forward) path.reverse();
    const length = polylineLength(path);
    // Reject wrap-arounds (e.g. the long way round a loop line).
    if (length > straight * 2.5 + 300) continue;
    if (!best || length < best.length) best = { path, length };
  }
  return best ? best.path : [from, to];
}

function traceRoute(field, probePoint) {
  if (!field?.previous || !probePoint) return null;
  const cacheKey = `${field.key}|${probePoint[0].toFixed(1)}|${probePoint[1].toFixed(1)}`;
  if (state.routeCache?.key === cacheKey) return state.routeCache.route;

  const walkSpeed = currentTravelSettings().walkingSpeed;
  let end = null;
  for (const { node, meters } of nearestStreetNodes(probePoint, ORIGIN_SNAP_CANDIDATES)) {
    const time = field.times[node] + meters / walkSpeed;
    if (!end || time < end.time) end = { node, meters, time };
  }
  let route = null;
  if (end && Number.isFinite(end.time)) {
    const chain = [];
    for (let index = end.node; index !== -1 && chain.length < 1_000_000; index = field.previous[index]) chain.push(index);
    chain.reverse();
    route = { legs: buildRouteLegs(field, chain, end), total: end.time };
  }
  state.routeCache = { key: cacheKey, route };
  return route;
}

function buildRouteLegs(field, chain, end) {
  const nodeCount = state.graph.nodeCount;
  const { routeStates, stations, routeStyles } = state.data;
  const times = field.times;
  const legs = [];
  const pushStreetLeg = (nodes, bike, startTime, endTime) => {
    if (nodes.length < 2) return;
    const points = nodes.map(streetNodePoint);
    const meters = polylineLength(points);
    const previousLeg = legs[legs.length - 1];
    if (previousLeg && previousLeg.type === (bike ? "bike" : "walk")) {
      previousLeg.points.push(...points.slice(1));
      previousLeg.meters += meters;
      previousLeg.minutes += endTime - startTime;
      return;
    }
    legs.push({ type: bike ? "bike" : "walk", points, meters, minutes: endTime - startTime });
  };

  let index = 0;
  while (index < chain.length) {
    if (chain[index] < nodeCount) {
      // Street run: split wherever the traveller switches between riding and pushing/walking.
      let runEnd = index;
      while (runEnd + 1 < chain.length && chain[runEnd + 1] < nodeCount) runEnd += 1;
      let segmentStart = index;
      let segmentBike = null;
      for (let k = index; k < runEnd; k += 1) {
        const bike = streetEdgeIsBike(field, chain[k], chain[k + 1]);
        if (segmentBike === null) segmentBike = bike;
        if (bike !== segmentBike) {
          pushStreetLeg(chain.slice(segmentStart, k + 1), segmentBike, times[chain[segmentStart]], times[chain[k]]);
          segmentStart = k;
          segmentBike = bike;
        }
      }
      pushStreetLeg(chain.slice(segmentStart, runEnd + 1), Boolean(segmentBike), times[chain[segmentStart]], times[chain[runEnd]]);
      index = runEnd + 1;
      continue;
    }
    // Transit run: consecutive (station, line) states until the traveller is back on the street.
    let runEnd = index;
    while (runEnd + 1 < chain.length && chain[runEnd + 1] >= nodeCount) runEnd += 1;
    const boardTime = index > 0 ? times[chain[index - 1]] : 0;
    const exitTime = runEnd + 1 < chain.length ? times[chain[runEnd + 1]] : times[chain[runEnd]];
    let groupStart = index;
    let legStartTime = boardTime;
    for (let k = index; k <= runEnd; k += 1) {
      const lastOfGroup = k === runEnd || routeStates[chain[k + 1] - nodeCount].routeId !== routeStates[chain[k] - nodeCount].routeId;
      if (!lastOfGroup) continue;
      const group = chain.slice(groupStart, k + 1).map((value) => routeStates[value - nodeCount]);
      const routeId = group[0].routeId;
      const stationIndexes = group.map((routeState) => routeState.stationIndex);
      const legEndTime = k === runEnd ? exitTime : times[chain[k]];
      const points = [];
      for (let hop = 1; hop < stationIndexes.length; hop += 1) {
        const subpath = routeSubpath(routeId, stations[stationIndexes[hop - 1]].point, stations[stationIndexes[hop]].point);
        points.push(...(points.length ? subpath.slice(1) : subpath));
      }
      if (stationIndexes.length > 1) {
        legs.push({
          type: "ride",
          routeId,
          label: routeStyles[routeId]?.label ?? routeId,
          color: routeStyles[routeId]?.color ?? "#17304d",
          textColor: routeStyles[routeId]?.textColor ?? "#ffffff",
          from: stations[stationIndexes[0]].name,
          to: stations[stationIndexes[stationIndexes.length - 1]].name,
          stops: stationIndexes.length - 1,
          stationPoints: [stations[stationIndexes[0]].point, stations[stationIndexes[stationIndexes.length - 1]].point],
          points,
          minutes: legEndTime - legStartTime,
        });
      }
      groupStart = k + 1;
      legStartTime = legEndTime;
    }
    index = runEnd + 1;
  }

  // The snap from the start pin onto the street network belongs to the first leg.
  if (legs.length && legs[0].type !== "ride") legs[0].minutes += times[chain[0]];

  // The last few metres from the street network to the measure pin.
  const lastLeg = legs[legs.length - 1];
  const walkSpeed = currentTravelSettings().walkingSpeed;
  if (lastLeg && lastLeg.type === "walk") {
    lastLeg.minutes += end.meters / walkSpeed;
    lastLeg.meters += end.meters;
  } else if (end.meters > 1) {
    legs.push({ type: "walk", points: [streetNodePoint(end.node)], meters: end.meters, minutes: end.meters / walkSpeed });
  }
  return mergeShortStreetLegs(legs);
}

// Fold short walk/bike fragments (e.g. pushing the bike across a plaza) into the neighbouring street
// leg, so the itinerary reads "Bike 2.8 km" rather than alternating 40 m pieces.
function mergeShortStreetLegs(legs) {
  const isStreet = (leg) => leg && leg.type !== "ride";
  let merged = true;
  while (merged) {
    merged = false;
    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      if (!isStreet(leg) || leg.meters >= SHORT_STREET_LEG_METERS) continue;
      const neighbourIndex = isStreet(legs[index - 1]) ? index - 1 : isStreet(legs[index + 1]) ? index + 1 : -1;
      if (neighbourIndex === -1) continue;
      const [first, second] = neighbourIndex < index ? [legs[neighbourIndex], leg] : [leg, legs[neighbourIndex]];
      const combined = {
        type: first.meters >= second.meters ? first.type : second.type,
        points: [...first.points, ...second.points.slice(1)],
        meters: first.meters + second.meters,
        minutes: first.minutes + second.minutes,
      };
      legs.splice(Math.min(index, neighbourIndex), 2, combined);
      merged = true;
      break;
    }
  }
  return legs;
}

function drawRoute(drawCtx, route, projectPoint) {
  drawCtx.save();
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  for (const leg of route.legs) {
    if (leg.points.length < 2) continue;
    const screen = leg.points.map(projectPoint);
    const trace = () => {
      drawCtx.beginPath();
      drawCtx.moveTo(screen[0][0], screen[0][1]);
      for (const [x, y] of screen.slice(1)) drawCtx.lineTo(x, y);
    };
    drawCtx.setLineDash([]);
    trace();
    drawCtx.strokeStyle = "rgba(255, 252, 247, 0.95)";
    drawCtx.lineWidth = leg.type === "ride" ? 9 : 6;
    drawCtx.stroke();
    trace();
    if (leg.type === "ride") {
      drawCtx.strokeStyle = leg.color;
      drawCtx.lineWidth = 5;
    } else if (leg.type === "bike") {
      drawCtx.strokeStyle = BIKE_ROUTE_COLOR;
      drawCtx.lineWidth = 3.5;
    } else {
      drawCtx.strokeStyle = "#17304d";
      drawCtx.lineWidth = 3;
      drawCtx.setLineDash([2, 6]);
    }
    drawCtx.stroke();
  }
  drawCtx.setLineDash([]);
  for (const leg of route.legs) {
    if (leg.type !== "ride") continue;
    for (const point of leg.stationPoints) {
      const [x, y] = projectPoint(point);
      drawCtx.beginPath();
      drawCtx.arc(x, y, 5, 0, Math.PI * 2);
      drawCtx.fillStyle = "#ffffff";
      drawCtx.fill();
      drawCtx.lineWidth = 2.5;
      drawCtx.strokeStyle = leg.color;
      drawCtx.stroke();
    }
  }
  drawCtx.restore();
}

function formatMeters(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 10) * 10} m`;
}

function renderRouteSteps(route) {
  const key = route ? JSON.stringify(route.legs.map((leg) => [leg.type, leg.label, leg.from, leg.to, Math.round(leg.minutes), Math.round(leg.meters ?? 0)])) : "";
  if (key === state.routeStepsKey) return;
  state.routeStepsKey = key;
  if (!route) {
    routeSteps.hidden = true;
    routeSteps.innerHTML = "";
    return;
  }
  const rows = route.legs
    .map((leg) => {
      if (leg.type === "ride") {
        const stops = `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`;
        return `<li><span class="route-chip" style="background:${leg.color};color:${leg.textColor}">${escapeHtml(leg.label)}</span>
          <span class="route-text" title="${escapeHtml(`${leg.from} → ${leg.to} · ${stops}`)}">${escapeHtml(leg.from)} → ${escapeHtml(leg.to)} · ${stops}</span>
          <span class="route-time">${formatMinutes(leg.minutes)}</span></li>`;
      }
      const label = leg.type === "bike" ? "Bike" : "Walk";
      return `<li><span class="route-chip route-chip-${leg.type}">${label}</span>
        <span class="route-text">${formatMeters(leg.meters)}</span>
        <span class="route-time">${formatMinutes(leg.minutes)}</span></li>`;
    })
    .join("");
  routeSteps.innerHTML = `<p class="route-total">Fastest route · <strong>${formatMinutes(route.total)}</strong></p><ol>${rows}</ol>
    <p class="route-note">Ride times include waiting and getting to the platform.</p>`;
  routeSteps.hidden = false;
}

// ---------- heatmap, pins, export ----------

function heatmapImage(field) {
  if (field.heatImage) return field.heatImage;
  const { gridCols, gridRows } = state.data.meta;
  const cellNode = state.graph.cellNode;
  // Spread shore values a couple of cells into water/off-map cells so smoothing doesn't fade
  // the colour at the shoreline; water itself is erased with the real outlines in drawHeatmap.
  let values = field.minutes;
  for (let pass = 0; pass < HEATMAP_SHORE_SPREAD_CELLS; pass += 1) {
    const next = values.slice();
    for (let row = 0; row < gridRows; row += 1) {
      for (let col = 0; col < gridCols; col += 1) {
        const index = row * gridCols + col;
        if (cellNode[index] >= 0 || Number.isFinite(values[index])) continue;
        let best = Infinity;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const r = row + dy;
            const c = col + dx;
            if (r < 0 || c < 0 || r >= gridRows || c >= gridCols) continue;
            best = Math.min(best, values[r * gridCols + c]);
          }
        }
        next[index] = best;
      }
    }
    values = next;
  }

  const canvas = document.createElement("canvas");
  canvas.width = gridCols;
  canvas.height = gridRows;
  const context = canvas.getContext("2d");
  const image = context.createImageData(gridCols, gridRows);
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      const minutes = values[row * gridCols + col];
      // Land cells that weren't reached get the "far" colour; other empty cells stay clear.
      if (!Number.isFinite(minutes) && cellNode[row * gridCols + col] < 0) continue;
      const [r, g, b] = heatmapRgb(minutes);
      // Grid rows run south to north; image rows run top to bottom.
      const offset = ((gridRows - 1 - row) * gridCols + col) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  field.heatImage = canvas;
  return canvas;
}

function drawHeatmap(drawCtx, field, transform) {
  const [minX, minY, maxX, maxY] = state.data.meta.bounds;
  const [left, top] = transform.toScreen([minX, maxY]);
  const [right, bottom] = transform.toScreen([maxX, minY]);
  const { width, height } = canvasSize();
  const dpr = window.devicePixelRatio || 1;

  // Render the heat image on its own layer, cut the lakes and canals out along their real
  // outlines, then multiply it onto the land.
  let layer = state.heatLayer;
  if (!layer || layer.width !== Math.round(width * dpr) || layer.height !== Math.round(height * dpr)) {
    layer = document.createElement("canvas");
    layer.width = Math.round(width * dpr);
    layer.height = Math.round(height * dpr);
    state.heatLayer = layer;
  }
  const layerCtx = layer.getContext("2d");
  layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layerCtx.clearRect(0, 0, width, height);
  layerCtx.imageSmoothingEnabled = true;
  layerCtx.imageSmoothingQuality = "high";
  layerCtx.drawImage(heatmapImage(field), left, top, right - left, bottom - top);
  layerCtx.globalCompositeOperation = "destination-out";
  for (const polygon of state.data.water || []) {
    drawPolygonPath(layerCtx, polygon, (point) => transform.toScreen(point));
    layerCtx.fill("evenodd");
  }
  layerCtx.globalCompositeOperation = "source-over";

  drawCtx.save();
  traceLandMaskPath(drawCtx, (point) => transform.toScreen(point));
  drawCtx.clip("evenodd");
  drawCtx.globalCompositeOperation = "multiply";
  drawCtx.globalAlpha = HEATMAP_ALPHA;
  drawCtx.drawImage(layer, 0, 0, width, height);
  drawCtx.restore();
}

function drawReachabilityOutline(drawCtx, field, transform) {
  const threshold = currentTravelSettings().maxTransitTime;
  const { gridCols, gridRows, bounds } = state.data.meta;
  const [minX, minY, maxX, maxY] = bounds;
  const cellW = (maxX - minX) / gridCols;
  const cellH = (maxY - minY) / gridRows;
  const inGrid = (row, col) => row >= 0 && row < gridRows && col >= 0 && col < gridCols;
  const isReachable = (row, col) => inGrid(row, col) && field.minutes[row * gridCols + col] <= threshold;
  // Only trace the time frontier: edges against water or the map edge are skipped.
  const isFrontier = (row, col) =>
    inGrid(row, col) && state.graph.cellNode[row * gridCols + col] >= 0 && !isReachable(row, col);
  const cellCorner = (row, col) => [minX + col * cellW, minY + row * cellH];

  const drawEdge = (start, end) => {
    const [sx, sy] = transform.toScreen(start);
    const [ex, ey] = transform.toScreen(end);
    drawCtx.moveTo(sx, sy);
    drawCtx.lineTo(ex, ey);
  };

  drawCtx.save();
  drawCtx.lineJoin = "round";
  drawCtx.lineCap = "round";

  drawCtx.beginPath();
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!isReachable(row, col)) continue;

      if (isFrontier(row - 1, col)) {
        drawEdge(cellCorner(row, col), cellCorner(row, col + 1));
      }
      if (isFrontier(row, col + 1)) {
        drawEdge(cellCorner(row, col + 1), cellCorner(row + 1, col + 1));
      }
      if (isFrontier(row + 1, col)) {
        drawEdge(cellCorner(row + 1, col + 1), cellCorner(row + 1, col));
      }
      if (isFrontier(row, col - 1)) {
        drawEdge(cellCorner(row + 1, col), cellCorner(row, col));
      }
    }
  }

  drawCtx.strokeStyle = "rgba(255, 248, 239, 0.95)";
  drawCtx.lineWidth = 4;
  drawCtx.stroke();

  drawCtx.strokeStyle = "rgba(215, 92, 46, 0.98)";
  drawCtx.lineWidth = 2;
  drawCtx.stroke();
  drawCtx.restore();
}

function drawMarker(drawCtx, screenPoint, color, glowRadius, radius, glowAlpha = 0.5) {
  const [sx, sy] = screenPoint;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const halo = drawCtx.createRadialGradient(sx, sy, 2, sx, sy, glowRadius);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  drawCtx.fillStyle = halo;
  drawCtx.beginPath();
  drawCtx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
  drawCtx.fill();

  drawCtx.beginPath();
  drawCtx.arc(sx, sy, radius, 0, Math.PI * 2);
  drawCtx.fillStyle = "#fff7ef";
  drawCtx.fill();
  drawCtx.lineWidth = 2;
  drawCtx.strokeStyle = color;
  drawCtx.stroke();
}

function drawHoverTooltip(drawCtx, screenPoint, label) {
  const [sx, sy] = screenPoint;
  drawCtx.save();
  drawCtx.font = '700 13px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  drawCtx.textAlign = "center";
  drawCtx.textBaseline = "middle";

  const metrics = drawCtx.measureText(label);
  const paddingX = 10;
  const boxWidth = metrics.width + paddingX * 2;
  const boxHeight = 28;
  const boxX = clamp(sx - boxWidth / 2, 12, drawCtx.canvas.clientWidth - boxWidth - 12);
  const boxY = clamp(sy + 16, 12, drawCtx.canvas.clientHeight - boxHeight - 12);

  drawCtx.fillStyle = "rgba(23, 48, 77, 0.92)";
  drawCtx.beginPath();
  drawCtx.roundRect(boxX, boxY, boxWidth, boxHeight, 10);
  drawCtx.fill();

  drawCtx.fillStyle = "#fff8ef";
  drawCtx.fillText(label, boxX + boxWidth / 2, boxY + boxHeight / 2 + 0.5);
  drawCtx.restore();
}

function drawPinnedLabel(drawCtx, screenPoint, label, options = {}) {
  const {
    offsetX = 18,
    offsetY = -20,
    align = "left",
  } = options;
  const [sx, sy] = screenPoint;
  drawCtx.save();
  drawCtx.font = '700 13px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  drawCtx.textAlign = "left";
  drawCtx.textBaseline = "middle";

  const metrics = drawCtx.measureText(label);
  const paddingX = 10;
  const boxWidth = metrics.width + paddingX * 2;
  const boxHeight = 28;
  const desiredX = align === "right" ? sx - offsetX - boxWidth : sx + offsetX;
  const boxX = clamp(desiredX, 12, drawCtx.canvas.clientWidth - boxWidth - 12);
  const boxY = clamp(sy + offsetY, 12, drawCtx.canvas.clientHeight - boxHeight - 12);

  drawCtx.fillStyle = "rgba(255, 248, 239, 0.96)";
  drawCtx.beginPath();
  drawCtx.roundRect(boxX, boxY, boxWidth, boxHeight, 10);
  drawCtx.fill();
  drawCtx.strokeStyle = "rgba(23, 48, 77, 0.14)";
  drawCtx.lineWidth = 1;
  drawCtx.stroke();

  drawCtx.fillStyle = "#17304d";
  drawCtx.fillText(label, boxX + paddingX, boxY + boxHeight / 2 + 0.5);
  drawCtx.restore();
}

function roundRectPath(drawCtx, x, y, width, height, radius) {
  drawCtx.beginPath();
  drawCtx.roundRect(x, y, width, height, radius);
}

function exportShareImage() {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = 1080;
  exportCanvas.height = 1240;
  const exportCtx = exportCanvas.getContext("2d");

  const bg = exportCtx.createLinearGradient(0, 0, 0, exportCanvas.height);
  bg.addColorStop(0, "#fbf5ea");
  bg.addColorStop(1, "#f2eadb");
  exportCtx.fillStyle = bg;
  exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

  exportCtx.fillStyle = "rgba(215, 92, 46, 0.1)";
  exportCtx.beginPath();
  exportCtx.arc(180, 150, 180, 0, Math.PI * 2);
  exportCtx.fill();
  exportCtx.fillStyle = "rgba(40, 112, 129, 0.08)";
  exportCtx.beginPath();
  exportCtx.arc(930, 190, 210, 0, Math.PI * 2);
  exportCtx.fill();

  exportCtx.fillStyle = "#d75c2e";
  exportCtx.font = '700 28px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("TRAVEL TIME MAP", 72, 86);

  exportCtx.fillStyle = "#17304d";
  exportCtx.font = '700 58px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("Copenhagen", 72, 146);

  const field = state.currentRender?.field ?? null;
  const nearestStationName =
    field && field.nearestStationIndex !== null ? state.data.stations[field.nearestStationIndex].name : null;
  const probeMinutes = state.probePoint ? measureProbe(field, state.probePoint) : null;

  const cardX = 50;
  const cardY = 198;
  const cardSize = 980;
  roundRectPath(exportCtx, cardX, cardY, cardSize, cardSize, 38);
  exportCtx.fillStyle = "rgba(255, 252, 247, 0.92)";
  exportCtx.fill();
  exportCtx.strokeStyle = "rgba(23, 48, 77, 0.1)";
  exportCtx.lineWidth = 2;
  exportCtx.stroke();

  const inset = 28;
  const mapX = cardX + inset;
  const mapY = cardY + inset;
  const mapSize = cardSize - inset * 2;
  const sourceWidthCss = mapCanvas.clientWidth;
  const sourceHeightCss = mapCanvas.clientHeight;
  const sourceSquareCss = Math.min(sourceWidthCss, sourceHeightCss);
  const sourceXCss = (sourceWidthCss - sourceSquareCss) / 2;
  const sourceYCss = (sourceHeightCss - sourceSquareCss) / 2;
  const sourceScaleX = mapCanvas.width / Math.max(sourceWidthCss, 1);
  const sourceScaleY = mapCanvas.height / Math.max(sourceHeightCss, 1);
  roundRectPath(exportCtx, mapX, mapY, mapSize, mapSize, 28);
  exportCtx.save();
  exportCtx.clip();
  exportCtx.drawImage(
    mapCanvas,
    sourceXCss * sourceScaleX,
    sourceYCss * sourceScaleY,
    sourceSquareCss * sourceScaleX,
    sourceSquareCss * sourceScaleY,
    mapX,
    mapY,
    mapSize,
    mapSize,
  );
  if (state.originPoint && state.currentRender?.projectPoint) {
    const originScreen = state.currentRender.projectPoint(state.originPoint);
    drawPinnedLabel(
      exportCtx,
      [
        mapX + ((originScreen[0] - sourceXCss) / sourceSquareCss) * mapSize,
        mapY + ((originScreen[1] - sourceYCss) / sourceSquareCss) * mapSize,
      ],
      currentOriginSummary(nearestStationName),
    );
  }
  if (probeMinutes !== null && state.currentRender?.projectPoint && state.probePoint) {
    const probeScreen = state.currentRender.projectPoint(state.probePoint);
    drawHoverTooltip(
      exportCtx,
      [
        mapX + ((probeScreen[0] - sourceXCss) / sourceSquareCss) * mapSize,
        mapY + ((probeScreen[1] - sourceYCss) / sourceSquareCss) * mapSize,
      ],
      formatDistanceLabel(probeMinutes),
    );
  }

  const reachability = field?.reachability ?? null;
  if (reachability) {
    const badgeX = mapX + 26;
    const badgeY = mapY + 24;
    const badgeWidth = 310;
    const badgeHeight = 110;
    const percent = Math.round(reachability.ratio * 100);

    exportCtx.fillStyle = "rgba(255, 252, 247, 0.9)";
    exportCtx.beginPath();
    exportCtx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 22);
    exportCtx.fill();

    exportCtx.strokeStyle = "rgba(23, 48, 77, 0.12)";
    exportCtx.lineWidth = 1.5;
    exportCtx.stroke();

    exportCtx.fillStyle = "#5f6f7f";
    exportCtx.font = '700 17px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.fillText("60-MINUTE REACH", badgeX + 20, badgeY + 26);

    exportCtx.fillStyle = "#17304d";
    exportCtx.font = '700 42px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.fillText(
      `${reachability.reachableStations} / ${reachability.totalStations}`,
      badgeX + 20,
      badgeY + 68,
    );

    exportCtx.fillStyle = "#5f6f7f";
    exportCtx.font = '500 18px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.fillText(`${percent}% of stations within 60 min`, badgeX + 20, badgeY + 94);
  }
  exportCtx.restore();

  if (state.showHeatmap) {
    const maxTransitTime = currentTravelSettings().maxTransitTime;
    const legendWidth = 360;
    const leftLabelWidth = 50;
    const rightLabelWidth = 80;
    const legendX = cardX + cardSize - inset - legendWidth - 10;
    const legendY = cardY + cardSize - inset - 30;
    const legendLineX = legendX + leftLabelWidth;
    const legendLineY = legendY;
    const legendLineWidth = legendWidth - leftLabelWidth - rightLabelWidth;

    exportCtx.font = '600 23px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.textBaseline = "middle";
    exportCtx.fillStyle = "#17304d";
    exportCtx.fillText("0m", legendX, legendY);

    const legendGradient = exportCtx.createLinearGradient(legendLineX, legendLineY, legendLineX + legendLineWidth, legendLineY);
    legendGradient.addColorStop(0, "#dc4525");
    legendGradient.addColorStop(0.18, "#f47f2e");
    legendGradient.addColorStop(0.36, "#ffc44f");
    legendGradient.addColorStop(0.58, "#f8e89c");
    legendGradient.addColorStop(0.78, "#95bcd3");
    legendGradient.addColorStop(1, "#4a678d");
    exportCtx.strokeStyle = legendGradient;
    exportCtx.lineWidth = 16;
    exportCtx.lineCap = "round";
    exportCtx.beginPath();
    exportCtx.moveTo(legendLineX, legendLineY);
    exportCtx.lineTo(legendLineX + legendLineWidth, legendLineY);
    exportCtx.stroke();

    exportCtx.textAlign = "right";
    exportCtx.fillText(`${Math.round(maxTransitTime)}m`, legendX + legendWidth, legendY);
    exportCtx.textAlign = "left";
  }

  exportCtx.fillStyle = "#17304d";
  exportCtx.font = '700 24px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("Copenhagen Commute POV", 72, 1202);

  exportCtx.textAlign = "right";
  exportCtx.fillStyle = "#5f6f7f";
  exportCtx.font = '500 12px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("Data: Rejseplanen GTFS, OpenStreetMap", 1008, 1202);
  exportCtx.textAlign = "left";

  return exportCanvas;
}

function searchViewbox() {
  const [minX, minY, maxX, maxY] = state.data.meta.bounds;
  const southWest = worldToLonLat([minX, minY]);
  const northEast = worldToLonLat([maxX, maxY]);
  return [southWest.lon, northEast.lat, northEast.lon, southWest.lat].map((value) => value.toFixed(3)).join(",");
}

async function searchAddress(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "dk",
    "accept-language": "da,en",
    limit: "5",
    bounded: "1",
    viewbox: searchViewbox(),
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`);
  }
  const payload = await response.json();
  return payload.map((item) => ({
    title: item.display_name.split(",").slice(0, 2).join(",").trim(),
    subtitle: item.display_name,
    lat: Number(item.lat),
    lon: Number(item.lon),
  }));
}

// ---------- viewport ----------

function canvasSize() {
  return state.canvasSize || { width: mapCanvas.clientWidth, height: mapCanvas.clientHeight };
}

function fitScale(box, width, height) {
  return Math.min((width - MAP_PADDING * 2) / (box[2] - box[0]), (height - MAP_PADDING * 2) / (box[3] - box[1]));
}

// Opening view: central Copenhagen out to Rødovre, fitted to the window.
function initialViewport() {
  const { width, height } = canvasSize();
  const { bounds, initialView } = state.data.meta;
  return {
    scale: clamp(fitScale(initialView, width, height) / fitScale(bounds, width, height), MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE),
    center: [(initialView[0] + initialView[2]) / 2, (initialView[1] + initialView[3]) / 2],
  };
}

function rebuildTransform() {
  if (!state.data) return;
  const { width, height } = canvasSize();
  if (!state.viewportCenter) {
    const view = initialViewport();
    state.viewportScale = view.scale;
    state.viewportCenter = view.center;
  }
  state.transform = buildTransform(
    state.data.meta.bounds,
    width,
    height,
    MAP_PADDING,
    state.viewportScale,
    state.viewportCenter,
  );
  state.viewportCenter = state.transform.center;
  zoomInButton.disabled = state.viewportScale >= MAX_VIEWPORT_SCALE;
  zoomOutButton.disabled = state.viewportScale <= MIN_VIEWPORT_SCALE;
  invalidate();
}

function setViewport(scale, center) {
  state.viewportScale = clamp(scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
  state.viewportCenter = center;
  state.viewIsInitial = false;
  rebuildTransform();
  scheduleUrlSync();
}

function zoomAt(screenPoint, factor) {
  const world = state.transform.toWorld(screenPoint[0], screenPoint[1]);
  const nextScale = clamp(state.viewportScale * factor, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
  const ratio = state.viewportScale / nextScale;
  const [cx, cy] = state.viewportCenter;
  // Keep the point under the cursor fixed on screen.
  setViewport(nextScale, [world[0] - (world[0] - cx) * ratio, world[1] - (world[1] - cy) * ratio]);
}

function resetView() {
  state.viewportCenter = null;
  state.viewIsInitial = true;
  rebuildTransform();
  syncBrowserUrl();
}

function resize() {
  state.canvasSize = createCanvasBacking(mapCanvas);
  state.streetLayerCache = null;
  rebuildTransform();
}

// ---------- drawing ----------

function requestDraw() {
  if (!state.ready || !state.dirty) return;
  state.dirty = false;
  window.requestAnimationFrame(() => {
    const { width, height } = canvasSize();
    drawMap(ctx, width, height);
  });
}

function invalidate() {
  state.dirty = true;
  requestDraw();
}

// The full walk/bike network as faint context once zoomed in. Rendered (at 1x) for the view plus a
// margin, and only re-rendered when the zoom changes or a pan leaves the rendered area.
function drawMinorStreets(drawCtx, transform) {
  if (!state.graph || 1 / transform.scale > MINOR_STREET_MAX_METERS_PER_PX) return;
  const { width, height } = canvasSize();
  const [viewMinX, viewMaxY] = transform.toWorld(0, 0);
  const [viewMaxX, viewMinY] = transform.toWorld(width, height);
  let cache = state.streetLayerCache;
  const covers =
    cache &&
    cache.scale === transform.scale &&
    cache.minX <= viewMinX &&
    cache.maxX >= viewMaxX &&
    cache.minY <= viewMinY &&
    cache.maxY >= viewMaxY;
  if (!covers) {
    const marginX = (viewMaxX - viewMinX) * STREET_LAYER_MARGIN;
    const marginY = (viewMaxY - viewMinY) * STREET_LAYER_MARGIN;
    cache = {
      scale: transform.scale,
      minX: viewMinX - marginX,
      maxX: viewMaxX + marginX,
      minY: viewMinY - marginY,
      maxY: viewMaxY + marginY,
      canvas: document.createElement("canvas"),
    };
    cache.canvas.width = Math.ceil((cache.maxX - cache.minX) * transform.scale);
    cache.canvas.height = Math.ceil((cache.maxY - cache.minY) * transform.scale);
    const layer = cache.canvas.getContext("2d");
    const g = state.graph;
    const toLayer = (node) => [
      (g.nodeX[node] + g.originX - cache.minX) * transform.scale,
      (cache.maxY - (g.nodeY[node] + g.originY)) * transform.scale,
    ];
    const firstCol = clamp(Math.floor((cache.minX - g.originX - g.bucketMinX) / STREET_BUCKET_METERS), 0, g.bucketCols - 1);
    const lastCol = clamp(Math.floor((cache.maxX - g.originX - g.bucketMinX) / STREET_BUCKET_METERS), 0, g.bucketCols - 1);
    const firstRow = clamp(Math.floor((cache.minY - g.originY - g.bucketMinY) / STREET_BUCKET_METERS), 0, g.bucketRows - 1);
    const lastRow = clamp(Math.floor((cache.maxY - g.originY - g.bucketMinY) / STREET_BUCKET_METERS), 0, g.bucketRows - 1);
    layer.beginPath();
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const bucket = row * g.bucketCols + col;
        for (let k = g.bucketStart[bucket]; k < g.bucketStart[bucket + 1]; k += 1) {
          const node = g.bucketNodes[k];
          const [x1, y1] = toLayer(node);
          for (let edge = g.edgeOffsets[node]; edge < g.edgeOffsets[node + 1]; edge += 1) {
            const target = g.edgeTargets[edge];
            if (target < node) continue;
            const [x2, y2] = toLayer(target);
            layer.moveTo(x1, y1);
            layer.lineTo(x2, y2);
          }
        }
      }
    }
    layer.strokeStyle = "rgba(150, 162, 176, 0.5)";
    layer.lineWidth = 0.7;
    layer.stroke();
    state.streetLayerCache = cache;
  }
  const [left, top] = transform.toScreen([cache.minX, cache.maxY]);
  drawCtx.drawImage(cache.canvas, left, top, cache.canvas.width, cache.canvas.height);
}

function drawMeasureLine(drawCtx, from, to) {
  drawCtx.save();
  drawCtx.setLineDash([5, 5]);
  drawCtx.strokeStyle = "rgba(23, 48, 77, 0.55)";
  drawCtx.lineWidth = 1.5;
  drawCtx.beginPath();
  drawCtx.moveTo(from[0], from[1]);
  drawCtx.lineTo(to[0], to[1]);
  drawCtx.stroke();
  drawCtx.restore();
}

function drawMap(drawCtx, width, height) {
  drawPanelBackground(drawCtx, width, height);
  if (!state.transform) return;

  const transform = state.transform;
  const projectPoint = (point) => transform.toScreen(point);
  const field = state.originPoint && state.graph ? computeTravelField(state.originPoint) : null;
  state.currentRender = { field, transform, projectPoint };
  syncReachabilityScore(field?.reachability ?? null);

  drawExternalLand(drawCtx, projectPoint);
  drawCityBasemap(drawCtx, projectPoint, transform);
  if (field && state.showHeatmap) {
    drawHeatmap(drawCtx, field, transform);
  }
  if (field && state.showReachOutline) {
    drawReachabilityOutline(drawCtx, field, transform);
  }
  drawStations(drawCtx, projectPoint);
  drawMunicipalityLabels(drawCtx, projectPoint);

  const station = field && field.nearestStationIndex !== null ? state.data.stations[field.nearestStationIndex] : null;
  const summary = currentOriginSummary(station?.name ?? null);

  const route = state.showRoute && field && state.probePoint ? traceRoute(field, state.probePoint) : null;
  renderRouteSteps(route);
  if (route) {
    drawRoute(drawCtx, route, projectPoint);
  }
  if (state.originPoint && state.probePoint) {
    const originScreen = projectPoint(state.originPoint);
    const probeScreen = projectPoint(state.probePoint);
    if (!route) drawMeasureLine(drawCtx, originScreen, probeScreen);
    drawMarker(drawCtx, probeScreen, "#17304d", 18, 5, 0.22);
    drawHoverTooltip(drawCtx, probeScreen, formatDistanceLabel(measureProbe(field, state.probePoint)));
  }
  if (state.originPoint) {
    const originScreen = projectPoint(state.originPoint);
    drawMarker(drawCtx, originScreen, "#d75c2e", 24, 6);
    drawPinnedLabel(drawCtx, originScreen, `Start · ${summary}`);
  }

  statusText.textContent = state.originPoint
    ? `Travel times from ${summary.replace(/^Near /, "near ")}.`
    : "Click the map (or search an address) to choose a starting point.";
  clearButton.hidden = !state.originPoint;
}

function syncReachabilityScore(summary) {
  if (!summary || !summary.totalStations) {
    reachScore.hidden = true;
    return;
  }
  reachScore.hidden = false;
  const percent = Math.round(summary.ratio * 100);
  reachScore.innerHTML = `<strong>${summary.reachableStations} / ${summary.totalStations}</strong> stations (${percent}%) reachable within ${REACHABILITY_THRESHOLD_MINUTES} min`;
}

// ---------- pins, panning, zooming ----------

function pointerToWorld(event) {
  const rect = mapCanvas.getBoundingClientRect();
  const screenPoint = [event.clientX - rect.left, event.clientY - rect.top];
  return { screenPoint, worldPoint: state.transform.toWorld(screenPoint[0], screenPoint[1]) };
}

function hitPin(screenPoint) {
  const project = (point) => state.transform.toScreen(point);
  const near = (point) =>
    point && Math.hypot(project(point)[0] - screenPoint[0], project(point)[1] - screenPoint[1]) <= PIN_HIT_RADIUS;
  if (near(state.originPoint)) return "origin";
  if (near(state.probePoint)) return "probe";
  return null;
}

function syncCursor() {
  const drag = state.drag?.target;
  mapCanvas.classList.toggle("is-panning", drag === "pan");
  mapCanvas.classList.toggle("is-pan-ready", !drag && state.spaceHeld);
  mapCanvas.classList.toggle("is-dragging-pin", drag === "origin" || drag === "probe");
  mapCanvas.classList.toggle("is-over-pin", !drag && !state.spaceHeld && Boolean(state.hoverPin));
  hintBar.classList.toggle("is-panning", state.spaceHeld || drag === "pan");
}

function setOrigin(worldPoint, label = null) {
  state.originPoint = worldPoint;
  state.originLabel = label;
  syncBrowserUrl();
  invalidate();
}

function clearPins() {
  state.originPoint = null;
  state.originLabel = null;
  state.probePoint = null;
  syncBrowserUrl();
  invalidate();
}

function handlePointerDown(event) {
  if (event.button !== 0 || !state.transform) return;
  const { screenPoint, worldPoint } = pointerToWorld(event);
  mapCanvas.setPointerCapture(event.pointerId);
  const base = { pointerId: event.pointerId, startScreen: screenPoint, moved: false };

  if (state.spaceHeld) {
    state.drag = { ...base, target: "pan", startCenter: state.viewportCenter.slice() };
  } else if (!withinBounds(worldPoint)) {
    return;
  } else if (hitPin(screenPoint) === "origin") {
    // The start pin only moves when dragged.
    state.drag = { ...base, target: "origin" };
  } else if (!state.originPoint) {
    state.originPoint = worldPoint;
    state.originLabel = null;
    state.drag = { ...base, target: "origin" };
  } else if (hitPin(screenPoint) === "probe") {
    state.drag = { ...base, target: "probe", created: false };
  } else {
    // Any other click drops the measuring pin there (or jumps it), and dragging explores.
    state.probePoint = worldPoint;
    state.drag = { ...base, target: "probe", created: true };
  }
  syncCursor();
  invalidate();
}

function handlePointerMove(event) {
  if (!state.transform) return;
  const { screenPoint, worldPoint } = pointerToWorld(event);
  const drag = state.drag;
  if (!drag) {
    state.hoverPin = hitPin(screenPoint);
    syncCursor();
    return;
  }
  if (Math.hypot(screenPoint[0] - drag.startScreen[0], screenPoint[1] - drag.startScreen[1]) > CLICK_SLOP_PX) {
    drag.moved = true;
  }
  if (drag.target === "pan") {
    const scale = state.transform.scale;
    setViewport(state.viewportScale, [
      drag.startCenter[0] - (screenPoint[0] - drag.startScreen[0]) / scale,
      drag.startCenter[1] + (screenPoint[1] - drag.startScreen[1]) / scale,
    ]);
    return;
  }
  if (!withinBounds(worldPoint)) return;
  if (drag.target === "origin") {
    state.originPoint = worldPoint;
    state.originLabel = null;
  } else {
    state.probePoint = worldPoint;
  }
  invalidate();
}

function handlePointerUp(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  // Clicking the measuring pin without moving it removes it.
  if (drag.target === "probe" && !drag.created && !drag.moved) {
    state.probePoint = null;
  }
  state.drag = null;
  try {
    mapCanvas.releasePointerCapture(event.pointerId);
  } catch (error) {
    console.error(error);
  }
  syncBrowserUrl();
  syncCursor();
  invalidate();
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

// ---------- URL state ----------

let urlSyncTimer = null;

function scheduleUrlSync() {
  window.clearTimeout(urlSyncTimer);
  urlSyncTimer = window.setTimeout(syncBrowserUrl, 250);
}

function buildViewUrlFragment() {
  const params = new URLSearchParams();
  if (isLocalStaticDev() && state.originPoint) {
    params.set("origin", formatCoordinatePair(state.originPoint));
  }
  if (state.probePoint) {
    params.set("distance", formatCoordinatePair(state.probePoint));
  }
  if (!state.viewIsInitial && state.viewportCenter) {
    params.set("view", `${formatCoordinatePair(state.viewportCenter)},${state.viewportScale.toFixed(2)}`);
  }
  if (!state.showHeatmap) params.set("heatmap", "0");
  if (state.showReachOutline) params.set("outline", "1");
  if (state.showRoute) params.set("route", "1");
  const defaultModes = defaultModeIds();
  const modesAreDefault =
    state.enabledModes?.size === defaultModes.length && defaultModes.every((mode) => state.enabledModes.has(mode));
  if (state.enabledModes && !modesAreDefault) {
    params.set("modes", allModeIds().filter((mode) => state.enabledModes.has(mode)).join(",") || "none");
  }
  const query = params.toString();
  if (isLocalStaticDev()) return query ? `?${query}` : "";
  const path = state.originPoint ? `@${formatCoordinatePair(state.originPoint)}` : "";
  return query ? `${path}?${query}` : path;
}

function parseSharedView() {
  const searchParams = new URLSearchParams(window.location.search);
  const viewMatch = (searchParams.get("view") || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
  const modesRaw = searchParams.get("modes");
  return {
    origin: parseOriginPath() || parseCoordinatePair(searchParams.get("origin")),
    probe: parseCoordinatePair(searchParams.get("distance")),
    view: viewMatch ? { lat: Number(viewMatch[1]), lon: Number(viewMatch[2]), zoom: Number(viewMatch[3]) } : null,
    heatmap: searchParams.has("heatmap") ? searchParams.get("heatmap") !== "0" : null,
    outline: searchParams.has("outline") ? searchParams.get("outline") !== "0" : null,
    route: searchParams.get("route") === "1",
    modes: modesRaw === null ? null : modesRaw === "none" ? [] : modesRaw.split(","),
  };
}

// ---------- panels ----------

function renderModeToggles() {
  modeToggleContainer.innerHTML = (state.data.modes || [])
    .map(
      (mode) => `
        <label class="mode-chip" title="${escapeHtml(mode.label)}">
          <input type="checkbox" data-mode-toggle="${escapeHtml(mode.id)}" />
          <span class="mode-swatch" style="background: ${modeSwatchBackground(mode.id)}"></span>
          <span>${escapeHtml(mode.label.replace(/ (trains|bus)$/, ""))}</span>
        </label>
      `,
    )
    .join("");
  for (const input of modeToggleContainer.querySelectorAll("[data-mode-toggle]")) {
    input.addEventListener("change", () => {
      const next = new Set(state.enabledModes);
      if (input.checked) next.add(input.dataset.modeToggle);
      else next.delete(input.dataset.modeToggle);
      applyEnabledModes([...next]);
      syncBrowserUrl();
    });
  }
}

function setSearchMeta(text) {
  searchMeta.textContent = text;
  searchMeta.hidden = !text;
}

function renderSearchResults(results) {
  searchResults.innerHTML = "";
  if (!results.length) {
    setSearchMeta("No matching addresses in the Copenhagen area.");
    return;
  }
  setSearchMeta("");
  searchResults.innerHTML = results
    .map(
      (result, index) => `
        <button class="search-result" type="button" data-result-index="${index}">
          <strong>${escapeHtml(result.title)}</strong>
          <span>${escapeHtml(result.subtitle)}</span>
        </button>
      `,
    )
    .join("");
  for (const button of searchResults.querySelectorAll(".search-result")) {
    button.addEventListener("click", () => {
      const result = results[Number(button.dataset.resultIndex)];
      const worldPoint = lonLatToWorld(result.lon, result.lat);
      searchResults.innerHTML = "";
      if (!withinBounds(worldPoint)) {
        setSearchMeta("That address is outside the mapped area.");
        return;
      }
      addressInput.value = result.title;
      setOrigin(worldPoint, shortOriginLabel(result.title));
    });
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    setSearchMeta("Location access is not available in this browser.");
    return;
  }
  locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locateButton.disabled = false;
      const worldPoint = lonLatToWorld(position.coords.longitude, position.coords.latitude);
      if (!withinBounds(worldPoint)) {
        setSearchMeta("Your location is outside the mapped area.");
        return;
      }
      setSearchMeta("");
      setOrigin(worldPoint, "My location");
    },
    (error) => {
      console.error(error);
      locateButton.disabled = false;
      setSearchMeta("Could not access your location. Check permissions and try again.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
  );
}

let toastTimer = null;

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 1800);
}

async function downloadShareImage() {
  saveImageButton.disabled = true;
  try {
    const exportCanvas = exportShareImage();
    const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Failed to create image.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cph-travel-time-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
  } finally {
    saveImageButton.disabled = false;
  }
}

// ---------- startup ----------

async function init() {
  const [dataResponse, graphResponse] = await Promise.all([fetch(DATA_URL), fetch(GRAPH_URL)]);
  state.data = await dataResponse.json();
  state.graph = loadStreetGraph(await graphResponse.arrayBuffer());
  state.travelSettingsDefaults = getTravelSettingsDefaults();
  state.travelSettings = sanitizeTravelSettings(loadStoredTravelSettings(), state.travelSettingsDefaults);
  state.ready = true;

  const shared = parseSharedView();
  if (shared.heatmap !== null) state.showHeatmap = shared.heatmap;
  if (shared.outline !== null) state.showReachOutline = shared.outline;
  state.showRoute = shared.route;
  renderModeToggles();
  applyEnabledModes(shared.modes ?? loadStoredModes(), { persist: shared.modes === null });

  state.canvasSize = createCanvasBacking(mapCanvas);
  if (shared.view) {
    state.viewportScale = clamp(shared.view.zoom, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
    state.viewportCenter = lonLatToWorld(shared.view.lon, shared.view.lat);
    state.viewIsInitial = false;
  }
  if (shared.origin) {
    const point = lonLatToWorld(shared.origin.lon, shared.origin.lat);
    if (withinBounds(point)) state.originPoint = point;
  }
  if (shared.probe && state.originPoint) {
    const point = lonLatToWorld(shared.probe.lon, shared.probe.lat);
    if (withinBounds(point)) state.probePoint = point;
  }

  heatmapToggle.checked = state.showHeatmap;
  outlineToggle.checked = state.showReachOutline;
  syncTravelSettingsInputs();
  syncHeatmapLegend();
  rebuildTransform();

  window.addEventListener("resize", resize);
  mapCanvas.addEventListener("pointerdown", handlePointerDown);
  mapCanvas.addEventListener("pointermove", handlePointerMove);
  mapCanvas.addEventListener("pointerup", handlePointerUp);
  mapCanvas.addEventListener("pointercancel", handlePointerUp);
  mapCanvas.addEventListener("pointerleave", () => {
    state.hoverPin = null;
    syncCursor();
  });
  mapCanvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(pointerToWorld(event).screenPoint, Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY));
    },
    { passive: false },
  );

  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!state.spaceHeld) {
        state.spaceHeld = true;
        syncCursor();
      }
    } else if (event.key === "Escape" && state.probePoint) {
      state.probePoint = null;
      syncBrowserUrl();
      invalidate();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      state.spaceHeld = false;
      syncCursor();
    }
  });
  window.addEventListener("blur", () => {
    state.spaceHeld = false;
    syncCursor();
  });

  for (const input of settingsInputs) {
    input.addEventListener("input", () => {
      const key = input.dataset.settingKey;
      const rawValue = Number(input.value);
      if (!key || !Number.isFinite(rawValue)) return;
      applyTravelSettings({
        ...currentTravelSettings(),
        [key]: input.dataset.settingUnit === "kmh" ? kmhToMetersPerMinute(rawValue) : rawValue,
      });
    });
  }
  resetSettingsButton.addEventListener("click", () => {
    applyTravelSettings(state.travelSettingsDefaults);
    applyEnabledModes(defaultModeIds());
    syncBrowserUrl();
  });
  heatmapToggle.addEventListener("change", () => {
    state.showHeatmap = heatmapToggle.checked;
    syncHeatmapLegend();
    syncBrowserUrl();
    invalidate();
  });
  const syncRouteButton = () => {
    routeButton.setAttribute("aria-pressed", String(state.showRoute));
    routeButton.textContent = state.showRoute ? "Hide route" : "Show route";
  };
  syncRouteButton();
  routeButton.addEventListener("click", () => {
    state.showRoute = !state.showRoute;
    syncRouteButton();
    if (state.showRoute && !state.probePoint) {
      showToast(state.originPoint ? "Click the map to place the measure pin" : "Place a start pin, then click a destination");
    }
    syncBrowserUrl();
    invalidate();
  });
  outlineToggle.addEventListener("change", () => {
    state.showReachOutline = outlineToggle.checked;
    syncBrowserUrl();
    invalidate();
  });

  zoomInButton.addEventListener("click", () => zoomAt([canvasSize().width / 2, canvasSize().height / 2], VIEWPORT_ZOOM_STEP));
  zoomOutButton.addEventListener("click", () => zoomAt([canvasSize().width / 2, canvasSize().height / 2], 1 / VIEWPORT_ZOOM_STEP));
  resetViewButton.addEventListener("click", resetView);
  copyLinkButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getShareUrl());
      showToast("Link to this view copied");
    } catch (error) {
      console.error(error);
      showToast("Could not copy the link");
    }
  });
  saveImageButton.addEventListener("click", () => {
    downloadShareImage().catch((error) => {
      console.error(error);
      showToast("Could not save the image");
    });
  });
  fullscreenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error) {
      console.error(error);
    }
  });

  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = addressInput.value.trim();
    searchResults.innerHTML = "";
    if (!query) {
      setSearchMeta("Type an address in the Copenhagen area.");
      return;
    }
    searchButton.disabled = true;
    setSearchMeta("Searching…");
    try {
      renderSearchResults(await searchAddress(query));
    } catch (error) {
      console.error(error);
      setSearchMeta("Address lookup failed. Try a more specific address.");
    } finally {
      searchButton.disabled = false;
    }
  });
  locateButton.addEventListener("click", useCurrentLocation);
  clearButton.addEventListener("click", clearPins);
}

init().catch((error) => {
  console.error(error);
  statusText.textContent = "Failed to load the map data.";
});

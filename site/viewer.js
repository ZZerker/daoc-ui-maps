const CLIENTS = { eden: "Eden", blackthorn: "Blackthorn" };
const MAP_UNITS = 65536;
const EXTRA_ZOOM = 2;
const BOUNDS_PADDING = 0.25;
const KEY_STEP = 0.05;

const params = new URLSearchParams(location.search);
const client = Object.hasOwn(CLIENTS, params.get("client")) ? params.get("client") : "eden";
const other = client === "eden" ? "blackthorn" : "eden";
const zoneId = params.get("zone") || "";

const mapEl = document.getElementById("map");
const nameEl = document.getElementById("zone-name");
const lineEl = document.getElementById("zone-line");
const bodyEl = document.getElementById("panel-body");

const view = {
  level: params.get("level"),
  labels: params.get("labels") !== "0",
  compare: params.get("compare") === "1",
  split: 0.5,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  node.append(...children);
  return node;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

async function fetchOptional(path) {
  try {
    return await fetchJson(path);
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad2(n) {
  return String(n).padStart(2, "0"); // taste-skill-ignore: file names use two-digit level numbers
}

function writeUrl() {
  const next = new URLSearchParams();
  next.set("client", client);
  next.set("zone", zoneId);
  if (view.level !== null) {
    next.set("level", view.level);
  }
  if (!view.labels) {
    next.set("labels", "0");
  }
  if (view.compare) {
    next.set("compare", "1");
  }
  try {
    history.replaceState(null, "", `?${next.toString()}`);
  } catch {
    // browsers rate limit history calls
  }
}

function setBar(zoneInOther) {
  document.getElementById("brand").href = `./?client=${client}`;
  for (const link of document.querySelectorAll("[data-client]")) {
    const target = link.dataset.client;
    if (target === client) {
      link.href = `viewer.html?client=${client}&zone=${encodeURIComponent(zoneId)}`;
      link.setAttribute("aria-current", "page");
    } else {
      link.href = zoneInOther ? `viewer.html?client=${target}&zone=${encodeURIComponent(zoneId)}` : `./?client=${target}`;
    }
  }
}

function showMessage(text, retry) {
  const parts = [el("p", { text })];
  if (retry) {
    parts.push(el("button", { class: "link", type: "button", text: "Retry", onclick: retry }));
  }
  bodyEl.replaceChildren(el("div", { class: "notice-block", role: "alert" }, ...parts));
}

function backLink() {
  return el("a", { class: "link", href: `./?client=${client}`, text: "Back to all maps" });
}

function mapPixelToGame(zone, px, py) {
  const size = zone.size;
  if (zone.frame) {
    return [zone.frame.offsetX + (px / size) * zone.frame.width, zone.frame.offsetY + (py / size) * zone.frame.width];
  }
  return [(px / size) * MAP_UNITS, (py / size) * MAP_UNITS];
}

function frameName(zone) {
  if (!zone.frame) {
    return "Zone coordinates";
  }
  return zone.type === "Capitol" ? "City coordinates" : "Dungeon coordinates";
}

function imageUrl(clientKey, zone, level) {
  const base = `data/${clientKey}/viewer/z${zone.id}`;
  return level === null ? `${base}.webp` : `${base}_${pad2(level)}.webp`;
}

function levelValid(zone, level) {
  return level !== null && Array.isArray(zone.levels) && zone.levels.some((l) => String(l.index) === String(level));
}

function downloadHref(downloads) {
  if (!downloads || typeof downloads.zoneFile !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(downloads.repo || "") || typeof downloads.tag !== "string") {
    return null;
  }
  const file = downloads.zoneFile.replace("{id}", zoneId);
  return `https://github.com/${downloads.repo}/releases/download/${encodeURIComponent(downloads.tag)}/${encodeURIComponent(file)}`;
}

function buildLabel(label) {
  const priority = Number(label.priority) >= 2 ? "p2" : "p1";
  const edge = ["north", "south", "east", "west"].includes(label.edge) ? label.edge : "";
  const node = el("span", { class: `lbl ${priority}${edge ? ` edge-${edge}` : ""}`, text: String(label.text) });
  return node;
}

let activeMap = null;

function teardown() {
  if (activeMap) {
    activeMap.remove();
    activeMap = null;
  }
  mapEl.replaceChildren();
  mapEl.classList.remove("low-zoom");
}

function startViewer(zone, otherZone, labelData, downloads) {
  view.level = levelValid(zone, view.level) ? String(view.level) : null;
  const size = zone.size;
  const bounds = [
    [0, 0],
    [size, size],
  ];
  const pad = size * BOUNDS_PADDING;
  const map = L.map(mapEl, {
    crs: L.CRS.Simple,
    zoomControl: false,
    attributionControl: false,
    keyboard: true,
    zoomAnimation: false,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    maxZoom: EXTRA_ZOOM,
    maxBounds: [
      [-pad, -pad],
      [size + pad, size + pad],
    ],
    maxBoundsViscosity: 0.8,
  });
  activeMap = map;
  L.control.zoom({ position: "topleft", zoomInTitle: "Zoom in", zoomOutTitle: "Zoom out" }).addTo(map);
  mapEl.setAttribute("aria-label", `Map of ${zone.name}`);

  // getBoundsZoom clamps to the current minimum, so open it first
  const fitMin = () => {
    map.setMinZoom(-10);
    map.setMinZoom(map.getBoundsZoom(bounds));
  };
  const fit = () => {
    map.invalidateSize();
    fitMin();
  };
  fit();
  map.fitBounds(bounds);
  map.on("resize", fitMin);
  requestAnimationFrame(() => {
    fit();
    map.fitBounds(bounds, { animate: false });
  });

  const alertEl = el("p", { class: "alert-line", role: "alert" });
  let alertOwner = "";
  const setAlert = (owner, text, retry) => {
    alertOwner = owner;
    alertEl.replaceChildren(el("span", { text }));
    if (retry) {
      alertEl.append(" ", el("button", { class: "link", type: "button", text: "Retry", onclick: retry }));
    }
  };
  const clearAlert = () => {
    alertOwner = "";
    alertEl.replaceChildren();
  };
  const levelName = (key) => {
    const found = key === null ? null : zone.levels.find((l) => String(l.index) === key);
    return found ? found.name || `Level ${Number(found.index) + 1}` : "the whole map";
  };
  const mainKey = () => (levelValid(zone, view.level) ? String(view.level) : null);
  const main = L.imageOverlay(imageUrl(client, zone, mainKey()), bounds, { interactive: false, alt: "" }).addTo(map);
  let shownLevel = mainKey();
  let requestedLevel = shownLevel;
  let syncLevelButtons = () => {};
  const markFailed = (layer, failed) => layer.getElement()?.classList.toggle("failed", failed);
  main.on("load", () => {
    markFailed(main, false);
    shownLevel = requestedLevel;
    if (alertOwner === "main") {
      clearAlert();
    }
  });
  main.on("error", () => {
    markFailed(main, true);
    if (requestedLevel !== shownLevel) {
      const failed = requestedLevel;
      requestedLevel = shownLevel;
      view.level = shownLevel;
      main.setUrl(imageUrl(client, zone, shownLevel));
      syncLevelButtons();
      writeUrl();
      setAlert("revert", `Couldn't load ${levelName(failed)}.`);
    } else {
      setAlert("main", `Couldn't load the map of ${zone.name}.`, () => main.setUrl(imageUrl(client, zone, requestedLevel)));
    }
  });

  // coordinate readout
  const readout = document.getElementById("loc-value");
  const cross = el("div", { class: "cross", "aria-hidden": "true" });
  mapEl.append(cross);
  const showPoint = (latlng, touch) => {
    const px = latlng.lng;
    const py = size - latlng.lat;
    if (px < 0 || py < 0 || px > size || py > size) {
      clearPoint();
      return;
    }
    const [x, y] = mapPixelToGame(zone, px, py);
    readout.textContent = `${Math.round(x)}, ${Math.round(y)}`;
    const point = map.latLngToContainerPoint(latlng);
    cross.style.transform = `translate(${point.x}px, ${point.y}px)`;
    cross.classList.add("on");
    if (touch) {
      cross.classList.add("sticky");
    }
  };
  const clearPoint = () => {
    readout.textContent = "-";
    cross.classList.remove("on", "sticky");
  };
  map.on("mousemove", (e) => showPoint(e.latlng, false));
  map.on("mouseout", () => {
    if (!cross.classList.contains("sticky")) {
      clearPoint();
    }
  });
  map.on("click", (e) => showPoint(e.latlng, true));
  map.on("movestart", () => cross.classList.remove("on", "sticky"));

  // labels
  const labelLayer = L.layerGroup();
  if (labelData && Array.isArray(labelData.labels)) {
    for (const label of labelData.labels) {
      if (typeof label.text !== "string" || !Number.isFinite(label.x) || !Number.isFinite(label.y)) {
        continue;
      }
      const icon = L.divIcon({ className: "lbl-wrap", html: buildLabel(label), iconSize: [0, 0] });
      L.marker([size * (1 - label.y), size * label.x], { icon, interactive: false, keyboard: false }).addTo(labelLayer);
    }
  }
  const syncLabelZoom = () => mapEl.classList.toggle("low-zoom", map.getZoom() < 0);
  map.on("zoomend", syncLabelZoom);
  syncLabelZoom();
  const setLabels = (on) => {
    view.labels = on;
    if (on) {
      labelLayer.addTo(map);
    } else {
      labelLayer.remove();
    }
    writeUrl();
  };

  // compare
  let compare = null;
  const handle = el("div", { class: "split", role: "slider", tabindex: "0", "aria-label": "Comparison divider", "aria-orientation": "horizontal", "aria-valuemin": "0", "aria-valuemax": "100" }, el("span", { class: "split-grip", "aria-hidden": "true" }));
  const sideLine = el("p", { class: "meta compare-sides" });
  const updateClip = () => {
    if (!compare) {
      return;
    }
    const node = compare.getElement();
    if (!node) {
      return;
    }
    const container = mapEl.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    const edge = container.left + container.width * view.split;
    const percent = clamp(((edge - rect.left) / rect.width) * 100, 0, 100);
    node.style.clipPath = `inset(0 0 0 ${percent}%)`;
  };
  const setSplit = (value) => {
    view.split = clamp(value, 0, 1);
    handle.style.left = `${view.split * 100}%`;
    const left = Math.round(view.split * 100);
    handle.setAttribute("aria-valuenow", String(left));
    handle.setAttribute("aria-valuetext", `${left}% ${CLIENTS[client]}, ${100 - left}% ${CLIENTS[other]}`);
    updateClip();
  };
  map.on("move zoom resize", updateClip);
  handle.addEventListener("pointerdown", (e) => {
    handle.focus();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("drag");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (handle.hasPointerCapture(e.pointerId)) {
      const rect = mapEl.getBoundingClientRect();
      setSplit((e.clientX - rect.left) / rect.width);
    }
  });
  const endDrag = () => handle.classList.remove("drag");
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  const SPLIT_KEYS = { ArrowLeft: -KEY_STEP, ArrowDown: -KEY_STEP, ArrowRight: KEY_STEP, ArrowUp: KEY_STEP, PageDown: -2 * KEY_STEP, PageUp: 2 * KEY_STEP };
  handle.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (Object.hasOwn(SPLIT_KEYS, e.key)) {
      setSplit(view.split + SPLIT_KEYS[e.key]);
    } else if (e.key === "Home") {
      setSplit(0);
    } else if (e.key === "End") {
      setSplit(1);
    } else {
      return;
    }
    e.preventDefault();
  });
  L.DomEvent.disableClickPropagation(handle);
  L.DomEvent.disableScrollPropagation(handle);
  mapEl.append(handle);
  handle.classList.add("hidden");

  const otherImage = () => imageUrl(other, otherZone, mainKey());
  const otherHasLevel = () => mainKey() === null || levelValid(otherZone, mainKey());
  let compareToggle = null;
  const compareNote = el("p", { class: "meta compare-note" });
  const syncCompareAvailable = () => {
    if (!compareToggle) {
      return;
    }
    const ok = otherHasLevel();
    if (!ok && compare) {
      compareToggle.checked = false;
      setCompare(false);
    }
    compareToggle.disabled = !ok;
    compareNote.textContent = ok ? "" : `${CLIENTS[other]} has no map for this level.`;
  };
  const setCompare = (on) => {
    view.compare = on;
    if (on && !compare) {
      compare = L.imageOverlay(otherImage(), bounds, { interactive: false, alt: "" }).addTo(map);
      compare.on("load", updateClip);
      compare.on("error", () => {
        compareToggle.checked = false;
        setCompare(false);
        setAlert("compare", `Couldn't load the ${CLIENTS[other]} map.`);
      });
    } else if (!on && compare) {
      compare.remove();
      compare = null;
    }
    handle.classList.toggle("hidden", !on);
    sideLine.textContent = on ? `Left: ${CLIENTS[client]}. Right: ${CLIENTS[other]}.` : "";
    if (on) {
      setSplit(view.split);
    }
    writeUrl();
  };

  // panel
  lineEl.replaceChildren(el("span", { text: `Zone ${zone.id}` }), el("span", { text: zone.realm || "Unlisted" }), el("span", { text: zone.type }));
  const locBlock = el(
    "div",
    { class: "loc" },
    el("p", { class: "loc-line" }, el("span", { text: "Loc " }), el("span", { id: "loc-value", class: "loc-value", text: "-" })),
    el("p", { class: "meta", text: frameName(zone) }),
  );
  const panelParts = [locBlock, alertEl];
  const readoutRef = locBlock.querySelector("#loc-value");
  readoutRef.setAttribute("aria-live", "off");

  const switchRow = (id, label, checked, onChange) => {
    const input = el("input", { type: "checkbox", id, class: "switch-input" });
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    const row = el("label", { class: "switch", for: id }, input, el("span", { class: "switch-track", "aria-hidden": "true" }), el("span", { text: label }));
    return { row, input };
  };

  const hasLabels = zone.labels && labelData && Array.isArray(labelData.labels);
  if (hasLabels) {
    panelParts.push(switchRow("toggle-labels", "Labels", view.labels, setLabels).row);
  }

  if (Array.isArray(zone.levels) && zone.levels.length) {
    const buttons = [];
    syncLevelButtons = () => {
      for (const b of buttons) {
        b.node.setAttribute("aria-pressed", String(b.level === mainKey()));
      }
    };
    const select = (level) => {
      clearAlert();
      view.level = level === null ? null : String(level);
      requestedLevel = mainKey();
      main.setUrl(imageUrl(client, zone, requestedLevel));
      syncLevelButtons();
      syncCompareAvailable();
      if (compare) {
        compare.setUrl(otherImage());
      }
      writeUrl();
    };
    const entries = [{ level: null, label: "Whole map" }, ...zone.levels.map((l) => ({ level: String(l.index), label: l.name || `Level ${Number(l.index) + 1}` }))];
    const current = levelValid(zone, view.level) ? String(view.level) : null;
    for (const entry of entries) {
      const node = el("button", { class: "level", type: "button", "aria-pressed": String(entry.level === current), text: entry.label, onclick: () => select(entry.level) });
      buttons.push({ node, level: entry.level });
    }
    panelParts.push(el("div", { class: "levels", role: "group", "aria-label": "Level" }, el("h2", { text: "Levels" }), ...buttons.map((b) => b.node)));
  }

  if (otherZone) {
    const row = switchRow("toggle-compare", `Compare with ${CLIENTS[other]}`, view.compare, setCompare);
    compareToggle = row.input;
    panelParts.push(el("div", {}, row.row, compareNote, sideLine));
  }

  const actions = el("div", { class: "panel-actions" });
  const href = downloadHref(downloads);
  if (href) {
    actions.append(el("a", { class: "pill", href, text: "Download PNG" }));
  } else {
    actions.append(el("a", { class: "link", href: `./?client=${client}#downloads`, text: "All downloads" }));
  }
  actions.append(backLink());
  panelParts.push(actions);
  panelParts.push(el("p", { class: "credit" }, el("span", { text: "Map display by " }), el("a", { class: "link", href: "vendor/leaflet/LICENSE", text: "Leaflet (BSD-2)" })));
  bodyEl.replaceChildren(...panelParts);

  setLabels(view.labels && hasLabels);
  if (!hasLabels) {
    view.labels = true;
  }
  syncCompareAvailable();
  setCompare(view.compare && Boolean(otherZone) && otherHasLevel());
  writeUrl();
}

async function start() {
  setBar(false);
  nameEl.textContent = "Loading the map";
  lineEl.replaceChildren();
  bodyEl.replaceChildren(el("div", { class: "skeleton-line" }), el("div", { class: "skeleton-line short" }));

  teardown();
  let list;
  try {
    list = await fetchJson(`data/${client}/zones.json`);
    if (!list || !Array.isArray(list.zones)) {
      throw new Error("zones.json has no zones");
    }
  } catch {
    nameEl.textContent = "Map";
    document.title = "Map, DAoC UI maps";
    showMessage(`Couldn't load the ${CLIENTS[client]} map list.`, start);
    return;
  }
  const otherList = await fetchOptional(`data/${other}/zones.json`);
  const zone = list.zones.find((z) => z && z.id === zoneId);
  const otherZone = otherList && Array.isArray(otherList.zones) ? otherList.zones.find((z) => z && z.id === zoneId) || null : null;
  setBar(Boolean(otherZone));

  if (!zone) {
    nameEl.textContent = "Map not found";
    document.title = "Map not found, DAoC UI maps";
    bodyEl.replaceChildren(el("div", { class: "notice-block" }, el("p", { text: `Zone ${zoneId} is not in the ${CLIENTS[client]} map list.` }), backLink()));
    return;
  }

  nameEl.textContent = zone.name;
  document.title = `${zone.name}, DAoC UI maps`;
  const [labelData, downloads] = await Promise.all([
    zone.labels ? fetchOptional(`data/${client}/labels/z${zone.id}.json`) : Promise.resolve(null),
    fetchOptional(`data/${client}/downloads.json`),
  ]);
  try {
    if (typeof L === "undefined") {
      throw new Error("Leaflet is missing");
    }
    if (!Number.isFinite(zone.size) || zone.size <= 0) {
      throw new Error("zone size is invalid");
    }
    startViewer(zone, otherZone, labelData, downloads);
  } catch {
    teardown();
    showMessage(`Couldn't load the map of ${zone.name}.`, start);
  }
}

start();

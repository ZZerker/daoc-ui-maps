const CLIENTS = { eden: "Eden", blackthorn: "Blackthorn" };
const TYPES = [
  { key: "all", label: "All", match: () => true },
  { key: "outdoor", label: "Outdoor", match: (t) => t === "Outdoor" },
  { key: "cities", label: "Cities", match: (t) => t === "Capitol" },
  { key: "dungeons", label: "Dungeons", match: (t) => t === "Dungeons" },
  { key: "other", label: "Other", match: (t) => ["Battlegrounds", "Instances", "Indoor"].includes(t) },
];
const REALMS = [
  { value: "all", label: "All realms" },
  { value: "Albion", label: "Albion" },
  { value: "Midgard", label: "Midgard" },
  { value: "Hibernia", label: "Hibernia" },
  { value: "All Realms", label: "Frontiers and shared" },
  { value: "Unlisted", label: "Unlisted" },
];
const STORAGE_KEY = "daoc-ui-maps.client";
const SKELETON_TILES = 12;

const main = document.getElementById("main");
const state = { client: "eden", type: "all", realm: "all", q: "", view: "maps" };
const zoneCache = new Map();
const downloadCache = new Map();
let zones = null;
let loadFailed = false;
let loading = false;
const SEARCH_DELAY = 150;
let refs = {};

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

function normalize(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function clientName() {
  return CLIENTS[state.client];
}

function readStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage may be blocked
  }
}

function readState() {
  const params = new URLSearchParams(location.search);
  const client = params.get("client") || readStorage();
  state.client = Object.hasOwn(CLIENTS, client) ? client : "eden";
  const type = params.get("type");
  state.type = TYPES.some((t) => t.key === type) ? type : "all";
  const realm = params.get("realm");
  state.realm = REALMS.some((r) => r.value === realm) ? realm : "all";
  state.q = params.get("q") || "";
  state.view = location.hash === "#downloads" ? "downloads" : "maps";
}

function queryString() {
  const params = new URLSearchParams();
  params.set("client", state.client);
  if (state.type !== "all") {
    params.set("type", state.type);
  }
  if (state.realm !== "all") {
    params.set("realm", state.realm);
  }
  if (state.q) {
    params.set("q", state.q);
  }
  return params.toString();
}

function writeUrl() {
  const hash = state.view === "downloads" ? "#downloads" : "";
  try {
    history.replaceState(null, "", `?${queryString()}${hash}`);
  } catch {
    // browsers rate limit history calls
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

async function loadZones() {
  zones = null;
  loadFailed = false;
  const client = state.client;
  if (zoneCache.has(client)) {
    zones = zoneCache.get(client);
    return;
  }
  loading = true;
  try {
    const data = await fetchJson(`data/${client}/zones.json`);
    data.zones.sort((a, b) => a.name.localeCompare(b.name, "en"));
    zoneCache.set(client, data);
    if (state.client === client) {
      zones = data;
    }
  } catch {
    if (state.client === client) {
      loadFailed = true;
    }
  } finally {
    loading = false;
  }
}

async function fetchDownloads(client) {
  try {
    const response = await fetch(`data/${client}/downloads.json`);
    if (response.status === 404) {
      return { missing: true };
    }
    if (!response.ok) {
      return { error: true };
    }
    return { data: await response.json() };
  } catch {
    return { error: true };
  }
}

function loadDownloads(client) {
  if (!downloadCache.has(client)) {
    const request = fetchDownloads(client).then((result) => {
      if (result.error) {
        downloadCache.delete(client);
      }
      return result;
    });
    downloadCache.set(client, request);
  }
  return downloadCache.get(client);
}

function validFiles(data) {
  if (!data || typeof data.repo !== "string" || typeof data.tag !== "string" || typeof data.released !== "string" || !Array.isArray(data.files)) {
    return [];
  }
  return data.files.filter(
    (f) => f && typeof f.name === "string" && typeof f.format === "string" && Number.isFinite(f.size) && Number.isFinite(f.bytes) && typeof f.labels === "boolean",
  );
}

// ---------- filtering ----------

function realmMatches(zone) {
  if (state.realm === "all") {
    return true;
  }
  if (state.realm === "Unlisted") {
    return !zone.realm;
  }
  return zone.realm === state.realm;
}

function queryMatches(zone, query) {
  return !query || normalize(zone.name).includes(query) || zone.id.includes(query);
}

function filterZones() {
  const query = normalize(state.q.trim());
  const base = zones.zones.filter((zone) => realmMatches(zone) && queryMatches(zone, query));
  const counts = Object.fromEntries(TYPES.map((t) => [t.key, base.filter((z) => t.match(z.type)).length]));
  const type = TYPES.find((t) => t.key === state.type);
  return { shown: base.filter((z) => type.match(z.type)), counts };
}

function emptyMessage() {
  const realm = REALMS.find((r) => r.value === state.realm).label;
  const type = TYPES.find((t) => t.key === state.type).label.toLowerCase();
  const scope = state.type === "all" ? realm : `${realm}, ${type}`;
  return state.q.trim() ? `No zone matches "${state.q.trim()}" in ${scope}.` : `No zone found in ${scope}.`;
}

// ---------- maps view ----------

function tile(zone) {
  const thumb = el("span", { class: "thumb" });
  const img = el("img", {
    src: `data/${state.client}/thumbs/z${zone.id}.webp`,
    width: "256",
    height: "256",
    loading: "lazy",
    decoding: "async",
    alt: `Map of ${zone.name}`,
  });
  img.addEventListener("error", () => {
    thumb.classList.add("missing");
    img.replaceWith(el("span", { text: zone.id }));
  });
  thumb.append(img);
  const meta = el("span", { class: "tile-meta" }, el("span", { text: zone.id }));
  if (zone.realm) {
    meta.append(el("span", { text: zone.realm }));
  }
  return el(
    "a",
    { class: "tile", href: `viewer.html?client=${state.client}&zone=${zone.id}` },
    thumb,
    el("div", { class: "tile-name", text: zone.name }),
    meta,
  );
}

function clearFilters() {
  state.type = "all";
  state.realm = "all";
  state.q = "";
  refs.select.value = "all";
  refs.search.value = "";
  update();
}

function gridNotice(text, actionLabel, action) {
  return el("div", { class: "notice" }, el("p", { text }), el("button", { class: "link", type: "button", text: actionLabel, onclick: action }));
}

function renderGrid() {
  refs.grid.replaceChildren();
  if (loadFailed) {
    refs.grid.append(gridNotice(`Couldn't load the ${clientName()} zone list.`, "Retry", retry));
    refs.count.textContent = "";
    return;
  }
  if (!zones) {
    for (let i = 0; i < SKELETON_TILES; i++) {
      refs.grid.append(el("div", { class: "skeleton" }));
    }
    refs.count.textContent = "";
    return;
  }
  const { shown, counts } = filterZones();
  for (const card of refs.cards) {
    card.button.setAttribute("aria-pressed", String(card.key === state.type));
    card.value.textContent = String(counts[card.key]);
  }
  refs.count.textContent = `Showing ${shown.length} of ${zones.zones.length}`;
  if (!shown.length) {
    refs.grid.append(gridNotice(emptyMessage(), "Clear filters", clearFilters));
    return;
  }
  refs.grid.append(...shown.map(tile));
}

function subtitle() {
  if (!zones) {
    return "Loading the zone list.";
  }
  return `${zones.zones.length} ${clientName()} zones rendered from the game files, updated ${zones.generated}.`;
}

function buildCards() {
  refs.cards = TYPES.map((type) => {
    const value = el("span", { class: "value", text: "0" });
    const button = el(
      "button",
      {
        class: "card",
        type: "button",
        "aria-pressed": "false",
        onclick: () => {
          state.type = type.key;
          update();
        },
      },
      el("span", { class: "label", text: type.label }),
      value,
    );
    return { key: type.key, button, value };
  });
  return el("div", { class: "cards" }, ...refs.cards.map((c) => c.button));
}

function buildSelect() {
  const select = el("select", { class: "select", "aria-label": "Realm" }, ...REALMS.map((r) => el("option", { value: r.value, text: r.label })));
  select.value = state.realm;
  select.addEventListener("change", () => {
    state.realm = select.value;
    update();
  });
  return select;
}

function buildSearch() {
  const input = el("input", { class: "search", id: "find", type: "search", placeholder: "Name or id", autocomplete: "off", spellcheck: "false" });
  input.value = state.q;
  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = input.value;
      update();
    }, SEARCH_DELAY);
  });
  return input;
}

function renderMaps() {
  refs = {};
  refs.sub = el("p", { class: "sub" });
  refs.count = el("p", { class: "count", "aria-live": "polite" });
  refs.grid = el("div", { class: "grid" });
  refs.select = buildSelect();
  refs.search = buildSearch();
  const download = el("a", { class: "pill", href: "#downloads", text: "Download UI packs" });
  const titleRow = el("div", { class: "title-row" }, el("div", {}, el("h1", { text: "Zone maps" }), refs.sub), download);
  const find = el("div", { class: "find" }, el("label", { for: "find", text: "Find a zone" }), refs.search);
  const filters = el("div", { class: "filters" }, buildCards(), refs.select, find);
  const head = el("div", { class: "maps-head" }, el("h2", { text: "Maps" }), refs.count);
  main.replaceChildren(titleRow, filters, head, refs.grid);
  update();
}

function update() {
  if (state.view !== "maps") {
    return;
  }
  refs.sub.textContent = subtitle();
  renderGrid();
  writeUrl();
}

async function retry() {
  if (loading) {
    return;
  }
  const request = loadZones();
  update();
  await request;
  update();
}

// ---------- downloads view ----------

function packLabel(file) {
  return `${file.format.toUpperCase()} ${file.size}, ${file.labels ? "labeled" : "no labels"}`;
}

function sortFiles(files) {
  return [...files].sort((a, b) => a.format.localeCompare(b.format) || a.size - b.size || Number(b.labels) - Number(a.labels));
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadRow(data, file) {
  const url = `https://github.com/${data.repo}/releases/download/${data.tag}/${file.name}`;
  return el(
    "tr",
    {},
    el("td", { text: packLabel(file) }),
    el("td", { class: "n", text: String(file.size) }),
    el("td", { class: "n", text: megabytes(file.bytes) }),
    el("td", {}, el("a", { class: "link", href: url, text: "Download", "aria-label": `Download ${packLabel(file)}` })),
  );
}

function downloadTable(data) {
  const head = el("tr", {}, el("th", { text: "Pack" }), el("th", { class: "n", text: "Size" }), el("th", { class: "n", text: "File size" }), el("th", { "aria-label": "Action" }));
  const body = el("tbody", {}, ...sortFiles(data.files).map((file) => downloadRow(data, file)));
  return el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), body));
}

function releaseLine(data) {
  const link = el("a", { class: "link", href: `https://github.com/${data.repo}/releases/tag/${data.tag}`, text: `Release ${data.tag}, ${data.released}` });
  return el("p", { class: "release" }, link);
}

async function renderDownloads() {
  refs = {};
  const client = state.client;
  const back = el("a", { class: "back", href: `?${queryString()}`, text: "Back to maps", onclick: onShowMaps });
  const intro = el("p", { class: "sub", text: "UI packs hold the zone, level and region maps as DXT1 DDS for the TokaZerk UI; unzip into your UI's Maps folder." });
  const body = el("div");
  main.replaceChildren(back, el("div", { class: "title-row" }, el("div", {}, el("h1", { text: "Downloads" }), intro)), body);
  writeUrl();
  const result = await loadDownloads(client);
  if (state.view !== "downloads" || state.client !== client) {
    return;
  }
  if (result.error) {
    body.append(
      el(
        "div",
        { class: "notice" },
        el("p", { text: `Couldn't load the ${clientName()} packs.` }),
        el("button", { class: "link", type: "button", text: "Retry", onclick: () => renderDownloads() }),
      ),
    );
    return;
  }
  const files = validFiles(result.data);
  if (!files.length) {
    body.append(el("p", { class: "dl-empty", text: `Packs for ${clientName()} are not released yet.` }));
    return;
  }
  const data = { ...result.data, files };
  body.append(releaseLine(data), downloadTable(data));
}

// ---------- shell ----------

function markClient() {
  for (const link of document.querySelectorAll("[data-client]")) {
    const active = link.dataset.client === state.client;
    link.href = `?client=${link.dataset.client}${state.view === "downloads" ? "#downloads" : ""}`;
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function focusHeading() {
  const heading = main.querySelector("h1");
  heading.tabIndex = -1;
  heading.focus();
}

async function render(moveFocus = false) {
  markClient();
  document.title = state.view === "downloads" ? "Downloads, DAoC UI maps" : "DAoC UI maps";
  if (state.view === "downloads") {
    renderDownloads();
    if (moveFocus) {
      focusHeading();
    }
    return;
  }
  if (zoneCache.has(state.client)) {
    zones = zoneCache.get(state.client);
  }
  renderMaps();
  if (moveFocus) {
    focusHeading();
  }
  if (!zones || zones.client !== state.client) {
    await loadZones();
    update();
  }
}

async function switchClient(client) {
  if (client === state.client) {
    return;
  }
  state.client = client;
  writeStorage(client);
  zones = null;
  loadFailed = false;
  await render();
}

function onShowMaps(event) {
  event.preventDefault();
  const changed = state.view !== "maps";
  state.view = "maps";
  try {
    history.replaceState(null, "", `?${queryString()}`);
  } catch {
    // browsers rate limit history calls
  }
  render(changed);
  window.scrollTo(0, 0);
}

function onHashChange() {
  state.view = location.hash === "#downloads" ? "downloads" : "maps";
  render(true);
  window.scrollTo(0, 0);
}

function wireShell() {
  for (const link of document.querySelectorAll("[data-client]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      switchClient(link.dataset.client);
    });
  }
  document.getElementById("brand").addEventListener("click", onShowMaps);
  const bar = document.getElementById("bar");
  const markScroll = () => bar.classList.toggle("scrolled", window.scrollY > 0);
  window.addEventListener("scroll", markScroll, { passive: true });
  markScroll();
  window.addEventListener("hashchange", onHashChange);
}

function start() {
  readState();
  writeStorage(state.client);
  wireShell();
  render();
}

start();

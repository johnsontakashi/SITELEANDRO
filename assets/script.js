/* =========================================================
   GeoViewer Pro — Admin JS (otimizado)
   - Performance de zoom/carga melhorada
   - Simplificação de geometrias em METROS
   - Parser em lotes com requestIdleCallback
   - Labels de postos só quando o mapa para
   - Uploader de logo (server-side) incluído no final

   🔧 Atualizações (out/2025)
   - FIX: Ocultar linhas passa a ocultar apenas polylines (sem afetar postos/números)
   - FIX: Removidos halos/destaques ao ocultar linhas (não ficam “linhas fantasmas”)
   - FIX: Duplicação de attachLineTooltip/addLayer em polylines
   - UX: Carregamento inicial mostra só as linhas; postos aparecem após o primeiro zoom do usuário
   - CACHE: Prefetch dos KML/KMZ com Cache Storage (cache-first com fallback de rede)
   - GEO: Localização por leitura única com animação (sem watch)
   ========================================================= */

/* ---------- Parâmetros de performance ---------- */
const Z_MARKERS_ON   = 15; // exibir marcadores a partir deste zoom
const Z_LABELS_ON    = 12; // exibir labels (tooltips) a partir deste zoom
const CHUNK_SIZE     = 1000; // tamanho do lote no parse (↑ para menos overhead)
const LINE_SMOOTH    = 2.0; // suavização visual das polylines (Leaflet)
const LINE_BASE_W = 4;      // base mais grossa
const LINE_MAX_W  = 6;      // teto em zoom alto
const Z_POST_TEXT_ON   = 14;   // ou 15/16 se preferir ainda mais leve
const MAX_POST_LABELS  = 100;  // teto global de labels simultâneos
const LABEL_GRID_PX    = 96;   // tamanho da célula de amostragem na tela

/* ----------------- Utils ----------------- */
const $ = (s, r = document) => r.querySelector(s);
const statusEl = $("#statusText"),
      coordsEl = $("#coordinates");
const loadingEl = $("#loadingOverlay"),
      loadingTxt = $("#loadingText");
// SUBSTITUIR a sua setStatus por esta:
// Máximo de 40 caracteres no rodapé
const MAX_STATUS_LEN = 40;

// SUBSTITUIR sua setStatus por esta:
const setStatus = (m) => {
  if (!statusEl) return;
  const raw = String(m ?? '').trim();

  // silencia a msg “não encontrei essa sua cidade…”
  if (/não encontrei essa sua cidade/i.test(raw)) return;

  const short = raw.length > MAX_STATUS_LEN
    ? raw.slice(0, MAX_STATUS_LEN - 1).trimEnd() + '…'
    : raw;

  statusEl.textContent = short;
  statusEl.title = raw; // mostra o texto completo no hover (opcional)
};


const showLoading = (on, msg = "Processando...") => {
  if (!loadingEl) return;
  loadingEl.classList.toggle("show", !!on);
  if (msg && loadingTxt) loadingTxt.textContent = msg;
};
const timeoutFetch = (url, opts = {}, ms = 10000) => {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(id));
};
const prettyCityFromFilename = (name = "") => {
  const base = String(name).split("/").pop().replace(/\.[^.]+$/, "");
  return base.replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim().toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
};

/* >>>>>>> Prefixo + códigos ARA persistentes (para AGRUPAR LINHAS) <<<<<<< */
const LS_KEYCODES = 'gv_keycodes_v1';   // mapa "prefix:lat,lng" -> ARA01/PAI01…
const LS_PREFIXSEQ = 'gv_prefix_seq_v1';// contador por prefixo
const keycodes = JSON.parse(localStorage.getItem(LS_KEYCODES) || '{}');
const prefixSeq = JSON.parse(localStorage.getItem(LS_PREFIXSEQ) || '{}');

/* --- Índice local p/ busca por chave/nome --- */
const localIndex = {
  points: [],   // {name, code, lat, lon}
  groups: []    // {name, lat, lon, bbox: L.LatLngBounds}
};

function saveCodes() {
  localStorage.setItem(LS_KEYCODES, JSON.stringify(keycodes));
  localStorage.setItem(LS_PREFIXSEQ, JSON.stringify(prefixSeq));
}

function stripAccents(s='') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function cityToPrefix(city='') {
  const map = { 'Belo Horizonte':'BHZ','São Paulo':'SAO','Rio De Janeiro':'RIO','Porto Alegre':'POA','Belo Horizonte - Mg':'BHZ' };
  const cTitle = (city||'').trim();
  if (map[cTitle]) return map[cTitle];
  const clean = stripAccents(cTitle).replace(/[^A-Za-z ]/g,'').trim();
  if (!clean) return 'GEN';
  const words = clean.split(/\s+/).filter(Boolean);
  let base = words[0] || clean;
  if (/^(Sao|Santo|Santa|Santana|Vila|Vila\/|Bom|Nova)$/i.test(base) && words[1]) base = words[1];
  return base.slice(0,3).toUpperCase();
}

/* ========= A) Utilidades — ler códigos direto do arquivo ========= */
const FEED_RE = /\b([A-Z]{2,6})\s*[-_:.\s]*0*([0-9]{1,4})\b/i;
function pad2(n){ return String(n).padStart(2,'0'); }
function extractFeedFromText(txt) {
  if (!txt) return null;
  const m = String(txt).toUpperCase().match(FEED_RE);
  return m ? `${m[1]}${pad2(+m[2])}` : null;
}
function detectPrefixFromTree(pm) {
  const n = pm.querySelector("name")?.textContent;
  let code = extractFeedFromText(n);
  if (code) return code.replace(/\d+$/, "");
  for (const d of pm.querySelectorAll("ExtendedData Data")) {
    const v = d.querySelector("value")?.textContent;
    code = extractFeedFromText(v);
    if (code) return code.replace(/\d+$/, "");
  }
  let node = pm.parentElement;
  while (node) {
    if (node.tagName === 'Folder' || node.tagName === 'Document') {
      const name = node.querySelector(":scope > name")?.textContent;
      const code = extractFeedFromText(name);
      if (code) return code.replace(/\d+$/, "");
    }
    node = node.parentElement;
  }
  return null;
}
function prefixFromFilename(filename = "") {
  const base = filename.split("/").pop().replace(/\.[^.]+$/, "");
  const clean = base.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z ]/g,'').trim();
  if (!clean) return "GEN";
  const first = clean.split(/\s+/)[0] || clean;
  return first.slice(0,3).toUpperCase();
}

/* ========= B) Alimentador do Placemark ========= */
function getAlim(pm) {
  for (const d of pm.querySelectorAll("ExtendedData Data")) {
    const key = (d.getAttribute("name") || "").toLowerCase();
    const val = d.querySelector("value")?.textContent?.trim();
    if (key.includes("alimentador") && val) {
      const code = extractFeedFromText(val);
      return code || val.toUpperCase();
    }
  }
  const folder = pm.closest("Folder");
  const fname = folder?.querySelector(":scope > name")?.textContent?.trim();
  if (fname) {
    const code = extractFeedFromText(fname);
    return code || fname.toUpperCase();
  }
  const s = pm.querySelector("styleUrl")?.textContent?.replace("#","").trim();
  if (s) {
    const code = extractFeedFromText(s);
    return code || s.toUpperCase();
  }
  return null;
}

/* ========= C) Código explícito ========= */
function findFeedCodeInPlacemark(pm) {
  const byName = extractFeedFromText(pm.querySelector("name")?.textContent);
  if (byName) return byName;
  for (const d of pm.querySelectorAll("ExtendedData Data")) {
    const v = d.querySelector("value")?.textContent;
    const byExt = extractFeedFromText(v);
    if (byExt) return byExt;
  }
  let node = pm.parentElement;
  while (node) {
    if (node.tagName === 'Folder' || node.tagName === 'Document') {
      const name = node.querySelector(":scope > name")?.textContent;
      const byFolder = extractFeedFromText(name);
      if (byFolder) return byFolder;
    }
    node = node.parentElement;
  }
  return null;
}

/* ========= D) Grupo da geometria ========= */
function decideGroupForGeometry(pm, centroidLatLngOrNull, keyIndex) {
  const explicit = findFeedCodeInPlacemark(pm);
  if (explicit) return explicit;
  const alim = getAlim(pm);
  const asCode = extractFeedFromText(alim);
  if (asCode) return asCode;
  if (centroidLatLngOrNull && keyIndex?.length) {
    const near = nearestARA(keyIndex, centroidLatLngOrNull);
    if (near.code) return near.code;
  }
  return alim || "AUTO";
}

/* ========= E) Código dos POSTOS automático ========= */
function getOrCreateKeyCodeAuto(pm, lat, lng, filenameHint = "") {
  const feed = findFeedCodeInPlacemark(pm) || extractFeedFromText(getAlim(pm));
  const prefix = feed ? feed.replace(/\d+$/, "") 
                      : (detectPrefixFromTree(pm) || prefixFromFilename(filenameHint) || "GEN");
  const key = `${prefix}:${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (keycodes[key]) return keycodes[key];
  const next = (prefixSeq[prefix] || 0) + 1;
  prefixSeq[prefix] = next;
  const code = `${prefix}${String(next).padStart(2,'0')}`;
  keycodes[key] = code;
  saveCodes();
  return code;
}

/* ----------------- Logo (fallback local) ----------------- */
const DEFAULT_LOGO = "assets/img/image.png";
(() => {
  const src = localStorage.getItem("geoviewer-logo") || DEFAULT_LOGO;
  $("#brandLogo") && ($("#brandLogo").src = src);
  $("#brandLogoTop") && ($("#brandLogoTop").src = src);
  $("#loadingLogo") && ($("#loadingLogo").src = src);
  $("#favicon") && ($("#favicon").href = src);
})();

/* ----------------- Tema / Ajuda ----------------- */
const themeBtn = $("#themeToggle");
(() => {
  const saved = localStorage.getItem("geoviewer-theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  themeBtn?.setAttribute("aria-pressed", saved === "dark" ? "true" : "false");
})();
themeBtn?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("geoviewer-theme", next);
  themeBtn?.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
});
const dlg = $("#shortcutsDialog");
$("#openShortcuts")?.addEventListener("click", () => dlg?.showModal());
$("#closeShortcuts")?.addEventListener("click", () => dlg?.close());
$("#okShortcuts")?.addEventListener("click", () => dlg?.close());

/* ----------------- Sidebar mobile ----------------- */
const sidebar = $(".sidebar");
$("#openSidebar")?.addEventListener("click", () => {
  if (!sidebar) return;
  sidebar.classList.add("open");
  document.body.classList.add("sidebar-open");
});
$("#closeSidebar")?.addEventListener("click", () => {
  if (!sidebar) return;
  sidebar.classList.remove("open");
  document.body.classList.remove("sidebar-open");
});
document.addEventListener("click", (e) => {
  if (!sidebar) return;
  if (sidebar.classList.contains("open") &&
      !sidebar.contains(e.target) &&
      !$("#openSidebar")?.contains(e.target) &&
      window.innerWidth <= 768) {
    sidebar.classList.remove("open");
    document.body.classList.remove("sidebar-open");
  }
});

/* ==================== PERFORMANCE BLOCKS ==================== */
/* ---- Simplificação/decimação de caminhos em METROS ---- */
const SIMPLIFY_TOL_M = 4.0;
const MAX_POINTS_PER_GEOM = 800;
const MIN_SKIP_M     = 2.0;

function toMetersProj(lat0){
  const R = 6371000, toRad = d=>d*Math.PI/180, c0 = Math.cos(toRad(lat0));
  return (lat,lng)=>({ x: R*toRad(lng)*c0, y: R*toRad(lat) });
}
function rdpsSimplify(pointsXY, tol){
  const tol2 = tol*tol;
  const keep = new Uint8Array(pointsXY.length);
  const stack = [[0, pointsXY.length-1]];
  keep[0]=keep[keep.length-1]=1;
  function segDist2(p,a,b){
    const vx=b.x-a.x, vy=b.y-a.y;
    const wx=p.x-a.x, wy=p.y-a.y;
    const c1= vx*wx+vy*wy;
    if (c1<=0) return (wx*wx+wy*wy);
    const c2= vx*vx+vy*vy;
    if (c2<=c1){ const dx=p.x-b.x, dy=p.y-b.y; return dx*dx+dy*dy; }
    const t=c1/c2; const px=a.x+t*vx, py=a.y+t*vy;
    const dx=p.x-px, dy=p.y-py; return dx*dx+dy*dy;
  }
  while(stack.length){
    const [i,j] = stack.pop();
    let maxD2=-1, idx=-1;
    for(let k=i+1;k<j;k++){
      const d2 = segDist2(pointsXY[k], pointsXY[i], pointsXY[j]);
      if (d2>maxD2){ maxD2=d2; idx=k; }
    }
    if (maxD2>tol2 && idx>0){
      keep[idx]=1;
      stack.push([i,idx],[idx,j]);
    }
  }
  const outIdx=[];
  for(let k=0;k<keep.length;k++) if (keep[k]) outIdx.push(k);
  return outIdx;
}
function simplifyPathMeters(coords, tolM = SIMPLIFY_TOL_M){
  if (!coords || coords.length <= 2) return coords || [];
  const out = [];
  let last = coords[0];
  out.push(last);
  const proj = toMetersProj(coords[0][0]);
  let lastXY = proj(last[0], last[1]);
  for (let i=1;i<coords.length;i++){
    const c = coords[i];
    const xy = proj(c[0], c[1]);
    const dx = xy.x - lastXY.x, dy = xy.y - lastXY.y;
    if (dx*dx + dy*dy >= MIN_SKIP_M*MIN_SKIP_M){
      out.push(c); last = c; lastXY = xy;
    }
  }
  if (out.length<=2) return out;
  const ptsXY = out.map(c => proj(c[0], c[1]));
  const keepIdx = rdpsSimplify(ptsXY, tolM);
  let simp = keepIdx.map(i => out[i]);
  if (simp.length > MAX_POINTS_PER_GEOM){
    const step = Math.ceil(simp.length / MAX_POINTS_PER_GEOM);
    const slim = [];
    for (let i=0;i<simp.length;i+=step) slim.push(simp[i]);
    if (slim[slim.length-1] !== simp[simp.length-1]) slim.push(simp[simp.length-1]);
    simp = slim;
  }
  return simp;
}

/* ---------- LOD para linhas: 3 níveis ---------- */
const LOD_TOLS = { coarse: 30, mid: 12, fine: SIMPLIFY_TOL_M };
function buildSimpLevels(coords){
  const fine = simplifyPathMeters(coords, LOD_TOLS.fine);
  const mid  = simplifyPathMeters(fine,  LOD_TOLS.mid);
  const coarse = simplifyPathMeters(mid, LOD_TOLS.coarse);
  return { coarse, mid, fine };
}
function makeLODPolyline(coords, style, grpLabel){
  const levels = buildSimpLevels(coords);
  const poly = L.polyline(levels.coarse, {
    ...style,
    smoothFactor: 3,
    noClip: true,
    updateWhenZooming: false,
    renderer: fastRenderer
  });
  poly.__label = grpLabel || '';
  poly.__levels = levels;
  poly.__lodApplied = 'coarse';
  return poly;
}
function pickLevelForZoom(z){
  if (z < 13) return 'coarse';
  if (z < 15) return 'mid';
  return 'fine';
}
function nextIdle(){
  return new Promise(res => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => res(), { timeout: 32 });
    } else {
      requestAnimationFrame(() => res());
    }
  });
}

/* ----------------- Mapa (Leaflet em Canvas + ajustes) ----------------- */
const fastRenderer = L.canvas({ padding: 0.1 });

const map = L.map("map", {
  center: [-21.7947, -48.1780],
  zoom: 12,
  zoomControl: false,
  worldCopyJump: true,
  preferCanvas: true,
  zoomAnimation: false,
  markerZoomAnimation: false,
  fadeAnimation: false
});

/* ====== Controlador de bases e botões ====== */
function makeBaseController(map){
  // pane de labels
  if(!map.getPane('labels')){
    map.createPane('labels');
    const p = map.getPane('labels');
    p.style.zIndex = 650;
    p.style.pointerEvents = 'none';
  }

  // bases
  const bases = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19, updateWhenZooming: false, updateWhenIdle: true, keepBuffer: 0
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri, Maxar', maxZoom: 19, updateWhenZooming: false, updateWhenIdle: true, keepBuffer: 0
    }),
    terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenTopoMap', maxZoom: 17, updateWhenZooming: false, updateWhenIdle: true, keepBuffer: 0
    })
  };

  // labels para satélite
  const labels = {
    cartoLight: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png', {
      pane: 'labels', maxZoom: 20, opacity: 1, attribution: '© CARTO'
    }),
    esriTrans: L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{x}/{y}', {
      pane: 'labels', maxZoom: 19, opacity: 1, attribution: '© Esri'
    }),
    esriPlaces: L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{x}/{y}', {
      pane: 'labels', maxZoom: 19, opacity: 1, attribution: '© Esri'
    })
  };

  let baseCur = 'osm';
  bases.osm.addTo(map);

  function enableSatLabels(on){
    const want = !!on;
    const hasL = map.hasLayer(labels.cartoLight);
    const hasT = map.hasLayer(labels.esriTrans);
    const hasP = map.hasLayer(labels.esriPlaces);
    if (want){
      if (!hasL) labels.cartoLight.addTo(map);
      if (!hasT) labels.esriTrans.addTo(map);
      if (!hasP) labels.esriPlaces.addTo(map);
    } else {
      if (hasL) map.removeLayer(labels.cartoLight);
      if (hasT) map.removeLayer(labels.esriTrans);
      if (hasP) map.removeLayer(labels.esriPlaces);
    }
  }

  function setBase(name){
    if (!bases[name] || name === baseCur) return;
    if (map.hasLayer(bases[baseCur])) map.removeLayer(bases[baseCur]);
    bases[name].addTo(map);
    enableSatLabels(name === 'sat');
    baseCur = name;
  }

  function wireButtons(){
    const bSat = document.getElementById('toggleSatellite');
    const bTer = document.getElementById('toggleTerrain');
    const bIn  = document.getElementById('zoomIn');
    const bOut = document.getElementById('zoomOut');
    const bLoc = document.getElementById('locateMe');

    bSat?.addEventListener('click', () => setBase(baseCur !== 'sat' ? 'sat' : 'osm'));
    bTer?.addEventListener('click', () => setBase(baseCur !== 'terrain' ? 'terrain' : 'osm'));
    bIn?.addEventListener('click',  () => map.zoomIn());
    bOut?.addEventListener('click', () => map.zoomOut());

    // 📍 fluxo novo (uma única leitura com animação)
    bLoc?.addEventListener('click', () => { locateOnceAnimated(); });
  }

  return { setBase, wireButtons, get current(){ return baseCur; }, bases, labels };
}
// instancia os botões/base
const baseCtl = makeBaseController(map);
baseCtl.wireButtons();

/* ----------------- Busca (local + remoto) ----------------- */
const searchForm  = $("#searchForm");
const searchInput = $("#searchInput");
const searchBtn   = $("#searchBtn");
if (searchBtn) searchBtn.type = "button";

let searchResults = document.getElementById("searchResults");
if (!searchResults) {
  searchResults = document.createElement("div");
  searchResults.id = "searchResults";
  document.body.appendChild(searchResults);
}
searchResults.className = "search-results";
searchResults.style.position = "fixed";
searchResults.style.maxHeight = "320px";
searchResults.style.overflowY = "auto";
searchResults.style.display = "none";
searchResults.style.zIndex = "9999";

const norm   = (q) => q.trim().replace(/\s+/g, " ");
const encode = (q) => encodeURIComponent(q);

function positionResults() {
  if (!searchInput || !searchResults) return;
  const r = searchInput.getBoundingClientRect();
  searchResults.style.left = `${r.left}px`;
  searchResults.style.top  = `${r.bottom + 4}px`;
  searchResults.style.width = `${r.width}px`;
}
window.addEventListener("resize", positionResults);
window.addEventListener("scroll", positionResults, true);

function showResults(on) {
  searchResults.style.display = on ? "block" : "none";
  if (on) positionResults();
}

// ---------- BUSCA LOCAL ----------
const KEY_RE = /^([A-Z]{2,6})\s*[-_:.\s]*0*([0-9]{1,4})$/i;
function isKeyQuery(q) { return KEY_RE.test(q.trim()); }
function parseKey(q) {
  const m = q.trim().match(KEY_RE);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  const num = String(+m[2]).padStart(2, "0");
  return `${prefix}${num}`;
}
function searchLocal(qRaw, limit = 20) {
  const q = qRaw.trim();
  const out = [];
  const seen = new Set();

  const isKey = KEY_RE.test(q);
  let keyNorm = null;
  if (isKey) {
    const m = q.match(KEY_RE);
    keyNorm = (m[1].toUpperCase() + String(+m[2]).padStart(2, "0"));
  }
  const qLower = q.toLowerCase();

  // pontos
  for (const p of (localIndex.points || [])) {
    const name = (p.name || "");
    const code = (p.code || "");
    const k = `${code}|${p.lat.toFixed(6)}|${p.lon.toFixed(6)}`;
    if (seen.has(k)) continue;

    let ok = false, score = 0;

    if (isKey) {
      if (code === keyNorm) { ok = true; score += 100; }
      else if (code.startsWith(keyNorm)) { ok = true; score += 60; }
    } else {
      if (code.toLowerCase().startsWith(qLower)) { ok = true; score += 80; }
      else if (name.toLowerCase().includes(qLower)) { ok = true; score += 40; }
      else if (code.toLowerCase().includes(qLower)) { ok = true; score += 20; }
    }

    if (ok) {
      seen.add(k);
      out.push({ kind: "point", icon: "📍", name: code || name, desc: name && code ? name : "", lat: p.lat, lon: p.lon, _score: score });
      if (out.length >= limit) break;
    }
  }

  // grupos
  for (const g of (localIndex.groups || [])) {
    if (g.name && g.name.toLowerCase().includes(qLower)) {
      const k = `G|${g.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: "group", icon: "🗂️", name: g.name, desc: "Grupo/Alimentador", lat: g.lat, lon: g.lon, bbox: g.bbox, _score: 10 });
    }
  }

  out.sort((a,b)=> (b._score||0) - (a._score||0));
  return out;
}

function flyToLocal(item) {
  if (item.kind === "group" && item.bbox) {
    map.fitBounds(item.bbox, { padding: [48, 48] });
    setStatus(`🗂️ Grupo: ${item.name}`);
    showResults(false);
    return;
  }
  const z = Math.max(map.getZoom(), 15);
  map.flyTo([item.lat, item.lon], z, { duration: 0.9 });
  const temp = L.circleMarker([item.lat, item.lon], {
    radius: 8, color: "#111", weight: 2, fillColor: "#4dabf7", fillOpacity: 1, renderer: fastRenderer
  }).addTo(map);
  temp.bindPopup(
    `<div style="min-width:220px"><b>${item.name}</b>${item.desc ? `<br><small>${item.desc}</small>` : ""}<br><small>Lat: ${item.lat.toFixed(6)}, Lon: ${item.lon.toFixed(6)}</small></div>`
  ).openPopup();
  setTimeout(() => map.removeLayer(temp), 15000);
  setStatus(`📍 ${item.name}`);
  showResults(false);
  searchResults.innerHTML = "";
  if (searchInput) searchInput.value = "";
}
function renderResults(items) {
  if (!searchResults) return;
  searchResults.innerHTML = "";
  if (!items.length) {
    searchResults.innerHTML = `<div class="search-item" style="opacity:.7;cursor:default">Nenhum resultado</div>`;
    showResults(true);
    return;
  }
  items.forEach((it) => {
    const div = document.createElement("div");
    div.className = "search-item";
    div.style.cursor = "pointer";
    const icon = it.icon || (it.type?.includes("city") || it.type === "PPL" ? "🏙️" : "📍");
    const title = it.title || it.name;
    const subtitle = it.subtitle || it.desc || (it.name || "");
    div.innerHTML = `<b>${icon} ${title}</b>${subtitle ? `<br><small>${subtitle}</small>` : ""}`;
    div.addEventListener("click", () => {
      if (it.kind) flyToLocal(it); else flyToResult(it);
    });
    searchResults.appendChild(div);
  });
  showResults(true);
}

// ---------- GEOCODE REMOTO (fallback) ----------
async function geocode(queryRaw) {
  const q = norm(queryRaw);
  if (!q) return [];
  const qEnc = encode(q);
  try {
    const r = await timeoutFetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${qEnc}&count=6&language=pt&format=json`,
      {}, 10000
    );
    if (r.ok) {
      const j = await r.json();
      const itemsOM = (j.results || []).map((it) => ({
        name: [it.name, it.admin1, it.country].filter(Boolean).join(", "),
        type: it.feature_code || "place",
        lat: it.latitude,
        lon: it.longitude,
        country_code: it.country_code || ""
      })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      if (itemsOM.length) return itemsOM;
    }
  } catch {}
  try {
    const r2 = await timeoutFetch(
      `https://geocode.maps.co/search?q=${qEnc}&limit=6`, {}, 10000
    );
    if (r2.ok) {
      const j2 = await r2.json();
      const items = (j2 || []).map((it) => ({
        name: it.display_name || it.name || "Local",
        type: it.class || it.type || "place",
        lat: +it.lat,
        lon: +it.lon,
        country_code: (it.address && it.address.country_code) || ""
      })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      if (items.length) return items;
    }
  } catch {}
  return [];
}
function rankResults(items) {
  if (!Array.isArray(items)) return [];
  const withScore = items.map((it, idx) => {
    let score = 0;
    const name = (it.name || "").toLowerCase();
    if ((it.country_code || "").toUpperCase() === "BR") score += 5;
    if (/brasil|brazil/.test(name)) score += 3;
    if (/^belo horizonte\b/i.test(it.name)) score += 2;
    return { it, score, idx };
  });
  withScore.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return withScore.map(x => x.it);
}
function flyToResult(it) {
  const z = it.type === "country" ? 6
          : it.type === "state"   ? 8
          : (it.type?.includes("city") || it.type === "PPL") ? 12 : 13;
  map.flyTo([it.lat, it.lon], z, { duration: 0.9 });
  const temp = L.marker([it.lat, it.lon], {
    icon: L.divIcon({ className: "", html: '<div style="font-size:28px">📍</div>', iconSize: [0, 0] })
  }).addTo(map);
  const main = String(it.name).split(",")[0];
  temp.bindPopup(
    `<div style="min-width:220px"><b>${main}</b><br><small>${it.name}</small><br><small>Lat: ${it.lat.toFixed(6)}, Lon: ${it.lon.toFixed(6)}</small></div>`
  ).openPopup();
  setTimeout(() => map.removeLayer(temp), 15000);
  setStatus(`📍 Local: ${main}`);
  showResults(false);
  searchResults.innerHTML = "";
  if (searchInput) searchInput.value = "";
}
async function handleSearch(e) {
  if (e) e.preventDefault();
  const q = (searchInput?.value || "").trim();
  if (!q || q.length < 2) { renderResults([]); return; }
  const local = searchLocal(q);
  if (local.length === 1) { flyToLocal(local[0]); return; }
  if (local.length > 1) { renderResults(local); setStatus(`Resultados no mapa para “${q}”`); return; }
  setStatus(`Buscando “${q}”…`);
  showLoading(true, "Buscando localização…");
  try {
    const remote = rankResults(await geocode(q));
    showLoading(false);
    if (remote.length === 1) { flyToResult(remote[0]); return; }
    renderResults(remote);
    setStatus(remote.length ? `Resultados para “${q}”` : `Nada encontrado para “${q}”`);
  } catch (err) {
    console.error("[search] erro:", err);
    showLoading(false);
    renderResults([]);
    setStatus("Erro ao buscar localização");
  }
}
// listeners (apenas uma vez)
searchForm?.addEventListener("submit", handleSearch);
searchBtn?.addEventListener("click", handleSearch);
searchInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearch(e); });

// 🔹 Sugestões em tempo real (apenas busca local)
let _suggTimer = null;
searchInput?.addEventListener('input', () => {
  clearTimeout(_suggTimer);
  const q = (searchInput.value || '').trim();
  if (q.length < 2) { showResults(false); searchResults.innerHTML = ''; return; }
  _suggTimer = setTimeout(() => {
    const items = searchLocal(q, 12); // até 12 sugestões locais
    renderResults(items);
  }, 120);
});

document.addEventListener("click", (e) => {
  const inside = searchResults.contains(e.target) ||
                 searchInput?.contains(e.target) ||
                 searchBtn?.contains(e.target);
  if (!inside) {
    showResults(false);
    searchResults.innerHTML = "";
  }
});

/* ----------------- Publicação KML/KMZ ----------------- */
const fileInput = $("#fileInput"),
      dropZone = $("#dropZone"),
      currentFile = $("#currentFile");

/* PAINÉIS */
const layersListLines = $("#layersList") || null;
const layersListPosts = $("#postsLayersList") || null;
const hideAllBtn = $("#hideAllLayers"),
      showAllBtn = $("#showAllLayers"),
      hideAllPostsBtn = $("#hideAllPosts"),
      showAllPostsBtn = $("#showAllPosts");

const palette = [
  "#1976d2","#4dabf7","#51cf66","#f59f00","#845ef7",
  "#22b8cf","#e8590c","#a9e34b","#ff8787","#2f9e44",
  "#f783ac","#20c997","#ffa94d","#94d82d","#66d9e8",
  "#748ffc","#e599f7","#12b886","#e67700","#5c7cfa",
];
const POST_COLORS = { "FU": "#e03131", "FA": "#4f3b09", "RE": "#2f9e44", "KVA":"#845ef7", "OUTROS": "#868e96" };

const groups = {}, colors = {}, order = [];
const postGroups = {}, postOrder = [];
let pIdx = 0;
let published = null, stats = { markers: 0, lines: 0, polygons: 0 };
let routeLayer = null;

const lod = { keysContainer: null, keysRawGroup: null, keysVisible: false, blockMarkersUntilZoom: true };
const hasCluster = typeof L.markerClusterGroup === "function";

/* ---------- Destaque (linha + postos) ---------- */
const highlight = { line:null, oldStyle:null, halo:null, markers:[] };
let allPostMarkers = [];

const nextColor = (n) => colors[n] ?? (colors[n] = palette[pIdx++ % palette.length]);
function resetGroups() {
  // remover linhas/polígonos
  for (const name of Object.keys(groups)) {
    try { map.removeLayer(groups[name]); } catch {}
    delete groups[name];
  }
  // remover grupos de postos
  for (const gname of Object.keys(postGroups)) {
    try { map.removeLayer(postGroups[gname]); } catch {}
    delete postGroups[gname];
  }
  // remover contêiner de postos
  if (lod.keysContainer) { try { map.removeLayer(lod.keysContainer); } catch {} }
  if (lod.keysRawGroup)  { try { map.removeLayer(lod.keysRawGroup);  } catch {} }
  lod.keysContainer = null;
  lod.keysRawGroup  = null;
  lod.keysVisible   = false;
  lod.blockMarkersUntilZoom = true;

  Object.keys(colors).forEach(k => delete colors[k]);
  order.length = 0;
  postOrder.length = 0;
  pIdx = 0;
  allPostMarkers = [];

  clearEmphasis();
}

function refreshCounters() {
  $("#markerCount") && ($("#markerCount").textContent = stats.markers);
  $("#lineCount") && ($("#lineCount").textContent = stats.lines);
  $("#polygonCount") && ($("#polygonCount").textContent = stats.polygons);
}
function renderLayersPanelLines() {
  if (!layersListLines) return;
  layersListLines.innerHTML = "";
  if (!order.length) {
    layersListLines.innerHTML = `<div class="empty"><div class="empty-ico">🗂️</div><p>Nenhuma camada carregada</p></div>`;
    return;
  }
  order.forEach((name) => {
    const color = colors[name];
    const row = document.createElement("label");
    row.className = "layer-item";
    row.innerHTML = `<input type="checkbox" checked data-af="${name}"><span class="layer-color" style="background:${color}"></span><span class="layer-name">${name}</span>`;
    const cb = row.querySelector("input");
    cb.onchange = () => {
      if (cb.checked) {
        groups[name].addTo(map);
      } else {
        if (highlight.line && groups[name]?.hasLayer?.(highlight.line)) clearEmphasis();
        groups[name].eachLayer(l => l.unbindTooltip?.());
        map.removeLayer(groups[name]);
      }
    };
    layersListLines.appendChild(row);
  });
}
function renderLayersPanelPosts() {
  if (!layersListPosts) return;
  layersListPosts.innerHTML = "";
  if (!postOrder.length) {
    layersListPosts.innerHTML = `<div class="empty"><div class="empty-ico">📍</div><p>Nenhum posto</p></div>`;
    return;
  }
  postOrder.forEach((gname) => {
    const color = POST_COLORS[gname] || POST_COLORS.OUTROS;
    const row = document.createElement("label");
    row.className = "layer-item";
    row.innerHTML = `<input type="checkbox" checked data-pg="${gname}"><span class="layer-color" style="background:${color}"></span><span class="layer-name">${gname}</span>`;
    const cb = row.querySelector("input");
    cb.onchange = () => cb.checked ? postGroups[gname].addTo(map) : map.removeLayer(postGroups[gname]);
    layersListPosts.appendChild(row);
  });
}

/* -------- Helpers de parsing -------- */
function parseCoordBlock(txt) {
  if (!txt) return [];
  return txt.trim().replace(/\s+/g, " ").split(" ").map((p) => {
    const [lngS, latS] = p.split(",");
    const lat = parseFloat(latS), lng = parseFloat(lngS);
    return isNaN(lat) || isNaN(lng) ? null : [lat, lng];
  }).filter(Boolean);
}
function getPotencia(pm) {
  for (const d of pm.querySelectorAll("ExtendedData Data")) {
    const k = (d.getAttribute("name") || "").toLowerCase();
    if (k.includes("kva") || k.includes("pot") || k.includes("potencia")) {
      const v = d.querySelector("value")?.textContent?.trim();
      if (v) return v.replace(/kva$/i, "kVA");
    }
  }
  return null;
}
function postoGroupByName(rawName, pm) {
  const n = (rawName || '').toUpperCase();
  if (/-FU\b/.test(n)) return 'FU';
  if (/-FA\b/.test(n)) return 'FA';
  if (/-RE\b/.test(n)) return 'RE';
  const pot = getPotencia(pm);
  if (pot) return 'KVA';
  return 'OUTROS';
}

/* ------------- Rota (Google Maps) ------------- */
function openGoogleMapsApp(lat, lng) {
  const dest = `${lat},${lng}`;
  const ios = `comgooglemaps://?daddr=${dest}&directionsmode=driving`;
  const android = `google.navigation:q=${dest}`;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);
  setTimeout(() => { location.href = web; }, 250);
  if (isIOS) location.href = ios;
  else if (isAndroid) location.href = android;
  else location.href = web;
}

/* --------- Distâncias/centro ---------- */
function haversine(a, b){
  const R = 6371000;
  const toRad = (x)=> x*Math.PI/180;
  const dLat = toRad(b.lat-a.lat);
  const dLng = toRad(b.lng-a.lng);
  const s1 = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s1));
}
function centroidLatLng(coords){
  let lat=0, lng=0, n=coords.length;
  coords.forEach(([lt,lg])=>{ lat+=lt; lng+=lg; });
  return { lat: lat/n, lng: lng/n };
}
function nearestARA(keysArr, pt){
  let best = null, bd = Infinity;
  for(const k of keysArr){
    const d = haversine(pt, {lat:k.lat, lng:k.lng});
    if (d < bd){ bd = d; best = k.code; }
  }
  return { code: best, dist: bd };
}

/* --------- Realce: helpers em METROS ---------- */
function distPointToSegmentMeters(P, A, B){
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const lat0 = toRad(P.lat);
  const x = (lng, lat) => R * toRad(lng) * Math.cos(lat0);
  const y = (lat)        => R * toRad(lat);
  const ax = x(A.lng, A.lat) - x(P.lng, P.lat);
  const ay = y(A.lat) - y(P.lat);
  const bx = x(B.lng, B.lat) - x(P.lng, P.lat);
  const by = y(B.lat) - y(P.lat);
  const vx = bx - ax, vy = by - ay;
  const c1 = -(ax*vx + ay*vy);
  if (c1 <= 0) return Math.hypot(ax, ay);
  const c2 = vx*vx + vy*vy;
  if (c2 <= c1) return Math.hypot(bx, by);
  const t = c1 / c2;
  const px = ax + t*vx, py = ay + t*vy;
  return Math.hypot(px, py);
}
function minDistToPolylineMeters(latlng, poly){
  const ll = poly.getLatLngs();
  const pts = Array.isArray(ll[0]) ? ll.flat() : ll;
  let min = Infinity;
  for (let i=0; i<pts.length-1; i++){
    const d = distPointToSegmentMeters(
      {lat: latlng.lat, lng: latlng.lng},
      {lat: pts[i].lat,   lng: pts[i].lng},
      {lat: pts[i+1].lat, lng: pts[i+1].lng}
    );
    if (d < min) min = d;
  }
  return min;
}
function bufferForZoomMeters(z){
  return Math.max(35, 250 * Math.pow(0.75, (z - 12)));
}

// Normaliza nome de grupo/código (ex.: "PAI-11" -> "PAI11")
function normalizeGroupName(txt){
  if (!txt) return null;
  const code = extractFeedFromText(String(txt).toUpperCase());
  return code || String(txt).toUpperCase().trim();
}

// Polyline mais próxima dentro de um LayerGroup
function nearestPolylineInGroup(groupLayer, lat, lng){
  if (!groupLayer) return null;
  let best = null, bestD = Infinity;
  groupLayer.eachLayer(l => {
    if (l instanceof L.Polyline && !(l instanceof L.Polygon)) {
      const d = minDistToPolylineMeters({ lat, lng }, l);
      if (d < bestD) { bestD = d; best = l; }
    }
  });
  return best;
}

// Fallback: linha mais próxima em TODOS os grupos
function nearestPolylineGlobal(lat, lng){
  let best = null, bestD = Infinity;
  for (const gName of Object.keys(groups)) {
    const l = nearestPolylineInGroup(groups[gName], lat, lng);
    if (l) {
      const d = minDistToPolylineMeters({ lat, lng }, l);
      if (d < bestD) { bestD = d; best = l; }
    }
  }
  return best;
}

// Wrapper para clique no posto
function emphasizeNearestLineFor(groupName, lat, lng){
  const grp = groupName ? groups[normalizeGroupName(groupName)] : null;
  let target = null;
  if (grp) target = nearestPolylineInGroup(grp, lat, lng);
  if (!target) target = nearestPolylineGlobal(lat, lng);
  if (target) emphasizePolyline(target);
}

function guessGroupForPoint(pm, lat, lng, fallbackAlim){
  const explicit = findFeedCodeInPlacemark(pm);
  if (explicit) return explicit;
  const asCode = extractFeedFromText(fallbackAlim);
  if (asCode) return asCode;
  const near = nearestPolylineGlobal(lat, lng);
  if (near && near.__label) return near.__label;
  return fallbackAlim || "—";
}

/* --------- Marcador leve para POSTOS ---------- */
function makePostMarker(lat, lng, color, labelHtml, extraHtml = "") {
  const baseRadius = matchMedia?.('(pointer:coarse)').matches ? 7 : 5;
  const cm = L.circleMarker([lat, lng], {
    radius: baseRadius,
    stroke: true,
    weight: 2,
    color: "#fff",
    fillColor: color,
    fillOpacity: 1,
    renderer: fastRenderer,
    updateWhenZooming: false
  });
  cm.__groupName = null;
  cm.setGroupName = (g) => { cm.__groupName = normalizeGroupName(g); };
  cm.on("click", () => {
    cm.bindPopup(`
      <div style="padding:8px;min-width:230px">
        ${labelHtml}${extraHtml}
        <div style="margin-top:8px">
          <button class="btn primary js-gmaps">Abrir no Google Maps (rota)</button>
        </div>
        <small style="color:#999;display:block;margin-top:6px">
          Lat: ${lat.toFixed(6)}, Lon: ${lng.toFixed(6)}
        </small>
      </div>
    `).openPopup();
    cm.getPopup()?.getElement()
      ?.querySelector(".js-gmaps")
      ?.addEventListener("click", () => openGoogleMapsApp(lat, lng));
    emphasizeNearestLineFor(cm.__groupName, lat, lng);
  });
  return cm;
}

function updatePostLabels() {
  const canShow = map.getZoom() >= Z_POST_TEXT_ON;
  if (!canShow) {
    for (const it of allPostMarkers) {
      if (it._labelOn) { it.m.unbindTooltip(); it._labelOn = false; }
    }
    return;
  }
  const bbox = map.getBounds().pad(0.12);
  const used = new Set();
  let shown = 0;
  const toCell = (lat, lng) => {
    const p = map.latLngToContainerPoint([lat, lng]);
    const cx = Math.floor(p.x / LABEL_GRID_PX);
    const cy = Math.floor(p.y / LABEL_GRID_PX);
    return cx + ':' + cy;
  };
  const center = map.getCenter();
  const dist2 = (a,b)=> {
    const pa = map.latLngToContainerPoint([a.lat, a.lng]);
    const pb = map.latLngToContainerPoint([b.lat, b.lng]);
    const dx = pa.x - pb.x, dy = pa.y - pb.y;
    return dx*dx + dy*dy;
  };
  const items = allPostMarkers
    .filter(it => bbox.contains([it.lat, it.lng]))
    .sort((a,b)=> dist2(a, center) - dist2(b, center));
  for (const it of items) {
    if (shown >= MAX_POST_LABELS) break;
    const cell = toCell(it.lat, it.lng);
    if (used.has(cell)) {
      if (it._labelOn) { it.m.unbindTooltip(); it._labelOn = false; }
      continue;
    }
    used.add(cell);
    if (!it._labelOn) {
      it.m.bindTooltip(it.text, {
        permanent: true,
        direction: "bottom",
        offset: [0, 10],
        className: "post-inline-label"
      });
      it._labelOn = true;
    }
    shown++;
  }
  for (const it of allPostMarkers) {
    if (!bbox.contains([it.lat, it.lng])) {
      if (it._labelOn) { it.m.unbindTooltip(); it._labelOn = false; }
      continue;
    }
    const cell = toCell(it.lat, it.lng);
    if (!used.has(cell) && it._labelOn) {
      it.m.unbindTooltip(); it._labelOn = false;
    }
  }
}

/* --------- Tooltips + clique para enfatizar linhas ---------- */
function attachLineTooltip(poly, grpLabel) {
  poly.__label = grpLabel;
  const openLabel = () => {
    poly.bindTooltip(grpLabel, {
      direction: "center",
      className: "line-label",
      sticky: true
    }).openTooltip();
  };
  const closeLabel = () => poly.unbindTooltip();
  poly.on("mouseover", () => { if (map.getZoom() >= Z_LABELS_ON) openLabel(); });
  poly.on("mouseout",  closeLabel);
  poly.on("click", () => { openLabel(); emphasizePolyline(poly); });
  poly.on("touchstart", () => openLabel());
}

/* --------- LOD ---------- */
function updateLOD() {
  const z = map.getZoom();

  const canShowMarkers = (z >= Z_MARKERS_ON) && !lod.blockMarkersUntilZoom;

  if (canShowMarkers && !lod.keysVisible && lod.keysContainer) {
    map.addLayer(lod.keysContainer);
    lod.keysVisible = true;
  } else if ((!canShowMarkers || !lod.keysContainer) && lod.keysVisible) {
    map.removeLayer(lod.keysContainer);
    lod.keysVisible = false;
  }

  const IS_TOUCH = matchMedia?.('(pointer:coarse)').matches;
  const TOUCH_BONUS = IS_TOUCH ? 1.5 : 0;
  const w = Math.min(LINE_MAX_W, LINE_BASE_W + TOUCH_BONUS + Math.max(0, z - 12) * 0.9);
  const targetLevel = (z < 13) ? 'coarse' : (z < 15 ? 'mid' : 'fine');

  Object.values(groups).forEach((g) => {
    g.eachLayer((l) => {
      if (l instanceof L.Polyline && !(l instanceof L.Polygon)) {
        if (l.__levels && l.__lodApplied !== targetLevel) {
          l.setLatLngs(l.__levels[targetLevel]);
          l.__lodApplied = targetLevel;
        }
        l.setStyle({ weight: w, opacity: 0.95 });
      }
    });
  });
}

// Assinatura de linha p/ evitar duplicatas
function lineSignature(grp, coords) {
  const round5 = (n) => Math.round(n * 1e5) / 1e5;
  const sample = (arr, step = Math.ceil(arr.length / 8)) =>
    arr.filter((_, i) => i === 0 || i === arr.length - 1 || i % step === 0)
       .map(([lt, lg]) => `${round5(lt)},${round5(lg)}`).join(';');
  const s1 = `${grp}|${sample(coords)}`;
  const s2 = `${grp}|${sample([...coords].reverse())}`;
  return s1 < s2 ? s1 : s2;
}

let _labelsScheduled = false, _labelsTimer = null;
function scheduleUpdatePostLabels(){
  if (_labelsScheduled) return;
  _labelsScheduled = true;
  clearTimeout(_labelsTimer);
  _labelsTimer = setTimeout(() => {
    _labelsScheduled = false;
    updatePostLabels();
  }, 60);
}
map.on("zoomend", () => { updateLOD(); scheduleUpdatePostLabels(); });
map.on("moveend", scheduleUpdatePostLabels);
map.on("zoomstart", () => {
  for (const it of allPostMarkers) { if (it._labelOn) { it.m.unbindTooltip(); it._labelOn = false; } }
});

/* ---------- Destaque aplicar/limpar ---------- */
function clearEmphasis(){
  if (highlight.line && highlight.oldStyle){
    try {
      highlight.line.unbindTooltip();
      highlight.line.setStyle(highlight.oldStyle).bringToBack();
    } catch {}
  }
  if (highlight.halo){ try { map.removeLayer(highlight.halo); } catch {} }
  highlight.markers.forEach(({m, old})=>{
    try { m.setStyle(old).setRadius(old.radius || 5).bringToBack(); } catch {}
  });
  highlight.line = highlight.oldStyle = highlight.halo = null;
  highlight.markers = [];
}
function emphasizePolyline(poly){
  clearEmphasis();
  const cur = poly.options || {};
  highlight.oldStyle = { color: cur.color, weight: cur.weight, opacity: cur.opacity, smoothFactor: cur.smoothFactor };
  highlight.line = poly;
  const coords = poly.getLatLngs();
  highlight.halo = L.polyline(coords, {
    color: '#ffffff', weight: (cur.weight||3) + 10, opacity: 0.45, interactive: false, renderer: fastRenderer, updateWhenZooming: false
  }).addTo(map);
  poly.setStyle({ color: '#ffd43b', weight: (cur.weight||3) + 4, opacity: 1 }).bringToFront();
  if (poly.__label) {
    poly.bindTooltip(poly.__label, { direction: "center", className: "line-label", sticky: true }).openTooltip();
  }
  const THRESH_M = bufferForZoomMeters(map.getZoom());
  for (const it of allPostMarkers){
    const d = minDistToPolylineMeters({lat: it.lat, lng: it.lng}, poly);
    if (d <= THRESH_M){
      const old = { ...it.m.options, radius: it.m.options.radius };
      highlight.markers.push({ m: it.m, old });
      it.m.setStyle({ color:'#000', weight:3, fillOpacity: 1 })
          .setRadius(Math.max(8, (old.radius||5) + 3))
          .bringToFront();
    }
  }
}
map.on('click', (e)=>{
  if (!(e.originalEvent?.target?.closest?.('.leaflet-interactive'))) clearEmphasis();
});

/* ----------------- Parse e publicação do KML (lotes) ----------------- */
async function parseKML(text, cityHint = "") {
  const groupBounds = {};
  const boundsLines = L.latLngBounds();
  const MIN_START_ZOOM = 12;
  const seenLines = new Set();

  showLoading(true, `Carregando mapa elétrico de ${cityHint || "sua cidade"}…`);

  try {
    const xml = new DOMParser().parseFromString(text, "text/xml");
    if (xml.querySelector("parsererror")) throw new Error("XML inválido");

    if (published) { try { map.removeLayer(published); } catch {} }
    resetGroups();

    published = L.layerGroup().addTo(map);

    localIndex.points = [];
    localIndex.groups = [];
    stats = { markers: 0, lines: 0, polygons: 0 };

    // contêiner de postos (oculto; só aparece após 1º zoom do usuário)
    if (hasCluster) {
      lod.keysContainer = L.markerClusterGroup({
        chunkedLoading: true,
        disableClusteringAtZoom: Z_MARKERS_ON + 2,
        spiderfyOnMaxZoom: false,
        showCoverageOnHover: false
      });
    } else {
      lod.keysRawGroup = L.layerGroup();
      lod.keysContainer = lod.keysRawGroup;
    }
    lod.keysVisible = false;
    lod.blockMarkersUntilZoom = true;

    const placemarks = Array.from(xml.querySelectorAll("Placemark"));
    if (!placemarks.length) throw new Error("Sem Placemark");

    const keyIndex = [];
    const CHUNK = Math.max(600, Math.min(CHUNK_SIZE || 800, 1200));

    for (let i = 0; i < placemarks.length; i += CHUNK) {
      const chunk = placemarks.slice(i, i + CHUNK);
      const pct = Math.min(100, Math.round((i / placemarks.length) * 100));
      showLoading(true, `Processando (${pct}%)…`);

      for (const pm of chunk) {
        const rawName = pm.querySelector("name")?.textContent?.trim() || `Ponto`;
        const alim = getAlim(pm);

        // ---------- POSTO ----------
        const point = pm.querySelector(":scope > Point > coordinates");
        if (point) {
          const coords = parseCoordBlock(point.textContent);
          if (coords.length) {
            const [lat, lng] = coords[0];
            const autoCode = getOrCreateKeyCodeAuto(
              pm, lat, lng, fileInput?.files?.[0]?.name || currentFile?.textContent || ""
            );

            localIndex.points.push({ name: rawName, code: autoCode, lat, lon: lng });
            keyIndex.push({ lat, lng, code: autoCode });

            const gName = postoGroupByName(rawName, pm);
            const color = POST_COLORS[gName] || POST_COLORS.OUTROS;
            if (!postGroups[gName]) { 
              postGroups[gName] = L.layerGroup(); 
              postOrder.push(gName); 
            }

            const pot   = getPotencia(pm);
            const label = `<b>${rawName}</b>`;
            const alimDisplay = guessGroupForPoint(pm, lat, lng, alim);
            const extra = `<br><small>Alim:</small> <b>${alimDisplay || "—"}</b>`
                        + (pot ? `<br><small>Potência:</small> <b>${pot}</b>` : ``)
                        + `<br><small>Cód.:</small> <b>${autoCode}</b>`;

            const marker = makePostMarker(lat, lng, color, label, extra);
            marker.setGroupName(alimDisplay);

            allPostMarkers.push({ m: marker, lat, lng, text: rawName });

            lod.keysContainer.addLayer(marker);
            postGroups[gName].addLayer(marker);

            stats.markers++;
          }
          continue;
        }

        // ---------- LINHAS ----------
        const lineNodes = pm.querySelectorAll(":scope > LineString > coordinates, MultiGeometry LineString coordinates");
        if (lineNodes.length) {
          lineNodes.forEach(ls => {
            const coordsRaw = parseCoordBlock(ls.textContent);
            const coords    = simplifyPathMeters(coordsRaw);
            if (coords.length > 1) {
              const ctr = centroidLatLng(coords);
              const grp = decideGroupForGeometry(pm, ctr, keyIndex);

              const sig = lineSignature(grp, coords);
              if (seenLines.has(sig)) return;
              seenLines.add(sig);

              if (!groups[grp]) {
                groups[grp] = L.layerGroup();
                published.addLayer(groups[grp]);
                order.push(grp);
              }
              const color = nextColor(grp);
              const poly = makeLODPolyline(coords, { color, weight: LINE_BASE_W, opacity: 0.95 }, grp);

              attachLineTooltip(poly, grp);
              groups[grp].addLayer(poly);

              const gb = (groupBounds[grp] ??= L.latLngBounds());
              coords.forEach(([lt, lg]) => { gb.extend([lt, lg]); boundsLines.extend([lt, lg]); });

              stats.lines++;
            }
          });
          continue;
        }

        // ---------- POLÍGONOS ----------
        const polyNodes = pm.querySelectorAll(":scope > Polygon outerBoundaryIs coordinates, MultiGeometry Polygon outerBoundaryIs coordinates");
        if (polyNodes.length) {
          polyNodes.forEach(pg => {
            const ringRaw = parseCoordBlock(pg.textContent);
            const coords  = simplifyPathMeters(ringRaw);
            if (coords.length > 2) {
              const ctr = centroidLatLng(coords);
              const grp = decideGroupForGeometry(pm, ctr, keyIndex);

              if (!groups[grp]) {
                groups[grp] = L.layerGroup();
                published.addLayer(groups[grp]);
                order.push(grp);
              }
              const color = nextColor(grp);
              const p = L.polygon(coords, {
                color, weight: 2.5, fillColor: color, fillOpacity: 0.25,
                updateWhenZooming: false, renderer: fastRenderer
              });
              groups[grp].addLayer(p);
              stats.polygons++;
            }
          });
          continue;
        }
      } // chunk
      await nextIdle();
    } // loop Placemark

    Object.entries(groupBounds).forEach(([name, bbox]) => {
      localIndex.groups.push({ name, lat: bbox.getCenter().lat, lon: bbox.getCenter().lng, bbox });
    });

    renderLayersPanelLines();
    renderLayersPanelPosts();
    refreshCounters();

    if (boundsLines.isValid()) {
      map.fitBounds(boundsLines, { padding: [48, 48] });
      if (map.getZoom() < MIN_START_ZOOM) map.setZoom(MIN_START_ZOOM);
    }

    map.once('zoomend', () => { lod.blockMarkersUntilZoom = false; updateLOD(); });

    updateLOD();
    updatePostLabels();
    setStatus(`✅ Publicado: ${stats.markers} postos, ${stats.lines} linhas, ${stats.polygons} polígonos`);
    // ⇢ se alguém pediu para voltar à minha posição após a publicação, faça agora
if (window.__afterPublishFlyTarget) {
  const { lat, lng, accuracy } = window.__afterPublishFlyTarget;
  const targetZ = Math.max(map.getZoom(), 18);   // zoom confortável
  map.flyTo([lat, lng], targetZ, { duration: 0.7 });
  drawMeAt(lat, lng, accuracy);                  // redesenha o pin
  window.__afterPublishFlyTarget = null;         // limpa o “lembrete”
}

  } catch (e) {
    console.error(e);
    setStatus("❌ Erro ao processar KML: " + e.message);
  } finally {
    showLoading(false);
  }
}

/* ----------------- KMZ loader ----------------- */
async function loadKMZ(file) {
  const cityHint = prettyCityFromFilename(file?.name || "");
  showLoading(true, `Carregando mapa elétrico de ${cityHint || "sua cidade"}…`);
  try {
    const zip = await JSZip.loadAsync(file);
    const entry = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml") && !n.startsWith("__MACOSX"));
    if (!entry) throw new Error("KML não encontrado no KMZ");
    const text = await zip.files[entry].async("text");
    await parseKML(text, cityHint);
  } catch (e) {
    console.error(e);
    setStatus("❌ Erro ao processar KMZ: " + e.message);
  } finally {
    showLoading(false);
  }
}

/* ----------------- Upload / Drag&Drop ----------------- */
fileInput?.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) {
    const cityGuess = prettyCityFromFilename(f.name);
    const last = f.lastModified ? new Date(f.lastModified) : new Date();
    setUpdateBanner(cityGuess || 'Arquivo local', last);
  }
  if (!f) return;
  currentFile && (currentFile.textContent = f.name);
  const ext = f.name.split(".").pop().toLowerCase();
  if (ext === "kml") {
    const r = new FileReader();
    r.onload = (ev) => parseKML(ev.target.result, prettyCityFromFilename(f.name));
    r.readAsText(f);
  } else if (ext === "kmz") {
    loadKMZ(f);
  } else setStatus("Formato não suportado. Use .KML ou .KMZ");
});
if (dropZone && fileInput) {
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); })
  );
  ["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, () => dropZone.classList.add("drag-over"))
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, () => dropZone.classList.remove("drag-over"))
  );
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change"));
  });
}

/* ----------------- Limpar / Ocultar/Exibir ----------------- */
$("#clearLayers")?.addEventListener("click", () => {
  if (published) { map.removeLayer(published); published = null; }
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  clearEmphasis();
  resetGroups();
  localIndex.points = [];
  localIndex.groups = [];
  renderLayersPanelLines();
  renderLayersPanelPosts();
  stats = { markers: 0, lines: 0, polygons: 0 };
  refreshCounters();
  currentFile && (currentFile.textContent = "Nada publicado ainda");
  setStatus("🗑️ Publicação limpa");
});

// ⚠️ Botões afetam apenas LINHAS
hideAllBtn?.addEventListener("click", () => {
  clearEmphasis();
  order.forEach((n) => {
    groups[n].eachLayer(l => l.unbindTooltip?.());
    map.removeLayer(groups[n]);
    const cb = layersListLines?.querySelector(`input[data-af="${n}"]`);
    if (cb) cb.checked = false;
  });
});
showAllBtn?.addEventListener("click", () => {
  order.forEach((n) => {
    if (!map.hasLayer(groups[n])) groups[n].addTo(map);
    const cb = layersListLines?.querySelector(`input[data-af="${n}"]`);
    if (cb) cb.checked = true;
  });
  updateLOD();
});

hideAllPostsBtn?.addEventListener("click", () => {
  postOrder.forEach((gname) => {
    if (postGroups[gname]) map.removeLayer(postGroups[gname]);
    const cb = layersListPosts?.querySelector(`input[data-pg="${gname}"]`);
    if (cb) cb.checked = false;
  });
  if (lod.keysContainer && map.hasLayer(lod.keysContainer)) {
    map.removeLayer(lod.keysContainer);
    lod.keysVisible = false;
  }
});
showAllPostsBtn?.addEventListener("click", () => {
  postOrder.forEach((gname) => {
    if (postGroups[gname] && !map.hasLayer(postGroups[gname])) postGroups[gname].addTo(map);
    const cb = layersListPosts?.querySelector(`input[data-pg="${gname}"]`);
    if (cb) cb.checked = true;
  });
  if (!lod.keysVisible && lod.keysContainer && map.getZoom() >= Z_MARKERS_ON && !lod.blockMarkersUntilZoom) {
    map.addLayer(lod.keysContainer);
    lod.keysVisible = true;
  }
});

/* ----------------- Inicial ----------------- */
setStatus("Sistema pronto");

/* =========================================================
   GeoViewer Pro — Cidades (CRUD via API + upload em disco)
   ========================================================= */
const API_CITIES = 'api/cities.php';

// DOM
const dlgCities          = document.getElementById('citiesDialog');
const btnOpenCities      = document.getElementById('openCities');
const btnCloseCities     = document.getElementById('closeCities');
const btnOkCities        = document.getElementById('okCities');
const cityForm           = document.getElementById('cityForm');
const cityIdInput        = document.getElementById('cityId');
const cityNameInput      = document.getElementById('cityName');
const cityPrefixInput    = document.getElementById('cityPrefix');
const cityFileInput      = document.getElementById('cityFile');
const btnCityNew         = document.getElementById('btnCityNew');
const btnCityDelete      = document.getElementById('btnCityDelete');
const citySearchInput    = document.getElementById('citySearch');
const tbodyCityList      = document.getElementById('cityList');
const tplCityRow         = document.getElementById('cityRowTpl');

const dlgConfirmDel      = document.getElementById('confirmDeleteCityDialog');
const confirmDelCityName = document.getElementById('confirmDelCityName');
const confirmDelCancel   = document.getElementById('confirmDelCancel');
const confirmDelOk       = document.getElementById('confirmDelOk');

let _cities = [];
let _pendingDeleteId = null;

/* ---- Cache Storage para cidades (prefetch) ---- */
const CACHE_CITIES = 'gv-cities-v1';

async function cacheOpen() {
  return ('caches' in window) ? caches.open(CACHE_CITIES) : null;
}
async function cacheGet(url) {
  try {
    const c = await cacheOpen(); if (!c) return null;
    const m = await c.match(url);
    return m || null;
  } catch { return null; }
}
async function cachePut(url, resp) {
  try {
    const c = await cacheOpen(); if (!c) return;
    await c.put(url, resp.clone());
  } catch {}
}

// ------- API helpers -------
async function apiListCities(){
  const r = await fetch(`${API_CITIES}?action=list`, { cache:'no-store' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Falha ao listar cidades');
  return j.data || [];
}
async function apiGetCity(id){
  const r = await fetch(`${API_CITIES}?action=get&id=${encodeURIComponent(id)}`, { cache:'no-store' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Falha ao obter cidade');
  return j.data;
}
async function apiCreateCity({name, prefix, file}){
  const fd = new FormData();
  fd.append('action','create');
  fd.append('name', name);
  if (prefix) fd.append('prefix', prefix);
  if (file) fd.append('file', file, file.name);
  const r = await fetch(API_CITIES, { method:'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Falha ao criar cidade');
  return j.data;
}
async function apiUpdateCity({id, name, prefix, file}){
  const fd = new FormData();
  fd.append('action','update');
  fd.append('id', id);
  fd.append('name', name);
  if (prefix) fd.append('prefix', prefix);
  if (file) fd.append('file', file, file.name);
  const r = await fetch(API_CITIES, { method:'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Falha ao atualizar cidade');
  return j.data;
}
async function apiDeleteCity(id){
  const fd = new FormData();
  fd.append('action','delete');
  fd.append('id', id);
  const r = await fetch(API_CITIES, { method:'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Falha ao excluir cidade');
  return j.data;
}
async function apiSetDefaultCity(id){
  const fd = new FormData();
  fd.append('action','set_default');
  fd.append('id', id);
  const r = await fetch('api/cities.php', { method:'POST', body: fd, cache:'no-store' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Falha ao definir padrão');
  return j.data;
}

// ------- Render -------
function renderCities(filter=''){
  if (!tbodyCityList || !tplCityRow) return;
  const f = (filter||'').trim().toLowerCase();
  const rows = _cities
    .slice()
    .sort((a,b)=> a.name.localeCompare(b.name))
    .filter(c => !f || c.name.toLowerCase().includes(f) || (c.prefix||'').toLowerCase().includes(f));

  tbodyCityList.innerHTML = '';
  rows.forEach(c => {
    const tr = tplCityRow.content.firstElementChild.cloneNode(true);
    tr.dataset.id = c.id;

    const nameCell = tr.querySelector('[data-col="name"]');
    nameCell.textContent = '';
    const star = document.createElement('span');
    star.textContent = c.isDefault ? '⭐ ' : '';
    const nameTxt = document.createTextNode(c.name);
    nameCell.appendChild(star);
    nameCell.appendChild(nameTxt);

    tr.querySelector('[data-col="prefix"]').textContent = c.prefix || '';
    tr.querySelector('[data-col="file"]').textContent = c.file?.name || '—';

    const btnLoad = tr.querySelector('[data-act="load"]');
    const btnEdit = tr.querySelector('[data-act="edit"]');

    const btnDefault = document.createElement('button');
    btnDefault.className = 'icon-link';
    btnDefault.title = 'Definir como padrão';
    btnDefault.textContent = '⭐';
    btnDefault.addEventListener('click', async () => {
      try{
        await apiSetDefaultCity(c.id);
        _cities = await apiListCities();
        renderCities(citySearchInput?.value||'');
        setStatus && setStatus(`⭐ ${c.name} definida como padrão`);
      }catch(err){
        alert(err.message||'Erro ao definir padrão');
      }
    });

    const actions = tr.querySelector('.row-actions');
    actions.insertBefore(btnDefault, actions.firstChild);

    btnLoad.addEventListener('click', () => loadCityOnMap(c.id));
    btnEdit.addEventListener('click', () => fillFormForEdit(c.id));

    tbodyCityList.appendChild(tr);
  });
}
function resetCityForm(){
  cityIdInput.value = '';
  cityNameInput.value = '';
  cityPrefixInput.value = '';
  cityFileInput.value = '';
  btnCityDelete.disabled = true;
}
async function fillFormForEdit(id){
  try{
    const c = await apiGetCity(id);
    cityIdInput.value = c.id;
    cityNameInput.value = c.name;
    cityPrefixInput.value = c.prefix || '';
    cityFileInput.value = '';
    btnCityDelete.disabled = false;
  }catch(err){
    alert(err.message||'Erro ao carregar cidade');
  }
}

// ------- Eventos UI -------
btnOpenCities?.addEventListener('click', async ()=>{
  try{
    setStatus && setStatus('Carregando cidades…');
    _cities = await apiListCities();
    renderCities();
    dlgCities?.showModal();
    setStatus && setStatus('Sistema pronto');
  }catch(err){
    console.error(err);
    alert(err.message||'Erro ao listar');
  }
});
btnCloseCities?.addEventListener('click', ()=> dlgCities?.close());
btnOkCities?.addEventListener('click', ()=> dlgCities?.close());
document.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') {
    if (dlgConfirmDel?.open) dlgConfirmDel.close();
    else if (dlgCities?.open) dlgCities.close();
  }
});
btnCityNew?.addEventListener('click', resetCityForm);
citySearchInput?.addEventListener('input', ()=> renderCities(citySearchInput.value));

btnCityDelete?.addEventListener('click', ()=>{
  const id = cityIdInput.value.trim();
  if (!id) return;
  const c = _cities.find(x => x.id === id);
  if (!c) return;
  _pendingDeleteId = id;
  confirmDelCityName.textContent = c.name;
  dlgConfirmDel.showModal();
});
confirmDelCancel?.addEventListener('click', ()=> { _pendingDeleteId = null; dlgConfirmDel.close(); });
confirmDelOk?.addEventListener('click', async ()=>{
  if (!_pendingDeleteId) return;
  try{
    await apiDeleteCity(_pendingDeleteId);
    _cities = await apiListCities();
    renderCities(citySearchInput?.value||'');
    resetCityForm();
    setStatus && setStatus('🗑️ Cidade excluída');
  }catch(err){
    alert(err.message||'Erro ao excluir');
  }finally{
    _pendingDeleteId = null;
    dlgConfirmDel.close();
  }
});

cityForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const id = cityIdInput.value.trim();
  const name = cityNameInput.value.trim();
  const prefix = cityPrefixInput.value.trim();
  const file  = cityFileInput.files?.[0] || null;

  if (!name){ cityNameInput.focus(); return; }

  try{
    let saved;
    if (!id) saved = await apiCreateCity({name, prefix, file});
    else     saved = await apiUpdateCity({id, name, prefix, file});

    _cities = await apiListCities();
    renderCities(citySearchInput?.value||'');
    fillFormForEdit(saved.id);
    setStatus && setStatus(id ? '💾 Cidade atualizada' : '✅ Cidade cadastrada');
  }catch(err){
    console.error(err);
    alert(err.message||'Erro ao salvar');
  }
});

// ===== Últimas Atualizações (banner) =====
const filesUpdEl = document.getElementById('filesUpdatedAt');
function fmtDateTime(dt){
  try{
    return new Intl.DateTimeFormat('pt-BR',{ dateStyle:'short', timeStyle:'short' }).format(dt);
  }catch{ return dt.toLocaleString?.() || String(dt); }
}
function setUpdateBanner(cityName, when){
  if (!filesUpdEl) return;
  const nice = fmtDateTime(when instanceof Date ? when : new Date(when));
  filesUpdEl.textContent = `Últimas atualizações: ${cityName} — ${nice}`;
}

/* ---------- Load city com cache-first + fallback de rede ---------- */
async function loadCityOnMap(id) {
  try {
    const c = await apiGetCity(id);
    if (!c || !c.file || !c.file.url) { alert('Esta cidade não possui arquivo cadastrado.'); return; }

    const url   = c.file.url;
    const name  = c.name || 'Modelo';
    const isKmz = /\.kmz$/i.test(url);

    setStatus && setStatus(`Baixando ${name}…`);
    showLoading(true, `Carregando ${name}…`);

    // 1) cache
    let resp = await cacheGet(url);

    // 2) rede como fallback; salva no cache se ok
    if (!resp) {
      const net = await fetch(url, { cache: 'no-cache' });
      if (!net.ok) throw new Error('Falha ao baixar arquivo');
      await cachePut(url, net.clone());
      resp = net;
      setStatus && setStatus(`📦 ${name}: salvo em cache para reaberturas rápidas`);
    }

    const lastHdr = resp.headers?.get?.('Last-Modified')
                 || resp.headers?.get?.('X-Last-Modified')
                 || resp.headers?.get?.('Date');
    const when = lastHdr ? new Date(lastHdr) : new Date();
    setUpdateBanner(name, when);

    // PUBLICAÇÃO nova
    if (isKmz) {
      const blob = await resp.blob();
      const fname = c.file.name || `${(c.prefix || cityToPrefix(name) || 'CITY')}.kmz`;
      const file = new File([blob], fname, { type: blob.type || 'application/vnd.google-earth.kmz' });
      await loadKMZ(file);
    } else {
      const text = await resp.text();
      await parseKML(text, name);
    }

    currentFile && (currentFile.textContent = (c.file.name || 'arquivo') + ` (de ${name})`);
    setStatus && setStatus(`📥 ${name} carregada`);
    dlgCities?.close();
  } catch (err) {
    console.error(err);
    alert(err.message || 'Erro ao carregar no mapa');
    setStatus && setStatus('Erro ao carregar arquivo');
  } finally {
    showLoading(false);
  }
}

// Boot leve
(async function initCitiesUI(){
  if (!dlgCities) return;
  try{ _cities = await apiListCities(); } catch {}
})();
(async function autoLoadDefaultCity(){
  try{
    const list = await apiListCities();
    const def = list.find(x => x.isDefault && x.file && x.file.url);
    if (def){
      await loadCityOnMap(def.id);
      setStatus && setStatus(`⭐ Carregada cidade padrão: ${def.name}`);
    }
  }catch(e){}
})();

/* =========================================================
   ADMIN – Logo uploader (server-side) + PWA icons refresh
   ========================================================= */
(function (w, d) {
  const DEFAULTS = {
    defaultLogo: 'assets/img/image.png',
    serverLogoPath: 'uploads/logo.png',
    uploadEndpoint: 'api/upload_logo.php',
    sel: {
      img: '#brandLogo',
      imgTop: '#brandLogoTop',
      loadingLogo: '#loadingLogo',
      favicon: '#favicon',
      fileInput: '#logoFileInput',
      btnFab: '#changeLogoBtn',
      btnInline: '#changeLogoBtnInline'
    },
    maxSizeMB: 2
  };

  function initAdminLogoUpload(opts = {}) {
    const cfg = deepMerge(DEFAULTS, opts);
    const $  = (s) => d.querySelector(s);

    const $img         = $(cfg.sel.img);
    const $imgTop      = $(cfg.sel.imgTop);
    const $loadingLogo = $(cfg.sel.loadingLogo);
    const $favicon     = $(cfg.sel.favicon);
    const $fileInput   = $(cfg.sel.fileInput);
    const $btnFab      = $(cfg.sel.btnFab);
    const $btnInline   = $(cfg.sel.btnInline);

    let $apple = d.querySelector('link[rel="apple-touch-icon"]');
    if (!$apple) {
      $apple = d.createElement('link');
      $apple.setAttribute('rel', 'apple-touch-icon');
      d.head.appendChild($apple);
    }

    const bust = (p) => p + '?' + Date.now();

    function applyLogoUI(src) {
      if ($img)         $img.src = src;
      if ($imgTop)      $imgTop.src = src;
      if ($loadingLogo) $loadingLogo.src = src;
      if ($favicon) $favicon.href = bust('assets/icons/icon-192.png');
      if ($apple)   $apple.href   = bust('assets/icons/apple-touch-icon.png');
    }

    async function loadServerLogo() {
      try {
        const res = await fetch(cfg.serverLogoPath, { cache: 'no-store' });
        applyLogoUI(res.ok ? bust(cfg.serverLogoPath) : cfg.defaultLogo);
      } catch {
        applyLogoUI(cfg.defaultLogo);
      }
    }

    async function uploadLogo(file) {
      const okType = file && file.type && file.type.startsWith('image/');
      if (!okType) { alert('Selecione uma imagem (PNG, JPG, WEBP, GIF, SVG).'); return; }
      if (file.size > cfg.maxSizeMB * 1024 * 1024) {
        alert(`Imagem muito grande (máx. ${cfg.maxSizeMB} MB).`); return;
      }
      const fd = new FormData();
      fd.append('logo', file);
      try {
        const resp = await fetch(cfg.uploadEndpoint, { method: 'POST', body: fd });
        const j = await resp.json();
        if (!j.ok) throw new Error(j.error || 'Falha no upload');
        applyLogoUI(bust(cfg.serverLogoPath));
        [
          'assets/icons/icon-192.png',
          'assets/icons/icon-512.png',
          'assets/icons/icon-512-maskable.png',
          'assets/icons/apple-touch-icon.png'
        ].forEach(p => { const i = new Image(); i.decoding = 'async'; i.src = bust(p); });
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistration()
            .then(reg => reg && reg.update())
            .catch(() => {});
        }
        alert('✅ Logo atualizada com sucesso!');
      } catch (err) {
        alert('❌ Erro ao enviar: ' + (err.message || 'Desconhecido'));
      }
    }

    d.addEventListener('DOMContentLoaded', loadServerLogo);

    if ($img) {
      $img.addEventListener('click', (ev) => {
        if (ev.shiftKey) {
          if (confirm('Restaurar visualmente para a logo padrão (sem apagar do servidor)?')) {
            applyLogoUI(cfg.defaultLogo);
          }
          return;
        }
        $fileInput && $fileInput.click();
      });
      $img.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          $fileInput && $fileInput.click();
        }
      });
    }
    if ($btnFab)    $btnFab.addEventListener('click',   () => $fileInput && $fileInput.click());
    if ($btnInline) $btnInline.addEventListener('click',() => $fileInput && $fileInput.click());

    if ($fileInput) {
      $fileInput.addEventListener('change', (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (file) uploadLogo(file);
        ev.target.value = '';
      });
    }
    return { applyLogoUI, loadServerLogo, uploadLogo, config: cfg };
  }

  function deepMerge(base, extra) {
    const out = { ...base, ...(extra || {}) };
    out.sel = { ...base.sel, ...((extra && extra.sel) || {}) };
    return out;
  }

  w.initAdminLogoUpload = initAdminLogoUpload;
  initAdminLogoUpload();
})(window, document);

/* ---- SW ---- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}

let meLayer = null;   // agrupador do marcador + círculo de foco
let meMarker = null;  // referência do marcador “ponto”
// ======= pós-publicação: alvo para voltar =======
window.__afterPublishFlyTarget = null;

/** redesenha o pin da minha localização sem reler geoloc */
function drawMeAt(lat, lng, accuracy){
  // apaga marcadores antigos com animação (você já tem essa helper)
  if (typeof animateOutOldMarker === 'function') animateOutOldMarker();

  // ping visual
  if (typeof pingAt === 'function') pingAt([lat, lng]);

  // (re)cria o grupo/marcadores
  if (typeof L !== 'undefined') {
    if (typeof meLayer !== 'undefined' && meLayer) { try { map.removeLayer(meLayer); } catch{} }
    meLayer = L.layerGroup().addTo(map);

    meMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'gv-me',
        html: '<span class="gv-me__dot"></span><span class="gv-me__ring"></span>',
        iconSize:[0,0], iconAnchor:[0,0]
      }),
      keyboard:false, zIndexOffset:1000
    }).addTo(meLayer);

    L.circleMarker([lat, lng], {
      radius: 12, color:'#fff', weight:3, fillColor:'transparent',
      opacity:.9, renderer: fastRenderer
    }).addTo(meLayer);

    meLayer.eachLayer(l => l.bringToFront && l.bringToFront());
  }

  if (coordsEl) {
    coordsEl.textContent =
      `Lat: ${lat.toFixed(6)} | Lon: ${lng.toFixed(6)}${accuracy?` (±${Math.round(accuracy)}m)`:''}`;
  }
}

// injeta CSS (ponto + anel + ping)
(function ensureMeStyles(){
  if (document.getElementById('gv-me-styles')) return;
  const css = `
  .gv-me{position:relative; width:0; height:0}
  .gv-me__dot{
    position:absolute; left:-10px; top:-10px; width:20px; height:20px;
    border-radius:50%; background:#e03131; box-shadow:0 0 0 3px #fff, 0 10px 20px rgba(0,0,0,.25);
  }
  .gv-me__ring{
    position:absolute; left:-18px; top:-18px; width:36px; height:36px;
    border:3px solid rgba(224,49,49,.65); border-radius:50%;
    animation:gvPulse 1.2s ease-out infinite; box-sizing:border-box;
  }
  @keyframes gvPulse{
    0%{transform:scale(.6); opacity:.9}
    70%{transform:scale(1.25); opacity:.15}
    100%{transform:scale(1.4); opacity:0}
  }
  .gv-marker--out .gv-me__ring{animation:none; opacity:0; transition:opacity .2s}

  /* ping temporário */
  .gv-ping__dot{
    position:absolute; left:-6px; top:-6px; width:12px; height:12px;
    border-radius:50%; background:#e03131; box-shadow:0 0 0 2px #fff;
  }
  .gv-ping__ring{
    position:absolute; left:-14px; top:-14px; width:28px; height:28px;
    border:2px solid rgba(224,49,49,.65); border-radius:50%;
    animation:gvPulse 1.0s ease-out 1;
  }`;
  const style = document.createElement('style');
  style.id = 'gv-me-styles';
  style.textContent = css;
  document.head.appendChild(style);
})();

function pingAt(latlng) {
  const ping = L.marker(latlng, {
    icon: L.divIcon({
      className: 'gv-ping',
      html: '<span class="gv-ping__dot"></span><span class="gv-ping__ring"></span>',
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    }),
    interactive: false,
    keyboard: false
  }).addTo(map);
  setTimeout(() => map.removeLayer(ping), 1200);
}
function animateOutOldMarker() {
  if (!meLayer) return;
  const el = meMarker?.getElement?.();
  if (el) el.classList.add('gv-marker--out');
  setTimeout(() => {
    try { map.removeLayer(meLayer); } catch {}
    meLayer = null;
    meMarker = null;
  }, 320);
}
/** Lê geolocalização UMA vez com animação */
async function locateOnceAnimated() {
  try {
    if (typeof map.stopLocate === "function") map.stopLocate();

    if (!("geolocation" in navigator)) {
      setStatus && setStatus("⚠️ Geolocalização não suportada.");
      return null;
    }

    setStatus && setStatus("Obtendo sua posição…");

    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000
      });
    });

    const { latitude, longitude, accuracy } = pos.coords;
    const latlng = [latitude, longitude];

    animateOutOldMarker();
    pingAt(latlng);

    const targetZoom = Math.max(map.getZoom(), 18.2);
    map.flyTo(latlng, targetZoom, { animate: true, duration: 0.7 });

    meLayer = L.layerGroup().addTo(map);

    meMarker = L.marker(latlng, {
      icon: L.divIcon({
        className: 'gv-me',
        html: '<span class="gv-me__dot"></span><span class="gv-me__ring"></span>',
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      keyboard: false,
      zIndexOffset: 1000
    }).addTo(meLayer);

    L.circleMarker(latlng, {
      radius: 12, color: '#fff', weight: 3, fillColor: 'transparent',
      opacity: .9, renderer: fastRenderer
    }).addTo(meLayer);

    meLayer.eachLayer(l => l.bringToFront && l.bringToFront());

    if (coordsEl) {
      coordsEl.textContent = `Lat: ${latitude.toFixed(6)} | Lon: ${longitude.toFixed(6)}${accuracy ? ` (±${Math.round(accuracy)}m)` : ''}`;
    }
    setStatus && setStatus("📍 Posição marcada.");

    return { lat: latitude, lng: longitude, accuracy };
  } catch (err) {
    let msg = "Não foi possível obter a localização.";
    if (err && typeof err === "object" && "code" in err) {
      msg =
        err.code === err.PERMISSION_DENIED ? "Permissão de localização negada." :
        err.code === err.POSITION_UNAVAILABLE ? "Posição indisponível." :
        err.code === err.TIMEOUT ? "Tempo esgotado ao obter posição." : msg;
    }
    setStatus && setStatus("⚠️ " + msg);
    alert(msg);
    return null;
  }
}
/** botão 📍 — leitura única + animação (também ligado no makeBaseController) */
document.getElementById("locateMe")?.addEventListener("click", async () => {
  const pos = await locateOnceAnimated(); // sua função que já anima e mostra o ponto
  if (pos && typeof window.loadNearestCityThenReturn === 'function') {
    // 👉 guarda alvo para voltarmos depois que o modelo publicar
    window.__afterPublishFlyTarget = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy || 0 };
    // carrega a cidade mais próxima (sua função)
    window.loadNearestCityThenReturn(pos.lat, pos.lng);
  }
});



/* =======================
   Carregar cidade próxima da localização do usuário
   - Usa reverse geocode para descobrir a cidade
   - Faz matching por nome e/ou prefixo
   - Chama loadCityOnMap(id) se encontrar
   ======================= */

async function reverseGeocodeLatLng(lat, lng){
  const r = await fetch(`api/revgeo.php?lat=${lat}&lon=${lng}`, { cache:'no-store' });
  const j = await r.json().catch(()=>null);
  if (!j || !j.ok) return null;
  return { city: j.city, admin1: j.admin1, country_code: (j.country_code||'').toUpperCase() };
}


/**
 * Acha um modelo por cidade retornada do reverse geocode
 * Tenta por nome exato; se não achar, tenta por prefixo heurístico.
 */
function _matchCityInList(list, cityName, admin1){
  if (!Array.isArray(list) || !list.length) return null;
  const nCity = _normTxt(cityName || '');
  const nUF   = _normTxt(admin1 || '');

  // 1) match exato pelo nome
  let hit = list.find(c => _normTxt(c.name) === nCity);
  if (hit) return hit;

  // 2) nome contém + mesmo estado (quando existir)
  hit = list.find(c => _normTxt(c.name).includes(nCity) && (!nUF || _normTxt(c.state||'')===nUF));
  if (hit) return hit;

  // 3) heurística por prefixo configurado (ex.: BHZ, RIO…)
  const guessPrefix = cityToPrefix(cityName || '');
  hit = list.find(c => (c.prefix||'').toUpperCase() === guessPrefix.toUpperCase());
  if (hit) return hit;

  // 4) começa com
  hit = list.find(c => _normTxt(c.name).startsWith(nCity));
  return hit || null;
}

// ---- 1) helper: normaliza comparação de nomes ----
const _norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

// ---- 2) encontra cidade cadastrada que "bate" com o nome do reverse geocode ----
function findCityByNameLike(cityName, cities){
  const n = _norm(cityName);
  // 1: match exato
  let c = cities.find(x => _norm(x.name) === n);
  if (c) return c;
  // 2: começa com
  c = cities.find(x => _norm(x.name).startsWith(n));
  if (c) return c;
  // 3: inclui (ex.: "Belo Horizonte - MG")
  c = cities.find(x => _norm(x.name).includes(n));
  return c || null;
}

// ---- 3) carrega a cidade mais próxima e, ao terminar, volta para as coord do usuário ----
// Helper p/ mensagens curtas no status

function setStatusShort(msg){
  if (!setStatus) return;
  const s = String(msg || '');
  setStatus(s.length > MAX_STATUS_LEN ? s.slice(0, MAX_STATUS_LEN - 1) + '…' : s);
}

async function loadNearestCityThenReturn(lat, lng){
  try{
    setStatusShort('🔎 Buscando sua cidade…');

    // usa seu endpoint (api/revgeo.php)
    const rg = await reverseGeocodeLatLng(lat, lng);
    const cityName = rg?.city;
    if (!cityName){
      setStatusShort('⚠️ Cidade não identificada.');
      return;
    }

    const list = _cities?.length ? _cities : await apiListCities();
    const match = findCityByNameLike(cityName, list);
    if (!match){
      setStatusShort(`⚠️ ${cityName} não cadastrada.`);
      return;
    }

    setStatusShort(`📥 Carregando ${match.name}…`);
    await loadCityOnMap(match.id);

    // publicado: volta para o ponto do usuário
    const z = Math.max(17, map.getZoom());
    map.flyTo([lat, lng], z, { duration: 0.8 });
    pingAt([lat, lng]);

    setStatusShort(`✅ ${match.name} carregada; mostrando você.`);
  } catch (err){
    console.error(err);
    setStatusShort('⚠️ Erro ao carregar e recentrar.');
  }
}



/**
 * Carrega o modelo da cidade mais próxima da (lat,lng) e,
 * depois que terminar o load/fitBounds, voa de volta pro usuário.
 */
async function loadNearestCityThenReturn(lat, lng, zoom = 18){
  try{
    // 1) tenta descobrir cidade via reverse geocode (use seu proxy sem CORS)
    const rev = await reverseGeocodeLatLng(lat, lng); // { city, admin1, country_code }
    if (!rev || !rev.city){
      console.warn('[nearest] reverse geocode falhou, abortando match de cidade.');
      return;
    }

    // 2) garante lista de cidades atualizada
    try { _cities = await apiListCities(); } catch {}

    const city = _matchCityInList(_cities, rev.city, rev.admin1);
    if (!city){ 
      setStatus && setStatus(`⚠️ Nenhum modelo cadastrado para ${rev.city}.`);
      return;
    }

    setStatus && setStatus(`📦 Carregando modelo de ${city.name}…`);
    await loadCityOnMap(city.id);                 // <- publica KML/KMZ e faz fitBounds
    await new Promise(r => setTimeout(r, 120));   // pequeno respiro p/ terminar render

    // 3) volta para a sua posição (sem “perder” o foco)
    const targetZoom = Math.max(map.getZoom(), zoom);
    map.flyTo([lat, lng], targetZoom, { animate: true, duration: 0.7 });

    // re-garante o marcador de você (se já não estiver na tela)
    if (!meLayer || !meMarker){
      // reaproveita o visual do bloco de localização
      pingAt([lat, lng]);
      meLayer = L.layerGroup().addTo(map);
      
      meMarker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'gv-me',
          html: '<span class="gv-me__dot"></span><span class="gv-me__ring"></span>',
          iconSize: [0,0], iconAnchor: [0,0]
        }),
        keyboard:false, zIndexOffset:1000
      }).addTo(meLayer);
      L.circleMarker([lat, lng], {
        radius: 12, color:'#fff', weight:3, fillColor:'transparent',
        opacity:.9, renderer: fastRenderer
      }).addTo(meLayer);
      meLayer.eachLayer(l => l.bringToFront && l.bringToFront());
    }

    setStatus && setStatus(`✅ ${city.name} carregada. Centralizado na sua posição.`);
  }catch(err){
    console.error('[nearest] erro', err);
    setStatus && setStatus('❌ Erro ao carregar cidade próxima.');
  }
}


function _normTxt(s=''){
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}

function _normCity(s=''){
  return stripAccents(String(s).toLowerCase()).replace(/[^a-z0-9 ]/g,'').trim();
}
function _same(a,b){ return _normCity(a) === _normCity(b); }
function _starts(a,b){ return _normCity(a).startsWith(_normCity(b)); }
function _incl(a,b){ return _normCity(a).includes(_normCity(b)); }

/**
 * Carrega a cidade mais apropriada com base em lat/lng atuais.
 * - Se achar correspondência por nome/prefixo, pergunta e carrega.
 * - Retorna o ID carregado ou null.
 */
async function loadNearestCityThenReturn(lat, lng) {
  try {
    // garantia: lista de cidades pronta
    if (!_cities || !_cities.length) {
      try { _cities = await apiListCities(); } catch {}
    }
    if (!_cities || !_cities.length) {
      setStatus && setStatus('⚠️ Nenhuma cidade cadastrada.');
      return null;
    }

    setStatus && setStatus('🔎 Identificando cidade próxima…');
    const info = await reverseGeocodeLatLng(lat, lng);

    // fallback se reverse falhar: tenta por proximidade de prefixo padrão “GEN”
    if (!info) {
      // sem nome de cidade — não arrisca; apenas retorna
      setStatus && setStatus('⚠️ Não foi possível identificar a cidade pela localização.');
      return null;
    }

    const { city, admin1 } = info;
    const cityN  = _normCity(city);
    const adminN = _normCity(admin1);

    // 1) match exato por nome
    let candidates = _cities.filter(c => _same(c.name, city));

    // 2) começa com / contém
    if (!candidates.length) candidates = _cities.filter(c => _starts(c.name, city) || _incl(c.name, city));

    // 3) tenta por prefixo
    if (!candidates.length) {
      const wantedPrefix = cityToPrefix(city);
      candidates = _cities.filter(c => (c.prefix||'').toUpperCase() === wantedPrefix.toUpperCase());
    }

    // 4) se ainda houver vários, preferir os que mencionam o estado/UF no nome
    if (candidates.length > 1 && adminN) {
      const withAdmin = candidates.filter(c => _incl(c.name, admin1));
      if (withAdmin.length) candidates = withAdmin;
    }

    // 5) escolhe o primeiro
    const chosen = candidates[0] || null;

    if (!chosen) {
      setStatus && setStatus(`ℹ️ Posição em ${city}${admin1?`/${admin1}`:''}, mas não encontrei essa cidade na sua lista.`);
      return null;
    }

    // confirma com o usuário (evita troca “surpresa” do mapa)
    const ok = window.confirm(`Carregar o modelo de “${chosen.name}”?`);
    if (!ok) { setStatus && setStatus('Abertura cancelada.'); return null; }

    await loadCityOnMap(chosen.id);
    setStatus && setStatus(`📦 Carregado: ${chosen.name}`);
    return chosen.id;

  } catch (err) {
    console.error('[loadNearestCityThenReturn]', err);
    setStatus && setStatus('⚠️ Erro ao carregar cidade próxima.');
    return null;
  }
}

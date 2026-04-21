// App principal (sin frameworks). Leaflet se carga por CDN en index.html.
// Nota: como este archivo se carga como ES Module, exponemos a window las funciones
// que el HTML llama por atributos onclick (optimizarYCrearRuta, toggleAnim, etc.).

// -----------------------
// Mapa (estilo navegación 2D: calles + etiquetas por capas, tipo apps)
// -----------------------
const map = L.map('map', {
  preferCanvas: true,
  zoomControl: true,
  zoomControlOptions: { position: 'bottomleft' },
  zoomSnap: 0.5
}).setView([6.2442, -75.5812], 13);

// Exponer `map` para módulos externos
window.map = null;
setTimeout(() => { try{ window.map = map; }catch(_){ } }, 0);

map.createPane('cartoBase');
map.getPane('cartoBase').style.zIndex = 200;
map.createPane('cartoLabels');
map.getPane('cartoLabels').style.zIndex = 250;

const cartoOpts = { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO' };
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { ...cartoOpts, pane: 'cartoBase' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', { ...cartoOpts, pane: 'cartoLabels', opacity: 0.88 }).addTo(map);

let routeLineHalo = null;
let routeLine = null;
let stopMarkers = [];
let vehicleMarker = null;
let vehicleAnim = null; // (ya no se usa para mover el carro; se mantiene por compatibilidad)
let currentRouteLatLngs = [];
let currentStats = { distanceM: 0, durationS: 0 };
let lastVehicleLatLng = null;
let navigationActive = false;

let userLocation = null;
let userMarker = null;
let userAccuracyCircle = null;
let geoWatchId = null;
let followUser = false;
let lastFollowUserPan = null;
let lastFollowVehiclePan = null;

const carIcon = L.icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/743/743922.png',
  iconSize: [38, 38],
  iconAnchor: [19, 19]
});

const userDotIcon = L.divIcon({
  className: 'user-dot-wrap',
  html: '<div class="user-dot"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

// -----------------------
// Paradas en ruta + clientes + asistente (municipio → lugar)
// -----------------------
const LS_CLIENTS = 'reparto_clientes_v1';
const LS_ROUTES_WEEK = 'reparto_rutas_semana_v1';
const LS_SETTINGS = 'reparto_settings_v1';
const LS_LAST_VEHICLE_NOTIF = 'reparto_last_vehicle_notif_date';
const MUNICIPIOS_ORIENTE = [
  'Rionegro', 'La Ceja', 'Marinilla', 'El Retiro', 'Guarne', 'La Unión', 'El Carmen de Viboral',
  'Medellín', 'Envigado', 'Itagüí', 'Bello', 'Sabaneta', 'Copacabana', 'Girardota',
  'Otro (escribir)'
];

let routeStops = [];
let savedClients = [];

// Funciones para acceso externo (otros módulos pueden usarlas)
window.getSavedClients = () => savedClients;
window.getRouteStops = () => routeStops;

let wizMunicipio = '';
let wizLugarText = '';
let wizPreview = null;
let wizTypeaheadTimer = null;
let wizLastSuggestions = [];

/** Días laborales (lun–sáb). Domingo (0): sin plantilla automática. */
const WEEK_DAYS = [
  { key: 'lun', label: 'Lun', long: 'Lunes', js: 1 },
  { key: 'mar', label: 'Mar', long: 'Martes', js: 2 },
  { key: 'mie', label: 'Mié', long: 'Miércoles', js: 3 },
  { key: 'jue', label: 'Jue', long: 'Jueves', js: 4 },
  { key: 'vie', label: 'Vie', long: 'Viernes', js: 5 },
  { key: 'sab', label: 'Sáb', long: 'Sábado', js: 6 }
];
let selectedWeekKey = 'lun';

function uid(){
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function migrateClientRow(c){
  if (!c || !c.name) return null;
  if (!Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lon))) return null;
  return {
    id: c.id || uid(),
    name: String(c.name),
    municipality: String(c.municipality || ''),
    placeDetail: String(c.placeDetail || ''),
    lat: Number(c.lat),
    lon: Number(c.lon),
    display: String(c.display || ''),
    openTime: c.openTime || '08:00',
    closeTime: c.closeTime || '18:00',
    lunchStart: c.lunchStart || '12:00',
    lunchEnd: c.lunchEnd || '13:00',
    priority: c.priority || 'low', // low|medium|high
    amount: Number.isFinite(Number(c.amount)) ? Number(c.amount) : 0,
    paid: !!c.paid,
    orderState: c.orderState || 'Pendiente', // Pendiente|Entregado|Fallido
    serviceMin: Number.isFinite(Number(c.serviceMin)) ? Number(c.serviceMin) : 10,
    lastNotifiedAt: c.lastNotifiedAt || 0
  };
}

function loadClients(){
  try{
    const raw = localStorage.getItem(LS_CLIENTS);
    const arr = raw ? JSON.parse(raw) : [];
    savedClients = Array.isArray(arr) ? arr.map(migrateClientRow).filter(Boolean) : [];
    // Exponer referencia actualizada
    window.savedClients = savedClients;
  }catch(_){
    savedClients = [];
  }
}

function persistClients(){
  localStorage.setItem(LS_CLIENTS, JSON.stringify(savedClients));
  try{ window.savedClients = savedClients; }catch(_){ }
  try{ if (typeof window.renderClientMarkers === 'function') window.renderClientMarkers(); }catch(_){ }
  try{ updateFinancialSummary(); }catch(_){ }
}

function renderClients(){
  const q = (document.getElementById('clientSearch')?.value || '').trim().toLowerCase();
  const box = document.getElementById('clientsList');
  if (!box) return;
  box.innerHTML = '';
  const list = !q ? savedClients : savedClients.filter(c => (c.name||'').toLowerCase().includes(q) || (c.placeDetail||'').toLowerCase().includes(q) || (c.municipality||'').toLowerCase().includes(q));
  if (!list.length){
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.margin = '8px 0 0';
    p.textContent = savedClients.length ? 'No hay coincidencias.' : 'Todavía no guardaste clientes. Al agregar una parada podés usar «Guardar cliente».';
    box.appendChild(p);
    return;
  }
  for (const c of list){
    const row = document.createElement('div');
    row.className = 'client-row';
    const meta = document.createElement('div');
    meta.className = 'client-meta';
    const prClass = c.priority === 'high' ? 'prio-high' : (c.priority === 'medium' ? 'prio-medium' : 'prio-low');
    const paidLabel = c.paid ? 'Cobrado' : 'Pendiente';
    meta.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
        <div>
          <div class="client-name">${escapeHtml(c.name)}</div>
          <div class="client-sub">${escapeHtml(c.placeDetail)} · ${escapeHtml(c.municipality)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <div class="prio-badge ${prClass}">${c.priority === 'high' ? '🔴 Alta' : (c.priority === 'medium' ? '🟠 Media' : '🟢 Baja')}</div>
          <div class="small-muted client-money">${Number(c.amount || 0).toFixed(2)} COP · <span class="small-muted">${paidLabel}</span></div>
          <div class="small-muted client-state">Estado: ${escapeHtml(c.orderState || 'Pendiente')}</div>
        </div>
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'client-actions';
    const bAdd = document.createElement('button');
    bAdd.type = 'button';
    bAdd.className = 'secondary';
    bAdd.textContent = 'A la ruta';
    bAdd.onclick = () => addClientStopToRoute(c);
    const bDetail = document.createElement('button');
    bDetail.type = 'button';
    bDetail.className = 'secondary';
    bDetail.textContent = 'Detalle';
    bDetail.onclick = () => openClientModal(c.id);
    const bEdit = document.createElement('button');
    bEdit.type = 'button';
    bEdit.className = 'secondary';
    bEdit.textContent = 'Editar';
    bEdit.onclick = () => crmLoadClient(c);
    const bDelivered = document.createElement('button');
    bDelivered.type = 'button';
    bDelivered.className = 'secondary';
    bDelivered.textContent = 'Marcar entregado';
    bDelivered.onclick = () => { markAsDelivered(c.id); };
    const b3 = document.createElement('button');
    b3.type = 'button';
    b3.className = 'danger';
    b3.textContent = 'Borrar';
    b3.onclick = () => { savedClients = savedClients.filter(x => x.id !== c.id); persistClients(); renderClients(); updateFinancialSummary(); };
    actions.appendChild(bAdd);
    actions.appendChild(bDetail);
    actions.appendChild(bEdit);
    actions.appendChild(bDelivered);
    actions.appendChild(b3);
    row.appendChild(meta);
    row.appendChild(actions);
    box.appendChild(row);
  }
  updateFinancialSummary();
}

function addClientStopToRoute(c){
  const label = `${c.name} — ${c.placeDetail}, ${c.municipality}`;
  routeStops.push({
    id: uid(),
    label,
    query: null,
    lat: c.lat,
    lon: c.lon,
    clientId: c.id,
    geocodeDisplay: c.display || label,
    openTime: c.openTime,
    closeTime: c.closeTime,
    serviceMin: c.serviceMin
  });
  renderRouteStops();
  setStatus(`Se agregó a la ruta: ${label}`);
  try{ if (typeof window.renderClientMarkers === 'function') window.renderClientMarkers(); }catch(_){ }
}

function renderRouteStops(){
  const ul = document.getElementById('routeStopList');
  const empty = document.getElementById('routeEmpty');
  if (!ul) return;
  ul.innerHTML = '';
  routeStops.forEach((s, idx) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'stop-label';
    span.textContent = `${idx + 1}. ${s.label}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary btn-tiny';
    btn.textContent = 'Quitar';
    btn.onclick = () => {
      routeStops.splice(idx, 1);
      renderRouteStops();
      // Si ya había una ruta calculada, reoptimizar automáticamente
      if (currentRouteLatLngs && currentRouteLatLngs.length) setTimeout(optimizarYCrearRuta, 700);
    };
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
  if (empty) empty.style.display = routeStops.length ? 'none' : 'block';
  syncTextareaFromStops();
}

function syncTextareaFromStops(){
  const ta = document.getElementById('direcciones');
  if (!ta) return;
  ta.value = routeStops.map(s => s.query || s.label).join('\n');
}

function getStopsForRouting(){
  if (routeStops.length) return routeStops;
  const input = document.getElementById('direcciones')?.value || '';
  return input.split('\n').map(s => s.trim()).filter(Boolean).map(line => ({ id: uid(), label: line, query: line }));
}

function importarDesdeTextarea(){
  const input = document.getElementById('direcciones')?.value || '';
  const lines = input.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length){
    setStatus('No hay líneas para importar.', true);
    return;
  }
  for (const line of lines){
    routeStops.push({ id: uid(), label: line, query: line });
  }
  document.getElementById('direcciones').value = '';
  renderRouteStops();
  setStatus(`Se agregaron ${lines.length} parada(s) desde el texto.`);
}

function populateMunicipioSelect(){
  const sel = document.getElementById('wizMunicipio');
  if (!sel) return;
  sel.innerHTML = '';
  for (const m of MUNICIPIOS_ORIENTE){
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  sel.value = 'Rionegro';
}

function getWizardMunicipioLabel(){
  const sel = document.getElementById('wizMunicipio');
  const v = sel?.value || '';
  if (v === 'Otro (escribir)'){
    return (document.getElementById('wizMunicipioOtro')?.value || '').trim();
  }
  return v;
}

function wizardSetStep(n){
  document.getElementById('wizPanel1').style.display = n === 1 ? 'block' : 'none';
  document.getElementById('wizPanel2').style.display = n === 2 ? 'block' : 'none';
  document.getElementById('wizPanel3').style.display = n === 3 ? 'block' : 'none';
  document.getElementById('wizStepLabel').textContent = `Paso ${n} de 3`;
}

function wizardReset(){
  wizPreview = null;
  document.getElementById('wizLugar').value = '';
  document.getElementById('wizMunicipioOtro').value = '';
  document.getElementById('wizPreviewAddr').textContent = '';
  document.getElementById('wizClientName').value = '';
  hideWizardSuggestions();
  hideWizardNoResult();
  wizardSetStep(1);
}

function hideWizardSuggestions(){
  const box = document.getElementById('wizTypeahead');
  if (box) box.style.display = 'none';
  const list = document.getElementById('wizTypeaheadList');
  if (list) list.innerHTML = '';
  wizLastSuggestions = [];
}

function hideWizardNoResult(){
  const box = document.getElementById('wizNoResult');
  if (box) box.style.display = 'none';
  const list = document.getElementById('wizNoResultList');
  if (list) list.innerHTML = '';
}

function renderSuggestionButtons(containerId, items, onPick){
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  for (const it of items){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary';
    b.style.marginTop = '8px';
    b.style.textAlign = 'left';
    b.style.whiteSpace = 'normal';
    b.textContent = it.display_name || it.name || 'Sugerencia';
    b.onclick = () => onPick(it);
    box.appendChild(b);
  }
}

async function updateWizardTypeahead(){
  const lugar = (document.getElementById('wizLugar')?.value || '').trim();
  if (lugar.length < 3){
    hideWizardSuggestions();
    return;
  }
  const mun = wizMunicipio || getWizardMunicipioLabel() || '';
  const q = mun ? `${lugar}, ${mun}, Antioquia, Colombia` : `${lugar}, Antioquia, Colombia`;
  try{
    const items = await nominatimSearch(q, 5);
    wizLastSuggestions = items;
    const wrap = document.getElementById('wizTypeahead');
    if (!wrap) return;
    if (!items.length){
      hideWizardSuggestions();
      return;
    }
    wrap.style.display = 'block';
    renderSuggestionButtons('wizTypeaheadList', items, (it) => {
      // Selección directa: guardamos coordenadas y pasamos a confirmar, sin re-buscar texto.
      const lat = Number(it.lat), lon = Number(it.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      wizLugarText = (document.getElementById('wizLugar')?.value || '').trim() || (it.display_name || lugar);
      wizPreview = { lat, lon, display: it.display_name || q, query: it.display_name || q };
      document.getElementById('wizPreviewAddr').textContent = wizPreview.display;
      hideWizardSuggestions();
      hideWizardNoResult();
      wizardSetStep(3);
      map.panTo([lat, lon], { animate: true });
    });
  }catch(_){
    // no-op
  }
}

function wizardOpen(){
  wizardReset();
  document.getElementById('addStopWizard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function wizardClose(){
  wizardReset();
  wizardSetStep(1);
}

function initWizardUi(){
  populateMunicipioSelect();
  const sel = document.getElementById('wizMunicipio');
  const otro = document.getElementById('wizMunicipioOtro');
  sel?.addEventListener('change', () => {
    otro.style.display = sel.value === 'Otro (escribir)' ? 'block' : 'none';
  });
  document.getElementById('btnAddStopTop')?.addEventListener('click', wizardOpen);
  document.getElementById('btnManageClients')?.addEventListener('click', () => showView('clients'));
  document.getElementById('btnOpenWizard')?.addEventListener('click', wizardOpen);
  document.getElementById('wizClose')?.addEventListener('click', wizardClose);
  document.getElementById('wizTo2')?.addEventListener('click', () => {
    const mun = getWizardMunicipioLabel();
    if (!mun) { setStatus('Elegí o escribí un municipio.', true); return; }
    wizMunicipio = mun;
    wizardSetStep(2);
    document.getElementById('wizLugar').focus();
  });
  document.getElementById('wizBack2')?.addEventListener('click', () => wizardSetStep(1));
  document.getElementById('wizLugar')?.addEventListener('input', () => {
    if (wizTypeaheadTimer) clearTimeout(wizTypeaheadTimer);
    wizTypeaheadTimer = setTimeout(updateWizardTypeahead, 350);
  });
  document.getElementById('wizTo3')?.addEventListener('click', async () => {
    const lugar = (document.getElementById('wizLugar').value || '').trim();
    if (!lugar) { setStatus('Escribí un lugar o referencia.', true); return; }
    wizLugarText = lugar;
    // Si ya eligió una sugerencia (wizPreview), no volvemos a buscar; solo confirmamos y centramos.
    if (wizPreview && Number.isFinite(wizPreview.lat) && Number.isFinite(wizPreview.lon)){
      document.getElementById('wizPreviewAddr').textContent = wizPreview.display || 'Punto seleccionado';
      hideWizardNoResult();
      wizardSetStep(3);
      map.panTo([wizPreview.lat, wizPreview.lon], { animate: true });
      return;
    }
    const q = `${lugar}, ${wizMunicipio}, Antioquia, Colombia`;
    setBusy(true);
    setStatus('Buscando ubicación…');
    hideWizardNoResult();
    try{
      const g = await geocodeNominatim(q);
      wizPreview = { lat: g.lat, lon: g.lon, display: g.display, query: q };
      document.getElementById('wizPreviewAddr').textContent = g.display;
      wizardSetStep(3);
      map.panTo([g.lat, g.lon], { animate: true });
    }catch(e){
      try{
        const items = await nominatimSearch(q, 6);
        if (items.length){
          document.getElementById('wizPreviewAddr').textContent = 'No se encontró exacto. Elegí una sugerencia.';
          const box = document.getElementById('wizNoResult');
          if (box) box.style.display = 'block';
          renderSuggestionButtons('wizNoResultList', items, (it) => {
            const lat = Number(it.lat), lon = Number(it.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            wizPreview = { lat, lon, display: it.display_name || q, query: it.display_name || q };
            document.getElementById('wizPreviewAddr').textContent = wizPreview.display;
            hideWizardNoResult();
            map.panTo([lat, lon], { animate: true });
          });
          wizardSetStep(3);
        } else {
          setStatus(e?.message || String(e), true);
        }
      }catch(_){
        setStatus(e?.message || String(e), true);
      }
    }finally{
      setBusy(false);
    }
  });
  document.getElementById('wizBack3')?.addEventListener('click', () => wizardSetStep(2));
  document.getElementById('wizConfirmAdd')?.addEventListener('click', () => {
    if (!wizPreview) return;
    const label = `${wizLugarText} (${wizMunicipio})`;
    routeStops.push({
      id: uid(),
      label,
      query: wizPreview.query,
      lat: wizPreview.lat,
      lon: wizPreview.lon,
      geocodeDisplay: wizPreview.display
    });
    renderRouteStops();
    setStatus(`Parada agregada: ${label}`);
    wizardClose();
  });
  document.getElementById('wizSaveClient')?.addEventListener('click', () => {
    if (!wizPreview){
      setStatus('Primero buscá la ubicación (paso 3).', true);
      return;
    }
    const name = (document.getElementById('wizClientName').value || '').trim();
    if (!name){
      setStatus('Escribí el nombre del cliente.', true);
      return;
    }
    const c = migrateClientRow({
      id: uid(),
      name,
      municipality: wizMunicipio,
      placeDetail: wizLugarText,
      lat: wizPreview.lat,
      lon: wizPreview.lon,
      display: wizPreview.display,
      openTime: '08:00',
      closeTime: '18:00',
      serviceMin: 10
    });
    savedClients = savedClients.filter(x => (x.name + x.municipality + x.placeDetail).toLowerCase() !== (name + wizMunicipio + wizLugarText).toLowerCase());
    savedClients.unshift(c);
    persistClients();
    renderClients();
    setStatus(`Cliente guardado: ${name}`);
  });
  document.getElementById('clientSearch')?.addEventListener('input', () => renderClients());
}

function setStatus(msg, isError=false){
  const el = document.getElementById('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function setBusy(busy){
  document.getElementById('btnOptimizar').disabled = busy;
}

function updateChips(){
  const d = document.getElementById('dist').textContent;
  const t = document.getElementById('dur').textContent;
  const cd = document.getElementById('chipDist');
  const ct = document.getElementById('chipDur');
  cd.textContent = d === '—' ? '—' : d;
  ct.textContent = t === '—' ? '—' : t;
  const has = d !== '—' && t !== '—';
  cd.classList.toggle('muted', !has);
  ct.classList.toggle('muted', !has);
}

function setGpsPill(text, ok){
  const el = document.getElementById('gpsPill');
  el.textContent = text;
  el.style.borderColor = ok ? 'rgba(34,197,94,.45)' : 'rgba(148,163,184,.35)';
  el.style.background = ok ? 'rgba(34,197,94,.12)' : 'rgba(255,255,255,.06)';
  el.style.color = ok ? '#86efac' : 'var(--muted)';
}

function refreshPlayButtons(){
  const t = document.getElementById('btnPlay').textContent;
  document.getElementById('btnPlayPeek').textContent = t;
}

function updateUserFromPosition(pos){
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const acc = pos.coords.accuracy;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  userLocation = { lat, lon, accuracy: acc };
  const ll = [lat, lon];
  if (!userMarker){
    userMarker = L.marker(ll, { icon: userDotIcon, zIndexOffset: 1000 }).addTo(map);
  } else {
    userMarker.setLatLng(ll);
  }
  if (Number.isFinite(acc) && acc > 5){
    if (!userAccuracyCircle){
      userAccuracyCircle = L.circle(ll, {
        radius: acc,
        color: '#38bdf8',
        weight: 1,
        fillColor: '#38bdf8',
        fillOpacity: 0.12
      }).addTo(map);
    } else {
      userAccuracyCircle.setLatLng(ll);
      userAccuracyCircle.setRadius(acc);
    }
  }

  // Solo seguir si el usuario activó "seguir" (botón ubicación) y si realmente se movió.
  if (followUser){
    const movedM = lastFollowUserPan ? haversineMeters(lastFollowUserPan, ll) : Infinity;
    if (movedM >= 10){
      map.panTo(ll, { animate: false });
      lastFollowUserPan = ll;
    }
  }

  // Navegación real: el "carro" es tu GPS en tiempo real.
  if (navigationActive && vehicleMarker){
    vehicleMarker.setLatLng(ll);
    applyVehicleHeading(ll);
    if (document.getElementById('followVehicle').checked){
      const movedM = lastFollowVehiclePan ? haversineMeters(lastFollowVehiclePan, ll) : Infinity;
      if (movedM >= 10){
        map.panTo(ll, { animate: false });
        lastFollowVehiclePan = ll;
      }
    }
  }
  // Reoptimización si te desviás de la ruta (comprobación ligera)
  try{ if (typeof maybeReoptimizeOnDeviation === 'function') maybeReoptimizeOnDeviation(); }catch(e){}
}

function startLocationWatch(){
  if (!navigator.geolocation){
    setGpsPill('GPS no disponible', false);
    setStatus('Tu navegador no soporta geolocalización.', true);
    return;
  }
  if (geoWatchId != null) return;
  setGpsPill('Buscando señal…', false);
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      updateUserFromPosition(pos);
      setGpsPill('GPS activo', true);
      document.getElementById('btnLocate').classList.add('fab--active');
    },
    (err) => {
      setGpsPill(err.code === 1 ? 'Permiso denegado' : 'Sin señal GPS', false);
      setStatus(err.code === 1 ? 'Activa el permiso de ubicación en el navegador.' : ('GPS: ' + (err.message || 'error')), true);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 25000 }
  );
}

function ensureUserLocationOnce(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation){
      reject(new Error('Geolocalización no disponible.'));
      return;
    }
    if (userLocation){
      resolve();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updateUserFromPosition(pos);
        setGpsPill('GPS activo', true);
        document.getElementById('btnLocate').classList.add('fab--active');
        if (geoWatchId == null) startLocationWatch();
        resolve();
      },
      (err) => reject(new Error(err.code === 1 ? 'Permiso de ubicación denegado.' : 'No se pudo obtener tu posición.')),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  });
}

document.getElementById('btnLocate').addEventListener('click', () => {
  if (geoWatchId == null){
    startLocationWatch();
    followUser = true;
    if (userLocation){
      lastFollowUserPan = [userLocation.lat, userLocation.lon];
      map.flyTo([userLocation.lat, userLocation.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
    }
    return;
  }
  if (userLocation){
    followUser = true;
    lastFollowUserPan = [userLocation.lat, userLocation.lon];
    map.flyTo([userLocation.lat, userLocation.lon], Math.max(map.getZoom(), 16), { duration: 0.55 });
  } else {
    setStatus('Esperando señal GPS…');
  }
});

// Si el usuario arrastra/zoomea el mapa, dejamos de seguir automáticamente (como Waze).
map.on('dragstart zoomstart', () => { followUser = false; });

(function sheetUi(){
  const sheet = document.getElementById('bottomSheet');
  const handle = document.getElementById('sheetHandle');
  function toggle(){
    sheet.classList.toggle('sheet--collapsed');
    const collapsed = sheet.classList.contains('sheet--collapsed');
    handle.setAttribute('aria-expanded', String(!collapsed));
    setTimeout(() => map.invalidateSize(), 280);
  }
  handle.addEventListener('click', toggle);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
})();

function actualizarVelocidadUI(){
  const kmh = Number(document.getElementById('speed').value);
  document.getElementById('speedLabel').textContent = `${kmh} km/h`;
}
actualizarVelocidadUI();

function setAnimLabel(t){ document.getElementById('animLabel').textContent = t; }

function fmtDistance(m){
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m/1000).toFixed(2)} km`;
}
function fmtDuration(s){
  if (!Number.isFinite(s)) return '—';
  const mins = Math.round(s/60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins/60);
  const mm = mins % 60;
  return `${h} h ${mm} min`;
}

function limpiarMapa(){
  if(routeLineHalo){ map.removeLayer(routeLineHalo); routeLineHalo = null; }
  if(routeLine){ map.removeLayer(routeLine); routeLine = null; }
  for (const m of stopMarkers) map.removeLayer(m);
  stopMarkers = [];
  if(vehicleMarker){ map.removeLayer(vehicleMarker); vehicleMarker = null; }
  currentRouteLatLngs = [];
  currentStats = { distanceM: 0, durationS: 0 };
  lastVehicleLatLng = null;
  lastFollowVehiclePan = null;
}

function limpiarTodo(){
  stopAnim(true);
  limpiarMapa();
  routeStops = [];
  renderRouteStops();
  document.getElementById('orden').innerHTML = '';
  document.getElementById('nStops').textContent = '0';
  document.getElementById('dist').textContent = '—';
  document.getElementById('dur').textContent = '—';
  const et = document.getElementById('etaTotal');
  if (et) et.textContent = '—';
  const pill = document.getElementById('optPill');
  if (pill){ pill.textContent = 'Optimizado'; pill.style.borderColor = ''; }
  document.getElementById('btnPlay').disabled = true;
  document.getElementById('btnPlayPeek').disabled = true;
  navigationActive = false;
  document.getElementById('btnPlay').textContent = 'Navegar (GPS)';
  document.getElementById('btnPlayPeek').textContent = 'Navegar (GPS)';
  setAnimLabel('Lista');
  setStatus('');
  updateChips();
  refreshPlayButtons();
}

function usarEjemplo(){
  document.getElementById('useGpsStart').checked = true;
  routeStops = [
    { id: uid(), label: 'Parque de El Poblado (Medellín)', query: 'Parque de El Poblado, Medellín, Colombia' },
    { id: uid(), label: 'Plaza Botero (Medellín)', query: 'Plaza Botero, Medellín, Colombia' },
    { id: uid(), label: 'Estación San Antonio (Medellín)', query: 'Estación San Antonio, Medellín, Colombia' },
    { id: uid(), label: 'Aeropuerto Olaya Herrera (Medellín)', query: 'Aeropuerto Olaya Herrera, Medellín, Colombia' }
  ];
  renderRouteStops();
  setStatus('Ejemplo cargado: cuatro paradas en Medellín.');
}

// =====================================================================================
// Logística: vistas, rutas por día, ajustes, CRM, ETA y ventanas de horario (comentado)
// =====================================================================================

function showView(name){
  document.getElementById('viewMain')?.classList.toggle('view--active', name === 'main');
  document.getElementById('viewClients')?.classList.toggle('view--active', name === 'clients');
  document.getElementById('viewWeekly')?.classList.toggle('view--active', name === 'weekly');
  document.querySelectorAll('.app-tabs button').forEach(b => {
    b.classList.toggle('tab--active', b.dataset.view === name);
  });
  if (name === 'weekly') renderWeekPanel();
  if (name === 'clients') renderClients();
}

function getTodayWeekKey(){
  const d = new Date().getDay();
  const row = WEEK_DAYS.find(x => x.js === d);
  return row ? row.key : null;
}

function loadSettings(){
  try{
    const r = localStorage.getItem(LS_SETTINGS);
    return r ? JSON.parse(r) : { autoRoute: true, autoNotify: true };
  }catch(_){
    return { autoRoute: true, autoNotify: true };
  }
}

function saveSettings(s){
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

function persistSettingsFromUi(){
  const s = {
    autoRoute: !!document.getElementById('settingAutoRoute')?.checked,
    autoNotify: !!document.getElementById('settingAutoNotify')?.checked
  };
  saveSettings(s);
}

function loadWeekPlan(){
  try{
    const r = localStorage.getItem(LS_ROUTES_WEEK);
    const o = r ? JSON.parse(r) : {};
    return o && typeof o === 'object' ? o : {};
  }catch(_){
    return {};
  }
}

function saveWeekPlan(plan){
  localStorage.setItem(LS_ROUTES_WEEK, JSON.stringify(plan));
}

function normalizeStopRef(s){
  if (!s) return null;
  if (s.clientId) return { clientId: s.clientId };
  return {
    id: s.id,
    label: s.label,
    query: s.query || null,
    lat: s.lat,
    lon: s.lon,
    geocodeDisplay: s.geocodeDisplay || null,
    openTime: s.openTime,
    closeTime: s.closeTime,
    serviceMin: s.serviceMin,
    clientId: s.clientId || null
  };
}

function expandStopRef(ref){
  if (!ref) return null;
  if (ref.clientId){
    const c = savedClients.find(x => x.id === ref.clientId);
    if (!c) return null;
    return {
      id: uid(),
      label: `${c.name} — ${c.placeDetail}, ${c.municipality}`,
      query: null,
      lat: c.lat,
      lon: c.lon,
      clientId: c.id,
      geocodeDisplay: c.display || c.name,
      openTime: c.openTime,
      closeTime: c.closeTime,
      serviceMin: c.serviceMin
    };
  }
  return {
    id: ref.id || uid(),
    label: ref.label,
    query: ref.query || null,
    lat: ref.lat,
    lon: ref.lon,
    clientId: ref.clientId || null,
    geocodeDisplay: ref.geocodeDisplay || ref.label,
    openTime: ref.openTime,
    closeTime: ref.closeTime,
    serviceMin: ref.serviceMin
  };
}

function initTabsUi(){
  document.querySelectorAll('.app-tabs button').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view || 'main'));
  });
  document.getElementById('tabMain')?.addEventListener('click', () => showView('main'));
}

function initWeekUi(){
  const box = document.getElementById('weekDayButtons');
  if (!box) return;
  box.innerHTML = '';
  for (const d of WEEK_DAYS){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary' + (d.key === selectedWeekKey ? ' day--active' : '');
    b.textContent = d.label;
    b.onclick = () => {
      selectedWeekKey = d.key;
      Array.from(box.querySelectorAll('button')).forEach(x => x.classList.remove('day--active'));
      b.classList.add('day--active');
      renderWeekPanel();
    };
    box.appendChild(b);
  }
  document.getElementById('btnWeekLoadToRoute')?.addEventListener('click', () => {
    const plan = loadWeekPlan();
    const refs = plan[selectedWeekKey]?.stops || [];
    const expanded = refs.map(expandStopRef).filter(Boolean);
    if (!expanded.length){
      setStatus('No hay paradas guardadas para este día.', true);
      return;
    }
    routeStops = expanded;
    renderRouteStops();
    showView('main');
    setStatus(`Ruta cargada (${selectedWeekKey}).`);
  });
  document.getElementById('btnWeekSaveFromRoute')?.addEventListener('click', () => {
    const plan = loadWeekPlan();
    plan[selectedWeekKey] = { stops: routeStops.map(normalizeStopRef).filter(Boolean) };
    saveWeekPlan(plan);
    setStatus(`Guardado el plan de ${selectedWeekKey}.`);
    renderWeekPanel();
  });
  document.getElementById('settingAutoRoute')?.addEventListener('change', persistSettingsFromUi);
  document.getElementById('settingAutoNotify')?.addEventListener('change', persistSettingsFromUi);
}

function renderWeekPanel(){
  const d = WEEK_DAYS.find(x => x.key === selectedWeekKey);
  document.getElementById('weekDayLabel').textContent = d ? d.long : selectedWeekKey;
  const plan = loadWeekPlan();
  const refs = plan[selectedWeekKey]?.stops || [];
  const ul = document.getElementById('weekStopsList');
  const empty = document.getElementById('weekEmpty');
  if (!ul) return;
  ul.innerHTML = '';
  if (!refs.length){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  refs.forEach((r, i) => {
    const li = document.createElement('li');
    const ex = expandStopRef(r);
    li.innerHTML = `<span class="stop-label">${i + 1}. ${escapeHtml(ex ? ex.label : (r.clientId || 'Ref inválida'))}</span>`;
    ul.appendChild(li);
  });
}

function parseHHMM(s){
  const p = String(s || '00:00').trim().split(':');
  const h = Number(p[0]), m = Number(p[1] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function departureDateTimeMs(){
  const v = document.getElementById('departureTime')?.value || '08:00';
  const [hh, mm] = v.split(':').map(Number);
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function dayStartMs(ms){
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function minutesSinceMidnight(ms){
  return Math.floor((ms - dayStartMs(ms)) / 60000);
}

function fmtClockFromMs(ms){
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function buildMetaList(geocodedLen, stopsInput, useGps){
  const metas = [];
  for (let i = 0; i < geocodedLen; i++){
    if (useGps && i === 0){
      metas.push({ skipWindows: true, openMin: 0, closeMin: 24 * 60, serviceMin: 0 });
      continue;
    }
    const st = useGps ? stopsInput[i - 1] : stopsInput[i];
    const c = st?.clientId ? savedClients.find(x => x.id === st.clientId) : null;
    const openT = c?.openTime || st?.openTime || '08:00';
    const closeT = c?.closeTime || st?.closeTime || '22:00';
    const svc = Number(c?.serviceMin ?? st?.serviceMin ?? 10);
    metas.push({
      skipWindows: false,
      openMin: parseHHMM(openT),
      closeMin: parseHHMM(closeT),
      serviceMin: Math.max(0, Number.isFinite(svc) ? svc : 10)
    });
  }
  return metas;
}

/**
 * Simula llegadas con ventanas: no atender antes de apertura (espera),
 * marca violación si llegás después del cierre, suma tiempo de atención.
 */
function simulateSchedule(orderIdx, durMatrix, metas, departMs){
  let cur = departMs;
  const events = [];
  let violations = 0;
  for (let k = 0; k < orderIdx.length; k++){
    const i = orderIdx[k];
    if (k > 0){
      const prev = orderIdx[k - 1];
      const legSec = durMatrix[prev][i];
      if (!Number.isFinite(legSec)) return { events, endMs: Infinity, violations: 9999, score: Infinity };
      cur += legSec * 1000;
    }
    const arrivalMs = cur;
    const m = metas[i];
    let waitMs = 0;
    let closed = false;
    if (m && !m.skipWindows){
      let arrMin = minutesSinceMidnight(arrivalMs);
      if (arrMin < m.openMin){
        waitMs = (m.openMin - arrMin) * 60000;
        cur += waitMs;
      }
      arrMin = minutesSinceMidnight(cur);
      if (arrMin > m.closeMin) closed = true;
    }
    if (m && !m.skipWindows){
      cur += (m.serviceMin || 0) * 60000;
    }
    if (closed) violations++;
    events.push({ idx: i, arrivalMs, waitMs, closed, serviceMin: m?.serviceMin || 0 });
  }
  const endMs = cur;
  const score = violations * 1e15 + endMs;
  return { events, endMs, violations, score };
}

function pickBestOrderWithWindows(geocoded, stopsInput, useGps, distMatrix, durMatrix){
  const n = geocoded.length;
  const startIdx = 0;
  const endIdx = n - 1;
  const metas = buildMetaList(n, stopsInput, useGps);
  const mids = [];
  for (let i = 0; i < n; i++){
    if (i !== startIdx && i !== endIdx) mids.push(i);
  }
  const departMs = departureDateTimeMs();
  const candidates = [];
  const pushUniq = (ord) => {
    const s = ord.join(',');
    if (!candidates.some(o => o.join(',') === s)) candidates.push(ord);
  };
  try{ pushUniq(computeOptimalOrderHeldKarp(distMatrix, startIdx, endIdx)); }catch(_){ }
  try{ pushUniq(computeOptimalOrderHeldKarp(durMatrix, startIdx, endIdx)); }catch(_){ }
  if (mids.length){
    const deadline = [startIdx, ...[...mids].sort((a, b) => metas[a].closeMin - metas[b].closeMin), endIdx];
    pushUniq(deadline);
  }
  let best = null;
  for (const ord of candidates){
    const sim = simulateSchedule(ord, durMatrix, metas, departMs);
    if (!best || sim.score < best.sim.score) best = { order: ord, sim };
  }
  if (!best){
    const ord = Array.from({ length: n }, (_, i) => i);
    best = { order: ord, sim: simulateSchedule(ord, durMatrix, metas, departMs) };
  }
  return { order: best.order, sim: best.sim, metas };
}

function crmClearForm(){
  document.getElementById('crmEditId').value = '';
  document.getElementById('crmName').value = '';
  document.getElementById('crmMunicipio').value = '';
  document.getElementById('crmRef').value = '';
  document.getElementById('crmLat').value = '';
  document.getElementById('crmLon').value = '';
  document.getElementById('crmOpen').value = '08:00';
  document.getElementById('crmClose').value = '18:00';
  document.getElementById('crmService').value = '10';
  document.getElementById('crmPriority').value = 'low';
  document.getElementById('crmAmount').value = '0';
  document.getElementById('crmPaid').value = 'false';
  document.getElementById('crmLunchStart').value = '12:00';
  document.getElementById('crmLunchEnd').value = '13:00';
  document.getElementById('crmGeoResult').textContent = '';
}

function crmLoadClient(c){
  document.getElementById('crmEditId').value = c.id;
  document.getElementById('crmName').value = c.name;
  document.getElementById('crmMunicipio').value = c.municipality || '';
  document.getElementById('crmRef').value = c.placeDetail || '';
  document.getElementById('crmLat').value = String(c.lat);
  document.getElementById('crmLon').value = String(c.lon);
  document.getElementById('crmOpen').value = c.openTime || '08:00';
  document.getElementById('crmClose').value = c.closeTime || '18:00';
  document.getElementById('crmService').value = String(c.serviceMin ?? 10);
  document.getElementById('crmPriority').value = c.priority || 'low';
  document.getElementById('crmAmount').value = Number.isFinite(Number(c.amount)) ? String(Number(c.amount)) : '0';
  document.getElementById('crmPaid').value = c.paid ? 'true' : 'false';
  document.getElementById('crmLunchStart').value = c.lunchStart || '12:00';
  document.getElementById('crmLunchEnd').value = c.lunchEnd || '13:00';
  document.getElementById('crmGeoResult').textContent = c.display ? `Ubicación: ${c.display}` : 'Coordenadas cargadas.';
}

function initCrmUi(){
  document.getElementById('crmClearForm')?.addEventListener('click', crmClearForm);
  document.getElementById('crmGeocode')?.addEventListener('click', async () => {
    const mun = (document.getElementById('crmMunicipio').value || '').trim();
    const ref = (document.getElementById('crmRef').value || '').trim();
    if (!mun || !ref){
      setStatus('Completá municipio y referencia para ubicar.', true);
      return;
    }
    const q = `${ref}, ${mun}, Antioquia, Colombia`;
    try{
      const g = await geocodeNominatim(q);
      document.getElementById('crmLat').value = String(g.lat);
      document.getElementById('crmLon').value = String(g.lon);
      document.getElementById('crmGeoResult').textContent = g.display;
    }catch(e){
      setStatus(e?.message || String(e), true);
    }
  });
  document.getElementById('crmSave')?.addEventListener('click', () => {
    const lat = Number(document.getElementById('crmLat').value);
    const lon = Number(document.getElementById('crmLon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)){
      setStatus('Ubicá el cliente con «Ubicar en mapa» antes de guardar.', true);
      return;
    }
    const c = {
      id: document.getElementById('crmEditId').value || uid(),
      name: (document.getElementById('crmName').value || '').trim(),
      municipality: (document.getElementById('crmMunicipio').value || '').trim(),
      placeDetail: (document.getElementById('crmRef').value || '').trim(),
      lat, lon,
      display: document.getElementById('crmGeoResult').textContent || '',
      openTime: document.getElementById('crmOpen').value || '08:00',
      closeTime: document.getElementById('crmClose').value || '18:00',
      lunchStart: document.getElementById('crmLunchStart').value || '12:00',
      lunchEnd: document.getElementById('crmLunchEnd').value || '13:00',
      priority: document.getElementById('crmPriority').value || 'low',
      amount: Number(document.getElementById('crmAmount').value) || 0,
      paid: (document.getElementById('crmPaid').value === 'true'),
      orderState: 'Pendiente',
      serviceMin: Math.max(0, Number(document.getElementById('crmService').value) || 0)
    };
    if (!c.name || !c.municipality || !c.placeDetail){
      setStatus('Nombre, municipio y referencia son obligatorios.', true);
      return;
    }
    savedClients = savedClients.filter(x => x.id !== c.id);
    savedClients.unshift(migrateClientRow(c));
    persistClients();
    renderClients();
    crmClearForm();
    try{ if (typeof window.renderClientMarkers === 'function') window.renderClientMarkers(); }catch(_){ }
    try{ updateFinancialSummary(); }catch(_){ }
    setStatus('Cliente guardado.');
  });
}

function maybeVehicleNotification(){
  const st = loadSettings();
  if (!st.autoNotify) return;
  if (!('Notification' in window)) return;
  const today = new Date().toDateString();
  if (localStorage.getItem(LS_LAST_VEHICLE_NOTIF) === today) return;
  if (Notification.permission !== 'granted') return;
  try{
    new Notification('Revisión del vehículo', { body: 'Recuerda realizar la revisión completa del vehículo.' });
    localStorage.setItem(LS_LAST_VEHICLE_NOTIF, today);
  }catch(_){ }
}

function initVehicleNotifyUi(){
  document.getElementById('btnNotifyVehicle')?.addEventListener('click', async () => {
    if (!('Notification' in window)){
      setStatus('Este navegador no soporta notificaciones.', true);
      return;
    }
    const p = await Notification.requestPermission();
    if (p !== 'granted'){
      setStatus('Permiso de notificaciones denegado.', true);
      return;
    }
    localStorage.removeItem(LS_LAST_VEHICLE_NOTIF);
    maybeVehicleNotification();
    setStatus('Recordatorio activado (una vez por día al abrir la app).');
  });
}

async function tryAutoRouteForToday(){
  const st = loadSettings();
  if (!st.autoRoute) return;
  const key = getTodayWeekKey();
  if (!key) return;
  selectedWeekKey = key;
  const plan = loadWeekPlan();
  const refs = plan[key]?.stops || [];
  const expanded = refs.map(expandStopRef).filter(Boolean);
  if (!expanded.length) return;
  routeStops = expanded;
  renderRouteStops();
  await optimizarYCrearRuta();
}

// -----------------------
// Geocodificación (Nominatim)
// -----------------------
async function nominatimSearch(q, limit=5){
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if(!res.ok) throw new Error(`Búsqueda falló (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function geocodeNominatim(q){
  const data = await nominatimSearch(q, 1);
  if(!data.length) throw new Error(`No se encontró: ${q}`);
  const lat = Number(data[0].lat);
  const lon = Number(data[0].lon);
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`Coordenadas inválidas: ${q}`);
  return { lat, lon, display: data[0].display_name || q };
}

// -----------------------
// OSRM Trip (optimiza el orden) + Route stats
// -----------------------
async function osrmTableMatrices(coordsLonLat){
  const coordStr = coordsLonLat.map(c => `${c.lon},${c.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=distance,duration`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`OSRM Table falló (${res.status})`);
  const data = await res.json();
  if(data.code !== 'Ok') throw new Error(`OSRM Table: ${data.message || data.code}`);
  const dist = data.distances;
  const dur = data.durations;
  if(!Array.isArray(dist) || !Array.isArray(dist[0])) throw new Error('OSRM Table no devolvió distancias');
  if(!Array.isArray(dur) || !Array.isArray(dur[0])) throw new Error('OSRM Table no devolvió duraciones');
  return { dist, dur };
}

/** TSP Held–Karp: orden óptimo visitando intermedios, con inicio y fin fijos (costMatrix en metros o segundos). */
function computeOptimalOrderHeldKarp(costMatrix, startIdx, endIdx){
  const n = costMatrix.length;
  const nodes = [];
  for (let i=0;i<n;i++){
    if (i !== startIdx && i !== endIdx) nodes.push(i);
  }
  const m = nodes.length;
  if (m === 0) return [startIdx, endIdx];
  if (m > 12) throw new Error('Demasiadas paradas intermedias para optimización exacta (>12).');

  const size = 1 << m;
  const dpCost = Array.from({ length: size }, () => Array(m).fill(Infinity));
  const dpPrev = Array.from({ length: size }, () => Array(m).fill(-1));

  for (let j=0;j<m;j++){
    const node = nodes[j];
    const v = costMatrix[startIdx][node];
    dpCost[1<<j][j] = Number.isFinite(v) ? v : Infinity;
  }

  for (let mask=1; mask<size; mask++){
    for (let j=0;j<m;j++){
      if (!(mask & (1<<j))) continue;
      const prevMask = mask ^ (1<<j);
      if (prevMask === 0) continue;
      const jNode = nodes[j];
      let best = dpCost[mask][j];
      let bestPrev = dpPrev[mask][j];
      for (let k=0;k<m;k++){
        if (!(prevMask & (1<<k))) continue;
        const kNode = nodes[k];
        const w = costMatrix[kNode][jNode];
        const cand = dpCost[prevMask][k] + (Number.isFinite(w) ? w : Infinity);
        if (cand < best){
          best = cand;
          bestPrev = k;
        }
      }
      dpCost[mask][j] = best;
      dpPrev[mask][j] = bestPrev;
    }
  }

  const full = size - 1;
  let bestEndCost = Infinity;
  let bestLast = -1;
  for (let j=0;j<m;j++){
    const jNode = nodes[j];
    const w = costMatrix[jNode][endIdx];
    const cand = dpCost[full][j] + (Number.isFinite(w) ? w : Infinity);
    if (cand < bestEndCost){
      bestEndCost = cand;
      bestLast = j;
    }
  }

  let mask = full;
  const seq = [];
  let cur = bestLast;
  while (cur !== -1){
    seq.push(nodes[cur]);
    const prev = dpPrev[mask][cur];
    mask = mask ^ (1<<cur);
    cur = prev;
  }
  seq.reverse();
  return [startIdx, ...seq, endIdx];
}

async function osrmRouteFull(coordsLonLat){
  const coordStr = coordsLonLat.map(c => `${c.lon},${c.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson&steps=false&alternatives=false`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`OSRM Route falló (${res.status})`);
  const data = await res.json();
  if(data.code !== 'Ok') throw new Error(`OSRM Route: ${data.message || data.code}`);
  const r = data.routes?.[0];
  if(!r?.geometry?.coordinates) throw new Error('OSRM Route no devolvió geometría');
  return { coords: r.geometry.coordinates, distanceM: r.distance ?? 0, durationS: r.duration ?? 0, legs: r.legs || [] };
}

// -----------------------
// UI principal
// -----------------------
async function optimizarYCrearRuta(){
  stopAnim(true);
  setBusy(true);
  setStatus('');
  document.getElementById('btnPlay').disabled = true;
  document.getElementById('btnPlayPeek').disabled = true;
  document.getElementById('btnPlay').textContent = 'Navegar (GPS)';
  refreshPlayButtons();
  setAnimLabel('Calculando…');
  document.getElementById('etaTotal').textContent = '—';

  try{
    const useGps = document.getElementById('useGpsStart').checked;
    const stopsInput = getStopsForRouting();
    // Filtrar clientes no disponibles: almuerzo o cerrados. Avisar al usuario.
    const nowMin = minutesSinceMidnight(Date.now());
    const filtered = [];
    const skipped = [];
    for (const st of stopsInput){
      if (st.clientId){
        const c = savedClients.find(x => x.id === st.clientId);
        if (c){
          const lunchS = parseHHMM(c.lunchStart || '99:99');
          const lunchE = parseHHMM(c.lunchEnd || '99:99');
          const open = parseHHMM(c.openTime || '00:00');
          const close = parseHHMM(c.closeTime || '23:59');
          if (nowMin >= lunchS && nowMin < lunchE){ skipped.push({st,c,reason:'almuerzo'}); continue; }
          if (nowMin < open || nowMin > close){ skipped.push({st,c,reason:'cerrado'}); continue; }
        }
      }
      filtered.push(st);
    }
    if (skipped.length){
      for (const s of skipped){
        setStatus(`Se omitió ${s.c?.name || s.st.label}: ${s.reason}`, true);
      }
    }
    if (useGps){
      if (stopsInput.length < 1) throw new Error('Agregá al menos una parada (o desactivá “Inicio en mi ubicación” y pon dos).');
      if (stopsInput.length > 11) throw new Error('Máximo 11 paradas con GPS como inicio.');
    } else {
      if (stopsInput.length < 2) throw new Error('Agregá al menos dos paradas, o activá “Inicio en mi ubicación”.');
      if (stopsInput.length > 12) throw new Error('Máximo 12 paradas.');
    }

    limpiarMapa();
    document.getElementById('orden').innerHTML = '';
    document.getElementById('nStops').textContent = '—';
    document.getElementById('dist').textContent = '—';
    document.getElementById('dur').textContent = '—';
    updateChips();

    let geocoded = [];
    if (useGps){
      setStatus('Obteniendo tu ubicación…');
      await ensureUserLocationOnce();
      if (!userLocation) throw new Error('No hay ubicación GPS.');
      geocoded.push({
        lat: userLocation.lat,
        lon: userLocation.lon,
        display: 'Mi ubicación actual'
      });
      if (userMarker) map.panTo(userMarker.getLatLng(), { animate: true });
    }

    setStatus('Buscando direcciones…');
    // Ordenar por prioridad y distancia antes de geocodificar
    let stopsToProcess = filtered.slice();
    try{
      const userLoc = userLocation || null;
      if (typeof sortClientsForRouting === 'function'){
        // si la parada referencia un cliente, reordenar según cliente
        stopsToProcess.sort((a,b)=>{
          const ca = a.clientId ? savedClients.find(x=>x.id===a.clientId) : null;
          const cb = b.clientId ? savedClients.find(x=>x.id===b.clientId) : null;
          if (ca && cb){
            return sortClientsForRouting([ca,cb], userLoc).indexOf(ca) - sortClientsForRouting([ca,cb], userLoc).indexOf(cb);
          }
          return 0;
        });
      }
    }catch(_){ }
    for (let i=0;i<stopsToProcess.length;i++){
      const st = stopsToProcess[i];
      setStatus(`Parada ${i+1}/${stopsInput.length}…\n${st.label}`);
      if(i>0 || geocoded.length>0) await new Promise(r => setTimeout(r, 350));
      if (Number.isFinite(st.lat) && Number.isFinite(st.lon)){
        geocoded.push({
          lat: st.lat,
          lon: st.lon,
          display: st.geocodeDisplay || st.label
        });
      } else {
        const q = st.query || st.label;
        geocoded.push(await geocodeNominatim(q));
      }
    }

    if (!geocoded.length) throw new Error('No hay paradas disponibles para calcular la ruta.');

    document.getElementById('nStops').textContent = String(geocoded.length);

    setStatus('Optimizando orden (distancia + horarios)…');
    const { dist, dur } = await osrmTableMatrices(geocoded);
    const { order, sim } = pickBestOrderWithWindows(geocoded, stopsInput, useGps, dist, dur);
    const orderedStops = order.map(i => ({
      lat: geocoded[i].lat,
      lon: geocoded[i].lon,
      label: geocoded[i].display || (useGps && i > 0 ? stopsInput[i - 1]?.label : stopsInput[i]?.label) || `Parada ${i + 1}`
    }));

    const departMs = departureDateTimeMs();
    const ol = document.getElementById('orden');
    ol.innerHTML = '';
    for (let k = 0; k < orderedStops.length; k++){
      const li = document.createElement('li');
      const ev = sim.events[k];
      const lab = document.createElement('div');
      lab.textContent = `${k + 1}. ${orderedStops[k].label}`;
      li.appendChild(lab);
      if (k === 0){
        const eta = document.createElement('div');
        eta.className = 'eta-line';
        eta.textContent = `Salida ~ ${fmtClockFromMs(departMs)}`;
        li.appendChild(eta);
      } else if (ev){
        const eta = document.createElement('div');
        eta.className = 'eta-line';
        const waitMin = Math.round((ev.waitMs || 0) / 60000);
        const parts = [`Llegada ~ ${fmtClockFromMs(ev.arrivalMs)}`];
        if (waitMin > 0) parts.push(`espera ${waitMin} min`);
        if (ev.closed) parts.push('⚠ cerrado a esa hora');
        eta.innerHTML = parts.join(' · ') + (ev.closed ? ' <span class="eta-warn">(revisá horario)</span>' : '');
        li.appendChild(eta);
      }
      ol.appendChild(li);
    }
    const totalEtaSec = Math.max(0, (sim.endMs - departMs) / 1000);
    document.getElementById('etaTotal').textContent = fmtDuration(totalEtaSec);
    const pill = document.getElementById('optPill');
    if (pill){
      pill.textContent = sim.violations ? 'Con alertas' : 'Optimizado';
      pill.style.borderColor = sim.violations ? 'rgba(251,191,36,.45)' : '';
    }

    setStatus('Trazando ruta más corta…');
    const route = await osrmRouteFull(orderedStops);
    currentRouteLatLngs = route.coords.map(c => [c[1], c[0]]);

    routeLineHalo = L.polyline(currentRouteLatLngs, {
      color: 'rgba(255,255,255,0.22)',
      weight: 14,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
    routeLine = L.polyline(currentRouteLatLngs, {
      color: '#00c8ff',
      weight: 7,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50], maxZoom: 17 });

    // Marcadores de paradas
    for (let i=0;i<orderedStops.length;i++){
      const s = orderedStops[i];
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: i===0 ? '#22c55e' : (i===orderedStops.length-1 ? '#ef4444' : '#60a5fa'),
        weight: 2,
        fillColor: '#0b1020',
        fillOpacity: 0.9
      }).addTo(map).bindPopup(`<b>${i+1}.</b> ${escapeHtml(s.label)}`);
      stopMarkers.push(m);
    }

    // Stats (distancia/duración) del route
    currentStats = { distanceM: route.distanceM, durationS: route.durationS };
    document.getElementById('dist').textContent = fmtDistance(route.distanceM);
    document.getElementById('dur').textContent = fmtDuration(route.durationS);
    updateChips();

    // Vehículo: no se mueve solo; se moverá con tu GPS cuando actives Navegar.
    if (!vehicleMarker){
      vehicleMarker = L.marker(currentRouteLatLngs[0], { icon: carIcon, zIndexOffset: 500 }).addTo(map);
    } else {
      vehicleMarker.setLatLng(currentRouteLatLngs[0]);
    }
    lastVehicleLatLng = currentRouteLatLngs[0];

    document.getElementById('btnPlay').disabled = false;
    document.getElementById('btnPlayPeek').disabled = false;
    setAnimLabel('Lista');
    setStatus('Listo. Toca Navegar para seguir tu GPS en tiempo real.');
    refreshPlayButtons();
  }catch(e){
    setAnimLabel('Error');
    setStatus(e?.message || String(e), true);
  }finally{
    setBusy(false);
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}

// -----------------------
// Animación del vehículo (distancia -> tiempo)
// -----------------------
function haversineMeters(a, b){
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const lat1 = toRad(a[0]), lon1 = toRad(a[1]);
  const lat2 = toRad(b[0]), lon2 = toRad(b[1]);
  const dLat = lat2-lat1, dLon = lon2-lon1;
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function buildCumulative(route){
  const cum = [0];
  for(let i=1;i<route.length;i++){
    cum.push(cum[i-1] + haversineMeters(route[i-1], route[i]));
  }
  return cum;
}

function interpolateOnRoute(route, cum, distM){
  if(distM <= 0) return route[0];
  const total = cum[cum.length-1];
  if(distM >= total) return route[route.length-1];
  // búsqueda lineal simple (suficiente para pocas coords). Si crece, se puede binarizar.
  let i=1;
  while(i<cum.length && cum[i] < distM) i++;
  const d0 = cum[i-1], d1 = cum[i];
  const t = (distM - d0) / Math.max(1e-6, (d1 - d0));
  const a = route[i-1], b = route[i];
  return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t];
}

async function toggleAnim(){
  // "Navegar" ahora significa: seguir tu GPS en tiempo real (sin simulación).
  if(!vehicleMarker) return;
  if (!navigationActive){
    try{
      setStatus('Activando navegación (GPS)…');
      await ensureUserLocationOnce();
      startLocationWatch();
      navigationActive = true;
      document.getElementById('btnPlay').textContent = 'Detener navegación';
      document.getElementById('btnPlayPeek').textContent = 'Detener navegación';
      setAnimLabel('GPS en vivo');
      if (userLocation){
        const ll = [userLocation.lat, userLocation.lon];
        vehicleMarker.setLatLng(ll);
        applyVehicleHeading(ll);
        lastFollowVehiclePan = ll;
        map.flyTo(ll, Math.max(map.getZoom(), 16), { duration: 0.45 });
      }
      setStatus('Navegación activa. El carro se mueve con tu GPS.');
    }catch(e){
      setStatus(e?.message || String(e), true);
    }
    return;
  }

  navigationActive = false;
  document.getElementById('btnPlay').textContent = 'Navegar (GPS)';
  document.getElementById('btnPlayPeek').textContent = 'Navegar (GPS)';
  setAnimLabel('Lista');
  setStatus('Navegación detenida.');
}

function bearingDeg(lat1, lon1, lat2, lon2){
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function applyVehicleHeading(p){
  if (!vehicleMarker) return;
  if (lastVehicleLatLng){
    const [lat1, lon1] = lastVehicleLatLng;
    const [lat2, lon2] = p;
    const deg = bearingDeg(lat1, lon1, lat2, lon2);
    const img = vehicleMarker.getElement()?.querySelector('img');
    if (img) img.style.transform = `rotate(${deg}deg)`;
  }
  lastVehicleLatLng = p;
}

function startAnim(){
  const kmh = Number(document.getElementById('speed').value);
  const speedMps = Math.max(1, kmh * 1000 / 3600);
  const cum = buildCumulative(currentRouteLatLngs);
  const totalDist = cum[cum.length-1];
  const totalMs = (totalDist / speedMps) * 1000;

  const alreadyMs = vehicleAnim?.pausedAtMs ? vehicleAnim.pausedAtMs : 0;
  const startTs = performance.now() - alreadyMs;

  vehicleAnim = { rafId: 0, startTs, pausedAtMs: 0, totalMs, cum };
  document.getElementById('btnPlay').textContent = 'Pausar';
  refreshPlayButtons();
  setAnimLabel('En movimiento…');

  const step = (ts) => {
    if(!vehicleAnim) return;
    const elapsed = ts - vehicleAnim.startTs;
    const clamped = Math.min(Math.max(elapsed, 0), vehicleAnim.totalMs);
    const dist = (clamped / vehicleAnim.totalMs) * totalDist;
    const p = interpolateOnRoute(currentRouteLatLngs, vehicleAnim.cum, dist);
    vehicleMarker.setLatLng(p);
    applyVehicleHeading(p);
    // (simulación desactivada conceptualmente; mantenida por compatibilidad)

    if (clamped >= vehicleAnim.totalMs){
      stopAnim(false);
      document.getElementById('btnPlay').textContent = 'Reiniciar';
      refreshPlayButtons();
      setAnimLabel('Completada');
      return;
    }
    vehicleAnim.rafId = requestAnimationFrame(step);
  };

  vehicleAnim.rafId = requestAnimationFrame(step);
}

function pauseAnim(){
  if(!vehicleAnim?.rafId) return;
  cancelAnimationFrame(vehicleAnim.rafId);
  const now = performance.now();
  vehicleAnim.pausedAtMs = Math.min(Math.max(now - vehicleAnim.startTs, 0), vehicleAnim.totalMs);
  vehicleAnim.rafId = 0;
  document.getElementById('btnPlay').textContent = 'Continuar';
  refreshPlayButtons();
  setAnimLabel('Pausada');
}

function stopAnim(resetToStart){
  if(vehicleAnim?.rafId) cancelAnimationFrame(vehicleAnim.rafId);
  vehicleAnim = null;
  if(resetToStart && vehicleMarker && currentRouteLatLngs.length){
    vehicleMarker.setLatLng(currentRouteLatLngs[0]);
    lastVehicleLatLng = currentRouteLatLngs[0];
    const img = vehicleMarker.getElement()?.querySelector('img');
    if (img) img.style.transform = 'rotate(0deg)';
  }
}

window.addEventListener('load', () => setTimeout(() => map.invalidateSize(), 150));
window.addEventListener('orientationchange', () => setTimeout(() => map.invalidateSize(), 250));
document.addEventListener('DOMContentLoaded', async () => {
  updateChips();
  loadClients();
  initTabsUi();
  const st = loadSettings();
  const ar = document.getElementById('settingAutoRoute');
  const an = document.getElementById('settingAutoNotify');
  if (ar) ar.checked = !!st.autoRoute;
  if (an) an.checked = !!st.autoNotify;
  const tk = getTodayWeekKey();
  if (tk) selectedWeekKey = tk;
  initWeekUi();
  initCrmUi();
  initVehicleNotifyUi();
  initWizardUi();
  renderClients();
  renderRouteStops();
  // toolbar buttons
  document.getElementById('btnAddClient')?.addEventListener('click', () => { showView('clients'); document.getElementById('crmName')?.focus(); });
  document.getElementById('btnViewRoute')?.addEventListener('click', () => { showView('main'); });
  document.getElementById('btnSummary')?.addEventListener('click', () => { const el = document.getElementById('financialSummary'); if(el) el.scrollIntoView({behavior:'smooth'}); });
  document.getElementById('btnPlay').textContent = 'Navegar (GPS)';
  document.getElementById('btnPlayPeek').textContent = 'Navegar (GPS)';
  maybeVehicleNotification();
  try{ await tryAutoRouteForToday(); }catch(_){ }
});

// Exponer funciones usadas por HTML (onclick)
window.optimizarYCrearRuta = optimizarYCrearRuta;
window.toggleAnim = toggleAnim;
window.usarEjemplo = usarEjemplo;
window.importarDesdeTextarea = importarDesdeTextarea;
window.limpiarTodo = limpiarTodo;

// -----------------------
// Extensiones: modal, entrega, notificaciones, resumen financiero, reoptimización
// -----------------------
function updateFinancialSummary(){
  const total = savedClients.reduce((s,c)=>s + (Number(c.amount)||0), 0);
  const paid = savedClients.reduce((s,c)=>s + ((c.paid ? Number(c.amount) : 0)||0), 0);
  const pending = Math.max(0, total - paid);
  document.getElementById('totalDay').textContent = total ? `${total.toFixed(2)} COP` : '—';
  document.getElementById('totalPaid').textContent = paid ? `${paid.toFixed(2)} COP` : '—';
  document.getElementById('totalPending').textContent = pending ? `${pending.toFixed(2)} COP` : '—';
}

function markAsDelivered(clientId){
  const c = savedClients.find(x=>x.id===clientId);
  if(!c) return;
  c.orderState = 'Entregado';
  // Si aún no estaba cobrado, lo dejamos como pendiente (usuario decide cobrar)
  persistClients();
  renderClients();
  updateFinancialSummary();
  setStatus(`Pedido marcado como entregado: ${c.name}`);
}

function openClientModal(clientId){
  const c = savedClients.find(x=>x.id===clientId);
  if(!c) return;
  const body = document.getElementById('clientModalBody');
  body.innerHTML = '';
  const info = document.createElement('div');
  const prClass = c.priority === 'high' ? 'prio-high' : (c.priority === 'medium' ? 'prio-medium' : 'prio-low');
  info.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
      <div>
        <div style="font-weight:800;font-size:16px;">${escapeHtml(c.name)}</div>
        <div class="small-muted">${escapeHtml(c.placeDetail)} · ${escapeHtml(c.municipality)}</div>
      </div>
      <div style="text-align:right;">
        <div class="prio-badge ${prClass}">${c.priority === 'high' ? '🔴 Alta' : (c.priority === 'medium' ? '🟠 Media' : '🟢 Baja')}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div><b>Horario</b><div class="small-muted">${c.openTime} — ${c.closeTime}</div></div>
      <div><b>Almuerzo</b><div class="small-muted">${c.lunchStart} — ${c.lunchEnd}</div></div>
      <div><b>Atención (min)</b><div class="small-muted">${c.serviceMin || 0}</div></div>
      <div><b>Estado pedido</b><div class="small-muted">${c.orderState || 'Pendiente'}</div></div>
      <div><b>Valor</b><div class="small-muted client-money">${Number(c.amount||0).toFixed(2)} COP</div></div>
      <div><b>Pago</b><div class="small-muted">${c.paid ? 'Cobrado' : 'Pendiente'}</div></div>
    </div>
  `;
  body.appendChild(info);
  document.getElementById('clientModal').style.display = 'flex';
  document.getElementById('clientModal').setAttribute('aria-hidden','false');
  // wire buttons
  document.getElementById('clientModalDelivered').onclick = () => { markAsDelivered(clientId); closeClientModal(); };
  document.getElementById('clientModalEdit').onclick = () => { crmLoadClient(c); closeClientModal(); showView('clients'); };
  document.getElementById('clientModalClose').onclick = closeClientModal;
}

function closeClientModal(){
  const mod = document.getElementById('clientModal');
  if(!mod) return;
  mod.style.display = 'none';
  mod.setAttribute('aria-hidden','true');
}

// Notificaciones inteligentes: proximidad, almuerzo, cierre
const LS_CLIENTS_NOTIF = 'reparto_client_notif_v1';
function proximityCheck(){
  if (!userLocation) return;
  const now = Date.now();
  let changed = false;
  for (const c of savedClients){
    if (!c.lat || !c.lon) continue;
    if (c.orderState === 'Entregado' || c.orderState === 'Fallido') continue;
    const dist = haversineMeters([userLocation.lat, userLocation.lon], [c.lat, c.lon]);
    const last = c.lastNotifiedAt || 0;
    // cerca (<200m)
    if (dist < 200 && now - last > 1000 * 60 * 3){
      notifyUser(`Cerca de ${c.name}`, `Estás a ${Math.round(dist)} m de ${c.name}.`);
      c.lastNotifiedAt = now; changed = true;
    }
    // horarios
    const mm = minutesSinceMidnight(now);
    const lunchStart = parseHHMM(c.lunchStart || '12:00');
    const lunchEnd = parseHHMM(c.lunchEnd || '13:00');
    if (mm >= lunchStart && mm < lunchEnd){
      // cliente en almuerzo
      if (now - last > 1000 * 60 * 5){ notifyUser(`${c.name}: en almuerzo`, `El cliente está en horario de almuerzo (${c.lunchStart}–${c.lunchEnd}).`); c.lastNotifiedAt = now; changed = true; }
    }
    const closeMin = parseHHMM(c.closeTime || '18:00');
    if (closeMin - mm <= 15 && closeMin - mm > 0 && now - last > 1000 * 60 * 5){
      notifyUser(`${c.name}: cierra pronto`, `Cierra en ${closeMin - mm} minutos (${c.closeTime}).`); c.lastNotifiedAt = now; changed = true;
    }
    if (mm > parseHHMM(c.closeTime || '18:00') && now - last > 1000 * 60 * 5){
      notifyUser(`${c.name}: fuera de horario`, `El cliente ya cerró (${c.closeTime}).`); c.lastNotifiedAt = now; changed = true;
    }
  }
  if (changed) persistClients();
}

function notifyUser(title, body){
  if ('Notification' in window && Notification.permission === 'granted'){
    try{ new Notification(title, { body }); return; }catch(_){ }
  }
  // Fallback: alert interno en la UI
  setStatus(`${title}: ${body}`);
}

// Re-optimización ligera: si te alejaste bastante del inicio de la ruta
function maybeReoptimizeOnDeviation(){
  if (!navigationActive) return;
  if (!userLocation) return;
  if (!currentRouteLatLngs || !currentRouteLatLngs.length) return;
  const distToStart = haversineMeters([userLocation.lat, userLocation.lon], currentRouteLatLngs[0]);
  if (distToStart > 400){
    setStatus('Detectada desviación significativa — recalculando ruta…');
    optimizarYCrearRuta();
  }
}

// Ejecutores periódicos
let proximityIntervalId = null;
function startProximityChecks(){
  if (proximityIntervalId) return;
  proximityIntervalId = setInterval(proximityCheck, 12 * 1000);
}
function stopProximityChecks(){ if (proximityIntervalId){ clearInterval(proximityIntervalId); proximityIntervalId = null; } }

// Inicialización extendida
document.addEventListener('DOMContentLoaded', () => {
  // Pedir permiso para notificaciones si el usuario ya activó recordatorio
  try{ const st = loadSettings(); if (st.autoNotify && 'Notification' in window && Notification.permission !== 'granted') Notification.requestPermission().catch(()=>{}); }catch(_){ }
  // Start background checks
  startProximityChecks();
  updateFinancialSummary();
});


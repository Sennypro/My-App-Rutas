// Módulo de mapa: marcadores por prioridad y comprobación de proximidad
// Depende de `window.map`, `window.getSavedClients()` y funciones globales como `openClientModal`, `notifyUser`, `haversineMeters`.

const markerLayerGroup = L.layerGroup();
let clientMarkers = new Map();

function priorityColor(pr){
  if (pr === 'high') return '#ef4444';
  if (pr === 'medium') return '#f59e0b';
  return '#22c55e';
}

function ensureLayer(){
  try{
    if (window.map && !markerLayerGroup._map) markerLayerGroup.addTo(window.map);
  }catch(e){}
}

function clearClientMarkers(){
  clientMarkers.forEach(m => markerLayerGroup.removeLayer(m));
  clientMarkers.clear();
}

function renderClientMarkers(){
  ensureLayer();
  clearClientMarkers();
  const clients = (window.getSavedClients ? window.getSavedClients() : window.savedClients) || [];
  for (const c of clients){
    if (!c.lat || !c.lon) continue;
    const color = priorityColor(c.priority);
    const m = L.circleMarker([c.lat, c.lon], {
      radius: 9,
      color: color,
      weight: 2,
      fillColor: '#0b1020',
      fillOpacity: 0.9
    }).addTo(markerLayerGroup);
    m.bindTooltip(`${c.name} · ${c.placeDetail}`, { permanent: false, direction: 'top' });
    m.on('click', () => {
      if (typeof openClientModal === 'function') openClientModal(c.id);
      if (window.map) window.map.panTo([c.lat, c.lon]);
    });
    clientMarkers.set(c.id, m);
  }
}

function updateMarkerForClient(client){
  ensureLayer();
  const existing = clientMarkers.get(client.id);
  if (existing){
    existing.setLatLng([client.lat, client.lon]);
    existing.setStyle({ color: priorityColor(client.priority) });
  } else {
    renderClientMarkers();
  }
}

// Comprobación periódica de proximidad (usa userLocation global mantenida por app.js)
let proximityInterval = null;
function startProximityChecks(){
  if (proximityInterval) return;
  proximityInterval = setInterval(() => {
    try{
      const clients = (window.getSavedClients ? window.getSavedClients() : window.savedClients) || [];
      const user = window.userLocation;
      if (!user) return;
      for (const c of clients){
        if (!c.lat || !c.lon) continue;
        if (c.orderState === 'Entregado' || c.orderState === 'Fallido') continue;
        const d = haversineMeters([user.lat, user.lon], [c.lat, c.lon]);
        if (d < 200){
          if (typeof notifyUser === 'function') notifyUser(`Cerca de ${c.name}`, `Estás a ${Math.round(d)} m de ${c.name}.`);
        }
      }
    }catch(_){ }
  }, 12 * 1000);
}
function stopProximityChecks(){ if (proximityInterval){ clearInterval(proximityInterval); proximityInterval = null; } }

// Exponer funciones
window.renderClientMarkers = renderClientMarkers;
window.updateMarkerForClient = updateMarkerForClient;
window.startProximityChecksMap = startProximityChecks;
window.stopProximityChecksMap = stopProximityChecks;

// Auto-iniciar si el mapa ya existe
setTimeout(() => { try{ if (window.map) { ensureLayer(); renderClientMarkers(); startProximityChecks(); } }catch(e){} }, 600);

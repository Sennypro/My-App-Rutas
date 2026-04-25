// Módulo de mapa: marcadores por prioridad y comprobación de proximidad
// Mejorado: validaciones, optimización, anti-spam, estructura limpia

const markerLayerGroup = L.layerGroup();
let clientMarkers = new Map();
const notifiedClients = new Set();

// =======================
// UTILIDADES
// =======================

function getClientsSafe(){
  return (window.getSavedClients?.() ?? window.savedClients ?? []);
}

function priorityColor(pr){
  if (pr === 'high') return '#ef4444';     // rojo
  if (pr === 'medium') return '#f59e0b';   // naranja
  return '#22c55e';                        // verde
}

function ensureLayer(){
  try{
    if (window.map && !markerLayerGroup._map){
      markerLayerGroup.addTo(window.map);
    }
  }catch(e){
    console.error("Error asegurando layer:", e);
  }
}

// =======================
// MARCADORES
// =======================

function createMarker(c){
  const m = L.circleMarker([c.lat, c.lon], {
    radius: c.priority === 'high' ? 12 : 9,
    color: priorityColor(c.priority),
    weight: 2,
    fillColor: '#0b1020',
    fillOpacity: 0.9
  }).addTo(markerLayerGroup);

  m.bindTooltip(`${c.name} · ${c.placeDetail || ''}`, {
    direction: 'top'
  });

  m.on('click', () => {
    try{
      window.openClientModal?.(c.id);
      window.map?.panTo([c.lat, c.lon]);
    }catch(e){
      console.error("Error al hacer click en marcador:", e);
    }
  });

  return m;
}

function clearClientMarkers(){
  clientMarkers.forEach(m => {
    if (markerLayerGroup.hasLayer(m)){
      markerLayerGroup.removeLayer(m);
    }
  });
  clientMarkers.clear();
}

function renderClientMarkers(){
  ensureLayer();

  const clients = getClientsSafe();

  for (const c of clients){
    if (c.lat == null || c.lon == null) continue;
    if (clientMarkers.has(c.id)) continue;

    const m = createMarker(c);
    clientMarkers.set(c.id, m);
  }
}

function updateMarkerForClient(client){
  ensureLayer();

  if (client.lat == null || client.lon == null) return;

  const existing = clientMarkers.get(client.id);

  if (existing){
    existing.setLatLng([client.lat, client.lon]);
    existing.setStyle({
      color: priorityColor(client.priority),
      radius: client.priority === 'high' ? 12 : 9
    });
  } else {
    const m = createMarker(client);
    clientMarkers.set(client.id, m);
  }
}

// =======================
// PROXIMIDAD (GPS)
// =======================

let proximityInterval = null;

function startProximityChecks(){
  if (proximityInterval) return;

  proximityInterval = setInterval(() => {
    try{
      const clients = getClientsSafe();
      const user = window.userLocation;

      if (!user) return;

      for (const c of clients){
        if (c.lat == null || c.lon == null) continue;
        if (c.orderState === 'Entregado' || c.orderState === 'Fallido') continue;

        const d = window.haversineMeters?.(
          [user.lat, user.lon],
          [c.lat, c.lon]
        );

        if (!d) continue;

        // Filtro general (optimización)
        if (d < 500){

          // Notificación cercana real
          if (d < 200 && !notifiedClients.has(c.id)){
            window.notifyUser?.(
              `Cerca de ${c.name}`,
              `Estás a ${Math.round(d)} m de ${c.name}.`
            );
            notifiedClients.add(c.id);
          }
        }
      }

    }catch(e){
      console.error("Error en proximidad:", e);
    }
  }, 12000); // cada 12s
}

function stopProximityChecks(){
  if (proximityInterval){
    clearInterval(proximityInterval);
    proximityInterval = null;
  }
}

// =======================
// EXPORTAR FUNCIONES
// =======================

window.renderClientMarkers = renderClientMarkers;
window.updateMarkerForClient = updateMarkerForClient;
window.startProximityChecksMap = startProximityChecks;
window.stopProximityChecksMap = stopProximityChecks;

// =======================
// INIT LIMPIO
// =======================

document.addEventListener("DOMContentLoaded", () => {
  try{
    if (window.map){
      ensureLayer();
      renderClientMarkers();
      startProximityChecks();
    }
  }catch(e){
    console.error("Error al iniciar mapa:", e);
  }
});
// Módulo clientes: utilidades para ordenar/filtrar por prioridad, horarios y disponibilidad

function isClientAvailableNow(c, atMs){
  const now = atMs || Date.now();
  const mm = (new Date(now)).getHours() * 60 + (new Date(now)).getMinutes();
  const open = parseHHMM(c.openTime || '00:00');
  const close = parseHHMM(c.closeTime || '23:59');
  const lunchStart = parseHHMM(c.lunchStart || '99:99');
  const lunchEnd = parseHHMM(c.lunchEnd || '99:99');
  if (mm < open) return { available: false, reason: 'no-abierto' };
  if (mm > close) return { available: false, reason: 'cerrado' };
  if (mm >= lunchStart && mm < lunchEnd) return { available: false, reason: 'almuerzo' };
  return { available: true };
}

function priorityWeight(p){ return p === 'high' ? 0 : (p === 'medium' ? 1 : 2); }

// Ordena clientes: prioridad asc (alta primero), luego distancia (si se pasa userLocation), luego horario
function sortClientsForRouting(clients, userLocation){
  const now = Date.now();
  return clients.slice().sort((a,b)=>{
    const wa = priorityWeight(a.priority || 'low');
    const wb = priorityWeight(b.priority || 'low');
    if (wa !== wb) return wa - wb;
    // disponibilidad
    const aa = isClientAvailableNow(a, now);
    const ab = isClientAvailableNow(b, now);
    if (aa.available !== ab.available) return aa.available ? -1 : 1;
    // distancia
    if (userLocation && a.lat && a.lon && b.lat && b.lon){
      const da = haversineMeters([userLocation.lat, userLocation.lon],[a.lat,a.lon]);
      const db = haversineMeters([userLocation.lat, userLocation.lon],[b.lat,b.lon]);
      return da - db;
    }
    return 0;
  });
}

window.isClientAvailableNow = isClientAvailableNow;
window.sortClientsForRouting = sortClientsForRouting;

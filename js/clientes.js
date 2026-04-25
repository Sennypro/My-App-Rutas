// Módulo clientes PRO: prioridad inteligente + horarios + urgencia + distancia

// =======================
// UTILIDADES
// =======================

function safeParse(time, fallback){
  try {
    const v = parseHHMM(time);
    return isNaN(v) ? fallback : v;
  } catch {
    return fallback;
  }
}

function getMinutesNow(now){
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

// =======================
// DISPONIBILIDAD
// =======================

function isClientAvailableNow(c, atMs){
  const now = atMs || Date.now();
  const mm = getMinutesNow(now);

  if (c.orderState === 'Entregado' || c.orderState === 'Fallido'){
    return { available: false, reason: 'finalizado' };
  }

  const open = safeParse(c.openTime, 0);
  const close = safeParse(c.closeTime, 1439);
  const lunchStart = safeParse(c.lunchStart, 9999);
  const lunchEnd = safeParse(c.lunchEnd, 9999);

  if (mm < open) return { available: false, reason: 'no-abierto' };
  if (mm > close) return { available: false, reason: 'cerrado' };
  if (mm >= lunchStart && mm < lunchEnd) return { available: false, reason: 'almuerzo' };

  return { available: true };
}

// =======================
// PRIORIDAD BASE
// =======================

function priorityWeight(p){
  return p === 'high' ? 0 : (p === 'medium' ? 1 : 2);
}

// =======================
// URGENCIA (CIERRE PRÓXIMO)
// =======================

function closingSoonScore(c, now){
  const mm = getMinutesNow(now);
  const close = safeParse(c.closeTime, 1439);

  const diff = close - mm;

  if (diff <= 0) return -1000;     // ya cerró
  if (diff < 30) return 50;        // MUY urgente
  if (diff < 60) return 30;
  if (diff < 120) return 10;

  return 0;
}

// =======================
// ALMUERZO PRÓXIMO
// =======================

function lunchSoonScore(c, now){
  const mm = getMinutesNow(now);
  const lunchStart = safeParse(c.lunchStart, 9999);

  const diff = lunchStart - mm;

  if (diff <= 0) return 0;
  if (diff < 30) return 40;  // se va a almorzar pronto
  if (diff < 60) return 20;

  return 0;
}

// =======================
// DISTANCIA
// =======================

function distanceScore(c, userLocation){
  if (!userLocation || c.lat == null || c.lon == null) return 0;

  const d = haversineMeters(
    [userLocation.lat, userLocation.lon],
    [c.lat, c.lon]
  );

  if (!d) return 0;

  // entre más cerca, mejor score
  if (d < 200) return 40;
  if (d < 500) return 25;
  if (d < 1000) return 10;

  return 0;
}

// =======================
// SCORE TOTAL (🔥 CLAVE)
// =======================

function calculateClientScore(c, userLocation, now, availabilityCache){
  const availability = availabilityCache.get(c.id) || isClientAvailableNow(c, now);
  availabilityCache.set(c.id, availability);

  if (!availability.available){
    return -9999; // descartado
  }

  let score = 0;

  // prioridad base
  score += (3 - priorityWeight(c.priority || 'low')) * 20;

  // urgencia
  score += closingSoonScore(c, now);

  // almuerzo
  score += lunchSoonScore(c, now);

  // distancia
  score += distanceScore(c, userLocation);

  return score;
}

// =======================
// ORDENAMIENTO PRO
// =======================

function sortClientsForRouting(clients, userLocation){
  const now = Date.now();
  const availabilityCache = new Map();

  return clients.slice().sort((a,b)=>{

    const scoreA = calculateClientScore(a, userLocation, now, availabilityCache);
    const scoreB = calculateClientScore(b, userLocation, now, availabilityCache);

    // mayor score = mayor prioridad
    if (scoreA !== scoreB) return scoreB - scoreA;

    // fallback: distancia pura
    if (
      userLocation &&
      a.lat != null && a.lon != null &&
      b.lat != null && b.lon != null
    ){
      const da = haversineMeters([userLocation.lat, userLocation.lon],[a.lat,a.lon]);
      const db = haversineMeters([userLocation.lat, userLocation.lon],[b.lat,b.lon]);
      return da - db;
    }

    return 0;
  });
}

// =======================
// EXPORTAR
// =======================

window.isClientAvailableNow = isClientAvailableNow;
window.sortClientsForRouting = sortClientsForRouting;
window.calculateClientScore = calculateClientScore;
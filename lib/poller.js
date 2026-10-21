const { fetchAttendanceLogs, fetchDeviceUsers } = require("./zkteco");
const { postClockEvent, getDaySummary } = require("./humandClient");
const { getClock, upsertClock, readClocks, getEmployeeState, upsertEmployeeState } = require("./store");

// --- Entrada vs. salida ---
// La API de Humand tiene dos endpoints separados (clockIn / clockOut), pero
// node-zklib no decodifica el byte de "tipo de verificación / entrada-salida"
// del paquete crudo del reloj (ver lib/zkteco.js) — cada marcación llega solo
// con { deviceUserId, recordTime }, sin indicar si fue una entrada o salida.
//
// Mientras no se decodifique ese byte (o se confirme con el cliente que el
// modelo/firmware lo reporta de forma confiable), se infiere alternando por
// empleado y por día: la primera marcación del día es START, la siguiente
// END, la siguiente START, etc. Es la heurística estándar para terminales
// sin ese dato — funciona bien salvo que a alguien le falte fichar una marca
// en el medio del día (ver README).
//
// ⚠️ CORREGIDO 19/8: esta alternancia vivía en clock.directionState — es
// decir, por reloj. Confirmado con el cliente que la gente puede fichar
// desde MÁS DE UN reloj (ej. entrada en EMPAQUE, salida en COMEDOR), así que
// guardar el estado por reloj estaba mal: cada reloj veía la marca del otro
// como si fuera la primera del día para ese empleado, y terminaba mandando
// dos entradas en vez de una entrada y una salida. Ahora el estado vive en
// la tabla employee_state (lib/store.js), compartido por TODOS los relojes
// de un mismo cliente — ver clientKeyFor() más abajo. Solo se confirma
// después de que Humand aceptó el envío — si el POST falla, no se avanza el
// estado, para no desincronizar la alternancia futura.
//
// ⚠️ CORREGIDO 15/9: el "día" de esta alternancia se calculaba con
// recordTime.toISOString().slice(0, 10) — el día calendario UTC de la
// marca, NO el día calendario Argentina (a pesar de que el resto de este
// archivo sí usa argentinaDateKey para eso, ver más abajo). Una salida
// entre las 21:00 y las 23:59 ART cae, en UTC, ya en el día SIGUIENTE
// (ej. 14/9 22:41 ART = 15/9 01:41 UTC), así que la alternancia la veía
// como "primera marca de un día nuevo" y la mandaba a Humand como START
// en vez de END. Humand la rechazaba (esa persona ya tenía una entrada real
// ese día) y, como el estado solo avanza cuando Humand acepta el envío, la
// salida quedaba reintentándose y fallando en cada ciclo hasta perderse del
// todo — reportado por el cliente: Empleado C marcó entrada 11:11 y
// salida 22:41 el 14/9, pero Humand nunca tomó la salida y terminó
// cerrando el turno solo por su propio límite de 20hs ("olvido de
// marcaje"). Ahora la alternancia usa argentinaDateKey (día real del
// cliente) en vez del día UTC del proceso.
//
// ⚠️ CORREGIDO 28/9: lo de arriba resuelve el desfasaje UTC/ART, pero
// dejaba un caso sin cubrir — reportado por el cliente el 28/9 con Empleado B
// Apellido (Horario Nocturno Lab4, 21:30-06:30: entrada viernes 21:28, salida
// sábado 06:41) y Empleado A (mismo patrón, salida ~06:42 marcada como si
// fuera una entrada del sábado). Un turno NOCTURNO real cruza la medianoche
// ARGENTINA (no solo la UTC), así que la salida cae en un `argentinaDateKey`
// distinto al de la entrada. Esta función, tal cual estaba, veía eso como
// "primera marca de un día nuevo" y devolvía START — Humand la rechazaba
// (422 TIME_TRACKING_ENTRY_DUPLICATE, "no puede haber dos entradas
// seguidas") porque ya tenía la entrada de la noche anterior sin cerrar, y
// el turno quedaba abierto para siempre (confirmado en vivo: Empleado A
// y Empleado B con turnos abiertos hace 16-17hs en el momento del
// diagnóstico). Ahora, si cambia el día calendario Argentina PERO la última
// marca fue una entrada (START) hace menos de MAX_SHIFT_EXTENSION_MS, se
// interpreta como el cierre de ESE turno (END) en vez de una entrada nueva.
// El umbral (16hs) se eligió para cubrir cualquier turno nocturno + margen
// de horas extra, sin comerse una entrada nueva legítima al día siguiente
// (que normalmente llega bastantes horas después del cierre real del turno
// anterior — ver testDirectionAlternation, que sigue pasando con este
// margen).
const MAX_SHIFT_EXTENSION_MS = 16 * 60 * 60 * 1000;

function peekDirection(state, recordTime) {
  if (!state) return "START";
  const dateKey = argentinaDateKey(recordTime);
  if (state.date === dateKey) {
    return state.lastType === "START" ? "END" : "START";
  }
  if (
    state.lastType === "START" &&
    typeof state.lastRecordTimeMs === "number" &&
    recordTime.getTime() - state.lastRecordTimeMs <= MAX_SHIFT_EXTENSION_MS
  ) {
    return "END";
  }
  return "START";
}

function nextState(recordTime, direction) {
  return {
    date: argentinaDateKey(recordTime),
    lastType: direction,
    lastRecordTimeMs: recordTime.getTime(),
  };
}

// Rebote del lector biométrico: descubierto en vivo el 19/8 — un mismo toque
// de huella/rostro puede quedar grabado como dos marcaciones separadas a
// pocos segundos de distancia. La alternancia START/END, al tratar cada línea
// del reloj como un evento real, interpretaba ese rebote como "entró y salió
// en 2 segundos", generando un turno fantasma en Humand con la misma hora de
// entrada y salida. Cualquier marcación del mismo empleado a menos de
// DUPLICATE_PUNCH_WINDOW_MS de la última YA ENVIADA se descarta como rebote
// (no se manda a Humand, no mueve la alternancia) en vez de contarse como un
// evento nuevo. Al ser estado por-empleado (no por-reloj), esto también
// cubre el caso de dos relojes físicamente cercanos leyendo el mismo toque.
const DUPLICATE_PUNCH_WINDOW_MS = 60 * 1000;

// Segunda marca pegada a una SALIDA (9/10, caso Empleada D): fichó la
// salida en un reloj y 7 minutos después hubo otra marca en otro reloj. La
// alternancia la tomó como una entrada nueva y dio vuelta todas las marcas
// siguientes. Una "entrada" a menos de POST_EXIT_REBOUND_WINDOW_MS de la
// salida se descarta igual que un rebote (no se envía ni mueve la alternancia).
// Solo aplica después de una salida: una marca pegada a una entrada se sigue
// tratando como salida real.
const POST_EXIT_REBOUND_WINDOW_MS = 10 * 60 * 1000;

function isDuplicatePunch(state, recordTime) {
  if (!state || typeof state.lastRecordTimeMs !== "number") return false;
  const gap = recordTime.getTime() - state.lastRecordTimeMs;
  if (Math.abs(gap) < DUPLICATE_PUNCH_WINDOW_MS) return true;
  return state.lastType === "END" && gap >= 0 && gap < POST_EXIT_REBOUND_WINDOW_MS;
}

// --- Alerta de "turno abierto" ---
// La alternancia (peekDirection) sigue siendo "primera marca del día =
// entrada, siguiente = salida, ..." — no se la reemplaza por algo más
// "inteligente": si a alguien le falta fichar una marca en el medio del día,
// esa jornada puntual se puede desalinear igual (ver README). En vez de
// complicar el algoritmo tratando de adivinar mejor, se detecta el síntoma
// más visible — un "turno abierto" (marcó entrada y hace demasiadas horas
// que no vuelve a marcar) — y se avisa en el panel para que alguien lo
// revise y corrija a mano en Humand, mismo circuito manual que ya se usó
// para el rebote del lector el 19/8. No cambia qué se manda a Humand ni la
// alternancia: es solo una lectura del estado ya guardado.
const STALE_OPEN_SHIFT_HOURS = 14;
const STALE_OPEN_SHIFT_MS = STALE_OPEN_SHIFT_HOURS * 60 * 60 * 1000;

// Namespace del estado compartido: todos los relojes de un mismo cliente
// (mismo clock.clientName) comparten la alternancia entrada/salida de sus
// empleados. Si un reloj no tiene clientName cargado, se aísla por su propio
// id en vez de mezclarse con "sin nombre" de otro cliente por accidente.
function clientKeyFor(clock) {
  return clock.clientName ? `client:${clock.clientName}` : `clock:${clock.id}`;
}

// Argentina no tiene horario de verano desde 2009: UTC-3 fijo. Se usa para
// poder filtrar "las marcaciones de hoy" (onlyToday, ver más abajo) según el
// día calendario real del cliente, no el día UTC.
const ARGENTINA_UTC_OFFSET_HOURS = -3;

function argentinaDateKey(date) {
  const shifted = new Date(date.getTime() + ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// --- Marca única del día que en realidad es una salida tardía ---
// Reportado por el cliente (el cliente, vía CX): a veces alguien se olvida
// de fichar la entrada y su único marcaje del día es en realidad la salida.
// peekDirection (arriba) no tiene forma de distinguir ese caso de una entrada
// legítima: para él, "primera marca del día" siempre es START, sin mirar la
// hora. El reporte quedaba desfasado (la hora de salida real figuraba como
// si fuera la de entrada) y sin ninguna señal de que el registro era raro.
//
// Se investigó si la API de Humand expone el horario programado del
// colaborador para poder comparar: NO existe vía "Turnos"
// (GET /shifts/planning devuelve siempre `shifts: []` para este cliente,
// que no usa ese módulo), pero SÍ vía "Horario Laboral"
// (GET /time-tracking/day-summaries, confirmado en vivo el 4/9 contra la
// comunidad real: `hasSchedule`/`timeSlots` con horarios reales por día). Ver
// getDaySummary() en lib/humandClient.js.
//
// Regla: SOLO para la primera marca del día de un empleado (no para un
// START posterior por alternancia, ej. la vuelta del almuerzo — eso sigue
// funcionando como antes) — si Humand tiene un horario cargado ese día y la
// marca llega después del fin de turno esperado + un margen de tolerancia,
// se reclasifica como END (salida) en vez de START (entrada), y se deja
// registrado en runLog.missingCheckIns para que quede visible en el panel
// (mismo criterio que runLog.openShifts: se avisa, no se inventa una entrada
// que no existió — alguien tiene que revisar y cargarla a mano en Humand).
//
// Por qué comparar solo contra el FIN de turno y no contra el inicio: una
// entrada legítima tarde (llega después de la hora de entrada esperada, pero
// todavía dentro de la jornada) tiene que seguir siendo START — esta regla
// no debe interferir con la tolerancia de tardanza/ausencia que el cliente
// ya configuró en Humand (5 min / 15 min): esa tolerancia sigue aplicando
// del lado de Humand sobre marcas que acá seguimos mandando como entrada.
//
// Apagado por defecto (clock.lateLonePunchCheckoutEnabled !== true): el
// pedido fue "arrancar en dry-run" — este flag es APARTE del dry-run de
// envío (clock.dryRun, ver effectiveDryRun en humandClient.js) para que
// activar esta feature en un reloj puntual (a validar con el cliente) no
// dependa de tocar/perder el estado de envío real que ya tenga ese reloj.
function isLateLonePunchCheckoutEnabled(clockConfig) {
  return clockConfig.lateLonePunchCheckoutEnabled === true;
}

const DEFAULT_LATE_LONE_PUNCH_TOLERANCE_MINUTES = 30;

function lateLonePunchToleranceMs(clockConfig) {
  const minutes =
    typeof clockConfig.lateLonePunchToleranceMinutes === "number"
      ? clockConfig.lateLonePunchToleranceMinutes
      : DEFAULT_LATE_LONE_PUNCH_TOLERANCE_MINUTES;
  return minutes * 60 * 1000;
}

// "HH:MM" en hora LOCAL Argentina (así los devuelve day-summaries, ver la
// nota grande en getDaySummary) + la fecha (YYYY-MM-DD, mismo día — ver la
// nota grande de shouldReclassifyLonePunchAsCheckout sobre por qué NO se
// intenta correr la fecha un día para turnos nocturnos) → ms UTC. Argentina
// es UTC-3 fijo (sin horario de verano desde 2009, ver ARGENTINA_UTC_OFFSET_HOURS
// arriba), así que la hora local + 3hs = la hora UTC.
function argentinaLocalTimeToUtcMs(dateKey, hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!match) return null;
  const [, hh, mm] = match;
  const parsedAsUtc = Date.parse(`${dateKey}T${hh}:${mm}:00.000Z`);
  if (Number.isNaN(parsedAsUtc)) return null;
  return parsedAsUtc - ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000;
}

// Trae (y cachea por empleado+día, ver daySummaryCache en syncClock) el
// resumen del día vía Humand. Nunca tira: si la consulta falla (red, rate
// limit, etc.) se loguea en runLog.errors y se devuelve null — el llamador
// interpreta null como "sin horario disponible" y cae al comportamiento
// actual (START), no bloquea el resto del sync.
async function fetchDaySummaryCached(clockConfig, employeeInternalId, dateKey, cache, runLog) {
  const cacheKey = `${employeeInternalId}|${dateKey}`;
  if (!cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      getDaySummary(clockConfig, employeeInternalId, dateKey).catch((err) => {
        runLog.errors.push(
          `No se pudo consultar el horario programado (day-summaries) de ${employeeInternalId} para ${dateKey}: ${err.message || err}`
        );
        return null;
      })
    );
  }
  return cache.get(cacheKey);
}

// Devuelve true si esta marca (la primera del día para este empleado, SEGÚN
// NUESTRO estado interno) debería reclasificarse como salida en vez de
// entrada. Ver la nota grande arriba.
//
// ⚠️ CORREGIDO en la validación en vivo del 4/9 contra un reloj real
// (COMEDOR): en ese momento employee_state reseteaba por día calendario UTC
// (peekDirection usaba recordTime.toISOString().slice(0, 10)), no por día
// calendario Argentina — así que una marca poco después de la medianoche
// UTC pero TODAVÍA dentro del mismo día laboral argentino (ej. 23:59 ART =
// 02:59 UTC del día siguiente) nos parecía "la primera marca del día" aunque
// ese día argentino YA tuviera un turno completo (entrada+salida) realmente
// cargado en Humand. Reclasificarla como salida en ese caso mandaría un
// SEGUNDO "END" seguido a Humand, que lo rechaza (422
// TIME_TRACKING_ENTRY_DUPLICATE). Se agregó esta condición (`summary.entries`
// vacío) como red de seguridad — pero el bug de fondo (peekDirection en día
// UTC) seguía ahí, y el 14/9 causó el problema inverso en LABORATORIO 4: la
// salida de Empleado C a las 22:41 ART (01:41 UTC del día siguiente) se
// clasificó como START en vez de END, esta función correctamente se negó a
// reclasificarla (Humand ya tenía la entrada de ese día), así que se mandó
// como una segunda entrada, Humand la rechazó, y la salida real se perdió
// hasta que Humand cerró el turno solo por su límite de 20hs. CORREGIDO
// 15/9: peekDirection/nextState ahora usan argentinaDateKey igual que acá,
// así que ninguna marca cruza el borde de día equivocado. Esta condición de
// `summary.entries` se mantiene igual, como red de seguridad adicional.
async function shouldReclassifyLonePunchAsCheckout(clockConfig, employeeInternalId, recordTime, cache, runLog) {
  const dateKey = argentinaDateKey(recordTime);
  const summary = await fetchDaySummaryCached(clockConfig, employeeInternalId, dateKey, cache, runLog);
  if (!summary || !summary.hasSchedule || !Array.isArray(summary.timeSlots) || summary.timeSlots.length === 0) {
    return false; // sin horario cargado ese día (franco, o cliente sin Horario Laboral): sin cambios
  }
  if (!Array.isArray(summary.entries) || summary.entries.length > 0) {
    return false; // Humand ya tiene algún fichaje cargado ese día argentino: no es realmente "el primero", no tocar
  }
  // ⚠️ CORREGIDO en la validación en vivo del 4/9 contra LABORATORIO 4: un
  // turno NOCTURNO (cruza medianoche, ej. 21:00-06:00) tiene
  // endTime < startTime porque el fin cae en el día SIGUIENTE al
  // referenceDate. Tratar de calcular ese fin de turno "corriendo" la fecha
  // un día resulta ambiguo: el día calendario argentino de la marca
  // (argentinaDateKey, usado para decidir qué referenceDate consultar) ya
  // pasa a ser el día siguiente ANTES de llegar a esa hora de fin (ej. una
  // marca a las 09:00 ART ya cae en el día calendario siguiente, así que se
  // termina comparando contra el turno de ESE día — uno que ni empezó
  // todavía — en vez del turno de la noche anterior que sí terminó). Probar
  // de "adivinar" esto llevó a una entrada real (~21hs) mal calculada como
  // tardía en un primer intento: se encontraron 15 casos así contra datos
  // reales antes de desactivar la función a tiempo (nunca se mandó nada
  // real: se detectó en dry-run). Ante la ambigüedad, se prefiere NO tocar
  // nada para turnos nocturnos — se mantiene el comportamiento de siempre —
  // en vez de arriesgar otro falso positivo.
  const hasOvernightSlot = summary.timeSlots.some((slot) => slot.endTime < slot.startTime);
  if (hasOvernightSlot) return false;

  const lastSlot = summary.timeSlots[summary.timeSlots.length - 1];
  const expectedEndUtcMs = argentinaLocalTimeToUtcMs(dateKey, lastSlot.endTime);
  if (expectedEndUtcMs == null) return false;
  return recordTime.getTime() > expectedEndUtcMs + lateLonePunchToleranceMs(clockConfig);
}

// --- Dirección por horario para turnos NOCTURNOS (1/10, caso A/B) ---
// Entre el 15/9 y el 28/9 las salidas de la mañana de los turnos nocturnos
// (21:30-06:30) no llegaban a Humand (ver notas de peekDirection), la clienta
// las cargaba a mano y, con el tiempo, la alternancia por inferencia quedó
// invertida (salidas guardadas como entradas), y como cada marca depende de
// la anterior, la inversión se perpetuaba noche tras noche. Para quien tiene
// un horario NOCTURNO cargado en Humand (Horario Laboral con endTime <
// startTime, hoy o ayer) la dirección se decide por la hora de la marca
// respecto de ese turno: cerca del inicio (±3 h) es entrada, cerca del fin
// (-4 h / +5 h) es salida. Fuera de esas ventanas, o sin horario nocturno,
// devuelve null y se usa la alternancia de siempre (nada cambia para el resto
// de los empleados). Si falla la consulta a Humand también devuelve null.
const NIGHT_START_WINDOW_MIN = 180;
const NIGHT_END_BEFORE_MIN = 240;
const NIGHT_END_AFTER_MIN = 300;

function minutesOfDayArgentina(date) {
  const d = new Date(date.getTime() + ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Diferencia circular con signo (en minutos) entre dos minutos del día, en (-720, 720].
function circularDiffMin(a, b) {
  return ((a - b + 1440 + 720) % 1440) - 720;
}

async function nightShiftDirectionByWindow(clockConfig, employeeInternalId, recordTime, cache, runLog) {
  const today = argentinaDateKey(recordTime);
  const yesterday = argentinaDateKey(new Date(recordTime.getTime() - 24 * 60 * 60 * 1000));
  let slot = null;
  for (const dateKey of [today, yesterday]) {
    const summary = await fetchDaySummaryCached(clockConfig, employeeInternalId, dateKey, cache, runLog);
    if (!summary || !summary.hasSchedule || !Array.isArray(summary.timeSlots)) continue;
    slot = summary.timeSlots.find((sl) => sl.endTime < sl.startTime) || null;
    if (slot) break;
  }
  if (!slot) return null;
  const startMin = hhmmToMinutes(slot.startTime);
  const endMin = hhmmToMinutes(slot.endTime);
  if (startMin == null || endMin == null) return null;
  const m = minutesOfDayArgentina(recordTime);
  const dStart = circularDiffMin(m, startMin);
  if (Math.abs(dStart) <= NIGHT_START_WINDOW_MIN) return "START";
  const dEnd = circularDiffMin(m, endMin);
  if (dEnd >= -NIGHT_END_BEFORE_MIN && dEnd <= NIGHT_END_AFTER_MIN) return "END";
  return null;
}

// --- Dirección por horario para turnos DIURNOS (21/10, casos Empleada F, Empleada G y otras 6) ---
// Mismo problema que en los nocturnos, ahora en turnos de día (05:30-14:30):
// al fichar en dos relojes a los pocos minutos (05:19 EMPAQUE + 05:25 COMEDOR)
// la 2da marca se tomó como salida, la alternancia quedó invertida y la salida
// real de las 14:3x se mandó como START (Humand: 422 o doble entrada). Con
// horario de día cargado en Humand, una marca cerca del INICIO del turno es
// entrada y cerca del FIN es salida. Ventanas angostas a propósito: salidas a
// almorzar/colación (a media jornada) caen fuera y siguen por alternancia.
// Solo se usa si no aplica la lógica nocturna. Sin horario o ante error, null.
const DAY_START_BEFORE_MIN = 180;
const DAY_START_AFTER_MIN = 90;
const DAY_END_BEFORE_MIN = 90;
const DAY_END_AFTER_MIN = 300;

async function dayShiftDirectionByWindow(clockConfig, employeeInternalId, recordTime, cache, runLog) {
  const summary = await fetchDaySummaryCached(
    clockConfig,
    employeeInternalId,
    argentinaDateKey(recordTime),
    cache,
    runLog
  );
  if (!summary || !summary.hasSchedule || !Array.isArray(summary.timeSlots)) return null;
  const m = minutesOfDayArgentina(recordTime);
  for (const sl of summary.timeSlots) {
    if (sl.endTime < sl.startTime) continue; // nocturno: lo resuelve nightShiftDirectionByWindow
    const startMin = hhmmToMinutes(sl.startTime);
    const endMin = hhmmToMinutes(sl.endTime);
    if (startMin == null || endMin == null) continue;
    const dStart = m - startMin;
    const dEnd = m - endMin;
    const inStart = dStart >= -DAY_START_BEFORE_MIN && dStart <= DAY_START_AFTER_MIN;
    const inEnd = dEnd >= -DAY_END_BEFORE_MIN && dEnd <= DAY_END_AFTER_MIN;
    if (inStart && inEnd) return Math.abs(dStart) <= Math.abs(dEnd) ? "START" : "END";
    if (inStart) return "START";
    if (inEnd) return "END";
  }
  return null;
}

// ¿Humand ya tiene un fichaje del mismo tipo a ±MANUAL_MATCH_MS de esta marca?
// (se mira el día de la marca y el anterior, por los turnos que cruzan medianoche).
// Ante cualquier duda o error de consulta devuelve false: la marca sigue trabada.
const MANUAL_MATCH_MS = 5 * 60 * 1000;

async function humandAlreadyHasPunch(clockConfig, employeeInternalId, recordTime, direction, cache, runLog) {
  const days = [
    argentinaDateKey(recordTime),
    argentinaDateKey(new Date(recordTime.getTime() - 24 * 60 * 60 * 1000)),
  ];
  for (const dateKey of days) {
    const summary = await fetchDaySummaryCached(clockConfig, employeeInternalId, dateKey, cache, runLog);
    if (!summary || !Array.isArray(summary.entries)) continue;
    const hit = summary.entries.some(
      (e) => e.type === direction && Math.abs(Date.parse(e.time) - recordTime.getTime()) <= MANUAL_MATCH_MS
    );
    if (hit) return true;
  }
  return false;
}

// Una marca que por horario es la MISMA dirección que la última enviada y cae
// a menos de este margen es un doble fichaje (otro reloj, otro toque), no un
// evento nuevo: se descarta como rebote en vez de mandarla (daría 422).
const SAME_DIRECTION_REBOUND_MS = 30 * 60 * 1000;

// --- Marcas sospechosas (9/10, casos Empleado E y Empleada D) ---
// Una marca de más invierte la alternancia y todo lo que sigue sale al revés
// sin que nadie se entere hasta que el cliente reclama. Para detectarlo el
// mismo día: si la dirección elegida (START/END) cae a más de
// SUSPECT_PUNCH_TOLERANCE_MIN del inicio/fin del horario del día en Humand
// (ej. una "salida" a las 09:28 con turno hasta las 17:00), se registra en
// clock.suspectPunches y se muestra en el panel. SOLO ALERTA: no cambia qué
// se envía ni la alternancia. Sin horario cargado, no se evalúa.
const SUSPECT_PUNCH_TOLERANCE_MIN = 240;
const SUSPECT_PUNCH_TTL_MS = 48 * 60 * 60 * 1000;

function suspectPunchReason(summary, recordTime, direction) {
  if (!summary || !summary.hasSchedule || !Array.isArray(summary.timeSlots) || !summary.timeSlots.length) return null;
  const m = minutesOfDayArgentina(recordTime);
  let best = null;
  for (const sl of summary.timeSlots) {
    const target = hhmmToMinutes(direction === "START" ? sl.startTime : sl.endTime);
    if (target == null) continue;
    const d = Math.abs(circularDiffMin(m, target));
    if (best == null || d < best.diff) best = { diff: d, slot: sl };
  }
  if (!best || best.diff <= SUSPECT_PUNCH_TOLERANCE_MIN) return null;
  return {
    slot: `${best.slot.startTime}-${best.slot.endTime}`,
    diffHours: Math.round((best.diff / 60) * 10) / 10,
  };
}

// --- Marcas "trabadas" por 422 TIME_TRACKING_ENTRY_DUPLICATE (caso EMPAQUE, 30/9) ---
// Cuando Humand rechaza una marca por duplicada (dos entradas o dos salidas
// seguidas), el estado no avanza y la marca quedaba reintentándose en cada
// ciclo para siempre, mezclada con los errores reales (el reloj quedaba en
// "error" todo el tiempo). Peor: con onlyToday, al pasar la medianoche el cron
// dejaba de mirarla, el 422 desaparecía y el panel mostraba "OK" aunque la
// marca seguía sin llegar a Humand (verificado el 1/10 con el DNI <DNI-1>).
// Ahora se guarda en clock.stuckPunches (persiste entre ciclos y días), se
// muestra aparte de los errores, se sigue reintentando aunque ya no sea "de
// hoy" y, tras STUCK_FAST_RETRY_ATTEMPTS intentos, solo se reintenta cada
// STUCK_SLOW_RETRY_MS. La marca NUNCA se descarta ni se inventa una salida:
// la corrección de asistencia se hace a mano en Humand y esta se reenvía sola.
const STUCK_FAST_RETRY_ATTEMPTS = 4;
const STUCK_SLOW_RETRY_MS = 3 * 60 * 60 * 1000;

function isDuplicateEntryRejection(err) {
  return err && err.status === 422 && err.body && err.body.code === "TIME_TRACKING_ENTRY_DUPLICATE";
}

function shouldRetryStuckPunch(entry, nowMs) {
  if (!entry) return true;
  if (entry.attempts < STUCK_FAST_RETRY_ATTEMPTS) return true;
  return nowMs - Date.parse(entry.lastAttemptAt) >= STUCK_SLOW_RETRY_MS;
}

// Corre un ciclo de sincronización para un reloj configurado:
// 1) se conecta al reloj por IP:puerto y descarga TODAS las marcaciones que tiene guardadas
// 2) descarta las que ya se enviaron antes (usando userSn + recordTime como clave)
// 3) mapea el "ID de Usuario" del reloj al employeeInternalId de Humand según la tabla de mapeo
// 4) infiere START/END por alternancia y envía cada marcación nueva a Humand (o la loguea, en dry-run)
// 5) guarda el estado (últimas claves ya enviadas + alternancia + resultado del último intento)
//
// options.onlyToday: si es true, ignora (sin marcarlas como enviadas ni
// como "sin mapear" — quedan intactas para un sync posterior) las
// marcaciones que no sean del día calendario actual en Argentina. Pensado
// para la primera activación en real: mandar solo lo de hoy para los
// usuarios ya mapeados, sin arrastrar de un saque todo el historial
// pendiente del reloj.
async function syncClock(clockId, options = {}) {
  const { onlyToday = false } = options;
  const clock = await getClock(clockId);
  if (!clock) throw new Error(`Reloj ${clockId} no encontrado`);

  const runLog = {
    startedAt: new Date().toISOString(),
    sent: 0,
    skipped: 0,
    unmapped: 0,
    notClaimed: 0,
    duplicates: 0,
    openShifts: [],
    missingCheckIns: [],
    stuckPunches: [],
    nightShiftCorrections: [],
    suspectPunches: [],
    errors: [],
  };

  let logs = [];
  try {
    logs = await fetchAttendanceLogs(clock.ip, clock.port);
  } catch (err) {
    runLog.errors.push(`No se pudo conectar al reloj: ${err.message || err}`);
    clock.lastRun = runLog;
    clock.status = "error";
    await upsertClock(clock);
    return runLog;
  }

  // Orden cronológico ascendente: imprescindible para que la alternancia
  // START/END por empleado sea correcta (si llegaran desordenados, un START
  // podría procesarse después de su propio END).
  logs.sort((a, b) => a.recordTime.getTime() - b.recordTime.getTime());

  // Best-effort: además de las marcaciones, traemos los perfiles enrolados
  // en el propio reloj (nombre que el instalador cargó ahí) para no
  // depender de que el cliente nos diga a mano "el ID 101 es Fulano" — ver
  // la nota grande en lib/zkteco.js sobre por qué userId == deviceUserId. Si
  // esto falla no aborta el sync (las marcaciones ya se trajeron bien).
  try {
    const deviceUsers = await fetchDeviceUsers(clock.ip, clock.port);
    clock.deviceUserNames = Object.fromEntries(
      deviceUsers.filter((u) => u.name).map((u) => [u.deviceUserId, u.name])
    );
  } catch (err) {
    runLog.errors.push(`No se pudieron traer los nombres enrolados en el reloj: ${err.message || err}`);
  }

  const alreadySent = new Set(clock.sentKeys || []);
  const userMap = clock.userMap || {}; // { deviceUserId: employeeInternalId de Humand }
  const newSentKeys = [...alreadySent];
  const seenDeviceIds = new Set();
  const seenKeys = new Set();
  const stuck = { ...(clock.stuckPunches || {}) }; // key -> marca rechazada por 422 duplicado
  const suspects = { ...(clock.suspectPunches || {}) }; // key -> marca lejos del horario (solo alerta)
  let rateLimited = false;

  const today = argentinaDateKey(new Date());

  // Cache en memoria del estado compartido por empleado, para no pegarle a
  // la base en cada línea del reloj si el mismo empleado marca varias veces
  // en esta corrida (se lee una vez por empleado y se persiste en cada
  // cambio real, ver más abajo).
  const clientKey = clientKeyFor(clock);
  const stateCache = new Map(); // employeeInternalId -> estado o null
  const daySummaryCache = new Map(); // "employeeInternalId|fecha" -> Promise<resumen o null>, ver fetchDaySummaryCached
  async function getState(employeeInternalId) {
    if (!stateCache.has(employeeInternalId)) {
      stateCache.set(employeeInternalId, await getEmployeeState(clientKey, employeeInternalId));
    }
    return stateCache.get(employeeInternalId);
  }
  async function setState(employeeInternalId, state) {
    stateCache.set(employeeInternalId, state);
    await upsertEmployeeState(clientKey, employeeInternalId, state);
  }

  for (const log of logs) {
    seenDeviceIds.add(log.deviceUserId);
    const key = `${log.userSn}-${log.recordTime.getTime()}`;
    seenKeys.add(key);

    if (onlyToday && argentinaDateKey(log.recordTime) !== today && !stuck[key]) {
      // No es de hoy: se deja completamente afuera de este ciclo (ni
      // enviada ni contada como pendiente) — un sync sin onlyToday más
      // adelante la va a recoger igual, porque nunca se marcó como enviada.
      // Excepción: una marca trabada por 422 se sigue reintentando aunque
      // ya no sea de hoy (ver nota de STUCK_FAST_RETRY_ATTEMPTS).
      continue;
    }

    if (rateLimited) {
      // Ya nos frenó un 429 en este ciclo: no seguimos insistiendo, el
      // próximo disparo del cron retoma desde donde quedó (nada se marcó
      // como enviado todavía).
      break;
    }

    if (alreadySent.has(key)) {
      delete stuck[key];
      runLog.skipped++;
      continue;
    }

    if (stuck[key] && !shouldRetryStuckPunch(stuck[key], Date.now())) {
      continue; // backoff: sigue trabada, se reintenta más adelante
    }

    const mappedUserId = userMap[log.deviceUserId];
    if (!mappedUserId) {
      runLog.unmapped++;
      continue; // no se envía hasta que el ID del reloj esté mapeado a un usuario de Humand
    }

    const employeeState = await getState(mappedUserId);

    if (isDuplicatePunch(employeeState, log.recordTime)) {
      // Rebote del lector (ver nota grande arriba de isDuplicatePunch): se
      // marca como procesada para no reintentarla en cada ciclo, pero no se
      // manda a Humand ni se mueve la alternancia START/END.
      runLog.duplicates++;
      newSentKeys.push(key);
      continue;
    }

    let direction = peekDirection(employeeState, log.recordTime);

    // Turnos nocturnos: la hora de la marca respecto del horario manda sobre
    // la alternancia (ver nota de nightShiftDirectionByWindow).
    const nightDirection = await nightShiftDirectionByWindow(
      clock,
      mappedUserId,
      log.recordTime,
      daySummaryCache,
      runLog
    );
    if (nightDirection && nightDirection !== direction) {
      runLog.nightShiftCorrections.push({
        employeeInternalId: mappedUserId,
        name: clock.deviceUserNames?.[log.deviceUserId] || null,
        recordTime: log.recordTime.toISOString(),
        alternation: direction,
        byNightShift: nightDirection,
      });
      direction = nightDirection;
    }

    // Turnos diurnos (ver dayShiftDirectionByWindow): solo si no hubo
    // dirección nocturna para esta marca.
    let scheduleDirection = nightDirection;
    if (!nightDirection) {
      const dayDirection = await dayShiftDirectionByWindow(
        clock,
        mappedUserId,
        log.recordTime,
        daySummaryCache,
        runLog
      );
      // Una "salida" como PRIMERA marca del día es el caso de la entrada
      // olvidada: lo gobierna lateLonePunchCheckoutEnabled, no esta regla.
      const sameDayState = employeeState && employeeState.date === argentinaDateKey(log.recordTime);
      if (dayDirection && (dayDirection === "START" || sameDayState)) {
        scheduleDirection = dayDirection;
        if (dayDirection !== direction) {
          runLog.nightShiftCorrections.push({
            employeeInternalId: mappedUserId,
            name: clock.deviceUserNames?.[log.deviceUserId] || null,
            recordTime: log.recordTime.toISOString(),
            alternation: direction,
            byDayShift: dayDirection,
          });
          direction = dayDirection;
        }
      }
    }

    if (
      scheduleDirection &&
      employeeState &&
      employeeState.lastType === scheduleDirection &&
      typeof employeeState.lastRecordTimeMs === "number" &&
      log.recordTime.getTime() - employeeState.lastRecordTimeMs >= 0 &&
      log.recordTime.getTime() - employeeState.lastRecordTimeMs < SAME_DIRECTION_REBOUND_MS
    ) {
      runLog.duplicates++;
      newSentKeys.push(key);
      continue;
    }

    // Ver la nota grande de shouldReclassifyLonePunchAsCheckout más arriba:
    // esto SOLO debe evaluarse para la primera marca del día de este
    // empleado (no para un START posterior por alternancia, ej. la vuelta
    // del almuerzo) — por eso se recalcula la condición de "primera marca"
    // acá en vez de reusar `direction === "START"` (que también es true en
    // ese otro caso).
    const isFirstPunchOfDayForEmployee =
      !employeeState || employeeState.date !== argentinaDateKey(log.recordTime);

    if (isFirstPunchOfDayForEmployee && isLateLonePunchCheckoutEnabled(clock)) {
      const reclassify = await shouldReclassifyLonePunchAsCheckout(
        clock,
        mappedUserId,
        log.recordTime,
        daySummaryCache,
        runLog
      );
      if (reclassify) {
        direction = "END";
        runLog.missingCheckIns.push({
          employeeInternalId: mappedUserId,
          name: clock.deviceUserNames?.[log.deviceUserId] || null,
          recordTime: log.recordTime.toISOString(),
        });
      }
    }

    const suspectSummary = await fetchDaySummaryCached(
      clock,
      mappedUserId,
      argentinaDateKey(log.recordTime),
      daySummaryCache,
      runLog
    );
    const suspect = suspectPunchReason(suspectSummary, log.recordTime, direction);
    if (suspect) {
      suspects[key] = {
        key,
        employeeInternalId: mappedUserId,
        name: clock.deviceUserNames?.[log.deviceUserId] || null,
        recordTime: log.recordTime.toISOString(),
        direction,
        schedule: suspect.slot,
        diffHours: suspect.diffHours,
      };
    }

    try {
      const result = await postClockEvent(clock, { ...log, mappedUserId, direction });
      // ⚠️ CORREGIDO 18/8: antes esto se hacía siempre, incluso en dry-run —
      // significaba que una vez que HUMAND_DRY_RUN pasara a false, estas
      // marcaciones ya iban a figurar como "ya enviadas" (por el dedup de
      // sentKeys) y JAMÁS se mandarían de verdad a Humand. El dry-run tiene
      // que ser una simulación repetible que no consuma el estado real: solo
      // se marca como enviado (sentKeys + alternancia START/END) cuando el
      // POST fue real.
      if (!result.dryRun) {
        await setState(mappedUserId, nextState(log.recordTime, direction));
        newSentKeys.push(key);
        delete stuck[key];
      }
      runLog.sent++;
    } catch (err) {
      if (err.status === 429) {
        rateLimited = true;
        runLog.errors.push("Humand devolvió 429 (rate limit) — se corta este ciclo, se reintenta en el próximo.");
        break;
      }
      if (err.userNotClaimed) {
        // No es un error del conector: la persona todavía no activó su
        // cuenta de Humand (ver resolveEmployeeId en lib/humandClient.js).
        // Se cuenta aparte para no mezclarlo con errores reales — la
        // marcación queda pendiente, se reintenta sola en cuanto la
        // persona reclame la cuenta.
        runLog.notClaimed++;
        continue;
      }
      if (isDuplicateEntryRejection(err)) {
        // Humand ya tiene algo abierto/cerrado que choca con esta marca: no
        // es un error del conector ni se arregla reintentando. Se registra
        // aparte para que alguien corrija el turno en Humand (ver nota de
        // STUCK_FAST_RETRY_ATTEMPTS). El estado NO avanza.
        // Si Humand YA tiene este mismo fichaje (alguien lo corrigió a mano),
        // no hay nada que reenviar: se da por resuelta, se limpia de las
        // trabadas y el estado se alinea con lo que Humand realmente tiene
        // (si esta marca es más nueva que el estado guardado).
        if (await humandAlreadyHasPunch(clock, mappedUserId, log.recordTime, direction, daySummaryCache, runLog)) {
          if (!employeeState || !(employeeState.lastRecordTimeMs > log.recordTime.getTime())) {
            await setState(mappedUserId, nextState(log.recordTime, direction));
          }
          newSentKeys.push(key);
          delete stuck[key];
          runLog.resolvedManually = (runLog.resolvedManually || 0) + 1;
          continue;
        }
        const prev = stuck[key];
        const nowIso = new Date().toISOString();
        stuck[key] = {
          key,
          deviceUserId: log.deviceUserId,
          employeeInternalId: mappedUserId,
          name: clock.deviceUserNames?.[log.deviceUserId] || null,
          recordTime: log.recordTime.toISOString(),
          direction,
          lastType: employeeState?.lastType || null,
          hoursSinceLastPunch:
            employeeState && typeof employeeState.lastRecordTimeMs === "number"
              ? Math.round(((log.recordTime.getTime() - employeeState.lastRecordTimeMs) / 3600e3) * 10) / 10
              : null,
          attempts: (prev?.attempts || 0) + 1,
          firstSeenAt: prev?.firstSeenAt || nowIso,
          lastAttemptAt: nowIso,
        };
        continue;
      }
      runLog.errors.push(`deviceUserId ${log.deviceUserId} @ ${log.recordTime.toISOString()}: ${err.message || err}`);
    }
  }

  // Una marca trabada que ya no está en el reloj (lo vaciaron) no se puede
  // reintentar: se descarta del registro.
  for (const key of Object.keys(stuck)) {
    if (!seenKeys.has(key)) delete stuck[key];
  }
  clock.stuckPunches = stuck;
  runLog.stuckPunches = Object.values(stuck);
  for (const k of Object.keys(suspects)) {
    if (Date.now() - Date.parse(suspects[k].recordTime) > SUSPECT_PUNCH_TTL_MS) delete suspects[k];
  }
  clock.suspectPunches = suspects;
  runLog.suspectPunches = Object.values(suspects);

  // Chequeo de turnos abiertos (ver nota grande de STALE_OPEN_SHIFT_MS más
  // arriba): recorre a los empleados mapeados en este reloj — no solo a los
  // que tuvieron una marca nueva en esta corrida — porque alguien puede
  // haber quedado con el turno abierto de un ciclo anterior sin volver a
  // fichar todavía.
  const now = Date.now();
  const alreadyChecked = new Set();
  for (const employeeInternalId of Object.values(userMap)) {
    if (alreadyChecked.has(employeeInternalId)) continue;
    alreadyChecked.add(employeeInternalId);
    const state = await getState(employeeInternalId);
    if (state && state.lastType === "START" && now - state.lastRecordTimeMs > STALE_OPEN_SHIFT_MS) {
      const deviceUserId = Object.keys(userMap).find((id) => userMap[id] === employeeInternalId);
      runLog.openShifts.push({
        employeeInternalId,
        name: (deviceUserId && clock.deviceUserNames?.[deviceUserId]) || null,
        hoursOpen: Math.round(((now - state.lastRecordTimeMs) / (60 * 60 * 1000)) * 10) / 10,
      });
    }
  }

  clock.sentKeys = newSentKeys.slice(-5000); // cap simple para no crecer sin límite
  clock.lastSeenDeviceIds = [...seenDeviceIds].sort();
  clock.lastRun = runLog;
  clock.status = runLog.errors.length ? "error" : runLog.stuckPunches.length ? "warning" : "ok";
  clock.lastSyncAt = new Date().toISOString();
  await upsertClock(clock);
  return runLog;
}

// Recorre todos los relojes configurados y sincroniza cada uno. Esto es lo
// que llama el cron de Vercel en cada disparo (no hay proceso de fondo: cada
// invocación hace una pasada y termina). Los errores de un reloj no frenan
// a los demás.
//
// ⚠️ CORREGIDO 26/8: antes esto era un for secuencial — cada reloj hace 2
// conexiones TCP al dispositivo (marcaciones + usuarios enrolados) con hasta
// DEFAULT_TIMEOUT (10s) cada una, así que en el peor caso 3 relojes ×
// 2 conexiones × 10s = 60s, exactamente el maxDuration del cron
// (vercel.json). Confirmado en producción: /api/cron/sync timeouteaba a los
// 60s y ESO frenaba a los 3 relojes, no solo al lento — el síntoma real
// (reportado por el cliente) fue que el reloj de COMEDOR "no tomaba" una
// marcación real que sí había leído. Al correr los relojes en paralelo, el
// tiempo total queda acotado por el más lento de los tres (peor caso ~20s)
// en vez de la suma de los tres.
async function syncAllClocks(options = {}) {
  const clocks = await readClocks();
  return Promise.all(
    clocks.map(async (clock) => {
      try {
        return { id: clock.id, alias: clock.alias, ...(await syncClock(clock.id, options)) };
      } catch (err) {
        return { id: clock.id, alias: clock.alias, errors: [String(err.message || err)] };
      }
    })
  );
}

// --- Solo para desarrollo local (node server.js) ---
// En Vercel esto no se usa: no hay proceso persistente donde mantener un
// setInterval entre invocaciones. Ahí la periodicidad la da Vercel Cron
// llamando a /api/cron/sync, que internamente llama a syncAllClocks() una
// vez por invocación.
const activeIntervals = new Map();

function scheduleClock(clock) {
  if (activeIntervals.has(clock.id)) {
    clearInterval(activeIntervals.get(clock.id));
  }
  const ms = Math.max(1, Number(clock.pollIntervalMinutes) || 5) * 60 * 1000;
  const handle = setInterval(() => {
    syncClock(clock.id).catch((err) => console.error(`[poller] error en ${clock.id}:`, err));
  }, ms);
  activeIntervals.set(clock.id, handle);
}

async function scheduleAll() {
  const clocks = await readClocks();
  clocks.forEach(scheduleClock);
}

module.exports = {
  syncClock,
  syncAllClocks,
  scheduleClock,
  scheduleAll,
  peekDirection,
  nextState,
  isDuplicatePunch,
  suspectPunchReason,
  clientKeyFor,
  argentinaLocalTimeToUtcMs,
  isLateLonePunchCheckoutEnabled,
};

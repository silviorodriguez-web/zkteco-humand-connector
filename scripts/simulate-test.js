// Prueba end-to-end del pipeline (mapeo + dedup + dry-run) sin necesitar un
// reloj real ni una base Postgres levantada: reemplaza tanto el reloj
// (lib/zkteco) como la persistencia (lib/store) por versiones en memoria.
// Sirve para validar la lógica antes de conectar infraestructura real.
let nightShiftRecordTimeIso = "2026-09-04T00:00:00Z"; // pisado por cada caso de testNightShiftNotFalselyReclassified

const zktecoPath = require.resolve("../lib/zkteco");
require.cache[zktecoPath] = {
  id: zktecoPath,
  filename: zktecoPath,
  loaded: true,
  exports: {
    // Distinto set de marcaciones según el reloj (por ip) — así se puede
    // simular a un mismo empleado fichando entrada en un reloj y salida en
    // otro (ver testCrossClockAlternation más abajo).
    fetchAttendanceLogs: async (ip) => {
      if (ip === "clock-b.example") {
        return [{ userSn: 1, deviceUserId: "14", recordTime: new Date("2026-08-12T17:00:00Z"), ip }];
      }
      if (ip === "clock-late.example") {
        // Marca única del día, bien después de un fin de turno mockeado de
        // 18:00 ART (21:00 UTC) — ver testLateLonePunchReclassifiedAsCheckout.
        return [{ userSn: 5, deviceUserId: "77", recordTime: new Date("2026-09-04T23:30:00Z"), ip }];
      }
      if (ip === "clock-nightshift.example") {
        // Hora configurable en runtime (ver nightShiftRecordTimeIso más abajo)
        // — turno nocturno real, ver testNightShiftNotFalselyReclassified.
        return [{ userSn: 6, deviceUserId: "88", recordTime: new Date(nightShiftRecordTimeIso), ip }];
      }
      if (ip === "clock-stuck.example") {
        // Entrada del 29/9 03:36 ART ya enviada (estado START) y una marca
        // 35 h después (30/9 14:49 ART) que Humand rechaza por duplicada —
        // caso real EMPAQUE, ver testStuckPunch422.
        return [{ userSn: 9, deviceUserId: "69", recordTime: new Date("2026-09-30T17:49:01Z"), ip }];
      }
      return [
        { userSn: 1, deviceUserId: "14", recordTime: new Date("2026-08-12T08:00:00Z"), ip: "192.0.2.20" },
        { userSn: 2, deviceUserId: "99", recordTime: new Date("2026-08-12T08:05:00Z"), ip: "192.0.2.20" },
      ];
    },
    testConnection: async () => ({ ok: true }),
    fetchDeviceUsers: async () => [
      { deviceUserId: "14", name: "Empleado de Prueba" },
      { deviceUserId: "99", name: "Otro Empleado" },
      { deviceUserId: "77", name: "Empleado Tardío" },
      { deviceUserId: "88", name: "Empleado Turno Nocturno" },
      { deviceUserId: "69", name: "Empleada Trabada" },
    ],
  },
};

// Mockeamos también humandClient: acá simulamos un ENVÍO REAL (dryRun:
// false) para poder probar el dedup de verdad — desde el fix del 18/8, el
// dry-run YA NO consume sentKeys (es una simulación repetible, ver la nota
// grande en lib/poller.js), así que si dejáramos pasar el DRY_RUN real acá
// (siempre true porque no hay HUMAND_DRY_RUN=false en este proceso), el
// test de dedup dejaría de tener sentido.
// getDaySummary es configurable en runtime (ver daySummaryResponder más
// abajo) porque distintos tests necesitan simular distintos horarios
// programados — por defecto devuelve null (sin horario cargado), que es
// justamente el fallback esperado: sin day-summaries, la lógica nueva de
// lib/poller.js no debe cambiar nada del comportamiento ya probado acá
// (testDirectionAlternation, RUN 1/2, testCrossClockAlternation).
let daySummaryResponder = async () => null;

let postClockEventImpl = async () => ({ ok: true, dryRun: false, simulated: true });

const humandClientPath = require.resolve("../lib/humandClient");
require.cache[humandClientPath] = {
  id: humandClientPath,
  filename: humandClientPath,
  loaded: true,
  exports: {
    postClockEvent: async (clockConfig, event) => postClockEventImpl(clockConfig, event),
    findUserByIdentifier: async () => null,
    listCommunityUsers: async () => [],
    getDaySummary: async (clockConfig, employeeInternalId, referenceDate) =>
      daySummaryResponder(clockConfig, employeeInternalId, referenceDate),
    DRY_RUN: false,
    DEFAULT_BASE_URL: "https://api-prod.humand.co/public/api/v1",
  },
};

const memory = new Map();
const employeeStateMemory = new Map(); // "clientKey|employeeInternalId" -> data
const storePath = require.resolve("../lib/store");
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    readClocks: async () => [...memory.values()],
    upsertClock: async (clock) => {
      memory.set(clock.id, clock);
      return clock;
    },
    getClock: async (id) => memory.get(id),
    deleteClock: async (id) => memory.delete(id),
    getEmployeeState: async (clientKey, employeeInternalId) =>
      employeeStateMemory.get(`${clientKey}|${employeeInternalId}`) || null,
    upsertEmployeeState: async (clientKey, employeeInternalId, data) => {
      employeeStateMemory.set(`${clientKey}|${employeeInternalId}`, data);
    },
  },
};

const { syncClock, syncAllClocks, peekDirection, nextState, argentinaLocalTimeToUtcMs } = require("../lib/poller");
const { upsertClock, deleteClock, getEmployeeState } = require("../lib/store");

// Sanity check de la conversión de hora local Argentina -> UTC (ver la nota
// grande en lib/poller.js) — ya hubo un bug real de zona horaria en este
// proyecto (commit 5cd8359), así que esto se prueba aislado y sin mocks.
function testArgentinaLocalTimeToUtcMs() {
  const ms = argentinaLocalTimeToUtcMs("2026-08-25", "14:30");
  const iso = new Date(ms).toISOString();
  if (iso !== "2026-08-25T17:30:00.000Z") {
    throw new Error(`argentinaLocalTimeToUtcMs: se esperaba 2026-08-25T17:30:00.000Z, dio ${iso}`);
  }
  if (argentinaLocalTimeToUtcMs("2026-08-25", "no-es-una-hora") !== null) {
    throw new Error("argentinaLocalTimeToUtcMs: debería devolver null ante un formato inválido");
  }
  console.log("OK: argentinaLocalTimeToUtcMs convierte hora local Argentina (UTC-3) a UTC correctamente.");
}

// Regresión del incidente real del 14/9 (reportado por el cliente, Empleado C
// Apellido en LABORATORIO 4): entrada 11:11 ART y salida 22:41 ART DEL MISMO
// DÍA ARGENTINO, pero 22:41 ART = 01:41 UTC del día SIGUIENTE. Antes del fix
// del 15/9, peekDirection/nextState comparaban el día calendario en UTC, así
// que la salida se veía como "primera marca de un día nuevo" y se clasificaba
// como START (entrada) en vez de END — Humand la rechazaba por duplicada y la
// salida real se perdía. Este test fija el comportamiento correcto para
// cualquier marca entre las 21:00 y 23:59 ART.
function testEveningExitAcrossUtcMidnight() {
  let state = null;
  const entrada = new Date("2026-09-14T14:11:43.000Z"); // 11:11:43 ART
  const salida = new Date("2026-09-15T01:41:27.000Z"); // 22:41:27 ART, mismo día argentino que la entrada

  const d1 = peekDirection(state, entrada);
  if (d1 !== "START") throw new Error(`entrada 11:11 ART debería ser START, dio ${d1}`);
  state = nextState(entrada, d1);

  const d2 = peekDirection(state, salida);
  if (d2 !== "END") {
    throw new Error(
      `salida 22:41 ART (01:41 UTC del día siguiente) debería seguir siendo END del mismo turno, dio ${d2}`
    );
  }

  console.log("OK: una salida entre las 21:00 y 23:59 ART no se reclasifica como entrada por cruzar la medianoche UTC.");
}

// Regresión del incidente real del 28/9 (reportado por el cliente: Empleado B
// Apellido y Empleado A, ambos con Horario Nocturno 21:30-06:30): entrada
// viernes 21:28 ART, salida sábado 06:41 ART — cruza la medianoche
// ARGENTINA (no solo la UTC, que ya estaba cubierto por
// testEveningExitAcrossUtcMidnight). Antes del fix del 28/9, peekDirection
// veía la salida como "primera marca de un día nuevo" y devolvía START;
// Humand la rechazaba como entrada duplicada y el turno quedaba abierto
// para siempre. Ver la nota grande de MAX_SHIFT_EXTENSION_MS en
// lib/poller.js.
function testOvernightShiftCheckoutNotMisclassifiedAsNewEntry() {
  let state = null;
  const entrada = new Date("2026-09-26T00:28:00.000Z"); // 21:28 ART viernes 25/9
  const salida = new Date("2026-09-26T09:41:00.000Z"); // 06:41 ART sábado 26/9

  const d1 = peekDirection(state, entrada);
  if (d1 !== "START") throw new Error(`entrada 21:28 ART debería ser START, dio ${d1}`);
  state = nextState(entrada, d1);

  const d2 = peekDirection(state, salida);
  if (d2 !== "END") {
    throw new Error(
      `salida 06:41 ART del día siguiente (cierre de turno nocturno) debería ser END, dio ${d2}`
    );
  }

  console.log(
    "OK: la salida de un turno nocturno que cruza la medianoche ARGENTINA no se reclasifica como una entrada nueva."
  );
}

function testDirectionAlternation() {
  let state = null;
  const t1 = new Date("2026-08-12T08:00:00Z");
  const t2 = new Date("2026-08-12T12:00:00Z");
  const t3 = new Date("2026-08-12T13:00:00Z");
  const t4NextDay = new Date("2026-08-13T08:00:00Z");

  const d1 = peekDirection(state, t1);
  if (d1 !== "START") throw new Error("primera marca del día debería ser START");
  state = nextState(t1, d1);

  const d2 = peekDirection(state, t2);
  if (d2 !== "END") throw new Error("segunda marca del día debería ser END");
  state = nextState(t2, d2);

  const d3 = peekDirection(state, t3);
  if (d3 !== "START") throw new Error("tercera marca del día debería volver a START (ej. vuelta de almuerzo)");
  state = nextState(t3, d3);

  const d4 = peekDirection(state, t4NextDay);
  if (d4 !== "START") throw new Error("primera marca de un día nuevo debería resetear a START");

  console.log("OK: alternancia START/END por empleado y por día funciona como se espera.");
}

// 9/10, casos Empleada D y Empleado E: marca pegada a una salida = rebote; marca
// lejos del horario = alerta (sin cambiar lo que se envía).
function testPostExitReboundAndSuspectPunch() {
  const { isDuplicatePunch, suspectPunchReason } = require("../lib/poller");
  const end = { date: "2026-10-08", lastType: "END", lastRecordTimeMs: Date.parse("2026-10-08T18:35:57Z") };
  const start = { ...end, lastType: "START" };
  if (!isDuplicatePunch(end, new Date("2026-10-08T18:42:05Z"))) throw new Error("marca 6 min después de una salida debía ser rebote");
  if (isDuplicatePunch(end, new Date("2026-10-08T18:50:00Z"))) throw new Error("marca 14 min después de una salida NO es rebote");
  if (isDuplicatePunch(start, new Date("2026-10-08T18:42:05Z"))) throw new Error("marca pegada a una ENTRADA no es rebote");
  const sergio = { hasSchedule: true, timeSlots: [{ startTime: "08:00", endTime: "17:00" }] };
  if (suspectPunchReason(sergio, new Date("2026-10-08T12:28:13Z"), "END") === null) throw new Error("salida 09:28 con turno hasta 17:00 debía ser sospechosa");
  if (suspectPunchReason(sergio, new Date("2026-10-08T09:48:44Z"), "START")) throw new Error("entrada 06:48 con turno 08:00 NO es sospechosa");
  if (suspectPunchReason(sergio, new Date("2026-10-08T20:00:00Z"), "END")) throw new Error("salida 17:00 NO es sospechosa");
  if (suspectPunchReason(null, new Date(), "END") || suspectPunchReason({ hasSchedule: false }, new Date(), "END")) throw new Error("sin horario no se evalúa");
  const marcela = { hasSchedule: true, timeSlots: [{ startTime: "02:30", endTime: "11:30" }] };
  if (suspectPunchReason(marcela, new Date("2026-10-09T03:59:40Z"), "END") === null) throw new Error("'salida' 00:59 con turno 02:30-11:30 debía ser sospechosa");
  if (suspectPunchReason(marcela, new Date("2026-10-09T03:59:40Z"), "START")) throw new Error("entrada 00:59 con turno 02:30 NO es sospechosa");
  console.log("OK: rebote post-salida (<10 min) y alerta de marca lejos del horario (casos Empleada D y Empleado E).");
}

// Caso real reportado por el cliente el 19/8: un empleado puede fichar
// entrada en un reloj y salida en OTRO. Antes del fix, cada reloj llevaba su
// propia alternancia y esto mandaba dos entradas en vez de entrada+salida.
async function testCrossClockAlternation() {
  const clockA = {
    id: "sim-clock-a",
    alias: "Reloj A",
    clientName: "Cliente Multi-Reloj",
    ip: "clock-a.example",
    port: 4370,
    humandApiKey: "k",
    pollIntervalMinutes: 5,
    userMap: { 14: "legajo-001" },
    sentKeys: [],
  };
  const clockB = {
    id: "sim-clock-b",
    alias: "Reloj B",
    clientName: "Cliente Multi-Reloj", // mismo cliente que clockA a propósito
    ip: "clock-b.example",
    port: 4370,
    humandApiKey: "k",
    pollIntervalMinutes: 5,
    userMap: { 14: "legajo-001" }, // mismo empleado, mapeado también en este reloj
    sentKeys: [],
  };
  await upsertClock(clockA);
  await upsertClock(clockB);

  const runA = await syncClock("sim-clock-a"); // marca de las 08:00 -> debería salir como entrada
  const runB = await syncClock("sim-clock-b"); // marca de las 17:00 en OTRO reloj -> debería salir como salida

  if (runA.sent !== 1) throw new Error("cross-clock: el reloj A debería haber mandado 1 marca");
  if (runB.sent !== 1) throw new Error("cross-clock: el reloj B debería haber mandado 1 marca");

  const state = await getEmployeeState("client:Cliente Multi-Reloj", "legajo-001");
  if (!state || state.lastType !== "END") {
    throw new Error(
      `cross-clock: se esperaba que la alternancia terminara en END (entrada en A + salida en B), pero quedó en ${JSON.stringify(state)}`
    );
  }

  await deleteClock("sim-clock-a");
  await deleteClock("sim-clock-b");
  console.log("OK: un empleado que ficha entrada en un reloj y salida en otro se procesa como un solo turno (estado compartido por cliente).");
}

// Caso reportado por el cliente (el cliente, vía CX): alguien se olvida de
// fichar la entrada y su única marca del día es, en realidad, la salida.
// Antes de este fix, peekDirection la tomaba ciegamente como START (entrada)
// por ser la primera del día. Con lateLonePunchCheckoutEnabled + un horario
// programado (mockeado acá vía daySummaryResponder) que ya terminó bien
// antes de la marca, debería reclasificarse como END (salida) y quedar
// registrada en runLog.missingCheckIns.
async function testLateLonePunchReclassifiedAsCheckout() {
  daySummaryResponder = async (_clockConfig, employeeInternalId) => {
    if (employeeInternalId !== "legajo-tardio") return null;
    // entries: [] a propósito — Humand también coincide en que no hay ningún
    // fichaje cargado ese día (ver la nota grande de
    // shouldReclassifyLonePunchAsCheckout sobre por qué esto es necesario).
    return { hasSchedule: true, timeSlots: [{ startTime: "09:00", endTime: "18:00" }], entries: [] }; // ART, ver getDaySummary
  };

  const clock = {
    id: "sim-late-checkout",
    alias: "Simulado Horario",
    clientName: "Test Horario",
    ip: "clock-late.example",
    port: 4370,
    humandApiKey: "k",
    pollIntervalMinutes: 5,
    userMap: { 77: "legajo-tardio" },
    lateLonePunchCheckoutEnabled: true,
    sentKeys: [],
  };
  await upsertClock(clock);

  const run = await syncClock("sim-late-checkout");
  if (run.sent !== 1) throw new Error(`late-checkout: debería haber mandado 1 marca, mandó ${run.sent}`);
  if (!run.missingCheckIns || run.missingCheckIns.length !== 1) {
    throw new Error(`late-checkout: se esperaba 1 entrada en missingCheckIns, quedó ${JSON.stringify(run.missingCheckIns)}`);
  }

  const state = await getEmployeeState("client:Test Horario", "legajo-tardio");
  if (!state || state.lastType !== "END") {
    throw new Error(
      `late-checkout: se esperaba que la alternancia quedara en END (reclasificado como salida), pero quedó en ${JSON.stringify(state)}`
    );
  }

  daySummaryResponder = async () => null; // restaurar el default para no afectar otros tests
  await deleteClock("sim-late-checkout");
  console.log(
    "OK: marca única después del fin de turno programado se reclasifica como salida (no como entrada) y queda marcada en missingCheckIns."
  );
}

// Caso real encontrado el 4/9 validando en vivo contra COMEDOR (cliente
// real): una marca poco después de medianoche UTC pero TODAVÍA dentro
// del mismo día laboral argentino (23:59 ART = 02:59 UTC del día siguiente)
// parece "la primera marca del día" para NUESTRO estado interno (que resetea
// por UTC, ver peekDirection) aunque ese día argentino YA tenga un turno
// completo cargado en Humand. NO debe reclasificarse — si se reclasificara,
// se mandaría un segundo END seguido, que Humand rechaza (422
// TIME_TRACKING_ENTRY_DUPLICATE). Ver la nota grande de
// shouldReclassifyLonePunchAsCheckout.
async function testLateLonePunchNotReclassifiedWhenHumandAlreadyHasEntriesThatDay() {
  daySummaryResponder = async (_clockConfig, employeeInternalId) => {
    if (employeeInternalId !== "legajo-turno-completo") return null;
    return {
      hasSchedule: true,
      timeSlots: [{ startTime: "05:30", endTime: "14:30" }],
      // Humand YA tiene entrada+salida cargadas ese día argentino (ej.
      // enviadas por un ciclo de sync anterior) — por eso NO hay que
      // reclasificar esta marca como si fuera "la primera del día".
      entries: [
        { type: "START", time: "2026-08-31T05:23:17.000Z" },
        { type: "END", time: "2026-08-31T17:30:01.000Z" },
      ],
    };
  };

  const clock = {
    id: "sim-late-checkout-already-has-entries",
    alias: "Simulado Turno Ya Completo",
    clientName: "Test Turno Ya Completo",
    ip: "clock-late.example",
    port: 4370,
    humandApiKey: "k",
    pollIntervalMinutes: 5,
    userMap: { 77: "legajo-turno-completo" },
    lateLonePunchCheckoutEnabled: true,
    sentKeys: [],
  };
  await upsertClock(clock);

  // La marca mockeada de "clock-late.example" (2026-09-04T23:30:00Z) cae en
  // día argentino 2026-09-04 — alcanza para probar el mismo mecanismo aunque
  // las fechas de los `entries` de arriba sean de otro día en este mock.
  const run = await syncClock("sim-late-checkout-already-has-entries");
  if (run.missingCheckIns?.length) {
    throw new Error(
      `turno-ya-completo: NO debería haber reclasificado (Humand ya tiene entries ese día), pero missingCheckIns=${JSON.stringify(run.missingCheckIns)}`
    );
  }

  const state = await getEmployeeState("client:Test Turno Ya Completo", "legajo-turno-completo");
  if (!state || state.lastType !== "START") {
    throw new Error(
      `turno-ya-completo: se esperaba que quedara en START (sin reclasificar), pero quedó en ${JSON.stringify(state)}`
    );
  }

  daySummaryResponder = async () => null;
  await deleteClock("sim-late-checkout-already-has-entries");
  console.log(
    "OK: si Humand ya tiene fichajes cargados ese día argentino, no se reclasifica aunque nuestro estado interno la vea como 'primera marca del día' (evita mandar un segundo END seguido)."
  );
}

// Mismo escenario pero con el flag APAGADO (default): debe comportarse
// exactamente como antes de este fix — primera marca del día = entrada,
// aunque llegue tarde y haya horario cargado. Esto es lo que garantiza que
// activar/desplegar este código no cambia nada para ningún reloj existente
// hasta que alguien prenda el flag a propósito.
async function testLateLonePunchFlagDisabledByDefault() {
  daySummaryResponder = async (_clockConfig, employeeInternalId) => {
    if (employeeInternalId !== "legajo-tardio-2") return null;
    return { hasSchedule: true, timeSlots: [{ startTime: "09:00", endTime: "18:00" }] };
  };

  const clock = {
    id: "sim-late-checkout-off",
    alias: "Simulado Horario (flag apagado)",
    clientName: "Test Horario Flag Apagado",
    ip: "clock-late.example",
    port: 4370,
    humandApiKey: "k",
    pollIntervalMinutes: 5,
    userMap: { 77: "legajo-tardio-2" },
    // lateLonePunchCheckoutEnabled sin setear a propósito: default false
    sentKeys: [],
  };
  await upsertClock(clock);

  const run = await syncClock("sim-late-checkout-off");
  if (run.missingCheckIns?.length) {
    throw new Error(`flag apagado: no debería haber reclasificado nada, pero missingCheckIns=${JSON.stringify(run.missingCheckIns)}`);
  }

  const state = await getEmployeeState("client:Test Horario Flag Apagado", "legajo-tardio-2");
  if (!state || state.lastType !== "START") {
    throw new Error(`flag apagado: se esperaba que quedara en START (comportamiento previo intacto), quedó en ${JSON.stringify(state)}`);
  }

  daySummaryResponder = async () => null;
  await deleteClock("sim-late-checkout-off");
  console.log("OK: con el flag apagado (default), una marca tardía sigue siendo entrada — comportamiento previo intacto.");
}

// Caso real encontrado el 4/9 validando en vivo contra LABORATORIO 4: un
// turno NOCTURNO (cruza medianoche, ej. 21:00-06:00 ART) tiene
// endTime < startTime. Un primer intento de "correr" la fecha un día para
// calcular el fin de turno resultó ambiguo (el día calendario argentino de
// la marca ya pasa a ser el día siguiente antes de llegar a esa hora de fin,
// así que se termina comparando contra el turno de un día que ni empezó
// todavía) y en un caso de prueba mal armado llegó a sugerir reclasificar
// una entrada real — se encontraron 15 falsos positivos así contra datos
// reales antes de desactivar la función a tiempo (nunca se mandó nada real:
// se detectó en dry-run). Se decidió, ante la ambigüedad, NO tocar nada para
// turnos nocturnos — se prueba acá que NINGUNA marca de un empleado con
// turno nocturno se reclasifica, sea a la hora de entrada esperada o mucho
// más tarde.
async function testNightShiftNeverReclassified() {
  daySummaryResponder = async (_clockConfig, employeeInternalId) => {
    if (employeeInternalId !== "legajo-nocturno") return null;
    return { hasSchedule: true, timeSlots: [{ startTime: "21:00", endTime: "06:00" }], entries: [] };
  };

  const clock = {
    id: "sim-nightshift",
    alias: "Simulado Turno Nocturno",
    clientName: "Test Turno Nocturno",
    ip: "clock-nightshift.example",
    port: 4370,
    humandApiKey: "k",
    pollIntervalMinutes: 5,
    userMap: { 88: "legajo-nocturno" },
    lateLonePunchCheckoutEnabled: true,
    sentKeys: [],
  };

  for (const recordTimeIso of [
    "2026-09-04T00:23:00Z", // ~21:23 ART del 3/9 — entrada real, hora esperada del turno
    "2026-09-04T12:00:00Z", // 09:00 ART del 4/9 — bien pasado cualquier fin de turno razonable
  ]) {
    nightShiftRecordTimeIso = recordTimeIso;
    await upsertClock({ ...clock, sentKeys: [] });
    const run = await syncClock("sim-nightshift");
    if (run.missingCheckIns?.length) {
      throw new Error(
        `turno-nocturno (${recordTimeIso}): NO debería haber reclasificado nada, pero missingCheckIns=${JSON.stringify(run.missingCheckIns)}`
      );
    }
    await deleteClock("sim-nightshift");
  }

  daySummaryResponder = async () => null;
  console.log("OK: turno nocturno (21:00-06:00) — nunca se reclasifica, sea la hora que sea (evita el falso positivo encontrado el 4/9).");
}

// Caso EMPAQUE (30/9, verificado el 1/10): Humand rechaza una marca con 422
// TIME_TRACKING_ENTRY_DUPLICATE. Debe (a) no mover employee_state, (b) quedar
// en stuckPunches, (c) no dejar el reloj en "error", (d) seguir reintentándose
// aunque con onlyToday ya no sea "de hoy" (antes desaparecía en silencio a la
// medianoche y el panel mostraba OK), (e) con backoff tras varios intentos, y
// (f) reenviarse y resolverse cuando Humand pasa a aceptar.
async function testStuckPunch422() {
  const realNow = Date.now;
  const baseMs = Date.parse("2026-09-30T18:00:00Z"); // 15:00 ART del 30/9
  let nowMs = baseMs;
  Date.now = () => nowMs;
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
  };
  global.Date.now = () => nowMs;
  global.Date.parse = RealDate.parse;
  global.Date.UTC = RealDate.UTC;

  let posts = 0;
  let humandAccepts = false;
  postClockEventImpl = async () => {
    posts++;
    if (humandAccepts) return { ok: true, dryRun: false };
    const err = new Error("Humand API respondió 422: Can't create two entries of the same type in a row");
    err.status = 422;
    err.body = { code: "TIME_TRACKING_ENTRY_DUPLICATE" };
    throw err;
  };

  try {
    const clock = {
      id: "sim-stuck", alias: "Simulado Trabado", clientName: "Test Trabado",
      ip: "clock-stuck.example", port: 4370, humandApiKey: "k", pollIntervalMinutes: 15,
      userMap: { 69: "legajo-trabado" }, sentKeys: [],
    };
    await upsertClock(clock);
    const staleState = { date: "2026-09-29", lastType: "START", lastRecordTimeMs: Date.parse("2026-09-29T06:36:09Z") };
    await require("../lib/store").upsertEmployeeState("client:Test Trabado", "legajo-trabado", staleState);

    // (a)(b)(c) primer ciclo: el mismo día de la marca
    let run = await syncClock("sim-stuck", { onlyToday: true });
    if (run.sent !== 0 || run.errors.length) throw new Error(`stuck: esperaba sent=0 y sin errors, got ${JSON.stringify(run)}`);
    if (run.stuckPunches.length !== 1 || run.stuckPunches[0].attempts !== 1) throw new Error("stuck: debería haber 1 marca trabada con attempts=1");
    if ((await getEmployeeState("client:Test Trabado", "legajo-trabado")).lastRecordTimeMs !== staleState.lastRecordTimeMs) {
      throw new Error("stuck: employee_state NO debería moverse ante un 422");
    }
    if ((await require("../lib/store").getClock("sim-stuck")).status !== "warning") throw new Error("stuck: el reloj debería quedar en 'warning', no 'error'");

    // (d) al día siguiente con onlyToday la marca ya no es de hoy, pero sigue trabada y se reintenta
    nowMs = Date.parse("2026-10-01T13:00:00Z");
    posts = 0;
    run = await syncClock("sim-stuck", { onlyToday: true });
    if (posts !== 1 || run.stuckPunches.length !== 1 || run.stuckPunches[0].attempts !== 2) {
      throw new Error(`stuck: al día siguiente debe reintentarse (posts=${posts}, stuck=${JSON.stringify(run.stuckPunches)})`);
    }

    // (e) backoff: tras 4 intentos solo reintenta cada 3 h
    for (let i = 0; i < 2; i++) { nowMs += 15 * 60e3; await syncClock("sim-stuck", { onlyToday: true }); }
    posts = 0;
    nowMs += 15 * 60e3;
    run = await syncClock("sim-stuck", { onlyToday: true });
    if (posts !== 0 || run.stuckPunches.length !== 1) throw new Error(`stuck: con backoff no debía reintentar a los 15 min (posts=${posts})`);
    nowMs += 3 * 3600e3;
    run = await syncClock("sim-stuck", { onlyToday: true });
    if (posts !== 1) throw new Error(`stuck: pasadas 3 h debía reintentar (posts=${posts})`);

    // (f) Humand lo corrigió a mano: se reenvía sola y se limpia
    humandAccepts = true;
    nowMs += 3 * 3600e3;
    run = await syncClock("sim-stuck", { onlyToday: true });
    if (run.sent !== 1 || run.stuckPunches.length !== 0) throw new Error(`stuck: debía enviarse y limpiarse (${JSON.stringify(run)})`);
    const st = await getEmployeeState("client:Test Trabado", "legajo-trabado");
    if (st.lastType !== "START" || st.date !== "2026-09-30") throw new Error(`stuck: estado final inesperado ${JSON.stringify(st)}`);
    if ((await require("../lib/store").getClock("sim-stuck")).status !== "ok") throw new Error("stuck: el reloj debía volver a 'ok'");
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
    postClockEventImpl = async () => ({ ok: true, dryRun: false, simulated: true });
    await deleteClock("sim-stuck");
  }
  console.log("OK: 422 duplicado — no mueve estado, queda trabada (warning), persiste tras medianoche, backoff y se resuelve sola.");
}

// Turnos nocturnos (1/10, caso A/B): con horario nocturno cargado en
// Humand, la dirección sale de la hora de la marca respecto del turno, no de
// una alternancia que pudo quedar invertida. Sin horario nocturno, no cambia
// nada.
async function testNightShiftDirectionByWindow() {
  const store = require("../lib/store");
  const cases = [
    // [descripción, ART de la marca, estado previo, esperado, ¿tiene horario nocturno?]
    ["entrada nocturna con estado invertido (salida guardada como START)", "2026-10-02T00:50:00Z", null, { date: "2026-10-01", lastType: "START", hm: "2026-10-01T10:18:00Z" }, "START", true],
    ["salida de la mañana con estado invertido (última marca END)", "2026-10-02T09:40:00Z", null, { date: "2026-10-01", lastType: "END", hm: "2026-10-01T09:37:00Z" }, "END", true],
    ["entrada nocturna normal (estado END)", "2026-10-01T23:30:00Z", null, { date: "2026-10-01", lastType: "END", hm: "2026-10-01T09:37:00Z" }, "START", true],
    ["fuera de ventanas (14:00 ART) -> sigue la alternancia", "2026-10-01T17:00:00Z", null, { date: "2026-10-01", lastType: "END", hm: "2026-10-01T09:37:00Z" }, "START", true],
    ["sin horario nocturno -> alternancia intacta (START hace 14h = END)", "2026-10-02T09:40:00Z", null, { date: "2026-10-01", lastType: "START", hm: "2026-10-01T23:00:00Z" }, "END", false],
    ["sin horario nocturno, estado invertido NO se toca", "2026-10-02T00:50:00Z", null, { date: "2026-10-01", lastType: "START", hm: "2026-10-01T10:18:00Z" }, "END", false],
  ];
  for (const [desc, iso, , prev, expected, hasNight] of cases) {
    daySummaryResponder = async () =>
      hasNight ? { hasSchedule: true, timeSlots: [{ startTime: "21:30", endTime: "06:30" }], entries: [] } : null;
    nightShiftRecordTimeIso = iso;
    let sentDirection = null;
    postClockEventImpl = async (_c, event) => {
      sentDirection = event.direction;
      return { ok: true, dryRun: false };
    };
    await store.upsertEmployeeState("client:Test NightDir", "legajo-noct", {
      date: prev.date,
      lastType: prev.lastType,
      lastRecordTimeMs: Date.parse(prev.hm),
    });
    await upsertClock({
      id: "sim-nightdir", alias: "Simulado NightDir", clientName: "Test NightDir",
      ip: "clock-nightshift.example", port: 4370, humandApiKey: "k", pollIntervalMinutes: 15,
      userMap: { 88: "legajo-noct" }, sentKeys: [],
    });
    await syncClock("sim-nightdir");
    await deleteClock("sim-nightdir");
    if (sentDirection !== expected) throw new Error(`nocturno (${desc}): esperaba ${expected}, se mandó ${sentDirection}`);
  }
  daySummaryResponder = async () => null;
  postClockEventImpl = async () => ({ ok: true, dryRun: false, simulated: true });
  console.log("OK: turno nocturno — la dirección sale del horario (corrige estado invertido); sin horario nocturno no cambia nada.");
}

// Turnos diurnos (21/10, casos Empleada F / Empleada G y otras 6): con
// horario 05:30-14:30 la dirección sale de la hora de la marca, aunque la
// alternancia haya quedado invertida; un doble fichaje pegado a la entrada
// (otro reloj) se descarta; marcas a media jornada siguen por alternancia.
async function testDayShiftDirectionByWindow() {
  const store = require("../lib/store");
  const cases = [
    // [descripción, instante UTC de la marca, estado previo, esperado (null = no se envía)]
    ["salida 14:33 ART con estado invertido (última START)", "2026-10-21T17:33:00Z", { date: "2026-10-21", lastType: "START", hm: "2026-10-21T08:25:00Z" }, "END"],
    ["salida 14:33 ART con estado normal", "2026-10-21T17:33:00Z", { date: "2026-10-21", lastType: "START", hm: "2026-10-21T08:19:00Z" }, "END"],
    ["entrada 05:25 ART con estado invertido (viene de START de ayer)", "2026-10-21T08:25:00Z", { date: "2026-10-20", lastType: "START", hm: "2026-10-20T17:33:00Z" }, "START"],
    ["2do fichaje 6 min después de la entrada (otro reloj) -> se descarta", "2026-10-21T08:25:00Z", { date: "2026-10-21", lastType: "START", hm: "2026-10-21T08:19:00Z" }, null],
    ["salida a colación 09:41 ART (fuera de ventanas) -> alternancia", "2026-10-21T12:41:00Z", { date: "2026-10-21", lastType: "START", hm: "2026-10-21T08:19:00Z" }, "END"],
    ["vuelta de colación 10:20 ART (fuera de ventanas) -> alternancia", "2026-10-21T13:20:00Z", { date: "2026-10-21", lastType: "END", hm: "2026-10-21T12:41:00Z" }, "START"],
  ];
  for (const [desc, iso, prev, expected] of cases) {
    daySummaryResponder = async () => ({ hasSchedule: true, timeSlots: [{ startTime: "05:30", endTime: "14:30" }], entries: [] });
    nightShiftRecordTimeIso = iso;
    let sentDirection = null;
    postClockEventImpl = async (_c, event) => {
      sentDirection = event.direction;
      return { ok: true, dryRun: false };
    };
    await store.upsertEmployeeState("client:Test DayDir", "legajo-dia", {
      date: prev.date,
      lastType: prev.lastType,
      lastRecordTimeMs: Date.parse(prev.hm),
    });
    await upsertClock({
      id: "sim-daydir", alias: "Simulado DayDir", clientName: "Test DayDir",
      ip: "clock-nightshift.example", port: 4370, humandApiKey: "k", pollIntervalMinutes: 15,
      userMap: { 88: "legajo-dia" }, sentKeys: [],
    });
    await syncClock("sim-daydir");
    await deleteClock("sim-daydir");
    if (sentDirection !== expected) throw new Error(`diurno (${desc}): esperaba ${expected}, se mandó ${sentDirection}`);
  }
  daySummaryResponder = async () => null;
  postClockEventImpl = async () => ({ ok: true, dryRun: false, simulated: true });
  console.log("OK: turno diurno — la dirección sale del horario, doble fichaje descartado, media jornada intacta.");
}

(async () => {
  testArgentinaLocalTimeToUtcMs();
  testDirectionAlternation();
  testPostExitReboundAndSuspectPunch();
  testEveningExitAcrossUtcMidnight();
  testOvernightShiftCheckoutNotMisclassifiedAsNewEntry();

  const clock = {
    id: "sim-test",
    alias: "Simulado",
    clientName: "Test",
    ip: "x.x.x.x",
    port: 4370,
    humandApiKey: "k",
    humandBaseUrl: "https://api-prod.humand.co",
    pollIntervalMinutes: 5,
    userMap: { 14: "legajo-001" }, // "99" queda sin mapear a propósito
    sentKeys: [],
    status: "pending",
  };
  await upsertClock(clock);

  const run1 = await syncClock("sim-test");
  console.log("RUN 1 (primera sync):", run1);
  if (run1.sent !== 1 || run1.unmapped !== 1) throw new Error("RUN 1 no dio el resultado esperado");

  const run2 = await syncClock("sim-test");
  console.log("RUN 2 (misma data, no debería re-enviar el ya mandado):", run2);
  if (run2.sent !== 0 || run2.skipped !== 1) throw new Error("RUN 2 no dio el resultado esperado (falló el dedup)");

  const all = await syncAllClocks();
  console.log("syncAllClocks (lo que llama el cron de Vercel en cada disparo):", all);

  await deleteClock("sim-test");
  console.log("\nOK: mapeo + dedup + dry-run + syncAllClocks funcionan como se espera.");

  await testCrossClockAlternation();
  await testLateLonePunchReclassifiedAsCheckout();
  await testLateLonePunchNotReclassifiedWhenHumandAlreadyHasEntriesThatDay();
  await testLateLonePunchFlagDisabledByDefault();
  await testNightShiftNeverReclassified();
  await testStuckPunch422();
  await testNightShiftDirectionByWindow();
  await testDayShiftDirectionByWindow();
})().catch((e) => {
  console.error("FALLÓ LA SIMULACIÓN:", e);
  process.exit(1);
});

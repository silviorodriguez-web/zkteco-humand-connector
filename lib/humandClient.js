// Cliente real contra la API pública de Humand — Control de Asistencia
// (Time Tracking), a partir del swagger publicado en
// https://api-prod.humand.co/public/api/v1/api-docs/
//
// Endpoints usados:
//   POST /time-tracking/entries/clockIn   { employeeId, now, comment? }
//   POST /time-tracking/entries/clockOut  { employeeId, now, comment? }
//   GET  /users/{employeeInternalId}      → { id, ... }  (resuelve el id numérico interno)
//   GET  /time-tracking/day-summaries?employeeIds=&startDate=&endDate=&page=&limit=
//        → horario programado (timeSlots) + incidencias ya calculadas por
//          Humand, por día. Ver getDaySummary() más abajo y la nota grande en
//          lib/poller.js sobre por qué hace falta esto (marca única del día
//          tardía, reclasificada como salida en vez de entrada).
//
// Autenticación: header "Authorization: Basic {api_key}" — así lo documenta
// el propio swagger (components.securitySchemes.api_key.description:
// "Basic {{api_key}}"). No es HTTP Basic estándar (no lleva user:pass en
// base64), es literalmente ese string con el API Key pegado.
//
// Nota sobre el mapeo de usuarios: lo que se guarda en clock.userMap NO es
// el id numérico de Humand — es el "employeeInternalId" (el identificador
// propio del cliente, ej. legajo), porque es lo único que un CX puede pedirle
// al cliente sin tocar la base de datos de Humand. resolveEmployeeId() lo
// traduce al id numérico que pide clockIn/clockOut, y cachea el resultado en
// el propio registro del reloj para no repetir la consulta en cada ciclo.
const DRY_RUN = process.env.HUMAND_DRY_RUN !== "false"; // true por defecto

const DEFAULT_BASE_URL = "https://api-prod.humand.co/public/api/v1";

function baseUrlFor(clockConfig) {
  return (clockConfig.humandBaseUrl || process.env.HUMAND_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function humandFetch(clockConfig, path, options = {}) {
  const apiKey = clockConfig.humandApiKey || process.env.HUMAND_API_KEY;
  const url = `${baseUrlFor(clockConfig)}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${apiKey}`,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const err = new Error(
      `Humand API respondió ${res.status} en ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// --- Login del cliente contra la comunidad de Humand ---
// El cliente escribe su "usuario" de Humand en /login; esto lo busca entre
// los usuarios de la comunidad (usando el HUMAND_API_KEY global de la app,
// no el de un reloj puntual) y si existe, se le da acceso a la interfaz.
//
// El "usuario" de Humand NO siempre es el email: confirmado con el cliente
// que en su comunidad el login es por DNI, y ese DNI es justamente el
// employeeInternalId que ya devuelve /users (se verificó contra 3 empleados
// reales: el número calza con el formato de DNI argentino, y en uno de ellos
// el CUIL informado en `fields` se deriva exactamente de ese mismo DNI). Por
// eso findUserByIdentifier matchea contra employeeInternalId Y contra email
// (para cuentas internas/admin que sí loguean con correo, ver ADMIN_EMAILS
// en api/index.js).
//
// Confirmado en vivo (14/8) contra la API real con dos API Keys distintas
// (incluida la de la comunidad del cliente, instance <ID>):
//   GET /users?limit=N&page=P  →  { count: <total>, users: [ {..., email, employeeInternalId, id, ...}, ... ] }
// El query param `email=` se probó y la API lo IGNORA (no filtra) — hay que
// traer las páginas y comparar a mano.
//
// ⚠️ CORREGIDO 18/8: esto paginaba con `offset=` (offset 0, 50, 100...), pero
// el swagger real (`/api-docs`) documenta el parámetro como `page`
// (1-indexado), NO `offset` — y la API efectivamente IGNORA `offset` por
// completo: devuelve siempre la primera página sin importar qué offset se
// mande (confirmado en vivo pidiendo offset=0/50/100 contra una comunidad de
// 110 personas: las 3 respuestas fueron idénticas, siempre las mismas 50
// primeras). Con `page=1/2/3` sí pagina bien (50+50+10=110, coincide con
// `count`). Esto significaba que, en producción, cualquier persona que no
// estuviera entre las primeras 50 de la comunidad NUNCA podía loguearse
// (findUserByIdentifier jamás llegaba a verla) — bug real, no solo cosmético.
const globalConfig = () => ({
  humandApiKey: process.env.HUMAND_API_KEY,
  humandBaseUrl: process.env.HUMAND_BASE_URL,
});

const USERS_PAGE_SIZE = 50; // confirmado en vivo: la API rechaza limit > 50 ("The limit must be an integer between 1 and 50")

// Itera todas las páginas de /users y llama a `onPage(list, body)` con cada
// una; corta apenas `onPage` devuelve algo truthy (para poder cortar temprano
// en una búsqueda) o cuando ya no hay más páginas.
async function paginateUsers(config, onPage) {
  for (let page = 1; page <= 100; page++) {
    // tope defensivo (100 páginas de 50 = 5000 usuarios) por si `count` viniera mal
    const body = await humandFetch(config, `/users?limit=${USERS_PAGE_SIZE}&page=${page}`);
    const list = Array.isArray(body?.users) ? body.users : [];
    const result = onPage(list, body);
    if (result) return result;

    const total = Number(body?.count) || 0;
    if (list.length === 0 || page * USERS_PAGE_SIZE >= total) break;
  }
  return null;
}

async function findUserByIdentifier(identifier) {
  const config = globalConfig();
  if (!config.humandApiKey) {
    throw new Error("Falta HUMAND_API_KEY configurada — no se puede validar el login contra la comunidad de Humand.");
  }
  const normalized = String(identifier).trim().toLowerCase();

  return paginateUsers(config, (list) =>
    list.find(
      (u) =>
        u &&
        (String(u.employeeInternalId || "").toLowerCase() === normalized ||
          String(u.email || "").toLowerCase() === normalized)
    )
  );
}

// Trae TODOS los usuarios de la comunidad (paginando de a 50, el máximo real
// que acepta la API). Se usa para el mapeo reloj->Humand: en vez de que el
// CX tenga que escribir a ciegas el employeeInternalId (DNI) de cada "ID de
// Usuario" del reloj, se le muestra la lista real de la comunidad (nombre +
// apellido + DNI) y elige de ahí. Mismo endpoint que findUserByIdentifier
// (GET /users?limit=&page=), ver la nota grande más arriba sobre el bug de
// `offset` corregido el 18/8.
async function listCommunityUsers() {
  const config = globalConfig();
  if (!config.humandApiKey) {
    throw new Error("Falta HUMAND_API_KEY configurada — no se puede traer la lista de usuarios de Humand.");
  }

  const all = [];
  await paginateUsers(config, (list) => {
    all.push(...list);
    return false; // nunca corta antes de tiempo: acá queremos TODAS las páginas
  });
  return all;
}

// DRY_RUN es el default GLOBAL (env var), pero cada reloj puede pisarlo con
// su propio clock.dryRun (true/false) — así se puede activar el envío real
// para un solo reloj (ej. EMPAQUE, ya validado) sin tocar los demás, que
// siguen en simulación hasta que el cliente los valide también. Ver
// effectiveDryRun() más abajo, usada tanto acá como en postClockEvent.
function effectiveDryRun(clockConfig) {
  return typeof clockConfig.dryRun === "boolean" ? clockConfig.dryRun : DRY_RUN;
}

// employeeInternalId (string, ej. legajo/DNI) -> el mismo employeeInternalId,
// una vez confirmado que la cuenta existe y está ACTIVE en Humand.
//
// ⚠️ CORREGIDO 19/8: esta función devolvía antes user.id (el id numérico
// interno de Humand, ej. 10000001), asumiendo que era lo que pedía
// /time-tracking/entries/clockIn|clockOut. Confirmado en vivo con un GET de
// solo lectura contra /time-tracking/entries: ese módulo usa como
// "employeeId" el employeeInternalId (DNI/legajo) — el mismo valor que ya
// tenemos en clock.userMap — y responde 404 USER_NOT_FOUND si en cambio se le
// manda el id numérico de /users. Por eso ningún envío real había tenido
// éxito nunca en EMPAQUE (sent siempre en 0, incluso para cuentas ACTIVE):
// se estaba mandando el id equivocado a todo el mundo, no solo a los
// UNCLAIMED. GET /users se sigue llamando: es la única forma de confirmar
// que la cuenta existe y ya está ACTIVE antes de gastar el POST real.
async function resolveEmployeeId(clockConfig, employeeInternalId) {
  clockConfig.employeeIdCache = clockConfig.employeeIdCache || {};
  if (clockConfig.employeeIdCache[employeeInternalId]) {
    return clockConfig.employeeIdCache[employeeInternalId];
  }

  if (effectiveDryRun(clockConfig)) {
    // No golpeamos /users en dry-run para no depender de una API Key real;
    // devolvemos un id ficticio así el resto del pipeline se puede simular.
    return `DRY-${employeeInternalId}`;
  }

  const user = await humandFetch(clockConfig, `/users/${encodeURIComponent(employeeInternalId)}`);

  // Descubierto en vivo el 18/8, primera activación real: /time-tracking
  // rechaza con 404 USER_NOT_FOUND a cualquier persona cuya cuenta de
  // Humand siga en estado UNCLAIMED (no completó el alta/activación), aun
  // cuando GET /users la encuentra perfectamente y el mapeo esté bien
  // hecho. No es un bug de este conector — es una condición previa del
  // lado de Humand/el cliente. Se corta acá con un mensaje claro para no
  // gastar el POST real y para que el error en el log de sync sea
  // accionable (no un 404 genérico).
  if (user.status && user.status !== "ACTIVE") {
    const err = new Error(
      `${user.firstName || ""} ${user.lastName || ""} (DNI ${employeeInternalId}) todavía no activó/reclamó su cuenta en Humand (status: ${user.status}) — Humand no permite registrar fichaje hasta que lo haga.`
    );
    err.userNotClaimed = true;
    throw err;
  }

  clockConfig.employeeIdCache[employeeInternalId] = employeeInternalId;
  return employeeInternalId;
}

// event.direction ya viene calculado por lib/poller.js ("START" o "END") —
// ver la nota grande en ese archivo sobre por qué hace falta inferirlo.
async function postClockEvent(clockConfig, event) {
  const employeeInternalId = event.mappedUserId;
  const endpoint = event.direction === "END" ? "clockOut" : "clockIn";
  const employeeId = await resolveEmployeeId(clockConfig, employeeInternalId);

  const payload = {
    // ⚠️ El swagger documenta employeeId como PositiveInteger, pero la API
    // real (confirmado en vivo el 18/8, primer envío real) lo valida con
    // class-validator y rechaza el número con 400 "employeeId must be a
    // string" — hay que mandarlo como string pese a lo que dice el swagger.
    employeeId: String(employeeId),
    now: event.recordTime.toISOString(),
    // No hay campo estructurado de sede/ubicación en este endpoint (solo
    // `comment`, texto libre — confirmado en el swagger real), así que acá
    // es donde va identificado el reloj físico de origen. Pedido explícito
    // del 18/8: que el cliente pueda ver desde qué reloj/lugar se marcó
    // cada fichaje, no solo que llegó.
    comment: `Marcado en el reloj "${clockConfig.alias || clockConfig.ip}" (sincronización automática)`,
  };

  if (effectiveDryRun(clockConfig)) {
    return {
      ok: true,
      dryRun: true,
      would_call: `POST ${baseUrlFor(clockConfig)}/time-tracking/entries/${endpoint}`,
      payload,
    };
  }

  const response = await humandFetch(clockConfig, `/time-tracking/entries/${endpoint}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { ok: true, dryRun: false, response };
}

// Trae el resumen del día (horario programado + incidencias ya calculadas
// por Humand) de UN empleado para UNA fecha puntual (referenceDate,
// YYYY-MM-DD). Se usa desde lib/poller.js SOLO para la primera marca del día
// de un empleado (candidata a "en realidad es una salida tardía, no una
// entrada" — ver la nota grande ahí), no en cada marcación.
//
// Confirmado en vivo el 4/9 contra la comunidad real del cliente: cuando el
// colaborador tiene "Horario Laboral" cargado (a diferencia de "Turnos", que
// para este cliente está vacío — ver GET /shifts/planning), este endpoint sí
// devuelve `hasSchedule: true` y `timeSlots: [{ startTime, endTime }]` con
// horarios reales por día (varían día a día, ej. franco/turno rotativo). Si
// el día no tiene horario cargado (`hasSchedule: false` o `timeSlots: null`,
// ej. franco/domingo o cliente sin Horario Laboral configurado), se devuelve
// tal cual — el que llama debe hacer el fallback al comportamiento actual.
//
// ⚠️ `startTime`/`endTime` vienen en hora LOCAL Argentina (confirmado
// comparando contra una marcación real: timeSlot "05:30"-"14:30" calzó con
// un fichaje real a las 08:19 UTC ≈ 05:19 ART) — no en UTC. Ver
// argentinaLocalTimeToUtcMs() en lib/poller.js para la conversión.
//
// No se usa `effectiveDryRun` acá a propósito: es un GET de solo lectura que
// no cambia nada en Humand, así que conviene poder validarlo en vivo aunque
// el reloj siga en dry-run para el ENVÍO (clockIn/clockOut) — es justamente
// lo que se necesita para probar esta lógica antes de activar el envío real.
async function getDaySummary(clockConfig, employeeInternalId, referenceDate) {
  const body = await humandFetch(
    clockConfig,
    `/time-tracking/day-summaries?employeeIds=${encodeURIComponent(employeeInternalId)}&startDate=${referenceDate}&endDate=${referenceDate}&page=1&limit=10`
  );
  const items = Array.isArray(body?.items) ? body.items : [];
  return items[0] || null;
}

module.exports = {
  postClockEvent,
  resolveEmployeeId,
  findUserByIdentifier,
  listCommunityUsers,
  getDaySummary,
  effectiveDryRun,
  DRY_RUN,
  DEFAULT_BASE_URL,
};

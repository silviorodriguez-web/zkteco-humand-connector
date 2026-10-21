// Wrapper around node-zklib: talks directly to the clock over its own IP:port
// using ZKTeco's native protocol (TCP/UDP, default port 4370). This is the
// "pull" side of the connector — no server needs to be exposed for inbound
// traffic, we just reach out to the clock the same way the client's current
// platform already does.
const ZKLib = require("node-zklib");

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_INPORT = 4000;

// node-zklib no siempre rechaza con un Error real: a veces es un objeto plano
// como { err: { code: 'EHOSTUNREACH', ... }, ip, command }. Normalizamos para
// que el resto de la app siempre pueda hacer err.message de forma segura.
function normalizeError(err) {
  if (err instanceof Error) return err;
  const code = err?.err?.code || err?.code;
  const detail = code ? `${code} conectando a ${err.ip}:${err.port ?? ""} (${err.command || "?"})` : JSON.stringify(err);
  return new Error(detail);
}

async function withConnection(ip, port, fn) {
  const zk = new ZKLib(ip, Number(port), DEFAULT_TIMEOUT, DEFAULT_INPORT);
  try {
    await zk.createSocket();
  } catch (err) {
    throw normalizeError(err);
  }
  try {
    return await fn(zk);
  } catch (err) {
    throw normalizeError(err);
  } finally {
    try {
      await zk.disconnect();
    } catch (_) {
      /* best effort */
    }
  }
}

// Quick connectivity/health check — used by the "Probar conexión" button.
async function testConnection(ip, port) {
  return withConnection(ip, port, async (zk) => {
    const info = await zk.getInfo();
    const users = await zk.getUsers();
    return {
      ok: true,
      deviceInfo: info,
      userCount: users?.data?.length ?? 0,
      sampleUsers: (users?.data ?? []).slice(0, 5).map((u) => ({
        userId: u.userId ?? u.uid,
        name: u.name,
      })),
    };
  });
}

// Trae la lista de usuarios ENROLADOS en el reloj (no las marcaciones — los
// perfiles que el propio reloj tiene guardados con su nombre). node-zklib
// decodifica cada perfil de 72 bytes y expone `userId` como el mismo campo
// string que `deviceUserId` en las marcaciones (ambos leen el campo "ID de
// Usuario" del dispositivo, ver decodeUserData72/decodeRecordData40 en
// node_modules/node-zklib/utils.js) — por eso se puede unir por ese campo
// para saber, sin depender del cliente, qué nombre puso el propio reloj para
// cada ID que aparece en las marcaciones.
async function fetchDeviceUsers(ip, port) {
  return withConnection(ip, port, async (zk) => {
    const result = await zk.getUsers();
    if (result.err) throw result.err;
    return (result.data ?? [])
      .map((u) => ({
        deviceUserId: String(u.userId ?? u.uid ?? "").trim(),
        name: String(u.name ?? "").trim(),
      }))
      .filter((u) => u.deviceUserId);
  });
}

// ⚠️ CORREGIDO 19/8, bug crítico de fondo (todas las marcas llegaban a Humand
// 3 horas antes de lo real): node-zklib decodifica cada marcación armando un
// `new Date(año, mes, día, hora, min, seg)` con el constructor LOCAL de JS a
// partir de los campos crudos del reloj (que están en hora de Argentina,
// donde están instalados físicamente estos equipos) — asumiendo que el
// proceso que corre el código está en esa misma zona horaria. Eso es cierto
// corriendo local en una máquina Argentina, pero FALSO en Vercel (corre en
// UTC): ahí esos mismos números quedan mal etiquetados como si fueran UTC en
// vez de ART, y cada marcación se manda a Humand desfasada exactamente 3
// horas. Confirmado en vivo el 19/8 conectándose directo al reloj: su turno
// real arrancó a las 11:55 ART, pero por este bug se mandó y se vio en
// Humand como si hubiera sido a las 08:55.
//
// El reloj físico en sí tiene bien puesta su hora (confirmado con
// CMD_GET_TIME) — el problema es enteramente de esta decodificación. Se
// arregla acá, tomando los mismos campos año/mes/día/hora/min/seg que
// node-zklib ya decodificó (leídos con los getters LOCALES del Date, que
// devuelven fielmente esos números sin importar la zona horaria del
// proceso, porque se los pasó el propio constructor local) y reconstruyendo
// el instante UTC verdadero asumiendo que esos campos son hora de
// Argentina. Al usar siempre los mismos getters/constructor locales de un
// lado y otro, esto da el resultado correcto sin importar en qué zona
// horaria esté corriendo el proceso (local, Vercel, o cualquier otra).
const ARGENTINA_UTC_OFFSET_MS = -3 * 60 * 60 * 1000; // Argentina no tiene horario de verano desde 2009: UTC-3 fijo (misma constante que ARGENTINA_UTC_OFFSET_HOURS en lib/poller.js)

function fixDeviceLocalTime(date) {
  const mislabeledAsUtcMs = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  );
  return new Date(mislabeledAsUtcMs - ARGENTINA_UTC_OFFSET_MS);
}

// Pulls every attendance record currently stored on the clock. The device
// does not support "give me only what's new" natively with this library, so
// de-duplication against records we already forwarded happens one layer up,
// in the poller (see lib/poller.js), keyed by userSn + recordTime.
async function fetchAttendanceLogs(ip, port) {
  return withConnection(ip, port, async (zk) => {
    const result = await zk.getAttendances();
    if (result.err) throw result.err;
    return (result.data ?? []).map((r) => ({
      // userSn: internal sequential slot number on the device (not stable across re-enrollments)
      userSn: r.userSn,
      // deviceUserId: the "ID de Usuario" field visible on the clock's screen —
      // this is what needs to be mapped to the real legajo/Humand user id.
      deviceUserId: String(r.deviceUserId).trim(),
      recordTime: fixDeviceLocalTime(r.recordTime instanceof Date ? r.recordTime : new Date(r.recordTime)),
      ip: r.ip,
    }));
  });
}

module.exports = { testConnection, fetchAttendanceLogs, fetchDeviceUsers };

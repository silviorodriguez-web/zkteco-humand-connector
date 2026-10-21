// App Express completa. En Vercel esto se expone como una única función
// serverless (api/index.js) y vercel.json reescribe todo el tráfico que no
// sea /api/* hacia acá — así se reutiliza el mismo código de rutas sin
// reescribirlo por archivo. Para desarrollo local, server.js importa este
// archivo y le agrega app.listen().
const express = require("express");
const crypto = require("crypto");
const { readClocks, getClock, upsertClock, deleteClock } = require("../lib/store");
const { testConnection, fetchDeviceUsers } = require("../lib/zkteco");
const { syncClock, scheduleClock, isLateLonePunchCheckoutEnabled } = require("../lib/poller");
const { DRY_RUN, effectiveDryRun, findUserByIdentifier, listCommunityUsers } = require("../lib/humandClient");
const { getSessionEmail, setSessionCookie, clearSessionCookie } = require("../lib/session");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Login: "tu usuario de Humand" ---
// El cliente escribe su "usuario" de Humand — que en su comunidad NO es el
// email, es el DNI (confirmado: el DNI es el mismo employeeInternalId que
// devuelve la API de Humand, ver la nota grande en lib/humandClient.js). Si
// ese identificador (DNI o email, según el caso) existe entre los usuarios
// de la comunidad, se le da acceso — ver lib/humandClient.js ->
// findUserByIdentifier() y lib/session.js.
//
// APP_BASIC_AUTH_USER/PASS se mantiene como puerta trasera solo para el
// equipo interno (CX/soporte), por si hace falta entrar sin depender de la
// comunidad de Humand estando disponible. No se ofrece ni se menciona al
// cliente.
const AUTH_USER = process.env.APP_BASIC_AUTH_USER;
const AUTH_PASS = process.env.APP_BASIC_AUTH_PASS;

// Emails (no DNI) que entran por /login sin depender de la comunidad del
// cliente — equipo interno (CX/soporte de Humand), separado por comas en
// ADMIN_EMAILS.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function hasValidBasicAuth(req) {
  if (!AUTH_USER || !AUTH_PASS) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
  return user === AUTH_USER && pass === AUTH_PASS;
}

const PUBLIC_PATHS = new Set(["/login"]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (hasValidBasicAuth(req)) return next();
  if (getSessionEmail(req)) return next();

  // Sin login por comunidad configurado (falta HUMAND_API_KEY) y sin basic
  // auth configurado tampoco: queda abierto (solo para pruebas locales).
  if (!process.env.HUMAND_API_KEY && !AUTH_USER) return next();

  if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.redirect(`/login${req.path !== "/" ? `?next=${encodeURIComponent(req.originalUrl)}` : ""}`);
});

// --- Cache en memoria de la lista de usuarios de la comunidad de Humand ---
// Se usa para el mapeo reloj->Humand (ver /clocks/:id más abajo): en vez de
// que el CX escriba a ciegas el employeeInternalId (DNI), se le muestra la
// lista real de la comunidad (nombre + DNI) para elegir. Traer todas las
// páginas pega varias veces contra /users, así que se cachea un rato (esto
// vive en memoria del proceso de la función serverless, se pierde entre
// invocaciones frías — no hace falta más que eso, el botón "Actualizar
// lista" fuerza un refresh).
let communityUsersCache = { at: 0, users: [] };
const COMMUNITY_USERS_TTL_MS = 5 * 60 * 1000;

async function getCommunityUsers({ forceRefresh = false } = {}) {
  const fresh = Date.now() - communityUsersCache.at < COMMUNITY_USERS_TTL_MS;
  if (!forceRefresh && fresh && communityUsersCache.users.length) return communityUsersCache.users;
  const users = await listCommunityUsers();
  communityUsersCache = { at: Date.now(), users };
  return users;
}

function humandUserLabel(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return `${name || "(sin nombre)"} — DNI ${user.employeeInternalId || "?"}${user.email ? ` — ${user.email}` : ""}`;
}

// Normaliza un nombre para comparar "JUAN PEREZ" con "Juan Pérez": pasa a
// minúsculas, saca acentos y colapsa espacios. Sirve para sugerir un match
// automático entre el nombre enrolado en el reloj y el de la comunidad de
// Humand — nunca para mapear solo, siempre queda a confirmación del CX.
// Pasa a minúsculas, saca acentos/puntuación y devuelve la lista de
// palabras (sin ordenar ni unir — eso lo hace cada consumidor según lo que
// necesite: nameTokens() para comparar con tolerancia a truncamiento,
// normalizeName() para el caso de igualdad exacta).
function nameTokens(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // ⚠️ CORREGIDO 18/8: antes esto BORRABA cualquier caracter no-letra
    // (.replace(..., "")), así que "Emanuel.Banega" quedaba pegado como
    // "emanuelbanega" — una sola palabra en vez de dos, y como
    // suggestMatch exige 2+ palabras para sugerir algo, esto perdía
    // matches reales (confirmado en vivo: el reloj usa tanto "Apellido .,
    // Nombre" como "Nombre.Apellido", con puntos como separador). Ahora
    // cualquier corrida de caracteres no-letra (puntos, comas, números,
    // basura de control) se trata como separador de palabras.
    .replace(/[^a-z]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeName(str) {
  return nameTokens(str).sort().join(" ");
}

// El campo "nombre" que el reloj guarda por perfil viene de un paquete de
// tamaño fijo (72 bytes, compartido con password/cardno/etc. — ver la nota
// en lib/zkteco.js) y en la práctica trunca nombres largos a mitad de
// palabra (confirmado en vivo: "Maria Isab" en vez de "Maria Isabel",
// "Norma Beatr" en vez de "Norma Beatriz"). Por eso la comparación no puede
// ser de igualdad exacta: cada palabra del reloj tiene que calzar, entera o
// como PREFIJO (mínimo 3 letras, para no matchear con cualquier cosa), con
// una palabra distinta de la persona de la comunidad — y todas las palabras
// del reloj tienen que encontrar dónde calzar.
function namesLikelyMatch(deviceTokens, communityTokens) {
  if (!deviceTokens.length) return false;
  const used = new Set();
  for (const dt of deviceTokens) {
    let found = false;
    for (let i = 0; i < communityTokens.length; i++) {
      if (used.has(i)) continue;
      const ct = communityTokens[i];
      if (dt === ct || (dt.length >= 3 && ct.startsWith(dt)) || (ct.length >= 3 && dt.startsWith(ct))) {
        used.add(i);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// Busca, entre la lista de la comunidad, a alguien cuyo nombre calce con el
// nombre enrolado en el reloj (tolerando truncamiento y cualquier orden
// nombre/apellido, ver namesLikelyMatch). Devuelve null ante cualquier
// ambigüedad — mejor no sugerir nada que sugerir mal.
function suggestMatch(deviceName, communityUsers) {
  const deviceTokens = nameTokens(deviceName);
  if (deviceTokens.length < 2) return null; // muy poca info (un solo token) para sugerir con confianza
  const matches = communityUsers.filter((u) =>
    namesLikelyMatch(deviceTokens, nameTokens(`${u.firstName} ${u.lastName}`))
  );
  return matches.length === 1 ? matches[0] : null;
}

// Para cada ID sin mapear del reloj, calcula si hay una sugerencia (nombre
// enrolado en el reloj == exactamente una persona de la comunidad). La usan
// tanto la pantalla (para mostrar el ✅) como el botón de "vincular
// automático" (para efectivamente guardar esos mapeos).
function computeSuggestions(clock, communityUsers) {
  const deviceUserNames = clock.deviceUserNames || {};
  const userMap = clock.userMap || {};
  const unmapped = (clock.lastSeenDeviceIds || []).filter((id) => !userMap[id]);
  return unmapped.map((id) => {
    const deviceName = deviceUserNames[id];
    const suggested = deviceName ? suggestMatch(deviceName, communityUsers) : null;
    return { id, deviceName, suggested };
  });
}

app.get("/login", (req, res) => {
  const error = req.query.error;
  res.send(
    layout(
      "Ingresar",
      `
<div class="card" style="max-width:420px; margin:60px auto;">
  <h2>Ingresar</h2>
  <p class="muted">Ingresá tu usuario de Humand (el mismo con el que entrás a tu comunidad — para la mayoría es tu DNI) o tu email. Si te encontramos ahí, te damos acceso.</p>
  ${error ? `<p style="color:#C0392B; font-size:13px;">${error}</p>` : ""}
  <form method="POST" action="/login">
    <input type="hidden" name="next" value="${req.query.next ? String(req.query.next).replace(/"/g, "&quot;") : "/"}" />
    <label>Usuario de Humand (DNI) o email</label>
    <input type="text" name="identifier" placeholder="Ej: 12345678" required />
    <button type="submit">Ingresar</button>
  </form>
</div>`
    )
  );
});

app.post("/login", async (req, res) => {
  const identifier = String(req.body.identifier || "").trim();
  const next = req.body.next || "/";
  if (!identifier) return res.redirect(`/login?error=${encodeURIComponent("Ingresá tu usuario o email.")}`);
  const normalized = identifier.toLowerCase();

  // Allowlist de emails admin (equipo CX/soporte, ej. Humand) que entran sin
  // depender de la comunidad del cliente — no son empleados de el cliente,
  // así que nunca van a aparecer en su findUserByIdentifier().
  if (ADMIN_EMAILS.has(normalized)) {
    setSessionCookie(res, normalized);
    return res.redirect(next);
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return res.redirect(
        `/login?error=${encodeURIComponent("No te encontramos en la comunidad de Humand con ese usuario o email.")}`
      );
    }
    setSessionCookie(res, normalized);
    res.redirect(next);
  } catch (err) {
    console.error("[login] error validando contra Humand:", err);
    res.redirect(
      `/login?error=${encodeURIComponent("No se pudo validar contra Humand ahora mismo. Probá de nuevo en un rato.")}`
    );
  }
});

app.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.redirect("/login");
});

function layout(title, body, sessionEmail) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Conector ZKTeco → Humand</title>
<style>
  :root { --navy:#1F3864; --accent:#2E74B5; --bg:#F5F7FA; --border:#DCE3EA; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: var(--bg); margin:0; color:#1a1a1a; }
  header { background: var(--navy); color: white; padding: 18px 32px; }
  header h1 { margin:0; font-size: 20px; }
  header p { margin:4px 0 0; opacity:.8; font-size:13px; }
  main { max-width: 900px; margin: 28px auto; padding: 0 20px 60px; }
  .card { background: white; border: 1px solid var(--border); border-radius: 10px; padding: 22px 24px; margin-bottom: 20px; }
  .card h2 { margin-top:0; font-size:17px; color: var(--navy); }
  label { display:block; font-size:13px; font-weight:600; margin: 12px 0 4px; color:#333; }
  input, select { width:100%; padding: 8px 10px; border:1px solid #C7CFD8; border-radius:6px; font-size:14px; }
  .row { display:flex; gap:16px; }
  .row > div { flex:1; }
  button { background: var(--accent); color:white; border:none; padding: 9px 16px; border-radius:6px; font-size:14px; cursor:pointer; margin-top:14px; }
  button.secondary { background:#fff; color: var(--accent); border:1px solid var(--accent); }
  button.danger { background:#fff; color:#C0392B; border:1px solid #C0392B; }
  table { width:100%; border-collapse: collapse; font-size:13px; margin-top:10px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid #EEF1F5; }
  .pill { display:inline-block; padding:2px 9px; border-radius: 20px; font-size:12px; font-weight:600; }
  .pill.ok { background:#E6F4EA; color:#1E7B34; }
  .pill.error { background:#FDECEA; color:#C0392B; }
  .pill.warning { background:#FDF3E3; color:#8A5A00; }
  .pill.pending { background:#EAF1F8; color: var(--accent); }
  .muted { color:#6b7280; font-size:12px; }
  .banner { background:#FFF7E6; border:1px solid #F5C24C; color:#7A5B00; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:20px; }
  a { color: var(--accent); text-decoration:none; }
  code { background:#EEF1F5; padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<header style="display:flex; justify-content:space-between; align-items:flex-start;">
  <div>
    <h1>Conector ZKTeco → Humand (Control de Asistencia)</h1>
    <p>Prototipo interno · modo pull · sin necesidad de servidor del lado del cliente</p>
  </div>
  ${
    sessionEmail
      ? `<form method="POST" action="/logout" style="margin:0;">
          <p style="margin:0 0 4px; font-size:12px; opacity:.85; text-align:right;">${sessionEmail}</p>
          <button type="submit" style="background:transparent; border:1px solid rgba(255,255,255,.5); color:white; padding:5px 12px; font-size:12px;">Salir</button>
        </form>`
      : ""
  }
</header>
<main>
${body}
</main>
</body>
</html>`;
}

function statusPill(clock) {
  if (!clock.lastRun) return `<span class="pill pending">Sin sincronizar aún</span>`;
  if (clock.status === "error") return `<span class="pill error">Error</span>`;
  if (clock.status === "warning") return `<span class="pill warning">Atención</span>`;
  return `<span class="pill ok">OK</span>`;
}

app.get("/", async (req, res) => {
  const clocks = await readClocks();
  const rows = clocks
    .map((c) => {
      const lastRun = c.lastRun
        ? `enviados: ${c.lastRun.sent} · sin mapear: ${c.lastRun.unmapped} · omitidos: ${c.lastRun.skipped}`
        : "—";
      return `<tr>
        <td><a href="/clocks/${c.id}">${c.alias}</a><div class="muted">${c.ip}:${c.port}</div></td>
        <td>${statusPill(c)}</td>
        <td class="muted">${c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString("es-AR") : "—"}</td>
        <td class="muted">${lastRun}</td>
      </tr>`;
    })
    .join("");

  const banner = DRY_RUN
    ? `<div class="banner">⚠️ Modo <b>DRY_RUN</b> activo: el conector lee los relojes y calcula todo (mapeo, entrada/salida) normalmente, pero <b>no</b> llama a la API real de Humand — solo queda registrado qué se habría enviado a <code>/time-tracking/entries/clockIn</code> y <code>clockOut</code>. Los endpoints ya están confirmados contra el swagger público de Humand; para pasar a producción, hacer una prueba controlada con un reloj y empleado real y recién ahí desactivarlo (variable <code>HUMAND_DRY_RUN=false</code>).</div>`
    : "";

  res.send(
    layout(
      "Relojes",
      `
${banner}
<div class="card">
  <h2>Relojes configurados</h2>
  ${clocks.length === 0 ? `<p class="muted">Todavía no agregaste ningún reloj.</p>` : `
  <table>
    <thead><tr><th>Reloj</th><th>Estado</th><th>Última sync</th><th>Detalle</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</div>

<div class="card">
  <h2>Agregar un reloj</h2>
  <p class="muted">El cliente completa esto con los datos que ya usa hoy con su plataforma actual: la IP pública y el puerto de cada reloj (por defecto el 4370 en los ZKTeco).</p>
  <form method="POST" action="/clocks">
    <div class="row">
      <div>
        <label>Alias / nombre del reloj</label>
        <input name="alias" placeholder="Ej: Planta - Reloj entrada" required />
      </div>
      <div>
        <label>Cliente</label>
        <input name="clientName" placeholder="Ej: el cliente" required />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Dirección IP</label>
        <input name="ip" placeholder="Ej: 190.xx.xx.xx (IP pública del reloj)" required />
      </div>
      <div>
        <label>Puerto TCP</label>
        <input name="port" value="4370" required />
      </div>
    </div>
    <div class="row">
      <div>
        <label>API Key de Humand (opcional)</label>
        <input name="humandApiKey" placeholder="Dejar vacío para usar la configurada por defecto para toda la cuenta" />
      </div>
      <div>
        <label>URL base de la API de Humand (opcional)</label>
        <input name="humandBaseUrl" placeholder="https://api-prod.humand.co/public/api/v1 (dejar vacío = ese default)" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Frecuencia de sincronización (minutos)</label>
        <input name="pollIntervalMinutes" value="5" required />
      </div>
      <div></div>
    </div>
    <button type="submit">Guardar y empezar a sincronizar</button>
  </form>
</div>
`,
      getSessionEmail(req)
    )
  );
});

app.post("/clocks", async (req, res) => {
  const id = crypto.randomUUID();
  const clock = {
    id,
    alias: req.body.alias,
    clientName: req.body.clientName,
    ip: req.body.ip,
    port: req.body.port || 4370,
    humandApiKey: req.body.humandApiKey || "",
    humandBaseUrl: req.body.humandBaseUrl || "",
    pollIntervalMinutes: req.body.pollIntervalMinutes || 5,
    userMap: {},
    sentKeys: [],
    status: "pending",
  };
  await upsertClock(clock);
  scheduleClock(clock); // no-op relevante solo en desarrollo local; en Vercel el cron es lo que dispara la sync
  res.redirect(`/clocks/${id}`);
});

app.get("/clocks/:id", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");

  // Lista de usuarios de la comunidad de Humand, para poder elegir por
  // nombre en vez de escribir el DNI a ciegas (ver getCommunityUsers arriba).
  // Si falla (sin HUMAND_API_KEY, API caída, etc.) se degrada al input de
  // texto libre de siempre — no bloquea la pantalla.
  let communityUsers = [];
  let communityUsersError = null;
  try {
    communityUsers = await getCommunityUsers({ forceRefresh: req.query.refreshUsers === "1" });
  } catch (err) {
    communityUsersError = String(err.message || err);
  }
  const byInternalId = new Map(communityUsers.map((u) => [String(u.employeeInternalId), u]));

  const mappedRows = Object.entries(clock.userMap || {})
    .map(([deviceId, humandId]) => {
      const match = byInternalId.get(String(humandId));
      return `<tr>
      <td>${deviceId}</td>
      <td>${humandId}${match ? ` <span class="muted">(${humandUserLabel(match)})</span>` : ""}</td>
      <td>
        <form method="POST" action="/clocks/${clock.id}/mapping/remove" style="display:inline;">
          <input type="hidden" name="deviceUserId" value="${deviceId}" />
          <button class="secondary" type="submit" style="margin:0; padding:5px 10px;">Quitar mapeo</button>
        </form>
      </td>
    </tr>`;
    })
    .join("");

  const suggestions = computeSuggestions(clock, communityUsers);
  const suggestedCount = suggestions.filter((s) => s.suggested).length;
  const unmappedRows = suggestions
    .map(({ id, deviceName, suggested }) => {
      const options = communityUsers
        .slice()
        .sort((a, b) => humandUserLabel(a).localeCompare(humandUserLabel(b)))
        .map(
          (u) =>
            `<option value="${u.employeeInternalId}" ${suggested && suggested.id === u.id ? "selected" : ""}>${
              suggested && suggested.id === u.id ? "✅ " : ""
            }${humandUserLabel(u)}</option>`
        )
        .join("");
      return `<tr>
      <td>${id}</td>
      <td>${deviceName ? deviceName : `<span class="muted">(el reloj no le puso nombre a este perfil)</span>`}</td>
      <td>
        <form method="POST" action="/clocks/${clock.id}/mapping" style="display:flex; gap:6px; flex-wrap:wrap;">
          <input type="hidden" name="deviceUserId" value="${id}" />
          ${
            communityUsers.length
              ? `<select name="humandUserId" style="padding:5px 8px;" required>
                   ${suggested ? "" : `<option value="" disabled selected>Elegir persona de la comunidad…</option>`}
                   ${options}
                 </select>`
              : `<input name="humandUserId" placeholder="employeeInternalId en Humand (ej. DNI/legajo)" style="padding:5px 8px;" required />`
          }
          <button type="submit" style="margin:0; padding:5px 10px;">${suggested ? "Confirmar" : "Mapear"}</button>
        </form>
      </td>
    </tr>`;
    })
    .join("");

  const errorLines = (clock.lastRun?.errors || []).map((e) => `<li>${e}</li>`).join("");

  res.send(
    layout(
      clock.alias,
      `
<p><a href="/">&larr; Volver</a></p>
<div class="card">
  <h2>${clock.alias} ${statusPill(clock)}</h2>
  <p class="muted">${clock.clientName} · ${clock.ip}:${clock.port} · sincroniza cada ${clock.pollIntervalMinutes} min (vía Vercel Cron, cada 5 min real vía el Worker de Cloudflare — solo procesa lo de HOY por defecto, ver más abajo)</p>
  <p>${
    effectiveDryRun(clock)
      ? '<span class="pill" style="background:#FDF3E3; color:#8A5A00;">DRY-RUN: no se envía nada real a Humand todavía</span>'
      : '<span class="pill" style="background:#E6F4EA; color:#1E7B34;">ENVÍO REAL activado para este reloj — esto escribe asistencia real en Humand</span>'
  }</p>
  <form method="POST" action="/clocks/${clock.id}/test" style="display:inline;">
    <button class="secondary" type="submit">Probar conexión</button>
  </form>
  <form method="POST" action="/clocks/${clock.id}/sync" style="display:inline;">
    <button type="submit">Sincronizar ahora (todo lo pendiente)</button>
  </form>
  <form method="POST" action="/clocks/${clock.id}/sync" style="display:inline;">
    <input type="hidden" name="onlyToday" value="1" />
    <button class="secondary" type="submit">Sincronizar solo lo de hoy</button>
  </form>
  ${
    effectiveDryRun(clock)
      ? `<form method="POST" action="/clocks/${clock.id}/dry-run" style="display:inline;" onsubmit="return confirm('¿Activar el ENVÍO REAL para este reloj? A partir de ahora, sus marcaciones de hoy en adelante van a escribirse de verdad en Humand para los usuarios ya mapeados.');">
           <input type="hidden" name="dryRun" value="false" />
           <button type="submit">Activar envío real (solo este reloj)</button>
         </form>`
      : `<form method="POST" action="/clocks/${clock.id}/dry-run" style="display:inline;" onsubmit="return confirm('¿Volver este reloj a modo simulación (dry-run)?');">
           <input type="hidden" name="dryRun" value="true" />
           <button class="secondary" type="submit">Volver a dry-run</button>
         </form>`
  }
  ${
    isLateLonePunchCheckoutEnabled(clock)
      ? `<form method="POST" action="/clocks/${clock.id}/late-lone-punch-checkout" style="display:inline;" onsubmit="return confirm('¿Desactivar la reclasificación de marca única tardía como salida en este reloj?');">
           <input type="hidden" name="enabled" value="false" />
           <button class="secondary" type="submit">Desactivar reclasificación de marca tardía</button>
         </form>`
      : `<form method="POST" action="/clocks/${clock.id}/late-lone-punch-checkout" style="display:inline;" onsubmit="return confirm('¿Activar que la única marca del día, si llega bien después del fin de turno programado en Humand, se mande como salida en vez de entrada? Requiere que el colaborador tenga Horario Laboral cargado en Humand.');">
           <input type="hidden" name="enabled" value="true" />
           <button class="secondary" type="submit">Activar reclasificación de marca tardía (beta)</button>
         </form>`
  }
  <form method="POST" action="/clocks/${clock.id}/delete" style="display:inline;" onsubmit="return confirm('¿Eliminar este reloj?');">
    <button class="danger" type="submit">Eliminar reloj</button>
  </form>
  ${clock.testResult ? `<pre style="background:#F5F7FA; padding:10px; border-radius:6px; font-size:12px; overflow:auto;">${JSON.stringify(clock.testResult, null, 2)}</pre>` : ""}
</div>

<div class="card">
  <h2>Último resultado de sincronización</h2>
  ${
    clock.lastRun
      ? `<p>Enviados: <b>${clock.lastRun.sent}</b> · Sin mapear: <b>${clock.lastRun.unmapped}</b> · Ya estaban al día: <b>${clock.lastRun.skipped}</b>${
          clock.lastRun.notClaimed ? ` · Esperando activación en Humand: <b>${clock.lastRun.notClaimed}</b>` : ""
        }${clock.lastRun.duplicates ? ` · Rebotes descartados: <b>${clock.lastRun.duplicates}</b>` : ""}</p>
         ${
           clock.lastRun.notClaimed
             ? `<p class="muted">"Esperando activación en Humand" son personas que existen en la comunidad y están bien mapeadas, pero todavía no reclamaron/activaron su cuenta de Humand — la API no deja registrar fichaje hasta que lo hagan. No es un error de este conector; se resuelve solo apenas activen la cuenta.</p>`
             : ""
         }
         ${
           clock.lastRun.duplicates
             ? `<p class="muted">"Rebotes descartados" son marcaciones del mismo empleado a menos de 1 minuto de la anterior (doble lectura del sensor) — se ignoran para no generar un turno fantasma con la misma hora de entrada y salida.</p>`
             : ""
         }
         ${
           clock.lastRun.stuckPunches?.length
             ? `<p style="color:#C0392B;">⛔ Marcas que Humand rechazó por duplicadas (no llegaron a Humand):</p><ul>${clock.lastRun.stuckPunches
                 .map(
                   (m) =>
                     `<li>${m.name ? `${m.name} — ` : ""}DNI ${m.employeeInternalId}: marca del ${new Date(Date.parse(m.recordTime) - 3 * 3600e3).toISOString().replace("T", " ").slice(0, 16)} (ART), enviada como ${m.direction === "START" ? "entrada" : "salida"}; el último fichaje que conocemos fue ${m.lastType === "START" ? "una entrada" : "una salida"} ${m.hoursSinceLastPunch != null ? `${m.hoursSinceLastPunch}hs antes` : ""}. Intentos: ${m.attempts}.</li>`
                 )
                 .join("")}</ul><p class="muted">Revisá y corregí el turno de esa persona en Humand (suele faltar una salida). La marca se reenvía sola en cuanto Humand la acepte; no se descarta.</p>`
             : ""
         }
         ${
           clock.lastRun.openShifts?.length
             ? `<p style="color:#8A5A00;">⚠️ Turnos abiertos hace más de 14hs (revisar y corregir a mano en Humand):</p><ul>${clock.lastRun.openShifts
                 .map(
                   (o) =>
                     `<li>${o.name ? `${o.name} — ` : ""}DNI ${o.employeeInternalId}: marcó entrada hace ${o.hoursOpen}hs y no volvió a fichar</li>`
                 )
                 .join("")}</ul><p class="muted">Puede ser que a la persona le haya faltado fichar una marca en el medio del día (ej. la vuelta de almuerzo) — eso corre el resto de las marcas de ESE día. No afecta a los días siguientes.</p>`
             : ""
         }
         ${
           clock.lastRun.suspectPunches?.length
             ? `<p style="color:#8A5A00;">⚠️ Marcas lejos del horario programado (posible marca de más que invierte entrada/salida — revisar en Humand):</p><ul>${clock.lastRun.suspectPunches
                 .map(
                   (x) =>
                     `<li>${x.name ? `${x.name} — ` : ""}DNI ${x.employeeInternalId}: ${x.direction === "START" ? "entrada" : "salida"} el ${new Date(Date.parse(x.recordTime) - 3 * 3600e3).toISOString().replace("T", " ").slice(5, 16)} (ART), a ${x.diffHours}hs del horario ${x.schedule}</li>`
                 )
                 .join("")}</ul><p class="muted">Solo es una alerta: no cambia lo que se envió. Se mantiene 48hs.</p>`
             : ""
         }
         ${
           clock.lastRun.missingCheckIns?.length
             ? `<p style="color:#8A5A00;">⚠️ Marcas reclasificadas como salida (llegaron después del fin de turno programado y no tenían entrada ese día):</p><ul>${clock.lastRun.missingCheckIns
                 .map(
                   (m) =>
                     `<li>${m.name ? `${m.name} — ` : ""}DNI ${m.employeeInternalId}: única marca del día a las ${m.recordTime} (UTC)</li>`
                 )
                 .join("")}</ul><p class="muted">Se mandó como salida en vez de entrada. Cargar la entrada real a mano en Humand si corresponde.</p>`
             : ""
         }
         ${errorLines ? `<p style="color:#C0392B;">Errores:</p><ul>${errorLines}</ul>` : ""}`
      : `<p class="muted">Todavía no corrió ninguna sincronización.</p>`
  }
</div>

<div class="card">
  <h2>IDs de usuario vistos en el reloj sin mapear a Humand</h2>
  <p class="muted">Estos son los "ID de Usuario" que el reloj reporta en sus marcaciones, junto con el nombre que el propio reloj tiene cargado para ese perfil (no hace falta pedírselo al cliente: se trae directo del dispositivo en cada sincronización). Cuando ese nombre coincide con una sola persona de la comunidad, se marca con ✅ y ya viene preseleccionada — igual conviene confirmar antes de guardar.</p>
  ${
    communityUsersError
      ? `<p style="color:#C0392B;">No se pudo traer la lista de la comunidad de Humand (${communityUsersError}) — se muestra el campo de texto libre como respaldo.</p>`
      : `<p class="muted">${communityUsers.length} persona(s) en la comunidad · <a href="?refreshUsers=1">actualizar lista</a></p>`
  }
  ${
    suggestedCount > 0
      ? `<form method="POST" action="/clocks/${clock.id}/mapping/automap" style="margin-bottom:10px;">
           <button type="submit">Vincular automáticamente los ${suggestedCount} sugeridos (✅)</button>
         </form>`
      : ""
  }
  ${suggestions.length === 0 ? `<p class="muted">No hay IDs pendientes de mapear (o todavía no se sincronizó).</p>` : `<table><thead><tr><th>ID en el reloj</th><th>Nombre en el reloj</th><th>Asociar a Humand</th></tr></thead><tbody>${unmappedRows}</tbody></table>`}
</div>

<div class="card">
  <h2>Usuarios ya mapeados</h2>
  ${mappedRows ? `<table><thead><tr><th>ID en el reloj</th><th>employeeInternalId en Humand</th><th></th></tr></thead><tbody>${mappedRows}</tbody></table>` : `<p class="muted">Todavía no hay mapeos guardados.</p>`}
</div>

<div class="card">
  <h2>Recuperación (avanzado)</h2>
  <p class="muted">Si corriste un sync en dry-run y después vas a activar el envío real, usá esto para que las marcaciones que ya se "simularon" se vuelvan a procesar de cero — si no, quedarían atascadas como si ya se hubieran enviado (bug real de dedup en dry-run, corregido el 18/8). Solo tiene sentido si nunca hiciste un envío REAL con este reloj todavía.</p>
  <form method="POST" action="/clocks/${clock.id}/reset-sync-state" onsubmit="return confirm('¿Reiniciar el estado de sincronización de este reloj? Las marcaciones ya mapeadas se van a volver a procesar en el próximo sync.');">
    <button class="secondary" type="submit">Reiniciar estado de sincronización</button>
  </form>
</div>
`,
      getSessionEmail(req)
    )
  );
});

app.post("/clocks/:id/test", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");
  try {
    const result = await testConnection(clock.ip, clock.port);
    clock.testResult = result;
  } catch (err) {
    clock.testResult = { ok: false, error: String(err.message || err) };
  }
  // Aprovechamos la conexión de prueba para refrescar también los nombres
  // enrolados en el reloj (ver la nota grande en la card de mapeo) — así
  // quedan visibles desde el primer test, sin esperar a la primera sync.
  try {
    const deviceUsers = await fetchDeviceUsers(clock.ip, clock.port);
    clock.deviceUserNames = Object.fromEntries(deviceUsers.filter((u) => u.name).map((u) => [u.deviceUserId, u.name]));
  } catch (_) {
    /* best effort, no bloquea el resultado del test de conexión */
  }
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

app.post("/clocks/:id/sync", async (req, res) => {
  // req.body puede venir undefined si el POST no manda body/Content-Type
  // (ej. un curl sin -d, o el disparo del cron) — express.urlencoded() no
  // siempre lo deja en {} en ese caso.
  const onlyToday = req.body?.onlyToday === "1";
  await syncClock(req.params.id, { onlyToday }).catch(() => {});
  res.redirect(`/clocks/${req.params.id}`);
});

// Recuperación para el bug de dedup en dry-run corregido el 18/8 (ver nota
// grande en lib/poller.js): antes de la corrección, una sync en dry-run
// marcaba las marcaciones como "ya enviadas" sin haberlas mandado de
// verdad. Este botón limpia ese estado (sentKeys + alternancia START/END)
// para que el próximo sync real las procese de cero. Seguro de usar
// mientras HUMAND_DRY_RUN nunca haya estado en false para este reloj — no
// hay ningún envío real que se pueda estar "perdiendo".
app.post("/clocks/:id/reset-sync-state", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");
  clock.sentKeys = [];
  // La alternancia entrada/salida (antes clock.directionState) ya NO vive acá
  // — desde el 19/8 es por empleado y se comparte entre todos los relojes del
  // mismo cliente (tabla employee_state, ver lib/poller.js), justamente para
  // no perderla si la persona fichó en más de un reloj. Reiniciar UN reloj no
  // debe resetear esa alternancia compartida a mitad de jornada.
  //
  // También el cache de employeeId (ver resolveEmployeeId en
  // lib/humandClient.js): si se cacheó antes de que existiera la validación
  // de status UNCLAIMED, el próximo sync lo saltearía sin re-chequear.
  clock.employeeIdCache = {};
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

// Activa/desactiva el envío real SOLO para este reloj (pisa el
// HUMAND_DRY_RUN global, ver effectiveDryRun en lib/humandClient.js) — así
// se puede validar un reloj a la vez sin afectar a los demás, que siguen en
// dry-run hasta que también se validen.
app.post("/clocks/:id/dry-run", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");
  clock.dryRun = req.body?.dryRun !== "false";
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

// Activa/desactiva, SOLO para este reloj, la reclasificación de "marca única
// del día que llega después del fin de turno programado" como salida en vez
// de entrada (ver la nota grande de isLateLonePunchCheckoutEnabled en
// lib/poller.js). Es un flag aparte del dry-run de envío a propósito: se
// puede activar esta lógica en un reloj que siga en dry-run para validarla
// con datos reales de Humand sin mandar nada de verdad todavía.
app.post("/clocks/:id/late-lone-punch-checkout", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");
  clock.lateLonePunchCheckoutEnabled = req.body?.enabled === "true";
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

app.post("/clocks/:id/mapping", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");
  clock.userMap = clock.userMap || {};
  clock.userMap[req.body.deviceUserId] = req.body.humandUserId;
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

app.post("/clocks/:id/mapping/remove", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");
  clock.userMap = clock.userMap || {};
  delete clock.userMap[req.body.deviceUserId];
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

// Aplica de una sola vez todos los mapeos que tengan sugerencia sin
// ambigüedad (nombre enrolado en el reloj == exactamente una persona de la
// comunidad, ver computeSuggestions arriba). Es la misma lógica que ya se
// ve en pantalla con el ✅ — este botón simplemente guarda todas esas de un
// solo click en vez de confirmar fila por fila.
app.post("/clocks/:id/mapping/automap", async (req, res) => {
  const clock = await getClock(req.params.id);
  if (!clock) return res.status(404).send("Reloj no encontrado");

  let communityUsers = [];
  try {
    communityUsers = await getCommunityUsers();
  } catch (err) {
    return res.redirect(
      `/clocks/${clock.id}?error=${encodeURIComponent("No se pudo traer la comunidad de Humand: " + (err.message || err))}`
    );
  }

  const suggestions = computeSuggestions(clock, communityUsers);
  clock.userMap = clock.userMap || {};
  let applied = 0;
  for (const { id, suggested } of suggestions) {
    if (!suggested) continue;
    clock.userMap[id] = suggested.employeeInternalId;
    applied++;
  }
  await upsertClock(clock);
  res.redirect(`/clocks/${clock.id}`);
});

app.post("/clocks/:id/delete", async (req, res) => {
  await deleteClock(req.params.id);
  res.redirect("/");
});

module.exports = app;

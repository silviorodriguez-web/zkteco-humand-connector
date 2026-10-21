# Integración ZKTeco → Humand — guía de traspaso

Documento para quien tome la cuenta. Explica **qué es, cómo funciona, cómo
está armado, cómo operarlo y qué se aprendió en producción**. Complementa a
`README.md` (visión general) y `HANDOFF.md` (checklist histórico de deploy).
Estado de este documento: **30/9/2026**.

> Si solo tenés 5 minutos, leé las secciones 1, 2, 7 y 9.

---

## 1. Qué es y para quién

Un puente que **Humand corre** (el cliente no levanta nada) entre los relojes
biométricos ZKTeco del cliente y el módulo **Control de Asistencia (Time
Tracking)** de Humand.

- **Cliente en producción:** el cliente (comunidad Humand instance <ID>).
- **Relojes:** 3 — EMPAQUE, COMEDOR, LABORATORIO 4 (~150 empleados).
- **Envío real:** activado en los 3.
- **Modelo:** *pull*. Nosotros nos conectamos al reloj por la IP pública y el
  puerto que el cliente ya tiene expuestos (4370, 4372, …) con el protocolo
  nativo de ZKTeco (`node-zklib`). No hay ADMS ni servidor del lado del
  cliente.

## 2. Cómo fluye una marcación (resumen ejecutable)

```
Reloj (guarda {ID usuario, fecha/hora})
   │  cada 15 min
Cloudflare Worker ──GET /api/cron/sync (Bearer CRON_SECRET)──► Vercel (api/cron/sync.js)
                                                                    │ syncAllClocks() → 3 relojes EN PARALELO
                                                                    ▼
                                                        lib/poller.js  syncClock()
   1. baja TODAS las marcas del reloj (lib/zkteco.js) y corrige la hora a UTC real
   2. dedup por reloj:  key = userSn-timestamp  (clock.sentKeys, últimas 5000)
   3. mapea "ID de usuario del reloj" → employeeInternalId (DNI) de Humand  (clock.userMap)
        └ sin mapeo → queda pendiente, NO se pierde, se reintenta cada ciclo
   4. descarta rebotes del lector (mismo empleado, <60 s de la última enviada)
   5. decide ENTRADA o SALIDA (el reloj no lo informa) → peekDirection()
   6. POST a Humand: /time-tracking/entries/clockIn | clockOut
   7. recién si Humand aceptó, avanza el estado (employee_state) y marca la marca como enviada
```

El cron **solo procesa las marcas del día calendario argentino**
(`SYNC_ONLY_TODAY=true`, default). El backlog anterior queda intacto hasta que
alguien lo vuelque a mano desde el dashboard.

## 3. Dónde vive todo (⚠️ cuentas personales hoy)

| Pieza | Dónde | Notas |
|---|---|---|
| App + API + dashboard | Vercel, proyecto `zkteco-connector`, team personal del responsable, plan **Hobby** | URL: `https://<tu-deploy>.vercel.app` |
| Base de datos | Neon Postgres (vía Vercel Storage), plan **free** | Tablas `clocks`, `employee_state` (se crean solas, `lib/db.js`) |
| Disparador del cron | Cloudflare Worker `zkteco-connector-cron`, plan **free** | Cada 15 min. Ver `cloudflare-cron-worker/` |
| Código | GitHub `<org>/zkteco-connector` | |

**Lo primero que hay que hacer al tomar la cuenta:** migrar estas 4 cosas a
cuentas/org de Humand (GitHub org `Humand-CX`, team de Vercel, cuenta de
Cloudflare y proyecto Neon compartidos). Nada de esto está atado a la persona
salvo la titularidad de las cuentas.

Es 100% serverless: no hay servidores ni procesos de fondo.

### Por qué hay un Worker de Cloudflare
Vercel Hobby solo permite cron **1 vez por día** (y rechaza el deploy si el
cron de `vercel.json` es más frecuente). El cron de `vercel.json`
(`0 6 * * *`) queda como red de contención diaria; el que sincroniza de
verdad es el Worker. Si se pasa a Vercel Pro, se puede borrar el Worker y
poner el cron en `vercel.json`.

### Por qué 15 minutos y no 5
Con `*/5` cada disparo despertaba el compute de Neon antes de que se
auto-suspendiera, y se agotaba la cuota free mensual (100 CU-h) sin tráfico
real. Bajado a `*/15` el 28/8. Si algún cliente necesita más frecuencia,
evaluar por cliente o subir de plan Neon antes de volver a bajar el
intervalo. (Ojo: el README principal todavía dice "cada 5 minutos" en varios
lugares — está desactualizado.)

## 4. Mapa del código

```
api/index.js           App Express completa (dashboard + endpoints). Una sola función serverless.
api/cron/sync.js       Endpoint del cron. Valida CRON_SECRET y llama a syncAllClocks({onlyToday}).
lib/poller.js          El cerebro: lee reloj → mapeo → dedup/rebote → entrada/salida → envío.
lib/zkteco.js          Protocolo ZKTeco (node-zklib). Corrige la zona horaria (ver §6.1).
lib/humandClient.js    Llamadas a la API de Humand (clockIn/Out, /users, day-summaries) + dry-run.
lib/store.js           CRUD sobre Postgres (clocks, employee_state).
lib/db.js              Pool de Postgres + creación de tablas.
lib/session.js         Cookie de sesión firmada (HMAC), 12 h, sin tabla.
cloudflare-cron-worker Worker que dispara el cron.
scripts/simulate-test.js  `npm test`: pipeline completo sin reloj ni base (mockea zkteco y store).
server.js              SOLO desarrollo local (`npm run dev`). Vercel no lo usa.
vercel.json            Rewrites (todo lo que no es /api/* va a api/index), cron diario, maxDuration.
```

### Modelo de datos
- **`clocks`** (`id`, `data` JSONB): un registro por reloj. Dentro de `data`:
  `alias`, `clientName`, `ip`, `port`, `userMap` (`{deviceUserId → DNI}`),
  `sentKeys`, `deviceUserNames` (nombres enrolados en el reloj), `dryRun`,
  `lateLonePunchCheckoutEnabled`, `lastRun`, `status`, `lastSyncAt`,
  `employeeIdCache`.
- **`employee_state`** (`client_key`, `employee_internal_id`, `data`): estado
  de la alternancia por empleado: `{date, lastType, lastRecordTimeMs}`.
  **Se comparte entre todos los relojes del mismo `clientName`** (alguien
  puede fichar entrada en EMPAQUE y salida en COMEDOR). Si un reloj no tiene
  `clientName`, se aísla por su id.

## 5. API de Humand — lo que hay que saber

Base: `https://api-prod.humand.co/public/api/v1` — swagger en `/api-docs/`.
Auth: header `Authorization: Basic {api_key}` (literal, **no** es Basic
estándar en base64).

| Uso | Endpoint | Gotchas confirmados en vivo |
|---|---|---|
| Fichar | `POST /time-tracking/entries/clockIn` / `clockOut` | `employeeId` debe ser el **`employeeInternalId` (DNI/legajo) como *string***. El swagger dice "PositiveInteger" y el id numérico interno: ambos están mal. Con el id equivocado da 404 `USER_NOT_FOUND`. |
| Validar cuenta | `GET /users/{employeeInternalId}` | Si `status != ACTIVE` (ej. `UNCLAIMED`) Humand **no deja fichar**. Se corta antes del POST y se cuenta como "esperando activación". |
| Listar comunidad | `GET /users?limit=&page=` | `limit` máx. **50**. Se pagina con **`page`** (1-indexado); `offset` y el filtro `email=` se **ignoran** en silencio. |
| Horario programado | `GET /time-tracking/day-summaries?employeeIds=&startDate=&endDate=` | Devuelve `hasSchedule`, `timeSlots` (hora **local ART**), `entries`. Es **Horario Laboral**, no "Turnos": `GET /shifts/planning` viene vacío en este cliente. |

Cada fichaje lleva `comment: Marcado en el reloj "<alias>" (sincronización automática)`
para que el cliente vea de qué reloj vino.

Errores esperables de Humand: `429` (se corta el ciclo y se retoma en el
próximo), `422 TIME_TRACKING_ENTRY_DUPLICATE` (dos entradas o dos salidas
seguidas — suele indicar que la alternancia se desfasó).

## 6. Las decisiones no obvias (leer antes de tocar `poller.js`/`zkteco.js`)

### 6.1 Hora del reloj (bug de 3 h)
`node-zklib` arma `new Date(y,m,d,h,mi,s)` con el constructor **local**,
asumiendo que el proceso corre en Argentina. En Vercel (UTC) todas las marcas
quedaban corridas −3 h. `fixDeviceLocalTime()` (`lib/zkteco.js`) reconstruye
el instante real asumiendo que los campos del reloj son ART (UTC−3 fijo, sin
horario de verano). El reloj en sí tiene la hora bien.

### 6.2 Entrada vs. salida es una **inferencia**
`node-zklib` no decodifica el tipo de marca: cada línea llega como
`{deviceUserId, recordTime}`. Se alterna por empleado y por **día argentino**
(`argentinaDateKey`, nunca día UTC): primera del día = entrada, siguiente =
salida, etc. Tres correcciones críticas en producción, todas con test de
regresión:

1. **Estado por empleado, no por reloj** (19/8): si no, entrada en un reloj y
   salida en otro se mandaban como dos entradas.
2. **Día Argentina, no UTC** (15/9): una salida entre 21:00 y 23:59 ART cae en
   el día UTC siguiente y se mandaba como entrada → Humand la rechazaba y la
   salida se perdía.
3. **Turnos nocturnos que cruzan medianoche ART** (28/9): si cambia el día
   pero la última marca fue una entrada hace ≤ 16 h
   (`MAX_SHIFT_EXTENSION_MS`), la marca es el **cierre** de ese turno (END),
   no una entrada nueva. Sin esto el turno quedaba abierto para siempre.

El estado **solo avanza si Humand aceptó el POST** — si falla, no se mueve,
para no desalinear lo que viene.

### 6.3 Rebote del lector
Un mismo toque puede quedar grabado dos veces con segundos de diferencia.
Marcas del mismo empleado a <60 s de la última enviada se descartan (se
marcan como procesadas, no se mandan, no mueven la alternancia). Sin esto se
generaban turnos fantasma de 0 minutos.

### 6.4 Dry-run no consume estado
En dry-run todo corre igual pero no llama a Humand **ni marca nada como
enviado**. (Antes sí lo hacía y al pasar a real esas marcas nunca se
mandaban.) Hay dry-run **global** (`HUMAND_DRY_RUN`, default `true`) y **por
reloj** (`clock.dryRun`, pisa al global). Hoy los 3 relojes tienen envío real
por override de reloj.

### 6.5 Reclasificación de marca tardía (opt-in, por reloj)
Caso reportado por el cliente: alguien olvida fichar la entrada y su única
marca del día es la salida; se mandaba como entrada.
Si `clock.lateLonePunchCheckoutEnabled` está activo y es la **primera marca
del día** del empleado, se consulta `day-summaries`; si hay Horario Laboral y
la marca llega después del fin del último slot + tolerancia (30 min,
`lateLonePunchToleranceMinutes`), se manda como **salida** y se anota en
`lastRun.missingCheckIns` (panel: "Marcas reclasificadas como salida") para
que alguien cargue la entrada a mano.

Se **aborta la reclasificación** (se mantiene entrada) si: no hay horario ese
día; Humand ya tiene fichajes ese día (evita un END duplicado); **el horario
es nocturno** (`endTime < startTime` — en dry-run daba falsos positivos, 15
casos reales, así que por ambigüedad no se toca); o falla la consulta a
Humand (nunca bloquea el sync).

### 6.6 Alerta de "turno abierto"
Si el último estado de un empleado es entrada hace >14 h, aparece en el panel
("Turnos abiertos hace más de 14hs"). Es solo lectura: **avisa, no corrige**.
La corrección es manual en Humand. Humand además cierra solo los turnos por
su propio límite (20 h, "olvido de marcaje").

### 6.7 Paralelismo
`syncAllClocks` corre los relojes en paralelo. En serie, 3 relojes × 2
conexiones × 10 s de timeout podían sumar 60 s = `maxDuration` del cron, y
un reloj lento tumbaba el ciclo de los 3.

## 7. Operación del día a día

### Dashboard (`/`, requiere login)
- **Login:** el cliente entra con su "usuario" de Humand (en esta comunidad es
  el **DNI** = `employeeInternalId`; también acepta email). Se valida contra
  `/users` con `HUMAND_API_KEY`. Equipo interno: `ADMIN_EMAILS` (entran sin
  estar en la comunidad) y, como puerta trasera, `APP_BASIC_AUTH_USER/PASS`.
- **Por reloj** (`/clocks/:id`): Probar conexión, Sincronizar (todo lo
  pendiente / solo lo de hoy), activar envío real, activar reclasificación,
  resetear estado de sync, mapeo de usuarios, borrar reloj.

### Alta de un reloj nuevo
1. El cliente necesita IP pública + puerto externo con port-forwarding al 4370
   del reloj (pedir captura del NAT del router).
2. Dashboard → nuevo reloj (alias, `clientName` **igual al de los otros
   relojes del cliente** para compartir estado, IP, puerto). Queda en dry-run
   salvo override.
3. **Probar conexión** (trae además los nombres enrolados).
4. **Mapear usuarios** (ver abajo).
5. Validar en dry-run → "Sincronizar solo lo de hoy" con un solo empleado
   mapeado y verificar en Humand → recién ahí "Activar envío real".

### Mapeo `ID del reloj → usuario de Humand`
La pieza **más sensible**: un mapeo mal hecho manda asistencia real a la
persona equivocada. En el detalle del reloj: sección "IDs de usuario vistos
en el reloj sin mapear". Las sugerencias ✅ aparecen cuando el nombre
enrolado en el reloj calza sin ambigüedad con **una** persona de la
comunidad; hay botón para aplicar todas (`/mapping/automap`). Aun así,
mirar el nombre antes de confirmar. Se guarda el DNI, no el id numérico.

### Variables de entorno (Vercel)
| Var | Para qué |
|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | Base (usar la connection string **pooled** de Neon) |
| `CRON_SECRET` | Protege `/api/cron/sync`. **Tiene que ser igual al secret del Worker** |
| `HUMAND_API_KEY` | API key de la comunidad del cliente (login + /users + fichajes) |
| `HUMAND_BASE_URL` | Opcional; default prod |
| `SESSION_SECRET` | Firma de la cookie (si falta cae a `CRON_SECRET`) |
| `ADMIN_EMAILS` | Emails internos que entran al dashboard |
| `APP_BASIC_AUTH_USER/PASS` | Puerta trasera interna (opcional) |
| `HUMAND_DRY_RUN` | Default global, `true` |
| `SYNC_ONLY_TODAY` | Default `true`; el cron solo procesa "hoy" |

⚠️ Si se rota `CRON_SECRET`: `npx wrangler secret put CRON_SECRET` en
`cloudflare-cron-worker/`. Si no, el cron devuelve 401 **en silencio** y deja
de sincronizar sin romper nada visible.

### Disparar un sync manual
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<tu-deploy>.vercel.app/api/cron/sync
```
(o un GET a la URL del Worker). Devuelve por reloj `sent / skipped /
unmapped / notClaimed / duplicates / openShifts / missingCheckIns / errors`.

### Desarrollo y tests
```bash
npm install
npm test       # simula relojes + base en memoria; no necesita nada externo
npm run dev    # http://localhost:3000 (necesita un Postgres)
```
`npm test` cubre mapeo, dedup, dry-run, estado compartido entre relojes y las
reglas de reclasificación/nocturnos. **Correrlo antes de cualquier cambio en
`poller.js`.**

## 8. Troubleshooting (casos que ya pasaron)

| Síntoma | Causa más probable | Qué hacer |
|---|---|---|
| "El reloj no me tomó la marcación" / la persona figura **Ausente** | **ID sin mapear** (9 de 10 veces). Caso real: un empleado registrado en un solo reloj, sin mapeo → nada se enviaba | Detalle del reloj → IDs sin mapear → confirmar → "Sincronizar solo lo de hoy" (o "todo lo pendiente" si hay que recuperar días) |
| Marca leída pero no llega, sin error | Cuenta Humand `UNCLAIMED` | Contador "esperando activación". Se resuelve solo cuando la persona activa su cuenta |
| Un reloj en estado `error` | Mirar `lastRun.errors`: reloj inalcanzable (`EHOSTUNREACH`/timeout), 429, o **422 duplicado** | Reachability: probar conexión y revisar port-forwarding del cliente. 422: ver fila siguiente |
| 422 `TIME_TRACKING_ENTRY_DUPLICATE` (desde 1/10 se muestra como pastilla "Atención" + bloque "Marcas que Humand rechazó por duplicadas", no como Error) | La alternancia quedó desfasada (marca faltante, salida reclasificada mal, o turno nocturno sin cerrar). También pasa si Humand ya tiene un fichaje "AUTO_CLOSE" que choca con la marca que mandamos | Revisar el turno de esa persona en Humand, corregir a mano; la marca (`clock.stuckPunches`) se reintenta sola, con backoff de 3 h tras 4 intentos, y sigue reintentándose aunque ya no sea "de hoy"; los casos nocturnos y de día UTC ya están arreglados en código |
| Turno "abierto" >14 h | Falta una marca en el medio del día | Corregir a mano en Humand |
| Hora corrida 3 h | Regresión de `fixDeviceLocalTime` | No tocar; ver §6.1 |
| El cron "no corre" | Worker caído, `CRON_SECRET` desalineado (401), o Neon sin cuota | Ver logs del Worker en Cloudflare; probar el `curl` de arriba |
| Mapeos cruzados entre personas (ej. dos empleadas con marcas intercambiadas) | Un mapeo confirmado mal o un ID reasignado en el reloj | Revisar `userMap` del reloj afectado y corregir. Se hizo un backfill de ~80 casos entre los 3 relojes en septiembre |

## 9. Antes de tocar producción — reglas de oro

1. **No pasar un reloj a envío real** sin probarlo con **un** empleado
   mapeado.
2. **No usar "Sincronizar (todo lo pendiente)"** en un reloj recién activado:
   manda de golpe todo el historial.
3. **No reclasificar ni cambiar la alternancia sin test de regresión.** Los
   cuatro bugs "críticos" de `poller.js` (15/9, 28/9, y los anteriores) se
   dieron por casos borde de fechas/turnos nocturnos. Cualquier cambio acá
   debe probarse con: salida entre 21:00 y 23:59, turno nocturno
   (21:30–06:30) y entrada/salida en relojes distintos.
4. **Cuidado con el mapeo**: es asistencia real de personas reales.
5. Un error en un reloj **no debería** frenar a los otros (corren en
   paralelo con try/catch por reloj); si pasa, es un bug.
6. No committear `.env*` ni la API key (están en `.gitignore`).

## 10. Límites y capacidad (26/8)

| Servicio | Uso | Límite |
|---|---|---|
| Cloudflare Worker | ~96 disparos/día | 100.000/día |
| Neon | ~8 MB | 0,5 GB; **cuota de compute 100 CU-h/mes es el límite real** |
| Vercel cron function | 60 s | techo de Hobby |

El primer número a vigilar si se suman relojes/clientes es la **duración del
sync (60 s)** y el compute de Neon, no el storage.

## 11. Limitaciones conocidas / ideas pendientes

- Entrada/salida **se infiere**; decodificar el byte de tipo de marca del
  paquete crudo (o confirmar firmware) eliminaría la heurística.
- La reclasificación de marca tardía no cubre turnos nocturnos (por
  ambigüedad) — requeriría resolver qué `referenceDate` consultar.
- `sentKeys` está capado a 5000 por reloj (suficiente hoy).
- El README principal todavía menciona el cron de 5 min y la alternancia
  solo por día UTC/ART sin el caso nocturno; este documento es la referencia
  vigente.
- Sin alertas automáticas: si un reloj queda en `error` nadie se entera salvo
  que mire el dashboard. Un aviso (Slack/email) sería la mejora de mayor
  valor operativo.
- Migrar cuentas personales → cuentas de equipo (ver §3).

### 6.8 Marcas trabadas por 422 (1/10)
Antes un 422 duplicado se reintentaba cada ciclo y contaba como error; y con
`onlyToday`, al pasar la medianoche el cron dejaba de mirar la marca y el panel
mostraba OK aunque nunca llegó a Humand. Ahora se guarda en
`clock.stuckPunches`, el reloj queda en `warning`, se reintenta aunque no sea
de hoy (backoff: cada ciclo 4 veces, luego cada 3 h) y nunca se descarta ni se
inventa una salida. Test: `testStuckPunch422`.

### 6.9 Dirección por horario en turnos nocturnos (1/10)
Causa raíz del reclamo de A/B: entre el 15/9 y el 28/9 las salidas de
la mañana de los turnos nocturnos no llegaban a Humand (el cambio a día
argentino del 15/9 las leía como entradas y Humand las rechazaba), la clienta
las cargó a mano y la alternancia quedó invertida. Ahora, para quien tiene un
Horario Laboral NOCTURNO en Humand, la dirección sale de la hora de la marca:
±3 h del inicio = entrada, de -4 h a +5 h del fin = salida; fuera de eso, o sin
horario nocturno, rige la alternancia de siempre. Se registra en
`lastRun.nightShiftCorrections`. Test: `testNightShiftDirectionByWindow`.
La API de Humand no permite editar ni borrar fichajes (solo crear), así que
los turnos partidos a mano (END 23:59 / START 00:00) se limpian desde el panel.

## 12. Historia resumida (por qué el código es como es)

| Fecha | Hito |
|---|---|
| 14/8 | Prototipo pull, login contra comunidad Humand |
| 18/8 | Primer envío real; se descubre UNCLAIMED, dry-run por reloj, bug de dedup en dry-run |
| 19/8 | Fix de hora (−3 h), `employeeInternalId` (ningún envío real había funcionado antes), estado compartido entre relojes, rebote del lector |
| 26/8 | Sync de relojes en paralelo, alerta de turno abierto |
| 28/8 | Cron 5→15 min por cuota de Neon |
| 4/9 | Reclasificación de marca tardía (opt-in), validada en vivo; se descartan turnos nocturnos |
| 15/9 | Fix de día UTC vs Argentina en la alternancia |
| 18/9 | Caso de empleado sin mapeo (resuelto con mapeo + sync manual) |
| 28/9 | Fix de cierre de turno nocturno que cruza medianoche ART |
| 1/10 | Marcas trabadas por 422: registro persistente, `warning`, backoff (caso EMPAQUE) |
| 1/10 | Turnos nocturnos: dirección por horario (corrige alternancia invertida) |

## Marcas de más que invierten entrada/salida (9/10/2026, casos E y D)

- **Causa:** la dirección se decide por alternancia; una marca de más (otro reloj a los pocos minutos, o una marca a media jornada) invierte todo lo que sigue.
- **Prevención:** una marca a < 10 min de una SALIDA se descarta como rebote (`POST_EXIT_REBOUND_WINDOW_MS`, `isDuplicatePunch`).
- **Detección:** si la dirección elegida cae a > 4 h del inicio/fin del horario del día en Humand, queda en `clock.suspectPunches` (48 h) y se ve en el panel ("Marcas lejos del horario"). Solo alerta, no cambia lo enviado.
- **Pendiente (opción 3):** decidir la dirección por horario para todos; probar primero en modo observación.
- **Corrección manual de estado:** `scripts/fix-state-*.js (puntuales, no incluidos)` (puntual, con guardas).

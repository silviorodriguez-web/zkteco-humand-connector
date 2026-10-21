> Versión pública: datos de personas, IPs y cuentas del cliente fueron anonimizados. Las credenciales NO están en el repo (ver `.env.example`).

# Conector ZKTeco → Humand

Puente que **Humand CX corre** (no el cliente) entre relojes biométricos
ZKTeco y la API de Humand: sale a buscar ("pull") las marcaciones a la IP y
puerto público que el cliente ya tiene hoy, sin que nadie tenga que levantar
un servidor propio ni abrir puertos nuevos.

En producción hoy: un cliente, 3 relojes (EMPAQUE, COMEDOR,
LABORATORIO 4), envío real activado. **Guía completa de traspaso y operación:
`INTEGRACION.md`** (referencia vigente). `HANDOFF.md` es el checklist
histórico del deploy inicial.

## Dónde vive esto (para el equipo de integraciones)

Todo corre sobre 3 servicios, **hoy bajo cuentas personales del responsable
Rodríguez** (no un team/org de Humand) — si el equipo de integraciones va a
tomar esto, lo primero es migrar estas 3 cuentas a algo compartido:

| Pieza | Dónde | Qué hace |
|---|---|---|
| App (dashboard + API) | [Vercel](https://vercel.com) — proyecto `zkteco-connector`, team personal `<tu-team>`, **plan Hobby** | Sirve el dashboard web y expone `/api/cron/sync` |
| Base de datos | [Neon](https://neon.tech) Postgres, conectada vía Vercel Storage — **plan free** | Guarda relojes configurados, mapeos, estado de sincronización (`clocks`, `employee_state`) |
| Disparador del cron cada 15 min | [Cloudflare Workers](https://workers.cloudflare.com) — worker `zkteco-connector-cron`, cuenta del responsable pero es cuenta personal, **plan free** | Le pega a `/api/cron/sync` cada 15 minutos (ver por qué más abajo) |
| Código fuente | GitHub, repo `<org>/zkteco-connector` | — |

No hay ningún servidor propio ni VM: es 100% serverless, sin proceso de
fondo — cada pieza se "despierta" solo cuando hay una request o un cron.

## Por qué "pull" y no ADMS

- **ADMS (push)**: el reloj manda los eventos a un servidor que alguien tiene
  que levantar y mantener con un puerto abierto a internet.
- **Este conector (pull)**: nosotros salimos a buscar los datos al reloj,
  usando la misma IP pública y puerto (4370+) que el cliente ya tiene
  configurados hoy. No hace falta abrir nada nuevo de su lado.

## Cómo fluye una marcación, paso a paso

1. Alguien ficha en el reloj físico. El reloj guarda `{ ID de Usuario,
   fecha/hora }` — no dice si fue entrada o salida (ver más abajo).
2. Cada 15 minutos, el Worker de Cloudflare le pega a
   `GET /api/cron/sync` (con `Authorization: Bearer CRON_SECRET`).
3. Esa función (`api/cron/sync.js` → `lib/poller.js`) se conecta a **los 3
   relojes en paralelo** por su protocolo nativo (`node-zklib`) y baja todas
   las marcaciones guardadas ahí.
4. Por cada marcación nueva (no procesada antes — dedup por reloj+timestamp
   en Postgres):
   - Si el "ID de Usuario" del reloj no está mapeado a un usuario de Humand
     todavía → queda pendiente, se reintenta en cada ciclo. **No se pierde**,
     solo no se envía hasta que alguien confirme el mapeo desde el dashboard.
   - Si dos marcas del mismo empleado llegan a menos de 1 minuto → se
     descarta como rebote del lector biométrico (no es un segundo evento
     real).
   - Si está mapeado: se infiere si es entrada o salida alternando por
     empleado y por día (primera marca del día = entrada, siguiente =
     salida, ...) — el reloj no reporta esto directamente, ver limitación
     abajo. Este estado es **compartido entre los 3 relojes del mismo
     cliente**: alguien puede fichar entrada en un reloj y salida en otro.
   - Se llama a `POST /time-tracking/entries/clockIn` o `.../clockOut` de
     Humand. Si la persona todavía no activó su cuenta de Humand, la API
     rechaza el envío — se cuenta aparte ("esperando activación"), no es un
     error del conector, se resuelve solo cuando activen la cuenta.
5. El dashboard (`/`, protegido con login) muestra el estado de cada reloj:
   última sync, cuántas se enviaron, cuántas quedaron sin mapear, cuántas
   esperando activación, y alertas de "turno abierto" (alguien marcó entrada
   hace más de 14hs y no volvió a fichar — normalmente indica que le faltó
   fichar una marca en el medio del día).

## Arquitectura del código

```
api/index.js          → toda la app Express (dashboard + endpoints), una única función serverless
api/cron/sync.js       → dispara el cron; llama a syncAllClocks() una vez por invocación
lib/db.js              → conexión Postgres
lib/store.js           → CRUD de relojes (tabla clocks) y de employee_state
lib/zkteco.js           → habla con el reloj por su protocolo nativo; corrige la hora del reloj a UTC real
lib/humandClient.js     → envía cada marcación a la API de Humand (respeta HUMAND_DRY_RUN)
lib/poller.js           → orquesta: lee reloj → mapea usuario → dedup/rebotes → alternancia entrada/salida → envía
server.js               → SOLO para dev local (node server.js); Vercel no lo usa
vercel.json             → rewrites (Express catch-all), cron nativo (fallback diario), límites de duración
cloudflare-cron-worker/ → Worker que dispara /api/cron/sync cada 15 min (ver por qué abajo)
scripts/simulate-test.js → prueba el pipeline completo sin reloj real ni base — mockea zkteco y store
```

## ⚠️ Por qué hay un cron en Vercel Y un Worker en Cloudflare

Vercel Cron nativo (`vercel.json`) solo corre **1 vez por día en el plan
Hobby** — no alcanza para un conector de asistencia. La solución fue un
Worker de Cloudflare (`cloudflare-cron-worker/`, gratis, sin límite práctico
en el free tier: 96 disparos/día contra un tope de 100k/día) que dispara
`/api/cron/sync` cada 15 minutos de verdad. El cron de `vercel.json` queda
solo como red de contención (una vez al día) por si el Worker fallara.

**Si algún día se pasa el proyecto a Vercel Pro**, se puede borrar el Worker
de Cloudflare y poner el cron directamente en `vercel.json` — es
una simplificación, no un cambio de comportamiento.

### Por qué 15 minutos y no 5

Con `*/5` cada disparo despertaba el compute de Neon antes de que llegara a
auto-suspenderse, y la cuota gratuita mensual (100 CU-hours) se agotaba sin
tráfico real. Se bajó a `*/15` el 28/8. Si algún cliente necesita más
frecuencia, evaluarlo por cliente o subir de plan en Neon antes de bajar el
intervalo.

## Entrada vs. salida — limitación conocida

`node-zklib` no decodifica el byte de "tipo de marca" del paquete crudo del
reloj — cada marcación llega solo con `{ deviceUserId, recordTime }`, sin
indicar si fue entrada o salida. El conector **infiere** la dirección
alternando por empleado y por día (`lib/poller.js`, función
`peekDirection`). Funciona bien en el caso típico, pero si a alguien le
falta fichar una marca en el medio del día, el resto de las marcas de *ese*
día quedan corridas — por eso existe la alerta de "turno abierto hace más de
14hs" en el dashboard: es la forma de detectar el síntoma y corregirlo a
mano en Humand, no de prevenirlo del todo.

### Correcciones posteriores a la alternancia (días y turnos nocturnos)

- **15/9 — día Argentina, no UTC**: la alternancia usaba el día calendario
  UTC; una salida entre 21:00 y 23:59 ART cae en el día UTC siguiente y se
  mandaba como entrada (Humand la rechazaba y la salida se perdía). Ahora usa
  `argentinaDateKey`.
- **28/9 — turnos nocturnos**: un turno que cruza la medianoche *argentina*
  (ej. 21:30–06:30) veía la salida como "primera marca de un día nuevo" y la
  mandaba como entrada (422 `TIME_TRACKING_ENTRY_DUPLICATE`, turno abierto
  para siempre). Ahora, si cambia el día pero la última marca fue una entrada
  hace ≤16 hs (`MAX_SHIFT_EXTENSION_MS`), se interpreta como el cierre de ese
  turno.
- Límite conocido de esa regla: si pasan más de 16 hs entre una entrada y la
  siguiente marca (ej. se olvidó de fichar la salida y vuelve al día
  siguiente), la marca nueva se manda como entrada, Humand la rechaza por
  duplicada y **queda reintentándose en cada ciclo** hasta que alguien
  corrija el turno a mano en Humand. Se ve como un error 422 en el reloj
  afectado.

### Caso particular: se olvidó de fichar la entrada y su única marca del día es la salida

Reportado por el cliente (el cliente, vía CX): a veces alguien se olvida de
fichar a la mañana y su único registro del día es, en realidad, la salida —
`peekDirection` lo tomaba ciegamente como entrada por ser la primera marca
del día, sin mirar la hora, y el reporte de asistencia quedaba desfasado.

Mitigación (opt-in, por reloj — `clock.lateLonePunchCheckoutEnabled`, botón
"Activar reclasificación de marca tardía (beta)" en el panel del reloj): si
el colaborador tiene **Horario Laboral** cargado en Humand (`GET
/time-tracking/day-summaries`, ver `lib/humandClient.js`) y su única marca
del día llega bien después del fin de turno programado (+ margen de
tolerancia, default 30 min, configurable con
`clock.lateLonePunchToleranceMinutes`), se manda como salida en vez de
entrada, y queda registrado en el panel bajo "Marcas reclasificadas como
salida" para que alguien la cargue a mano.

Ojo con la terminología de Humand: esto usa **Horario Laboral**, no
**Turnos** — probado en vivo el 4/9 contra la comunidad real del cliente,
`GET /shifts/planning` (Turnos) devolvía siempre `shifts: []` porque este
cliente no usa ese módulo, pero `day-summaries` sí trae `hasSchedule` +
`timeSlots` reales por día. Si `hasSchedule` es `false` (franco, o un
cliente que tampoco tenga Horario Laboral cargado), no hay con qué comparar
y se mantiene el comportamiento de siempre (entrada).

Apagado por defecto en todos los relojes existentes — activarlo no depende
del dry-run de envío (`clock.dryRun`): se puede prender esta lógica en un
reloj que siga en dry-run para validarla con horarios reales de Humand sin
mandar nada de verdad todavía.

## Estado real vs. simulado (dry-run)

Cada reloj tiene su propio flag de dry-run (independiente del resto). En
dry-run, todo el flujo corre igual (lectura, mapeo, cálculo de
entrada/salida) pero en vez de llamar a la API de Humand solo *loguea* qué
hubiese mandado. Al activar el envío real de un reloj por primera vez, usar
"Sincronizar solo lo de hoy" antes que "todo lo pendiente" — así no se manda
de un saque todo el historial acumulado en dry-run.

## Cómo diagnosticar los problemas más comunes

- **"El reloj no me tomó la marcación"** → 9 de cada 10 veces es un mapeo
  sin confirmar, no un problema del reloj ni de la red. Entrar al detalle
  del reloj en el dashboard → sección "IDs de usuario vistos en el reloj sin
  mapear" → si el ID en cuestión tiene un ✅ (sugerencia automática), solo
  falta confirmarlo. El reloj sí venía leyendo la marca, solo no se
  reenviaba hasta que el ID esté mapeado.
- **Alguien queda "activo" en Humand sin estarlo** → revisar si hubo un
  rebote del lector o una marca faltante en el medio del día (ver
  "turno abierto" arriba); corregir a mano en Humand, no rompe el estado de
  los días siguientes.
- **Un reloj aparece con estado `error`** → ver `clock.lastRun.errors` en el
  detalle del reloj; el 26/8 se corrigió un bug donde 3 relojes
  sincronizando en fila (con hasta 10s de timeout por conexión, 2 conexiones
  por reloj) podían sumar justo el límite de 60s del cron y tumbar el ciclo
  completo — ahora los 3 relojes corren en paralelo.
- **La hora de una marcación se ve corrida** → ya corregido (19/8): el reloj
  reporta su hora en Argentina, `node-zklib` la decodifica asumiendo que el
  proceso corre en esa misma zona horaria — cierto en local, falso en Vercel
  (UTC). El fix vive en `lib/zkteco.js` (`fixDeviceLocalTime`).

## Capacidad y límites de las cuentas usadas hoy (26/8/2026)

Todo corre muy por debajo de los límites gratuitos — no hay riesgo de romper
ninguna cuenta con el volumen actual (1 cliente, 3 relojes, ~150 empleados):

| Servicio | Uso actual | Límite del plan free/Hobby | Margen |
|---|---|---|---|
| Cloudflare Workers (cron cada 15 min) | ~96 disparos/día | 100.000 requests/día | <1% |
| Vercel Functions (Hobby) | 1 sync cada 15 min + tráfico del dashboard | Límite de ejecuciones mensuales generoso para este volumen | amplio |
| Neon Postgres (free tier) | 8 MB de base total | 0,5 GB en el free tier | ~1.5% |

El único límite real que ya pegamos es el de **duración de función** (60s en
el cron, propio del plan Hobby) — no es un límite de cuota, es un techo de
tiempo por ejecución, ya mitigado corriendo los relojes en paralelo (ver
arriba). Si se suman muchos más relojes/clientes en el futuro, ese es el
número a vigilar primero, no el de storage ni el de requests.

## ⚠️ Antes de tocar algo en producción

- No pasar `HUMAND_DRY_RUN` (global) ni el dry-run de un reloj puntual a
  envío real sin probarlo antes con un solo empleado mapeado.
- No usar "Sincronizar ahora (todo lo pendiente)" en un reloj recién
  activado a envío real sin haber corrido antes "solo lo de hoy" — podría
  mandar de golpe historial viejo.
- El mapeo (`deviceUserId → employeeInternalId de Humand`) es la pieza más
  sensible: un mapeo mal confirmado manda asistencia real a la persona
  equivocada. Las sugerencias automáticas (✅) solo aparecen cuando el
  nombre calza sin ambigüedad — igual conviene mirar el nombre antes de
  confirmar.
- `CRON_SECRET` protege `/api/cron/sync` — si se rota, hay que actualizar
  también el secret del Worker de Cloudflare (`wrangler secret put
  CRON_SECRET` en `cloudflare-cron-worker/`), si no el cron deja de andar
  silenciosamente (vuelve 401, no rompe nada pero deja de sincronizar).

## Probarlo sin nada externo

```bash
npm install
npm test        # simula reloj + base en memoria, no necesita Postgres ni un reloj real
```

Para correrlo con datos reales localmente, necesitás una `POSTGRES_URL` o
`DATABASE_URL` real (ver `.env.example`) — cualquier Postgres sirve, no hace
falta que sea el mismo que en producción.

```bash
npm run dev      # levanta http://localhost:3000
```

## Marcas rechazadas por duplicadas (422)

Si Humand rechaza una marca con `TIME_TRACKING_ENTRY_DUPLICATE`, queda en `clock.stuckPunches`, el reloj pasa a "Atención" (no "Error") y el detalle del reloj la lista. Se reintenta sola (backoff de 3 h tras 4 intentos) hasta que se corrija el turno en Humand. Ver `INTEGRACION.md` §6.8.

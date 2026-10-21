# Handoff para Claude Code — deploy en Vercel

Este proyecto llegó armado y probado (`npm test` corre offline, sin base ni
reloj real) desde otra sesión de Claude que no tenía credenciales de GitHub
ni de Vercel. Esta checklist es para la sesión que sí las tiene.

## Contexto en una línea

Conector Node/Express que hace *pull* de marcaciones desde relojes
biométricos ZKTeco (por IP:puerto) y las reenvía a la API de Humand.
Serverless-ready: sin `setInterval`, sin archivos en disco — persistencia en
Postgres, periodicidad vía Vercel Cron.

## Checklist de deploy

1. **Repo en GitHub**
   - Ya está inicializado como repo git local (`git log` para confirmar).
   - Crear el repo remoto (org sugerida: `Humand-CX`, nombre sugerido:
     `zkteco-connector`, privado) y pushear:
     ```bash
     gh repo create Humand-CX/zkteco-connector --private --source=. --remote=origin --push
     ```
     Si no hay acceso a esa org, crearlo bajo la cuenta personal del usuario
     y avisarle para que decida si lo mueve después.

2. **Base de datos (Postgres)**
   - Recomendado: Vercel → proyecto → tab **Storage** → **Create Database**
     → **Postgres** (Neon por debajo). Un click, sin cuenta separada, y
     Vercel inyecta `POSTGRES_URL` solo. Tiene free tier con capacidad de
     escalar a un plan pago sin migrar nada.
   - Alternativa equivalente si se prefiere no atarlo al proyecto de Vercel:
     crear un proyecto en [neon.tech](https://neon.tech) (free tier) y setear
     `DATABASE_URL` a mano con la connection string **pooled**.
   - El usuario ya dijo explícitamente que **no** quiere usar Supabase para
     esto (tiene muchos proyectos ahí y no quiere sumar límites) — no
     ofrecer Supabase como default.

3. **Variables de entorno en Vercel** (Project Settings → Environment
   Variables):
   - `POSTGRES_URL` — la inyecta Vercel Storage automáticamente si se usó
     la opción anterior.
   - `CRON_SECRET` — generar con `openssl rand -hex 32`. Vercel lo manda
     solo como `Authorization: Bearer $CRON_SECRET` en cada disparo del
     cron; el código en `api/cron/sync.js` ya valida contra esto.
   - `HUMAND_API_KEY` — la API Key de la comunidad del cliente . Es la que ya nos pasó, con la que se validó todo esto en
     vivo. **Cargarla solo como env var en Vercel, nunca committearla.**
   - `SESSION_SECRET` — generar con `openssl rand -hex 32` (si no se
     define, cae a `CRON_SECRET`, pero mejor uno propio).
   - `APP_BASIC_AUTH_USER` / `APP_BASIC_AUTH_PASS` — opcional, puerta trasera
     solo para el equipo interno (no se comparte con el cliente). Con
     `HUMAND_API_KEY` configurada ya no hace falta para el acceso del
     cliente (ver sección de login más abajo).
   - `HUMAND_DRY_RUN=true` — dejarlo así hasta probar el envío real de
     marcaciones (clockIn/clockOut) con un empleado real. **No cambiar a
     `false` sin que el usuario lo pida explícitamente.** Esto es
     independiente del login: el login sí pega contra la API real de
     Humand siempre (es una consulta de lectura, no toca asistencia).

4. **Deploy**
   ```bash
   vercel link      # conectar al proyecto (crear uno nuevo si no existe)
   vercel env pull  # opcional, para verificar que las env vars quedaron
   vercel --prod
   ```
   O, más simple: importar el repo de GitHub desde el dashboard de Vercel
   (Add New → Project → Import Git Repository) — detecta `vercel.json` solo.

5. **Verificar**
   - Abrir la URL de producción → debería pedir usuario/contraseña (si se
     configuró) y mostrar el dashboard vacío de relojes.
   - En Vercel → tab **Cron Jobs**, confirmar que `/api/cron/sync` aparece
     programado cada 5 minutos.
     - ⚠️ **En el plan Hobby de Vercel, los cron jobs corren como máximo una
       vez por día** — no van a poder tener sync cada 5 minutos ahí. Si el
       proyecto está en Hobby, avisarle al usuario y ofrecer dos caminos:
       pasar el proyecto a Pro, o disparar `/api/cron/sync` desde afuera
       (por ejemplo un GitHub Actions con `schedule:` cada 5 minutos, o un
       cron gratuito externo como cron-job.org) apuntando a esa URL con el
       header `Authorization: Bearer <CRON_SECRET>`.
   - Probar manualmente: `curl -H "Authorization: Bearer $CRON_SECRET" https://<deploy>/api/cron/sync`
     — con cero relojes configurados debería devolver `{"ok":true,"results":[]}`.

6. **Compartir con el cliente**
   - Una vez verificado, alcanza con pasarle el link a el cliente (Carlos
     del cliente): entra con su email de Humand (ver sección de login) y completa
     la IP pública y el puerto de sus 3 relojes.

## Login: "usuario de Humand" (resuelto 14/8)

Decisión final: el cliente entra a `/login` con su "usuario" de Humand — que
en la comunidad de el cliente **no es el email, es el DNI**. Se confirmó
que ese DNI es exactamente el `employeeInternalId` que devuelve la API de
Humand (se verificó contra 3 empleados reales: el número calza con formato
de DNI argentino, y el CUIL de uno de ellos se deriva exactamente de ese
mismo DNI). La app llama a `findUserByIdentifier()` (`lib/humandClient.js`)
contra la API real de Humand, usando `HUMAND_API_KEY` (global, no la de un
reloj puntual), matcheando por `employeeInternalId` (DNI) o por `email`; si
existe, se le da acceso vía un cookie firmado de 12hs (`lib/session.js`, sin
tabla en la base — es stateless). Si no existe, se lo rechaza con un mensaje
claro.

`ADMIN_EMAILS` (env var, coma-separado) es la excepción: emails del equipo
interno de Humand (no DNI) que entran directo sin pasar por la comunidad del
cliente — porque no son empleados de el cliente y nunca van a aparecer
ahí. Ya incluye a <email-del-equipo>.

Esto se probó **en vivo** contra la API real, con dos API Keys distintas
(incluida la de la comunidad del cliente, instance <ID>) — no quedó nada
sin confirmar:

- `GET /users?limit=N&offset=M` → `{ count: <total>, users: [ {email, employeeInternalId, id, ...}, ... ] }`.
- El query param `?email=` **se ignora** (no filtra) — por eso `findUserByEmail`
  pagina con `limit`/`offset` y compara el email a mano.
- `limit` máximo real: **50** (la API devuelve 400 `INVALID_DATA` si se pide
  más — probado con 100, falló).
- Confirmado con un email real de la comunidad del cliente: lo encuentra
  (`match`) y con un email inventado devuelve `null` — flujo probado
  end-to-end contra el server real (login rechaza / acepta / setea cookie /
  la cookie efectivamente destraba las rutas protegidas).

`APP_BASIC_AUTH_USER`/`PASS` se mantiene como puerta trasera interna (CX/
soporte), no se le menciona ni se le comparte al cliente.

## Estado de la integración con la API de Humand

Los endpoints ya están confirmados contra el swagger público
(`https://api-prod.humand.co/public/api/v1/api-docs/`) y wireados en
`lib/humandClient.js`: `POST /time-tracking/entries/clockIn|clockOut` +
`GET /users/{employeeInternalId}` para resolver el id numérico. Auth:
`Authorization: Basic {api_key}` (literal, no es Basic estándar).

Sigue en `HUMAND_DRY_RUN=true` por decisión, no por falta de información —
no cambiar a `false` sin que el usuario lo pida explícitamente, y antes de
hacerlo:

1. Confirmar con el usuario que tiene un API Key real de Humand para probar.
2. Probar contra **un solo reloj y un solo empleado mapeado**, revisar en el
   dashboard de Humand que el registro apareció bien.
3. Repasar con el usuario la heurística de entrada/salida (alternancia por
   empleado y por día, documentada en el README y en `lib/poller.js`) — es
   una inferencia, no un dato real del reloj, y conviene que la validen
   contra un caso real antes de confiar en ella para todos los empleados.


## Estado al 18/8 — datos reales del cliente, en progreso

**IP pública confirmada del cliente (el cliente)**: `203.0.113.10`.

Cliente mandó 3 relojes con IPs internas (Comedor .20, Laboratorio 4 .192,
Empaque .18) y capturas de su router con el NAT/port-forwarding real de 2 de
los 3:

| Reloj | IP interna | Puerto externo | Estado |
|---|---|---|---|
| EMPAQUE | 192.168.0.18 | 4370 | ✅ conectado en producción, ID clock `31c3df21-1bc6-43b4-b75b-ec59813e98ad` |
| LABORATORIO 4 | 192.168.0.192 | 4372 | ✅ conectado en producción, ID clock `ba905ad1-3b12-4871-a18c-2b12fc17b0fb` |
| COMEDOR | 192.168.0.20 | ❓ **pendiente** — falta que el cliente mande la captura de NAT de este (RELOJ0/RELOJ3) | no cargado aún |

Ambos relojes cargados fueron probados con `/clocks/:id/test` (protocolo
real ZKTeco) contra `203.0.113.10` — responden OK, con 142 y 121 usuarios
registrados respectivamente. Se corrió también `/clocks/:id/sync` en
`HUMAND_DRY_RUN=true` (no escribe nada real en Humand) — trajo marcaciones
reales sin mapear:

- EMPAQUE: 43 marcaciones, device user IDs sin mapear: 101,119,129,132,14,
  147,152,153,154,157,161,162,168,169,181,183,196,198,20,200,202,203,204,
  207,208,215,219,31,46,48,49,61,62,69,77,78,88,9
- LABORATORIO 4: 34 marcaciones, device user IDs sin mapear: 121,177,178,
  179,188,190,194,195,199,209,220,229,75,84,93,97,98

**Sin overlap entre los dos relojes** — no hay un empleado que aparezca en
ambos logs para usar como piloto único; hay que elegir un device user ID de
cualquiera de las dos listas y pedirle al cliente su DNI/legajo real en
Humand para completar el mapeo (`POST /clocks/:id/mapping`, ya probado que
funciona).

### Próximos pasos

1. Pedir al cliente la captura de NAT del reloj COMEDOR (192.168.0.20) — el
   mensaje ya se le mandó por WhatsApp.
2. Elegir 1 device user ID de la lista de arriba (ideal: uno con pocas
   marcaciones, fácil de verificar) y pedirle al cliente el DNI/legajo
   correspondiente en Humand.
3. Mapear ese usuario (`POST /clocks/:id/mapping` con `deviceUserId` +
   `humandUserId`=DNI) y correr `/clocks/:id/sync` de nuevo en dry-run para
   confirmar que ese usuario específico deja de aparecer como "sin mapear".
4. Recién con eso confirmado, evaluar apagar `HUMAND_DRY_RUN` (con permiso
   explícito del usuario) para probar el envío real con ese único empleado.

### Nota operativa: acceso al disco local se rompió a mitad de sesión (18/8)

Durante esta sesión, el acceso a `<ruta-local>`
(y a `~/Documents` en general) empezó a devolver `EPERM` en todas las
herramientas (Read, Bash, node, git, incluso `ls`) — aunque "Acceso completo
al disco" en System Settings mostraba Terminal y claude.exe habilitados. Se
trabajó igual sin problema usando:
- `gh api` (contenidos del repo vía API de GitHub, no filesystem local)
- `curl` contra `https://<tu-deploy>.vercel.app` directamente (login
  con cookie de sesión, alta de relojes, test y sync — todo por HTTP)

Si una sesión nueva encuentra el mismo problema: probar `cd ~` antes de
cualquier comando (el cwd roto parece ser específico de esa carpeta), y si
persiste, decirle al usuario que revise de nuevo el toggle de Acceso Completo
al Disco (apagar/prender) y reiniciar la sesión de terminal.

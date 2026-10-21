// Diagnóstico de SOLO LECTURA sobre la base de producción: muestra, por reloj,
// el estado del último sync y, para cada error 422 (marca "trabada"), el
// estado de alternancia del empleado afectado. No escribe nada ni llama a
// Humand.
//
// Uso:  node scripts/diagnose-stuck-punch.js
// Lee POSTGRES_URL / DATABASE_URL del entorno o de .env.production.local.
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env.production.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { query, pool } = require("../lib/db");

const art = (ms) => new Date(ms - 3 * 3600e3).toISOString().replace("T", " ").slice(0, 19) + " ART";

(async () => {
  const { rows } = await query("SELECT data FROM clocks ORDER BY updated_at DESC");
  console.log(`Ahora: ${art(Date.now())}\n`);

  for (const { data: clock } of rows) {
    const lr = clock.lastRun || {};
    console.log(
      `== ${clock.alias} | status=${clock.status} | dryRun=${clock.dryRun} | lastSync=${clock.lastSyncAt} | sent=${lr.sent} unmapped=${lr.unmapped} notClaimed=${lr.notClaimed}`
    );

    for (const err of lr.errors || []) {
      console.log(`   ERROR: ${err.slice(0, 220)}`);
      const m = err.match(/deviceUserId (\S+) @ (\S+):/);
      if (!m) continue;
      const [, deviceUserId, isoTime] = m;
      const employeeId = (clock.userMap || {})[deviceUserId];
      const punchMs = Date.parse(isoTime);
      console.log(
        `   → marca trabada: device ${deviceUserId} (${clock.deviceUserNames?.[deviceUserId] || "?"}) DNI ${employeeId} @ ${art(punchMs)}`
      );
      const st = await query(
        "SELECT client_key, data FROM employee_state WHERE employee_internal_id = $1",
        [employeeId]
      );
      for (const s of st.rows) {
        const d = s.data;
        const gapH = ((punchMs - d.lastRecordTimeMs) / 3600e3).toFixed(1);
        console.log(
          `   → estado ${s.client_key}: último=${d.lastType} @ ${art(d.lastRecordTimeMs)} (la marca trabada llegó ${gapH} h después; umbral nocturno = 16 h)`
        );
      }
    }

    for (const o of lr.openShifts || []) {
      console.log(`   turno abierto: ${o.name || o.employeeInternalId} hace ${o.hoursOpen} h`);
    }
    console.log();
  }
  await pool.end();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});

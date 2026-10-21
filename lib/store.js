// Mismo contrato que la versión anterior basada en archivos (readClocks,
// upsertClock, getClock, deleteClock) pero respaldado por Postgres — así
// server.js y poller.js no necesitaron cambiar una sola línea al migrar de
// "archivo local" (no sirve en Vercel, filesystem efímero) a "base real".
const { query } = require("./db");

async function readClocks() {
  const { rows } = await query("SELECT data FROM clocks ORDER BY updated_at DESC");
  return rows.map((r) => r.data);
}

async function upsertClock(clock) {
  await query(
    `INSERT INTO clocks (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
    [clock.id, clock]
  );
  return clock;
}

async function getClock(id) {
  const { rows } = await query("SELECT data FROM clocks WHERE id = $1", [id]);
  return rows[0]?.data;
}

async function deleteClock(id) {
  await query("DELETE FROM clocks WHERE id = $1", [id]);
}

// Estado de alternancia entrada/salida por empleado, compartido entre todos
// los relojes de un mismo cliente — ver la nota grande en lib/poller.js
// sobre por qué esto no puede vivir adentro de cada reloj.
async function getEmployeeState(clientKey, employeeInternalId) {
  const { rows } = await query(
    "SELECT data FROM employee_state WHERE client_key = $1 AND employee_internal_id = $2",
    [clientKey, employeeInternalId]
  );
  return rows[0]?.data || null;
}

async function upsertEmployeeState(clientKey, employeeInternalId, data) {
  await query(
    `INSERT INTO employee_state (client_key, employee_internal_id, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (client_key, employee_internal_id) DO UPDATE SET data = $3, updated_at = now()`,
    [clientKey, employeeInternalId, data]
  );
}

module.exports = {
  readClocks,
  upsertClock,
  getClock,
  deleteClock,
  getEmployeeState,
  upsertEmployeeState,
};

// Conexión a Postgres para producción (Vercel). Pensado para Vercel Postgres
// (Neon por debajo) o cualquier Postgres real — Neon directo, Vercel Storage,
// etc. — sin atarse a Supabase.
//
// Vercel Storage → Postgres inyecta automáticamente varias env vars
// (POSTGRES_URL, POSTGRES_PRISMA_URL, POSTGRES_URL_NON_POOLING, ...). Usamos
// POSTGRES_URL (la pooled, recomendada para serverless) y si no existe,
// caemos a DATABASE_URL por si se conecta un Postgres genérico.
const { Pool } = require("pg");

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!connectionString) {
  // No tiramos el proceso abajo en el import (rompería todas las funciones
  // serverless incluso las que no tocan la base), pero cualquier query va a
  // fallar con un mensaje claro.
  console.warn(
    "[db] Falta POSTGRES_URL / DATABASE_URL. Conectá Vercel Postgres (Storage → Postgres) o seteá la variable manualmente."
  );
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 3, // las funciones serverless abren muchas conexiones cortas; con Neon usar siempre el connection string "pooled"
    })
  : null;

let migrated = false;

async function ensureSchema() {
  if (migrated || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clocks (
      id UUID PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Estado de alternancia entrada/salida POR EMPLEADO, compartido entre todos
  // los relojes de un mismo cliente (ver lib/poller.js) — un empleado puede
  // fichar entrada en un reloj y salida en otro (ej. EMPAQUE a la mañana,
  // COMEDOR al mediodía), así que esto no puede vivir adentro de cada
  // registro de "clocks" como antes (eso asumía, incorrectamente, que cada
  // reloj ve la jornada completa de sus propios empleados).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_state (
      client_key TEXT NOT NULL,
      employee_internal_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (client_key, employee_internal_id)
    );
  `);
  migrated = true;
}

async function query(text, params) {
  if (!pool) throw new Error("No hay conexión a la base configurada (POSTGRES_URL / DATABASE_URL).");
  await ensureSchema();
  return pool.query(text, params);
}

module.exports = { query, pool };

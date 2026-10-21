// Disparado periódicamente por Vercel Cron (ver vercel.json). Cada invocación
// hace UNA pasada de sincronización sobre todos los relojes configurados y
// termina — no hay proceso de fondo persistente, así que la "frecuencia" la
// define enteramente el cron, no este archivo.
//
// Protegido con un secreto propio (CRON_SECRET) en vez de confiar en que
// nadie más adivine la URL: sin el secreto correcto, devuelve 401 y no toca
// ningún reloj.
const { syncAllClocks } = require("../../lib/poller");

// SYNC_ONLY_TODAY: postura por defecto del proyecto, pedida explícitamente
// el 18/8 — el cron automático (cada 5 min, vía el Worker de Cloudflare)
// SOLO procesa marcaciones del día calendario actual (Argentina). El
// backlog histórico acumulado de antes de hoy queda intacto (nunca se envía
// ni se descarta) hasta que el cliente valide que los datos de "hoy" están
// llegando bien a Humand — recién ahí, a pedido explícito, se usa el botón
// "Sincronizar ahora (todo lo pendiente)" desde el dashboard para volcar el
// backlog. Para volver al comportamiento anterior (cron procesa todo lo
// pendiente, no solo hoy) alcanza con poner esta env var en "false".
const SYNC_ONLY_TODAY = process.env.SYNC_ONLY_TODAY !== "false"; // true por defecto

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  try {
    const results = await syncAllClocks({ onlyToday: SYNC_ONLY_TODAY });
    res.status(200).json({ ok: true, ranAt: new Date().toISOString(), onlyToday: SYNC_ONLY_TODAY, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};

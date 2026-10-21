// Disparador externo del cron del conector ZKTeco → Humand.
//
// Por qué existe: Vercel Hobby limita los cron jobs nativos a 1x/día, y este
// conector necesita sincronizar cada ~5 min. Este Worker no hace ninguna
// lógica del conector — solo pega un GET a /api/cron/sync con el
// Authorization: Bearer CRON_SECRET en cada disparo del Cron Trigger de
// Cloudflare (configurado en wrangler.toml), que sí soporta cada 5 minutos
// gratis y sin límite práctico (288 disparos/día contra 100k/día del free
// tier).
export default {
  async scheduled(event, env, ctx) {
    const url = `${env.TARGET_BASE_URL}/api/cron/sync`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`[cron-worker] ${url} respondió ${res.status}: ${body}`);
    } else {
      console.log(`[cron-worker] OK (${res.status}): ${body}`);
    }
  },

  // Endpoint manual de prueba: permite disparar el sync a mano pegándole a
  // la URL del Worker (GET), útil para verificar sin esperar al próximo tick.
  async fetch(request, env, ctx) {
    const url = `${env.TARGET_BASE_URL}/api/cron/sync`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
    });
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  },
};

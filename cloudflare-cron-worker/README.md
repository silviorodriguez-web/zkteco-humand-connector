# Worker de cron externo (Cloudflare)

Dispara `/api/cron/sync` en el conector cada 15 minutos. Existe porque Vercel
Hobby limita los cron jobs nativos a 1x/día (y de hecho **rechaza el deploy**
si el cron definido en `vercel.json` es más frecuente que eso) — Cloudflare
Workers + Cron Trigger es gratis y no tiene ese límite (96 disparos/día
contra el tope de 100k/día del free tier).

Ya desplegado en: `https://zkteco-connector-cron.ips-delta-notify.workers.dev`
(cron activo: `*/15 * * * *` — bajado de `*/5 * * * *` el 28/8 porque
mantenía despierto el cómputo de Neon las 24hs y agotaba la cuota gratuita
mensual; ver comentario en `wrangler.toml`). Pegarle un GET a esa URL también
sirve para disparar un sync manual sin esperar al próximo tick.

## Redeploy / cambios

```bash
cd cloudflare-cron-worker
npx wrangler deploy
```

## Variables

- `TARGET_BASE_URL` (en `wrangler.toml`, no es secreto): URL de producción
  del conector en Vercel.
- `CRON_SECRET` (secret, no está en ningún archivo): debe ser **el mismo
  valor** que la variable de entorno `CRON_SECRET` del proyecto en Vercel.
  Si se rota una, hay que rotar la otra:
  ```bash
  npx wrangler secret put CRON_SECRET
  ```

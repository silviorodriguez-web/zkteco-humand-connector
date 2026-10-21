// Solo para correr localmente (`npm run dev`). En Vercel, este archivo no se
// usa — Vercel arranca api/index.js directamente como función serverless y
// api/cron/sync.js vía Vercel Cron (ver vercel.json).
const app = require("./api/index");
const { scheduleAll } = require("./lib/poller");
const { DRY_RUN } = require("./lib/humandClient");

const PORT = process.env.PORT || 3000;

scheduleAll()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Conector corriendo en http://localhost:${PORT} (DRY_RUN=${DRY_RUN})`);
      console.log(`Requiere POSTGRES_URL o DATABASE_URL configurada (ver .env.example).`);
    });
  })
  .catch((err) => {
    console.error("No se pudo inicializar el scheduler local:", err);
    process.exit(1);
  });

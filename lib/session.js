// Sesión "sin base": un cookie firmado (HMAC) con el email de Humand validado
// en el login. No hace falta guardar sesiones en Postgres — el propio cookie
// es la prueba de que /login ya confirmó ese email contra la comunidad de
// Humand (ver lib/humandClient.js -> findUserByEmail).
const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || process.env.CRON_SECRET || "";
const COOKIE_NAME = "zkteco_session";
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12hs — suficiente para una sesión de trabajo, sin quedar abierta para siempre

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("hex");
}

// payload: "<email>.<expiresAtMs>" + "." + firma
function createToken(email) {
  if (!SECRET) {
    throw new Error(
      "Falta SESSION_SECRET (o CRON_SECRET) configurada — sin esto no se pueden firmar sesiones de login."
    );
  }
  const expiresAt = Date.now() + MAX_AGE_MS;
  const payload = `${Buffer.from(email).toString("base64url")}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [emailB64, expiresAtStr, signature] = parts;
  const payload = `${emailB64}.${expiresAtStr}`;
  const expected = sign(payload);
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return null;
  }
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return null;
  try {
    return Buffer.from(emailB64, "base64url").toString();
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf("=");
        return [decodeURIComponent(p.slice(0, idx)), decodeURIComponent(p.slice(idx + 1))];
      })
  );
}

function getSessionEmail(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, email) {
  const token = createToken(email);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

module.exports = { getSessionEmail, setSessionCookie, clearSessionCookie, COOKIE_NAME };

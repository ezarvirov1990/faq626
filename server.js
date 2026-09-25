// Дашборд «Лиды без касаний»: раз в N минут собирает снимок из Bitrix24 и отдаёт его под паролем.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createBitrix, collectSnapshot } from "./collector.js";

const env = process.env;
const config = {
  port: Number(env.PORT || 3000),
  webhook: env.BITRIX_WEBHOOK,
  user: env.DASHBOARD_USER || "mygenetics",
  password: env.DASHBOARD_PASSWORD,
  departments: (env.DEPARTMENTS || "256,198").split(",").map((s) => Number(s.trim())).filter(Boolean),
  thresholdHours: Number(env.THRESHOLD_HOURS || 48),
  refreshMinutes: Number(env.REFRESH_MINUTES || 15),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const missing = ["BITRIX_WEBHOOK", "DASHBOARD_PASSWORD"].filter((k) => !env[k]);
if (missing.length) log("Не заданы переменные:", missing.join(", "), "— дашборд не будет отдавать данные");

// Последний удачный снимок живёт в памяти; после перезапуска сервер соберёт новый
const state = { snapshot: null, lastAttemptAt: null, lastError: null, running: false };

async function refresh() {
  if (state.running || !config.webhook) return;
  state.running = true;
  state.lastAttemptAt = new Date().toISOString();
  const started = Date.now();
  try {
    const snap = await collectSnapshot(createBitrix(config.webhook), config);
    // При ошибках отдельных запросов оставляем прежний снимок: на странице будет видно, что он устарел
    if (snap.batchErrors > 0) throw new Error(`Bitrix вернул ошибки в ${snap.batchErrors} запросах`);
    state.snapshot = snap;
    state.lastError = null;
    log(`collect ok: open=${snap.totalOpen} flagged=${snap.leads.length} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    state.lastError = e.message;
    log("collect error:", e.message);
  } finally {
    state.running = false;
  }
}

function authorized(req) {
  if (!config.password) return false;
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const given = Buffer.from(Buffer.from(encoded, "base64").toString("utf8"));
  const expected = Buffer.from(`${config.user}:${config.password}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const page = await readFile(new URL("./public/index.html", import.meta.url));
const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  // Проверка живости для Railway — без пароля и без данных
  if (pathname === "/healthz") {
    res.writeHead(200, { ...baseHeaders, "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (!authorized(req)) {
    res.writeHead(401, { ...baseHeaders, "WWW-Authenticate": 'Basic realm="Leads dashboard", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
    return res.end(config.password ? "Нужен логин и пароль" : "Дашборд не настроен: задайте DASHBOARD_PASSWORD");
  }
  if (req.method !== "GET") {
    res.writeHead(405, baseHeaders);
    return res.end();
  }
  if (pathname === "/") {
    res.writeHead(200, { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  if (pathname === "/api/snapshot") {
    res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      snapshot: state.snapshot,
      status: { lastAttemptAt: state.lastAttemptAt, lastError: state.lastError, running: state.running },
    }));
  }
  res.writeHead(404, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Не найдено");
});

server.listen(config.port, () => log(`listening on ${config.port}, refresh every ${config.refreshMinutes} min`));
refresh();
setInterval(refresh, config.refreshMinutes * 60e3);

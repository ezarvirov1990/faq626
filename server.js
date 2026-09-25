// Дашборд «Лиды без касаний»: раз в N минут собирает снимок из Bitrix24 и отдаёт его под паролем.
import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createBitrix, collectSnapshot, loadConfig } from "./collector.js";
import { mergeHints } from "./hints.js";

const env = process.env;
const config = loadConfig(env);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const missing = ["BITRIX_WEBHOOK", "DASHBOARD_PASSWORD"].filter((k) => !env[k]);
if (missing.length) log("Не заданы переменные:", missing.join(", "), "— дашборд не будет отдавать данные");

// Последний удачный снимок живёт в памяти; после перезапуска сервер соберёт новый
const state = { snapshot: null, lastAttemptAt: null, lastError: null, running: false, hints: {} };

// Подсказки по лидам хранятся на постоянном диске (DATA_DIR — volume Railway), а не в репозитории:
// в них данные клиентов. Без DATA_DIR живут только в памяти до перезапуска.
const hintsFile = env.DATA_DIR ? path.join(env.DATA_DIR, "hints.json") : null;
if (hintsFile) {
  try { state.hints = JSON.parse(await readFile(hintsFile, "utf8")); } catch (e) { if (e.code !== "ENOENT") log("hints read error:", e.message); }
} else log("DATA_DIR не задан — подсказки не переживут перезапуск");

async function saveHints() {
  if (!hintsFile) return;
  await mkdir(path.dirname(hintsFile), { recursive: true });
  await writeFile(hintsFile + ".tmp", JSON.stringify(state.hints), "utf8");
  await rename(hintsFile + ".tmp", hintsFile);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Слишком большой запрос"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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
    const summary = Object.entries(snap.views).map(([k, v]) => `${k} ${v.items.length}/${v.totalOpen}`).join(", ");
    log(`collect ok: ${summary} in ${Math.round((Date.now() - started) / 1000)}s`);
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
  // Загрузка подсказок: POST { "<ID лида>": {request, outcome, next, at?} | null }
  if (pathname === "/api/hints" && req.method === "POST") {
    readBody(req, 2e6)
      .then(async (raw) => {
        state.hints = mergeHints(state.hints, JSON.parse(raw));
        await saveHints();
        res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, total: Object.keys(state.hints).length, persisted: Boolean(hintsFile) }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
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
      hints: state.hints,
      status: { lastAttemptAt: state.lastAttemptAt, lastError: state.lastError, running: state.running },
    }));
  }
  res.writeHead(404, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Не найдено");
});

server.listen(config.port, () => log(`listening on ${config.port}, refresh every ${config.refreshMinutes} min`));
refresh();
setInterval(refresh, config.refreshMinutes * 60e3);

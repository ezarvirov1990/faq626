// Дашборд «Лиды без касаний»: раз в N минут собирает снимок из Bitrix24 и отдаёт его под паролем.
import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createBitrix, collectSnapshot, loadConfig, mergeDealPipelines } from "./collector.js";
import { mergeHints } from "./hints.js";
import { collectLive } from "./activity.js";
import { mskDayStart } from "./tasks.js";
import { decideAlerts, alertText, createMattermost, recipientOnDuty } from "./alerts.js";

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

// The last good snapshot is also kept on disk, so after a restart the page shows it right away
// instead of waiting for a full collection (several minutes)
const snapshotFile = env.DATA_DIR ? path.join(env.DATA_DIR, "snapshot.json") : null;
if (snapshotFile) {
  try { state.snapshot = JSON.parse(await readFile(snapshotFile, "utf8")); log("snapshot loaded from disk:", state.snapshot.updatedAt); }
  catch (e) { if (e.code !== "ENOENT") log("snapshot read error:", e.message); }
}

async function saveSnapshot() {
  if (!snapshotFile) return;
  await mkdir(path.dirname(snapshotFile), { recursive: true });
  await writeFile(snapshotFile + ".tmp", JSON.stringify(state.snapshot), "utf8");
  await rename(snapshotFile + ".tmp", snapshotFile);
}

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
    // Slow (big) pipelines are collected every SLOW_REFRESH_MINUTES; in between they come from the previous snapshot
    const prev = state.snapshot;
    const slowAt = prev && prev.slowUpdatedAt ? Date.parse(prev.slowUpdatedAt) : 0;
    const withSlow = started - slowAt >= (config.slowRefreshMinutes - 1) * 60e3;
    let snap = await collectSnapshot(createBitrix(config.webhook), config, { withSlow });
    // При ошибках отдельных запросов оставляем прежний снимок: на странице будет видно, что он устарел
    if (snap.batchErrors > 0) throw new Error(`Bitrix вернул ошибки в ${snap.batchErrors} запросах`);
    snap = withSlow ? { ...snap, slowUpdatedAt: snap.updatedAt } : { ...mergeDealPipelines(snap, prev), slowUpdatedAt: prev && prev.slowUpdatedAt };
    state.snapshot = snap;
    state.lastError = null;
    try { await saveSnapshot(); } catch (e) { log("snapshot save error:", e.message); }
    const summary = Object.entries(snap.views).map(([k, v]) => `${k} ${v.items.length}/${v.totalOpen}`).join(", ");
    log(`collect ok (${withSlow ? "full" : "fast"}): ${summary} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    state.lastError = e.message;
    log("collect error:", e.message);
  } finally {
    state.running = false;
  }
}

// «Лента событий»: every LIVE_SECONDS (30) — online, calls, stages, tasks, messages of changed dialogs;
// notes of hot cards once a minute. The snapshot adds the full sweep of messages and notes.
// Всё живёт в памяти и только за сегодня (по Москве); «был в сети» сервер помнит с момента запуска.
const live = {
  day: 0, events: new Map(), online: {}, absent: {}, lastSeen: {}, updatedAt: null, error: null, running: false, tasksCheckedAt: 0,
  messagesAt: 0, notesAt: 0, chatCache: new Map(), watch: new Map(),
};
const LIVE_MS = Number(env.LIVE_SECONDS || 30) * 1e3;

// Уведомления руководителю в Mattermost о 20 минутах тишины (alerts.js). Без переменных — выключены.
// Открытые «простои» лежат на постоянном диске, чтобы после перезапуска не слать повторно.
const mattermost = env.MATTERMOST_URL && env.MATTERMOST_TOKEN && env.ALERT_MM_USER
  ? createMattermost({ url: env.MATTERMOST_URL, token: env.MATTERMOST_TOKEN }) : null;
if (!mattermost) log("MATTERMOST_URL / MATTERMOST_TOKEN / ALERT_MM_USER не заданы — уведомления о тишине выключены");
const alertsFile = env.DATA_DIR ? path.join(env.DATA_DIR, "alerts.json") : null;
let alertsOpen = {};
if (alertsFile) {
  try { alertsOpen = JSON.parse(await readFile(alertsFile, "utf8")); } catch (e) { if (e.code !== "ENOENT") log("alerts read error:", e.message); }
}

async function runAlerts(now) {
  if (!mattermost || !state.snapshot) return;
  const p = activityPayload();
  const { send, open } = decideAlerts({
    now, managers: state.snapshot.managers, events: p.events, absent: live.absent, open: alertsOpen,
    // messages are read live now; fall back to the snapshot if the live part hasn't run yet
    messagesAt: Math.max(live.messagesAt || 0, Date.parse(state.snapshot.updatedAt)),
  });
  alertsOpen = open;
  if (alertsFile) {
    await mkdir(path.dirname(alertsFile), { recursive: true });
    await writeFile(alertsFile, JSON.stringify(alertsOpen), "utf8");
  }
  const feedUrl = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") + "/#feed" : undefined;
  // Руководителю шлём только «нет активности 20 минут» (решение 30.09.2026): без «снова в работе» и «смена началась, действий нет»,
  // и только в её рабочее время; вне его простой помечен открытым, но не отправляется
  const silent = send.filter((x) => x.kind === "silent");
  if (silent.length && !recipientOnDuty(now)) { log(`alerts skipped (recipient off duty): ${silent.map((a) => a.manager.name).join(", ")}`); return; }
  for (const a of silent) {
    try {
      await mattermost.direct(env.ALERT_MM_USER, alertText(a, { online: live.online[a.manager.id], feedUrl }));
      log(`alert ${a.kind}: ${a.manager.name}`);
    } catch (e) { log("alert send error:", e.message); }
  }
}

// Feed covers the main groups plus other pipelines' people (upsell group); alerts stay with the main groups
function feedManagers() {
  const snap = state.snapshot;
  if (!snap) return null;
  const extra = (snap.views.deals && snap.views.deals.extraManagers) || [];
  return [...snap.managers, ...extra.filter((m) => !snap.managers.some((x) => x.id === m.id))];
}

async function refreshLive() {
  const managers = feedManagers();
  if (live.running || !config.webhook || !managers) return;
  live.running = true;
  const started = Date.now();
  try {
    const day = mskDayStart(started);
    if (day !== live.day) Object.assign(live, { day, events: new Map(), tasksCheckedAt: 0, watch: new Map() });
    // Историю задач перечитываем только по тем, что менялись с прошлого раза (с запасом 2 минуты).
    // Dialogs: those changed since the last check (1 min overlap; the first run looks 2 minutes back —
    // earlier messages of the day come from the snapshot). Notes of hot cards — once a minute.
    const notes = started - live.notesAt >= 60e3 - 5e3;
    const res = await collectLive(createBitrix(config.webhook), managers, {
      now: started, tasksSince: live.tasksCheckedAt - 2 * 60e3,
      sessionsSince: (live.messagesAt || started - 60e3) - 60e3, chatCache: live.chatCache, watch: live.watch, notes,
    });
    for (const e of res.events) live.events.set(e.key, e);
    for (const [id, on] of Object.entries(res.online)) if (on) live.lastSeen[id] = started;
    live.online = res.online;
    live.absent = res.absent;
    live.tasksCheckedAt = started;
    live.messagesAt = started;
    if (notes) live.notesAt = started;
    live.updatedAt = new Date(started).toISOString();
    live.error = null;
    try { await runAlerts(Date.now()); } catch (e) { log("alerts error:", e.message); }
  } catch (e) {
    live.error = e.message;
    log("live error:", e.message);
  } finally {
    live.running = false;
  }
}

function activityPayload() {
  const snap = state.snapshot;
  const day = mskDayStart(Date.now());
  const events = new Map(live.day === day ? live.events : []);
  for (const e of (snap && snap.activity && snap.activity.events) || []) if (e.at >= day) events.set(e.key, e);
  return {
    updatedAt: live.updatedAt,
    messagesUpdatedAt: snap ? snap.updatedAt : null,
    error: live.error,
    managers: feedManagers() || [],
    online: Object.fromEntries(Object.entries(live.online).map(([id, on]) => [id, { online: on, lastSeenAt: live.lastSeen[id] ? new Date(live.lastSeen[id]).toISOString() : null, absentUntil: live.absent[id] || null }])),
    events: [...events.values()].sort((a, b) => b.at - a.at),
  };
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
  if (pathname === "/api/activity") {
    res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(activityPayload()));
  }
  res.writeHead(404, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Не найдено");
});

server.listen(config.port, () => log(`listening on ${config.port}, refresh every ${config.refreshMinutes} min`));
refresh().then(refreshLive);
setInterval(refresh, config.refreshMinutes * 60e3);
setInterval(refreshLive, LIVE_MS);

// Дашборд «Лиды без касаний»: раз в N минут собирает снимок из Bitrix24 и отдаёт его под паролем.
import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createBitrix, collectSnapshot, loadConfig, mergeDealPipelines } from "./collector.js";
import { mergeHints } from "./hints.js";
import { collectLive } from "./activity.js";
import { mskDayStart } from "./tasks.js";
import { decideAlerts, alertText, createMattermost, alertRecipient, BACKUP_ID, SCHEDULES } from "./alerts.js";
import { collectWeek, weekStart, SUVVY_ID } from "./weekstats.js";
import { collectUndelivered } from "./undelivered.js";
import { collectReplies } from "./replies.js";

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
  // в её рабочее время; после него — Кондратьевой (ALERT_MM_BACKUP_USER) в её смену; иначе простой помечен открытым, но не отправляется
  const silent = send.filter((x) => x.kind === "silent");
  const skipped = [];
  for (const a of silent) {
    const who = alertRecipient(now, a.manager.id, { absent: live.absent, backupId: env.ALERT_MM_BACKUP_USER ? BACKUP_ID : null });
    if (!who) { skipped.push(a.manager.name); continue; }
    try {
      await mattermost.direct(who === "backup" ? env.ALERT_MM_BACKUP_USER : env.ALERT_MM_USER, alertText(a, { online: live.online[a.manager.id], feedUrl }));
      log(`alert ${a.kind}${who === "backup" ? " (backup)" : ""}: ${a.manager.name}`);
    } catch (e) { log("alert send error:", e.message); }
  }
  if (skipped.length) log(`alerts skipped (recipient off duty): ${skipped.join(", ")}`);
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

// «Не доставлено» (undelivered.js): today's manager messages Wazzup could not deliver, nothing reached the
// client after them. Own run every UNDELIVERED_MINUTES (~30 s: every chat touched today), in memory only.
const undelivered = { data: null, error: null, running: false };
const UNDELIVERED_MS = Number(env.UNDELIVERED_MINUTES || 15) * 60e3;
async function refreshUndelivered() {
  const managers = feedManagers();
  if (undelivered.running || !config.webhook || !managers) return;
  undelivered.running = true;
  const started = Date.now();
  try {
    undelivered.data = await collectUndelivered(createBitrix(config.webhook), managers, { now: started });
    undelivered.error = null;
    log(`undelivered ok: ${undelivered.data.items.length} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    undelivered.error = e.message;
    log("undelivered error:", e.message);
  } finally {
    undelivered.running = false;
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
const weekPage = await readFile(new URL("./public/week.html", import.meta.url));

// «Неделя»: computed on request from three lead lists (~5 s), cached 5 min (past weeks — 1 h)
const weekCache = new Map();
const WEEKS_BACK = 12;
// {ids:[...]} leads left out of «Неделя»: Bitrix opened them for our win-back sends (20–21.10.2026). Kept out of the public repo
const weekExcludeFile = path.join(env.DATA_DIR || ".", "week-exclude.json");
function weekData(from) {
  const now = Date.now();
  const hit = weekCache.get(from);
  if (hit && now - hit.at < (from === weekStart(now) ? 5 * 60e3 : 3600e3)) return hit.promise;
  const owners = [...state.snapshot.managers.map((m) => ({ id: m.id, name: m.name, group: m.group })), { id: SUVVY_ID, name: "Савви (ИИ-агент)", group: "бот" }];
  const promise = readFile(weekExcludeFile, "utf8").then((t) => JSON.parse(t).ids || [], (e) => { if (e.code !== "ENOENT") log("week exclude read error:", e.message); return []; })
    .then((exclude) => collectWeek(createBitrix(config.webhook), { from, now, owners, exclude }));
  weekCache.set(from, { at: now, promise });
  promise.catch(() => weekCache.delete(from));
  return promise;
}
// «Неделя» → reply speed: every chat of the week paged through (~2 min), so it is never computed inside a request.
// The current week is recounted in the background every REPLIES_MINUTES (30) and served from memory meanwhile;
// a past week is computed on first request and, once it ended 2+ days ago (late answers are in), kept on disk for good.
const REPLIES_MS = Number(env.REPLIES_MINUTES || 30) * 60e3;
const repliesCache = new Map(); // from → { data, at, running }
const repliesFile = (from) => path.join(env.DATA_DIR || ".", `replies-${from}.json`);
function repliesFor(from, { force = false } = {}) {
  const now = Date.now();
  const c = repliesCache.get(from) || repliesCache.set(from, {}).get(from);
  const fresh = c.data && (c.final || now - c.at < (from === weekStart(now) ? REPLIES_MS : 3600e3));
  if (c.running || (fresh && !force) || !state.snapshot) return c;
  c.running = (async () => {
    if (!c.data) try { Object.assign(c, { data: JSON.parse(await readFile(repliesFile(from), "utf8")), final: true, at: now }); return; } catch {}
    const managers = state.snapshot.managers.map((m) => ({ id: m.id, name: m.name }));
    const data = await collectReplies(createBitrix(config.webhook), { from, now, managers, owners: managers.filter((m) => SCHEDULES[m.id]), schedules: SCHEDULES, log });
    Object.assign(c, { data, at: now, error: null });
    if (now > Date.parse(from + "T00:00:00+03:00") + 9 * 864e5) {
      c.final = true;
      await writeFile(repliesFile(from) + ".tmp", JSON.stringify(data)).then(() => rename(repliesFile(from) + ".tmp", repliesFile(from)));
    }
  })().catch((e) => { log("replies error:", e.message); c.error = e.message; }).finally(() => { c.running = null; });
  return c;
}
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
      undelivered: undelivered.data && { ...undelivered.data, error: undelivered.error },
      status: { lastAttemptAt: state.lastAttemptAt, lastError: state.lastError, running: state.running },
    }));
  }
  if (pathname === "/week") {
    res.writeHead(200, { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" });
    return res.end(weekPage);
  }
  if (pathname === "/api/week") {
    const now = Date.now();
    const from = new URL(req.url, "http://localhost").searchParams.get("from") || weekStart(now);
    const json = (code, body) => { res.writeHead(code, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
    const ms = Date.parse(from + "T12:00:00+03:00");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || weekStart(ms) !== from || ms > now + 864e5 || now - ms > (WEEKS_BACK + 1) * 7 * 864e5) return json(400, { error: "неделя вне диапазона" });
    if (!state.snapshot) return json(503, { error: "первый сбор данных ещё идёт" });
    weekData(from).then(
      (d) => json(200, { ...d, current: weekStart(now), weeksBack: WEEKS_BACK }),
      (e) => { log("week error:", e.message); json(502, { error: "Bitrix24 не ответил, попробуйте через минуту" }); });
    return;
  }
  if (pathname === "/api/replies") {
    const now = Date.now();
    const from = new URL(req.url, "http://localhost").searchParams.get("from") || weekStart(now);
    const ms = Date.parse(from + "T12:00:00+03:00");
    res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || weekStart(ms) !== from || ms > now + 864e5 || now - ms > (WEEKS_BACK + 1) * 7 * 864e5) return res.end(JSON.stringify({ error: "неделя вне диапазона" }));
    const c = repliesFor(from);
    return res.end(JSON.stringify({ from, data: c.data || null, running: Boolean(c.running), error: c.error || null }));
  }
  if (pathname === "/api/activity") {
    res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(activityPayload()));
  }
  res.writeHead(404, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Не найдено");
});

server.listen(config.port, () => log(`listening on ${config.port}, refresh every ${config.refreshMinutes} min`));
refresh().then(refreshLive).then(refreshUndelivered).then(() => repliesFor(weekStart(Date.now())));
setInterval(refresh, config.refreshMinutes * 60e3);
setInterval(refreshLive, LIVE_MS);
setInterval(refreshUndelivered, UNDELIVERED_MS);
setInterval(() => repliesFor(weekStart(Date.now()), { force: true }), REPLIES_MS);

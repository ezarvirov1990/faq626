// «Сервис B2C» page /service (spec docs/specs/2026-11-10-service-dashboard-design.md, 10.11.2026):
// the service team's reply speed after Suvvy hands a chat over, kept promises, service clients' calls,
// missed calls and call-backs, overdue tasks. Pure rules first, the Bitrix collection at the end.

import { clean, OUTGOING, NOT_A_QUESTION, WAZZUP_SYSTEM, TRIVIAL, shiftsOf, workTime } from "./replies.js";
import { ROBOT_TEXT, managerIndex, messageAuthor } from "./activity.js";

const H = 3600e3;
const DAY = 24 * H;
const MSK = 3 * H;
export const SUVVY_ID = 367846;
export const SERVICE_PIPELINE = 29;

// The user's list and schedules (10.11.2026); department 21 has other people too — not shown
const MSK_22 = { tz: 3, from: 10, to: 22, weekdays: false };
export const SERVICE_TEAM = [
  { id: 193818, name: "Елена Бирюкова", schedule: MSK_22 },
  { id: 188312, name: "Яна Лукьянова", schedule: MSK_22 },
  { id: 194956, name: "Анна Бурцева", schedule: { tz: 3, from: 9, to: 19, weekdays: true } },
  { id: 318154, name: "Елена Ермолова", schedule: { tz: 7, from: 11, to: 23, weekdays: false } },
  { id: 321518, name: "Алина Курашова", schedule: { tz: 7, from: 12, to: 24, weekdays: false } },
];
export const SERVICE_SCHEDULES = Object.fromEntries(SERVICE_TEAM.map((m) => [m.id, m.schedule]));

const localDay = (ms, tz) => new Date(ms + tz * H).toISOString().slice(0, 10);
const dayStartLocal = (day, tz) => Date.parse(day + "T00:00:00Z") - tz * H;
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const weekday = (day) => new Date(day + "T12:00:00Z").getUTCDay();

// ---- who holds the chat: Bitrix system lines (author 0) ----
const userIds = (t) => [...String(t).matchAll(/\[USER=(\d+)/g)].map((m) => Number(m[1]));
export function holderEvent(text) {
  const t = String(text || "");
  const ids = userIds(t);
  const to = (id) => (id === SUVVY_ID ? { kind: "bot" } : id ? { kind: "to", user: id } : null);
  if (/Бот передал работу с диалогом оператору|Диалог снят с оператора|Начат новый диалог/.test(t)) return { kind: "queue" };
  if (/завершил[аи]? работу с диалогом/.test(t)) return ids[0] ? { kind: "closed", user: ids[0] } : { kind: "closed" };
  if (/Автоматическое завершение диалога/.test(t)) return { kind: "closed" };
  if (/переадресовал[аи]? диалог на/.test(t)) return to(ids[ids.length - 1]);
  if (/забрал[аи]? диалог у|начал[аи]? работу с диалогом|К чату присоединил(ся|ась)|Обращение (пере)?(на)?правлено на|Обращение направлено на/.test(t)) return to(ids[0]);
  return null;
}

// ---- message roles ----
// chat: { id, users: { id: { client, bot } }, messages: [{ id, at, a, text, file }] }
export function roles(chat, team) {
  const isClient = new Map(Object.entries(chat.users || {}).map(([id, u]) => [String(id), Boolean(u.client)]));
  const isBot = (a) => a === SUVVY_ID || Boolean((chat.users || {})[a] && chat.users[a].bot);
  const index = managerIndex(team);
  const sorted = [...chat.messages].sort((a, b) => a.at - b.at || a.id - b.id);
  return sorted.map((m) => {
    const text = String(m.text || "");
    if (!m.a) return { m, role: "system" };
    if (text.includes(WAZZUP_SYSTEM)) return { m, role: "service" };
    const client = isClient.get(String(m.a));
    if (client && !OUTGOING.test(text)) return { m, role: "client" };
    if (isBot(m.a) || ROBOT_TEXT.test(text)) return { m, role: "bot" };
    // staff: any human of ours (a phone echo too); team member if it's one of the five
    return { m, role: "staff", team: messageAuthor({ author_id: m.a, text }, isClient, index) };
  });
}

const isRequest = (m) => {
  const t = clean(m.text);
  if (NOT_A_QUESTION.test(t)) return false;
  return Boolean(m.file) || (t && !TRIVIAL.test(t) && /[\p{L}\p{N}]/u.test(t));
};

// Episodes of one chat. A client waits from the message (or from Suvvy's hand-off if the bot held the chat) to the
// first human message of ours or a connected call; it belongs to the team member holding the chat then (queue → the
// next team member who gets it, else the one who answered). Time = working minutes of that person's shifts.
// shifts: Map(id → [[start, end]]), talks: sorted connected call times with the client, mass(text) → our mass send
export function serviceEpisodes({ chat, team, shifts, talks = [], now, mass = () => false }) {
  const teamIds = new Set(team.map((m) => m.id));
  const out = [];
  // pending: the client wrote while the chat was away from the team — with Suvvy or with someone of another department
  // (user 11.11.2026, lead 642448: a chat on Самусевич overnight, forwarded to Бирюкова in the morning — her wait
  // starts at the forward, not at the client's message)
  let holder = null, open = null, pending = null;
  const away = () => holder === "bot" || (typeof holder === "number" && !teamIds.has(holder));
  const close = (at, by) => { open.reply = at; open.by = by; out.push(open); open = null; };
  const startOpen = (at) => { open = { at, holder: teamIds.has(holder) ? holder : null, reply: null, by: null }; };
  const ours = [];
  const list = roles(chat, team);
  for (const { m, role } of list) if (role === "staff") ours.push({ at: m.at, t: clean(m.text).toLowerCase() });
  const echo = (m) => { const t = clean(m.text).toLowerCase(); return ours.some((o) => o.t === t && Math.abs(o.at - m.at) <= 10 * 60e3); };
  for (const { m, role, team: who } of list) {
    if (open) { const t = talks.find((x) => x > open.at && x < m.at); if (t) close(t, null); }
    if (role === "system") {
      const ev = holderEvent(m.text);
      if (!ev) continue;
      holder = ev.kind === "to" ? ev.user : ev.kind === "bot" ? "bot" : ev.kind === "queue" ? "queue" : holder;
      if (ev.kind === "closed") holder = null;
      // a team member closing the dialog decided it needs no more answer (Suvvy explained it, the client said thanks):
      // the wait ends there; Bitrix's auto-close after silence doesn't end it
      // (anyone of ours, not Suvvy — a colleague from another department closing it handled it too)
      if (ev.kind === "closed" && ev.user && ev.user !== SUVVY_ID) { if (open) close(m.at, teamIds.has(ev.user) ? ev.user : null); pending = null; continue; }
      // handed over to someone outside the team (upsell, sales): the service member routed it — the team's wait ends
      if (open && open.holder !== null && ev.kind === "to" && !teamIds.has(ev.user)) { close(m.at, null); continue; }
      if (pending !== null && !open && !away() && holder !== null) { startOpen(m.at); pending = null; }
      if (open && open.holder === null && ev.kind === "to" && teamIds.has(ev.user)) open.holder = ev.user;
      continue;
    }
    if (role === "client") {
      if (open || !isRequest(m) || echo(m) || mass(clean(m.text).toLowerCase())) continue;
      if (away()) { if (pending === null) pending = m.at; } else startOpen(m.at);
      continue;
    }
    if (role === "staff") {
      pending = null;
      if (open) close(m.at, who || null);
    }
  }
  if (open) { const t = talks.find((x) => x > open.at && x <= now); open.reply = t || null; out.push(open); }
  const res = [];
  for (const e of out) {
    const holderId = e.holder ?? (teamIds.has(e.by) ? e.by : null);
    if (!holderId) continue;
    const w = workTime(shifts.get(holderId) || [], e.at, e.reply ?? now);
    if (w.start === null) continue;
    res.push({ chat: chat.id, at: e.at, reply: e.reply, holder: holderId, min: Math.round(w.ms / 60e3) });
  }
  return res;
}

// ---- promises (user 10.11.2026: due from the text, else the end of the next shift; any team member fulfils) ----
const E = "(?![а-яё])";
const PROMISE = new RegExp([
  `(пере|по)звон(ю|им)${E}`, `набер(у|ём|ем)${E}`, `напиш(у|ем)${E}`, `сообщ(у|им)${E}`, `отпиш(усь|емся)${E}`,
  `верн(усь|ёмся|емся)${E}`, `свяж(усь|емся)${E}`, `уточн(ю|им)${E}`, `как (только )?(узна|разбер|выясн|получ)`,
  `дад?(м|им) (вам )?(ответ|обратную связь)`,
].join("|"), "i");
const WEEKDAYS = { "понедельник": 1, "вторник": 2, "среду": 3, "четверг": 4, "пятницу": 5, "субботу": 6, "воскресенье": 0 };
export function findPromise(text) {
  const t = clean(text).toLowerCase().replace(/ё/g, "е");
  if (!PROMISE.test(t)) return null;
  let m = /(через|в течени[еи]) (\d+|полчаса|пол часа|час|пару|несколько)?\s*(минут|мин|часа|часов|час)?/.exec(t);
  if (m && (m[2] || m[3])) {
    const n = m[2] === "полчаса" || m[2] === "пол часа" ? 30 : m[2] === "пару" ? 2 : m[2] === "несколько" ? 3 : m[2] === "час" ? 1 : Number(m[2]) || 1;
    const unit = m[2] === "полчаса" || m[2] === "пол часа" ? 1 : /час/.test(m[3] || m[2] || "") ? 60 : m[2] === "несколько" ? 5 : 1;
    if (m[3] || m[2] === "час" || m[2] === "полчаса" || m[2] === "пол часа") return { due: "minutes", n: n * unit };
  }
  if (/завтра/.test(t)) return { due: "tomorrow" };
  m = /(в|во) (понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/.exec(t);
  if (m) return { due: "weekday", day: WEEKDAYS[m[2]] };
  if (/сегодня|в течени[еи] дня|до конца дня/.test(t)) return { due: "today" };
  return { due: "shift" };
}

// Due time. worked: the promiser's worked local days (2/2: the next shift is the next worked day)
export function promiseDue(p, at, s, worked = []) {
  if (p.due === "minutes") return at + p.n * 60e3;
  const day = localDay(at, s.tz);
  const end = (d) => dayStartLocal(d, s.tz) + s.to * H;
  if (p.due === "today") return Math.max(end(day), at);
  if (p.due === "tomorrow") return end(addDays(day, 1));
  if (p.due === "weekday") { for (let i = 1; i <= 7; i++) { const d = addDays(day, i); if (weekday(d) === p.day) return end(d); } }
  if (s.weekdays) { for (let i = 1; i <= 7; i++) { const d = addDays(day, i); const w = weekday(d); if (w !== 0 && w !== 6) return end(d); } }
  const next = [...worked].sort().find((d) => d > day);
  return next ? end(next) : at + 4 * DAY;
}

// laterTeam: times of team members' messages in the chat; teamCalls: times of team calls to the client
export function promiseStatus({ at, due, laterTeam = [], teamCalls = [], now }) {
  const cands = [...laterTeam.filter((x) => x >= at + 2 * 60e3), ...teamCalls.filter((x) => x > at)].sort((a, b) => a - b);
  const doneAt = cands[0] ?? null;
  const status = doneAt !== null ? (doneAt <= due ? "done" : "late") : now > due ? "missed" : "pending";
  return { due, doneAt, status };
}

// ---- missed calls (user 10.11.2026: service clients' calls, whoever took them; any team member calls back) ----
const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);
// incoming: [{ at, contact, phone, ok }], outgoing: our calls (anyone) [{ at, contact, phone, user }], owners: contact → { deal, owner }
export function missedCases({ incoming, outgoing, owners, shifts, now }) {
  const byPhone = new Map();
  for (const c of incoming) if (c.contact && digits(c.phone)) byPhone.set(digits(c.phone), c.contact);
  const keyOf = (c) => c.contact && owners[c.contact] ? c.contact : byPhone.get(digits(c.phone)) || null;
  const evs = [
    ...incoming.map((c) => ({ ...c, kind: c.ok ? "in_ok" : "missed", key: keyOf(c) })),
    ...outgoing.map((c) => ({ ...c, kind: "out", key: keyOf(c) })),
  ].filter((e) => e.key && owners[e.key]).sort((a, b) => a.at - b.at);
  const open = new Map(), cases = [];
  for (const e of evs) {
    const c = open.get(e.key);
    if (e.kind === "missed") { if (c) c.calls++; else open.set(e.key, { contact: e.key, ...owners[e.key], first: e.at, calls: 1, status: "none", at: null }); continue; }
    if (!c) continue;
    c.status = e.kind === "out" ? "callback" : "self";
    if (e.kind === "out") c.by = e.user || null;
    c.at = e.at;
    cases.push(c);
    open.delete(e.key);
  }
  cases.push(...open.values());
  for (const c of cases) c.min = Math.round(workTime(shifts.get(c.owner) || [], c.first, c.at ?? now).ms / 60e3);
  return cases.sort((a, b) => a.first - b.first);
}

// Worked local days per team member from their actions (messages, calls) → shifts
export function teamShifts(team, actions) {
  const days = new Map(team.map((m) => [m.id, new Set()]));
  for (const { user, at } of actions) { const s = SERVICE_SCHEDULES[user] || (team.find((m) => m.id === user) || {}).schedule; if (s && days.has(user)) days.get(user).add(localDay(at, s.tz)); }
  // shifts on worked days only, as in replies.js (a day without any action is a day off or an absence)
  const shifts = new Map(team.map((m) => [m.id, shiftsOf(m.schedule, days.get(m.id))]));
  return { days, shifts };
}

// ---- Bitrix collection for one calendar week (Mon–Sun MSK) ----
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const iso = (t) => new Date(t).toISOString();
const ms = (s) => (s ? Date.parse(s) : NaN);
// query string for batch commands: { filter: { A: 1, B: [1, 2] }, select: ["X"] } → filter[A]=1&filter[B][]=1…
export function qs(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    // keys like «>=CALL_START_DATE» must be encoded: a raw «=» splits the pair and Bitrix drops the condition
    const key = prefix ? `${prefix}[${encodeURIComponent(k)}]` : encodeURIComponent(k);
    if (Array.isArray(v)) for (const x of v) out.push(`${key}[]=${encodeURIComponent(x)}`);
    else if (v && typeof v === "object") out.push(qs(v, key));
    else out.push(`${key}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join("&");
}

// All pages of a list method: the first page directly, the rest in batches (one request per 50 pages)
async function listAll(bx, method, body, pause, pick = (r) => r) {
  const first = await bx.call(method, body);
  let rows = pick(first.result) || [];
  const total = first.total || 0;
  if (total > rows.length) {
    const cmds = {};
    for (let s = 50; s < total; s += 50) cmds["p" + s] = `${method}?${qs(body)}&start=${s}`;
    const keys = Object.keys(cmds);
    for (let i = 0; i < keys.length; i += 50) {
      await sleep(pause);
      const { out } = await bx.batch(Object.fromEntries(keys.slice(i, i + 50).map((k) => [k, cmds[k]])));
      for (const k of keys.slice(i, i + 50)) rows = rows.concat(pick(out[k]) || []);
    }
  }
  return rows;
}

// Batches of `size` commands one after another; Bitrix's time budget per method (OPERATION_TIME_LIMIT,
// QUERY_LIMIT_EXCEEDED) → wait a minute and retry that batch
async function slowBatch(bx, cmds, { size = 25, pause = 1500 } = {}) {
  const out = {};
  const keys = Object.keys(cmds);
  for (let i = 0; i < keys.length; i += size) {
    const part = Object.fromEntries(keys.slice(i, i + size).map((k) => [k, cmds[k]]));
    for (let attempt = 1; ; attempt++) {
      if (i || attempt > 1) await sleep(attempt > 1 ? 60e3 : pause);
      try { Object.assign(out, (await bx.batch(part)).out); break; } catch (e) {
        if (attempt >= 5 || !/OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED/.test(e.message)) throw e;
      }
    }
  }
  return out;
}

// Pages by ID without counting (start=-1): fast on big tables, one request per 50 rows
async function listById(bx, method, filter, select, pause) {
  const rows = [];
  for (let last = 0; ; ) {
    const r = await bx.call(method, { filter: { ...filter, ">ID": last }, order: { ID: "ASC" }, select, start: -1 });
    const page = r.result || [];
    rows.push(...page);
    if (page.length < 50) return rows;
    last = Number(page[page.length - 1].ID);
    await sleep(pause);
  }
}

const parseEntities = (s) => {
  const p = String(s || "").split("|"), o = {};
  for (let i = 0; i + 1 < p.length; i += 2) if (Number(p[i + 1])) o[p[i]] = Number(p[i + 1]);
  return o;
};

// Texts are cut for memory, but Wazzup puts its service mark at the end of long texts: keep it
const keepMarks = (t) => { const s = String(t || ""); return s.length <= 400 ? s : s.slice(0, 400) + (s.includes(WAZZUP_SYSTEM) ? " " + WAZZUP_SYSTEM : ""); };

// cache kept by the server between runs: a user code always maps to one chat; messages are read incrementally
export function serviceCache() { return { codes: new Map(), chats: new Map() }; }

export async function collectService(bx, { from, now = Date.now(), cache = serviceCache(), pause = 600, log = () => {} }) {
  const team = SERVICE_TEAM;
  const ids = team.map((m) => m.id);
  const teamIds = new Set(ids);
  const weekStart = Date.parse(from + "T00:00:00+03:00"), weekEnd = weekStart + 7 * DAY;
  const histStart = weekStart - 3 * DAY; // context: who holds the chat when the week starts
  const until = Math.min(now, weekEnd);

  // 1. Open Lines sessions of the team active this week → chats. Paged by ID (offsets over activities take minutes
  // and end in OPERATION_TIME_LIMIT); after the first run only sessions updated since the previous one
  const seen = (cache.weeks ||= {})[from] ||= { touched: new Map(), since: weekStart };
  const runStart = Date.now();
  const sessions = await listById(bx, "crm.activity.list", {
    PROVIDER_ID: "IMOPENLINES_SESSION", RESPONSIBLE_ID: ids, ">=LAST_UPDATED": iso(Math.max(weekStart, seen.since - 10 * 60e3)), "<CREATED": iso(weekEnd),
  }, ["ID", "PROVIDER_PARAMS", "LAST_UPDATED"], pause);
  seen.since = runStart;
  const touched = seen.touched; // user code → latest session update
  for (const s of sessions) {
    const code = s.PROVIDER_PARAMS && s.PROVIDER_PARAMS.USER_CODE;
    if (code) touched.set(code, Math.max(touched.get(code) || 0, ms(s.LAST_UPDATED) || 0));
  }
  const newCodes = [...touched.keys()].filter((c) => !cache.codes.has(c));
  if (newCodes.length) {
    const out = await slowBatch(bx, Object.fromEntries(newCodes.map((c, i) => ["c" + i, `imopenlines.dialog.get?USER_CODE=${encodeURIComponent(c)}`])));
    newCodes.forEach((c, i) => {
      const d = out["c" + i];
      if (!d || !d.id) return;
      const ent = parseEntities(d.entity_data_2);
      cache.codes.set(c, { id: Number(d.id), name: String(d.name || "").split(" - ")[0].trim(), deal: ent.DEAL || null, lead: ent.LEAD || null, contact: ent.CONTACT || null });
    });
  }
  const chatIds = new Map(), infoOf = new Map();
  for (const [code, upd] of touched) {
    const c = cache.codes.get(code);
    if (!c) continue;
    chatIds.set(c.id, Math.max(chatIds.get(c.id) || 0, upd));
    infoOf.set(c.id, c);
  }

  // 2. Messages: new chats paged back to histStart; known ones only after their last cached id
  let todo = [];
  for (const [id, upd] of chatIds) {
    const c = cache.chats.get(id);
    if (!c) { cache.chats.set(id, { id, users: {}, messages: [], fetched: 0 }); todo.push({ id, mode: "back", last: 0 }); }
    else if (upd >= c.fetched - 60e3) todo.push({ id, mode: "fwd", last: Math.max(0, ...c.messages.map((m) => m.id)) });
  }
  const fetchedAt = Date.now();
  for (let round = 1; todo.length && round <= 20; round++) {
    const out = await slowBatch(bx, Object.fromEntries(todo.map((t) => ["m" + t.id,
      `im.dialog.messages.get?DIALOG_ID=chat${t.id}&LIMIT=50` + (t.mode === "back" ? (t.last ? "&LAST_ID=" + t.last : "") : "&FIRST_ID=" + t.last)])));
    const next = [];
    for (const t of todo) {
      const r = out["m" + t.id], c = cache.chats.get(t.id);
      if (!r) continue;
      for (const u of r.users || []) c.users[u.id] = { client: Boolean(u.connector), bot: Boolean(u.bot) };
      const msgs = r.messages || [];
      const have = new Set(c.messages.map((m) => m.id));
      for (const m of msgs) {
        const at = Date.parse(m.date);
        if (at >= histStart && !have.has(Number(m.id))) c.messages.push({ id: Number(m.id), at, a: Number(m.author_id), text: keepMarks(m.text), file: Boolean(m.params && m.params.FILE_ID) });
      }
      c.fetched = fetchedAt;
      if (msgs.length === 50) {
        if (t.mode === "back" && Math.min(...msgs.map((m) => Date.parse(m.date))) >= histStart) next.push({ ...t, last: Math.min(...msgs.map((m) => Number(m.id))) });
        if (t.mode === "fwd") next.push({ ...t, last: Math.max(...msgs.map((m) => Number(m.id))) });
      }
    }
    todo = next;
  }
  const chats = [...chatIds.keys()].map((id) => ({ ...cache.chats.get(id), info: infoOf.get(id) || {} }));

  // 3. Calls of the week: every incoming one (service clients reach sales too) and every call of the team
  const callBody = (f) => ({ FILTER: { ">=CALL_START_DATE": iso(weekStart), "<CALL_START_DATE": iso(weekEnd), ...f } });
  await sleep(pause);
  const callRow = (k) => ({ at: ms(k.CALL_START_DATE), user: Number(k.PORTAL_USER_ID), phone: k.PHONE_NUMBER, ok: String(k.CALL_FAILED_CODE) === "200" && Number(k.CALL_DURATION) > 0,
    type: Number(k.CALL_TYPE), contact: k.CRM_ENTITY_TYPE === "CONTACT" ? Number(k.CRM_ENTITY_ID) : null, lead: k.CRM_ENTITY_TYPE === "LEAD" ? Number(k.CRM_ENTITY_ID) : null,
    deal: k.CRM_ENTITY_TYPE === "DEAL" ? Number(k.CRM_ENTITY_ID) : null });
  const inc = (await listAll(bx, "voximplant.statistic.get", callBody({ CALL_TYPE: 2 }), pause)).map(callRow);
  await sleep(pause);
  const teamCalls = (await listAll(bx, "voximplant.statistic.get", callBody({ PORTAL_USER_ID: ids }), pause)).map(callRow);

  // 4. Service clients among the callers: their «B2C Сервис» deals open now or closed this week (the latest one wins);
  // plus titles of the chats' deals
  const callers = [...new Set(inc.map((c) => c.contact).filter(Boolean))];
  const chatDeals = [...new Set([...infoOf.values()].map((c) => c.deal).filter(Boolean))];
  const dealSel = ["ID", "TITLE", "CONTACT_ID", "ASSIGNED_BY_ID", "CLOSED", "CLOSEDATE"].map((f) => "&select[]=" + f).join("");
  const dcmd = {};
  const chunk = (arr) => Array.from({ length: Math.ceil(arr.length / 50) }, (_, i) => arr.slice(i * 50, i * 50 + 50));
  chunk(callers).forEach((part, i) => { for (const s of [0, 50]) dcmd[`k${i}_${s}`] = `crm.deal.list?filter[CATEGORY_ID]=${SERVICE_PIPELINE}&${part.map((x) => "filter[CONTACT_ID][]=" + x).join("&")}${dealSel}&order[ID]=DESC&start=${s}`; });
  chunk(chatDeals).forEach((part, i) => { dcmd["t" + i] = `crm.deal.list?${part.map((x) => "filter[ID][]=" + x).join("&")}&select[]=ID&select[]=TITLE`; });
  const owners = {}, titles = {};
  const dout = await slowBatch(bx, dcmd);
  for (const [k, list] of Object.entries(dout)) for (const d of list || []) {
    titles[d.ID] = d.TITLE;
    if (k[0] !== "k" || !Number(d.CONTACT_ID)) continue;
    if (d.CLOSED === "Y" && !(ms(d.CLOSEDATE) >= weekStart)) continue;
    const prev = owners[d.CONTACT_ID];
    if (!prev || Number(d.ID) > prev.deal) owners[d.CONTACT_ID] = { deal: Number(d.ID), owner: Number(d.ASSIGNED_BY_ID) };
  }
  const incoming = inc.filter((c) => c.contact && owners[c.contact]);
  const outgoing = teamCalls.filter((c) => c.type === 1);
  const allCalls = inc.concat(teamCalls.filter((c) => c.type !== 2));

  // 5. Shifts from the team's actions (messages, calls)
  const actions = teamCalls.map((c) => ({ user: c.user, at: c.at }));
  const roleCache = new Map();
  for (const c of chats) {
    const r = roles(c, team);
    roleCache.set(c.id, r);
    for (const x of r) if (x.role === "staff" && x.team) actions.push({ user: x.team, at: x.m.at });
  }
  const { days, shifts } = teamShifts(team, actions);

  // 6. Episodes and promises per chat
  const textsByClient = new Map();
  for (const c of chats) for (const x of roleCache.get(c.id)) if (x.role === "client") {
    const t = clean(x.m.text).toLowerCase();
    if (t.length >= 25) (textsByClient.get(t) || textsByClient.set(t, new Set()).get(t)).add(c.id);
  }
  const mass = (t) => (textsByClient.get(t) || { size: 0 }).size >= 3;
  const mine = (info) => (k) => (info.contact && k.contact === info.contact) || (info.lead && k.lead === info.lead) || (info.deal && k.deal === info.deal);
  const episodes = [], promises = [], chatInfo = {};
  for (const c of chats) {
    const info = c.info;
    const talks = allCalls.filter((k) => k.ok && mine(info)(k)).map((k) => k.at).sort((a, b) => a - b);
    const eps = serviceEpisodes({ chat: c, team, shifts, talks, now: until, mass }).filter((e) => e.at >= weekStart && e.at < weekEnd);
    const r = roleCache.get(c.id);
    const teamMsgs = r.filter((x) => x.role === "staff" && x.team).map((x) => x.m.at);
    const callsTo = outgoing.filter(mine(info)).map((k) => k.at);
    const prom = [];
    for (const x of r) {
      if (x.role !== "staff" || !x.team || x.m.at < weekStart || x.m.at >= weekEnd) continue;
      const p = findPromise(x.m.text);
      if (!p) continue;
      const due = promiseDue(p, x.m.at, SERVICE_SCHEDULES[x.team], days.get(x.team));
      prom.push({ chat: c.id, user: x.team, at: x.m.at, text: clean(x.m.text).slice(0, 240),
        ...promiseStatus({ at: x.m.at, due, laterTeam: teamMsgs.filter((t) => t > x.m.at), teamCalls: callsTo, now: until }) });
    }
    if (eps.length || prom.length) chatInfo[c.id] = { name: info.name || "", deal: info.deal || null, lead: info.lead || null, contact: info.contact || null };
    episodes.push(...eps);
    promises.push(...prom);
  }

  // 7. Missed calls of service clients and call-backs. A call-back by anyone of ours counts (user 11.11.2026, deal
  // 852320: an event client called Вяткина of B2B sales directly, she called back the same minute): outgoing calls of
  // the whole portal to the clients with a missed call, by contact
  const missedContacts = [...new Set(incoming.filter((c) => !c.ok).map((c) => c.contact))];
  const others = [];
  for (let i = 0; i < missedContacts.length; i += 50) {
    await sleep(pause);
    others.push(...(await listAll(bx, "voximplant.statistic.get", callBody({ CALL_TYPE: 1, CRM_ENTITY_TYPE: "CONTACT", CRM_ENTITY_ID: missedContacts.slice(i, i + 50) }), pause)).map(callRow));
  }
  const seenCall = new Set(outgoing.map((c) => c.at + ":" + c.user));
  const allOut = outgoing.concat(others.filter((c) => !seenCall.has(c.at + ":" + c.user)));
  const cases = missedCases({ incoming, outgoing: allOut, owners, shifts, now: until }).filter((x) => x.first >= weekStart && x.first < weekEnd);
  // names of colleagues outside the team who called back
  const outsiders = [...new Set(cases.map((c) => c.by).filter((u) => u && !teamIds.has(u)))];
  const people = {};
  if (outsiders.length) {
    await sleep(pause);
    for (const u of (await bx.call("user.get", { FILTER: { ID: outsiders } })).result || []) people[u.ID] = `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim();
  }
  const dealTitles = {};
  for (const x of cases) if (titles[x.deal]) dealTitles[x.deal] = titles[x.deal];
  for (const ci of Object.values(chatInfo)) if (ci.deal && titles[ci.deal]) dealTitles[ci.deal] = titles[ci.deal];

  log(`service ${from}: ${sessions.length} sessions, ${chats.length} chats, ${episodes.length} episodes, ${promises.length} promises, ${incoming.length} incoming, ${cases.length} missed cases`);
  return {
    from, updatedAt: iso(now), chats: chatInfo, deals: dealTitles, episodes, promises, cases, people,
    incoming: incoming.map((c) => ({ at: c.at, contact: c.contact, deal: owners[c.contact].deal, ok: c.ok, team: teamIds.has(c.user), owner: owners[c.contact].owner })),
  };
}

// Overdue tasks of the team now (user 10.11.2026: any overdue, all their tasks)
export async function collectServiceTasks(bx, { now = Date.now(), pause = 600 } = {}) {
  const rows = await listAll(bx, "tasks.task.list", {
    filter: { RESPONSIBLE_ID: SERVICE_TEAM.map((m) => m.id), "<DEADLINE": iso(now), "!REAL_STATUS": [4, 5, 6] },
    select: ["ID", "TITLE", "DEADLINE", "RESPONSIBLE_ID", "UF_CRM_TASK"],
  }, pause, (r) => r && r.tasks);
  return rows.map((t) => ({ id: Number(t.id), title: t.title, deadline: ms(t.deadline), user: Number(t.responsibleId), crm: t.ufCrmTask || [] }))
    .filter((t) => !Number.isNaN(t.deadline)).sort((a, b) => a.deadline - b.deadline);
}

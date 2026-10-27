// «Неделя» page: how fast managers answer clients in Open Lines chats.
// An episode starts with a client's message (a series counts once; «спасибо / ок», Wazzup service notes and our
// phone echoes don't start one) and ends with the first human message of any B2C manager in the chat or a connected
// call on the chat's lead/deal. Robots' templates and the Suvvy bot are not answers. The episode belongs to the
// current owner of the chat's «В2С Продажа» deal, else of its lead — only owners with a schedule in SCHEDULES.
// Time is counted in the owner's working hours only (user's decision 26.10.2026): a message at 23:00 starts the clock
// when the owner's next shift begins; a 2/2 shift counts only on days with at least one action of the owner; lunch is
// not deducted (user's decision 27.10.2026). Answered before the owner's next shift (a colleague covered, or the owner
// wrote after hours) — not counted for anyone.

import { messageAuthor, managerIndex } from "./activity.js";
import { SUVVY_ID } from "./weekstats.js";

const H = 3600e3;
const DAY = 24 * H;
const MSK = 3 * H;
const WAZZUP_SYSTEM = "=== SYSTEM WZ ===";
const OUTGOING = /^\s*=+\s*Исходящее сообщение/;
export const TRIVIAL = /^(спасибо|спс|благодарю|ок|окей|ok|хорошо|понятно|ясно|да|нет|ага|угу|отлично|супер|класс|принято|договорились|жду)[\s!.,)(:]*$/i;
// Not a client's question: Instagram «you were mentioned in a story» notices
const NOT_A_QUESTION = /^(you )?mentioned (you )?in (the|their|your) story$/i;
// Our own texts Wazzup also posts under the client (a mass send, a report-ready notice, the copy of a manager's
// message): the same text shows up as the client's in this many chats of the week, or as ours in the same chat
const MASS_CHATS = 3;
const ECHO_MS = 10 * 60e3;
const clean = (s) => String(s || "").replace(/\[\/?[a-zA-Z]+[^\]]*\]/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const localDay = (ms, tz) => new Date(ms + tz * H).toISOString().slice(0, 10);
const dayStartLocal = (day, tz) => Date.parse(day + "T00:00:00Z") - tz * H;
const mskDay = (ms) => localDay(ms, 3);

// Shifts of one owner: [start, end] in ms for every local day they worked, sorted
export function shiftsOf(s, workedDays) {
  const out = [];
  for (const d of [...workedDays].sort()) {
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    if (s.weekdays && (wd === 0 || wd === 6)) continue;
    const base = dayStartLocal(d, s.tz);
    out.push([base + s.from * H, base + s.to * H]);
  }
  return out;
}

// Working time between a and b over the shifts; also the first working moment at or after a (null if none before b)
export function workTime(shifts, a, b) {
  let start = null, ms = 0;
  for (const [s, e] of shifts) {
    const lo = Math.max(s, a), hi = Math.min(e, b);
    if (hi < lo) continue; // hi === lo: answered right as the shift began — counts, as 0 min
    if (start === null) start = lo;
    ms += hi - lo;
  }
  return { start, ms };
}

// Pure: episodes per chat → per owner, per MSK day of the client's message
// chats: { id: { ents: ["L1","D2"], users: { id: { client } }, messages: [{ id, at, a, text, file }] } }
// ents: { "L1": { owner } }, calls: [{ at, user, dur, code, key: "L1" }], managers: [{ id, name }] — everyone whose
// messages answer a client; schedules: SCHEDULES; from: Monday "YYYY-MM-DD" (MSK)
export function replyStats({ from, now, chats, ents, calls, managers, schedules, details = null }) {
  const index = managerIndex(managers);
  const weekStart = Date.parse(from + "T00:00:00+03:00");
  const weekEnd = weekStart + 7 * DAY;

  // Days each owner worked (local date): any own human message or call
  const worked = new Map();
  const mark = (id, at) => { const s = schedules[id]; if (s) (worked.get(id) || worked.set(id, new Set()).get(id)).add(localDay(at, s.tz)); };
  const isClientOf = (c) => new Map(Object.entries(c.users || {}).map(([id, u]) => [String(id), Boolean(u.client)]));
  for (const c of Object.values(chats)) {
    const isClient = isClientOf(c);
    for (const m of c.messages) { const who = messageAuthor({ author_id: m.a, text: m.text }, isClient, index); if (who) mark(who, m.at); }
  }
  for (const k of calls) mark(k.user, k.at);
  const shifts = new Map([...worked].map(([id, days]) => [id, shiftsOf(schedules[id], days)]));

  const talks = new Map();
  for (const k of calls) if (k.dur > 0 && String(k.code) === "200" && k.key) (talks.get(k.key) || talks.set(k.key, []).get(k.key)).push(k.at);

  // Client-side texts repeated across chats are our sends, not clients' words
  const norm = (t) => clean(t).toLowerCase();
  const chatsByText = new Map();
  for (const [id, c] of Object.entries(chats)) {
    const isClient = isClientOf(c);
    for (const m of c.messages) {
      if (!isClient.get(String(m.a))) continue;
      const t = norm(m.text);
      if (t.length >= 25) (chatsByText.get(t) || chatsByText.set(t, new Set()).get(t)).add(id);
    }
  }
  const mass = (t) => (chatsByText.get(t) || { size: 0 }).size >= MASS_CHATS;

  const cells = {};
  const cell = (o, d) => ((cells[o] ||= {})[d] ||= { n: 0, waiting: 0, times: [] });
  for (const c of Object.values(chats)) {
    const own = (pre) => c.ents.find((k) => k[0] === pre && ents[k] && schedules[ents[k].owner]);
    const ownerKey = own("D") || own("L");
    if (!ownerKey) continue;
    const owner = ents[ownerKey].owner;
    const sh = shifts.get(owner) || [];
    const callTimes = c.ents.flatMap((k) => talks.get(k) || []).sort((a, b) => a - b);
    const isClient = isClientOf(c);
    const sorted = [...c.messages].sort((a, b) => a.at - b.at || a.id - b.id);
    const ours = sorted.filter((m) => m.a && !isClient.get(String(m.a))).map((m) => ({ at: m.at, t: norm(m.text) }));
    const echo = (m, t) => ours.some((o) => o.t === t && Math.abs(o.at - m.at) <= ECHO_MS);
    const episodes = [];
    let open = null;
    for (const m of sorted) {
      if (open) { const t = callTimes.find((x) => x > open.at && x < m.at); if (t) { open.reply = t; episodes.push(open); open = null; } }
      if (!m.a || String(m.text).includes(WAZZUP_SYSTEM)) continue;
      if (isClient.get(String(m.a)) && !OUTGOING.test(m.text)) {
        const t = clean(m.text), n = t.toLowerCase();
        if (open || NOT_A_QUESTION.test(t) || (n && (echo(m, n) || mass(n)))) continue;
        if (m.file || (t && !TRIVIAL.test(t) && /[\p{L}\p{N}]/u.test(t))) open = { at: m.at, reply: null };
        continue;
      }
      // The Suvvy bot answered: it is handling the chat — not counted for anyone
      if (open && Number(m.a) === SUVVY_ID) { open = null; continue; }
      if (open && messageAuthor({ author_id: m.a, text: m.text }, isClient, index)) { open.reply = m.at; episodes.push(open); open = null; }
    }
    if (open) { const t = callTimes.find((x) => x > open.at); open.reply = t || null; episodes.push(open); }

    for (const e of episodes) {
      if (e.at < weekStart || e.at >= weekEnd) continue;
      const w = workTime(sh, e.at, e.reply ?? now);
      if (w.start === null) continue; // answered (or still waiting) before the owner's next shift
      const x = cell(owner, mskDay(e.at));
      x.n++;
      if (e.reply) x.times.push(Math.round(w.ms / 60e3)); else x.waiting++;
      if (details) details.push({ chat: c, owner, at: e.at, reply: e.reply, min: Math.round(w.ms / 60e3) });
    }
  }
  return { from, now, cells };
}

// Bitrix: owners' leads and «В2С Продажа» deals active this week → their chats paged back to the week start → calls
export async function collectReplies(bx, { from, now = Date.now(), owners, managers, schedules, dealCategory = 27, log = () => {}, details = null }) {
  const ids = owners.map((o) => o.id);
  const fromIso = from + "T00:00:00+03:00";
  const weekStart = Date.parse(fromIso);
  const leadSel = ["ID", "ASSIGNED_BY_ID"], dealSel = ["ID", "ASSIGNED_BY_ID"];
  const lists = await Promise.all([
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, STATUS_SEMANTIC_ID: "P" }, select: leadSel }),
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, ">=DATE_CLOSED": fromIso }, select: leadSel }),
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, ">=DATE_CREATE": fromIso }, select: leadSel }),
    bx.list("crm.deal.list", { filter: { CATEGORY_ID: dealCategory, ASSIGNED_BY_ID: ids, STAGE_SEMANTIC_ID: "P" }, select: dealSel }),
    bx.list("crm.deal.list", { filter: { CATEGORY_ID: dealCategory, ASSIGNED_BY_ID: ids, ">=CLOSEDATE": fromIso }, select: dealSel }),
  ]);
  const ents = {};
  lists.forEach((rows, i) => { for (const r of rows) ents[(i < 3 ? "L" : "D") + r.ID] = { owner: Number(r.ASSIGNED_BY_ID) }; });

  const keys = Object.keys(ents);
  const { out: chatRes } = await bx.batch(Object.fromEntries(keys.map((k) => [k, `imopenlines.crm.chat.get?CRM_ENTITY_TYPE=${k[0] === "L" ? "LEAD" : "DEAL"}&CRM_ENTITY=${k.slice(1)}&ACTIVE_ONLY=N`])));
  const chats = {};
  for (const k of keys) for (const c of chatRes[k] || []) if (c && c.CHAT_ID) {
    const ch = (chats[c.CHAT_ID] ||= { ents: [], users: {}, messages: [] });
    if (!ch.ents.includes(k)) ch.ents.push(k);
  }

  // Newest first, 50 per request, LAST_ID = the oldest id seen; stop once a page reaches before the week
  let todo = Object.keys(chats).map((c) => ({ c, last: 0 }));
  for (let round = 1; todo.length && round <= 20; round++) {
    const { out } = await bx.batch(Object.fromEntries(todo.map(({ c, last }) => ["m" + c, `im.dialog.messages.get?DIALOG_ID=chat${c}&LIMIT=50${last ? "&LAST_ID=" + last : ""}`])));
    const next = [];
    for (const { c } of todo) {
      const r = out["m" + c];
      if (!r) continue;
      for (const u of r.users || []) chats[c].users[u.id] = { client: Boolean(u.connector) };
      const ms = r.messages || [];
      for (const m of ms) {
        const at = Date.parse(m.date);
        if (at >= weekStart) chats[c].messages.push({ id: Number(m.id), at, a: Number(m.author_id), text: String(m.text || "").slice(0, 300), file: Boolean(m.params && m.params.FILE_ID) });
      }
      if (ms.length === 50 && Math.min(...ms.map((m) => Date.parse(m.date))) >= weekStart) next.push({ c, last: Math.min(...ms.map((m) => Number(m.id))) });
    }
    todo = next;
  }
  for (const [id, c] of Object.entries(chats)) if (!c.messages.length) delete chats[id];

  const calls = (await bx.list("voximplant.statistic.get", { FILTER: { ">=CALL_START_DATE": fromIso, PORTAL_USER_ID: managers.map((m) => m.id) } }))
    .map((k) => ({ at: Date.parse(k.CALL_START_DATE), user: Number(k.PORTAL_USER_ID), dur: Number(k.CALL_DURATION), code: String(k.CALL_FAILED_CODE),
      key: ({ LEAD: "L", DEAL: "D" }[k.CRM_ENTITY_TYPE] || "") && Number(k.CRM_ENTITY_ID) ? { LEAD: "L", DEAL: "D" }[k.CRM_ENTITY_TYPE] + k.CRM_ENTITY_ID : null }));
  log(`replies ${from}: ${keys.length} cards, ${Object.keys(chats).length} chats, ${calls.length} calls`);
  return replyStats({ from, now, chats, ents, calls, managers, schedules, details });
}

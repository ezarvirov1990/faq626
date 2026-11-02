// Уведомления руководителю в Mattermost: менеджер в своё рабочее время 20 минут ничего не делает в Bitrix24.
// Правила — чистая функция decideAlerts (проверки — alerts.test.js), отправка — createMattermost.

export const SILENCE_MS = 20 * 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Графики менеджеров (со слов руководителя, 30.09.2026; подтверждены менеджерами 26–27.10.2026). tz — часовой пояс, часов от UTC.
// weekdays: true — 5/2, пн–пт; false — 2/2: рабочий ли день, видно только по первому действию за день.
// Кого нет в списке (руководитель и новые сотрудники), тот не проверяется.
const NSK = { tz: 7, from: 10, to: 19, weekdays: true };
const MSK_5_2 = { tz: 3, from: 10, to: 19, weekdays: true };
const MSK_2_2 = { tz: 3, from: 9, to: 21, weekdays: false };
const MSK_2_2_LATE = { tz: 3, from: 10, to: 22, weekdays: false }; // Радченко (her answer 27.10.2026)
export const SCHEDULES = {
  251414: NSK, 117061: NSK, 318794: NSK, // Юрганова, Василевская, Носкова (Воробьева left in October)
  73919: MSK_5_2, // Кондратьева
  412800: MSK_5_2, 412804: MSK_5_2, // Первухина, Татриева (new, the user 02.11.2026)
  203760: MSK_2_2, 242224: MSK_2_2, 91397: MSK_2_2, // Муртазина, Ямщикова, Путятина
  130142: MSK_2_2_LATE, // Радченко
};

// Working hours of the alert recipient (Мария Самусевич: Mon–Fri 9–19 Novosibirsk, decision 30.09.2026).
// Outside them alerts are not sent and not queued: by the morning a pause is old news.
export const RECIPIENT_HOURS = { tz: 7, from: 9, to: 19, weekdays: true };
export const recipientOnDuty = (now, hours = RECIPIENT_HOURS) => Boolean(shiftNow(hours, now));

// When the head is off, alerts go to the backup (Кондратьева, decision 21.10.2026) during her own shift,
// except alerts about the backup herself and days she is absent. Returns "primary", "backup" or null (drop).
export const BACKUP_ID = "73919";
export function alertRecipient(now, managerId, { absent = {}, hours = RECIPIENT_HOURS, backupId = BACKUP_ID, schedules = SCHEDULES } = {}) {
  if (recipientOnDuty(now, hours)) return "primary";
  if (!backupId || String(managerId) === String(backupId) || absent[backupId]) return null;
  return shiftNow(schedules[backupId], now) ? "backup" : null;
}

// Смена сегодня, если сейчас рабочее время: { start, end } (мс) или null
export function shiftNow(s, now) {
  const local = now + s.tz * HOUR;
  const dayLocal = Math.floor(local / DAY) * DAY;
  const weekday = new Date(local).getUTCDay(); // 0 — воскресенье
  if (s.weekdays && (weekday === 0 || weekday === 6)) return null;
  const start = dayLocal + s.from * HOUR - s.tz * HOUR;
  const end = dayLocal + s.to * HOUR - s.tz * HOUR;
  return now >= start && now < end ? { start, end } : null;
}

// Что отправить. events — события ленты за сегодня (любой порядок), absent — { id: true }, open — открытые «простои»
// { id: { ref, kind } }, messagesAt — когда последний раз собраны сообщения (до этого момента тишина не доказана).
// Возвращает { send: [...], open } — новое состояние простоев.
export function decideAlerts({ now, managers, events, absent = {}, open = {}, messagesAt = 0, schedules = SCHEDULES }) {
  const next = { ...open };
  const send = [];
  const lastOf = new Map();
  for (const e of events) if (!lastOf.has(e.managerId) || e.at > lastOf.get(e.managerId).at) lastOf.set(e.managerId, e);

  for (const m of managers) {
    const s = schedules[m.id];
    if (!s) continue;
    const last = lastOf.get(m.id);
    const o = next[m.id];
    if (o && last && last.at > o.ref) {
      send.push({ kind: "back", manager: m, last, pauseMs: last.at - o.ref, was: o.kind });
      delete next[m.id];
    }
    const shift = shiftNow(s, now);
    if (!shift || absent[m.id]) { delete next[m.id]; continue; }
    if (next[m.id]) continue;
    let ref, kind;
    if (last && last.at >= shift.start) { ref = last.at; kind = "silent"; }
    else if (s.weekdays) { ref = shift.start; kind = "nostart"; } // 5/2: день точно рабочий, а действий в смену ещё нет
    else continue; // 2/2: пока нет действий — не знаем, рабочий ли день
    if (now - ref >= SILENCE_MS && messagesAt >= ref + SILENCE_MS) {
      send.push({ kind, manager: m, last: kind === "silent" ? last : null, since: ref, shiftStart: shift.start, tz: s.tz });
      next[m.id] = { ref, kind };
    }
  }
  return { send, open: next };
}

// «Лента событий» → inactivity of a day (the user's choice 02.11.2026, variant A): pauses of SILENCE_MS+ inside the
// shift — between two actions, or from the last action to the shift end (today — to now, the pause still going),
// the same rule as the alerts. The start of the shift before the first action isn't counted.
// dayStart — MSK midnight of the day; events — that day's feed events of the manager (any order).
// null: no schedule, a 5/2 weekend, a 2/2 day without actions (a day off), absent per the chart
export const MIN_WORKDAY_ACTIONS = 5;
export function idleDay(events, s, dayStart, now, { absent = false, minMs = SILENCE_MS } = {}) {
  if (!s || absent) return null;
  const local = dayStart + 12 * HOUR + s.tz * HOUR; // the manager's calendar day that matches this MSK day
  const weekday = new Date(local).getUTCDay();
  if (s.weekdays && (weekday === 0 || weekday === 6)) return null;
  const midnight = Math.floor(local / DAY) * DAY - s.tz * HOUR;
  const start = midnight + s.from * HOUR, end = midnight + s.to * HOUR;
  const acts = events.filter((e) => e.at < Math.min(end, now)).sort((a, b) => a.at - b.at);
  // no actions yet: 5/2 — a working day with nothing done (not a pause by this rule); 2/2 — likely a day off
  if (!acts.length) return s.weekdays && now > start ? { start, end, totalMs: 0, pauses: [], actions: 0 } : null;
  // 2/2: a handful of actions is a day off with a quick look at the CRM (Радченко 30.10.2026: one stage move at 10:57
  // would read as an 11-hour pause); today the rule waits until there are enough actions
  if (!s.weekdays && events.length < MIN_WORKDAY_ACTIONS) return null;
  const pauses = [];
  const add = (from, to, before, after) => {
    const a = Math.max(from, start), b = Math.min(to, end);
    if (b - a >= minMs) pauses.push({ from: a, to: b, ms: b - a, before: before.kind, after: after ? after.kind : null, open: !after && to === now });
  };
  for (let i = 1; i < acts.length; i++) add(acts[i - 1].at, acts[i].at, acts[i - 1], acts[i]);
  const last = acts[acts.length - 1];
  add(last.at, Math.min(now, end), last, null);
  return { start, end, totalMs: pauses.reduce((a, p) => a + p.ms, 0), pauses, actions: acts.filter((e) => e.at >= start).length };
}

const LABEL = {
  msg: "💬 сообщение клиенту", comment: "📝 заметка в карточке", call: "📞 звонок", move: "➡️ смена стадии",
  task_new: "🆕 новая задача", task_done: "✅ закрыта задача", task_deadline: "📅 перенос срока задачи",
};
const hm = (ms, tz = 3) => new Date(ms + tz * HOUR).toISOString().slice(11, 16);
const mins = (ms) => {
  const m = Math.round(ms / 60e3);
  return m < 60 ? m + " мин" : Math.floor(m / 60) + " ч " + (m % 60) + " мин";
};

export function alertText(a, { online, feedUrl } = {}) {
  const who = `**${a.manager.name}**`;
  const net = online === undefined ? "" : online ? " В Bitrix24 — в сети." : " В Bitrix24 — не в сети.";
  const link = feedUrl ? `\n[Лента событий](${feedUrl})` : "";
  if (a.kind === "back") return `▶️ ${who} снова в работе: ${hm(a.last.at)} МСК — ${LABEL[a.last.kind] || a.last.kind}. Пауза была ${mins(a.pauseMs)}.`;
  if (a.kind === "nostart") {
    const local = a.tz === 3 ? "" : ` (${hm(a.shiftStart, a.tz)} по местному)`;
    return `🌅 ${who}: смена с ${hm(a.shiftStart)} МСК${local}, а действий в Bitrix24 пока нет.${net}${link}`;
  }
  return `⏸ ${who}: нет активности 20 минут. Последнее действие — ${hm(a.last.at)} МСК, ${LABEL[a.last.kind] || a.last.kind}.${net}${link}`;
}

// Личные сообщения от бота Mattermost
export function createMattermost({ url, token }) {
  const base = url.replace(/\/+$/, "") + "/api/v4";
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20e3),
    });
    if (!res.ok) throw new Error(`Mattermost ${path}: HTTP ${res.status}`);
    return res.json();
  };
  let me = null;
  return {
    async direct(userId, message) {
      me = me || (await call("GET", "/users/me"));
      const ch = await call("POST", "/channels/direct", [me.id, userId]);
      return call("POST", "/posts", { channel_id: ch.id, message });
    },
  };
}

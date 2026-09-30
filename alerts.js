// Уведомления руководителю в Mattermost: менеджер в своё рабочее время 20 минут ничего не делает в Bitrix24.
// Правила — чистая функция decideAlerts (проверки — alerts.test.js), отправка — createMattermost.

export const SILENCE_MS = 20 * 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Графики менеджеров (со слов руководителя, 30.09.2026). tz — часовой пояс, часов от UTC.
// weekdays: true — 5/2, пн–пт; false — 2/2: рабочий ли день, видно только по первому действию за день.
// Кого нет в списке (руководитель и новые сотрудники), тот не проверяется.
const NSK = { tz: 7, from: 10, to: 19, weekdays: true };
const MSK_5_2 = { tz: 3, from: 10, to: 19, weekdays: true };
const MSK_2_2 = { tz: 3, from: 9, to: 21, weekdays: false };
export const SCHEDULES = {
  251414: NSK, 117061: NSK, 387234: NSK, 318794: NSK, // Юрганова, Василевская, Воробьева, Носкова
  73919: MSK_5_2, // Кондратьева
  203760: MSK_2_2, 242224: MSK_2_2, 91397: MSK_2_2, 130142: MSK_2_2, // Муртазина, Ямщикова, Путятина, Радченко
};

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

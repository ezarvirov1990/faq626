// Вкладка «Лента событий»: что сегодня (по Москве) делали менеджеры групп B2C и кто сейчас в сети.
// Правила разбора — чистые функции (их проверяет activity.test.js), сбор из Bitrix — collectLive.

import { mskDayStart, MOVE_GRACE_MS } from "./tasks.js";

const OUTGOING_AUTHOR = /^\s*=+\s*Исходящее сообщение, автор:\s*Битрикс24\s*\(([^)]+)\)/;
const WAZZUP_SYSTEM_MARK = "=== SYSTEM WZ ===";
// Шаблонные дожимы роботов стадий: пишутся от имени ответственного, но это не действие менеджера
export const ROBOT_TEXT = /Актуально ли для Вас получить информацию по ДНК|Мне важно получить хоть какой-то ответ|Очень жду (от вас )?ваш ответ|не смогли до вас дозвониться|Два дня не получаю от вас ответа|Буду благодарна за обратную связь|Вдруг вы пропустили моё прошлое сообщение/i;
// Задачи, которые роботы ставят на ответственного при появлении лида и смене стадии
export const ROBOT_TASK = /^(Первые сутки|Вторые сутки|Третьи сутки|Оказать консультацию|Контроль )/i;
// Изменение карточки в пределах минуты от смены стадии — это и есть смена стадии
const EDIT_SAME_AS_MOVE_MS = 60e3;
const TASK_DONE = "5";

const normName = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

export function managerIndex(managers) {
  return { ids: new Set(managers.map((m) => m.id)), byName: new Map(managers.map((m) => [normName(m.name), m.id])) };
}

// Кто из менеджеров написал сообщение в чате Открытой линии (или null — клиент, бот, система, робот).
// Wazzup записывает наши исходящие из Битрикс24 от имени клиента: «=== Исходящее сообщение, автор: Битрикс24 (Имя Фамилия) ===».
export function messageAuthor(msg, isClient, index) {
  const author = Number(msg.author_id);
  const text = msg.text || "";
  if (!author || text.includes(WAZZUP_SYSTEM_MARK) || ROBOT_TEXT.test(text)) return null;
  if (isClient.get(String(author))) {
    const m = OUTGOING_AUTHOR.exec(text);
    return m ? index.byName.get(normName(m[1])) ?? null : null;
  }
  return index.ids.has(author) ? author : null;
}

// Сообщения менеджеров клиентам в одном чате с момента since
export function messageEvents(dialog, index, since) {
  const isClient = new Map((dialog.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
  const out = [];
  for (const x of dialog.messages || []) {
    const at = Date.parse(x.date);
    if (!(at >= since)) continue;
    const managerId = messageAuthor(x, isClient, index);
    if (managerId) out.push({ key: "msg:" + x.id, at, managerId, kind: "msg" });
  }
  return out;
}

// События из истории задачи: создал (кроме роботов), закрыл, перенёс срок (кроме правки сразу после создания)
export function taskHistoryEvents(taskId, title, history, managerIds, since) {
  const out = [];
  const created = history.find((h) => h.field === "NEW");
  const createdAt = created ? Date.parse(created.createdDate) : 0;
  for (const h of history) {
    const at = Date.parse(h.createdDate);
    const managerId = Number(h.user && h.user.id);
    if (!(at >= since) || !managerIds.has(managerId)) continue;
    const base = { key: `task:${taskId}:${h.id ?? at}:${h.field}`, at, managerId, title };
    const v = h.value || {};
    if (h.field === "NEW" && !ROBOT_TASK.test(title || "")) out.push({ ...base, kind: "task_new" });
    else if (h.field === "STATUS" && String(v.to) === TASK_DONE) out.push({ ...base, kind: "task_done" });
    else if (h.field === "DEADLINE" && !(createdAt && at - createdAt < MOVE_GRACE_MS)) {
      out.push({ ...base, kind: "task_deadline", from: Number(v.from) * 1000 || null, to: Number(v.to) * 1000 || null });
    }
  }
  return out;
}

// Смена стадии и правка карточки лида или сделки. Bitrix хранит только последнюю смену стадии и последнюю правку.
export function cardEvents(entity, row, managerIds, since, stageName) {
  const out = [];
  const movedAt = Date.parse(row.MOVED_TIME);
  const movedBy = Number(row.MOVED_BY_ID);
  if (movedAt >= since && managerIds.has(movedBy)) {
    out.push({ key: `move:${entity}:${row.ID}:${movedAt}`, at: movedAt, managerId: movedBy, kind: "move", entity, stage: stageName || null });
  }
  const editAt = Date.parse(row.DATE_MODIFY);
  const editBy = Number(row.MODIFY_BY_ID);
  const sameAsMove = editBy === movedBy && Math.abs(editAt - movedAt) < EDIT_SAME_AS_MOVE_MS;
  if (editAt >= since && managerIds.has(editBy) && !sameAsMove) {
    out.push({ key: `edit:${entity}:${row.ID}:${editAt}`, at: editAt, managerId: editBy, kind: "edit", entity });
  }
  return out;
}

// Заметки менеджеров в ленте лида или сделки (crm.timeline.comment.list)
export function commentEvents(entity, rows, managerIds, since) {
  return rows
    .map((c) => ({ key: "comment:" + c.ID, at: Date.parse(c.CREATED), managerId: Number(c.AUTHOR_ID), kind: "comment", entity }))
    .filter((e) => e.at >= since && managerIds.has(e.managerId));
}

// Звонок из статистики телефонии. Пропущенный входящий — не действие менеджера.
export function callEvent(c) {
  const outgoing = Number(c.CALL_TYPE) === 1;
  const ok = String(c.CALL_FAILED_CODE) === "200";
  if (!outgoing && !ok) return null;
  const at = Date.parse(c.CALL_START_DATE);
  return { key: "call:" + (c.CALL_ID || c.ID), at, managerId: Number(c.PORTAL_USER_ID), kind: "call", outgoing, ok, seconds: Number(c.CALL_DURATION) || 0 };
}

// Быстрый сбор (раз в минуту): кто в сети, звонки, смены стадий, правки карточек, задачи.
// tasksSince — с какого момента смотреть изменённые задачи (чтобы не перечитывать историю всех задач каждую минуту).
export async function collectLive(bx, managers, { now = Date.now(), tasksSince } = {}) {
  const since = mskDayStart(now);
  const ids = managers.map((m) => m.id);
  const idSet = new Set(ids);
  const iso = (ms) => new Date(ms).toISOString();
  const events = [];

  const users = (await bx.call("user.get", { FILTER: { ID: ids } })).result || [];
  const online = Object.fromEntries(users.map((u) => [Number(u.ID), u.IS_ONLINE === "Y"]));

  const calls = await bx.list("voximplant.statistic.get", { FILTER: { PORTAL_USER_ID: ids, ">=CALL_START_DATE": iso(since) } });
  for (const c of calls) { const e = callEvent(c); if (e && idSet.has(e.managerId)) events.push(e); }

  const stageNames = { lead: {}, deal: {} };
  for (const s of await bx.list("crm.status.list", {})) {
    if (s.ENTITY_ID === "STATUS") stageNames.lead[s.STATUS_ID] = s.NAME;
    else if (String(s.ENTITY_ID).startsWith("DEAL_STAGE")) stageNames.deal[s.STATUS_ID] = s.NAME;
  }
  const cards = [
    { entity: "lead", method: "crm.lead.list", stage: "STATUS_ID" },
    { entity: "deal", method: "crm.deal.list", stage: "STAGE_ID" },
  ];
  for (const c of cards) {
    const select = ["ID", c.stage, "MOVED_TIME", "MOVED_BY_ID", "DATE_MODIFY", "MODIFY_BY_ID"];
    const seen = new Map();
    for (const filter of [{ ">=MOVED_TIME": iso(since), MOVED_BY_ID: ids }, { ">=DATE_MODIFY": iso(since), MODIFY_BY_ID: ids }]) {
      for (const row of await bx.list(c.method, { filter, select })) seen.set(row.ID, row);
    }
    for (const row of seen.values()) events.push(...cardEvents(c.entity, row, idSet, since, stageNames[c.entity][row[c.stage]]));
  }

  const taskFrom = Math.max(since, tasksSince || since);
  const tasks = new Map();
  for (const who of ["RESPONSIBLE_ID", "CREATED_BY"]) {
    // tasks.task.list отдаёт задачи в result.tasks, поэтому листаем сами
    let start = 0;
    do {
      const r = await bx.call("tasks.task.list", { filter: { [who]: ids, ">=CHANGED_DATE": iso(taskFrom) }, select: ["ID", "TITLE"], start });
      for (const t of (r.result && r.result.tasks) || []) tasks.set(String(t.id), t.title);
      start = r.next;
    } while (start);
  }
  const hist = await bx.batch(Object.fromEntries([...tasks.keys()].map((id) => ["h_" + id, `tasks.task.history.list?taskId=${id}`])));
  for (const [id, title] of tasks) events.push(...taskHistoryEvents(id, title, ((hist.out["h_" + id] || {}).list) || [], idSet, since));

  return { day: since, online, events };
}

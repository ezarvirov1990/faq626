// faq626/stagerules.js
// «Сделки» → «Правила этапов»: «В2С Продажа» deals that break the stage rules (the user's rules, 29.10.2026).
// Pure rule logic (stagerules.test.js); collector.js feeds it with chats, calls and comments it already loads,
// collectStageFlow reads the 7-day stage flow from Bitrix.

import { SCHEDULES } from "./alerts.js";
import { messageAuthor, ROBOT_TEXT } from "./activity.js";
import { SERVICE_TEXT } from "./undelivered.js";

const DAY = 864e5;
const MSK = 3 * 3600e3;
export const RULE_PIPELINE = 27;
export const STAGES = [
  { id: "C27:mygenetics.amocrm.ru_30370630", key: "need", name: "Выявили потребность", limitDays: 15 },
  { id: "C27:mygenetics.amocrm.ru_30370633", key: "product", name: "Выбран продукт (КЭВ)", limitDays: 30 },
  { id: "C27:mygenetics.amocrm.ru_30370636", key: "ready", name: "Готов оплачивать", limitDays: 2 },
  { id: "C27:UC_5C7VFG", key: "push", name: "Дожимаем", limitDays: 5 },
];
const WON = "C27:WON";
const CLOSED = new Set(["C27:LOSE", "C27:10", "C27:11"]);
export const FIELDS = {
  request: "UF_CRM_67A0A0880E955", // «Запрос клиента»
  test: "UF_CRM_1631596713140", // «Какой тест планирует купить» («Список товаров_нью» in REST)
  nextContact: "UF_CRM_1599366683581", // «Дата следующего контакта (Анализ интереса)»
  payDate: "UF_CRM_1648734958777", // «Дата Готов оплачивать»
};
export const RULE_SELECT = ["MOVED_TIME", "OPPORTUNITY", ...Object.values(FIELDS)];
// Above this the amount is likely a typo (29.10.2026: 498 000 and 249 000 ₽ on «Выбран продукт»)
export const BIG_AMOUNT = 150000;

const mskDay = (ms) => Math.floor((ms + MSK) / DAY);
const dayStart = (n) => n * DAY - MSK; // first instant of an MSK day number
const ddmm = (ms) => new Date(ms + MSK).toISOString().slice(5, 10).split("-").reverse().join(".");
const days = (n) => n + " " + (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня" : "дней");

// A manager comment that says the client is in touch («договорились», «с личного ответила», «на связи»);
// «не отвечает», «недозвон», «молчит» win. Substrings, not \b: JS word boundaries don't work for Cyrillic
const CONTACT_YES = ["договор", "на связи", "ответил", "ответила", "ответили", "созвон", "с личного", "в личн", "переписыва", "переписк",
  "общаем", "общались", "пообщал", "оплатит", "оплачу", "обещал", "написал в", "написала в", "пишет в", "ватсап", "вотсап", "whatsapp", "телеграм", "telegram"];
const CONTACT_NO = ["не отвеча", "не ответил", "не ответила", "не дозвон", "недозвон", "не на связи", "молчит", "не бер", "без ответа", "игнор", "сброс", "не выходит на связь", "не прочитал"];
export function contactNote(text) {
  const t = String(text || "").toLowerCase().replace(/ё/g, "е");
  return CONTACT_YES.some((w) => t.includes(w)) && !CONTACT_NO.some((w) => t.includes(w));
}

// «Выбран продукт»: the manager's comment must say why the client won't pay now (the user's rule 30.10.2026) —
// a reason word or a date; checked by words, so some honest comments will be missed (the user accepted that)
const PAY_REASON = ["деньг", "денег", "зарплат", "зп ", "аванс", "бюджет", "дорого", "дороговат", "цена", "цену", "стоимост", "скидк", "акци",
  "рассрочк", "кредит", "долями", "подума", "посовет", "обсуд", "муж", "жена", "супруг", "мама", "маме", "родител", "дочь", "сын",
  "врач", "доктор", "анализ", "после", "позже", "потом", "не сейчас", "не готов", "не может", "отпуск", "командиров", "болеет", "болезн",
  "заболел", "больниц", "переезд", "ремонт", "праздник", "новый год", " нг ", "ноябр", "декабр", "январ", "феврал", "месяц", "недел",
  "сравнива", "выбира", "сомнева", "не уверен", "ждет", "ждут", "перезвон", "связаться", "оплатит", "оплата", "оплату", "оплачу"];
const DATE_IN_TEXT = /\d{1,2}[./]\d{1,2}|\d{1,2}\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)/;
export function payReason(text) {
  const t = " " + String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\[[^\]]*\]/g, " ") + " ";
  return DATE_IN_TEXT.test(t) || PAY_REASON.some((w) => t.includes(w));
}

// One deal on a checked stage → what's wrong. null for stages without rules.
export function stageRules(d, now) {
  const st = STAGES.find((s) => s.id === d.stageId);
  if (!st) return null;
  const onStage = (now - d.movedAt) / DAY;
  const full = Math.floor(onStage);
  const mine = (ts) => ts.filter((t) => t >= d.movedAt && t <= now);
  const attempts = mine(d.attempts), replies = mine(d.replies), comments = mine(d.comments);
  const attemptDays = new Set(attempts.map(mskDay));
  const lastReply = replies.length ? Math.max(...replies) : null;
  // the latest attempt ever (also from before the stage) — shown next to the stage's attempt count
  const before = d.attempts.filter((t) => t <= now);
  const lastAttempt = before.length ? Math.max(...before) : null;
  const quiet = (n) => ![...attempts, ...replies].some((t) => now - t < n * DAY);
  const today = mskDay(now);
  const prevWorkDay = d.prevWorkDay ?? today - 1;
  const over = full > st.limitDays;
  // A manager comment within the stage limit saying the client is in touch: they may talk on the manager's own phone,
  // which Bitrix doesn't see (deal 907014, 30.10.2026). Not an attempt (the user's decision) — it only stops «закрыть»
  const notes = mine(d.contactNotes || []);
  const lastComment = notes.length ? Math.max(...notes) : null;
  const noted = lastComment !== null && now - lastComment <= st.limitDays * DAY;
  const NOTED = "по комментарию менеджера клиент на связи";
  // A cut chat (50 messages, the oldest after the stage move) may hide the client's replies: no «silent», a note instead
  const silentRule = (text) => {
    if (d.cut) add("cut", "w", "Длинная переписка — проверьте ответы клиента в чате");
    else if (noted) add("noted", "w", "В чате клиент молчит, но " + NOTED + " — перевести дальше или назначить дату");
    else add("silent", "c", text);
  };
  const rules = [];
  const add = (code, level, text) => rules.push({ code, level, text });
  // Open tasks (deadlines, null = no deadline): every «В2С Продажа» deal must have one (the user's rule 30.10.2026);
  // the nearest deadline is the day the manager agreed to contact the client. Not checked when tasks weren't loaded
  const tasks = d.tasks || null;
  const dated = tasks ? tasks.filter((t) => Number.isFinite(t)) : [];
  const taskDue = dated.length ? Math.min(...dated) : null;
  if (tasks && !tasks.length) add("notask", "c", "Нет открытой задачи — поставить задачу с датой связи");
  if (taskDue !== null && mskDay(taskDue) < today && !attempts.some((t) => t >= dayStart(mskDay(taskDue)))) {
    add("taskdue", "w", `Срок задачи ${ddmm(taskDue)} прошёл — попытки связаться не было`);
  }

  if (st.key === "need" || st.key === "product") {
    if (over) add("over", "c", `На этапе ${days(full)} из ${st.limitDays} — передвинуть${st.key === "need" ? " на «Выбран продукт»" : ""}` + (noted ? " (" + NOTED + ")" : " или закрыть"));
    // «Выявили потребность»: a contact time the client named (today or later) is not silence
    const named = st.key === "need" && d.nextContact && mskDay(d.nextContact) >= today;
    if (full >= st.limitDays && !lastReply && !named) silentRule("Клиент молчит весь срок этапа — закрыть");
    const gap = st.key === "need" ? 5 : 7;
    // The planned contact day counts in MSK days: it pauses the rhythm until that day is over (the field on
    // «Выявили потребность», an open task's deadline on both stages)
    const paused = (st.key === "need" && d.nextContact && mskDay(d.nextContact) >= today) || (taskDue !== null && mskDay(taskDue) >= today);
    if (onStage >= gap && !paused && quiet(gap)) {
      add("rhythm", "w", st.key === "need" ? "5 дней без попытки связаться" : "7 дней без попытки — узнать дату и способ оплаты");
    }
    // Overdue once its MSK day is over with no attempt since the day started
    if (st.key === "need" && d.nextContact && mskDay(d.nextContact) < today && !attempts.some((t) => t >= dayStart(mskDay(d.nextContact)))) {
      add("next", "w", `Следующий контакт был назначен на ${ddmm(d.nextContact)} — попытки не было`);
    }
    if (onStage >= 1 && !comments.length) add("comment", "w", "Нет комментария менеджера на этом этапе");
    else if (st.key === "product" && d.reasonNotes && !mine(d.reasonNotes).length) add("why", "w", "В комментарии не видно, почему клиент не готов оплатить сейчас");
    if (st.key === "need" && !d.request) add("request", "w", "Не заполнен «Запрос клиента»");
    // Required from «Выбран продукт» on (the user's rules); Bitrix returns an empty enumeration as false
    if (st.key === "product" && !d.test) add("test", "w", "Не заполнено «Какой тест планирует купить»");
    if (st.key === "product" && !(d.amount > 0)) add("amount", "w", "Не указана сумма сделки");
    if (st.key === "product" && d.amount > BIG_AMOUNT) add("bigamount", "w", "Проверьте сумму — больше " + BIG_AMOUNT.toLocaleString("ru-RU") + " ₽");
  }
  if (st.key === "ready") {
    if (over) add("over", "c", `На этапе ${days(full)} — больше 2`);
    if (!d.payDate) add("paydate", "c", "Не указана «Дата Готов оплачивать»");
    else if (mskDay(d.payDate) < today) add("paydate", "c", `Дата оплаты ${ddmm(d.payDate)} прошла — проверить оплату; не оплатил — в «Дожимаем»`);
    if (d.payDate && mskDay(d.payDate) < today && !attemptDays.has(mskDay(d.payDate))) add("payday", "w", "В день оплаты не связались с клиентом");
  }
  if (st.key === "push") {
    if (over) add("over", "c", `На этапе ${days(full)} из 5 — ` + (noted ? "перевести в «Готов оплачивать» с датой оплаты (" + NOTED + ")" : "закрыть как «Нереализован» или перевести"));
    if (full >= st.limitDays && !lastReply) silentRule("Клиент не отвечает 5 дней — закрыть как «Нереализован»");
    if (d.worksToday && onStage >= 1 && !attemptDays.has(today) && !attemptDays.has(prevWorkDay)) add("rhythm", "w", "Нужна попытка связаться сегодня");
    if (lastReply && !comments.some((t) => t > lastReply)) add("reason", "w", "Клиент ответил — зафиксируйте причину неоплаты в комментарии");
    if (lastReply && now - lastReply > DAY) add("move", "w", "Клиент ответил — перевести в «Готов оплачивать» с новой датой или в «Выбран продукт»");
  }
  rules.sort((a, b) => (a.level === b.level ? 0 : a.level === "c" ? -1 : 1));
  return { stage: st.key, daysOnStage: full, over, attempts: attemptDays.size, lastAttempt, lastReply, lastComment, hasTask: tasks ? tasks.length > 0 : null, taskDue, rules };
}

const WAZZUP_SYSTEM = "=== SYSTEM WZ ===";
const OUTGOING = /^\s*=+\s*Исходящее сообщение/;
const MASS_CHATS = 3;
const normText = (t) => String(t || "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

// Texts Wazzup posts under the client in MASS_CHATS+ chats: our own sends from the Wazzup app (promo, follow-up
// templates), not clients' words (29.10.2026: «Отличные новости… Детоксикация мини» showed up as the client's)
export function massTexts(dialogs) {
  const chats = new Map();
  for (const d of dialogs) {
    const client = new Set((d.users || []).filter((u) => u.connector).map((u) => String(u.id)));
    for (const t of new Set((d.messages || []).filter((x) => client.has(String(x.author_id))).map((x) => normText(x.text)).filter((t) => t.length >= 25))) {
      chats.set(t, (chats.get(t) || 0) + 1);
    }
  }
  return new Set([...chats].filter(([, n]) => n >= MASS_CHATS).map(([t]) => t));
}

// Our voice in a client-side text: the brand, the company, promos. A client's «Хочу получить…» is not ours.
const OUR_VOICE = /mygenetics|компани|лаборатори|дарим|акци/i;
const WANT = /^хочу/i;
const ourVoice = (text) => OUR_VOICE.test(text) && !WANT.test(text.trim());

// Wazzup failure copy: our message posted under the client with a `=== SYSTEM WZ ===` reason after it.
// The body is ours when it is not empty and not a robot/service text; edits, deletions and missed calls are notes.
const WZ_NOTE_SKIP = /сообщение изменено|сообщение удалено|пропущенный звонок|пропущен звонок/i;
function failureAttempt(text) {
  const at = text.indexOf(WAZZUP_SYSTEM);
  const body = text.slice(0, at).trim();
  const note = text.slice(at + WAZZUP_SYSTEM.length);
  if (!body || WZ_NOTE_SKIP.test(note)) return false;
  return !(ROBOT_TEXT.test(body) || SERVICE_TEXT.test(body));
}

// One chat → when a manager tried (human message, phone echo, our mass send, failure copy) and when the client wrote.
// Robot follow-ups, Suvvy and Wazzup notes are neither.
export function chatSignals(dialog, index, mass) {
  const isClient = new Map((dialog.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
  const human = [], client = [];
  let oldest = null;
  for (const x of dialog.messages || []) {
    const text = String(x.text || "");
    const at = Date.parse(x.date);
    if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at;
    if (!Number(x.author_id) || Number.isNaN(at)) continue;
    if (text.includes(WAZZUP_SYSTEM)) {
      if (isClient.get(String(x.author_id)) && failureAttempt(text)) human.push(at);
      continue;
    }
    if (messageAuthor(x, isClient, index)) { human.push(at); continue; }
    if (!isClient.get(String(x.author_id)) || OUTGOING.test(text)) continue;
    if (!mass.has(normText(text))) { client.push(at); continue; }
    // A text Wazzup posts under the client in 3+ chats is our send from the Wazzup app: an attempt only in our voice
    if (ourVoice(text) && !SERVICE_TEXT.test(text) && !ROBOT_TEXT.test(text)) human.push(at);
  }
  // full: the dialog came back as a whole 50-message page, so older messages may be missing
  return { human: human.sort((a, b) => a - b), client: client.sort((a, b) => a - b), oldest, full: (dialog.messages || []).length >= 50 };
}

// Is today a working day of the owner: 5/2 — Mon–Fri in their time zone; 2/2 — any own action today
// (the same rule as alerts and «Неделя»); no schedule (the head) — Mon–Fri MSK
function worksToday(id, now, worked, schedules) {
  const s = schedules[id];
  if (s && !s.weekdays) return worked.has(id);
  const wd = new Date(now + (s ? s.tz : 3) * 3600e3).getUTCDay();
  return wd !== 0 && wd !== 6;
}

// The owner's previous working day as an MSK day number: 5/2 — the previous Mon–Fri in their time zone
// (Monday → Friday); 2/2 — yesterday. The owner's day is taken at its local noon, so it maps to one MSK day.
function prevWorkDay(id, now, schedules) {
  const s = schedules[id];
  if (s && !s.weekdays) return mskDay(now) - 1;
  const tz = s ? s.tz : 3;
  let p = Math.floor((now + tz * 3600e3) / DAY) - 1;
  while ([0, 6].includes(new Date(p * DAY).getUTCDay())) p--;
  return mskDay(p * DAY + 12 * 3600e3 - tz * 3600e3);
}

// All open deals → the snapshot's views.deals.rules
export function buildRules(deals, { now, flow = null, weeks = null, worked = new Set(), schedules = SCHEDULES }) {
  const stages = STAGES.map((s) => ({ key: s.key, name: s.name, limitDays: s.limitDays, byManager: {} }));
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const items = [];
  for (const d of deals) {
    const r = stageRules({
      ...d, worksToday: worksToday(d.managerId, now, worked, schedules), prevWorkDay: prevWorkDay(d.managerId, now, schedules),
    }, now);
    if (!r) continue;
    const m = (byKey.get(r.stage).byManager[d.managerId] ||= { open: 0, sum: 0, over: 0 });
    m.open++;
    m.sum += Number(d.amount) || 0;
    if (r.over) m.over++;
    if (r.rules.length) items.push({
      id: d.id, managerId: d.managerId, stage: r.stage, amount: d.amount, daysOnStage: r.daysOnStage, over: r.over, attempts: r.attempts,
      lastAttempt: r.lastAttempt ? new Date(r.lastAttempt).toISOString() : null,
      lastComment: r.lastComment ? new Date(r.lastComment).toISOString() : null,
      hasTask: r.hasTask, taskDue: r.taskDue ? new Date(r.taskDue).toISOString() : null,
      lastReply: r.lastReply ? new Date(r.lastReply).toISOString() : null, rules: r.rules,
    });
  }
  // flow — the current calendar week; weeks — finished weeks by their Monday (ISO), kept between collections
  return { updatedAt: new Date(now).toISOString(), flow, weeks, stages, items };
}

// Stage history rows → per checked stage: deals that arrived since `since`, and where deals went when they left it
// (moves at `until` or later are left out — a calendar week). The ids of deals paid from a checked stage come as a
// non-enumerable `paidIds`, so the result stays a plain stage map in JSON
export function stageFlow(rows, since, until = Infinity) {
  const idx = new Map(STAGES.map((s, i) => [s.id, i]));
  const out = Object.fromEntries(STAGES.map((s) => [s.key, { entered: 0, forward: 0, back: 0, closed: 0, paid: 0 }]));
  const paidIds = [];
  Object.defineProperty(out, "paidIds", { value: paidIds, enumerable: false });
  const byDeal = new Map();
  for (const r of rows) {
    const id = String(r.OWNER_ID);
    if (!byDeal.has(id)) byDeal.set(id, []);
    byDeal.get(id).push({ stage: r.STAGE_ID, at: Date.parse(r.CREATED_TIME) });
  }
  for (const [id, hs] of byDeal) {
    hs.sort((a, b) => a.at - b.at);
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h.at < since || h.at >= until) continue;
      const to = idx.get(h.stage);
      if (to !== undefined) out[STAGES[to].key].entered++;
      const prev = i ? hs[i - 1].stage : null;
      const from = idx.get(prev);
      if (from === undefined || prev === h.stage) continue;
      const f = out[STAGES[from].key];
      // A move to an unchecked stage that is neither closed nor paid counts as back: «Консультация оказана»,
      // «Брошенная корзина» and «Свободная база» come earlier in the pipeline than the checked stages
      if (h.stage === WON) { f.paid++; paidIds.push(id); }
      else if (CLOSED.has(h.stage)) f.closed++;
      else if (to !== undefined && to > from) f.forward++;
      else f.back++;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bitrix: stage moves in «В2С Продажа» since `since` (default: the last `days` days) and before `until`, plus, for those
// deals, the last move before the window (where they came from). ~25 paged calls with a pause + ≤3 batches.
export async function collectStageFlow(bx, now, { days = 7, since = now - days * DAY, until = null, pause = 600 } = {}) {
  const sinceIso = new Date(since).toISOString();
  const filter = { CATEGORY_ID: RULE_PIPELINE, ">=CREATED_TIME": sinceIso };
  if (until) filter["<CREATED_TIME"] = new Date(until).toISOString();
  const rows = [];
  let start = 0;
  do {
    const r = await bx.call("crm.stagehistory.list", {
      entityTypeId: 2, filter, order: { ID: "ASC" },
      select: ["OWNER_ID", "STAGE_ID", "CREATED_TIME"], start,
    });
    rows.push(...((r.result && r.result.items) || []));
    start = r.next;
    if (start) await sleep(pause);
  } while (start);
  const owners = [...new Set(rows.map((r) => String(r.OWNER_ID)))];
  const cmds = {};
  for (let i = 0; i < owners.length; i += 5) {
    const q = new URLSearchParams([["entityTypeId", "2"], ...owners.slice(i, i + 5).map((o) => ["filter[OWNER_ID][]", o]),
      ["filter[<CREATED_TIME]", sinceIso], ["order[ID]", "DESC"], ["select[]", "OWNER_ID"], ["select[]", "STAGE_ID"], ["select[]", "CREATED_TIME"]]);
    cmds["b" + i] = "crm.stagehistory.list?" + q.toString();
  }
  const before = [];
  let partial = false;
  if (owners.length) {
    const res = await bx.batch(cmds);
    if (res.errors > 0) partial = true; // createBitrix().batch reports errors as a count
    for (const v of Object.values(res.out || {})) {
      const items = (v && v.items) || [];
      if (items.length === 50) partial = true; // a full page may have more rows behind it
      before.push(...items);
    }
  }
  const all = [...before, ...rows];
  const stages = stageFlow(all, since, until || Infinity);
  // Per manager: the deal's current owner (stage history doesn't keep who owned it at the move). Owners and amounts
  // only for deals that touched a checked stage — site orders that go straight to «Оплачено» are left out
  const checked = new Set(STAGES.map((s) => s.id));
  const ruleDeals = [...new Set(all.filter((r) => checked.has(r.STAGE_ID)).map((r) => String(r.OWNER_ID)))];
  const deal = new Map();
  for (let i = 0; i < ruleDeals.length; i += 50) {
    const r = await bx.call("crm.deal.list", { filter: { ID: ruleDeals.slice(i, i + 50) }, select: ["ID", "ASSIGNED_BY_ID", "OPPORTUNITY"] });
    for (const d of Array.isArray(r.result) ? r.result : []) deal.set(String(d.ID), { owner: Number(d.ASSIGNED_BY_ID), amount: Number(d.OPPORTUNITY) || 0 });
    if (i + 50 < ruleDeals.length) await sleep(pause);
  }
  const paidSum = (ids) => ids.reduce((a, id) => a + ((deal.get(id) || {}).amount || 0), 0);
  const byOwner = new Map();
  for (const r of all) {
    const o = (deal.get(String(r.OWNER_ID)) || {}).owner;
    if (!o) continue;
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(r);
  }
  const byManager = {};
  for (const [o, rs] of byOwner) {
    const st = stageFlow(rs, since, until || Infinity);
    byManager[o] = { stages: st, paidSum: paidSum(st.paidIds) };
  }
  return { at: new Date(now).toISOString(), since: sinceIso, until: until ? new Date(until).toISOString() : null, stages, paidSum: paidSum(stages.paidIds), byManager, partial };
}

// Monday 00:00 MSK of the week `ms` falls in (MSK day 0 — 01.01.1970 — was a Thursday)
export const weekStartMsk = (ms) => { const d = mskDay(ms); return dayStart(d - ((d + 3) % 7)); };
const WEEKS_KEPT = 26;

// «Работа с воронкой» by calendar week (the user's decision 30.10.2026: accumulate from now on, no backfill): the
// current week is recounted at most every `maxAgeMs`; a finished week is counted once, whole, and kept in the snapshot.
// Only the week before the current one is fetched on its own, so a comparison exists from day one.
export async function collectFunnelWeeks(bx, now, prev, { maxAgeMs = 3600e3, pause = 600 } = {}) {
  const mon = weekStartMsk(now), monIso = new Date(mon).toISOString();
  const weeks = { ...((prev && prev.weeks) || {}) };
  let current = prev && prev.current && prev.current.since === monIso && now - Date.parse(prev.current.at) < maxAgeMs ? prev.current : null;
  if (!current) current = await collectStageFlow(bx, now, { since: mon, pause });
  const last = mon - 7 * DAY, lastIso = new Date(last).toISOString();
  // a kept week from before the per-manager split (no byManager) is counted again once
  if (!weeks[lastIso] || weeks[lastIso].partial || !weeks[lastIso].byManager) weeks[lastIso] = await collectStageFlow(bx, now, { since: last, until: mon, pause });
  for (const k of Object.keys(weeks).sort().slice(0, -WEEKS_KEPT)) delete weeks[k];
  return { current, weeks };
}

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
const ddmm = (ms) => new Date(ms + MSK).toISOString().slice(5, 10).split("-").reverse().join(".");
const days = (n) => n + " " + (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня" : "дней");

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
  const quiet = (n) => ![...attempts, ...replies].some((t) => now - t < n * DAY);
  const today = mskDay(now);
  const over = onStage > st.limitDays;
  const rules = [];
  const add = (code, level, text) => rules.push({ code, level, text });

  if (st.key === "need" || st.key === "product") {
    if (over) add("over", "c", `На этапе ${days(full)} из ${st.limitDays} — передвинуть${st.key === "need" ? " на «Выбран продукт»" : ""} или закрыть`);
    if (onStage >= st.limitDays && !lastReply) add("silent", "c", "Клиент молчит весь срок этапа — закрыть");
    const gap = st.key === "need" ? 5 : 7;
    const paused = st.key === "need" && d.nextContact && d.nextContact > now;
    if (onStage >= gap && !paused && quiet(gap)) {
      add("rhythm", "w", st.key === "need" ? "5 дней без попытки связаться" : "7 дней без попытки — узнать дату и способ оплаты");
    }
    if (st.key === "need" && d.nextContact && d.nextContact <= now && !attempts.some((t) => t >= d.nextContact)) {
      add("next", "w", `Следующий контакт был назначен на ${ddmm(d.nextContact)} — попытки не было`);
    }
    if (onStage >= 1 && !comments.length) add("comment", "w", "Нет комментария менеджера на этом этапе");
    if (st.key === "need" && !d.request) add("request", "w", "Не заполнен «Запрос клиента»");
    if (!d.test) add("test", "w", "Не заполнено «Какой тест планирует купить»");
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
    if (over) add("over", "c", `На этапе ${days(full)} из 5 — закрыть как «Нереализован» или перевести`);
    if (onStage >= st.limitDays && !lastReply) add("silent", "c", "Клиент не отвечает 5 дней — закрыть как «Нереализован»");
    if (d.worksToday && onStage >= 1 && !attemptDays.has(today) && !attemptDays.has(today - 1)) add("rhythm", "w", "Нужна попытка связаться сегодня");
    if (lastReply && !comments.some((t) => t > lastReply)) add("reason", "w", "Клиент ответил — зафиксируйте причину неоплаты в комментарии");
    if (lastReply && now - lastReply > DAY) add("move", "w", "Клиент ответил — перевести в «Готов оплачивать» с новой датой или в «Выбран продукт»");
  }
  rules.sort((a, b) => (a.level === b.level ? 0 : a.level === "c" ? -1 : 1));
  return { stage: st.key, daysOnStage: full, over, attempts: attemptDays.size, lastReply, rules };
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

// One chat → when a manager tried (human message, phone echo, mass template) and when the client wrote.
// Robot follow-ups, Suvvy, service notices and Wazzup notes are neither.
export function chatSignals(dialog, index, mass) {
  const isClient = new Map((dialog.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
  const human = [], client = [];
  for (const x of dialog.messages || []) {
    const text = String(x.text || "");
    if (!Number(x.author_id) || text.includes(WAZZUP_SYSTEM)) continue;
    const at = Date.parse(x.date);
    if (messageAuthor(x, isClient, index)) { human.push(at); continue; }
    if (!isClient.get(String(x.author_id)) || OUTGOING.test(text)) continue;
    const t = normText(text);
    if (SERVICE_TEXT.test(text) || ROBOT_TEXT.test(text)) continue;
    if (mass.has(t)) human.push(at);
    else client.push(at);
  }
  return { human: human.sort((a, b) => a - b), client: client.sort((a, b) => a - b) };
}

// Is today a working day of the owner: 5/2 — Mon–Fri in their time zone; 2/2 — any own action today
// (the same rule as alerts and «Неделя»); no schedule (the head) — Mon–Fri MSK
function worksToday(id, now, worked, schedules) {
  const s = schedules[id];
  if (s && !s.weekdays) return worked.has(id);
  const wd = new Date(now + (s ? s.tz : 3) * 3600e3).getUTCDay();
  return wd !== 0 && wd !== 6;
}

// All open deals → the snapshot's views.deals.rules
export function buildRules(deals, { now, flow = null, worked = new Set(), schedules = SCHEDULES }) {
  const stages = STAGES.map((s) => ({ key: s.key, name: s.name, limitDays: s.limitDays, byManager: {} }));
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const items = [];
  for (const d of deals) {
    const r = stageRules({ ...d, worksToday: worksToday(d.managerId, now, worked, schedules) }, now);
    if (!r) continue;
    const m = (byKey.get(r.stage).byManager[d.managerId] ||= { open: 0, sum: 0, over: 0 });
    m.open++;
    m.sum += d.amount;
    if (r.over) m.over++;
    if (r.rules.length) items.push({
      id: d.id, managerId: d.managerId, stage: r.stage, amount: d.amount, daysOnStage: r.daysOnStage, attempts: r.attempts,
      lastReply: r.lastReply ? new Date(r.lastReply).toISOString() : null, rules: r.rules,
    });
  }
  return { updatedAt: new Date(now).toISOString(), flow, stages, items };
}

// Stage history rows → per checked stage: deals that arrived since `since`, and where deals went when they left it
export function stageFlow(rows, since) {
  const idx = new Map(STAGES.map((s, i) => [s.id, i]));
  const out = Object.fromEntries(STAGES.map((s) => [s.key, { entered: 0, forward: 0, back: 0, closed: 0, paid: 0 }]));
  const byDeal = new Map();
  for (const r of rows) (byDeal.get(String(r.OWNER_ID)) || byDeal.set(String(r.OWNER_ID), []).get(String(r.OWNER_ID))).push({ stage: r.STAGE_ID, at: Date.parse(r.CREATED_TIME) });
  for (const hs of byDeal.values()) {
    hs.sort((a, b) => a.at - b.at);
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h.at < since) continue;
      const to = idx.get(h.stage);
      if (to !== undefined) out[STAGES[to].key].entered++;
      const prev = i ? hs[i - 1].stage : null;
      const from = idx.get(prev);
      if (from === undefined || prev === h.stage) continue;
      const f = out[STAGES[from].key];
      if (h.stage === WON) f.paid++;
      else if (CLOSED.has(h.stage)) f.closed++;
      else if (to !== undefined && to > from) f.forward++;
      else f.back++;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bitrix: stage moves of the last `days` days in «В2С Продажа» plus, for those deals, the last move before the window
// (where they came from). ~25 paged calls with a pause + ≤3 batches; the server runs it at most once an hour.
export async function collectStageFlow(bx, now, { days = 7, pause = 600 } = {}) {
  const since = now - days * DAY;
  const sinceIso = new Date(since).toISOString();
  const rows = [];
  let start = 0;
  do {
    const r = await bx.call("crm.stagehistory.list", {
      entityTypeId: 2, filter: { CATEGORY_ID: RULE_PIPELINE, ">=CREATED_TIME": sinceIso }, order: { ID: "ASC" },
      select: ["OWNER_ID", "STAGE_ID", "CREATED_TIME"], start,
    });
    rows.push(...((r.result && r.result.items) || []));
    start = r.next;
    if (start) await sleep(pause);
  } while (start);
  const owners = [...new Set(rows.map((r) => String(r.OWNER_ID)))];
  const cmds = {};
  for (let i = 0; i < owners.length; i += 10) {
    const q = new URLSearchParams([["entityTypeId", "2"], ...owners.slice(i, i + 10).map((o) => ["filter[OWNER_ID][]", o]),
      ["filter[<CREATED_TIME]", sinceIso], ["order[ID]", "DESC"], ["select[]", "OWNER_ID"], ["select[]", "STAGE_ID"], ["select[]", "CREATED_TIME"]]);
    cmds["b" + i] = "crm.stagehistory.list?" + q.toString();
  }
  const before = [];
  if (owners.length) for (const v of Object.values((await bx.batch(cmds)).out)) before.push(...((v && v.items) || []));
  return { at: new Date(now).toISOString(), since: sinceIso, stages: stageFlow([...before, ...rows], since) };
}

// faq626/stagerules.js
// «Сделки» → «Правила этапов»: «В2С Продажа» deals that break the stage rules (the user's rules, 29.10.2026).
// Pure rule logic (stagerules.test.js); collector.js feeds it with chats, calls and comments it already loads,
// collectStageFlow reads the 7-day stage flow from Bitrix.

import { SCHEDULES } from "./alerts.js";

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

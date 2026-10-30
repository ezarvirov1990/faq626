import { test } from "node:test";
import assert from "node:assert/strict";
import { stageRules, contactNote, payReason, STAGES, UPSELL_STAGES, UPSELL_PIPELINE, GENCONF_STAGES, GENCONF_PIPELINE, chatSignals, massTexts, buildRules, stageFlow, collectStageFlow, collectFunnelWeeks, weekStartMsk } from "./stagerules.js";
import { managerIndex } from "./activity.js";

const DAY = 864e5;
const now = Date.parse("2026-10-29T12:00:00+03:00");
const st = Object.fromEntries(STAGES.map((s) => [s.key, s.id]));
const deal = (o) => ({ amount: 27900, request: true, test: true, nextContact: null, payDate: null, attempts: [], replies: [], comments: [], worksToday: true, ...o });
const codes = (r) => r.rules.map((x) => x.code + ":" + x.level).sort();

test("last attempt: the latest one, even from before the stage; null when there was none", () => {
  const r = stageRules(deal({ stageId: st.need, movedAt: now - 3 * DAY, attempts: [now - 20 * DAY, now - 5 * DAY, now + DAY] }), now);
  assert.equal(r.attempts, 0);
  assert.equal(r.lastAttempt, now - 5 * DAY);
  assert.equal(stageRules(deal({ stageId: st.need, movedAt: now - 3 * DAY }), now).lastAttempt, null);
});

test("a fresh manager comment (contact outside Bitrix) turns «закрыть» into «перевести»; not an attempt", () => {
  // deal 907014: 15 days on «Дожимаем», the manager noted «договорились что оплатит сегодня завтра» 2 days ago
  const push = stageRules(deal({ stageId: st.push, movedAt: now - 15 * DAY, comments: [now - 2 * DAY], contactNotes: [now - 2 * DAY] }), now);
  assert.match(push.rules.find((r) => r.code === "over").text, /перевести в «Готов оплачивать»/);
  assert.doesNotMatch(push.rules.find((r) => r.code === "over").text, /закрыть/);
  assert.ok(!push.rules.some((r) => r.code === "silent"));
  assert.ok(push.rules.some((r) => r.code === "rhythm"));
  assert.equal(push.lastComment, now - 2 * DAY);
  const need = stageRules(deal({ stageId: st.need, movedAt: now - 20 * DAY, comments: [now - 3 * DAY], contactNotes: [now - 3 * DAY] }), now);
  assert.deepEqual(codes(need), ["noted:w", "over:c", "rhythm:w"]);
  // an old note (older than the stage limit) or a plain comment changes nothing
  const old = stageRules(deal({ stageId: st.push, movedAt: now - 15 * DAY, comments: [now - 10 * DAY], contactNotes: [now - 10 * DAY] }), now);
  assert.match(old.rules.find((r) => r.code === "over").text, /закрыть/);
  const plain = stageRules(deal({ stageId: st.need, movedAt: now - 20 * DAY, comments: [now - 3 * DAY] }), now);
  assert.ok(plain.rules.some((r) => r.code === "silent"));
});

test("contact notes: the manager says the client is in touch; «не отвечает» wins", () => {
  assert.equal(contactNote("договорились что оплатит сегодня завтра и сделаем 1 печатку в подарок"), true);
  assert.equal(contactNote("с личного ответила в среду после командировки будет удобно пообщаться"), true);
  assert.equal(contactNote("Клиент на связи в ватсапе"), true);
  assert.equal(contactNote("не отвечает, недозвон"), false);
  assert.equal(contactNote("написала, клиент не ответил"), false);
  assert.equal(contactNote("Интересует ДНК-диета, бюджет 30к"), false);
});

test("stages outside the rules are not checked", () => {
  assert.equal(stageRules(deal({ stageId: "C27:NEW", movedAt: now - 40 * DAY }), now), null);
});

test("Выявили потребность: over 15 days, client silent the whole stage — both red", () => {
  const r = stageRules(deal({ stageId: st.need, movedAt: now - 16 * DAY, attempts: [now - 2 * DAY], comments: [now - 10 * DAY] }), now);
  assert.deepEqual(codes(r), ["over:c", "silent:c"]);
  assert.equal(r.daysOnStage, 16);
  assert.equal(r.over, true);
});

test("Выявили потребность: no attempt and no reply for 5 days — amber, paused by a future next-contact date", () => {
  const base = { stageId: st.need, movedAt: now - 8 * DAY, attempts: [now - 7 * DAY], replies: [now - 6 * DAY], comments: [now - 7 * DAY] };
  assert.deepEqual(codes(stageRules(deal(base), now)), ["rhythm:w"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, nextContact: now + 2 * DAY }), now)), []);
});

test("Выявили потребность: next-contact date passed with no attempt since", () => {
  const r = stageRules(deal({ stageId: st.need, movedAt: now - 3 * DAY, nextContact: now - DAY, attempts: [now - 2 * DAY], comments: [now - 3 * DAY] }), now);
  assert.deepEqual(codes(r), ["next:w"]);
});

test("missing comment counts only after the first day on the stage; empty fields are flagged", () => {
  assert.deepEqual(codes(stageRules(deal({ stageId: st.need, movedAt: now - 3600e3 }), now)), []);
  const r = stageRules(deal({ stageId: st.need, movedAt: now - 2 * DAY, request: false, test: false, attempts: [now - DAY] }), now);
  assert.deepEqual(codes(r), ["comment:w", "request:w"]);
  const product = stageRules(deal({ stageId: st.product, movedAt: now - 2 * DAY, test: false, attempts: [now - DAY], comments: [now - DAY] }), now);
  assert.deepEqual(codes(product), ["test:w"]);
});

test("Выбран продукт: weekly rhythm, amount checks, 30-day limit", () => {
  const base = { stageId: st.product, comments: [now - DAY] };
  assert.deepEqual(codes(stageRules(deal({ ...base, movedAt: now - 9 * DAY, attempts: [now - 8 * DAY], replies: [now - 8 * DAY] }), now)), ["rhythm:w"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, movedAt: now - 3 * DAY, amount: 0, replies: [now - DAY] }), now)), ["amount:w"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, movedAt: now - 3 * DAY, amount: 498000, replies: [now - DAY] }), now)), ["bigamount:w"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, movedAt: now - 31 * DAY, attempts: [now - DAY], replies: [now - 20 * DAY] }), now)), ["over:c"]);
});

test("Готов оплачивать: empty or past payment date is red, no attempt on the payment day is amber", () => {
  assert.deepEqual(codes(stageRules(deal({ stageId: st.ready, movedAt: now - 3600e3 }), now)), ["paydate:c"]);
  const payDay = Date.parse("2026-10-27T00:00:00+03:00");
  const r = stageRules(deal({ stageId: st.ready, movedAt: now - 3 * DAY, payDate: payDay, comments: [now - 3 * DAY] }), now);
  assert.deepEqual(codes(r), ["over:c", "paydate:c", "payday:w"]);
  assert.match(r.rules.find((x) => x.code === "paydate").text, /27\.10/);
  const today = stageRules(deal({ stageId: st.ready, movedAt: now - DAY, payDate: Date.parse("2026-10-29T00:00:00+03:00"), comments: [now - DAY] }), now);
  assert.deepEqual(codes(today), []);
});

test("Дожимаем: daily attempts only on working days; a reply needs a reason comment and a move", () => {
  const base = { stageId: st.push, movedAt: now - 3 * DAY, attempts: [now - 3 * DAY], comments: [now - 3 * DAY] };
  assert.deepEqual(codes(stageRules(deal({ ...base, replies: [now - 3 * DAY + 3600e3] }), now)), ["move:w", "reason:w", "rhythm:w"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, replies: [now - 3 * DAY + 3600e3], worksToday: false }), now)), ["move:w", "reason:w"]);
  const silent = stageRules(deal({ ...base, movedAt: now - 6 * DAY, attempts: [now - 3600e3] }), now);
  assert.deepEqual(codes(silent), ["over:c", "silent:c"]);
});

test("every deal needs an open task; its date is the agreed contact day (pauses the rhythm, overdue without an attempt)", () => {
  // no open task — red, on every stage
  const none = stageRules(deal({ stageId: st.ready, movedAt: now - 3600e3, payDate: now, tasks: [] }), now);
  assert.deepEqual(codes(none), ["notask:c"]);
  // a future task pauses the weekly attempt on «Выбран продукт»
  const base = { stageId: st.product, movedAt: now - 9 * DAY, attempts: [now - 8 * DAY], replies: [now - 8 * DAY], comments: [now - DAY] };
  assert.deepEqual(codes(stageRules(deal({ ...base, tasks: [now + 3 * DAY] }), now)), []);
  // the task day passed with no attempt since that day began
  const due = stageRules(deal({ ...base, tasks: [now - 2 * DAY] }), now);
  assert.deepEqual(codes(due), ["rhythm:w", "taskdue:w"]);
  assert.match(due.rules.find((r) => r.code === "taskdue").text, /27\.10/);
  assert.equal(due.taskDue, now - 2 * DAY);
  // an attempt on or after the task day clears it; a task without a deadline is still a task
  assert.deepEqual(codes(stageRules(deal({ ...base, attempts: [now - DAY], tasks: [now - 2 * DAY] }), now)), []);
  assert.deepEqual(codes(stageRules(deal({ ...base, attempts: [now - DAY], tasks: [null] }), now)), []);
  // «Дожимаем» keeps its daily attempt even with a future task
  const push = stageRules(deal({ stageId: st.push, movedAt: now - 3 * DAY, attempts: [now - 3 * DAY], comments: [now - 3 * DAY], tasks: [now + DAY] }), now);
  assert.deepEqual(codes(push), ["rhythm:w"]);
});

test("Выбран продукт: the comment must say why the client won't pay now", () => {
  const base = { stageId: st.product, movedAt: now - 3 * DAY, attempts: [now - DAY], comments: [now - DAY] };
  assert.deepEqual(codes(stageRules(deal({ ...base, reasonNotes: [] }), now)), ["why:w"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, reasonNotes: [now - DAY] }), now)), []);
  // no comment at all — only the «no comment» rule
  assert.deepEqual(codes(stageRules(deal({ ...base, comments: [], reasonNotes: [] }), now)), ["comment:w"]);
  assert.equal(payReason("Ждёт зарплату 10.11, тогда оплатит"), true);
  assert.equal(payReason("хочет посоветоваться с мужем"), true);
  assert.equal(payReason("Связаться после отпуска"), true);
  assert.equal(payReason("ДНК-диета"), false);
  assert.equal(payReason("[DISK FILE ID=n2788540]"), false);
});

test("attempts are counted as distinct MSK days on the current stage; red rules come first", () => {
  const r = stageRules(deal({ stageId: st.need, movedAt: now - 16 * DAY, attempts: [now - 20 * DAY, now - 3 * DAY, now - 3 * DAY + 60e3, now - DAY] }), now);
  assert.equal(r.attempts, 2);
  assert.equal(r.rules[0].level, "c");
});

const index = managerIndex([{ id: 5, name: "Ольга Волокитина" }]);
const dlg = (messages) => ({ users: [{ id: 900, connector: true }, { id: 5 }, { id: 367846 }], messages });
const m = (id, author, text, time) => ({ id, author_id: author, text, date: `2026-10-28T${time}+03:00` });
const BLAST = "Отличные новости: с 20 по 28 октября дарим эксклюзивный ДНК-отчёт";

test("chat signals: manager, phone echo and our mass send are attempts; Suvvy, robots and Wazzup notes are not", () => {
  const d = dlg([
    m(1, 5, "Добрый день! Подобрала вам тест", "10:00:00"),
    m(2, 900, "=== Исходящее сообщение, автор: Битрикс24 (Ольга Волокитина) === Перезвоню", "11:00:00"),
    m(3, 900, BLAST, "12:00:00"),
    m(4, 5, "Очень жду ваш ответ :)", "13:00:00"),
    m(5, 367846, "Я Алина, специалист по подбору", "13:30:00"),
    m(6, 900, "Курьерская служба сообщила о получении вами комплекта", "14:00:00"),
    m(7, 900, "А сколько стоит Эксперт?", "15:00:00"),
    m(8, 900, "=== SYSTEM WZ === Сообщение не доставлено.", "16:00:00"),
  ]);
  const mass = massTexts([d, dlg([m(9, 900, BLAST, "09:00:00")]), dlg([m(10, 900, BLAST, "09:00:00")])]);
  const s = chatSignals(d, index, mass);
  assert.deepEqual(s.human, ["10:00", "11:00", "12:00"].map((t) => Date.parse(`2026-10-28T${t}:00+03:00`)));
  assert.deepEqual(s.client, ["14:00", "15:00"].map((t) => Date.parse(`2026-10-28T${t}:00+03:00`)));
});

test("buildRules: per-stage open / sum / over by manager, only deals with rules in items, worksToday from schedules", () => {
  const deals = [
    deal({ id: 1, managerId: 73919, stageId: st.need, movedAt: now - 16 * DAY }),
    deal({ id: 2, managerId: 73919, stageId: st.need, movedAt: now - 2 * DAY, attempts: [now - DAY], comments: [now - DAY] }),
    deal({ id: 3, managerId: 242224, stageId: st.push, movedAt: now - 2 * DAY, attempts: [now - 2 * DAY], comments: [now - 2 * DAY] }),
  ];
  // 29.10.2026 is a Thursday: the 5/2 manager works; the 2/2 manager (242224) works only if she acted today
  const R = buildRules(deals, { now, flow: null, worked: new Set() });
  const need = R.stages.find((s) => s.key === "need");
  assert.deepEqual(need.byManager[73919], { open: 2, sum: 55800, over: 1 });
  assert.deepEqual(R.items.map((x) => x.id), [1]);
  const R2 = buildRules(deals, { now, flow: null, worked: new Set([242224]) });
  assert.deepEqual(R2.items.map((x) => x.id), [1, 3]);
});

test("stageFlow: forward, back, closed and paid from the stage a deal left; entries counted on arrival", () => {
  const since = Date.parse("2026-10-22T00:00:00+03:00");
  const h = (deal, stage, day) => ({ OWNER_ID: deal, STAGE_ID: stage, CREATED_TIME: `2026-10-${day}T12:00:00+03:00` });
  const f = stageFlow([
    h(1, st.need, "10"), h(1, st.product, "23"), h(1, st.ready, "24"), h(1, "C27:WON", "25"),
    h(2, st.product, "15"), h(2, st.need, "26"),
    h(3, st.need, "23"), h(3, "C27:LOSE", "27"),
  ], since);
  assert.deepEqual(f.need, { entered: 2, forward: 1, back: 0, closed: 1, paid: 0 });
  assert.deepEqual(f.product, { entered: 1, forward: 1, back: 1, closed: 0, paid: 0 });
  assert.deepEqual(f.ready, { entered: 1, forward: 0, back: 0, closed: 0, paid: 1 });
});

test("pause and next-contact use MSK days: a contact planned for today pauses the rhythm and is not overdue", () => {
  const base = { stageId: st.need, movedAt: now - 8 * DAY, attempts: [now - 7 * DAY], replies: [now - 6 * DAY], comments: [now - 7 * DAY] };
  assert.deepEqual(codes(stageRules(deal({ ...base, nextContact: Date.parse("2026-10-29T09:00:00+03:00") }), now)), []);
  assert.deepEqual(codes(stageRules(deal({ ...base, nextContact: Date.parse("2026-10-29T18:00:00+03:00") }), now)), []);
});

test("a client text that Wazzup posted in 3+ chats is a manager attempt only in our voice", () => {
  const HELLO = "Хочу получить бесплатную консультацию. Мой промокод ABC123";
  const chats = [1, 2, 3].map(() => dlg([m(1, 900, HELLO, "10:00:00")]));
  const s = chatSignals(chats[0], index, massTexts(chats));
  assert.deepEqual(s.human, []);
  assert.deepEqual(s.client, []);
});

test("a single-chat client message is a reply even when it holds a service word", () => {
  const d = dlg([m(1, 900, "Какой набор лучше выбрать?", "10:00:00")]);
  assert.deepEqual(chatSignals(d, index, massTexts([d])).client, [Date.parse("2026-10-28T10:00:00+03:00")]);
});

test("Wazzup failure copy with a body is a manager attempt; empty bodies, edits and service bodies are not", () => {
  const d = dlg([
    m(1, 900, "Добрый день! Подобрала вам тест\n=== SYSTEM WZ === Сообщение не доставлено.", "10:00:00"),
    m(2, 900, "=== SYSTEM WZ === Сообщение не доставлено.", "11:00:00"),
    m(3, 900, "Вы ошиблись в тесте\n=== SYSTEM WZ === Сообщение изменено.", "12:00:00"),
    m(4, 900, "Курьерская служба сообщила о получении\n=== SYSTEM WZ === Сообщение не доставлено.", "13:00:00"),
    m(5, 900, "Очень жду ваш ответ\n=== SYSTEM WZ === Сообщение не доставлено.", "14:00:00"),
  ]);
  const s = chatSignals(d, index, new Set());
  assert.deepEqual(s.human, [Date.parse("2026-10-28T10:00:00+03:00")]);
  assert.deepEqual(s.client, []);
});

test("messages without a valid date are skipped", () => {
  const d = dlg([{ id: 1, author_id: 5, text: "Добрый день!", date: "не дата" }, { id: 2, author_id: 900, text: "Какой тест лучше?", date: "не дата" }]);
  assert.deepEqual(chatSignals(d, index, new Set()), { human: [], client: [], oldest: null, full: false });
});

test("Выявили потребность: a named contact time for today (or later) suppresses «silent»; a connected call is client contact", () => {
  const base = { stageId: st.need, movedAt: now - 16 * DAY, attempts: [now - 2 * DAY], comments: [now - 10 * DAY] };
  assert.deepEqual(codes(stageRules(deal({ ...base, replies: [now - 3 * DAY] }), now)), ["over:c"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, nextContact: Date.parse("2026-10-29T00:00:00+03:00") }), now)), ["over:c"]);
  assert.deepEqual(codes(stageRules(deal({ ...base, nextContact: now - 2 * DAY, attempts: [now - 2 * DAY + 3600e3] }), now)), ["over:c", "silent:c"]);
});

test("cut chat: never «silent», an amber «cut» note appears where silent would have fired", () => {
  const need = stageRules(deal({ stageId: st.need, movedAt: now - 16 * DAY, attempts: [now - 2 * DAY], comments: [now - 10 * DAY], cut: true }), now);
  assert.deepEqual(codes(need), ["cut:w", "over:c"]);
  const push = stageRules(deal({ stageId: st.push, movedAt: now - 6 * DAY, attempts: [now - 3600e3], comments: [now - 3 * DAY], cut: true }), now);
  assert.deepEqual(codes(push), ["cut:w", "over:c"]);
  const fresh = stageRules(deal({ stageId: st.need, movedAt: now - 3 * DAY, attempts: [now - DAY], comments: [now - DAY], cut: true }), now);
  assert.deepEqual(codes(fresh), []);
});

test("over means whole days above the limit, silent starts at the whole limit; items carry over", () => {
  const r = stageRules(deal({ stageId: st.need, movedAt: now - 15.5 * DAY, attempts: [now - DAY], comments: [now - 10 * DAY] }), now);
  assert.equal(r.over, false);
  assert.deepEqual(codes(r), ["silent:c"]);
  const R = buildRules([deal({ id: 1, managerId: 73919, stageId: st.need, movedAt: now - 16 * DAY })], { now, worked: new Set() });
  assert.equal(R.items[0].over, true);
});

test("chatSignals reports the oldest message and whether the dialog is a full 50-message page", () => {
  const msgs = Array.from({ length: 50 }, (_, i) => m(i + 1, 900, "Вопрос " + i, "10:00:00"));
  const s = chatSignals(dlg(msgs), index, new Set());
  assert.equal(s.full, true);
  assert.equal(s.oldest, Date.parse("2026-10-28T10:00:00+03:00"));
  assert.equal(chatSignals(dlg([]), index, new Set()).oldest, null);
});

test("buildRules: a deal without a numeric amount adds nothing to the sum", () => {
  const deals = [
    deal({ id: 1, managerId: 73919, stageId: st.need, movedAt: now - 2 * DAY, amount: 27900, attempts: [now - DAY], comments: [now - DAY] }),
    deal({ id: 2, managerId: 73919, stageId: st.need, movedAt: now - 2 * DAY, amount: undefined, attempts: [now - DAY], comments: [now - DAY] }),
  ];
  const R = buildRules(deals, { now, flow: null, worked: new Set() });
  assert.deepEqual(R.stages.find((s) => s.key === "need").byManager[73919], { open: 2, sum: 27900, over: 0 });
});

test("Дожимаем rhythm: the owner's previous working day — Friday for a Monday", () => {
  const monday = Date.parse("2026-11-02T12:00:00+03:00");
  const schedules = { 1: { tz: 3, weekdays: true } };
  const rhythmCount = (attempt) => {
    const deals = [deal({ id: 1, managerId: 1, stageId: st.push, movedAt: Date.parse("2026-10-27T12:00:00+03:00"), comments: [Date.parse("2026-10-27T12:00:00+03:00")], attempts: [attempt] })];
    const R = buildRules(deals, { now: monday, worked: new Set(), schedules });
    return R.items.flatMap((x) => x.rules).filter((x) => x.code === "rhythm").length;
  };
  assert.equal(rhythmCount(Date.parse("2026-10-30T12:00:00+03:00")), 0);
  assert.equal(rhythmCount(Date.parse("2026-10-29T12:00:00+03:00")), 1);
});

test("collectStageFlow: 5 owners per batch command; batch errors or a full 50-row command mark the flow partial", async () => {
  const owners = Array.from({ length: 12 }, (_, i) => 1000 + i);
  const rows = owners.map((o) => ({ OWNER_ID: o, STAGE_ID: st.need, CREATED_TIME: "2026-10-28T12:00:00+03:00" }));
  const fake = ({ errors = 0, fullCmd = null } = {}) => {
    const cmds = [];
    return {
      cmds,
      call: async () => ({ result: { items: rows } }),
      batch: async (c) => {
        cmds.push(c);
        const out = Object.fromEntries(Object.keys(c).map((k) => [k, { items: k === fullCmd ? Array.from({ length: 50 }, () => rows[0]) : [] }]));
        return { out, errors };
      },
    };
  };
  const clean = fake();
  const ok = await collectStageFlow(clean, now, { pause: 0 });
  assert.equal(ok.partial, false);
  assert.equal(clean.cmds.length, 1);
  const perCommand = Object.values(clean.cmds[0]).map((c) => (decodeURIComponent(c).match(/filter\[OWNER_ID\]\[\]=/g) || []).length);
  assert.deepEqual(perCommand, [5, 5, 2]);
  assert.equal((await collectStageFlow(fake({ errors: 1 }), now, { pause: 0 })).partial, true);
  assert.equal((await collectStageFlow(fake({ fullCmd: "b0" }), now, { pause: 0 })).partial, true);
});

test("weekStartMsk: Monday 00:00 MSK", () => {
  assert.equal(new Date(weekStartMsk(Date.parse("2026-10-30T12:00:00+03:00"))).toISOString(), "2026-10-25T21:00:00.000Z");
  assert.equal(new Date(weekStartMsk(Date.parse("2026-10-26T00:30:00+03:00"))).toISOString(), "2026-10-25T21:00:00.000Z");
  assert.equal(new Date(weekStartMsk(Date.parse("2026-11-01T23:59:00+03:00"))).toISOString(), "2026-10-25T21:00:00.000Z");
});

test("stageFlow: a week window [since, until) and the ids of paid deals", () => {
  const since = Date.parse("2026-10-19T00:00:00+03:00"), until = Date.parse("2026-10-26T00:00:00+03:00");
  const h = (deal, stage, day) => ({ OWNER_ID: deal, STAGE_ID: stage, CREATED_TIME: `2026-10-${day}T12:00:00+03:00` });
  const f = stageFlow([h(1, st.ready, "20"), h(1, "C27:WON", "21"), h(2, st.ready, "22"), h(2, "C27:WON", "27"), h(3, st.need, "27")], since, until);
  assert.equal(f.ready.entered, 2);
  assert.equal(f.ready.paid, 1);
  assert.equal(f.need.entered, 0);
  assert.deepEqual(f.paidIds, ["1"]);
});

test("collectFunnelWeeks: the current week hourly, a finished week once and kept; amounts of paid deals", async () => {
  const now = Date.parse("2026-11-03T12:00:00+03:00"); // Tuesday
  const calls = [];
  const bx = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "crm.deal.list") return { result: [{ ID: "7", ASSIGNED_BY_ID: "251414", OPPORTUNITY: "34010" }, { ID: "8", ASSIGNED_BY_ID: "91397", OPPORTUNITY: "0" }] };
      return { result: { items: [
        { OWNER_ID: 7, STAGE_ID: st.push, CREATED_TIME: "2026-10-28T12:00:00+03:00" }, { OWNER_ID: 7, STAGE_ID: "C27:WON", CREATED_TIME: "2026-10-29T12:00:00+03:00" },
        { OWNER_ID: 8, STAGE_ID: st.need, CREATED_TIME: "2026-10-27T12:00:00+03:00" }, { OWNER_ID: 8, STAGE_ID: "C27:LOSE", CREATED_TIME: "2026-10-30T12:00:00+03:00" },
        { OWNER_ID: 9, STAGE_ID: "C27:WON", CREATED_TIME: "2026-10-30T12:00:00+03:00" }, // a site order straight to «Оплачено»
      ] } };
    },
    batch: async () => ({ out: {}, errors: 0 }),
  };
  const r = await collectFunnelWeeks(bx, now, null, { pause: 0 });
  assert.equal(r.current.since, "2026-11-01T21:00:00.000Z");
  const last = r.weeks["2026-10-25T21:00:00.000Z"];
  assert.equal(last.stages.push.paid, 1);
  assert.equal(last.paidSum, 34010);
  // per manager — by the deal's current owner; the site order (no checked stage) isn't looked up
  assert.equal(last.byManager[251414].stages.push.paid, 1);
  assert.equal(last.byManager[251414].paidSum, 34010);
  assert.equal(last.byManager[91397].stages.need.closed, 1);
  assert.deepEqual(calls.find((c) => c.method === "crm.deal.list").params.filter.ID.sort(), ["7", "8"]);
  // an hour later: nothing is collected again; a week later the finished week is kept and the next one added
  const n = calls.length;
  await collectFunnelWeeks(bx, now + 30 * 60e3, r, { pause: 0 });
  assert.equal(calls.length, n);
  const next = await collectFunnelWeeks(bx, now + 7 * DAY, r, { pause: 0 });
  assert.deepEqual(Object.keys(next.weeks).sort(), ["2026-10-25T21:00:00.000Z", "2026-11-01T21:00:00.000Z"]);
});

test("stageFlow: a move from a checked stage to an earlier unchecked stage counts as back", () => {
  const since = Date.parse("2026-10-22T00:00:00+03:00");
  const h = (deal, stage, day) => ({ OWNER_ID: deal, STAGE_ID: stage, CREATED_TIME: `2026-10-${day}T12:00:00+03:00` });
  const f = stageFlow([h(4, st.need, "23"), h(4, "C27:UC_9AD24Z", "24")], since);
  assert.deepEqual(f.need, { entered: 1, forward: 0, back: 1, closed: 0, paid: 0 });
});

test("collectStageFlow: batch errors (a count) mark the flow partial; a clean batch does not", async () => {
  const fakeBx = (errors) => ({
    call: async () => ({ result: { items: [{ OWNER_ID: 1, STAGE_ID: st.product, CREATED_TIME: "2026-10-28T12:00:00+03:00" }] } }),
    batch: async () => ({
      out: { b0: { items: [{ OWNER_ID: 1, STAGE_ID: st.need, CREATED_TIME: "2026-10-20T12:00:00+03:00" }] } },
      errors,
    }),
  });
  const bad = await collectStageFlow(fakeBx(1), now, { pause: 0 });
  assert.equal(bad.partial, true);
  assert.equal(bad.stages.need.forward, 1);
  const clean = await collectStageFlow(fakeBx(0), now, { pause: 0 });
  assert.equal(clean.partial, false);
  assert.equal(clean.stages.need.forward, 1);
});

test("Дожимаем rhythm, 2/2 owner: yesterday counts, a Sunday attempt is the previous day", () => {
  const monday = Date.parse("2026-11-02T12:00:00+03:00");
  const schedules = { 242224: { tz: 3, weekdays: false } };
  const deals = [deal({ id: 3, managerId: 242224, stageId: st.push, movedAt: Date.parse("2026-10-27T12:00:00+03:00"), comments: [Date.parse("2026-10-27T12:00:00+03:00")], attempts: [Date.parse("2026-11-01T12:00:00+03:00")] })];
  const R = buildRules(deals, { now: monday, worked: new Set([242224]), schedules });
  assert.equal(R.items.flatMap((x) => x.rules).filter((x) => x.code === "rhythm").length, 0);
});

// «B2C Допродажа» (the user's rules 30.10.2026)
const up = Object.fromEntries(UPSELL_STAGES.map((s) => [s.key, s.id]));
const udeal = (o) => ({ nps: true, npsComment: true, payDate: null, attempts: [], replies: [], comments: [], ...o });

test("Допродажа: «Консультация проведена» and «Взят в работу» — 5 days, NPS fields from «Взят в работу» on", () => {
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.consult, movedAt: now - 3 * DAY, nps: false, npsComment: false }), now)), []);
  const c = stageRules(udeal({ stageId: up.consult, movedAt: now - 6 * DAY, nps: false }), now);
  assert.deepEqual(codes(c), ["over:c"]);
  assert.match(c.rules[0].text, /«Взят в работу»/);
  const w = stageRules(udeal({ stageId: up.work, movedAt: now - 7 * DAY, nps: false, npsComment: false }), now);
  assert.deepEqual(codes(w), ["nps:w", "npscomment:w", "over:c"]);
  assert.match(w.rules.find((r) => r.code === "over").text, /«Первая попытка допродать»/);
});

test("Допродажа: 3 attempts in 10 days (by days 1, 4, 7), a comment after each, the client's answer written down", () => {
  const at = (n) => now - n * DAY;
  // day 5 on the stage, one attempt (with a comment the same day) — the 2nd was due by day 4
  const r = stageRules(udeal({ stageId: up.up1, movedAt: at(5), attempts: [at(4)], comments: [at(4) + 3600e3] }), now);
  assert.deepEqual(codes(r), ["rhythm:w"]);
  assert.match(r.rules[0].text, /Попыток 1 из 3 — нужна попытка допродать/);
  // two attempts, the older one without a comment on that day or the next
  const bare = stageRules(udeal({ stageId: up.up2, movedAt: at(6), attempts: [at(5), at(2)], comments: [at(2)] }), now);
  assert.deepEqual(codes(bare), ["attcomment:w"]);
  // a comment the next day is fine; yesterday's attempt still has time today
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.up1, movedAt: at(3), attempts: [at(2)], comments: [at(1)] }), now)), []);
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.up1, movedAt: at(3), attempts: [at(1)] }), now)), []);
  // the client answered: no more chase, but the decision must be in a comment
  const ans = stageRules(udeal({ stageId: up.up1, movedAt: at(8), attempts: [at(7)], comments: [at(7)], replies: [at(3)] }), now);
  assert.deepEqual(codes(ans), ["reason:w"]);
  // the robot should have moved it after 10 days
  assert.match(stageRules(udeal({ stageId: up.up2, movedAt: at(12), attempts: [at(11), at(8), at(5)], comments: [at(11), at(8), at(5)] }), now).rules[0].text, /робот не передвинул/);
  // NPS is required on the upsell stages, not on reviews
  assert.ok(stageRules(udeal({ stageId: up.up1, movedAt: at(0.5), nps: false }), now).rules.some((x) => x.code === "nps"));
  assert.ok(!stageRules(udeal({ stageId: up.reviews, movedAt: at(0.5), nps: false }), now).rules.some((x) => x.code === "nps"));
});

test("Допродажа: «Отработаны» / «Первый недозвон» — silent 10 days is red «закрыть», a fresh note softens it", () => {
  const at = (n) => now - n * DAY;
  const s = stageRules(udeal({ stageId: up.reviews, movedAt: at(12), attempts: [at(11), at(8), at(5)], comments: [at(11), at(8), at(5)] }), now);
  assert.deepEqual(codes(s), ["over:c", "silent:c"]);
  const n = stageRules(udeal({ stageId: up.noanswer, movedAt: at(10), attempts: [at(9), at(6), at(3)], comments: [at(9), at(6), at(3), at(2)], contactNotes: [at(2)] }), now);
  assert.deepEqual(codes(n), ["noted:w"]);
  // the client wrote 4 days ago: not silent, over the limit — close by the outcome
  const r = stageRules(udeal({ stageId: up.reviews, movedAt: at(11), attempts: [at(10)], comments: [at(10), at(3)], replies: [at(4)] }), now);
  assert.deepEqual(codes(r), ["over:c"]);
  assert.match(r.rules[0].text, /закрыть сделку/);
});

test("Допродажа: «Готов покупать» — payment date set and not past, a task on that day, silent 10 days → close", () => {
  const at = (n) => now - n * DAY;
  const d = Date.parse("2026-11-04T00:00:00+03:00");
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.buy, movedAt: at(2), payDate: d, tasks: [d + 10 * 3600e3] }), now)), []);
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.buy, movedAt: at(2), payDate: d, tasks: [now + DAY] }), now)), ["paytask:w"]);
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.buy, movedAt: at(2), payDate: d, tasks: [] }), now)), ["notask:c"]);
  assert.deepEqual(codes(stageRules(udeal({ stageId: up.buy, movedAt: at(2), tasks: [now] }), now)), ["paydate:c"]);
  const past = stageRules(udeal({ stageId: up.buy, movedAt: at(12), payDate: at(3), tasks: [at(3)], replies: [at(11)] }), now);
  assert.deepEqual(codes(past), ["paydate:c", "silent:c"]);
});

test("buildRules for «B2C Допродажа»: its own stages, other pipelines' deals left out", () => {
  const R = buildRules([
    { id: 1, managerId: 307452, ...udeal({ stageId: up.work, movedAt: now - 7 * DAY }) },
    { id: 2, managerId: 307452, amount: 1000, ...deal({ stageId: st.need, movedAt: now - 20 * DAY }) },
  ], { now, pipeline: UPSELL_PIPELINE });
  assert.equal(R.pipeline, UPSELL_PIPELINE);
  assert.deepEqual(R.stages.map((s) => s.key), ["consult", "work", "up1", "up2", "buy", "reviews", "noanswer"]);
  assert.deepEqual(R.items.map((x) => x.id), [1]);
  assert.equal(R.stages[1].byManager[307452].over, 1);
});

// «ГенКонф2026» (the user's rules 30.10.2026)
const gc = Object.fromEntries(GENCONF_STAGES.map((s) => [s.key, s.id]));
const gdeal = (o) => ({ ticket: true, payDate: null, attempts: [], replies: [], comments: [], reasonNotes: [], ...o });

test("ГенКонф: «Новая заявка» — move at once; «Взят в работу» — 30 days, attempt twice a week, a comment, silent 10 days", () => {
  const at = (n) => now - n * DAY;
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gnew, movedAt: at(0.3) }), now)), []);
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gnew, movedAt: at(1.2) }), now)), ["over:c"]);
  // taken 2 days ago, nobody wrote or called, no comment
  const fresh = stageRules(gdeal({ stageId: gc.gwork, movedAt: at(2), replies: [at(1)] }), now);
  assert.deepEqual(codes(fresh), ["comment:w", "rhythm:w"]);
  assert.match(fresh.rules[0].text, /Не было попытки/);
  // attempts 3 days ago — fine; 5 days ago — due
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gwork, movedAt: at(8), attempts: [at(3)], replies: [at(3)], comments: [at(20)] }), now)), []);
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gwork, movedAt: at(8), attempts: [at(5)], replies: [at(5)], comments: [at(5)] }), now)), ["rhythm:w"]);
  // the client silent more than 10 days — close; over 30 days — move on
  const s = stageRules(gdeal({ stageId: gc.gwork, movedAt: at(31), attempts: [at(2)], replies: [at(15)], comments: [at(2)] }), now);
  assert.deepEqual(codes(s), ["over:c", "silent:c"]);
  assert.match(s.rules[0].text, /«Выбрал категорию билета»/);
});

test("ГенКонф: «Выбрал категорию билета» — ticket category and a reason comment; «Готов оплачивать» — payment date not past", () => {
  const at = (n) => now - n * DAY;
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gchoice, movedAt: at(3), comments: [at(40)], reasonNotes: [at(40)] }), now)), []);
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gchoice, movedAt: at(3), ticket: false }), now)), ["comment:w", "test:w"]);
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gchoice, movedAt: at(3), comments: [at(2)] }), now)), ["why:w"]);
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gready, movedAt: at(3) }), now)), ["paydate:c"]);
  assert.deepEqual(codes(stageRules(gdeal({ stageId: gc.gready, movedAt: at(3), payDate: now + DAY }), now)), []);
  assert.match(stageRules(gdeal({ stageId: gc.gready, movedAt: at(9), payDate: at(2) }), now).rules[0].text, /прошла/);
  const R = buildRules([{ id: 1, managerId: 105725, ...gdeal({ stageId: gc.gready, movedAt: at(3) }) }], { now, pipeline: GENCONF_PIPELINE });
  assert.deepEqual(R.stages.map((s) => s.key), ["gnew", "gwork", "gchoice", "gready"]);
  assert.deepEqual(R.items.map((x) => x.id), [1]);
});

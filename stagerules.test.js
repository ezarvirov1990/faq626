import { test } from "node:test";
import assert from "node:assert/strict";
import { stageRules, STAGES, chatSignals, massTexts, buildRules, stageFlow, collectStageFlow } from "./stagerules.js";
import { managerIndex } from "./activity.js";

const DAY = 864e5;
const now = Date.parse("2026-10-29T12:00:00+03:00");
const st = Object.fromEntries(STAGES.map((s) => [s.key, s.id]));
const deal = (o) => ({ amount: 27900, request: true, test: true, nextContact: null, payDate: null, attempts: [], replies: [], comments: [], worksToday: true, ...o });
const codes = (r) => r.rules.map((x) => x.code + ":" + x.level).sort();

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
  assert.deepEqual(chatSignals(d, index, new Set()), { human: [], client: [] });
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

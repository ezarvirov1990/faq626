import { test } from "node:test";
import assert from "node:assert/strict";
import { replyStats, workTime, shiftsOf } from "./replies.js";

const msk = (s) => Date.parse(s + "+03:00");
const MGR = 10, OTHER = 11, CLIENT = 900, SUVVY = 367846;
const schedules = { [MGR]: { tz: 3, from: 10, to: 19, weekdays: true }, [OTHER]: { tz: 3, from: 9, to: 21, weekdays: false } };
const managers = [{ id: MGR, name: "Анна Иванова" }, { id: OTHER, name: "Олег Петров" }];
const users = { [CLIENT]: { client: true }, [MGR]: { client: false }, [OTHER]: { client: false }, [SUVVY]: { client: false } };
let seq = 0;
const m = (at, a, text = "текст") => ({ id: ++seq, at: msk(at), a, text, file: false });
const run = (messages, { ents = { L1: { owner: MGR } }, calls = [], now = msk("2026-10-25T23:00:00") } = {}) =>
  replyStats({ from: "2026-10-19", now, chats: { 1: { ents: Object.keys(ents), users, messages } }, ents, calls, managers, schedules }).cells;

test("working time skips nights and weekends; the first working moment is where the clock starts", () => {
  const sh = shiftsOf({ tz: 3, from: 10, to: 19, weekdays: true }, new Set(["2026-10-23", "2026-10-24", "2026-10-26"]));
  assert.equal(sh.length, 2); // Saturday 24.10 dropped
  const w = workTime(sh, msk("2026-10-23T18:30:00"), msk("2026-10-26T10:15:00"));
  assert.equal(w.start, msk("2026-10-23T18:30:00"));
  assert.equal(w.ms, 45 * 60e3);
  assert.equal(workTime(sh, msk("2026-10-23T20:00:00"), msk("2026-10-26T09:00:00")).start, null);
});

test("a client series is one episode; the first human answer ends it; robots and «спасибо» don't count", () => {
  const c = run([
    m("2026-10-20T11:00:00", CLIENT, "Сколько стоит тест?"), m("2026-10-20T11:02:00", CLIENT, "И когда результат?"),
    m("2026-10-20T11:05:00", MGR, "Очень жду ваш ответ"), // robot template under the manager's name
    m("2026-10-20T11:20:00", MGR, "Здравствуйте! Стоимость…"),
    m("2026-10-20T11:30:00", CLIENT, "Спасибо!"),
  ]);
  assert.deepEqual(c[MGR]["2026-10-20"], { n: 1, waiting: 0, times: [20] });
});

test("a message at night starts the clock at the next shift; a connected call answers too", () => {
  const c = run([m("2026-10-20T10:00:00", MGR, "Добрый день"), m("2026-10-20T23:00:00", CLIENT, "Перезвоните мне"), m("2026-10-21T10:00:00", MGR, "работаю")],
    { calls: [{ at: msk("2026-10-21T10:40:00"), user: MGR, dur: 120, code: "200", key: "L1" }] });
  assert.deepEqual(c[MGR]["2026-10-20"], { n: 1, waiting: 0, times: [0] }); // the 10:00 message came before the call
  const c2 = run([m("2026-10-20T10:00:00", MGR, "Добрый день"), m("2026-10-20T23:00:00", CLIENT, "Перезвоните мне")],
    { calls: [{ at: msk("2026-10-21T10:40:00"), user: MGR, dur: 120, code: "200", key: "L1" }, { at: msk("2026-10-21T10:30:00"), user: MGR, dur: 0, code: "304", key: "L1" }] });
  assert.deepEqual(c2[MGR]["2026-10-20"].times, [40]);
});

test("still waiting counts as waiting; answered by a colleague before the owner's shift is not counted", () => {
  const c = run([m("2026-10-23T12:00:00", MGR, "Добрый день"), m("2026-10-23T18:00:00", CLIENT, "Хочу оплатить")]);
  assert.deepEqual(c[MGR]["2026-10-23"], { n: 1, waiting: 1, times: [] });
  const c2 = run([m("2026-10-23T12:00:00", MGR, "Добрый день"), m("2026-10-24T12:00:00", CLIENT, "Хочу оплатить"), m("2026-10-24T12:10:00", OTHER, "Подскажу")]);
  assert.equal((c2[MGR] || {})["2026-10-24"], undefined);
});

test("the deal's owner wins over the lead's; owners without a schedule are skipped", () => {
  const ents = { L1: { owner: OTHER }, D5: { owner: MGR } };
  const msgs = [m("2026-10-20T10:00:00", MGR, "Добрый день"), m("2026-10-20T12:00:00", CLIENT, "Вопрос по заказу"), m("2026-10-20T12:30:00", OTHER, "Отвечаю")];
  const c = run(msgs, { ents });
  assert.deepEqual(c[MGR]["2026-10-20"], { n: 1, waiting: 0, times: [30] });
  assert.deepEqual(run(msgs, { ents: { L1: { owner: SUVVY } } }), {});
});

test("episodes outside the week are left out", () => {
  const c = run([m("2026-10-16T10:00:00", MGR, "Добрый день"), m("2026-10-16T12:00:00", CLIENT, "Вопрос")]);
  assert.deepEqual(c, {});
});

test("the Suvvy bot answering takes the episode out; story mentions, echoes and mass sends don't open one", () => {
  const base = [m("2026-10-20T10:00:00", MGR, "Добрый день")];
  assert.deepEqual(run([...base, m("2026-10-20T11:00:00", CLIENT, "Сколько стоит?"), m("2026-10-20T11:01:00", SUVVY, "Эксперт стоит…")]), {});
  assert.deepEqual(run([...base, m("2026-10-20T11:00:00", CLIENT, "You mentioned in the story")]), {});
  const promo = "Отличные новости: с 20 по 28 октября дарим отчёт";
  assert.deepEqual(run([...base, m("2026-10-20T11:00:00", MGR, promo + "!"), m("2026-10-20T11:00:05", CLIENT, promo + "!")]), {});
  const ents = { L1: { owner: MGR } };
  const chats = Object.fromEntries([1, 2, 3].map((i) => [i, { ents: ["L1"], users, messages: [...base, m("2026-10-20T12:00:00", CLIENT, promo)] }]));
  assert.deepEqual(replyStats({ from: "2026-10-19", now: msk("2026-10-25T23:00:00"), chats, ents, calls: [], managers, schedules }).cells, {});
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { stageRules, STAGES } from "./stagerules.js";

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
  assert.deepEqual(codes(r), ["comment:w", "request:w", "test:w"]);
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

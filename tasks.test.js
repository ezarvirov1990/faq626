import { test } from "node:test";
import assert from "node:assert/strict";
import { mskDayStart, untouchedMoves, taskState } from "./tasks.js";

const t = (s) => Date.parse(s);

test("начало суток считается по Москве", () => {
  assert.equal(mskDayStart(t("2026-09-25T10:00:00+03:00")), t("2026-09-25T00:00:00+03:00"));
  assert.equal(mskDayStart(t("2026-09-25T00:30:00+03:00")), t("2026-09-25T00:00:00+03:00"));
  // 23:30 UTC — это уже следующие сутки по Москве
  assert.equal(mskDayStart(t("2026-09-24T23:30:00Z")), t("2026-09-25T00:00:00+03:00"));
});

const created = t("2026-09-20T10:00:00+03:00");
const move = (at) => ({ at: t(at), userId: 5, from: 0, to: 0 });

test("перенос без касаний в тот день — нарушение", () => {
  const res = untouchedMoves([move("2026-09-25T12:00:00+03:00")], [], created);
  assert.equal(res.length, 1);
  assert.equal(res[0].lastTouch, null);
});

test("касание в тот же день до переноса — не нарушение", () => {
  const res = untouchedMoves([move("2026-09-25T12:00:00+03:00")], [t("2026-09-25T09:15:00+03:00")], created);
  assert.equal(res.length, 0);
});

test("касание после переноса не спасает", () => {
  const res = untouchedMoves([move("2026-09-25T12:00:00+03:00")], [t("2026-09-25T12:05:00+03:00")], created);
  assert.equal(res.length, 1);
});

test("касание накануне не считается, но показывается как последнее", () => {
  const touch = t("2026-09-24T18:00:00+03:00");
  const res = untouchedMoves([move("2026-09-25T09:00:00+03:00")], [touch, t("2026-09-25T15:00:00+03:00")], created);
  assert.equal(res.length, 1);
  assert.equal(res[0].lastTouch, touch);
});

test("правка срока в первые 10 минут после создания — не перенос", () => {
  const c = t("2026-09-25T10:31:03+03:00");
  const res = untouchedMoves([move("2026-09-25T10:31:38+03:00"), move("2026-09-25T10:41:04+03:00")], [], c);
  assert.equal(res.length, 1);
  assert.equal(res[0].at, t("2026-09-25T10:41:04+03:00"));
});

test("каждый перенос проверяется отдельно", () => {
  const res = untouchedMoves(
    [move("2026-09-24T11:00:00+03:00"), move("2026-09-25T11:00:00+03:00")],
    [t("2026-09-24T10:00:00+03:00")],
    created,
  );
  assert.deepEqual(res.map((m) => m.at), [t("2026-09-25T11:00:00+03:00")]);
});

const now = t("2026-09-25T12:00:00+03:00");

test("нет открытых задач — без задачи", () => {
  assert.deepEqual(taskState([], now), { kind: "none" });
});

test("задача просрочена больше чем на 2 дня — просрочка по самой старой", () => {
  const s = taskState([
    { DEADLINE: "2026-09-20T10:00:00+03:00" },
    { DEADLINE: "2026-09-18T10:00:00+03:00" },
    { DEADLINE: "2026-09-26T10:00:00+03:00" },
  ], now);
  assert.deepEqual(s, { kind: "overdue", deadline: t("2026-09-18T10:00:00+03:00") });
});

test("просрочка меньше 2 дней и задачи без срока — всё в порядке", () => {
  assert.deepEqual(taskState([{ DEADLINE: "2026-09-24T10:00:00+03:00" }, { DEADLINE: "" }, {}], now), { kind: "ok" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftNow, decideAlerts, alertText, SILENCE_MS } from "./alerts.js";

const t = (s) => Date.parse(s);
const NSK = { tz: 7, from: 10, to: 19, weekdays: true };
const MSK22 = { tz: 3, from: 9, to: 21, weekdays: false };
const schedules = { 1: NSK, 2: MSK22 };
const managers = [{ id: 1, name: "Кристина Носкова" }, { id: 2, name: "Алсу Муртазина" }];
const ev = (managerId, at, kind = "call") => ({ managerId, at: t(at), kind });
const run = (now, events, extra = {}) => decideAlerts({ now: t(now), managers, events, schedules, messagesAt: t(now), ...extra });

test("смена по местному времени: НСК 10–19 = 06–15 МСК, выходные — нет", () => {
  assert.ok(shiftNow(NSK, t("2026-09-30T06:30:00+03:00")));
  assert.equal(shiftNow(NSK, t("2026-09-30T15:30:00+03:00")), null);
  assert.equal(shiftNow(NSK, t("2026-10-03T08:00:00+03:00")), null); // суббота
  assert.ok(shiftNow(MSK22, t("2026-10-03T12:00:00+03:00"))); // 2/2 — и в субботу
});

test("тишина 20 минут в смену — уведомление, повторно не шлём", () => {
  const r = run("2026-09-30T12:21:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")]);
  assert.deepEqual(r.send.filter((a) => a.manager.id === 2).map((a) => a.kind), ["silent"]);
  const again = run("2026-09-30T12:40:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")], { open: r.open });
  assert.equal(again.send.filter((a) => a.manager.id === 2).length, 0);
});

test("меньше 20 минут — рано", () => {
  const r = run("2026-09-30T12:15:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")]);
  assert.equal(r.send.filter((a) => a.manager.id === 2).length, 0);
});

test("пока сообщения не собраны заново — не уведомляем (могла быть переписка)", () => {
  const r = run("2026-09-30T12:25:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")], { messagesAt: t("2026-09-30T12:15:00+03:00") });
  assert.equal(r.send.filter((a) => a.manager.id === 2).length, 0);
});

test("после уведомления менеджер что-то сделал — «снова в работе» с паузой", () => {
  const first = run("2026-09-30T12:21:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")]);
  const r = run("2026-09-30T12:50:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00"), ev(2, "2026-09-30T12:47:00+03:00", "msg")], { open: first.open });
  const back = r.send.find((a) => a.kind === "back");
  assert.equal(back.pauseMs, 47 * 60e3);
  assert.equal(r.open[2], undefined);
});

test("2/2 без действий за день — не проверяем; 5/2 — «не начал работу» через 20 минут после начала смены", () => {
  const r = run("2026-09-30T06:21:00+03:00", []); // 10:21 в Новосибирске
  assert.deepEqual(r.send.map((a) => [a.kind, a.manager.id]), [["nostart", 1]]);
});

test("вне смены, в выходной и при отсутствии по графику — тишина", () => {
  assert.equal(run("2026-09-30T22:00:00+03:00", [ev(2, "2026-09-30T20:00:00+03:00")]).send.length, 0);
  assert.equal(run("2026-10-03T08:00:00+03:00", []).send.filter((a) => a.manager.id === 1).length, 0);
  assert.equal(run("2026-09-30T12:21:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")], { absent: { 2: true } }).send.filter((a) => a.manager.id === 2).length, 0);
});

test("конец смены закрывает простой без сообщений", () => {
  const first = run("2026-09-30T20:30:00+03:00", [ev(2, "2026-09-30T20:05:00+03:00")]);
  assert.equal(first.send.length, 1);
  const r = run("2026-09-30T21:10:00+03:00", [ev(2, "2026-09-30T20:05:00+03:00")], { open: first.open });
  assert.equal(r.send.length, 0);
  assert.equal(r.open[2], undefined);
});

test("текст уведомления", () => {
  const a = run("2026-09-30T12:21:00+03:00", [ev(2, "2026-09-30T12:00:00+03:00")]).send.find((x) => x.manager.id === 2);
  assert.match(alertText(a, { online: true }), /Алсу Муртазина.*20 минут.*12:00 МСК, 📞 звонок.*в сети/s);
  assert.ok(SILENCE_MS === 20 * 60e3);
});

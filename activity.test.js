import { test } from "node:test";
import assert from "node:assert/strict";
import { managerIndex, messageEvents, taskHistoryEvents, cardEvents, callEvent, commentEvents } from "./activity.js";

const t = (s) => Date.parse(s);
const since = t("2026-09-29T00:00:00+03:00");
const index = managerIndex([{ id: 5, name: "Алсу Муртазина" }, { id: 7, name: "Кристина Носкова" }]);
const ids = index.ids;
const dialog = (messages) => ({ users: [{ id: 900, connector: true }, { id: 5 }, { id: 42, bot: true }], messages });
const msg = (id, author, text, date = "2026-09-29T12:00:00+03:00") => ({ id, author_id: author, text, date });

test("сообщение менеджера клиенту — событие", () => {
  const ev = messageEvents(dialog([msg(1, 5, "Добрый день! Подобрала вам тест")]), index, since);
  assert.deepEqual(ev.map((e) => [e.managerId, e.kind]), [[5, "msg"]]);
});

test("клиент, бот, система и сообщения до начала суток — не события", () => {
  const ev = messageEvents(dialog([
    msg(1, 900, "Сколько стоит?"),
    msg(2, 42, "Я Алина, специалист по подбору"),
    msg(3, 0, "Начат новый диалог"),
    msg(4, 5, "Вчерашнее", "2026-09-28T23:59:00+03:00"),
  ]), index, since);
  assert.equal(ev.length, 0);
});

test("исходящее через Wazzup записывается на менеджера по имени, «Телефон» — ни на кого", () => {
  const ev = messageEvents(dialog([
    msg(1, 900, "=== Исходящее сообщение, автор: Битрикс24 (Кристина Носкова) ===\nДобрый день!"),
    msg(2, 900, "=== Исходящее сообщение, автор: Телефон ===\nДобрый день!"),
  ]), index, since);
  assert.deepEqual(ev.map((e) => e.managerId), [7]);
});

test("шаблонный дожим робота и служебные пометки Wazzup — не действие менеджера", () => {
  const ev = messageEvents(dialog([
    msg(1, 5, "Добрый день! Лаборатория генетики MyGenetics) Актуально ли для Вас получить информацию по ДНК тестам?"),
    msg(2, 5, "=== SYSTEM WZ === Сообщение не доставлено"),
  ]), index, since);
  assert.equal(ev.length, 0);
});

const h = (id, field, user, at, from, to) => ({ id, field, user: { id: String(user) }, createdDate: at, value: { from, to } });

test("задача: создал, закрыл, перенёс срок", () => {
  const ev = taskHistoryEvents(10, "CRM: Перезвонить", [
    h(1, "NEW", 5, "2026-09-29T10:00:00+03:00"),
    h(2, "DEADLINE", 5, "2026-09-29T11:00:00+03:00", "1759132800", "1759305600"),
    h(3, "STATUS", 5, "2026-09-29T12:00:00+03:00", "2", "5"),
  ], ids, since);
  assert.deepEqual(ev.map((e) => e.kind), ["task_new", "task_deadline", "task_done"]);
  assert.equal(ev[1].to, 1759305600 * 1000);
});

test("задачи роботов: создание и закрытие — не события, перенос срока — событие", () => {
  const ev = taskHistoryEvents(11, "Первые сутки. Связаться с клиентом", [
    h(1, "NEW", 5, "2026-09-29T10:00:00+03:00"),
    h(2, "DEADLINE", 5, "2026-09-29T10:03:00+03:00", "1", "2"),
    h(3, "STATUS", 5, "2026-09-29T13:26:28+03:00", "2", "5"),
    h(4, "DEADLINE", 5, "2026-09-29T15:00:00+03:00", "1", "2"),
  ], ids, since);
  assert.deepEqual(ev.map((e) => e.kind), ["task_deadline"]);
  assert.equal(ev[0].at, t("2026-09-29T15:00:00+03:00"));
});

test("upsell robot tasks: creating and closing are not events", () => {
  for (const title of ["Первая допродажа", "Вторая попытка допродать"]) {
    const ev = taskHistoryEvents(12, title, [
      h(1, "NEW", 5, "2026-09-30T09:06:50+03:00"),
      h(2, "STATUS", 5, "2026-09-30T10:51:54+03:00", "2", "5"),
    ], ids, since);
    assert.deepEqual(ev, [], title);
  }
});

test("в чате лида на автоматической стадии сообщения от имени менеджера — не события", () => {
  const d = dialog([msg(1, 5, "Здравствуйте! Подскажите, удобно созвониться?")]);
  assert.equal(messageEvents(d, index, since, true).length, 0);
  assert.equal(messageEvents(d, index, since, false).length, 1);
});

test("действия с задачей чужих сотрудников и вчерашние — не события", () => {
  const ev = taskHistoryEvents(12, "CRM: Перезвонить", [
    h(1, "STATUS", 77, "2026-09-29T12:00:00+03:00", "2", "5"),
    h(2, "STATUS", 5, "2026-09-28T12:00:00+03:00", "2", "5"),
  ], ids, since);
  assert.equal(ev.length, 0);
});

const moved = (stage) => ({ ID: "1", MOVED_TIME: "2026-09-29T12:00:00+03:00", MOVED_BY_ID: "5", STATUS_ID: stage, DATE_CREATE: "2026-09-28T10:00:00+03:00" });

test("стадия при создании (лид из Wazzup ночью на ответственного) — не событие", () => {
  const row = { ...moved("NEW"), MOVED_TIME: "2026-09-30T02:22:24+03:00", DATE_CREATE: "2026-09-30T02:22:24+03:00" };
  assert.equal(cardEvents("lead", row, ids, since, "Новый лид", "NEW").length, 0);
});

test("менеджер перевёл лид на «Недозвон вторые сутки» — событие", () => {
  assert.deepEqual(cardEvents("lead", moved("PROCESSED"), ids, since, "Недозвон вторые сутки", "PROCESSED").map((e) => [e.kind, e.stage]),
    [["move", "Недозвон вторые сутки"]]);
});

test("автоматические стадии и «Взят в работу» (назначение) — не события, даже если записаны на менеджера", () => {
  for (const s of ["1", "UC_8C77HR", "UC_33AW0X", "UC_5ZV4JA", "UC_ZIU6Y3", "UC_I6EXOS", "IN_PROCESS"]) {
    assert.equal(cardEvents("lead", moved(s), ids, since, "x", s).length, 0, s);
  }
});

test("стадию сменил робот — не событие; у сделок стадии не фильтруются", () => {
  assert.equal(cardEvents("deal", { ...moved("C27:NEW"), MOVED_BY_ID: "1" }, ids, since, "x", "C27:NEW").length, 0);
  assert.equal(cardEvents("deal", moved("C27:PREPARATION"), ids, since, "x", "C27:PREPARATION").length, 1);
});

test("звонки: исходящий — всегда, входящий — только если ответили", () => {
  const c = (type, code) => ({ CALL_ID: "c" + type + code, PORTAL_USER_ID: "5", CALL_TYPE: String(type), CALL_FAILED_CODE: code, CALL_DURATION: "240", CALL_START_DATE: "2026-09-29T12:00:00+03:00" });
  assert.equal(callEvent(c(1, "603")).ok, false);
  assert.equal(callEvent(c(2, "200")).seconds, 240);
  assert.equal(callEvent(c(2, "304")), null);
});

test("заметки в карточке — только менеджеров и за сегодня", () => {
  const ev = commentEvents("deal", [
    { ID: "1", AUTHOR_ID: "5", CREATED: "2026-09-29T12:00:00+03:00" },
    { ID: "2", AUTHOR_ID: "99", CREATED: "2026-09-29T12:00:00+03:00" },
    { ID: "3", AUTHOR_ID: "5", CREATED: "2026-09-28T12:00:00+03:00" },
  ], ids, since);
  assert.deepEqual(ev.map((e) => e.key), ["comment:1"]);
});

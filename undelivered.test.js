import { test } from "node:test";
import assert from "node:assert/strict";
import { failureReason, chatFailures, pickCard, introAuthor } from "./undelivered.js";

const since = Date.parse("2026-10-22T00:00:00+03:00");
const managers = new Set([5, 7]);
const dialog = (messages) => ({ users: [{ id: 900, connector: true }, { id: 5 }, { id: 7 }, { id: 367846, bot: true }], messages });
let n = 0;
const msg = (author, text, time = "12:00:00") => ({ id: ++n, author_id: author, text, date: `2026-10-22T${time}+03:00` });
const WZ = (body, reason) => body + "\n=== SYSTEM WZ === " + reason;

test("Wazzup reasons map to a hint; edits and deletions are not failures", () => {
  assert.match(failureReason(WZ("Привет", "24-часовая сессия истекла. Отправьте шаблон")).hint, /Прошли сутки/);
  assert.match(failureReason(WZ("Привет", "Сейчас этому клиенту нельзя отправить шаблон «Маркетинг» из-за лимитов")).hint, /Лимит шаблонов/);
  assert.match(failureReason(WZ("Привет", "Сообщение не отправлено из-за подозрения на спам.")).hint, /спам/);
  assert.equal(failureReason(WZ("Привет", "Неизвестная ошибка. Попробуйте позже")).hint, "Неизвестная ошибка. Попробуйте позже");
  assert.equal(failureReason(WZ("", "Сообщение изменено. Посмотрите в чатах Wazzup")), null);
  assert.equal(failureReason(WZ("", "Сообщение удалено. Посмотрите в чатах Wazzup")), null);
  assert.equal(failureReason("Обычное сообщение"), null);
});

test("a manager's message Wazzup could not deliver, nothing after it — listed", () => {
  const f = chatFailures(dialog([
    msg(900, "Сколько стоит тест?", "10:00:00"),
    msg(5, "Добрый день! Эксперт стоит 27 900 ₽", "11:00:00"),
    msg(900, WZ("Добрый день! Эксперт стоит 27 900 ₽", "24-часовая сессия истекла."), "11:00:05"),
  ]), managers, since);
  assert.equal(f.managerId, 5);
  assert.equal(f.count, 1);
  assert.match(f.hint, /Прошли сутки/);
  assert.equal(f.text, "Добрый день! Эксперт стоит 27 900 ₽");
});

test("resolved when a later message of ours got through or the client wrote", () => {
  const failed = [msg(5, "Напоминаю о тесте", "11:00:00"), msg(900, WZ("Напоминаю о тесте", "Сообщение не доставлено."), "11:00:04")];
  assert.equal(chatFailures(dialog([...failed, msg(7, "Позвонили вам, перезвоните", "12:00:00")]), managers, since), null);
  assert.equal(chatFailures(dialog([...failed, msg(900, "Да, интересно", "12:00:00")]), managers, since), null);
  // a phone echo of our outgoing message also reached the client
  assert.equal(chatFailures(dialog([...failed, msg(900, "=== Исходящее сообщение, автор: Битрикс24 (Алсу Муртазина) === Алло", "12:00:00")]), managers, since), null);
});

test("a second failed message does not resolve the first; the latest is shown with the count", () => {
  const f = chatFailures(dialog([
    msg(5, "Первое", "11:00:00"), msg(900, WZ("Первое", "Сообщение не доставлено."), "11:00:04"),
    msg(5, "Второе", "12:00:00"), msg(900, WZ("Второе", "Сообщение не доставлено."), "12:00:04"),
  ]), managers, since);
  assert.equal(f.count, 2);
  assert.equal(f.text, "Второе");
});

test("not a manager's message: automatic/mass sends without an original, Suvvy, robot follow-ups, yesterday", () => {
  assert.equal(chatFailures(dialog([msg(900, WZ("Ваш отчет готов!", "Сообщение не доставлено."))]), managers, since), null);
  assert.equal(chatFailures(dialog([msg(367846, "Подскажите задачу", "11:00:00"), msg(900, WZ("Подскажите задачу", "Сообщение не доставлено."), "11:00:03")]), managers, since), null);
  assert.equal(chatFailures(dialog([msg(5, "Здравствуйте! Мне важно получить хоть какой-то ответ", "11:00:00"),
    msg(900, WZ("Здравствуйте! Мне важно получить хоть какой-то ответ", "Сообщение не доставлено."), "11:00:03")]), managers, since), null);
  const y = { id: ++n, author_id: 5, text: "Вчера", date: "2026-10-21T18:00:00+03:00" };
  assert.equal(chatFailures(dialog([y, { id: ++n, author_id: 900, text: WZ("Вчера", "Сообщение не доставлено."), date: "2026-10-21T18:00:04+03:00" }]), managers, since), null);
});

test("BB-codes and spacing don't break matching the copy to the original", () => {
  const f = chatFailures(dialog([msg(5, "Ссылка [URL=https://x.ru]на оплату[/URL]  тут", "11:00:00"), msg(900, WZ("Ссылка на оплату тут", "Сообщение не доставлено."), "11:00:04")]), managers, since);
  assert.equal(f.managerId, 5);
});

test("a chat bound to several cards: the author's card, else the deal", () => {
  const lead = { entity: "lead", id: 1, managerId: 9 }, deal = { entity: "deal", id: 2, managerId: 8 }, own = { entity: "lead", id: 3, managerId: 5 };
  assert.equal(pickCard([lead, deal, own], 5).id, 3);
  assert.equal(pickCard([lead, deal], 5).id, 2);
  assert.equal(pickCard([lead], 5).id, 1);
});

test("sent from the Wazzup app (no Bitrix original): shown unless a mass send or a service notice; author by introduction", () => {
  const people = [{ id: 5, name: "Ольга Волокитина" }, { id: 7, name: "Мария Радченко" }, { id: 8, name: "Мария Василевская" }];
  const wz = { mass: new Set(), managers: people };
  const own = chatFailures(dialog([msg(900, WZ("Добрый день! Это Ольга из компании MyGenetics", "Сообщение не отправлено из-за подозрения на спам."), "11:00:00")]), managers, since, wz);
  assert.equal(own.managerId, 5);
  assert.equal(own.viaWazzup, true);
  const anon = chatFailures(dialog([msg(900, WZ("Добрый день! Направляю описание исследования", "Сообщение не доставлено."), "11:00:00")]), managers, since, wz);
  assert.equal(anon.managerId, null); // the card owner is picked later
  assert.equal(introAuthor("Это Мария из MyGenetics", people), null); // two Marias
  assert.equal(introAuthor("Добрый день! 🤍 Ольга, менеджер компании", people), 5);
  const blast = "Отличные новости: с 20 по 28 октября дарим отчёт";
  assert.equal(chatFailures(dialog([msg(900, WZ(blast, "Сообщение не доставлено."), "11:00:00")]), managers, since, { ...wz, mass: new Set([blast.toLowerCase().slice(0, 60)]) }), null);
  assert.equal(chatFailures(dialog([msg(900, WZ("Курьерская служба сообщила о получении", "Что-то не так с шаблоном."), "11:00:00")]), managers, since, wz), null);
  // without the wazzup option (old behaviour) such copies are ignored
  assert.equal(chatFailures(dialog([msg(900, WZ("Добрый день! Это Ольга", "Сообщение не доставлено."), "11:00:00")]), managers, since), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { holderEvent, serviceEpisodes, findPromise, promiseDue, promiseStatus, missedCases, teamShifts, SERVICE_TEAM, SUVVY_ID } from "./service.js";

const msk = (s) => Date.parse(s + "+03:00");
const MIN = 60e3;
const team = SERVICE_TEAM;
const ERM = 318154, BIR = 193818, BUR = 194956;
const U = (id, name) => `[USER=${id} REPLACE]${name}[/USER]`;

test("holderEvent: Bitrix system lines", () => {
  assert.deepEqual(holderEvent(`Обращение направлено на ${U(SUVVY_ID, "Suvvy")}`), { kind: "bot" });
  assert.deepEqual(holderEvent("Бот передал работу с диалогом оператору"), { kind: "queue" });
  assert.deepEqual(holderEvent(`Обращение перенаправлено на ${U(BIR, "Бирюкова")} по правилам очереди`), { kind: "to", user: BIR });
  assert.deepEqual(holderEvent(`${U(ERM, "Ермолова")} забрал диалог у ${U(SUVVY_ID, "Suvvy")}`), { kind: "to", user: ERM });
  assert.deepEqual(holderEvent(`${U(BIR, "Бирюкова")} переадресовала диалог на ${U(ERM, "Ермолова")}`), { kind: "to", user: ERM });
  assert.deepEqual(holderEvent(`${U(BIR, "Бирюкова")} начала работу с диалогом`), { kind: "to", user: BIR });
  assert.deepEqual(holderEvent(`К чату присоединился ${U(ERM, "Ермолова")}`), { kind: "to", user: ERM });
  assert.deepEqual(holderEvent("Диалог снят с оператора, так как оператор не начал или завершил рабочий день"), { kind: "queue" });
  assert.deepEqual(holderEvent(`${U(ERM, "Ермолова")} завершил работу с диалогом`), { kind: "closed", user: ERM });
  assert.deepEqual(holderEvent("Автоматическое завершение диалога"), { kind: "closed" });
  assert.equal(holderEvent("[b]Создан новый лид[/b]"), null);
});

// a 2/2 MSK shift 10–22 for Бирюкова and an NSK one for Ермолова on 02.11
const shifts = new Map([[BIR, [[msk("2026-11-02T10:00:00"), msk("2026-11-02T22:00:00")]]], [ERM, [[msk("2026-11-02T07:00:00"), msk("2026-11-02T19:00:00")], [msk("2026-11-03T07:00:00"), msk("2026-11-03T19:00:00")]]]]);
const chatOf = (rows) => ({
  id: 1, users: { 900: { client: true }, [SUVVY_ID]: { bot: true } },
  messages: rows.map(([t, a, text], i) => ({ id: i + 1, at: msk("2026-11-02T" + t), a, text })),
});

test("serviceEpisodes: Suvvy holds → the wait starts at the hand-off; Suvvy's answer doesn't end it", () => {
  const chat = chatOf([
    ["11:16:00", 0, `Обращение направлено на ${U(SUVVY_ID, "Suvvy")}`],
    ["11:17:00", 900, "Не выбирается город для вызова курьера"],
    ["11:17:30", SUVVY_ID, "Добрый день! Передаю вопрос"],
    ["11:20:00", 0, "Бот передал работу с диалогом оператору"],
    ["11:21:00", 0, `Обращение перенаправлено на ${U(ERM, "Ермолова")} по правилам очереди`],
    ["11:35:00", ERM, "Добрый день! Напишите код теста"],
  ]);
  const e = serviceEpisodes({ chat, team, shifts, now: msk("2026-11-02T20:00:00") });
  assert.deepEqual(e.map((x) => [x.holder, x.min]), [[ERM, 15]]);
});

test("serviceEpisodes: a bot-only chat isn't counted; queue at start goes to the next holder; a call answers", () => {
  const botOnly = chatOf([["08:37:00", 0, `Обращение направлено на ${U(SUVVY_ID, "Suvvy")}`], ["08:37:10", 900, "Подскажите сроки"], ["08:37:20", SUVVY_ID, "Пожалуйста!"]]);
  assert.equal(serviceEpisodes({ chat: botOnly, team, shifts, now: msk("2026-11-02T20:00:00") }).length, 0);
  const queued = chatOf([
    ["12:00:00", 0, "Начат новый диалог №1"],
    ["12:01:00", 900, "Когда будет готов отчёт?"],
    ["12:10:00", 0, `Обращение перенаправлено на ${U(BIR, "Бирюкова")} по правилам очереди`],
  ]);
  const e = serviceEpisodes({ chat: queued, team, shifts, talks: [msk("2026-11-02T12:41:00")], now: msk("2026-11-02T20:00:00") });
  assert.deepEqual(e.map((x) => [x.holder, x.min, x.reply === msk("2026-11-02T12:41:00")]), [[BIR, 40, true]]);
});

test("serviceEpisodes: a night message waits from the shift start; «спасибо» opens nothing; unanswered stays open", () => {
  const chat = chatOf([
    ["06:00:00", 0, `Обращение направлено на ${U(BIR, "Бирюкова")}`],
    ["06:01:00", 900, "Где мой курьер?"],
    ["10:20:00", BIR, "Добрый день, курьер будет сегодня"],
    ["10:21:00", 900, "Спасибо!"],
    ["15:00:00", 900, "Курьер не приехал"],
  ]);
  const e = serviceEpisodes({ chat, team, shifts, now: msk("2026-11-02T16:00:00") });
  assert.deepEqual(e.map((x) => [x.min, x.reply === null]), [[20, false], [60, true]]);
});

test("findPromise: words and due", () => {
  assert.deepEqual(findPromise("Перезвоню вам через 30 минут"), { due: "minutes", n: 30 });
  assert.deepEqual(findPromise("Уточню у лаборатории и вернусь с ответом"), { due: "shift" });
  assert.deepEqual(findPromise("Напишу вам завтра"), { due: "tomorrow" });
  assert.deepEqual(findPromise("Сообщим в пятницу"), { due: "weekday", day: 5 });
  assert.deepEqual(findPromise("Как только получу ответ, сразу напишу. Сегодня"), { due: "today" });
  assert.deepEqual(findPromise("Наберу через час"), { due: "minutes", n: 60 });
  assert.equal(findPromise("Напишите, пожалуйста, код теста"), null);
  assert.equal(findPromise("Позвоните нам на 8-800"), null);
});

test("promiseDue: by text, next shift for 5/2 and 2/2", () => {
  const at = msk("2026-11-06T15:00:00"); // Friday
  const s52 = { tz: 3, from: 9, to: 19, weekdays: true }, s22 = { tz: 3, from: 10, to: 22, weekdays: false };
  assert.equal(promiseDue({ due: "minutes", n: 30 }, at, s52), at + 30 * MIN);
  assert.equal(promiseDue({ due: "today" }, at, s52), msk("2026-11-06T19:00:00"));
  assert.equal(promiseDue({ due: "tomorrow" }, at, s52), msk("2026-11-07T19:00:00"));
  assert.equal(promiseDue({ due: "shift" }, at, s52), msk("2026-11-09T19:00:00")); // Monday
  assert.equal(promiseDue({ due: "shift" }, at, s22, ["2026-11-06", "2026-11-09"]), msk("2026-11-09T22:00:00"));
  assert.equal(promiseDue({ due: "shift" }, at, s22, ["2026-11-06"]), at + 4 * 864e5);
  // Novosibirsk 12–24: the end of the shift is local midnight
  assert.equal(promiseDue({ due: "today" }, at, { tz: 7, from: 12, to: 24, weekdays: false }), Date.parse("2026-11-07T00:00:00+07:00"));
});

test("promiseStatus: a message 2+ min later or a call fulfils", () => {
  const at = msk("2026-11-02T12:00:00"), due = msk("2026-11-02T19:00:00"), now = msk("2026-11-02T20:00:00");
  assert.equal(promiseStatus({ at, due, laterTeam: [at + MIN], now }).status, "missed");
  assert.equal(promiseStatus({ at, due, laterTeam: [at + 10 * MIN], now }).status, "done");
  assert.equal(promiseStatus({ at, due, teamCalls: [due + MIN], now }).status, "late");
  assert.equal(promiseStatus({ at, due, now: at + H() }).status, "pending");
});
function H() { return 3600e3; }

test("missedCases: one case per client until a call-back or a call that gets through", () => {
  const owners = { 11: { deal: 501, owner: BUR }, 12: { deal: 502, owner: BIR }, 13: { deal: 503, owner: BIR } };
  const sh = new Map([[BUR, [[msk("2026-11-02T09:00:00"), msk("2026-11-02T19:00:00")]]], [BIR, [[msk("2026-11-02T10:00:00"), msk("2026-11-02T22:00:00")]]]]);
  const incoming = [
    { at: msk("2026-11-02T10:00:00"), contact: 11, phone: "+7 900 000-00-11", ok: false },
    { at: msk("2026-11-02T10:05:00"), contact: 11, phone: "79000000011", ok: false },
    { at: msk("2026-11-02T11:00:00"), contact: 12, phone: "79000000012", ok: false },
    { at: msk("2026-11-02T11:30:00"), contact: 12, phone: "79000000012", ok: true },
    { at: msk("2026-11-02T12:00:00"), contact: 13, phone: "79000000013", ok: false },
    { at: msk("2026-11-02T12:00:00"), contact: 99, phone: "79000000099", ok: false }, // not a service client
  ];
  const outgoing = [{ at: msk("2026-11-02T10:40:00"), contact: null, phone: "89000000011" }];
  const c = missedCases({ incoming, outgoing, owners, shifts: sh, now: msk("2026-11-02T13:00:00") });
  assert.deepEqual(c.map((x) => [x.contact, x.calls, x.status, x.min]), [[11, 2, "callback", 40], [12, 1, "self", 30], [13, 1, "none", 60]]);
});

test("teamShifts: worked days from actions", () => {
  const { shifts: sh } = teamShifts(team, [{ user: ERM, at: msk("2026-11-02T08:00:00") }, { user: BIR, at: msk("2026-11-03T12:00:00") }]);
  assert.deepEqual(sh.get(ERM), [[msk("2026-11-02T07:00:00"), msk("2026-11-02T19:00:00")]]);
  assert.deepEqual(sh.get(BIR), [[msk("2026-11-03T10:00:00"), msk("2026-11-03T22:00:00")]]);
  assert.deepEqual(sh.get(BUR), []);
});

test("qs: operator keys are encoded so Bitrix keeps the condition", async () => {
  const { qs } = await import("./service.js");
  assert.equal(qs({ FILTER: { ">=CALL_START_DATE": "2026-11-02", PORTAL_USER_ID: [1, 2] } }), "FILTER[%3E%3DCALL_START_DATE]=2026-11-02&FILTER[PORTAL_USER_ID][]=1&FILTER[PORTAL_USER_ID][]=2");
});

test("serviceEpisodes: a team member closing the dialog ends the wait; a long Wazzup notice isn't a request", () => {
  const chat = chatOf([
    ["19:55:00", 0, `Обращение направлено на ${U(SUVVY_ID, "Suvvy")}`],
    ["19:55:10", 900, "Какие коды писать на конверте?"],
    ["19:56:00", SUVVY_ID, "На зелёном конверте укажите все коды"],
    ["20:16:00", 0, `${U(BIR, "Бирюкова")} начала работу с диалогом`],
    ["20:16:30", 0, `${U(BIR, "Бирюкова")} завершила работу с диалогом`],
    ["20:30:00", 900, "Ваш отчет готов! " + "x".repeat(500) + " === SYSTEM WZ === Сообщение не доставлено"],
  ]);
  const e = serviceEpisodes({ chat, team, shifts, now: msk("2026-11-02T21:00:00") });
  assert.deepEqual(e.map((x) => [x.holder, x.min]), [[BIR, 1]]);
});

test("serviceEpisodes: forwarded to another department or closed by a colleague ends the team's wait", () => {
  const chat = chatOf([
    ["13:41:00", 0, `Обращение направлено на ${U(SUVVY_ID, "Suvvy")}`],
    ["13:41:10", 900, "Хочу докупить тест для мужа"],
    ["13:41:20", 0, "Бот передал работу с диалогом оператору"],
    ["13:41:30", 0, `Обращение перенаправлено на ${U(BIR, "Бирюкова")} по правилам очереди`],
    ["13:43:30", 0, `${U(BIR, "Бирюкова")} переадресовала диалог на ${U(105725, "Кремлева")}`],
    ["16:44:00", 0, `${U(105725, "Кремлева")} завершила работу с диалогом`],
  ]);
  const e = serviceEpisodes({ chat, team, shifts, now: msk("2026-11-02T21:00:00") });
  assert.deepEqual(e.map((x) => [x.holder, x.min]), [[BIR, 2]]);
});

test("serviceEpisodes: a chat on someone outside the team waits for the team only from the forward (lead 642448)", () => {
  const chat = chatOf([
    ["16:05:00", 0, `Обращение направлено на ${U(77, "Самусевич")} (ответственного в CRM)`],
    ["16:05:30", 900, "Пришлите, пожалуйста, расшифровку по второму тесту"],
    ["21:40:00", 0, `${U(77, "Самусевич")} переадресовал диалог на ${U(BIR, "Бирюкова")}`],
    ["21:50:00", BIR, "Добрый вечер! Запросили у генетиков"],
  ]);
  const e = serviceEpisodes({ chat, team, shifts, now: msk("2026-11-02T22:00:00") });
  assert.deepEqual(e.map((x) => [x.holder, x.min]), [[BIR, 10]]);
});

test("missedCases: a call-back by a colleague outside the team counts and names who called (deal 852320)", () => {
  const owners = { 21: { deal: 852320, owner: BUR } };
  const sh = new Map([[BUR, [[msk("2026-11-02T09:00:00"), msk("2026-11-02T19:00:00")]]]]);
  const c = missedCases({
    incoming: [{ at: msk("2026-11-02T13:49:00"), contact: 21, phone: "79000000021", ok: false, user: 333210 }],
    outgoing: [{ at: msk("2026-11-02T13:49:40"), contact: 21, phone: "79000000021", user: 333210 }],
    owners, shifts: sh, now: msk("2026-11-02T18:00:00"),
  });
  assert.deepEqual(c.map((x) => [x.status, x.by, x.min]), [["callback", 333210, 1]]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { formatText, mskTime, leadsNeedingHints, chatLines, parseHints, batches, leadFacts } from "./hints-auto.js";

test("facts: who wrote last, waiting client, unanswered messages, last call", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const dialog = (msgs) => ({ users: [{ id: 9, connector: true }, { id: 5 }], messages: msgs });
  const waiting = leadFacts([dialog([
    { author_id: 5, date: "2026-09-28T10:00:00Z", text: "Добрый день" },
    { author_id: 9, date: "2026-09-30T08:20:00Z", text: "Сколько стоит?" },
    { author_id: 9, date: "2026-09-30T09:00:00Z", text: "=== SYSTEM WZ === удалено" },
  ])], [], now);
  assert.ok(waiting.some((f) => f.includes("клиент ждёт ответа с 30.09.26 11:20")));
  assert.ok(waiting.includes("Звонков не было."));
  const silent = leadFacts([dialog([
    { author_id: 9, date: "2026-09-27T09:00:00Z", text: "Изучу" },
    { author_id: 5, date: "2026-09-27T16:00:00Z", text: "Напоминаю" },
    { author_id: 9, date: "2026-09-28T09:00:00Z", text: "=== Исходящее сообщение, автор: Битрикс24 (Анна) === акция" },
  ])], [{ CALL_START_DATE: "2026-09-28T10:00:00+03:00", CALL_DURATION: "27" }, {}], now);
  assert.ok(silent.some((f) => f.includes("Последними писали МЫ; наших сообщений после последнего ответа клиента: 2")));
  assert.ok(silent.some((f) => f.includes("разговор 27 с; всего звонков: 2")));
  assert.deepEqual(leadFacts([], [], now), ["Переписки нет.", "Звонков не было."]);
});
import { createGigaChat } from "./gigachat.js";

test("leads go to the model in batches", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
});

test("GigaChat: one OAuth token is reused, the answer text and usage come back", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, body: opts.body });
    const body = url.includes("/oauth")
      ? { access_token: "tok", expires_at: Date.now() + 30 * 60e3 }
      : { choices: [{ message: { content: '{"1":{}}' } }], usage: { total_tokens: 42 } };
    return { ok: true, status: 200, json: async () => body };
  };
  const g = createGigaChat({ authKey: "KEY", scope: "GIGACHAT_API_CORP", fetchImpl });
  const a = await g.complete("привет");
  await g.complete("ещё");
  assert.equal(a.text, '{"1":{}}');
  assert.equal(a.usage.total_tokens, 42);
  assert.equal(calls.filter((c) => c.url.includes("/oauth")).length, 1);
  assert.equal(calls[0].auth, "Basic KEY");
  assert.equal(calls[0].body, "scope=GIGACHAT_API_CORP");
  assert.equal(calls[1].auth, "Bearer tok");
});

test("bb-codes and html are stripped, blank lines collapsed", () => {
  assert.equal(formatText("[b]Привет[/b]<br>  мир\n\n\n  ок"), "Привет мир\nок");
});

test("time is shown in Moscow", () => {
  assert.equal(mskTime(Date.parse("2026-09-30T10:05:00Z")), "30.09.26 13:05");
});

test("leads without a hint or with a stale one need a hint, up to the limit", () => {
  const snapshot = { views: { leads: { items: [
    { id: 1, lastActivity: "2026-09-30T10:00:00Z" },
    { id: 2, lastActivity: "2026-09-30T10:00:00Z" },
    { id: 3, lastActivity: "2026-09-30T12:00:00Z" },
    { id: 4, lastActivity: null },
  ] } } };
  const hints = { 2: { at: "2026-09-30T11:00:00Z" }, 3: { at: "2026-09-30T11:00:00Z" } };
  assert.deepEqual(leadsNeedingHints(snapshot, hints, 10), [1, 3, 4]);
  assert.deepEqual(leadsNeedingHints(snapshot, hints, 2), [1, 3]);
});

test("chat roles: client, our Wazzup outgoing, Wazzup service notes", () => {
  const lines = chatLines({
    users: [{ id: 9, connector: true, name: "Клиент Ольга" }, { id: 5, name: "Анна" }],
    messages: [
      { id: 3, author_id: 9, date: "2026-09-30T10:02:00Z", text: "=== SYSTEM WZ === Сообщение не доставлено" },
      { id: 1, author_id: 9, date: "2026-09-30T10:00:00Z", text: "Сколько стоит?" },
      { id: 2, author_id: 9, date: "2026-09-30T10:01:00Z", text: "=== Исходящее сообщение, автор: Битрикс24 (Анна) === 26 505 ₽" },
      { id: 4, author_id: 0, date: "2026-09-30T10:03:00Z", text: "Диалог завершён" },
    ],
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Клиент: Сколько стоит\?/);
  assert.match(lines[1], /Мы \(Клиент Ольга\):/);
  assert.match(lines[2], /\[служебное Wazzup\] Сообщение не доставлено/);
});

test("Claude's answer: only requested leads with all fields, long text trimmed", () => {
  const text = "Вот JSON:\n" + JSON.stringify({
    11: { request: "a", outcome: "b", next: "c" },
    12: { request: "a", outcome: "", next: "c" },
    99: { request: "a", outcome: "b", next: "c" },
    13: { request: "x".repeat(500), outcome: "b", next: "c" },
  });
  const h = parseHints(text, [11, 12, 13]);
  assert.deepEqual(Object.keys(h).sort(), ["11", "13"]);
  assert.equal(h[13].request.length, 400);
  assert.throws(() => parseHints("нет json", [1]));
});

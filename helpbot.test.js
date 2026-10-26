import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, parseAnswer, newQuestions, historyText, answersSurvey, ESCALATE } from "./helpbot.js";

const BOT = "bot1";
const post = (id, user, at, message, type = "") => ({ id, user_id: user, create_at: at, message, type });

test("only the manager's new posts after the cursor are questions, oldest first; system posts skipped", () => {
  const posts = [post("a", "u1", 100, "старый вопрос"), post("b", BOT, 150, "ответ"), post("d", "u1", 300, "и ещё"),
    post("c", "u1", 200, "Почему сделка в списке?"), post("e", "u1", 250, "", ""), post("f", "u1", 260, "joined", "system_join_channel")];
  assert.deepEqual(newQuestions(posts, BOT, 150).map((p) => p.id), ["c", "d"]);
});

test("an escalation marker anywhere wins; a normal answer is passed through and capped", () => {
  assert.deepEqual(parseAnswer(`${ESCALATE}: когда оплатят премию`), { escalate: true, text: "когда оплатят премию" });
  assert.equal(parseAnswer(`Не знаю.\n${ESCALATE}: про график`).escalate, true);
  assert.deepEqual(parseAnswer("  «Не доставлено» — это…  "), { escalate: false, text: "«Не доставлено» — это…" });
  assert.equal(parseAnswer("я".repeat(5000)).text.length, 3501);
});

test("history: last 6 posts in order with roles", () => {
  const posts = Array.from({ length: 8 }, (_, i) => post("p" + i, i % 2 ? BOT : "u1", i, "m" + i));
  const h = historyText(posts, BOT, { u1: "Алина Юрганова" }).split("\n");
  assert.equal(h.length, 6);
  assert.equal(h[0], "Алина Юрганова: m2");
  assert.equal(h[5], "Бот: m7");
});

test("prompt carries the reference, the question, today and the escalation rule", () => {
  const p = buildPrompt("СПРАВКА-ТЕКСТ", "Бот: привет", "Что такое касание?", "23 октября 2026 г.");
  for (const s of ["СПРАВКА-ТЕКСТ", "Что такое касание?", "23 октября 2026 г.", ESCALATE + ":"]) assert.ok(p.includes(s), s);
});

test("a reply to the bot's own survey post is an answer, not a question", () => {
  const ask = { ...post("s", BOT, 100, "Напишите рабочий график"), props: { survey: "hours" } };
  const reply = [post("r", "u1", 200, "2/2, 9–21 по Москве")];
  assert.equal(answersSurvey([ask, ...reply], BOT, reply), true);
  const later = [post("q", "u1", 400, "Что такое касание?")];
  assert.equal(answersSurvey([ask, ...reply, post("t", BOT, 300, "Спасибо, записал!"), ...later], BOT, later), false);
  assert.equal(answersSurvey(reply, BOT, reply), false);
});

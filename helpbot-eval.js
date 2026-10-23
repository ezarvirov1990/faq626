// Dry run of the help bot: sample questions → GigaChat answers on stdout, nothing is posted.
// Run on the server with the helpbot service's environment (see deploy/README.md).
import { readFile } from "node:fs/promises";
import { createGigaChat } from "./gigachat.js";
import { buildPrompt, parseAnswer } from "./helpbot.js";

const QUESTIONS = [
  "Почему у меня в Неделе качественных больше, чем я вижу в битриксе по дате создания?",
  "Что значит «Не доставлено» и что мне делать, если там написано 24-часовая сессия истекла?",
  "Я звонила клиенту с личного телефона, а сделка всё равно в списке без касаний. Почему?",
  "Когда мне выплатят премию за октябрь?",
  "Спасибо, всё отработала!",
  "Почему шаблон робота «Мне важно получить хоть какой-то ответ» не считается касанием в ленте?",
  "До какого числа акция и что в подарок?",
];
const giga = createGigaChat({ authKey: process.env.GIGACHAT_AUTH_KEY, scope: process.env.GIGACHAT_SCOPE });
const kb = await readFile(new URL("./helpbot-kb.md", import.meta.url), "utf8");
for (const q of QUESTIONS) {
  const r = await giga.complete(buildPrompt(kb, "", q, "23 октября 2026 г."), { model: process.env.HELPBOT_MODEL || "GigaChat-2-Max" });
  const a = parseAnswer(r.text);
  console.log(`\n### ${q}\n${a.escalate ? "[ПЕРЕДАТЬ] " : ""}${a.text}\n(tokens ${r.usage.total_tokens})`);
}

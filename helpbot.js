// Q&A in the @b2c-helper bot's direct messages: a manager asks how the dashboard or a bot list works,
// GigaChat answers from helpbot-kb.md only; anything the reference doesn't cover is forwarded to the head
// (HELPBOT_ESCALATE). Runs as its own service (deploy/faq626-helpbot.service), polls every HELPBOT_POLL_SECONDS.
// Env: MATTERMOST_URL, MATTERMOST_TOKEN, GIGACHAT_AUTH_KEY, GIGACHAT_SCOPE, HELPBOT_ESCALATE (comma-separated
// Mattermost user ids), HELPBOT_MODEL (GigaChat-2-Max), DATA_DIR (cursor file helpbot.json).
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGigaChat } from "./gigachat.js";

export const ESCALATE = "ПЕРЕДАТЬ";
const MAX_ANSWER = 3500;

export function buildPrompt(kb, history, question, today) {
  return `Ты — бот-помощник отдела продаж MyGenetics в Mattermost. Менеджеры спрашивают тебя, как работает дашборд «Без касаний B2C» и списки, которые присылает бот.
Отвечай ТОЛЬКО по справке ниже. Ничего не выдумывай: ни правил, ни цифр, ни акций, ни сроков.
Если в справке нет ответа на вопрос (или вопрос про конкретного клиента, лид, сделку, оплату, зарплату, график, что-то вне дашборда), ответь одной строкой: «${ESCALATE}: <вопрос коротко, своими словами>».
Если сообщение — не вопрос, а приветствие, «спасибо», «ок», «принято» или отчёт о сделанном («связалась», «отработала список»), ответь коротко и вежливо (например, «Спасибо, принято!»), без «${ESCALATE}».
Стиль: по-русски, на «вы», дружелюбно и коротко (2–6 предложений или короткий список), простыми словами, без технических терминов. Не здоровайся повторно, если в переписке уже здоровались.
Сегодня: ${today}.

=== СПРАВКА ===
${kb}
=== КОНЕЦ СПРАВКИ ===

Последние сообщения переписки (для контекста):
${history || "(нет)"}

Новый вопрос менеджера:
${question}`;
}

// The model's reply → {escalate, text}; escalation anywhere in the reply wins
export function parseAnswer(text) {
  const t = String(text || "").trim();
  const m = new RegExp(ESCALATE + "\\s*:?\\s*(.*)", "is").exec(t);
  if (m) return { escalate: true, text: m[1].split("\n")[0].trim() || t };
  return { escalate: false, text: t.length > MAX_ANSWER ? t.slice(0, MAX_ANSWER).trimEnd() + "…" : t };
}

// New questions per channel: user posts after the cursor, oldest first, merged into one question
export function newQuestions(posts, botId, cursor) {
  return posts
    .filter((p) => p.user_id !== botId && !p.type && p.create_at > cursor && String(p.message || "").trim())
    .sort((a, b) => a.create_at - b.create_at);
}

// The bot asked the manager something itself (post props.survey, e.g. working hours) and this is the answer:
// it is data for us, not a question for GigaChat — thank them and don't escalate
export const SURVEY_THANKS = "Спасибо, записал!";
export function answersSurvey(posts, botId, qs) {
  const first = Math.min(...qs.map((p) => p.create_at));
  const last = posts.filter((p) => p.user_id === botId && !p.type && p.create_at < first).sort((a, b) => b.create_at - a.create_at)[0];
  return Boolean(last && last.props && last.props.survey);
}

export function historyText(posts, botId, names = {}) {
  return posts.filter((p) => !p.type && String(p.message || "").trim()).sort((a, b) => a.create_at - b.create_at).slice(-6)
    .map((p) => (p.user_id === botId ? "Бот: " : (names[p.user_id] || "Менеджер") + ": ") + String(p.message).replace(/\s+/g, " ").slice(0, 600)).join("\n");
}

function createMm(url, token) {
  const base = url.replace(/\/+$/, "") + "/api/v4";
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30e3) });
    if (!r.ok) throw new Error(`Mattermost ${p}: HTTP ${r.status}`);
    return r.json();
  };
}

async function main() {
  const env = process.env;
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const mm = createMm(env.MATTERMOST_URL, env.MATTERMOST_TOKEN);
  const giga = createGigaChat({ authKey: env.GIGACHAT_AUTH_KEY, scope: env.GIGACHAT_SCOPE });
  const model = env.HELPBOT_MODEL || "GigaChat-2-Max";
  const escalateTo = String(env.HELPBOT_ESCALATE || "").split(",").map((s) => s.trim()).filter(Boolean);
  const kb = await readFile(new URL("./helpbot-kb.md", import.meta.url), "utf8");
  const stateFile = path.join(env.DATA_DIR || ".", "helpbot.json");
  let cursor;
  try { cursor = JSON.parse(await readFile(stateFile, "utf8")).cursor; } catch { cursor = Date.now(); } // first start: don't answer old messages
  const save = async () => { await mkdir(path.dirname(stateFile), { recursive: true }); await writeFile(stateFile + ".tmp", JSON.stringify({ cursor })); await rename(stateFile + ".tmp", stateFile); };
  await save();
  const me = await mm("GET", "/users/me");
  const names = {};
  const nameOf = async (id) => (names[id] ||= await mm("GET", `/users/${id}`).then((u) => `${u.first_name} ${u.last_name}`.trim() || u.username, () => "Менеджер"));
  const dmWith = async (userId) => (await mm("POST", "/channels/direct", [me.id, userId])).id;
  log(`helpbot started as @${me.username}, escalate to ${escalateTo.length} people, model ${model}`);

  const tick = async () => {
    const channels = (await mm("GET", `/users/${me.id}/channels?per_page=200`)).filter((c) => c.type === "D" && c.last_post_at > cursor);
    // the cursor moves to the newest post seen, so a question that arrives mid-tick is answered once
    let handled = 0, escalated = 0, next = Math.max(cursor, ...channels.map((c) => c.last_post_at));
    for (const c of channels) {
      const res = await mm("GET", `/channels/${c.id}/posts?per_page=30`);
      const posts = Object.values(res.posts || {});
      const qs = newQuestions(posts, me.id, cursor);
      if (!qs.length) continue;
      const asker = qs[0].user_id;
      const who = await nameOf(asker);
      const question = qs.map((p) => p.message.trim()).join("\n");
      const history = historyText(posts.filter((p) => !qs.includes(p)), me.id, { [asker]: who });
      next = Math.max(next, ...qs.map((p) => p.create_at));
      if (answersSurvey(posts, me.id, qs)) {
        await mm("POST", "/posts", { channel_id: c.id, message: SURVEY_THANKS });
        handled++;
        continue;
      }
      const today = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "Europe/Moscow" }).format(new Date());
      let ans;
      try { ans = parseAnswer((await giga.complete(buildPrompt(kb, history, question, today), { model })).text); }
      catch (e) { log("gigachat error:", e.message); ans = { escalate: true, text: question.slice(0, 300) }; }
      if (ans.escalate) {
        escalated++;
        await mm("POST", "/posts", { channel_id: c.id, message: "Не нашёл точного ответа в описании дашборда — передал вопрос руководителю, вам ответят." });
        for (const to of escalateTo) if (to !== asker)
          await mm("POST", "/posts", { channel_id: await dmWith(to), message: `❓ Вопрос боту от **${who}**, на который у бота нет ответа:\n\n> ${question.replace(/\n/g, "\n> ")}\n\nОтветьте, пожалуйста, ${who.split(" ")[0]} напрямую.` });
      } else {
        await mm("POST", "/posts", { channel_id: c.id, message: ans.text });
      }
      handled++;
    }
    cursor = next;
    await save();
    if (handled) log(`answered ${handled}, escalated ${escalated}`);
  };
  const every = Number(env.HELPBOT_POLL_SECONDS || 30) * 1e3;
  for (;;) {
    try { await tick(); } catch (e) { log("tick error:", e.message); }
    await new Promise((r) => setTimeout(r, every));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();

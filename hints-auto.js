// Hourly auto-hints on the server (faq626-hints.timer): leads of the «Лиды» tab without a fresh hint →
// context from Bitrix24 with facts computed here (who wrote last, waiting, calls) → GigaChat (Sber; Claude isn't
// available from Russia): draft with style examples, then a self-check pass → validated → POST /api/hints.
// No leads to hint — no model call. Context lives in memory only. Env: BITRIX_WEBHOOK, DASHBOARD_USER,
// DASHBOARD_PASSWORD, GIGACHAT_AUTH_KEY, GIGACHAT_SCOPE, HINTS_MAX (20), HINTS_BATCH (1 lead per request),
// HINTS_MODEL (GigaChat-2-Max), HINTS_VERIFY (on; "0" skips the check), HINTS_DRY_RUN=1 to skip the upload.
import { pathToFileURL } from "node:url";
import { createBitrix } from "./collector.js";
import { createGigaChat } from "./gigachat.js";
import { hintStale, HINT_MAX } from "./hints.js";

const REQUEST_FIELD = "UF_CRM_1738579732801"; // «Запрос клиента»
const MSK = 3 * 3600e3;
const OUTGOING = /^\s*=+\s*Исходящее сообщение/;
const WAZZUP_SYSTEM = "=== SYSTEM WZ ===";

export const PROMPT = `Ты помогаешь руководителю отдела продаж MyGenetics (ДНК-тесты). Ниже — выгрузка по лидам из Bitrix24: поля, заметки менеджеров, последний звонок, переписка (роли «Клиент» / «Мы»).
Для КАЖДОГО лида из выгрузки напиши подсказку менеджеру. Ответ — только JSON-объект, без пояснений и без markdown:
{"<ID лида>": {"request": "...", "outcome": "...", "next": "..."}}
- request — что хочет клиент (запрос, для кого, что важно);
- outcome — чем закончилось общение: последнее касание, ответил ли клиент, на чём остановились (с датами);
- next — конкретный следующий шаг менеджеру (что написать или сделать, в какой канал).
Правила: по-русски, каждое поле не длиннее 400 символов; только факты из выгрузки, ничего не выдумывать; если данных мало — так и написать («переписки нет, клиент не отвечал — позвонить»);
в next не называть по имени, кто должен сделать шаг: подсказку читает ответственный менеджер из поля «Менеджер» (в переписке могли писать другие сотрудники);
не писать телефоны, e-mail и адреса клиентов; никаких медицинских утверждений и диагнозов; служебные пометки Wazzup — это недоставка, а не ответ клиента.
Подробность: каждое поле — 2–3 полных предложения (150–350 символов) с датами, названиями тестов и суммами из выгрузки.
В outcome обязательно: кто написал последним (клиент или мы) и когда; если последним писал клиент — прямо написать «клиент ждёт ответа с <дата>».
Переписка может тянуться месяцами: не путай старые сообщения с последними, смотри на даты; сегодняшняя дата указана ниже.`;

// Two made-up hints in the wanted style (no real client data): the model copies length and detail
export const EXAMPLES = `Пример хорошего ответа (данные вымышлены):
{"100001": {"request": "Хочет понять причины усталости и набора веса; в анкете — «Похудение, Витамины». Предлагали Эксперт (27 900 ₽) и Веллнесс (19 900 ₽), спрашивала про рассрочку.", "outcome": "12.09 ответила «подумаю», после этого молчит. 14.09 и 17.09 мы писали напоминания без ответа, звонок 15.09 — не дозвонились. Последними писали мы, 2 сообщения без ответа.", "next": "Позвонить днём; если не ответит — одно короткое сообщение в WhatsApp: какой вариант ближе, Эксперт или Веллнесс, и предложить расчёт рассрочки на 3 или 6 месяцев."},
 "100002": {"request": "Спросила в Telegram стоимость теста для ребёнка 5 лет; для чего нужен тест — не уточнила.", "outcome": "Клиент написал 30.09 в 11:20, ответа от нас нет — клиент ждёт ответа с 30.09 11:20. Звонков не было.", "next": "Ответить в Telegram сегодня: назвать 1–2 подходящих детских теста с ценами и спросить, какая задача — питание, способности или здоровье."}}`;

// Prompt for a batch: rules, examples, today's date (models don't know it) and the lead ids
export function buildPrompt(ids, now = Date.now()) {
  return `${PROMPT}\n\n${EXAMPLES}\n\nСегодня: ${mskTime(now).slice(0, 8)} (по Москве).\nЛиды: ${ids.join(", ")}`;
}

// Second pass: check the draft against the data and drop anything that isn't there
export function verifyPrompt(draft) {
  return `Ниже — выгрузка по лидам и черновик подсказок к ним. Проверь КАЖДОЕ утверждение черновика по выгрузке и по блоку ФАКТЫ.
Если утверждения нет в выгрузке или оно противоречит ей (кто писал последним, даты, суммы, «передал данные», «согласился» и т. п.) — исправь или убери.
Сохрани подробность и формат. Ответ — только исправленный JSON в том же формате, без пояснений.
Черновик:
${draft}`;
}

export function formatText(s) {
  return String(s || "")
    .replace(/\[\/?[a-zA-Z]+[^\]]*\]/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/(\r?\n\s*)+/g, "\n").trim();
}

// dd.MM.yy HH:mm in Moscow time
export function mskTime(ms) {
  const d = new Date(ms + MSK).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)} ${d.slice(11, 16)}`;
}

// Leads of the tab with no hint or a stale one (activity after the hint)
export function leadsNeedingHints(snapshot, hints, max) {
  return ((snapshot && snapshot.views.leads && snapshot.views.leads.items) || [])
    .filter((x) => !hints[x.id] || hintStale(hints[x.id], x.lastActivity))
    .slice(0, max)
    .map((x) => x.id);
}

// Chat as lines «time role: text»; Wazzup outgoing marks count as ours, its service notes are shown as such
export function chatLines(dialog) {
  const users = new Map((dialog.users || []).map((u) => [String(u.id), u]));
  const out = [];
  for (const x of [...(dialog.messages || [])].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    if (Number(x.author_id) === 0) continue;
    let t = formatText(x.text);
    if (t.includes(WAZZUP_SYSTEM)) { out.push("  [служебное Wazzup] " + t.split(WAZZUP_SYSTEM).pop().trim().slice(0, 200)); continue; }
    const u = users.get(String(x.author_id)) || {};
    const who = u.connector && !OUTGOING.test(t) ? "Клиент" : `Мы (${u.name || "?"})`;
    if (!t && x.params && x.params.FILE_ID) t = "[файл]";
    out.push(`  ${mskTime(Date.parse(x.date))} ${who}: ${t}`);
  }
  return out;
}

// Facts the model tends to get wrong, computed here: who wrote last, is the client waiting,
// how many of our messages went unanswered, the last call. Same role rules as chatLines.
export function leadFacts(dialogs, calls, now = Date.now()) {
  let lastClient = 0, lastOurs = 0;
  const ours = [];
  for (const d of dialogs) {
    const users = new Map((d.users || []).map((u) => [String(u.id), u]));
    for (const x of d.messages || []) {
      const t = String(x.text || "");
      if (Number(x.author_id) === 0 || t.includes(WAZZUP_SYSTEM)) continue;
      const at = Date.parse(x.date);
      const u = users.get(String(x.author_id)) || {};
      if (u.connector && !OUTGOING.test(t)) lastClient = Math.max(lastClient, at);
      else { lastOurs = Math.max(lastOurs, at); ours.push(at); }
    }
  }
  const days = (ms) => Math.floor((now - ms) / 864e5);
  const out = [];
  if (!lastClient && !lastOurs) out.push("Переписки нет.");
  else {
    out.push(`Последнее сообщение клиента: ${lastClient ? `${mskTime(lastClient)} (${days(lastClient)} дн. назад)` : "клиент не писал"}.`);
    out.push(`Последнее наше сообщение: ${lastOurs ? `${mskTime(lastOurs)} (${days(lastOurs)} дн. назад)` : "мы не писали"}.`);
    if (lastClient > lastOurs) out.push(`Последним писал КЛИЕНТ — клиент ждёт ответа с ${mskTime(lastClient)}.`);
    else out.push(`Последними писали МЫ; наших сообщений после последнего ответа клиента: ${ours.filter((t) => t > lastClient).length}.`);
  }
  const c = calls[0];
  if (!c) out.push("Звонков не было.");
  else out.push(`Последний звонок: ${mskTime(Date.parse(c.CALL_START_DATE))}, ${Number(c.CALL_DURATION) > 0 ? `разговор ${c.CALL_DURATION} с` : "не дозвонились"}; всего звонков: ${calls.length}.`);
  return out;
}

// Parse Claude's answer: only requested leads, all three fields, trimmed to HINT_MAX
export function parseHints(text, ids) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in the answer");
  const raw = JSON.parse(m[0]);
  const want = new Set(ids.map(String));
  const out = {};
  for (const [id, h] of Object.entries(raw)) {
    if (!want.has(id) || !h || typeof h !== "object") continue;
    const c = {};
    for (const f of ["request", "outcome", "next"]) {
      let v = String(h[f] ?? "").trim();
      if (v.length > HINT_MAX) v = v.slice(0, HINT_MAX - 1) + "…";
      c[f] = v;
    }
    if (c.request && c.outcome && c.next) out[id] = c; // the server rejects a whole upload with an empty field
  }
  return out;
}

// Split ids into batches for the model: fewer leads per request — fewer mixed-up leads
export function batches(ids, size) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// Everything the hint needs, same as tools\hints.ps1 Export-LeadContext
export async function leadsContext(bx, ids, messagesPerChat = 40) {
  const fields = (await bx.call("crm.lead.fields")).result;
  const reqLabels = new Map(((fields[REQUEST_FIELD] || {}).items || []).map((i) => [String(i.ID), i.VALUE]));
  const stages = new Map((await bx.list("crm.status.list", { filter: { ENTITY_ID: "STATUS" } })).map((s) => [s.STATUS_ID, s.NAME]));
  const userNames = new Map();
  const userName = async (id) => {
    if (!userNames.has(String(id))) {
      const u = ((await bx.call("user.get", { ID: id })).result || [])[0] || {};
      userNames.set(String(id), `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim());
    }
    return userNames.get(String(id));
  };
  const parts = [];
  for (const id of ids) {
    const r = (await bx.batch({
      lead: `crm.lead.get?id=${id}`,
      comments: `crm.timeline.comment.list?filter[ENTITY_ID]=${id}&filter[ENTITY_TYPE]=lead&select[]=ID&select[]=CREATED&select[]=AUTHOR_ID&select[]=COMMENT`,
      calls: `voximplant.statistic.get?FILTER[CRM_ENTITY_TYPE]=LEAD&FILTER[CRM_ENTITY_ID]=${id}&SORT=CALL_START_DATE&ORDER=DESC`,
      chats: `imopenlines.crm.chat.get?CRM_ENTITY_TYPE=LEAD&CRM_ENTITY=${id}&ACTIVE_ONLY=N`,
    })).out;
    const l = r.lead;
    if (!l) continue;
    const lines = [`## Лид ${id} — ${l.TITLE || ""}`];
    const req = [].concat(l[REQUEST_FIELD] || []).filter(Boolean).map((v) => reqLabels.get(String(v))).filter(Boolean);
    lines.push(`Клиент: ${l.NAME || ""} ${l.LAST_NAME || ""} · Стадия: ${stages.get(l.STATUS_ID) || l.STATUS_ID} · Менеджер: ${await userName(l.ASSIGNED_BY_ID)} · Создан: ${l.DATE_CREATE}`);
    lines.push("Запрос клиента (поле): " + (req.length ? req.join(", ") : "не заполнено"));
    lines.push("Комментарий (поле): " + (formatText(l.COMMENTS) || "нет"));
    const comments = [...(r.comments || [])].sort((a, b) => Date.parse(a.CREATED) - Date.parse(b.CREATED));
    if (!comments.length) lines.push("Заметки в ленте: нет");
    else {
      lines.push("Заметки в ленте:");
      for (const c of comments) lines.push(`  ${mskTime(Date.parse(c.CREATED))} ${await userName(c.AUTHOR_ID)}: ${formatText(c.COMMENT)}`);
    }
    const calls = r.calls || [];
    if (!calls.length) lines.push("Звонков нет");
    else {
      const k = calls[0];
      const dir = String(k.CALL_TYPE) === "1" ? "исходящий" : String(k.CALL_TYPE) === "2" ? "входящий" : `тип ${k.CALL_TYPE}`;
      const res = Number(k.CALL_DURATION) > 0 ? `разговор ${k.CALL_DURATION} с` : `не дозвонились (код ${k.CALL_FAILED_CODE})`;
      lines.push(`Последний звонок: ${k.CALL_START_DATE}, ${dir}, ${res}. Всего звонков: ${calls.length}`);
    }
    const chats = (r.chats || []).filter((c) => c && c.CHAT_ID);
    if (!chats.length) lines.push("Чата нет");
    const msgs = chats.length ? (await bx.batch(Object.fromEntries(chats.map((c) => ["m" + c.CHAT_ID, `im.dialog.messages.get?DIALOG_ID=chat${c.CHAT_ID}&LIMIT=${messagesPerChat}`])))).out : {};
    // facts go right after the header, before the long chat
    lines.splice(2, 0, "ФАКТЫ (посчитаны программой, им доверять):", ...leadFacts(chats.map((c) => msgs["m" + c.CHAT_ID]).filter(Boolean), calls).map((f) => "  " + f));
    for (const c of chats) {
      lines.push(`Чат ${c.CHAT_ID} ${c.CONNECTOR_TITLE || ""} (последние ${messagesPerChat} сообщений):`);
      if (msgs["m" + c.CHAT_ID]) lines.push(...chatLines(msgs["m" + c.CHAT_ID]));
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

async function main() {
  const env = process.env;
  const base = env.HINTS_URL || `http://127.0.0.1:${env.PORT || 3000}`;
  const auth = "Basic " + Buffer.from(`${env.DASHBOARD_USER || "mygenetics"}:${env.DASHBOARD_PASSWORD}`).toString("base64");
  const started = Date.now();
  const snap = await (await fetch(base + "/api/snapshot", { headers: { authorization: auth } })).json();
  if (!snap.snapshot) { console.log("hints: dashboard has no snapshot yet"); return; }
  // HINTS_IDS=1,2,3 — hint these leads regardless of their state (for quality checks, with HINTS_DRY_RUN)
  const ids = env.HINTS_IDS ? env.HINTS_IDS.split(",").map(Number).filter(Boolean)
    : leadsNeedingHints(snap.snapshot, snap.hints || {}, Number(env.HINTS_MAX || 20));
  if (!ids.length) { console.log("hints: no leads need a hint"); return; }
  const bx = createBitrix(env.BITRIX_WEBHOOK);
  const giga = createGigaChat({ authKey: env.GIGACHAT_AUTH_KEY, scope: env.GIGACHAT_SCOPE });
  const hints = {};
  let tokens = 0, failed = 0;
  for (const part of batches(ids, Number(env.HINTS_BATCH || 1))) {
    try {
      const context = await leadsContext(bx, part);
      const model = env.HINTS_MODEL || "GigaChat-2-Max";
      const draft = await giga.complete(`${buildPrompt(part)}\n\n=== ВЫГРУЗКА ===\n${context}`, { model });
      tokens += Number(draft.usage.total_tokens) || 0;
      let text = draft.text;
      if (env.HINTS_VERIFY !== "0") {
        const checked = await giga.complete(`${verifyPrompt(text)}\n\n=== ВЫГРУЗКА ===\n${context}`, { model, temperature: 0.1 });
        tokens += Number(checked.usage.total_tokens) || 0;
        // keep the draft if the check broke the format
        try { if (Object.keys(parseHints(checked.text, part)).length) text = checked.text; } catch {}
      }
      Object.assign(hints, parseHints(text, part));
    } catch (e) {
      failed += part.length; // one bad batch doesn't stop the others
      console.error(`hints: batch ${part.join(",")} failed: ${e.message}`);
    }
  }
  const sec = Math.round((Date.now() - started) / 1000);
  const n = Object.keys(hints).length;
  if (env.HINTS_DRY_RUN) { console.log(`hints: dry run, ${n} of ${ids.length} ready in ${sec}s, ${tokens} tokens`); console.log(JSON.stringify(hints, null, 1)); return; }
  if (!n) { console.log(`hints: nothing to push (${failed} failed), ${tokens} tokens`); return; }
  const r = await fetch(base + "/api/hints", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(hints) });
  const res = await r.json();
  if (!res.ok) throw new Error("upload rejected: " + res.error);
  console.log(`hints: pushed ${n} of ${ids.length} in ${sec}s, ${tokens} tokens (server total ${res.total})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("hints error:", e.message); process.exit(1); });
}

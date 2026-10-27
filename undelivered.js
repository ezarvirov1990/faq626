// «Не доставлено»: today's manager messages in Open Lines chats that Wazzup could not deliver and
// nothing reached the client after them (no delivered message from us, no reply from the client).
// Wazzup reports a failure by posting a copy of our message under the client's chat user with
// «=== SYSTEM WZ === <reason>» appended, seconds after the manager's original. A copy without such an
// original in Bitrix was sent outside Bitrix: a manager writing from the Wazzup app, or an automatic / mass send
// (order notices, promo blasts). Since 27.10.2026 (user's request) the former are shown too: a copy counts as a
// manager's message unless its text went to MASS_CHATS+ chats today or looks like a service notice; the author is
// the manager who introduces themselves in the text («Это Ольга», «Марина, менеджер»), else the card's owner.
import { mskDayStart } from "./tasks.js";
import { ROBOT_TEXT } from "./activity.js";

const MARK = "=== SYSTEM WZ ===";
const OUTGOING = /^\s*=+\s*Исходящее сообщение, автор:/;
// Wazzup notes that are not a delivery failure
const NOT_FAILURE = /сообщение изменено|сообщение удалено|пропущенный звонок|пропущен звонок/i;
const TWIN_MS = 10 * 60e3;
const MASS_CHATS = 3;
// Service notices and reminders sent by automations through Wazzup
export const SERVICE_TEXT = /курьер|отч[её]т (готов|My)|генетический отч[её]т|записались на консультацию|трек[- ]?номер|ваш заказ|генетический материал|набор|Лаборатория MyGenetics|спасибо за вашу оценку|напоминаем|ГенКонф|купить нельзя/i;

// Wazzup reason → what the manager should do
const HINTS = [
  [/сессия истекла/i, "Прошли сутки с последнего сообщения клиента — отправьте шаблон или позвоните"],
  [/диалоговое окно закрыто/i, "Окно Instagram закрыто — написать можно, только когда клиент напишет сам; позвоните"],
  [/шаблон «?Маркетинг»?/i, "Лимит шаблонов «Маркетинг» — повторите завтра или позвоните"],
  [/не так с шаблоном/i, "Шаблон не принят — отправьте другим шаблоном или позвоните"],
  [/подозрения? на спам/i, "Wazzup принял за спам — позвоните или напишите позже другим текстом"],
  [/заблокировал/i, "Клиент заблокировал — только звонок"],
  [/не доставлено/i, "Не дошло: клиент давно не заходил или сменил номер — позвоните"],
  [/разрешения Wazzup|маршрутизац/i, "Ошибка настроек Wazzup — сообщите руководителю, клиенту позвоните"],
];

export function failureReason(text) {
  const i = String(text || "").indexOf(MARK);
  if (i < 0) return null;
  const reason = text.slice(i + MARK.length).replace(/\s+/g, " ").trim();
  if (NOT_FAILURE.test(reason)) return null;
  const hit = HINTS.find(([re]) => re.test(reason));
  return { reason: reason.split(/(?<=[.!])\s/)[0].slice(0, 160), hint: hit ? hit[1] : reason.slice(0, 160) };
}

const norm = (s) => String(s || "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
export const massKey = (body) => body.toLowerCase().slice(0, 60);

// The manager who introduces themselves in the text: «Это Ольга», «Меня зовут Юлия», «Марина, менеджер».
// Only a first name no other manager has; null when nobody or ambiguous.
export function introAuthor(text, managers) {
  const byFirst = new Map();
  for (const m of managers) {
    const first = String(m.name || "").split(" ")[0].toLowerCase().replace(/ё/g, "е");
    if (first) byFirst.set(first, byFirst.has(first) ? null : m.id);
  }
  const t = String(text || "").toLowerCase().replace(/ё/g, "е");
  const re = /(?:это|меня зовут)\s+([а-я]+)|([а-я]+),?\s+менеджер/g;
  for (let x; (x = re.exec(t));) { const id = byFirst.get(x[1] || x[2]); if (id) return id; }
  return null;
}

// Every Wazzup failure copy in a chat with its Bitrix original (twin), if there is one
function failureCopies(dialog) {
  const isClient = new Map((dialog.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
  const msgs = [...(dialog.messages || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const staff = (m) => Number(m.author_id) > 0 && !isClient.get(String(m.author_id));
  const out = [];
  for (const m of msgs) {
    if (!isClient.get(String(m.author_id))) continue;
    const f = failureReason(m.text);
    if (!f) continue;
    const body = norm(m.text.slice(0, m.text.indexOf(MARK)));
    const at = Date.parse(m.date);
    const twin = body ? [...msgs].reverse().find((x) => Number(x.id) < Number(m.id) && staff(x) && norm(x.text) === body && at - Date.parse(x.date) <= TWIN_MS) : null;
    out.push({ m, f, body, at, twin: twin || null });
  }
  return out;
}

// Mass-detection keys of a chat's copies without a Bitrix original since `since`
export function orphanKeys(dialog, since) {
  return failureCopies(dialog).filter((x) => !x.twin && x.at >= since && x.body).map((x) => massKey(x.body));
}

// Unresolved failed manager messages of one chat since `since` (the latest per chat, with how many failed).
// managerIds — whose messages count (Suvvy, robots and our scripts' user are not in it).
// wazzup: { mass: Set of massKey sent to MASS_CHATS+ chats today, managers: [{ id, name }] } — also report copies
// without a Bitrix original (sent from the Wazzup app); their managerId is the introduced author or null (= card owner)
export function chatFailures(dialog, managerIds, since, wazzup = null) {
  const isClient = new Map((dialog.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
  const msgs = [...(dialog.messages || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const staff = (m) => Number(m.author_id) > 0 && !isClient.get(String(m.author_id));
  const failed = [];
  const failedIds = new Set();
  for (const { m, f, body, at, twin } of failureCopies(dialog)) {
    if (!twin) {
      if (!wazzup || !body || at < since || wazzup.mass.has(massKey(body)) || SERVICE_TEXT.test(body) || ROBOT_TEXT.test(body)) continue;
      failed.push({ ...f, managerId: introAuthor(body, wazzup.managers), viaWazzup: true, at, afterId: Number(m.id), text: body.slice(0, 140) });
      continue;
    }
    failedIds.add(String(twin.id));
    const managerId = Number(twin.author_id);
    if (!managerIds.has(managerId) || ROBOT_TEXT.test(twin.text || "") || !(Date.parse(twin.date) >= since)) continue;
    failed.push({ ...f, managerId, at: Date.parse(twin.date), afterId: Number(m.id), text: body.slice(0, 140) });
  }
  // Resolved by anything that reached the client later: their own message, or ours that did not fail
  const reached = (m) => {
    const t = m.text || "";
    if (isClient.get(String(m.author_id))) return !t.includes(MARK); // client's message or our phone echo («Исходящее сообщение…»)
    return staff(m) && !failedIds.has(String(m.id));
  };
  const open = failed.filter((f) => !msgs.some((m) => Number(m.id) > f.afterId && reached(m)));
  if (!open.length) return null;
  const last = open[open.length - 1];
  return { managerId: last.managerId, at: last.at, text: last.text, reason: last.reason, hint: last.hint, count: open.length, viaWazzup: Boolean(last.viaWazzup) };
}

// For a chat bound to several cards: the card owned by the author, else a deal, else a lead
export function pickCard(cards, managerId) {
  return cards.find((c) => c.managerId === managerId) || cards.find((c) => c.entity === "deal") || cards[0] || null;
}

// Today's failures across every chat whose Open Lines session changed today (~30 s for a full day).
// managers — B2C groups plus the upsell group. Returns items for the «Лиды» and «Сделки» tabs.
export async function collectUndelivered(bx, managers, { now = Date.now() } = {}) {
  const since = mskDayStart(now);
  const managerIds = new Set(managers.map((m) => m.id));
  const sessions = await bx.list("crm.activity.list", {
    filter: { PROVIDER_ID: "IMOPENLINES_SESSION", ">=LAST_UPDATED": new Date(since).toISOString() }, select: ["ID", "OWNER_TYPE_ID", "OWNER_ID"],
  });
  const cards = new Map();
  for (const r of sessions) {
    const entity = { 1: "lead", 2: "deal" }[Number(r.OWNER_TYPE_ID)];
    if (entity && Number(r.OWNER_ID)) cards.set(entity + "_" + r.OWNER_ID, { entity, id: Number(r.OWNER_ID), chats: [] });
  }
  const found = await bx.batch(Object.fromEntries([...cards].map(([k, c]) =>
    ["c_" + k, `imopenlines.crm.chat.get?CRM_ENTITY_TYPE=${c.entity.toUpperCase()}&CRM_ENTITY=${c.id}&ACTIVE_ONLY=N`])));
  const byChat = new Map();
  for (const [k, c] of cards) for (const x of found.out["c_" + k] || []) if (x && x.CHAT_ID) {
    const id = String(x.CHAT_ID);
    c.chats.push(id);
    if (!byChat.has(id)) byChat.set(id, []);
    byChat.get(id).push(c);
  }
  const msgs = await bx.batch(Object.fromEntries([...byChat.keys()].map((c) => ["m_" + c, `im.dialog.messages.get?DIALOG_ID=chat${c}&LIMIT=50`])));
  // texts sent outside Bitrix to MASS_CHATS+ chats today are mass sends, not a manager's message
  const chatsByKey = new Map();
  for (const chat of byChat.keys()) for (const k of new Set(orphanKeys(msgs.out["m_" + chat] || {}, since))) chatsByKey.set(k, (chatsByKey.get(k) || 0) + 1);
  const wazzup = { mass: new Set([...chatsByKey].filter(([, n]) => n >= MASS_CHATS).map(([k]) => k)), managers };
  const hits = [];
  for (const chat of byChat.keys()) {
    const d = msgs.out["m_" + chat];
    const f = d && chatFailures(d, managerIds, since, wazzup);
    if (f) hits.push({ chat, ...f });
  }
  if (!hits.length) return { updatedAt: new Date(now).toISOString(), items: [] };

  // Card details: owner, stage, open/closed, pipeline
  const need = { lead: new Set(), deal: new Set() };
  for (const h of hits) for (const c of byChat.get(h.chat)) need[c.entity].add(c.id);
  const info = new Map();
  const spec = { lead: ["crm.lead.list", "STATUS_ID", "STATUS_SEMANTIC_ID"], deal: ["crm.deal.list", "STAGE_ID", "STAGE_SEMANTIC_ID"] };
  for (const entity of ["lead", "deal"]) {
    const ids = [...need[entity]];
    const [method, stage, sem] = spec[entity];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await bx.call(method, { filter: { ID: ids.slice(i, i + 50) }, select: ["ID", "ASSIGNED_BY_ID", stage, sem, "CATEGORY_ID"] });
      for (const x of r.result || []) info.set(entity + "_" + x.ID, { stageId: x[stage], closed: (x[sem] || "P") !== "P", won: x[sem] === "S", pipeline: entity === "deal" ? Number(x.CATEGORY_ID) || 0 : undefined, owner: Number(x.ASSIGNED_BY_ID) });
    }
  }
  const stageNames = {};
  for (const s of await bx.list("crm.status.list", {})) if (s.ENTITY_ID === "STATUS" || String(s.ENTITY_ID).startsWith("DEAL_STAGE")) stageNames[s.STATUS_ID] = s.NAME;

  const items = [];
  for (const h of hits) {
    const cs = byChat.get(h.chat).map((c) => ({ ...c, ...info.get(c.entity + "_" + c.id), managerId: (info.get(c.entity + "_" + c.id) || {}).owner }));
    const c = pickCard(cs, h.managerId);
    if (!c) continue;
    // sent from Wazzup by someone who didn't introduce themselves: the card's owner, if they are ours
    const managerId = h.managerId || (managerIds.has(c.managerId) ? c.managerId : null);
    if (!managerId) continue;
    items.push({
      entity: c.entity, id: c.id, pipeline: c.pipeline, stage: stageNames[c.stageId] || c.stageId || "—", closed: Boolean(c.closed), won: Boolean(c.won), viaWazzup: h.viaWazzup,
      managerId, at: new Date(h.at).toISOString(), text: h.text, reason: h.reason, hint: h.hint, count: h.count,
    });
  }
  return { updatedAt: new Date(now).toISOString(), items: items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) };
}

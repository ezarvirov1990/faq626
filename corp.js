// «Корпоративные клиенты» (pipeline 41) for the corporate sales team's /corp page: the user's stage rules (06.11.2026)
// as a pure function (corpRules) plus the collection from Bitrix24 (collectCorp).
// Spec: docs/specs/2026-11-06-corp-dashboard-design.md in the outer project.

const DAY = 864e5;
const MSK = 3 * 3600e3;
const WINDOW = 30 * DAY; // fresh comment, monthly contact
export const CORP_PIPELINE = 41;
export const CORP_DEPARTMENT = 188;
// in the department but not in sales: Инесса Ершова, events manager (the user 06.11.2026)
export const CORP_EXCLUDE = new Set([192776]);

const MIDDLE = "до 30 дней или задача на дату возврата · задача · комментарий";
const BASE = "задача · план на месяц · связь раз в месяц";
export const CORP_STAGES = [
  { key: "base", id: "C41:UC_C3DPHJ", name: "База на проработку", rule: "до 2 месяцев с создания" },
  { key: "new", id: "C41:NEW", name: "Новый клиент", rule: "взять в работу за сутки" },
  { key: "work", id: "C41:PREPARATION", name: "Взят в работу", limit: 30, rule: "до 30 дней · задача · комментарий" },
  { key: "lpr", id: "C41:2", name: "ЛПР выявлен", limit: 30, rule: MIDDLE },
  { key: "kp", id: "C41:PREPAYMENT_INVOICE", name: "КП выслано", limit: 30, rule: MIDDLE },
  { key: "terms", id: "C41:EXECUTING", name: "Согласование условий", limit: 30, rule: MIDDLE },
  { key: "contract", id: "C41:FINAL_INVOICE", name: "Согласование договора", limit: 30, rule: MIDDLE },
  { key: "signed", id: "C41:3", name: "Договор подписан", limit: 30, rule: MIDDLE },
  { key: "invoice", id: "C41:1", name: "Счет выставлен", rule: "задача на дату оплаты · комментарий" },
  { key: "partners", id: "C41:UC_T9MHJD", name: "База Партнеры/Страховые", rule: BASE },
  { key: "agents", id: "C41:UC_JOWINP", name: "База Агентские договора", rule: BASE },
];
const BY_ID = new Map(CORP_STAGES.map((s) => [s.id, s]));
const NO_CARD_RULES = new Set(["base", "new"]); // no task / comment rules there
const FLEX = new Set(["lpr", "kp", "terms", "contract", "signed"]); // over 30 days is fine with an actual task
const BASES = new Set(["partners", "agents"]);
const BASE_AGE_DAYS = 60;
const INVOICE_TYPE = 31; // smart invoices
const INVOICE_SENT = "DT31_1:S"; // «Отправлен клиенту»

const mskDay = (ms) => Math.floor((ms + MSK) / DAY);
const ddmm = (ms) => new Date(ms + MSK).toISOString().slice(5, 10).split("-").reverse().join(".");
const plural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;
const days = (n) => n + " " + plural(n, "день", "дня", "дней");

// A note that says contact happened (a call or chat from a personal phone, a meeting) — the user's choice 06.11.2026:
// checked by words, misses accepted. Not the B2C contactNote: «договор» there would match every contract note here.
const CONTACT_YES = ["созвон", "звонил", "звонила", "позвонил", "поговорил", "разговаривал", "разговор с", "общались", "пообщал",
  "написал", "написала", "переписк", "переписыва", "встреч", "встрети", "договорились", "обсудил", "обсуди", "на связи",
  "ответил", "ответила", "ответили", "письм", "почт", "whatsapp", "ватсап", "вотсап",
  "телеграм", "telegram", "zoom", "зум", "презентац"];
const CONTACT_NO = ["не отвеча", "не ответил", "не ответила", "не дозвон", "недозвон", "не на связи", "молчит", "не бер", "без ответа",
  "игнор", "сброс", "не выходит на связь", "не прочитал"];
export function corpContactNote(text) {
  const t = String(text || "").toLowerCase().replace(/ё/g, "е");
  return CONTACT_YES.some((w) => t.includes(w)) && !CONTACT_NO.some((w) => t.includes(w));
}

// d = { stageId, createdAt, movedAt, tasks: [deadline ms | null], notes: [{ at, text }], contacts: [{ at, kind }] }
export function corpRules(d, now) {
  const stage = BY_ID.get(d.stageId);
  if (!stage) return null;
  const k = stage.key;
  const daysOnStage = Math.max(0, Math.floor((now - d.movedAt) / DAY));
  const todayStart = mskDay(now) * DAY - MSK;
  const deadlines = (d.tasks || []).filter((x) => x !== null);
  const actual = deadlines.filter((x) => x >= todayStart).sort((a, b) => a - b);
  const task = actual.length ? { state: "ok", next: actual[0] }
    : deadlines.length ? { state: "due", next: Math.max(...deadlines) }
    : (d.tasks || []).length ? { state: "nodate", next: null } : { state: "none", next: null };
  const notes = d.notes || [];
  const lastNote = notes.length ? Math.max(...notes.map((n) => n.at)) : null;
  const contacts = [...(d.contacts || []), ...notes.filter((n) => corpContactNote(n.text)).map((n) => ({ at: n.at, kind: "note" }))];
  const lastContact = contacts.length ? contacts.reduce((a, b) => (b.at > a.at ? b : a)) : null;
  const rules = [];
  const add = (code, type, text) => rules.push({ code, type, text });

  if (k === "base") {
    const age = Math.floor((now - d.createdAt) / DAY);
    if (age > BASE_AGE_DAYS) add("old", "stage", `Создана ${days(age)} назад (до 2 месяцев) — взять в работу или закрыть`);
  }
  if (k === "new" && now - d.movedAt > DAY) {
    const h = Math.floor((now - d.movedAt) / 3600e3);
    add("notaken", "stage", `Не взята в работу ${h < 48 ? h + " ч" : days(daysOnStage)} — перевести в «Взят в работу»`);
  }
  if (!NO_CARD_RULES.has(k)) {
    if (task.state === "none") add("notask", "task", "Нет задачи — поставить задачу с актуальным сроком");
    else if (task.state === "nodate") add("notask", "task", "У задачи нет срока — поставить срок");
    else if (task.state === "due") add("taskdue", "task", `Задача просрочена (срок ${ddmm(task.next)}) — перенести срок или закрыть задачу`);
    if (!lastNote || now - lastNote > WINDOW) {
      const what = BASES.has(k) ? "план работы на месяц и договорённости" : "дальнейшие действия";
      add("nocomment", "comment", (lastNote ? `Последний комментарий ${ddmm(lastNote)}` : "Нет комментария") + ` — записать ${what}`);
    }
  }
  if (stage.limit && daysOnStage > stage.limit && (k === "work" || (FLEX.has(k) && task.state !== "ok"))) {
    add("over", "stage", `${days(daysOnStage)} на этапе (до ${stage.limit}) — двигать дальше или закрыть` + (FLEX.has(k) ? "; если ЛПР вернётся позже — задача на эту дату" : ""));
  }
  if (BASES.has(k) && (!lastContact || now - lastContact.at > WINDOW)) {
    add("nocontact", "contact", (lastContact ? `Связь была ${ddmm(lastContact.at)}` : "Связи за месяц нет") + " — позвонить, написать или встретиться; разговор с личного телефона описать в комментарии");
  }
  return { stage: k, daysOnStage, task, lastNote, lastContact, rules };
}

// ---- collection ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (s) => (s ? Date.parse(s) : NaN);
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const ownerQuery = (ids) => ids.map((id) => `filter[OWNER_ID][]=${id}`).join("&");
const OWNER = { 2: "deal", 3: "contact", 4: "company" };
const CALL_ENTITY = { DEAL: "deal", CONTACT: "contact", COMPANY: "company" };

// Batches run one after another with a pause (Bitrix allows ~2 requests/s per portal)
async function batches(bx, cmds, pause) {
  const out = {};
  const keys = Object.keys(cmds);
  for (let i = 0; i < keys.length; i += 50) {
    if (i) await sleep(pause);
    const r = await bx.batch(Object.fromEntries(keys.slice(i, i + 50).map((k) => [k, cmds[k]])));
    if (r.errors) throw new Error(`Bitrix вернул ошибки в ${r.errors} запросах`);
    Object.assign(out, r.out);
  }
  return out;
}

export async function collectCorp(bx, now, { pause = 600 } = {}) {
  const since = now - WINDOW;
  const sinceIso = new Date(since).toISOString();

  const users = (await bx.call("user.get", { FILTER: { UF_DEPARTMENT: CORP_DEPARTMENT, ACTIVE: true } })).result || [];
  const team = users.map((u) => ({ id: Number(u.ID), name: `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim() })).filter((m) => !CORP_EXCLUDE.has(m.id));
  await sleep(pause);

  const select = ["ID", "TITLE", "STAGE_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "MOVED_TIME", "OPPORTUNITY", "CONTACT_ID", "COMPANY_ID"];
  const dealBody = "filter[CATEGORY_ID]=" + CORP_PIPELINE + "&filter[STAGE_SEMANTIC_ID]=P&order[ID]=ASC" + select.map((f) => "&select[]=" + f).join("");
  const first = await bx.call("crm.deal.list", { filter: { CATEGORY_ID: CORP_PIPELINE, STAGE_SEMANTIC_ID: "P" }, order: { ID: "ASC" }, select });
  let rows = first.result || [];
  if ((first.total || 0) > rows.length) {
    await sleep(pause);
    const cmds = {};
    for (let s = 50; s < first.total; s += 50) cmds["d" + s] = `crm.deal.list?${dealBody}&start=${s}`;
    const out = await batches(bx, cmds, pause);
    for (const k of Object.keys(cmds)) rows = rows.concat(out[k] || []);
  }
  const ids = [...new Set(rows.map((r) => String(r.ID)))];

  // open tasks bound to the deals (only the Tasks module counts — the user's decision)
  const taskCmds = {};
  chunks(ids, 50).forEach((part, i) => {
    for (const s of [0, 50, 100, 150]) taskCmds[`t${i}_${s}`] = `crm.activity.list?filter[OWNER_TYPE_ID]=2&${ownerQuery(part)}&filter[PROVIDER_ID]=CRM_TASKS_TASK&filter[COMPLETED]=N&select[]=ID&select[]=OWNER_ID&select[]=DEADLINE&start=${s}`;
  });
  await sleep(pause);
  const taskOut = await batches(bx, taskCmds, pause);
  const tasks = new Map();
  const seenTask = new Set();
  for (const list of Object.values(taskOut)) for (const a of list || []) {
    if (seenTask.has(a.ID)) continue;
    seenTask.add(a.ID);
    const at = ms(a.DEADLINE);
    (tasks.get(String(a.OWNER_ID)) || tasks.set(String(a.OWNER_ID), []).get(String(a.OWNER_ID))).push(Number.isNaN(at) ? null : at);
  }

  // timeline notes, newest first
  const noteCmds = Object.fromEntries(ids.map((id) => ["n" + id, `crm.timeline.comment.list?filter[ENTITY_TYPE]=deal&filter[ENTITY_ID]=${id}&order[CREATED]=DESC&select[]=CREATED&select[]=COMMENT`]));
  await sleep(pause);
  const noteOut = await batches(bx, noteCmds, pause);
  const notes = new Map(ids.map((id) => [id, (noteOut["n" + id] || []).map((n) => ({ at: ms(n.CREATED), text: n.COMMENT || "" })).filter((n) => !Number.isNaN(n.at))]));

  // monthly contact on the base stages: e-mail, open-lines chat, completed meeting on the deal, its contact or company; calls with a conversation
  const baseRows = rows.filter((r) => BASES.has((BY_ID.get(r.STAGE_ID) || {}).key));
  const contacts = new Map();
  if (baseRows.length) {
    const owners = { 2: baseRows.map((r) => String(r.ID)), 3: [...new Set(baseRows.map((r) => String(r.CONTACT_ID)).filter((x) => Number(x)))], 4: [...new Set(baseRows.map((r) => String(r.COMPANY_ID)).filter((x) => Number(x)))] };
    const dealsOf = { deal: new Map(), contact: new Map(), company: new Map() };
    for (const r of baseRows) {
      const link = (type, id) => { if (Number(id)) (dealsOf[type].get(String(id)) || dealsOf[type].set(String(id), []).get(String(id))).push(String(r.ID)); };
      link("deal", r.ID); link("contact", r.CONTACT_ID); link("company", r.COMPANY_ID);
    }
    const hit = (type, id, at, kind) => {
      if (Number.isNaN(at) || at < since || at > now) return;
      for (const d of dealsOf[type].get(String(id)) || []) (contacts.get(d) || contacts.set(d, []).get(d)).push({ at, kind });
    };
    const actCmds = {};
    for (const [type, list] of Object.entries(owners)) chunks(list, 50).forEach((part, i) => {
      for (const s of [0, 50, 100, 150]) actCmds[`a${type}_${i}_${s}`] = `crm.activity.list?filter[OWNER_TYPE_ID]=${type}&${ownerQuery(part)}&filter[>=LAST_UPDATED]=${encodeURIComponent(sinceIso)}&select[]=ID&select[]=OWNER_TYPE_ID&select[]=OWNER_ID&select[]=PROVIDER_ID&select[]=CREATED&select[]=LAST_UPDATED&select[]=END_TIME&select[]=COMPLETED&start=${s}`;
    });
    await sleep(pause);
    const actOut = await batches(bx, actCmds, pause);
    const seenAct = new Set();
    for (const list of Object.values(actOut)) for (const a of list || []) {
      if (seenAct.has(a.ID)) continue;
      seenAct.add(a.ID);
      const type = OWNER[a.OWNER_TYPE_ID];
      if (a.PROVIDER_ID === "CRM_EMAIL") hit(type, a.OWNER_ID, ms(a.CREATED), "email");
      else if (a.PROVIDER_ID === "IMOPENLINES_SESSION") hit(type, a.OWNER_ID, ms(a.LAST_UPDATED), "chat");
      else if (a.PROVIDER_ID === "CRM_MEETING" && a.COMPLETED === "Y") hit(type, a.OWNER_ID, ms(a.END_TIME || a.LAST_UPDATED), "meeting");
    }
    // calls of the team (the whole portal's calls are thousands a month — B2C), a conversation only
    for (let start = 0; team.length; ) {
      await sleep(pause);
      const r = await bx.call("voximplant.statistic.get", { FILTER: { PORTAL_USER_ID: team.map((m) => m.id), ">=CALL_START_DATE": sinceIso, ">CALL_DURATION": 0 }, SORT: "CALL_START_DATE", ORDER: "ASC", start });
      for (const c of r.result || []) if (CALL_ENTITY[c.CRM_ENTITY_TYPE]) hit(CALL_ENTITY[c.CRM_ENTITY_TYPE], c.CRM_ENTITY_ID, ms(c.CALL_START_DATE), "call");
      if (!r.next) break;
      start = r.next;
    }
  }

  // payments we wait for (the user 06.11.2026): invoices «Отправлен клиенту» of the deals' companies or bound to the deals;
  // a company's invoice is counted once in the total even when the company has several deals
  const companies = [...new Set(rows.map((r) => String(r.COMPANY_ID)).filter((x) => Number(x)))];
  const invCmds = {};
  const invSelect = ["id", "opportunity", "companyId", "parentId2", "begindate"].map((f) => "&select[]=" + f).join("");
  const invList = (key, field, part) => { for (const s of [0, 50]) invCmds[`${key}_${s}`] = `crm.item.list?entityTypeId=${INVOICE_TYPE}&filter[stageId]=${INVOICE_SENT}&${part.map((id) => `filter[@${field}][]=${id}`).join("&")}${invSelect}&start=${s}`; };
  chunks(companies, 50).forEach((part, i) => invList("ic" + i, "companyId", part));
  chunks(ids, 50).forEach((part, i) => invList("id" + i, "parentId2", part));
  await sleep(pause);
  const invOut = await batches(bx, invCmds, pause);
  const invoices = new Map();
  for (const r of Object.values(invOut)) for (const x of (r && r.items) || []) invoices.set(x.id, { id: x.id, sum: Number(x.opportunity) || 0, company: String(x.companyId || ""), deal: String(x.parentId2 || ""), at: ms(x.begindate) });
  const waitingOf = (r) => {
    const mine = [...invoices.values()].filter((v) => (Number(r.COMPANY_ID) && v.company === String(r.COMPANY_ID)) || v.deal === String(r.ID));
    if (!mine.length) return null;
    const dates = mine.map((v) => v.at).filter((x) => !Number.isNaN(x));
    return { sum: mine.reduce((a, v) => a + v.sum, 0), count: mine.length, since: dates.length ? Math.min(...dates) : null,
      invoices: mine.map((v) => ({ id: v.id, sum: v.sum, at: Number.isNaN(v.at) ? null : v.at })).sort((a, b) => b.sum - a.sum) };
  };
  const waitingAll = [...invoices.values()].filter((v) => companies.includes(v.company) || ids.includes(v.deal));
  const waiting = { sum: waitingAll.reduce((a, v) => a + v.sum, 0), count: waitingAll.length };

  const items = rows.map((r) => {
    const id = String(r.ID);
    const res = corpRules({
      stageId: r.STAGE_ID, createdAt: ms(r.DATE_CREATE), movedAt: ms(r.MOVED_TIME) || ms(r.DATE_CREATE),
      tasks: tasks.get(id) || [], notes: notes.get(id) || [], contacts: contacts.get(id) || [],
    }, now);
    return res && { id: Number(r.ID), title: r.TITLE || "Сделка " + r.ID, owner: Number(r.ASSIGNED_BY_ID), amount: Number(r.OPPORTUNITY) || 0, stageId: r.STAGE_ID, waiting: waitingOf(r), ...res };
  }).filter(Boolean);
  return { updatedAt: new Date(now).toISOString(), portal: bx.portal, team, stages: CORP_STAGES, items, waiting };
}

// Снимок «открытые лиды и сделки без нашего касания дольше порога» из Bitrix24.
// Касание — наше исходящее действие: сообщение менеджера/бота в чат Открытой линии или звонок.
// Сообщения клиента касанием не считаются; если клиент написал позже нашего касания — clientWaiting.

import { mskDayStart, untouchedMoves, taskState } from "./tasks.js";
import { managerIndex, messageEvents, commentEvents, AUTO_LEAD_STAGES } from "./activity.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const OUTGOING_MARK = /^\s*=+\s*Исходящее сообщение/;
// Служебные пометки Wazzup: сообщение не доставлено (лимит «Маркетинг», 24-часовая сессия, спам…),
// клиент изменил/удалил сообщение, пропущенный звонок. Не касание и не входящее от клиента.
const WAZZUP_SYSTEM_MARK = "=== SYSTEM WZ ===";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadConfig(env) {
  return {
    port: Number(env.PORT || 3000),
    webhook: env.BITRIX_WEBHOOK,
    user: env.DASHBOARD_USER || "mygenetics",
    password: env.DASHBOARD_PASSWORD,
    departments: (env.DEPARTMENTS || "256,198").split(",").map((s) => Number(s.trim())).filter(Boolean),
    thresholdHours: Number(env.THRESHOLD_HOURS || 48),
    dealPipelines: parseDealPipelines(env),
    // Чьи переносы сроков задач не показываем (руководитель)
    taskMoveExclude: (env.TASK_MOVE_EXCLUDE ?? "77").split(",").map((s) => Number(s.trim())).filter(Boolean),
    // Leads/deals/tasks tabs: one full collection of all pipelines every 15 min is enough (decision 30.09.2026);
    // the feed has its own 30-second live loop
    refreshMinutes: Number(env.REFRESH_MINUTES || 15),
    slowRefreshMinutes: Number(env.SLOW_REFRESH_MINUTES || 15),
  };
}

// Deal pipelines on the «Сделки» tab. A pipeline without `departments` belongs to the main groups
// (DEPARTMENTS) and also feeds «Задачи» and «Лента событий»; the others show up on «Сделки» only.
// days — how long without our touch before a deal is listed (deals have a slower rhythm than leads).
// slow — big pipelines collected less often (SLOW_REFRESH_MINUTES); in between the server reuses the previous result.
export function parseDealPipelines(env) {
  if (env.DEAL_PIPELINES) return JSON.parse(env.DEAL_PIPELINES);
  return [
    { id: Number(env.DEAL_CATEGORY_ID || 27), days: Number(env.DEAL_THRESHOLD_DAYS || 30) }, // «В2С Продажа»
    { id: 65, days: 14, departments: [206], excludeUsers: [77], slow: true }, // «B2C Допродажа», upsell group without the head
    // «ГенКонф2026»: once the ticket is bought there is nothing to push
    { id: 53, days: 30, departments: [206], excludeUsers: [77], slow: true, skipStages: ["Купили билет", "Подтвердили визит", "Посетил мероприятие"] },
  ];
}

// Fast collections skip slow pipelines: carry them over from the previous snapshot into the fresh deals view
export function mergeDealPipelines(fresh, prev) {
  const f = fresh.views.deals;
  const p = prev && prev.views && prev.views.deals;
  if (!f || !p || !p.pipelines) return fresh;
  const have = new Set(f.pipelines.map((x) => x.id));
  const carry = p.pipelines.filter((x) => !have.has(x.id));
  if (!carry.length) return fresh;
  const carried = new Set(carry.map((x) => x.id));
  const pipelines = [...f.pipelines, ...carry];
  const openByManager = {};
  for (const x of pipelines) for (const [id, n] of Object.entries(x.openByManager)) openByManager[id] = (openByManager[id] || 0) + n;
  const extra = new Map([...(p.extraManagers || []), ...(f.extraManagers || [])].map((m) => [m.id, m]));
  const deals = {
    ...f,
    pipelines,
    openByManager,
    totalOpen: pipelines.reduce((a, x) => a + x.totalOpen, 0),
    items: [...f.items, ...p.items.filter((x) => carried.has(x.pipeline))].sort((a, b) => a.silentSince.localeCompare(b.silentSince)),
    extraManagers: [...extra.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")),
  };
  // Feed: today's messages and notes of other pipelines' people come from the slow run — keep them
  let activity = fresh.activity;
  if (activity && prev.activity) {
    const since = Date.parse(activity.since);
    const keys = new Set(activity.events.map((e) => e.key));
    const kept = prev.activity.events.filter((e) => extra.has(e.managerId) && e.at >= since && !keys.has(e.key));
    activity = { ...activity, events: [...activity.events, ...kept] };
  }
  return { ...fresh, views: { ...fresh.views, deals }, ...(activity ? { activity } : {}) };
}

// When our silence starts. A client's chat outlives leads: a returning client writes into the old chat and
// Wazzup opens a new lead — that is a new inquiry, so for leads touches before the lead's creation don't count
// (otherwise a 9-hour-old lead shows «131 days without a touch»). Deals keep the chat of their lead: real silence.
export function silenceStart(entity, lastTouch, created) {
  if (!lastTouch) return created;
  return entity === "lead" ? Math.max(lastTouch, created) : lastTouch;
}

// Is the client still waiting after their last message, given telephony calls of the lead?
// A call that connected (either direction) answers the client; a failed outgoing call is only an attempt.
export function waitingAfter(lastClient, calls) {
  let attemptAt = 0;
  for (const c of calls) {
    const at = Date.parse(c.CALL_START_DATE);
    if (!(at > lastClient)) continue;
    if (Number(c.CALL_DURATION) > 0 && String(c.CALL_FAILED_CODE) === "200") return { waiting: false, attemptAt: null };
    if (Number(c.CALL_TYPE) === 1) attemptAt = Math.max(attemptAt, at);
  }
  return { waiting: true, attemptAt: attemptAt || null };
}

// Stage ids whose names start with any of the given prefixes
export function skipStageIds(stages, prefixes = []) {
  return new Set(Object.entries(stages).filter(([, name]) => prefixes.some((p) => String(name).startsWith(p))).map(([id]) => id));
}

export function createBitrix(webhook) {
  const base = webhook.endsWith("/") ? webhook : webhook + "/";

  async function call(method, body = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(base + method + ".json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60e3),
        });
        const json = await res.json();
        // Лимиты и 5xx — временные, повторяем с паузой
        if (["QUERY_LIMIT_EXCEEDED", "OPERATION_TIME_LIMIT"].includes(json.error) || res.status >= 500) throw new Error(json.error || "HTTP " + res.status);
        if (json.error) throw Object.assign(new Error(`${method}: ${json.error} ${json.error_description || ""}`.trim()), { fatal: true });
        return json;
      } catch (e) {
        if (e.fatal || attempt >= 4) throw e;
        await sleep(3000 * attempt);
      }
    }
  }

  async function list(method, body) {
    const all = [];
    let start = 0;
    do {
      const r = await call(method, { ...body, start });
      all.push(...(r.result || []));
      start = r.next;
    } while (start);
    return all;
  }

  // Пачки по 50 команд; команды — строки "method?query"
  async function batch(cmds) {
    const out = {};
    let errors = 0;
    const keys = Object.keys(cmds);
    for (let i = 0; i < keys.length; i += 50) {
      const cmd = {};
      for (const k of keys.slice(i, i + 50)) cmd[k] = cmds[k];
      const r = await call("batch", { halt: 0, cmd });
      Object.assign(out, r.result.result);
      const errs = r.result.result_error;
      if (errs && !Array.isArray(errs)) errors += Object.keys(errs).length;
    }
    return { out, errors };
  }

  return { call, list, batch, portal: new URL(base).origin };
}

export async function collectSnapshot(bx, config, { withSlow = true } = {}) {
  const now = Date.now();
  const { departments } = config;

  // Active members of a department — read on every collection
  const deptCache = new Map();
  async function deptMembers(dep) {
    if (!deptCache.has(dep)) {
      const depInfo = (await bx.call("department.get", { ID: dep })).result[0];
      const users = await bx.list("user.get", { FILTER: { ACTIVE: true, UF_DEPARTMENT: dep } });
      deptCache.set(dep, users.map((u) => ({ id: Number(u.ID), name: `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim(), group: depInfo ? depInfo.NAME : String(dep) })));
    }
    return deptCache.get(dep);
  }

  // Менеджеры выбранных групп
  const managers = new Map();
  for (const dep of departments) for (const m of await deptMembers(dep)) if (!managers.has(m.id)) managers.set(m.id, m);
  const managerIds = [...managers.keys()];

  // What to collect: leads of the main groups, then every deal pipeline with its own owners
  const specs = [{
    key: "leads", entity: "lead", title: "Лиды", crmType: "LEAD", ownerTypeId: 1, primary: true,
    listMethod: "crm.lead.list", stageField: "STATUS_ID", stageEntity: "STATUS",
    filter: { STATUS_SEMANTIC_ID: "P" }, extraSelect: ["HAS_PHONE"],
    thresholdHours: config.thresholdHours, ownerIds: managerIds,
  }];
  // Other pipelines' people: on «Сделки» and «Лента событий», not on leads/tasks/alerts.
  // Known on every run (a department list is cheap), even when their slow pipelines are skipped.
  const extraManagers = new Map();
  for (const p of config.dealPipelines) {
    let ownerIds = managerIds;
    if (p.departments) {
      const own = new Map();
      for (const dep of p.departments) for (const m of await deptMembers(dep)) if (!(p.excludeUsers || []).includes(m.id)) own.set(m.id, m);
      for (const m of own.values()) if (!managers.has(m.id)) extraManagers.set(m.id, m);
      ownerIds = [...own.keys()];
    }
    if (p.slow && !withSlow) continue;
    const category = (await bx.call("crm.category.get", { entityTypeId: 2, id: p.id })).result.category;
    specs.push({
      key: "deals", entity: "deal", pipeline: p.id, primary: !p.departments,
      title: category.name.replace(/^[^\p{L}\p{N}]+/u, "").trim(), crmType: "DEAL", ownerTypeId: 2,
      listMethod: "crm.deal.list", stageField: "STAGE_ID", stageEntity: `DEAL_STAGE_${p.id}`,
      filter: { CATEGORY_ID: p.id, STAGE_SEMANTIC_ID: "P" }, extraSelect: [],
      thresholdHours: p.days * 24, ownerIds, skipStages: p.skipStages, slow: Boolean(p.slow),
    });
  }

  // 1) Сущности, их чаты и последний звонок
  let batchErrors = 0;
  const loaded = [];
  for (const spec of specs) {
    const stages = {};
    for (const s of (await bx.call("crm.status.list", { filter: { ENTITY_ID: spec.stageEntity } })).result) stages[s.STATUS_ID] = s.NAME;

    const skip = skipStageIds(stages, spec.skipStages);
    const items = (await bx.list(spec.listMethod, {
      filter: { ...spec.filter, ASSIGNED_BY_ID: spec.ownerIds },
      select: ["ID", spec.stageField, "ASSIGNED_BY_ID", "DATE_CREATE", ...spec.extraSelect],
    })).filter((it) => !skip.has(it[spec.stageField]));

    const cmds = {};
    for (const it of items) {
      cmds["chat_" + it.ID] = `imopenlines.crm.chat.get?CRM_ENTITY_TYPE=${spec.crmType}&CRM_ENTITY=${it.ID}&ACTIVE_ONLY=N`;
      cmds["call_" + it.ID] =
        `crm.activity.list?filter[OWNER_TYPE_ID]=${spec.ownerTypeId}&filter[OWNER_ID]=${it.ID}&filter[TYPE_ID]=2` +
        `&order[CREATED]=DESC&select[]=ID&select[]=CREATED`;
      // Open tasks feed only the «Задачи» tab, which covers the main groups
      if (spec.primary) cmds["task_" + it.ID] =
        `crm.activity.list?filter[OWNER_TYPE_ID]=${spec.ownerTypeId}&filter[OWNER_ID]=${it.ID}&filter[PROVIDER_ID]=CRM_TASKS_TASK` +
        `&filter[COMPLETED]=N&select[]=ID&select[]=DEADLINE`;
    }
    const res = await bx.batch(cmds);
    batchErrors += res.errors;

    const chatsOf = new Map();
    for (const it of items) {
      chatsOf.set(it.ID, (res.out["chat_" + it.ID] || []).filter((c) => c && c.CHAT_ID).map((c) => String(c.CHAT_ID)));
    }
    loaded.push({ spec, stages, items, chatsOf, calls: res.out });
  }

  // 2) Последние сообщения каждого чата — один раз, даже если чат общий у лида и сделки
  const chatIds = new Set(loaded.flatMap((l) => [...l.chatsOf.values()].flat()));
  const msgCmds = {};
  for (const c of chatIds) msgCmds["msg_" + c] = `im.dialog.messages.get?DIALOG_ID=chat${c}&LIMIT=50`;
  const msgs = await bx.batch(msgCmds);
  batchErrors += msgs.errors;

  // Для «Ленты событий»: сообщения менеджеров клиентам за сегодня
  const index = managerIndex([...managers.values(), ...extraManagers.values()]);
  const daySince = mskDayStart(now);
  const activity = [];
  // Чаты лидов на автоматических стадиях («Недозвон третьи сутки», «Робот…»): там пишут роботы от имени менеджера
  const autoChats = new Set();
  for (const { spec, items, chatsOf } of loaded) {
    if (spec.entity !== "lead") continue;
    for (const it of items) if (AUTO_LEAD_STAGES.has(it[spec.stageField])) for (const c of chatsOf.get(it.ID)) autoChats.add(c);
  }

  const lastByChat = new Map();
  for (const c of chatIds) {
    const m = msgs.out["msg_" + c];
    if (m) activity.push(...messageEvents(m, index, daySince, autoChats.has(c)));
    let ours = 0, client = 0;
    const oursTimes = [];
    if (m) {
      const isClient = new Map((m.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
      for (const x of m.messages || []) {
        if (Number(x.author_id) === 0) continue; // системные строки
        if ((x.text || "").includes(WAZZUP_SYSTEM_MARK)) continue;
        const t = Date.parse(x.date);
        // Wazzup пишет наши исходящие (с телефона, из WhatsApp) от имени клиента с такой пометкой
        const outgoing = OUTGOING_MARK.test(x.text || "");
        if (isClient.get(String(x.author_id)) && !outgoing) client = Math.max(client, t);
        else { ours = Math.max(ours, t); oursTimes.push(t); }
      }
    }
    lastByChat.set(c, { ours, client, oursTimes });
  }

  // 3) Итог по каждому виду
  const views = {};
  const taskItems = [];
  const openItems = new Map(); // "L_123" / "D_456" → лид/сделка для вкладки «Задачи»
  const waitCands = [];
  for (const { spec, stages, items, chatsOf, calls } of loaded) {
    const openByManager = {};
    const rows = [];
    for (const it of items) {
      const managerId = Number(it.ASSIGNED_BY_ID);
      openByManager[managerId] = (openByManager[managerId] || 0) + 1;
      const stage = stages[it[spec.stageField]] || it[spec.stageField];

      let lastOurMsg = 0, lastClient = 0;
      const touches = [];
      for (const c of chatsOf.get(it.ID)) {
        const l = lastByChat.get(c);
        lastOurMsg = Math.max(lastOurMsg, l.ours);
        lastClient = Math.max(lastClient, l.client);
        touches.push(...l.oursTimes);
      }
      const itemCalls = calls["call_" + it.ID] || [];
      const lastCall = itemCalls.length ? Date.parse(itemCalls[0].CREATED) : 0;
      touches.push(...itemCalls.map((x) => Date.parse(x.CREATED)));

      if (spec.primary) {
        const ts = taskState(calls["task_" + it.ID] || [], now);
        if (ts.kind !== "ok") {
          taskItems.push({
            entity: spec.entity, id: Number(it.ID), stage, managerId, kind: ts.kind,
            deadline: ts.deadline ? new Date(ts.deadline).toISOString() : null,
          });
        }
        openItems.set(spec.crmType[0] + "_" + it.ID, { entity: spec.entity, id: Number(it.ID), stage, managerId, touches });
      }

      const lastTouch = Math.max(lastOurMsg, lastCall);
      const created = Date.parse(it.DATE_CREATE);
      // «Клиент ждёт ответа»: the client wrote last in the chat, whatever the lead's age
      if (spec.entity === "lead" && lastClient > lastOurMsg) {
        waitCands.push({ id: Number(it.ID), stage, managerId, created, lastClient, calledAfter: lastCall > lastClient });
      }
      const silentSince = silenceStart(spec.entity, lastTouch, created);
      if (now - silentSince < spec.thresholdHours * HOUR) continue;

      rows.push({
        id: Number(it.ID),
        ...(spec.pipeline ? { pipeline: spec.pipeline } : {}),
        stage,
        managerId,
        created: new Date(created).toISOString(),
        silentSince: new Date(silentSince).toISOString(),
        lastTouch: lastTouch ? new Date(lastTouch).toISOString() : null,
        lastTouchKind: !lastTouch ? null : lastCall > lastOurMsg ? "call" : "msg",
        clientWaiting: lastClient > lastTouch,
        // Последнее событие в лиде — наше или клиента; по нему подсказка помечается «устарела»
        lastActivity: Math.max(lastTouch, lastClient) ? new Date(Math.max(lastTouch, lastClient)).toISOString() : null,
        hasChat: chatsOf.get(it.ID).length > 0,
        hasPhone: spec.extraSelect.includes("HAS_PHONE") ? it.HAS_PHONE === "Y" : null,
      });
    }
    // All deal pipelines share one view; the first (main) pipeline sets its title and threshold
    const view = views[spec.key] ||= {
      title: spec.title, entity: spec.entity, thresholdHours: spec.thresholdHours, totalOpen: 0, openByManager: {}, items: [],
      ...(spec.pipeline ? { pipelines: [] } : {}),
    };
    view.totalOpen += items.length;
    for (const [id, n] of Object.entries(openByManager)) view.openByManager[id] = (view.openByManager[id] || 0) + n;
    view.items.push(...rows);
    if (spec.pipeline) {
      view.pipelines.push({
        id: spec.pipeline, title: spec.title, thresholdHours: spec.thresholdHours, totalOpen: items.length, openByManager,
        slow: spec.slow, updatedAt: new Date(now).toISOString(),
      });
    }
  }
  for (const v of Object.values(views)) v.items.sort((a, b) => a.silentSince.localeCompare(b.silentSince));

  // «Клиент ждёт ответа» on leads. Where we called after the client's message, telephony stats tell
  // a real conversation (answered — not waiting) from a failed attempt (still waiting, shown as an attempt).
  if (views.leads) {
    const called = waitCands.filter((w) => w.calledAfter);
    const stat = await bx.batch(Object.fromEntries(called.map((w) =>
      ["vox_" + w.id, `voximplant.statistic.get?FILTER[CRM_ENTITY_TYPE]=LEAD&FILTER[CRM_ENTITY_ID]=${w.id}&SORT=CALL_START_DATE&ORDER=DESC`])));
    views.leads.waiting = waitCands
      .map((w) => ({ w, s: waitingAfter(w.lastClient, w.calledAfter ? stat.out["vox_" + w.id] || [] : []) }))
      .filter((x) => x.s.waiting)
      .map(({ w, s }) => ({
        id: w.id, stage: w.stage, managerId: w.managerId, created: new Date(w.created).toISOString(),
        since: new Date(w.lastClient).toISOString(), attemptAt: s.attemptAt ? new Date(s.attemptAt).toISOString() : null,
      }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }
  if (views.deals) views.deals.extraManagers = [...extraManagers.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));

  // 4) Переносы сроков задач за вчера и сегодня (по Москве) по нашим открытым лидам и сделкам.
  // Изменённые задачи ищем по делам CRM: у задачи при переносе срока обновляется и её дело,
  // а tasks.task.list с фильтром по дате изменения отвечает в 10 раз медленнее.
  const movesSince = mskDayStart(now) - DAY;
  const changed = await bx.list("crm.activity.list", {
    filter: { ">=LAST_UPDATED": new Date(movesSince).toISOString(), PROVIDER_ID: "CRM_TASKS_TASK", OWNER_TYPE_ID: [1, 2] },
    select: ["ID", "OWNER_TYPE_ID", "OWNER_ID", "ASSOCIATED_ENTITY_ID", "SUBJECT", "CREATED", "RESPONSIBLE_ID"],
  });
  const ourTasks = new Map(); // id задачи → { task, item }
  for (const a of changed) {
    const item = openItems.get((Number(a.OWNER_TYPE_ID) === 1 ? "L_" : "D_") + a.OWNER_ID);
    if (item && !ourTasks.has(a.ASSOCIATED_ENTITY_ID)) ourTasks.set(a.ASSOCIATED_ENTITY_ID, { task: a, item });
  }
  const histCmds = {};
  for (const id of ourTasks.keys()) histCmds["hist_" + id] = `tasks.task.history.list?taskId=${id}&filter[FIELD]=DEADLINE`;
  const hist = await bx.batch(histCmds);
  batchErrors += hist.errors;

  // 5) Для «Ленты событий»: заметки менеджеров в ленте открытых лидов и сделок.
  // Ошибки здесь не портят снимок — лента просто покажет меньше заметок.
  const commentCmds = {};
  for (const { spec, items } of loaded) {
    for (const it of items) {
      commentCmds[`cm_${spec.entity}_${it.ID}`] =
        `crm.timeline.comment.list?filter[ENTITY_TYPE]=${spec.entity}&filter[ENTITY_ID]=${it.ID}&select[]=ID&select[]=CREATED&select[]=AUTHOR_ID`;
    }
  }
  const comments = await bx.batch(commentCmds);
  for (const [key, rows] of Object.entries(comments.out)) {
    activity.push(...commentEvents(key.split("_")[1], rows || [], index.ids, daySince));
  }

  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const moves = [];
  for (const [id, { task, item }] of ourTasks) {
    const recent = ((hist.out["hist_" + id] || {}).list || [])
      .map((h) => ({ at: Date.parse(h.createdDate), userId: Number(h.user && h.user.id), from: Number((h.value || {}).from) * 1000, to: Number((h.value || {}).to) * 1000 }))
      .filter((m) => m.at >= movesSince && managers.has(m.userId) && !config.taskMoveExclude.includes(m.userId));
    for (const m of untouchedMoves(recent, item.touches, Date.parse(task.CREATED))) {
      moves.push({
        entity: item.entity, id: item.id, stage: item.stage, ownerId: item.managerId,
        taskId: Number(id), taskTitle: task.SUBJECT, responsibleId: Number(task.RESPONSIBLE_ID),
        managerId: m.userId, at: iso(m.at), from: iso(m.from), to: iso(m.to), lastTouch: iso(m.lastTouch),
      });
    }
  }

  return {
    updatedAt: new Date(now).toISOString(),
    portal: bx.portal,
    batchErrors,
    managers: [...managers.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    views,
    tasks: {
      movesSince: new Date(movesSince).toISOString(),
      moves: moves.sort((a, b) => b.at.localeCompare(a.at)),
      items: taskItems,
    },
    activity: { since: iso(daySince), events: activity },
  };
}

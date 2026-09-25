// Снимок «открытые лиды и сделки без нашего касания дольше порога» из Bitrix24.
// Касание — наше исходящее действие: сообщение менеджера/бота в чат Открытой линии или звонок.
// Сообщения клиента касанием не считаются; если клиент написал позже нашего касания — clientWaiting.

const HOUR = 3600e3;
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
    dealCategoryId: Number(env.DEAL_CATEGORY_ID || 27),
    thresholdHours: Number(env.THRESHOLD_HOURS || 48),
    // У сделок другой ритм работы: в список попадают только те, где нас не было больше месяца
    dealThresholdDays: Number(env.DEAL_THRESHOLD_DAYS || 30),
    refreshMinutes: Number(env.REFRESH_MINUTES || 15),
  };
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

// Что и откуда берём для каждого вида
function entitySpecs(config, dealCategoryName) {
  return [
    {
      key: "leads", entity: "lead", title: "Лиды", crmType: "LEAD", ownerTypeId: 1,
      listMethod: "crm.lead.list", stageField: "STATUS_ID", stageEntity: "STATUS",
      filter: { STATUS_SEMANTIC_ID: "P" }, extraSelect: ["HAS_PHONE"],
      thresholdHours: config.thresholdHours,
    },
    {
      key: "deals", entity: "deal", title: dealCategoryName, crmType: "DEAL", ownerTypeId: 2,
      listMethod: "crm.deal.list", stageField: "STAGE_ID", stageEntity: `DEAL_STAGE_${config.dealCategoryId}`,
      filter: { CATEGORY_ID: config.dealCategoryId, STAGE_SEMANTIC_ID: "P" }, extraSelect: [],
      thresholdHours: config.dealThresholdDays * 24,
    },
  ];
}

export async function collectSnapshot(bx, config) {
  const now = Date.now();
  const { departments } = config;

  // Менеджеры выбранных групп — состав читается при каждом сборе
  const managers = new Map();
  for (const dep of departments) {
    const depInfo = (await bx.call("department.get", { ID: dep })).result[0];
    const users = await bx.list("user.get", { FILTER: { ACTIVE: true, UF_DEPARTMENT: dep } });
    for (const u of users) {
      if (managers.has(Number(u.ID))) continue;
      managers.set(Number(u.ID), {
        id: Number(u.ID),
        name: `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim(),
        group: depInfo ? depInfo.NAME : String(dep),
      });
    }
  }
  const managerIds = [...managers.keys()];

  const category = (await bx.call("crm.category.get", { entityTypeId: 2, id: config.dealCategoryId })).result.category;
  const specs = entitySpecs(config, category.name.replace(/^[^\p{L}\p{N}]+/u, "").trim());

  // 1) Сущности, их чаты и последний звонок
  let batchErrors = 0;
  const loaded = [];
  for (const spec of specs) {
    const stages = {};
    for (const s of (await bx.call("crm.status.list", { filter: { ENTITY_ID: spec.stageEntity } })).result) stages[s.STATUS_ID] = s.NAME;

    const items = await bx.list(spec.listMethod, {
      filter: { ...spec.filter, ASSIGNED_BY_ID: managerIds },
      select: ["ID", spec.stageField, "ASSIGNED_BY_ID", "DATE_CREATE", ...spec.extraSelect],
    });

    const cmds = {};
    for (const it of items) {
      cmds["chat_" + it.ID] = `imopenlines.crm.chat.get?CRM_ENTITY_TYPE=${spec.crmType}&CRM_ENTITY=${it.ID}&ACTIVE_ONLY=N`;
      cmds["call_" + it.ID] =
        `crm.activity.list?filter[OWNER_TYPE_ID]=${spec.ownerTypeId}&filter[OWNER_ID]=${it.ID}&filter[TYPE_ID]=2` +
        `&order[CREATED]=DESC&select[]=ID&select[]=CREATED`;
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

  const lastByChat = new Map();
  for (const c of chatIds) {
    const m = msgs.out["msg_" + c];
    let ours = 0, client = 0;
    if (m) {
      const isClient = new Map((m.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
      for (const x of m.messages || []) {
        if (Number(x.author_id) === 0) continue; // системные строки
        if ((x.text || "").includes(WAZZUP_SYSTEM_MARK)) continue;
        const t = Date.parse(x.date);
        // Wazzup пишет наши исходящие (с телефона, из WhatsApp) от имени клиента с такой пометкой
        const outgoing = OUTGOING_MARK.test(x.text || "");
        if (isClient.get(String(x.author_id)) && !outgoing) client = Math.max(client, t);
        else ours = Math.max(ours, t);
      }
    }
    lastByChat.set(c, { ours, client });
  }

  // 3) Итог по каждому виду
  const views = {};
  for (const { spec, stages, items, chatsOf, calls } of loaded) {
    const openByManager = {};
    const rows = [];
    for (const it of items) {
      const managerId = Number(it.ASSIGNED_BY_ID);
      openByManager[managerId] = (openByManager[managerId] || 0) + 1;

      let lastOurMsg = 0, lastClient = 0;
      for (const c of chatsOf.get(it.ID)) {
        const l = lastByChat.get(c);
        lastOurMsg = Math.max(lastOurMsg, l.ours);
        lastClient = Math.max(lastClient, l.client);
      }
      const itemCalls = calls["call_" + it.ID] || [];
      const lastCall = itemCalls.length ? Date.parse(itemCalls[0].CREATED) : 0;

      const lastTouch = Math.max(lastOurMsg, lastCall);
      const created = Date.parse(it.DATE_CREATE);
      const silentSince = lastTouch || created;
      if (now - silentSince < spec.thresholdHours * HOUR) continue;

      rows.push({
        id: Number(it.ID),
        stage: stages[it[spec.stageField]] || it[spec.stageField],
        managerId,
        created: new Date(created).toISOString(),
        silentSince: new Date(silentSince).toISOString(),
        lastTouchKind: !lastTouch ? null : lastCall > lastOurMsg ? "call" : "msg",
        clientWaiting: lastClient > lastTouch,
        hasChat: chatsOf.get(it.ID).length > 0,
        hasPhone: spec.extraSelect.includes("HAS_PHONE") ? it.HAS_PHONE === "Y" : null,
      });
    }
    views[spec.key] = {
      title: spec.title,
      entity: spec.entity,
      thresholdHours: spec.thresholdHours,
      totalOpen: items.length,
      openByManager,
      items: rows.sort((a, b) => a.silentSince.localeCompare(b.silentSince)),
    };
  }

  return {
    updatedAt: new Date(now).toISOString(),
    portal: bx.portal,
    batchErrors,
    managers: [...managers.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    views,
  };
}

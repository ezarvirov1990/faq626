// Снимок «открытые лиды без нашего касания дольше порога» из Bitrix24.
// Касание — наше исходящее действие: сообщение менеджера/бота в чат Открытой линии или звонок.
// Сообщения клиента касанием не считаются; если клиент написал позже нашего касания — clientWaiting.

const HOUR = 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        // QUERY_LIMIT_EXCEEDED и 5xx — временные, повторяем
        if (json.error === "QUERY_LIMIT_EXCEEDED" || res.status >= 500) throw new Error(json.error || "HTTP " + res.status);
        if (json.error) throw Object.assign(new Error(`${method}: ${json.error} ${json.error_description || ""}`.trim()), { fatal: true });
        return json;
      } catch (e) {
        if (e.fatal || attempt >= 3) throw e;
        await sleep(2000 * attempt);
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

export async function collectSnapshot(bx, { departments, thresholdHours }) {
  const now = Date.now();

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
        open: 0,
      });
    }
  }

  const stages = {};
  for (const s of (await bx.call("crm.status.list", { filter: { ENTITY_ID: "STATUS" } })).result) stages[s.STATUS_ID] = s.NAME;

  const leads = await bx.list("crm.lead.list", {
    filter: { STATUS_SEMANTIC_ID: "P", ASSIGNED_BY_ID: [...managers.keys()] },
    select: ["ID", "STATUS_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "HAS_PHONE"],
  });

  // Чаты и последний звонок по каждому лиду
  const cmds = {};
  for (const l of leads) {
    cmds["chat_" + l.ID] = `imopenlines.crm.chat.get?CRM_ENTITY_TYPE=LEAD&CRM_ENTITY=${l.ID}&ACTIVE_ONLY=N`;
    cmds["call_" + l.ID] =
      `crm.activity.list?filter[OWNER_TYPE_ID]=1&filter[OWNER_ID]=${l.ID}&filter[TYPE_ID]=2` +
      `&order[CREATED]=DESC&select[]=ID&select[]=CREATED`;
  }
  const first = await bx.batch(cmds);

  const chatsOf = new Map();
  const msgCmds = {};
  for (const l of leads) {
    const chats = (first.out["chat_" + l.ID] || []).filter((c) => c && c.CHAT_ID).map((c) => c.CHAT_ID);
    chatsOf.set(l.ID, chats);
    for (const c of chats) msgCmds["msg_" + c] = `im.dialog.messages.get?DIALOG_ID=chat${c}&LIMIT=50`;
  }
  const second = await bx.batch(msgCmds);

  const rows = [];
  for (const l of leads) {
    let lastOurMsg = 0, lastClient = 0;
    for (const c of chatsOf.get(l.ID)) {
      const m = second.out["msg_" + c];
      if (!m) continue;
      const isClient = new Map((m.users || []).map((u) => [String(u.id), Boolean(u.connector)]));
      for (const x of m.messages || []) {
        if (Number(x.author_id) === 0) continue; // системные строки
        const t = Date.parse(x.date);
        if (isClient.get(String(x.author_id))) lastClient = Math.max(lastClient, t);
        else lastOurMsg = Math.max(lastOurMsg, t);
      }
    }
    const calls = first.out["call_" + l.ID] || [];
    const lastCall = calls.length ? Date.parse(calls[0].CREATED) : 0;

    const lastTouch = Math.max(lastOurMsg, lastCall);
    const kind = !lastTouch ? null : lastCall > lastOurMsg ? "call" : "msg";
    const created = Date.parse(l.DATE_CREATE);
    const silentSince = lastTouch || created;

    const mgr = managers.get(Number(l.ASSIGNED_BY_ID));
    if (mgr) mgr.open++;
    if (now - silentSince < thresholdHours * HOUR) continue;

    rows.push({
      id: Number(l.ID),
      stage: stages[l.STATUS_ID] || l.STATUS_ID,
      managerId: Number(l.ASSIGNED_BY_ID),
      created: new Date(created).toISOString(),
      silentSince: new Date(silentSince).toISOString(),
      lastTouchKind: kind,
      clientWaiting: lastClient > lastTouch,
      hasChat: chatsOf.get(l.ID).length > 0,
      hasPhone: l.HAS_PHONE === "Y",
    });
  }

  return {
    updatedAt: new Date(now).toISOString(),
    thresholdHours,
    portal: bx.portal,
    totalOpen: leads.length,
    batchErrors: first.errors + second.errors,
    managers: [...managers.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    leads: rows.sort((a, b) => a.silentSince.localeCompare(b.silentSince)),
  };
}

// «Неделя» page: leads of B2C managers and the Suvvy bot per day (MSK) — came in, closed as qualified,
// closed as not qualified, still open at the end of the day. Attributed to the current owner.
// Leads closed as duplicate or spam are not analysed at all (user decision 22.10.2026) — left out entirely.

export const SUVVY_ID = 367846; // Open Lines service user: the Suvvy bot's queue
const DAY = 24 * 3600e3;
const MSK = 3 * 3600e3;
export const CLOSED = { CONVERTED: "qual", JUNK: "bad", 4: "bad" };
export const IGNORED = ["2", "3"]; // «Дубль», «Спам»

// Monday 00:00 MSK of the week containing `ms`, as "YYYY-MM-DD"
export function weekStart(ms) {
  const local = new Date(ms + MSK);
  const back = (local.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back)).toISOString().slice(0, 10);
}
const dayKey = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
const startMs = (day) => Date.parse(day + "T00:00:00+03:00");

// Pure: leads (created this week, closed since the week start, open now) → per owner, per day counts
// exclude — lead IDs to leave out entirely (leads Bitrix created when we messaged closed clients)
export function weekStats({ from, now, owners, leads, exclude = [] }) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = dayKey(startMs(from) + i * DAY + 12 * 3600e3);
    if (startMs(d) <= now) days.push(d);
  }
  const ownerSet = new Set(owners.map((o) => String(o.id)));
  const cells = {};
  const cell = (o, d) => ((cells[o] ||= {})[d] ||= { came: 0, viaBot: 0, qual: 0, bad: 0, work: 0 });
  const seen = new Set([...exclude].map(String));
  for (const l of leads) {
    if (seen.has(l.ID)) continue;
    seen.add(l.ID);
    const o = String(l.ASSIGNED_BY_ID);
    if (!ownerSet.has(o) || IGNORED.includes(String(l.STATUS_ID))) continue;
    const created = Date.parse(l.DATE_CREATE);
    const cls = CLOSED[l.STATUS_ID];
    const open = l.STATUS_SEMANTIC_ID === "P" || (!cls && !l.DATE_CLOSED);
    const closedDay = !open && l.DATE_CLOSED ? String(l.DATE_CLOSED).slice(0, 10) : null;
    const cd = dayKey(created);
    if (days.includes(cd)) {
      cell(o, cd).came++;
      if (String(l.CREATED_BY_ID) === String(SUVVY_ID)) cell(o, cd).viaBot++;
    }
    if (closedDay && cls && days.includes(closedDay)) cell(o, closedDay)[cls]++;
    for (const d of days) {
      const end = Math.min(startMs(d) + DAY, now);
      if (created < end && (open || (closedDay && closedDay > d))) cell(o, d).work++;
    }
  }
  return { from, days, now, owners, cells };
}

// Suvvy's own funnel (user's definition 27.10.2026): the bot takes every new request 24/7, moves the interested ones
// to «Тёплый» / «Горячий» (handed to managers) and closes the silent ones itself. A lead counts for the bot when the bot
// created it, whoever owns it now. handed — first move to «Тёплый» / «Горячий», or «Качественный лид» reached without
// them (bought / taken straight away); closed — closed as not qualified and never handed. Per MSK day of the event.
export const WARM_STAGES = ["UC_X7QRZ3", "UC_I4BC3I"]; // «Теплый лид», «Горячий лид»
export function suvvyFunnel({ from, now, created, closed, firstWarm, exclude = [] }) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = dayKey(startMs(from) + i * DAY + 12 * 3600e3);
    if (startMs(d) <= now) days.push(d);
  }
  const skip = new Set([...exclude].map(String));
  const cells = {};
  const cell = (d) => (cells[d] ||= { came: 0, handed: 0, closed: 0 });
  const ok = (l) => String(l.CREATED_BY_ID) === String(SUVVY_ID) && !IGNORED.includes(String(l.STATUS_ID)) && !skip.has(String(l.ID));
  const seen = new Set();
  for (const l of created) {
    if (!ok(l) || seen.has(l.ID)) continue;
    seen.add(l.ID);
    const d = dayKey(Date.parse(l.DATE_CREATE));
    if (days.includes(d)) cell(d).came++;
  }
  const counted = new Set();
  for (const l of [...closed, ...created]) {
    if (!ok(l) || counted.has(l.ID)) continue;
    counted.add(l.ID);
    const warm = firstWarm[l.ID];
    if (warm) {
      const d = dayKey(warm);
      if (days.includes(d)) cell(d).handed++;
      continue;
    }
    const cls = CLOSED[l.STATUS_ID];
    const d = cls && l.DATE_CLOSED ? String(l.DATE_CLOSED).slice(0, 10) : null;
    if (d && days.includes(d)) cell(d)[cls === "qual" ? "handed" : "closed"]++;
  }
  return { days, cells };
}

// Bitrix for the funnel: the bot's leads created this week, closed this week, or first moved to a warm stage this week
async function stageMoves(bx, filter) {
  const out = [];
  let start = 0;
  do {
    const r = await bx.call("crm.stagehistory.list", { entityTypeId: 1, filter, select: ["OWNER_ID", "STATUS_ID", "CREATED_TIME"], order: { ID: "ASC" }, start });
    out.push(...((r.result || {}).items || []));
    start = r.next;
  } while (start);
  return out;
}
export async function collectSuvvyFunnel(bx, { from, now = Date.now(), exclude = [] }) {
  const to = dayKey(startMs(from) + 7 * DAY + 12 * 3600e3);
  const fromIso = from + "T00:00:00+03:00", toIso = to + "T00:00:00+03:00";
  const select = ["ID", "CREATED_BY_ID", "STATUS_ID", "DATE_CREATE", "DATE_CLOSED"];
  const [created, closed, moved] = await Promise.all([
    bx.list("crm.lead.list", { filter: { CREATED_BY_ID: SUVVY_ID, ">=DATE_CREATE": fromIso, "<DATE_CREATE": toIso }, select }),
    bx.list("crm.lead.list", { filter: { CREATED_BY_ID: SUVVY_ID, STATUS_ID: Object.keys(CLOSED), ">=DATE_CLOSED": fromIso }, select }),
    stageMoves(bx, { STATUS_ID: WARM_STAGES, ">=CREATED_TIME": fromIso, "<CREATED_TIME": toIso }),
  ]);
  // leads moved this week that aren't in the two lists yet (created earlier, still open)
  const known = new Set([...created, ...closed].map((l) => String(l.ID)));
  const extraIds = [...new Set(moved.map((m) => String(m.OWNER_ID)))].filter((id) => !known.has(id));
  const extra = [];
  for (let i = 0; i < extraIds.length; i += 50) extra.push(...await bx.list("crm.lead.list", { filter: { ID: extraIds.slice(i, i + 50), CREATED_BY_ID: SUVVY_ID }, select }));
  // the first warm move ever of every lead involved (a lead handed last week isn't handed again this week)
  const all = [...created, ...closed, ...extra];
  const ids = [...new Set(all.map((l) => String(l.ID)))];
  const firstWarm = {};
  for (let i = 0; i < ids.length; i += 50) {
    for (const m of await stageMoves(bx, { OWNER_ID: ids.slice(i, i + 50), STATUS_ID: WARM_STAGES })) {
      const at = Date.parse(m.CREATED_TIME), k = String(m.OWNER_ID);
      if (!firstWarm[k] || at < firstWarm[k]) firstWarm[k] = at;
    }
  }
  return suvvyFunnel({ from, now, created: all, closed: [], firstWarm, exclude });
}

// Bitrix: three lists, all filtered to the owners
export async function collectWeek(bx, { from, now = Date.now(), owners, exclude = [] }) {
  const ids = owners.map((o) => o.id);
  const to = dayKey(startMs(from) + 7 * DAY + 12 * 3600e3);
  const select = ["ID", "ASSIGNED_BY_ID", "CREATED_BY_ID", "STATUS_ID", "STATUS_SEMANTIC_ID", "DATE_CREATE", "DATE_CLOSED"];
  const [created, closed, open, bot] = await Promise.all([
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, ">=DATE_CREATE": from + "T00:00:00+03:00", "<DATE_CREATE": to + "T00:00:00+03:00" }, select }),
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, STATUS_ID: Object.keys(CLOSED), ">=DATE_CLOSED": from + "T00:00:00+03:00" }, select }),
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, STATUS_SEMANTIC_ID: "P" }, select }),
    ids.includes(SUVVY_ID) ? collectSuvvyFunnel(bx, { from, now, exclude }) : null,
  ]);
  return { ...weekStats({ from, now, owners, exclude, leads: [...open, ...closed, ...created] }), bot: bot && bot.cells };
}

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

// Bitrix: three lists, all filtered to the owners
export async function collectWeek(bx, { from, now = Date.now(), owners, exclude = [] }) {
  const ids = owners.map((o) => o.id);
  const to = dayKey(startMs(from) + 7 * DAY + 12 * 3600e3);
  const select = ["ID", "ASSIGNED_BY_ID", "CREATED_BY_ID", "STATUS_ID", "STATUS_SEMANTIC_ID", "DATE_CREATE", "DATE_CLOSED"];
  const [created, closed, open] = await Promise.all([
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, ">=DATE_CREATE": from + "T00:00:00+03:00", "<DATE_CREATE": to + "T00:00:00+03:00" }, select }),
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, STATUS_ID: Object.keys(CLOSED), ">=DATE_CLOSED": from + "T00:00:00+03:00" }, select }),
    bx.list("crm.lead.list", { filter: { ASSIGNED_BY_ID: ids, STATUS_SEMANTIC_ID: "P" }, select }),
  ]);
  return weekStats({ from, now, owners, exclude, leads: [...open, ...closed, ...created] });
}
